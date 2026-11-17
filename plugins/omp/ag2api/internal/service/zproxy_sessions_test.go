package service

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
)

// zproxySessionRequest returns a one message request with the given text.
func zproxySessionRequest(text string) antigravity.GenerateRequest {
	return antigravity.GenerateRequest{
		Model:    "fixture",
		Session:  "client",
		Contents: []antigravity.Content{{Role: antigravity.RoleUser, Parts: []antigravity.Part{{Text: text}}}},
	}
}

// zproxySessionTurn returns a request whose messages alternate from the first
// user message, so the given texts form the full history.
func zproxySessionTurn(texts ...string) antigravity.GenerateRequest {
	request := zproxySessionRequest(texts[0])
	for _, text := range texts[1:] {
		role := antigravity.RoleUser
		if len(request.Contents)%2 == 1 {
			role = antigravity.RoleAssistant
		}
		request.Contents = append(request.Contents, antigravity.Content{Role: role, Parts: []antigravity.Part{{Text: text}}})
	}
	return request
}

// zproxySessionBranch returns a two message history whose answer differs from
// every other branch. The official begin rule keeps a session only when the
// request continues its chain, so two branches need two sessions.
func zproxySessionBranch(answer string) antigravity.GenerateRequest {
	return zproxySessionTurn("hello", answer)
}

// zproxySessionFiles returns the stored session files in dir.
func zproxySessionFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			files = append(files, filepath.Join(dir, entry.Name()))
		}
	}
	return files
}

func TestZProxySessionsIsolateScopes(t *testing.T) {
	dir := t.TempDir()
	sessions, err := newZProxySessions(dir, ZProxySessionLimit)
	if err != nil {
		t.Fatal(err)
	}
	request := zproxySessionRequest("hello")
	alice, err := sessions.Begin(request, "alice")
	if err != nil {
		t.Fatal(err)
	}
	bob, err := sessions.Begin(request, "bob")
	if err != nil {
		t.Fatal(err)
	}
	again, err := sessions.Begin(request, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if alice.Cascade == bob.Cascade || alice.Trajectory == bob.Trajectory {
		t.Fatalf("two scopes shared a session: %+v %+v", alice, bob)
	}
	if !alice.New || !bob.New {
		t.Fatal("a first request was not new")
	}
	if again.New || again.Cascade != alice.Cascade || again.Trajectory != alice.Trajectory {
		t.Fatalf("an equal request did not resume its scope: %+v %+v", alice, again)
	}
	if len(again.Times) != 1 || again.Times[0] != alice.Times[0] {
		t.Fatal("a resumed session changed its message time")
	}
	if files := zproxySessionFiles(t, dir); len(files) != 2 {
		t.Fatalf("two scopes kept %d sessions", len(files))
	}
}

func TestZProxySessionsContinueTurns(t *testing.T) {
	sessions, err := newZProxySessions(t.TempDir(), ZProxySessionLimit)
	if err != nil {
		t.Fatal(err)
	}
	first, err := sessions.Begin(zproxySessionTurn("hello"), "alice")
	if err != nil {
		t.Fatal(err)
	}
	second, err := sessions.Begin(zproxySessionTurn("hello", "hi there", "again"), "alice")
	if err != nil {
		t.Fatal(err)
	}
	third, err := sessions.Begin(zproxySessionTurn("hello", "hi there", "again", "sure", "last"), "alice")
	if err != nil {
		t.Fatal(err)
	}
	if second.New || third.New || second.Cascade != first.Cascade || third.Cascade != first.Cascade {
		t.Fatalf("a longer request did not continue the session: %+v %+v %+v", first, second, third)
	}
	if len(first.Times) != 1 || len(second.Times) != 3 || len(third.Times) != 5 {
		t.Fatalf("message times: %v %v %v", first.Times, second.Times, third.Times)
	}
	base := first.Times[0]
	if second.Times[0] != base || third.Times[0] != base || third.Times[1] != second.Times[1] {
		t.Fatalf("a later turn rewrote earlier times: %v %v %v", first.Times, second.Times, third.Times)
	}
}

func TestZProxySessionsKeepBranchesPerScope(t *testing.T) {
	sessions, err := newZProxySessions(t.TempDir(), ZProxySessionLimit)
	if err != nil {
		t.Fatal(err)
	}
	alice, err := sessions.Begin(zproxySessionBranch("a1"), "alice")
	if err != nil {
		t.Fatal(err)
	}
	bob, err := sessions.Begin(zproxySessionBranch("b1"), "bob")
	if err != nil {
		t.Fatal(err)
	}
	other, err := sessions.Begin(zproxySessionBranch("a2"), "alice")
	if err != nil {
		t.Fatal(err)
	}
	for _, session := range []ZProxySession{alice, bob, other} {
		if !session.New {
			t.Fatalf("a divergent history did not start its own session: %+v", session)
		}
	}
	if alice.Cascade == bob.Cascade || alice.Cascade == other.Cascade || bob.Cascade == other.Cascade {
		t.Fatal("two histories shared a session")
	}
	if len(alice.Times) != 2 {
		t.Fatalf("the session kept %d message times", len(alice.Times))
	}
}

func TestZProxySessionsReloadKeepsSessions(t *testing.T) {
	dir := t.TempDir()
	opened, err := NewZProxySessions(dir)
	if err != nil {
		t.Fatal(err)
	}
	request := zproxySessionBranch("answer")
	first, err := opened.Begin(request, "alice")
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := NewZProxySessions(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := reopened.Begin(request, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if second.New || second.Cascade != first.Cascade || second.Trajectory != first.Trajectory {
		t.Fatalf("a reopened store lost the session: %+v %+v", first, second)
	}
	if len(second.Times) != len(first.Times) || second.Times[0] != first.Times[0] {
		t.Fatalf("a reopened store lost message times: %v %v", first.Times, second.Times)
	}
}

func TestZProxySessionsRejectNewSessionsAtLimit(t *testing.T) {
	dir := t.TempDir()
	sessions, err := newZProxySessions(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	first, err := sessions.Begin(zproxySessionBranch("a1"), "alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.Begin(zproxySessionBranch("a2"), "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.Begin(zproxySessionBranch("a3"), "alice"); !errors.Is(err, ErrZProxySessionsFull) {
		t.Fatalf("a full store accepted a new session: %v", err)
	}
	reused, err := sessions.Begin(zproxySessionBranch("a1"), "alice")
	if err != nil || reused.New || reused.Cascade != first.Cascade {
		t.Fatalf("a full store rejected an existing session: %+v %v", reused, err)
	}
	if files := zproxySessionFiles(t, dir); len(files) != 2 {
		t.Fatalf("a full store kept %d sessions", len(files))
	}
}

func TestZProxySessionsKeepZeroLimitClosed(t *testing.T) {
	sessions, err := newZProxySessions(t.TempDir(), -1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.Begin(zproxySessionBranch("a1"), "alice"); !errors.Is(err, ErrZProxySessionsFull) {
		t.Fatalf("a zero limit accepted a session: %v", err)
	}
}

func TestZProxySessionsReleaseRoomAfterExpiry(t *testing.T) {
	dir := t.TempDir()
	sessions, err := newZProxySessions(dir, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.Begin(zproxySessionBranch("a1"), "alice"); err != nil {
		t.Fatal(err)
	}
	sessions.store.mu.Lock()
	expired := false
	for _, item := range sessions.store.items {
		item.Used = item.Used.Add(-2 * conversationTTL)
		expired = true
	}
	sessions.store.mu.Unlock()
	if !expired {
		t.Fatal("the store holds no session to expire")
	}
	session, err := sessions.Begin(zproxySessionBranch("a2"), "alice")
	if err != nil {
		t.Fatalf("an expired session kept the store full: %v", err)
	}
	if !session.New {
		t.Fatal("the request did not start a new session")
	}
	if files := zproxySessionFiles(t, dir); len(files) != 1 {
		t.Fatalf("an expired store kept %d sessions", len(files))
	}
}

func TestZProxySessionsTrimOldestFilesOnOpen(t *testing.T) {
	dir := t.TempDir()
	opened, err := newZProxySessions(dir, 8)
	if err != nil {
		t.Fatal(err)
	}
	requests := make(map[string]antigravity.GenerateRequest)
	cascades := make([]string, 0, 3)
	for _, answer := range []string{"a1", "a2", "a3"} {
		request := zproxySessionBranch(answer)
		session, err := opened.Begin(request, "alice")
		if err != nil {
			t.Fatal(err)
		}
		requests[session.Cascade] = request
		cascades = append(cascades, session.Cascade)
	}
	if len(cascades) != 3 {
		t.Fatalf("three histories kept %d sessions", len(cascades))
	}
	now := time.Now()
	for index, cascade := range cascades {
		path := filepath.Join(dir, cascade+".json")
		if err := os.Chtimes(path, now, now.Add(time.Duration(index-3)*time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	oldest, kept := cascades[0], cascades[1:]
	trimmed, err := newZProxySessions(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	if files := zproxySessionFiles(t, dir); len(files) != 2 {
		t.Fatalf("the trim kept %d sessions", len(files))
	}
	if _, err := os.Stat(filepath.Join(dir, oldest+".json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the trim kept the oldest session file: %v", err)
	}
	if _, ok := trimmed.store.items[oldest]; ok {
		t.Fatal("the trim kept the oldest session")
	}
	for _, cascade := range kept {
		session, err := trimmed.Begin(requests[cascade], "alice")
		if err != nil || session.New || session.Cascade != cascade {
			t.Fatalf("the trim dropped a recent session: %+v %v", session, err)
		}
	}
	if files := zproxySessionFiles(t, dir); len(files) != 2 {
		t.Fatalf("the trimmed store grew to %d sessions", len(files))
	}
}

func TestZProxySessionsBoundConcurrentBegins(t *testing.T) {
	dir := t.TempDir()
	sessions, err := newZProxySessions(dir, 4)
	if err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		session ZProxySession
		err     error
	}
	results := make(chan outcome, 32)
	var group sync.WaitGroup
	for index := 0; index < 32; index++ {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			session, err := sessions.Begin(zproxySessionBranch(fmt.Sprintf("answer %d", index)), "user")
			results <- outcome{session: session, err: err}
		}(index)
	}
	group.Wait()
	close(results)
	cascades := make(map[string]bool)
	created, failed := 0, 0
	for item := range results {
		if item.err != nil {
			if !errors.Is(item.err, ErrZProxySessionsFull) {
				t.Fatalf("an unexpected failure: %v", item.err)
			}
			failed++
			continue
		}
		if !item.session.New {
			t.Fatal("a new session was not marked new")
		}
		created++
		cascades[item.session.Cascade] = true
	}
	if created != 4 || len(cascades) != 4 || failed != 28 {
		t.Fatalf("limit 4 kept %d sessions and rejected %d requests", len(cascades), failed)
	}
	if files := zproxySessionFiles(t, dir); len(files) != 4 {
		t.Fatalf("limit 4 kept %d files", len(files))
	}
}

func TestZProxySessionsKeepCredentialsOutOfFiles(t *testing.T) {
	dir := t.TempDir()
	sessions, err := newZProxySessions(dir, ZProxySessionLimit)
	if err != nil {
		t.Fatal(err)
	}
	request := zproxySessionBranch("prompt-plaintext-marker")
	request.AccountID = "account-secret"
	request.Accounts = []string{"account-secret"}
	if _, err := sessions.Begin(request, "alice-secret"); err != nil {
		t.Fatal(err)
	}
	files := zproxySessionFiles(t, dir)
	if len(files) != 1 {
		t.Fatalf("a single session kept %d files", len(files))
	}
	data, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"account-secret", "alice-secret", "prompt-plaintext-marker", "fixture"} {
		if strings.Contains(string(data), secret) {
			t.Fatalf("the session file contains %q", secret)
		}
	}
}

func TestZProxySessionsFullErrorHidesRequestAndScope(t *testing.T) {
	sessions, err := newZProxySessions(t.TempDir(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.Begin(zproxySessionBranch("a1"), "alice-secret"); err != nil {
		t.Fatal(err)
	}
	_, err = sessions.Begin(zproxySessionBranch("second-plaintext-marker"), "alice-secret")
	if !errors.Is(err, ErrZProxySessionsFull) {
		t.Fatalf("the store accepted a second session: %v", err)
	}
	if err.Error() != "the session limit is reached" {
		t.Fatalf("the error text changed: %q", err.Error())
	}
	for _, leaked := range []string{"alice-secret", "second-plaintext-marker", "hello", "fixture"} {
		if strings.Contains(err.Error(), leaked) {
			t.Fatalf("the error contains %q", leaked)
		}
	}
}

func TestZProxySessionsSeparateScopesWithPrefixes(t *testing.T) {
	sessions, err := newZProxySessions(t.TempDir(), ZProxySessionLimit)
	if err != nil {
		t.Fatal(err)
	}
	request := zproxySessionRequest("hello")
	first, err := sessions.Begin(request, "a:client")
	if err != nil {
		t.Fatal(err)
	}
	second, err := sessions.Begin(request, "a")
	if err != nil {
		t.Fatal(err)
	}
	third, err := sessions.Begin(request, "a:")
	if err != nil {
		t.Fatal(err)
	}
	if first.Cascade == second.Cascade || first.Cascade == third.Cascade || second.Cascade == third.Cascade {
		t.Fatal("a scope that prefixes another shared a session")
	}
}