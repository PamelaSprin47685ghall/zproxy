package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
)

// officialTestDevice is a fixed device profile, so no test reads the host.
var officialTestDevice = antigravity.Device{
	OS:             "linux",
	Arch:           "amd64",
	UserName:       "fixture",
	AppDataDir:     "/home/fixture/.gemini/antigravity",
	TimeZone:       "UTC",
	InstallationID: "fixture",
}

// officialTestToken is a fixed, obviously synthetic access token.
const officialTestToken = "fixture-access-token"

// officialTestBoot is a cold start that opens no socket. It records each call
// and can hold the start on gate, so a test decides when the start finishes.
type officialTestBoot struct {
	mu      sync.Mutex
	calls   int
	watch   context.Context
	entered chan struct{}
	gate    chan struct{}
	delay   time.Duration
	answer  antigravity.Initialization
	err     error
}

func (b *officialTestBoot) start(ctx, watch context.Context, client *antigravity.Client) (*antigravity.Companion, antigravity.Initialization, error) {
	b.mu.Lock()
	b.calls++
	b.watch = watch
	answer, failure := b.answer, b.err
	b.mu.Unlock()
	if b.entered != nil {
		select {
		case b.entered <- struct{}{}:
		default:
		}
	}
	if b.delay > 0 {
		timer := time.NewTimer(b.delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return nil, antigravity.Initialization{}, ctx.Err()
		}
	}
	if b.gate != nil {
		select {
		case <-b.gate:
		case <-ctx.Done():
			return nil, antigravity.Initialization{}, ctx.Err()
		}
	}
	return nil, answer, failure
}

// setAnswer replaces the answer and the error of the next cold start.
func (b *officialTestBoot) setAnswer(answer antigravity.Initialization, err error) {
	b.mu.Lock()
	b.answer, b.err = answer, err
	b.mu.Unlock()
}

// count returns the number of cold starts this fake served.
func (b *officialTestBoot) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.calls
}

// watched returns the companion context of the last cold start.
func (b *officialTestBoot) watched() context.Context {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.watch
}

// officialTestRuntime returns a runtime with its state in a fresh temporary
// directory. Cleanup closes the runtime, so a failed assertion cannot leak a
// companion request.
func officialTestRuntime(t *testing.T) (*officialRuntime, string) {
	t.Helper()
	stateDir := filepath.Join(t.TempDir(), "state")
	runtime, err := newOfficialRuntime(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runtime.Close() })
	return runtime, stateDir
}

// officialTestHandle returns a distinct ladder-free handle per seed.
func officialTestHandle(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:])
}

// officialTestWaitStart fails the test unless the injected cold start began.
func officialTestWaitStart(t *testing.T, boot *officialTestBoot) {
	t.Helper()
	officialTestWaitCount(t, boot, 1)
}

// officialTestEntered returns a buffered channel that reports each cold start.
func officialTestEntered() chan struct{} { return make(chan struct{}, 16) }

// officialTestWaitCount fails the test unless boot began n cold starts.
func officialTestWaitCount(t *testing.T, boot *officialTestBoot, n int) {
	t.Helper()
	for range n {
		select {
		case <-boot.entered:
		case <-time.After(5 * time.Second):
			t.Fatalf("%d of %d cold starts began", boot.count(), n)
		}
	}
}

func TestOfficialRuntimeRejectsARelativeStateDirectory(t *testing.T) {
	if _, err := newOfficialRuntime("state"); err == nil {
		t.Fatal("a relative state directory was accepted")
	}
}

func TestOfficialRuntimePreparesPrivateStateDirectories(t *testing.T) {
	runtime, stateDir := officialTestRuntime(t)
	if runtime.sessions == nil {
		t.Fatal("the runtime holds no session store")
	}
	for _, dir := range []string{stateDir, filepath.Join(stateDir, "hubs"), filepath.Join(stateDir, "sessions")} {
		info, err := os.Stat(dir)
		if err != nil {
			t.Fatal(err)
		}
		if !info.IsDir() || info.Mode().Perm() != 0o700 {
			t.Fatalf("%s is not a private directory: %v", dir, info.Mode())
		}
	}
	// A second runtime on the same directory resumes it instead of failing.
	again, err := newOfficialRuntime(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := again.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestOfficialRuntimeRejectsUnsafeHandles(t *testing.T) {
	runtime, stateDir := officialTestRuntime(t)
	boot := &officialTestBoot{}
	runtime.boot = boot.start
	unsafe := []string{"", "fixture", "../escape", "../" + officialTestHandle("escape"),
		strings.Repeat("A", 64), strings.Repeat("z", 64), officialTestHandle("short") + "a"}
	for _, handle := range unsafe {
		_, err := runtime.get(context.Background(), handle, officialTestDevice, officialTestToken, 0)
		if !errors.Is(err, errOfficialHandle) {
			t.Fatalf("handle %q was not refused: %v", handle, err)
		}
	}
	if boot.count() != 0 {
		t.Fatal("a refused handle started a cold start")
	}
	entries, err := os.ReadDir(filepath.Join(stateDir, "hubs"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("a refused handle stored a file: %v", entries)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(stateDir), "escape.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a refused handle wrote outside the state directory: %v", err)
	}
}

func TestOfficialRuntimeRejectsAnUnusableAccessToken(t *testing.T) {
	runtime, _ := officialTestRuntime(t)
	boot := &officialTestBoot{}
	runtime.boot = boot.start
	handle := officialTestHandle("token")
	for _, token := range []string{"", "two words", "tab\there", "ünïcode", strings.Repeat("a", 4097)} {
		if _, err := runtime.get(context.Background(), handle, officialTestDevice, token, 0); !errors.Is(err, errOfficialToken) {
			t.Fatalf("token %q was not refused: %v", token, err)
		}
	}
	if _, err := runtime.get(context.Background(), handle, officialTestDevice, officialTestToken, -1); !errors.Is(err, errOfficialToken) {
		t.Fatalf("a negative expiry was not refused: %v", err)
	}
	// A refused token is never stored, so it neither starts nor blocks an
	// account: the handle is still free and the runtime is still empty.
	if boot.count() != 0 {
		t.Fatal("a refused token started a cold start")
	}
	runtime.mu.Lock()
	pending := len(runtime.accounts) + len(runtime.flights)
	runtime.mu.Unlock()
	if pending != 0 {
		t.Fatalf("a refused token kept %d accounts", pending)
	}
	if _, err := runtime.get(context.Background(), handle, officialTestDevice, officialTestToken, 0); err != nil {
		t.Fatal(err)
	}
}

func TestOfficialRuntimeGetSharesOneColdStartPerHandle(t *testing.T) {
	runtime, _ := officialTestRuntime(t)
	boot := &officialTestBoot{entered: officialTestEntered(), gate: make(chan struct{})}
	runtime.boot = boot.start
	handle := officialTestHandle("shared")
	const waiters = 8
	var group sync.WaitGroup
	accounts := make([]*officialAccount, waiters)
	failures := make([]error, waiters)
	group.Add(waiters)
	for index := range waiters {
		go func(index int) {
			defer group.Done()
			accounts[index], failures[index] = runtime.get(context.Background(), handle, officialTestDevice, officialTestToken, 0)
		}(index)
	}
	officialTestWaitStart(t, boot)
	// Every waiter is inside get, so none of them has seen a result yet.
	close(boot.gate)
	group.Wait()
	for index, err := range failures {
		if err != nil {
			t.Fatalf("waiter %d failed: %v", index, err)
		}
	}
	if boot.count() != 1 {
		t.Fatalf("%d cold starts ran for one handle", boot.count())
	}
	for index, account := range accounts {
		if account == nil || account != accounts[0] {
			t.Fatalf("waiter %d did not receive the shared account", index)
		}
	}
	cached, err := runtime.get(context.Background(), handle, officialTestDevice, officialTestToken, 0)
	if err != nil {
		t.Fatal(err)
	}
	if cached != accounts[0] || boot.count() != 1 {
		t.Fatal("a settled account was started again")
	}
}

func TestOfficialRuntimeCanceledWaiterLeavesTheStartRunning(t *testing.T) {
	runtime, _ := officialTestRuntime(t)
	boot := &officialTestBoot{entered: officialTestEntered(), gate: make(chan struct{})}
	runtime.boot = boot.start
	handle := officialTestHandle("cancel")
	ctx, cancel := context.WithCancel(context.Background())
	gone := make(chan error, 1)
	go func() {
		_, err := runtime.get(ctx, handle, officialTestDevice, officialTestToken, 0)
		gone <- err
	}()
	officialTestWaitStart(t, boot)
	cancel()
	select {
	case err := <-gone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("a canceled waiter returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a canceled waiter waited for the cold start")
	}
	// The other waiter still receives the account the runtime finished.
	kept := make(chan *officialAccount, 1)
	go func() {
		account, err := runtime.get(context.Background(), handle, officialTestDevice, officialTestToken, 0)
		if err != nil {
			kept <- nil
			return
		}
		kept <- account
	}()
	close(boot.gate)
	select {
	case account := <-kept:
		if account == nil {
			t.Fatal("the cold start did not survive a canceled waiter")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the surviving waiter did not receive the account")
	}
	if boot.count() != 1 {
		t.Fatalf("a canceled waiter caused %d cold starts", boot.count())
	}
}

func TestOfficialRuntimeRefusesNewHandleAtTheLimit(t *testing.T) {
	runtime, _ := officialTestRuntime(t)
	boot := &officialTestBoot{entered: officialTestEntered(), gate: make(chan struct{})}
	runtime.boot = boot.start
	runtime.limit = 1
	first := officialTestHandle("first")
	second := officialTestHandle("second")
	settled := make(chan error, 1)
	go func() {
		_, err := runtime.get(context.Background(), first, officialTestDevice, officialTestToken, 0)
		settled <- err
	}()
	officialTestWaitStart(t, boot)
	if _, err := runtime.get(context.Background(), second, officialTestDevice, officialTestToken, 0); !errors.Is(err, errOfficialFull) {
		t.Fatalf("a new handle at the limit returned %v", err)
	}
	// The handle already starting still joins its own cold start.
	joined := make(chan error, 1)
	go func() {
		_, err := runtime.get(context.Background(), first, officialTestDevice, officialTestToken, 0)
		joined <- err
	}()
	close(boot.gate)
	if err := <-settled; err != nil {
		t.Fatal(err)
	}
	if err := <-joined; err != nil {
		t.Fatalf("a handle already starting was refused at the limit: %v", err)
	}
	if boot.count() != 1 {
		t.Fatalf("the limit test ran %d cold starts", boot.count())
	}
	// A started handle answers from the cache even at the limit, so only a new
	// handle fails.
	if cached, err := runtime.get(context.Background(), first, officialTestDevice, officialTestToken, 0); err != nil || cached == nil {
		t.Fatalf("a started handle was refused at the limit: %v", err)
	}
	if _, err := runtime.get(context.Background(), second, officialTestDevice, officialTestToken, 0); !errors.Is(err, errOfficialFull) {
		t.Fatalf("a settled limit still accepted a new handle: %v", err)
	}
}

func TestOfficialRuntimeCloseStopsCompanionsAndIsIdempotent(t *testing.T) {
	runtime, _ := officialTestRuntime(t)
	boot := &officialTestBoot{}
	runtime.boot = boot.start
	handle := officialTestHandle("close")
	account, err := runtime.get(context.Background(), handle, officialTestDevice, officialTestToken, 0)
	if err != nil {
		t.Fatal(err)
	}
	if account.client == nil || account.source == nil {
		t.Fatal("the account holds no official client or token source")
	}
	if token, err := account.source.Token(); err != nil || token.AccessToken != officialTestToken {
		t.Fatalf("the account token source returned %v %v", token, err)
	}
	// The account keeps the opaque handle and nothing else that names it: no
	// token in plain text, no email.
	if account.handle != handle {
		t.Fatalf("the account keeps %q", account.handle)
	}
	watch := boot.watched()
	if watch == nil || watch.Err() != nil {
		t.Fatal("the companion context was not alive before Close")
	}
	if err := runtime.Close(); err != nil {
		t.Fatal(err)
	}
	if watch.Err() == nil {
		t.Fatal("Close left the companion requests running")
	}
	// Close clears the private token source, so a leaked account holds no
	// usable credential.
	if _, err := account.source.Token(); err == nil {
		t.Fatal("Close left the access token in the source")
	}
	if err := runtime.Close(); err != nil {
		t.Fatalf("a second Close returned %v", err)
	}
	if _, err := runtime.get(context.Background(), handle, officialTestDevice, officialTestToken, 0); !errors.Is(err, errOfficialClosed) {
		t.Fatalf("a closed runtime returned %v", err)
	}
}

func TestOfficialRuntimeCloseDuringStartDropsTheNewAccount(t *testing.T) {
	runtime, _ := officialTestRuntime(t)
	boot := &officialTestBoot{entered: officialTestEntered(), gate: make(chan struct{})}
	runtime.boot = boot.start
	result := make(chan error, 1)
	go func() {
		_, err := runtime.get(context.Background(), officialTestHandle("during"), officialTestDevice, officialTestToken, 0)
		result <- err
	}()
	officialTestWaitStart(t, boot)
	if err := runtime.Close(); err != nil {
		t.Fatal(err)
	}
	close(boot.gate)
	select {
	case err := <-result:
		if !errors.Is(err, errOfficialClosed) {
			t.Fatalf("a start finishing after Close returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a start blocked on Close")
	}
	runtime.mu.Lock()
	cached := len(runtime.accounts) + len(runtime.flights)
	runtime.mu.Unlock()
	if cached != 0 {
		t.Fatalf("Close kept %d accounts", cached)
	}
}

func TestOfficialRuntimeColdStartHonorsItsTimeout(t *testing.T) {
	runtime, _ := officialTestRuntime(t)
	boot := &officialTestBoot{delay: time.Minute}
	runtime.boot = boot.start
	runtime.timeout = 30 * time.Millisecond
	started := time.Now()
	_, err := runtime.get(context.Background(), officialTestHandle("slow"), officialTestDevice, officialTestToken, 0)
	if !errors.Is(err, errOfficialExpired) {
		t.Fatalf("a cold start past its timeout returned %v", err)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("the timeout took %v", elapsed)
	}
}

func TestOfficialRuntimeAccountKeepsTheOfficialCatalog(t *testing.T) {
	runtime, _ := officialTestRuntime(t)
	boot := &officialTestBoot{answer: antigravity.Initialization{Catalog: antigravity.Catalog{Models: map[string]antigravity.CatalogModel{
		"models/first": {ID: "first", DisplayName: "First", MaxOutputTokens: 1024},
	}}}}
	runtime.boot = boot.start
	account, err := runtime.get(context.Background(), officialTestHandle("catalog"), officialTestDevice, officialTestToken, 0)
	if err != nil {
		t.Fatal(err)
	}
	model, ok := account.model("first")
	if !ok || model.ID != "first" || model.DisplayName != "First" {
		t.Fatalf("the initialization catalog was not cached: %+v %v", model, ok)
	}
	if prefixed, ok := account.model("models/first"); !ok || prefixed.ID != "first" {
		t.Fatalf("a catalog key did not answer: %+v %v", prefixed, ok)
	}
	if _, ok := account.model(""); ok {
		t.Fatal("an empty model id answered")
	}
	if _, ok := account.model("missing"); ok {
		t.Fatal("an absent model answered")
	}
	// A later official read replaces the catalog, so a stale entry disappears.
	account.setCatalog(antigravity.Catalog{Models: map[string]antigravity.CatalogModel{
		"models/second": {ID: "second", DisplayName: "Second"},
	}})
	if _, ok := account.model("first"); ok {
		t.Fatal("an outdated catalog entry survived a new read")
	}
	if model, ok := account.model("second"); !ok || model.DisplayName != "Second" {
		t.Fatalf("the newer catalog was not cached: %+v %v", model, ok)
	}
	account.close()
	account.close()
}

func TestOfficialRuntimeUpdatesTheStartedAccountToken(t *testing.T) {
	runtime, _ := officialTestRuntime(t)
	boot := &officialTestBoot{}
	runtime.boot = boot.start
	handle := officialTestHandle("rotate")
	account, err := runtime.get(context.Background(), handle, officialTestDevice, "first-token", 2_000)
	if err != nil {
		t.Fatal(err)
	}
	// A refreshed token reaches the same source without another cold start.
	again, err := runtime.get(context.Background(), handle, officialTestDevice, "second-token", 4_000)
	if err != nil {
		t.Fatal(err)
	}
	if again != account || boot.count() != 1 {
		t.Fatalf("a token refresh started %d cold starts", boot.count())
	}
	token, err := account.source.Token()
	if err != nil || token.AccessToken != "second-token" {
		t.Fatalf("the account token source holds %v %v", token, err)
	}
	// The private source refuses an older expiry for a different token, and the
	// runtime reports that refusal without repeating either value.
	if _, err := runtime.get(context.Background(), handle, officialTestDevice, "third-token", 1_000); !errors.Is(err, errOfficialToken) {
		t.Fatalf("a stale token returned %v", err)
	}
	token, err = account.source.Token()
	if err != nil || token.AccessToken != "second-token" {
		t.Fatalf("a refused update replaced the token: %v %v", token, err)
	}
}

func TestOfficialRuntimeRefusesAConflictingDevice(t *testing.T) {
	runtime, _ := officialTestRuntime(t)
	boot := &officialTestBoot{entered: officialTestEntered(), gate: make(chan struct{})}
	runtime.boot = boot.start
	handle := officialTestHandle("device")
	other := officialTestDevice
	other.InstallationID = "other-fixture"
	started := make(chan *officialAccount, 1)
	go func() {
		account, err := runtime.get(context.Background(), handle, officialTestDevice, officialTestToken, 0)
		if err != nil {
			started <- nil
			return
		}
		started <- account
	}()
	officialTestWaitStart(t, boot)
	// The conflict is refused while the account is still starting, so one
	// handle never opens with two device profiles.
	if _, err := runtime.get(context.Background(), handle, other, officialTestToken, 0); !errors.Is(err, errOfficialDevice) {
		t.Fatalf("a second device profile while starting returned %v", err)
	}
	close(boot.gate)
	account := <-started
	if account == nil {
		t.Fatal("the cold start did not finish")
	}
	if _, err := runtime.get(context.Background(), handle, other, officialTestToken, 0); !errors.Is(err, errOfficialDevice) {
		t.Fatalf("a second device profile on a started account returned %v", err)
	}
	if account.device != officialTestDevice {
		t.Fatalf("the account device changed to %+v", account.device)
	}
	// The original profile still answers, and it did not restart anything.
	if again, err := runtime.get(context.Background(), handle, officialTestDevice, officialTestToken, 0); err != nil || again != account {
		t.Fatalf("the original device profile was refused: %v", err)
	}
	if boot.count() != 1 {
		t.Fatalf("a device conflict ran %d cold starts", boot.count())
	}
}

func TestOfficialRuntimeStoresOnePrivateHubFilePerHandle(t *testing.T) {
	runtime, stateDir := officialTestRuntime(t)
	handle := officialTestHandle("hub")
	state := antigravity.HubState{Conversations: 7, Model: "MODEL_PLACEHOLDER"}
	if err := runtime.saveHub(handle, state); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(stateDir, "hubs", handle+".json")
	if runtime.hubPath(handle) != want {
		t.Fatalf("the Hub path is %s", runtime.hubPath(handle))
	}
	info, err := os.Stat(want)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("the Hub file mode is %v", info.Mode().Perm())
	}
	entries, err := os.ReadDir(filepath.Join(stateDir, "hubs"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("a save left %d files", len(entries))
	}
	loaded := runtime.loadHub(handle)
	if loaded.Conversations != 7 || loaded.Model != state.Model {
		t.Fatalf("the stored Hub state changed: %+v", loaded)
	}
	// A second save replaces the state and leaves no temporary file.
	if err := runtime.saveHub(handle, antigravity.HubState{Conversations: 9}); err != nil {
		t.Fatal(err)
	}
	entries, err = os.ReadDir(filepath.Join(stateDir, "hubs"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != handle+".json" {
		t.Fatalf("a second save left %v", entries)
	}
	if runtime.loadHub(handle).Conversations != 9 {
		t.Fatal("the second save did not replace the state")
	}
}

func TestOfficialRuntimeHubStoreRefusesEscapingNames(t *testing.T) {
	runtime, stateDir := officialTestRuntime(t)
	for _, handle := range []string{"../escape", "/absolute", "a/b", "short", strings.Repeat("A", 64), strings.Repeat("g", 64)} {
		if err := runtime.saveHub(handle, antigravity.HubState{Conversations: 1}); !errors.Is(err, errOfficialHandle) {
			t.Fatalf("handle %q was stored: %v", handle, err)
		}
	}
	entries, err := os.ReadDir(filepath.Join(stateDir, "hubs"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("an escaping handle stored %v", entries)
	}
	if runtime.loadHub("../escape").Conversations != 0 {
		t.Fatal("an escaping handle read a stored state")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(stateDir), "escape.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("an escaping handle wrote outside the state directory: %v", err)
	}
}

func TestOfficialRuntimeHubStoreIgnoresOversizedOrBrokenFiles(t *testing.T) {
	runtime, _ := officialTestRuntime(t)
	broken := officialTestHandle("broken")
	if err := os.WriteFile(runtime.hubPath(broken), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if state := runtime.loadHub(broken); state.Conversations != 0 || state.Model != "" || len(state.Marketplaces) != 0 {
		t.Fatalf("broken JSON loaded as %+v", state)
	}
	large := officialTestHandle("large")
	if err := os.WriteFile(runtime.hubPath(large), bytes.Repeat([]byte("x"), officialHubLimit+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if state := runtime.loadHub(large); state.Conversations != 0 || state.Model != "" || len(state.Marketplaces) != 0 {
		t.Fatalf("an oversized file loaded as %+v", state)
	}
	// An oversized state is refused instead of written.
	filler := strings.Repeat("m", officialHubLimit)
	if err := runtime.saveHub(large, antigravity.HubState{Model: filler}); err == nil {
		t.Fatal("an oversized Hub state was stored")
	}
	info, err := os.Stat(runtime.hubPath(large))
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != officialHubLimit+1 {
		t.Fatalf("a refused save replaced the stored file: %d bytes", info.Size())
	}
}

func TestOfficialRuntimeHubKeepsTheRealDesktopSize(t *testing.T) {
	runtime, _ := officialTestRuntime(t)
	// The official desktop writes roughly 89 KiB of Hub state, so that shape
	// must load and save unchanged.
	handle := officialTestHandle("desktop")
	marketplaces := map[string]antigravity.MarketplaceCache{
		"open-vsx": {Body: json.RawMessage(`"` + strings.Repeat("b", 80<<10) + `"`)},
	}
	state := antigravity.HubState{Conversations: 12, Model: "MODEL_PLACEHOLDER", Marketplaces: marketplaces}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 80<<10 || len(data) >= officialHubLimit {
		t.Fatalf("the fixture is %d bytes, outside the desktop shape", len(data))
	}
	if err := runtime.saveHub(handle, state); err != nil {
		t.Fatal(err)
	}
	loaded := runtime.loadHub(handle)
	if loaded.Conversations != 12 || loaded.Model != state.Model || len(loaded.Marketplaces) != 1 {
		t.Fatalf("the desktop-sized state loaded as %d conversations", loaded.Conversations)
	}
	if officialHubLimit != 4<<20 {
		t.Fatalf("the Hub limit is %d bytes", officialHubLimit)
	}
}

func TestOfficialRuntimeHubStoreRefusesALinkedStateFile(t *testing.T) {
	runtime, stateDir := officialTestRuntime(t)
	outside := filepath.Join(filepath.Dir(stateDir), "outside.json")
	state := antigravity.HubState{Conversations: 3}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, data, 0o600); err != nil {
		t.Fatal(err)
	}
	handle := officialTestHandle("linked")
	if err := os.Symlink(outside, runtime.hubPath(handle)); err != nil {
		t.Fatal(err)
	}
	if loaded := runtime.loadHub(handle); loaded.Conversations != 0 {
		t.Fatalf("a linked Hub file was read: %+v", loaded)
	}
	// A save replaces the link instead of writing through it.
	if err := runtime.saveHub(handle, antigravity.HubState{Conversations: 5}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(runtime.hubPath(handle))
	if err != nil {
		t.Fatal(err)
	}
	if !info.Mode().IsRegular() {
		t.Fatalf("a save kept the link: %v", info.Mode())
	}
	untouched, err := os.ReadFile(outside)
	if err != nil {
		t.Fatal(err)
	}
	if string(untouched) != string(data) {
		t.Fatal("a save wrote through the link")
	}
	if runtime.loadHub(handle).Conversations != 5 {
		t.Fatal("the replacement state was not stored")
	}
}

func TestOfficialBootFailureKeepsNoAccountDetail(t *testing.T) {
	body, err := json.Marshal(map[string]any{"error": map[string]any{
		"status":  "RESOURCE_EXHAUSTED",
		"message": "quota exhausted for person@example.com",
		"details": []map[string]any{{"reason": "RATE_LIMITED"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	failure := officialBootFailure(&antigravity.UpstreamError{Status: 429, Body: body})
	if !errors.Is(failure, errOfficialBoot) {
		t.Fatalf("an upstream failure lost its class: %v", failure)
	}
	var status *officialBootStatus
	if !errors.As(failure, &status) || status.Status != 429 || status.Reason != "RATE_LIMITED" {
		t.Fatalf("the failure kept no typed status: %#v", status)
	}
	for _, want := range []string{"upstream 429", "RATE_LIMITED"} {
		if !strings.Contains(failure.Error(), want) {
			t.Fatalf("%q is missing from %q", want, failure.Error())
		}
	}
	for _, secret := range []string{"person@example.com", "quota exhausted", "RESOURCE_EXHAUSTED", officialTestToken} {
		if strings.Contains(failure.Error(), secret) {
			t.Fatalf("the failure repeats %q: %q", secret, failure.Error())
		}
	}
	if hidden := officialBootFailure(errors.New("dial tcp: person@example.com: no route")); hidden != errOfficialBoot {
		t.Fatalf("a transport failure leaked its text: %v", hidden)
	}
}

func TestOfficialBootFailureCarriesTheUpstreamStatus(t *testing.T) {
	// A rejected credential is the case a caller must distinguish, so 401
	// reaches it as a typed status and never as response text.
	body := []byte(`{"error":{"message":"invalid token fixture-access-token"}}`)
	failure := officialBootFailure(&antigravity.UpstreamError{Status: 401, Body: body})
	var status *officialBootStatus
	if !errors.As(failure, &status) || status.Status != 401 {
		t.Fatalf("a 401 lost its status: %v", failure)
	}
	if status.Reason != "" {
		t.Fatalf("a body without a reason reported %q", status.Reason)
	}
	if strings.Contains(failure.Error(), officialTestToken) || strings.Contains(failure.Error(), "invalid token") {
		t.Fatalf("the failure repeated the body: %q", failure.Error())
	}
	// A reason that is not an uppercase protocol token is dropped instead of
	// repeated, because it could carry account text.
	unsafe := officialBootFailure(&antigravity.UpstreamError{Status: 500, Body: []byte(
		`{"error":{"details":[{"reason":"failed for person@example.com"}]}}`)})
	if strings.Contains(unsafe.Error(), "person@example.com") {
		t.Fatalf("an unsafe reason was repeated: %q", unsafe.Error())
	}
	if !errors.As(unsafe, &status) || status.Status != 500 || status.Reason != "" {
		t.Fatalf("an unsafe reason was kept: %#v", status)
	}
}

func TestOfficialRuntimeStartsDistinctHandlesIndependently(t *testing.T) {
	runtime, _ := officialTestRuntime(t)
	boot := &officialTestBoot{entered: officialTestEntered(), gate: make(chan struct{})}
	runtime.boot = boot.start
	const handles = 4
	settled := make(chan error, handles)
	for index := range handles {
		go func(index int) {
			_, err := runtime.get(context.Background(), officialTestHandle(string(rune('a'+index))), officialTestDevice, officialTestToken, 0)
			settled <- err
		}(index)
	}
	officialTestWaitCount(t, boot, handles)
	close(boot.gate)
	for range handles {
		if err := <-settled; err != nil {
			t.Fatal(err)
		}
	}
	if boot.count() != handles {
		t.Fatalf("%d cold starts ran for %d handles", boot.count(), handles)
	}
}

func TestOfficialRuntimeReportsAFailedColdStartWithoutCachingIt(t *testing.T) {
	runtime, _ := officialTestRuntime(t)
	boot := &officialTestBoot{err: errors.New("upstream refused the start")}
	runtime.boot = boot.start
	handle := officialTestHandle("failed")
	if _, err := runtime.get(context.Background(), handle, officialTestDevice, officialTestToken, 0); !errors.Is(err, errOfficialBoot) {
		t.Fatalf("a failed cold start returned %v", err)
	}
	// The failure keeps no account, so the next call starts again.
	boot.setAnswer(antigravity.Initialization{Catalog: antigravity.Catalog{Models: map[string]antigravity.CatalogModel{
		"models/retry": {ID: "retry"},
	}}}, nil)
	account, err := runtime.get(context.Background(), handle, officialTestDevice, officialTestToken, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := account.model("retry"); !ok || boot.count() != 2 {
		t.Fatalf("a failed start was cached: %d calls", boot.count())
	}
}

func TestOfficialRuntimeStatesTheAccountLimit(t *testing.T) {
	if officialAccountLimit != 64 {
		t.Fatalf("the account limit is %d", officialAccountLimit)
	}
	runtime, _ := officialTestRuntime(t)
	if runtime.limit != officialAccountLimit || runtime.timeout <= 0 {
		t.Fatalf("the runtime limits are %d and %v", runtime.limit, runtime.timeout)
	}
}
