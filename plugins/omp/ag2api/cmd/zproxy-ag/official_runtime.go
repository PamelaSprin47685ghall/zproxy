package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
	"github.com/Mag1cFall/Antigravity2API/internal/service"
)

const (
	// officialAccountLimit is the number of accounts one runtime starts at once.
	officialAccountLimit = 64
	// officialBootTimeout bounds one official cold start, so its many network
	// requests cannot hold a caller forever.
	officialBootTimeout = 45 * time.Second
	// officialHubLimit bounds one stored Hub file. The official client keeps a
	// conversation count, one model name, and the cached marketplace bodies,
	// which the real desktop writes at roughly 89 KiB, so the limit leaves
	// room for a much larger marketplace cache without accepting a runaway
	// file.
	officialHubLimit = 4 << 20
)

var (
	// errOfficialClosed reports a request that arrives after Close.
	errOfficialClosed = errors.New("the official account runtime is closed")
	// errOfficialHandle reports a handle that is not 64 lowercase hex digits,
	// which is also the only form the Hub file name accepts.
	errOfficialHandle = errors.New("the account handle is invalid")
	// errOfficialFull reports a new account while the runtime owns its limit.
	// It repeats no account data.
	errOfficialFull = errors.New("the official account limit is reached")
	// errOfficialToken reports an access token the private source refused. It
	// repeats neither the token nor its expiry.
	errOfficialToken = errors.New("the account access token was refused")
	// errOfficialDevice reports a second device profile for a handle that is
	// already starting or started. One account presents one device.
	errOfficialDevice = errors.New("the account device profile conflicts")
	// errOfficialClient reports an official client that the constructor refused
	// to configure. It keeps no device, token, or upstream detail.
	errOfficialClient = errors.New("the official client is unusable")
	// errOfficialBoot reports a failed cold start. It keeps the upstream status
	// and machine reason and never the response body, the device, or a token.
	errOfficialBoot = errors.New("the official account initialization failed")
	// errOfficialExpired reports a cold start that used its whole timeout.
	errOfficialExpired = errors.New("the official account initialization timed out")
	// errOfficialHubStore reports a Hub state that could not be stored. The
	// message drops the file path, which names the handle.
	errOfficialHubStore = errors.New("the Hub state could not be stored")
)

// officialBootStatus is a cold start failure that carries the upstream HTTP
// status, so a caller can tell a rejected credential (401) from a retryable
// answer. It repeats no response body, no email, no device, and no token, and
// it unwraps to errOfficialBoot so every caller that only knows the class
// keeps working.
type officialBootStatus struct {
	// Status is the upstream HTTP status of the failed initialization.
	Status int
	// Reason is the bounded machine reason of the upstream error, empty when
	// the upstream body carried none.
	Reason string
}

// Error states the class, the status, and the machine reason only.
func (s *officialBootStatus) Error() string {
	if s.Reason == "" {
		return fmt.Sprintf("%s: upstream %d", errOfficialBoot, s.Status)
	}
	return fmt.Sprintf("%s: upstream %d %s", errOfficialBoot, s.Status, s.Reason)
}

// Unwrap reports the failure class, so errors.Is still matches errOfficialBoot.
func (s *officialBootStatus) Unwrap() error { return errOfficialBoot }

// officialBoot starts one account: it begins the companion requests on watch
// and returns the companion with the official initialization. Production uses
// service.ZProxyBoot; tests inject a local value that opens no socket.
type officialBoot func(ctx, watch context.Context, client *antigravity.Client) (*antigravity.Companion, antigravity.Initialization, error)

// officialAccount is one started account. handle is the only identity it keeps
// in text, and it is opaque: the Bun owner maps it to a credential that never
// leaves that process. source holds the access token the owner selected, and
// the account owns it exclusively, so closing the account removes the token.
type officialAccount struct {
	handle    string
	device    antigravity.Device
	client    *antigravity.Client
	source    *antigravity.ZProxyTokenSource
	cancel    context.CancelFunc
	closeOnce sync.Once
	mu        sync.RWMutex
	closed    bool
	catalog   antigravity.Catalog
}

// close stops the companion requests and the requests this account started,
// drops the idle connections, and then forgets the token. It is idempotent.
func (a *officialAccount) close() {
	a.closeOnce.Do(func() {
		// The closed flag comes first, so a caller that already found this
		// account cannot write a token after the source is cleared.
		a.mu.Lock()
		a.closed = true
		a.mu.Unlock()
		if a.cancel != nil {
			a.cancel()
		}
		if a.client != nil {
			a.client.ZProxyClose()
		}
		if a.source != nil {
			a.source.Clear()
		}
	})
}

// model returns the cached catalog entry for id. The official catalog keys an
// entry as "models/<id>" and repeats the bare id in CatalogModel.ID, so both
// forms answer, and a later official read replaces what they answer with.
func (a *officialAccount) model(id string) (antigravity.CatalogModel, bool) {
	if id == "" {
		return antigravity.CatalogModel{}, false
	}
	id = strings.TrimPrefix(id, "models/")
	a.mu.RLock()
	defer a.mu.RUnlock()
	if model, ok := a.catalog.Models["models/"+id]; ok {
		return model, true
	}
	model, ok := a.catalog.Models[id]
	return model, ok
}

// setCatalog replaces the cached catalog. The official Observe callback feeds
// it whenever the account reads the directory again.
func (a *officialAccount) setCatalog(catalog antigravity.Catalog) {
	a.mu.Lock()
	a.catalog = catalog
	a.mu.Unlock()
}

// update accepts the device profile of a caller and moves the account to a
// newer access token. It reports whether the write happened: a closed account
// refuses it, so no token lands in a source that already forgot its account.
func (a *officialAccount) update(device antigravity.Device, accessToken string, expiresAt int64) (bool, error) {
	if a.device != device {
		return false, errOfficialDevice
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return false, nil
	}
	if err := a.source.Update(accessToken, expiresAt); err != nil {
		return false, errOfficialToken
	}
	return true, nil
}

// officialFlight is one cold start in progress. Every caller that names the
// same handle while it runs waits on done, so the runtime starts one account
// once, and each waiter leaves on its own context. The flight owns the token
// source from admission, so a joining caller refreshes the same source the
// cold start is already using, and a finished flight refuses a later write so
// no token outlives the account that carried it.
type officialFlight struct {
	done    chan struct{}
	once    sync.Once
	mu      sync.Mutex
	closed  bool
	device  antigravity.Device
	source  *antigravity.ZProxyTokenSource
	account *officialAccount
	err     error
}

// stop ends the token writes of this flight and then closes what the start
// built. The caller holds no runtime lock, so the close may cancel requests.
func (f *officialFlight) stop(account *officialAccount) {
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
	if account != nil {
		account.close()
		return
	}
	f.source.Clear()
}

// finish publishes the result once and wakes every waiter.
func (f *officialFlight) finish(account *officialAccount, err error) {
	f.once.Do(func() {
		f.account, f.err = account, err
		close(f.done)
	})
}

// wait returns the shared result or ctx.Err before the result exists. A
// canceled waiter never cancels the cold start or another waiter.
func (f *officialFlight) wait(ctx context.Context) (*officialAccount, error) {
	select {
	case <-f.done:
		return f.account, f.err
	case <-ctx.Done():
		select {
		case <-f.done:
			return f.account, f.err
		default:
			return nil, ctx.Err()
		}
	}
}

// update accepts the device profile of a joining caller and refreshes the
// token source the cold start already uses. It reports whether the write
// happened: a flight that already finished refuses it, so a token never lands
// in a source whose account is gone.
func (f *officialFlight) update(device antigravity.Device, accessToken string, expiresAt int64) (bool, error) {
	if f.device != device {
		return false, errOfficialDevice
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return false, nil
	}
	if err := f.source.Update(accessToken, expiresAt); err != nil {
		return false, errOfficialToken
	}
	return true, nil
}

// officialRuntime owns the official accounts of one state directory. It starts
// at most officialAccountLimit accounts, keeps one account per handle, and
// stores each account's Hub state under stateDir/hubs.
type officialRuntime struct {
	hubRoot  string
	sessions *service.ZProxySessions
	boot     officialBoot
	timeout  time.Duration
	limit    int

	mu        sync.Mutex
	ctx       context.Context
	cancel    context.CancelFunc
	accounts  map[string]*officialAccount
	flights   map[string]*officialFlight
	closed    bool
	closeOnce sync.Once
}

// newOfficialRuntime opens the per-account Hub store and the session store
// under stateDir. Every account reaches the official HTTPS endpoints with its
// own client, so one runtime needs no socket; no account exists until get
// starts one.
func newOfficialRuntime(stateDir string) (*officialRuntime, error) {
	if !filepath.IsAbs(stateDir) {
		return nil, errors.New("the account state directory must be absolute")
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, fmt.Errorf("open the account state directory: %w", err)
	}
	if err := os.Chmod(stateDir, 0o700); err != nil {
		return nil, fmt.Errorf("open the account state directory: %w", err)
	}
	hubRoot := filepath.Join(stateDir, "hubs")
	if err := os.MkdirAll(hubRoot, 0o700); err != nil {
		return nil, fmt.Errorf("open the account state directory: %w", err)
	}
	if err := os.Chmod(hubRoot, 0o700); err != nil {
		return nil, fmt.Errorf("open the account state directory: %w", err)
	}
	sessions, err := service.NewZProxySessions(filepath.Join(stateDir, "sessions"))
	if err != nil {
		return nil, fmt.Errorf("open the account session store: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &officialRuntime{
		hubRoot:  hubRoot,
		sessions: sessions,
		boot:     service.ZProxyBoot,
		timeout:  officialBootTimeout,
		limit:    officialAccountLimit,
		ctx:      ctx,
		cancel:   cancel,
		accounts: map[string]*officialAccount{},
		flights:  map[string]*officialFlight{},
	}, nil
}

// get returns the started account for handle, starting it when needed. Callers
// that name the same handle share one cold start, and the access token and its
// expiry apply to every caller: a started account updates its own private
// source, so a refreshed token reaches the next official request without a new
// cold start.
//
// A handle keeps the device profile of its first caller, because one official
// account presents one device; a second profile fails with errOfficialDevice.
// A canceled waiter leaves alone; the start belongs to the runtime and finishes
// for the others. A new handle at the limit fails with errOfficialFull, and a
// token the source refuses fails with errOfficialToken.
//
// get reports a start that failed, and it does not judge the account beyond
// that: an unusable tier and every other account condition shows up on the
// first official request, which is the official behavior.
func (r *officialRuntime) get(ctx context.Context, handle string, device antigravity.Device,
	accessToken string, expiresAt int64) (*officialAccount, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if !officialHandle(handle) {
		return nil, errOfficialHandle
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil, errOfficialClosed
	}
	if account := r.accounts[handle]; account != nil {
		// The update runs under the runtime lock, so Close cannot clear the
		// source between the lookup and the write and leave a token behind.
		applied, err := account.update(device, accessToken, expiresAt)
		r.mu.Unlock()
		if err != nil {
			return nil, err
		}
		if !applied {
			return nil, errOfficialClosed
		}
		return account, nil
	}
	if flight := r.flights[handle]; flight != nil {
		applied, err := flight.update(device, accessToken, expiresAt)
		r.mu.Unlock()
		if err != nil {
			return nil, err
		}
		if !applied {
			return nil, errOfficialClosed
		}
		return flight.wait(ctx)
	}
	if len(r.accounts)+len(r.flights) >= r.limit {
		r.mu.Unlock()
		return nil, errOfficialFull
	}
	source := &antigravity.ZProxyTokenSource{}
	if err := source.Update(accessToken, expiresAt); err != nil {
		r.mu.Unlock()
		return nil, errOfficialToken
	}
	flight := &officialFlight{done: make(chan struct{}), device: device, source: source}
	r.flights[handle] = flight
	r.mu.Unlock()
	go r.start(handle, device, flight)
	return flight.wait(ctx)
}

// start runs one cold start and publishes it. A start that finishes after
// Close closes its account instead of caching it.
func (r *officialRuntime) start(handle string, device antigravity.Device, flight *officialFlight) {
	account, err := r.open(handle, device, flight.source)
	r.mu.Lock()
	if err == nil {
		if r.closed {
			err = errOfficialClosed
		} else {
			r.accounts[handle] = account
		}
	}
	delete(r.flights, handle)
	r.mu.Unlock()
	switch {
	case err == nil:
		flight.finish(account, nil)
	case account != nil:
		// The account was built for a runtime that closed meanwhile, so stop
		// it here: every waiter sees the failure and no companion survives.
		flight.stop(account)
		flight.finish(nil, err)
	default:
		// open already stopped what it built, so only the unused token source
		// is left to clear.
		flight.stop(nil)
		flight.finish(nil, err)
	}
}

// open builds the official client over the official HTTPS endpoints and runs
// the official cold start under one timeout. The companion requests live on
// watch, which derives from the runtime, so Close stops them with the account.
func (r *officialRuntime) open(handle string, device antigravity.Device, source *antigravity.ZProxyTokenSource) (*officialAccount, error) {
	client, err := antigravity.NewZProxyClient(device, source)
	if err != nil {
		// The constructor refuses a device or transport shape it cannot pin,
		// so the runtime configuration is what failed here.
		source.Clear()
		return nil, errOfficialClient
	}
	watch, stop := context.WithCancel(r.ctx)
	account := &officialAccount{handle: handle, device: device, client: client, source: source, cancel: stop}
	client.Observe(func(observed antigravity.Observed) {
		if observed.Catalog != nil {
			account.setCatalog(*observed.Catalog)
		}
	})
	client.SetHub(r.loadHub(handle), func(state antigravity.HubState) error {
		return r.saveHub(handle, state)
	})
	ctx, timeout := context.WithTimeout(watch, r.timeout)
	defer timeout()
	companion, _, bootErr := r.boot(ctx, watch, client)
	if ctxErr := ctx.Err(); ctxErr != nil {
		account.close()
		if errors.Is(ctxErr, context.DeadlineExceeded) {
			return nil, errOfficialExpired
		}
		return nil, errOfficialClosed
	}
	if bootErr != nil {
		account.close()
		return nil, officialBootFailure(bootErr)
	}
	// The official cold start records the directory without notifying the
	// observer, and a later official read replaces it.
	if companion != nil {
		go companion.Run(watch)
	}
	return account, nil
}

// officialBootFailure reports a failed cold start without the response body,
// the device, the token, or the handle. An upstream answer keeps its status and
// its machine-readable reason, neither of which names an account.
func officialBootFailure(err error) error {
	var upstream *antigravity.UpstreamError
	if !errors.As(err, &upstream) {
		return errOfficialBoot
	}
	if upstream.Status < 400 || upstream.Status > 599 {
		return errOfficialBoot
	}
	return &officialBootStatus{Status: upstream.Status, Reason: officialSafeReason(upstream.Reason())}
}

// officialSafeReason returns the machine reason when it is a bounded uppercase
// token, and empty otherwise. An upstream reason is a protocol enum, but only
// this alphabet is certain to carry no account text, so anything else is
// dropped instead of repeated.
func officialSafeReason(reason string) string {
	reason = strings.TrimSpace(reason)
	if reason == "" || len(reason) > 64 {
		return ""
	}
	for _, letter := range reason {
		if (letter < 'A' || letter > 'Z') && (letter < '0' || letter > '9') && letter != '_' {
			return ""
		}
	}
	return reason
}

// officialHandle reports whether handle is exactly 64 lowercase hex digits.
// The Hub file name is the handle, so this check is also the path guard.
func officialHandle(handle string) bool {
	if len(handle) != 64 || strings.ToLower(handle) != handle {
		return false
	}
	_, err := hex.DecodeString(handle)
	return err == nil
}

// hubPath returns the one file this runtime stores for handle. handle passed
// officialHandle, so the name holds no separator and no parent reference.
func (r *officialRuntime) hubPath(handle string) string {
	return filepath.Join(r.hubRoot, handle+".json")
}

// loadHub reads the stored Hub state. A missing, oversized, unreadable, or
// linked file yields the official empty state, which is the official load rule:
// a fresh account starts from zero conversations. A link is refused so a stored
// name cannot read outside the Hub directory.
func (r *officialRuntime) loadHub(handle string) antigravity.HubState {
	var state antigravity.HubState
	if !officialHandle(handle) {
		return state
	}
	path := r.hubPath(handle)
	if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() {
		return state
	}
	file, err := os.Open(path)
	if err != nil {
		return state
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, officialHubLimit+1))
	if err != nil || len(data) > officialHubLimit {
		return antigravity.HubState{}
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return antigravity.HubState{}
	}
	return state
}

// saveHub writes the Hub state atomically: a fresh 0600 file in the 0700 Hub
// directory replaces the old file by rename, so a reader never sees a partial
// state and a refused write leaves the old state in place. A refused write
// reports errOfficialHubStore, whose message names no file and so no handle.
func (r *officialRuntime) saveHub(handle string, state antigravity.HubState) error {
	if !officialHandle(handle) {
		return errOfficialHandle
	}
	data, err := json.Marshal(state)
	if err != nil {
		return errors.New("the Hub state is not JSON")
	}
	if len(data) > officialHubLimit {
		return errors.New("the Hub state exceeds its limit")
	}
	if err := r.storeHub(handle, data); err != nil {
		// The failure names no path, so it names no handle either.
		return errOfficialHubStore
	}
	return nil
}

// storeHub replaces the Hub file of handle with data. The caller validated
// handle, so the rename target stays inside the Hub directory.
func (r *officialRuntime) storeHub(handle string, data []byte) error {
	if err := os.MkdirAll(r.hubRoot, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(r.hubRoot, 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(r.hubRoot, "hub-")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(name, r.hubPath(handle))
}

// Close stops every companion request and every request in flight, drops the
// connections, clears the tokens, and forgets the started accounts. Later calls
// do nothing. A start that finishes after Close closes its own account.
func (r *officialRuntime) Close() error {
	r.closeOnce.Do(func() {
		r.mu.Lock()
		r.closed = true
		accounts := make([]*officialAccount, 0, len(r.accounts))
		for _, account := range r.accounts {
			accounts = append(accounts, account)
		}
		flights := make([]*officialFlight, 0, len(r.flights))
		for _, flight := range r.flights {
			flights = append(flights, flight)
		}
		r.accounts = map[string]*officialAccount{}
		r.flights = map[string]*officialFlight{}
		r.mu.Unlock()
		r.cancel()
		// A cold start that is still running keeps its own flight, so clearing
		// its source here removes the token before its account closes.
		for _, flight := range flights {
			flight.source.Clear()
		}
		for _, account := range accounts {
			account.close()
		}
	})
	return nil
}
