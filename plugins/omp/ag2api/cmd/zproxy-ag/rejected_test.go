package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
	"github.com/Mag1cFall/Antigravity2API/internal/prompt"
	"github.com/Mag1cFall/Antigravity2API/rules"
)

func TestRejectedFeedKeepsLastGoodRules(t *testing.T) {
	builtin, err := prompt.ParseRejected(string(rules.Rejected))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { prompt.SetRejected(builtin) })
	dir := t.TempDir()
	feed := openRejectedFeed(dir)
	const good = "! Version: 999999999999\n[user]\nremove this fixture sentence\n"
	replies := []struct {
		status int
		body   string
	}{
		{200, good}, {304, ""}, {200, "! Version: 999999999999\n/[a-/\n"},
		{200, "! Version: 1\n"}, {200, good + strings.Repeat("a", rejectedLimit)},
	}
	next := make(chan int, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		index := <-next
		if r.Header.Get("Accept") != "application/vnd.github.raw" || r.Header.Get("Authorization") != "" {
			t.Error("unexpected rule feed request headers")
		}
		if index == 1 && r.Header.Get("If-None-Match") != `"fixture"` {
			t.Error("refresh omitted the cached ETag")
		}
		w.Header().Set("ETag", `"fixture"`)
		w.WriteHeader(replies[index].status)
		_, _ = io.WriteString(w, replies[index].body)
	}))
	defer server.Close()
	for i := range replies {
		next <- i
		err := feed.check(context.Background(), server.Client(), server.URL)
		if (err != nil) != (i == 2 || i == 4) {
			t.Fatalf("refresh %d: %v", i, err)
		}
	}
	if data, err := os.ReadFile(feed.path); err != nil || string(data) != good {
		t.Fatalf("last good rules not retained: %v", err)
	}
	prompt.SetRejected(builtin)
	openRejectedFeed(dir)
	composer, err := prompt.New(prompt.TierFull, prompt.Custom{})
	if err != nil {
		t.Fatal(err)
	}
	request := antigravity.GenerateRequest{Contents: []antigravity.Content{{Role: antigravity.RoleUser,
		Parts: []antigravity.Part{{Text: "Remove this fixture sentence. Keep this reply."}}}}}
	composed, err := composer.Compose(request, antigravity.CatalogModel{}, "fixture", []string{"2026-11-19T00:00:00Z"}, antigravity.Device{}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	text := composed.Contents[0].Parts[0].Text
	if strings.Contains(text, "fixture sentence") || !strings.Contains(text, "Keep this reply.") {
		t.Fatalf("cached rules did not reach the official composer: %q", text)
	}
}
