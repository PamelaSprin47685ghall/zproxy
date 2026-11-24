package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/Mag1cFall/Antigravity2API/internal/prompt"
	"github.com/Mag1cFall/Antigravity2API/rules"
)

const rejectedURL = "https://api.github.com/repos/Mag1cFall/Antigravity2API/contents/rules/rejected.txt?ref=main"
const rejectedLimit = 1 << 20

type rejectedFeed struct {
	path    string
	current *prompt.Rejected
	etag    string
}

func readRejected(reader io.Reader) ([]byte, *prompt.Rejected, error) {
	data, err := io.ReadAll(io.LimitReader(reader, rejectedLimit+1))
	if err != nil {
		return nil, nil, err
	}
	if len(data) > rejectedLimit {
		return nil, nil, fmt.Errorf("rule list exceeds %d bytes", rejectedLimit)
	}
	parsed, err := prompt.ParseRejected(string(data))
	if err != nil || rejectedVersion(parsed) == 0 {
		return nil, nil, fmt.Errorf("invalid versioned rule list")
	}
	return data, parsed, nil
}

func rejectedVersion(list *prompt.Rejected) uint64 {
	if list == nil {
		return 0
	}
	version, err := strconv.ParseUint(list.Version, 10, 64)
	if err != nil {
		return 0
	}
	return version
}

func openRejectedFeed(stateDir string) *rejectedFeed {
	builtin, err := prompt.ParseRejected(string(rules.Rejected))
	if err != nil {
		panic(err) // The pinned composer already validates this in init.
	}
	feed := &rejectedFeed{path: filepath.Join(stateDir, "rejected.txt"), current: builtin}
	if file, err := os.Open(feed.path); err == nil {
		defer file.Close()
		if _, cached, err := readRejected(file); err == nil && rejectedVersion(cached) >= rejectedVersion(builtin) {
			feed.current = cached
			prompt.SetRejected(cached)
		}
	}
	return feed
}

func (f *rejectedFeed) check(ctx context.Context, client *http.Client, endpoint string) error {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/vnd.github.raw")
	if f.etag != "" {
		request.Header.Set("If-None-Match", f.etag)
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusNotModified:
		return nil
	case http.StatusOK:
	default:
		return fmt.Errorf("HTTP %d", response.StatusCode)
	}
	data, candidate, err := readRejected(response.Body)
	if err != nil {
		return err
	}
	if rejectedVersion(candidate) >= rejectedVersion(f.current) && candidate.Digest != f.current.Digest {
		if err := f.save(data); err != nil {
			return err
		}
		f.current = candidate
		prompt.SetRejected(candidate)
	}
	f.etag = response.Header.Get("ETag")
	return nil
}

func (f *rejectedFeed) save(data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(f.path), ".rejected-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), f.path)
}

func (f *rejectedFeed) watch(ctx context.Context) {
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		if err := f.check(ctx, client, rejectedURL); err != nil && ctx.Err() == nil {
			slog.Warn("AG cloud rules check failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
