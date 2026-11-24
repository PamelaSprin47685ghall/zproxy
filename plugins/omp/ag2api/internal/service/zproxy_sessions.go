package service

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
)

// ZProxySessionLimit is the number of unexpired sessions one ZProxySessions
// keeps. A session expires after conversationTTL without use, which is the
// lifetime the official store applies.
const ZProxySessionLimit = 4096

// ErrZProxySessionsFull reports a request that needs a new session while the
// store holds its limit of unexpired sessions. It repeats no request data.
var ErrZProxySessionsFull = errors.New("the session limit is reached")

// ZProxySession answers one generation request. Times holds the first Unix
// second of each message in that request.
type ZProxySession struct {
	Cascade    string
	Trajectory string
	Times      []int64
	New        bool
}

// ZProxySessions owns the official conversation store for zproxy requests.
// One scope owns one set of sessions, so two zproxy users with equal requests
// never resume the same conversation. The directory never holds more session
// files than the limit, also after a restart. Use one instance for one
// directory; the instance is safe for concurrent use and must not be copied.
type ZProxySessions struct {
	store *conversations
	limit int
	// mu serializes admitting a session with creating it, so two requests
	// cannot both pass the limit. The official store keeps its own lock.
	mu sync.Mutex
}

// NewZProxySessions opens dir with the default limit and returns the store.
// A later call on the same directory resumes its stored sessions.
func NewZProxySessions(dir string) (*ZProxySessions, error) {
	return newZProxySessions(dir, ZProxySessionLimit)
}

// newZProxySessions opens dir with an explicit limit, which the limit tests
// use. A limit below zero becomes zero, so the store keeps no session. The
// directory drops its oldest sessions before it is read, so a restart neither
// loads more sessions than the limit nor refuses every new one.
func newZProxySessions(dir string, limit int) (*ZProxySessions, error) {
	if limit < 0 {
		limit = 0
	}
	if err := zproxyTrimDir(dir, limit); err != nil {
		return nil, err
	}
	store, err := openConversations(dir)
	if err != nil {
		return nil, err
	}
	return &ZProxySessions{store: store, limit: limit}, nil
}

// Begin returns the session for request inside scope. It reuses the official
// identity and begin rules. The scope enters request.Session as a digest,
// so equal requests from different scopes take different sessions without a
// scope in plain text. A full store returns ErrZProxySessionsFull instead of
// growing without bound. Account credentials never enter a session, and no
// error repeats request data or a scope.
func (s *ZProxySessions) Begin(request antigravity.GenerateRequest, scope string) (ZProxySession, error) {
	request.Session = zproxyScopedSession(scope, request.Session)
	id := identify(request)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.store.zproxyAdmit(id, s.limit); err != nil {
		return ZProxySession{}, err
	}
	item, err := s.store.begin(id)
	if err != nil {
		return ZProxySession{}, err
	}
	return ZProxySession{Cascade: item.Cascade, Trajectory: item.Trajectory, Times: item.Times, New: item.New}, nil
}

// zproxyScopedSession joins the digest of scope and the client session. The
// digest separates scopes, so a stored file keeps no scope in plain text.
func zproxyScopedSession(scope, session string) string {
	sum := sha256.Sum256([]byte(scope))
	return "zproxy-" + hex.EncodeToString(sum[:]) + "-" + session
}

// zproxyTrimDir deletes the oldest session files while dir holds more than
// limit of them. The store saves a file whenever it uses a session, so file
// time follows the last use. Removing the files before the read keeps the load
// bounded in memory, and one store owns the directory, so no request sees the
// removal. This filter matches the read rule of openConversations exactly, so
// every record the store would load also counts here.
func zproxyTrimDir(dir string, limit int) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	type stored struct {
		path string
		used time.Time
	}
	files := make([]stored, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		files = append(files, stored{path: filepath.Join(dir, entry.Name()), used: info.ModTime()})
	}
	if len(files) <= limit {
		return nil
	}
	sort.Slice(files, func(left, right int) bool { return files[left].used.Before(files[right].used) })
	for _, file := range files[:len(files)-limit] {
		if err := os.Remove(file.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// zproxyAdmit accepts a request that reuses an existing session and accepts a
// new session while the store stays below limit. At the limit it drops the
// expired sessions first and then rejects the request. The caller holds s.mu,
// and this method takes the store lock, so begin creates no session this check
// did not admit.
func (c *conversations) zproxyAdmit(id identity, limit int) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.items) < limit {
		return nil
	}
	c.sweep()
	if len(c.items) < limit || c.zproxyReusable(id) {
		return nil
	}
	return ErrZProxySessionsFull
}


// zproxyReusable checks the same match, rewind and anchor paths as begin.
// The caller holds c.mu.
func (c *conversations) zproxyReusable(id identity) bool {
	length := len(id.digests) - 1
	if c.match(id, func(item *conversation) bool {
		return length > 1 || item.Length < length || item.Prompt == nil || item.Prompt.Length < item.Length
	}) != nil {
		return true
	}
	if length > 1 {
		if item, _ := c.rewind(id.digests); item != nil {
			return true
		}
	}
	return c.anchor(id) != nil
}