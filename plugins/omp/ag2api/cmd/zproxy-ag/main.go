package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
	"github.com/Mag1cFall/Antigravity2API/internal/api"
	"github.com/Mag1cFall/Antigravity2API/internal/service"
)

const upstreamVersion = "d36920f3e178eb6d94a49c0b184947cb7df8b3b1"
const maxRequest = 64 << 20
const maxRawResponse = 128 << 20

type prepareInput struct {
	Version int             `json:"version"`
	Request json.RawMessage `json:"request"`
	Model   api.ZProxyModel `json:"model"`
	Project string          `json:"project"`
	Session string          `json:"session"`
}

type recipe struct {
	API           string   `json:"api"`
	Provider      string   `json:"provider"`
	ID            string   `json:"id"`
	Reasoning     bool     `json:"reasoning"`
	Input         []string `json:"input"`
	ContextWindow int64    `json:"contextWindow"`
	MaxTokens     int64    `json:"maxTokens"`
	Compat        struct {
		Provider string `json:"agProvider"`
	} `json:"compat"`
}

type decodeEnvelope struct {
	Version      int        `json:"version"`
	Path         string     `json:"path"`
	RequestBytes int64      `json:"requestBytes"`
	Status       int        `json:"status"`
	Headers      [][]string `json:"headers"`
	Metadata     struct {
		Decoder     string `json:"decoder"`
		Version     int    `json:"version"`
		ModelAlias  string `json:"modelAlias"`
		RequestID   string `json:"requestId"`
		Attempt     int    `json:"attempt"`
		IsStreaming bool   `json:"isStreaming"`
		Recipe      string `json:"recipe"`
	} `json:"metadata"`
}

// chunkedWriter commits headers before a short body can acquire Content-Length.
type chunkedWriter struct {
	http.ResponseWriter
	wrote bool
}

func (w *chunkedWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *chunkedWriter) WriteHeader(status int) {
	if w.wrote {
		return
	}
	w.wrote = true
	w.Header().Del("Content-Length")
	w.ResponseWriter.WriteHeader(status)
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}
func (w *chunkedWriter) Write(data []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(data)
}

type worker struct {
	cache *api.ZProxyCache
	// official is the remote account runtime. It is nil in a local worker,
	// which owns no account and must refuse the official routes.
	official *officialRuntime
	stop     func()
}

func jsonReply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func problem(w http.ResponseWriter, status int, err error) {
	jsonReply(w, status, map[string]any{"error": map[string]any{"type": "invalid_request", "message": err.Error()}})
}

func readJSON(r io.Reader, limit int64, target any) error {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > limit || !utf8.Valid(data) {
		return errors.New("invalid private JSON body size or encoding")
	}
	return api.ZProxyJSON(data, target, true)
}

func (worker *worker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// HTTP/1.1 must allow response bytes while the raw request body is still open.
	if err := http.NewResponseController(w).EnableFullDuplex(); err != nil && !errors.Is(err, http.ErrNotSupported) {
		problem(&chunkedWriter{ResponseWriter: w}, 500, errors.New("duplex IPC is unavailable"))
		return
	}
	w = &chunkedWriter{ResponseWriter: w}
	defer func() {
		// Commit the error or terminal body before stopping an unfinished upload.
		_ = http.NewResponseController(w).Flush()
		_ = http.NewResponseController(w).SetReadDeadline(time.Now())
		_ = r.Body.Close()
	}()
	if r.URL.RawQuery != "" {
		problem(w, 404, errors.New("unknown private route"))
		return
	}
	switch r.Method + " " + r.URL.Path {
	case "GET /health":
		jsonReply(w, 200, map[string]bool{"ready": true})
	case "POST /shutdown":
		jsonReply(w, 200, map[string]bool{"stopping": true})
		if worker.stop != nil {
			go worker.stop()
		}
	case "POST /device":
		var input struct {
			Version int    `json:"version"`
			Email   string `json:"email"`
		}
		if err := readJSON(r.Body, 1024, &input); err != nil {
			problem(w, 400, err)
			return
		}
		local, domain, found := strings.Cut(input.Email, "@")
		if input.Version != 1 || !plain(input.Email, 320) || !found || local == "" || domain == "" || strings.Contains(domain, "@") {
			problem(w, 400, errors.New("invalid device identity"))
			return
		}
		device := antigravity.NewDevice(input.Email)
		jsonReply(w, 200, map[string]any{"device": device, "userAgent": device.UserAgent()})
	case "POST /agent":
		var input struct {
			Version int    `json:"version"`
			OS      string `json:"os"`
			Arch    string `json:"arch"`
		}
		if err := readJSON(r.Body, 1024, &input); err != nil {
			problem(w, 400, err)
			return
		}
		if input.Version != 1 || !plain(input.OS, 64) || !plain(input.Arch, 64) {
			problem(w, 400, errors.New("invalid device platform"))
			return
		}
		device := antigravity.Device{OS: input.OS, Arch: input.Arch}
		jsonReply(w, 200, map[string]any{"userAgent": device.UserAgent()})
	case "POST /prepare":
		var input prepareInput
		if err := readJSON(r.Body, maxRequest+(64<<10), &input); err != nil {
			problem(w, 400, err)
			return
		}
		if input.Version != 1 || len(input.Request) == 0 || len(input.Request) > maxRequest {
			problem(w, 400, errors.New("invalid prepare envelope"))
			return
		}
		body, err := api.ZProxyPrepare(input.Request, input.Model, input.Project, input.Session)
		if err != nil {
			problem(w, 400, err)
			return
		}
		device := antigravity.Device{OS: runtime.GOOS, Arch: runtime.GOARCH}
		jsonReply(w, 200, map[string]any{"body": body, "userAgent": device.UserAgent()})
	case "POST /augment":
		data, err := io.ReadAll(io.LimitReader(r.Body, maxRequest+1))
		if err != nil || len(data) > maxRequest || !utf8.Valid(data) {
			problem(w, 400, errors.New("invalid OpenAI request size or encoding"))
			return
		}
		augmented, err := worker.cache.Augment(data)
		if err != nil {
			problem(w, 400, err)
			return
		}
		if len(augmented) > maxRequest {
			problem(w, 400, errors.New("the augmented request exceeds its limit"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(augmented)
	case "POST /decode":
		worker.decode(w, r)
	case "POST /official-prepare":
		if worker.official == nil {
			problem(w, 404, errors.New("unknown private route"))
			return
		}
		worker.officialPrepare(w, r)
	case "POST /official-send":
		if worker.official == nil {
			problem(w, 404, errors.New("unknown private route"))
			return
		}
		worker.officialSend(w, r)
	default:
		problem(w, 404, errors.New("unknown private route"))
	}
}

func plain(value string, limit int) bool {
	return value != "" && len(value) <= limit && utf8.ValidString(value) &&
		!strings.ContainsFunc(value, func(r rune) bool { return r < 32 || (r >= 127 && r <= 159) })
}

func readEnvelope(r io.Reader) (decodeEnvelope, recipe, []byte, error) {
	var envelope decodeEnvelope
	var format recipe
	var prefix [4]byte
	if _, err := io.ReadFull(r, prefix[:]); err != nil {
		return envelope, format, nil, err
	}
	length := binary.BigEndian.Uint32(prefix[:])
	if length == 0 || length > 65536 {
		return envelope, format, nil, errors.New("invalid decode envelope size")
	}
	data := make([]byte, length)
	if _, err := io.ReadFull(r, data); err != nil {
		return envelope, format, nil, err
	}
	if err := api.ZProxyJSON(data, &envelope, true); err != nil {
		return envelope, format, nil, err
	}
	if envelope.Version != 1 || envelope.RequestBytes < 1 || envelope.RequestBytes > maxRequest || envelope.Status < 200 || envelope.Status > 299 ||
		(envelope.Path != "/v1/chat/completions" && envelope.Path != "/v1/completions") || len(envelope.Headers) > 32 ||
		envelope.Metadata.Decoder != "omp-response" || envelope.Metadata.Version != 1 || len(envelope.Metadata.Recipe) > 8192 {
		return envelope, format, nil, errors.New("invalid decode envelope")
	}
	for _, header := range envelope.Headers {
		if len(header) != 2 || !plain(header[0], 128) || len(header[1]) > 4096 || !utf8.ValidString(header[1]) ||
			strings.ContainsFunc(header[1], func(r rune) bool { return r < 32 || (r >= 127 && r <= 159) }) {
			return envelope, format, nil, errors.New("invalid raw response header")
		}
	}
	if err := api.ZProxyJSON([]byte(envelope.Metadata.Recipe), &format, true); err != nil {
		return envelope, format, nil, err
	}
	if format.API != "antigravity2api" || format.Provider != "google-antigravity" || api.ZProxyProvider(format.Compat.Provider) == "" || !plain(format.ID, 256) ||
		format.ContextWindow < 1 || format.ContextWindow > 2147483647 || format.MaxTokens < 1 || format.MaxTokens > 2147483647 || len(format.Input) < 1 || len(format.Input) > 2 {
		return envelope, format, nil, errors.New("invalid public decode recipe")
	}
	seen := map[string]bool{}
	for _, input := range format.Input {
		if (input != "text" && input != "image") || seen[input] {
			return envelope, format, nil, errors.New("invalid model input")
		}
		seen[input] = true
	}
	original := make([]byte, envelope.RequestBytes)
	if _, err := io.ReadFull(r, original); err != nil {
		return envelope, format, nil, err
	}
	if !utf8.Valid(original) {
		return envelope, format, nil, errors.New("invalid OpenAI request encoding")
	}
	return envelope, format, original, nil
}

type boundedBody struct {
	io.ReadCloser
	left       int64
	stop       func()
	closeOnce  sync.Once
	closeError error
	eof        atomic.Bool
}

func (r *boundedBody) Close() error {
	r.closeOnce.Do(func() {
		if r.stop != nil && !r.eof.Load() {
			r.stop()
		}
		r.closeError = r.ReadCloser.Close()
	})
	return r.closeError
}

func (r *boundedBody) Read(data []byte) (int, error) {
	if r.left < 0 {
		return 0, service.ZProxyRawLimitError
	}
	if int64(len(data)) > r.left+1 {
		data = data[:r.left+1]
	}
	n, err := r.ReadCloser.Read(data)
	if errors.Is(err, io.EOF) {
		r.eof.Store(true)
	}
	r.left -= int64(n)
	if r.left < 0 {
		return 0, service.ZProxyRawLimitError
	}
	return n, err
}

func (worker *worker) decode(w http.ResponseWriter, r *http.Request) {
	envelope, format, original, err := readEnvelope(r.Body)
	if err != nil {
		problem(w, 400, err)
		return
	}
	reasoningOrder := r.Header.Get("X-Zproxy-Reasoning-Order")
	if reasoningOrder != "" && reasoningOrder != "1" {
		problem(w, 400, errors.New("invalid reasoning-order option"))
		return
	}
	model := api.ZProxyModel{ID: format.ID, ModelProvider: api.ZProxyProvider(format.Compat.Provider), MaxOutputTokens: format.MaxTokens,
		MaxTokens: format.ContextWindow, SupportsThinking: format.Reasoning}
	for _, input := range format.Input {
		model.SupportsImages = model.SupportsImages || input == "image"
	}
	// A deliberate read deadline must not cancel the response it is completing.
	// A peer disconnect still cancels the decoder and its blocked body read.
	ctx, cancel := context.WithCancel(context.WithoutCancel(r.Context()))
	defer cancel()
	var stoppingRead atomic.Bool
	stopPeer := context.AfterFunc(r.Context(), func() {
		if !stoppingRead.Load() {
			cancel()
		}
	})
	defer stopPeer()
	if r.Context().Err() != nil {
		cancel()
	}
	source := &boundedBody{ReadCloser: r.Body, left: maxRawResponse,
		stop: func() { stoppingRead.Store(true); _ = http.NewResponseController(w).SetReadDeadline(time.Now()) }}
	api.ZProxyDecode(w, r.WithContext(ctx), envelope.Path, original, model, source, reasoningOrder == "1", worker.cache)
}

// run serves the private IPC socket. A non-empty stateDir enables the remote
// official account endpoints and holds every account's Hub and session state;
// an empty one leaves the worker local, so the official routes do not exist.
func run(socket, stateDir string) error {
	if !filepath.IsAbs(socket) {
		return errors.New("the socket path must be absolute")
	}
	var official *officialRuntime
	if stateDir != "" {
		opened, err := newOfficialRuntime(stateDir)
		if err != nil {
			return err
		}
		official = opened
	}
	if official != nil {
		defer official.Close()
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return err
	}
	defer listener.Close()
	defer os.Remove(socket)
	if err := os.Chmod(socket, 0600); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := &http.Server{ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 65536,
		BaseContext: func(net.Listener) context.Context { return ctx }}
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			cancel()
			deadline, done := context.WithTimeout(context.Background(), 3*time.Second)
			defer done()
			_ = server.Shutdown(deadline)
			_ = server.Close()
			if official != nil {
				_ = official.Close()
			}
		})
	}
	server.Handler = &worker{cache: api.NewZProxyCache(), official: official, stop: stop}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		select {
		case <-signals:
			stop()
		case <-ctx.Done():
		}
	}()
	fmt.Println("READY")
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("zproxy-ag Antigravity2API " + upstreamVersion)
		return
	}
	socket, stateDir, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "Usage: zproxy-ag --socket ABSOLUTE_PATH [--state-dir ABSOLUTE_PATH]")
		os.Exit(2)
	}
	if err := run(socket, stateDir); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// parseArgs accepts only the two documented shapes. The remote process adds
// --state-dir and owns the official accounts; the local process passes only
// --socket, so it can neither start nor reach an official account. Both paths
// must be absolute, and no other argument is accepted.
func parseArgs(args []string) (socket, stateDir string, err error) {
	if len(args) < 2 || args[0] != "--socket" || !filepath.IsAbs(args[1]) {
		return "", "", errors.New("invalid arguments")
	}
	socket = args[1]
	switch {
	case len(args) == 2:
		return socket, "", nil
	case len(args) == 4 && args[2] == "--state-dir" && filepath.IsAbs(args[3]):
		return socket, args[3], nil
	default:
		return "", "", errors.New("invalid arguments")
	}
}
