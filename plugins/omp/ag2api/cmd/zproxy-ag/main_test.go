package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Mag1cFall/Antigravity2API/internal/api"
)

func testPrelude(t *testing.T, original []byte) []byte {
	t.Helper()
	recipe := `{"api":"antigravity2api","provider":"google-antigravity","id":"fixture","reasoning":true,"input":["text"],"contextWindow":8192,"maxTokens":1024,"compat":{"agProvider":"google"}}`
	envelope, err := json.Marshal(map[string]any{"version": 1, "path": "/v1/chat/completions", "requestBytes": len(original), "status": 200,
		"headers": [][]string{{"content-type", "text/event-stream"}}, "metadata": map[string]any{"decoder": "omp-response", "version": 1, "modelAlias": "friendly", "requestId": "fixture", "attempt": 1, "isStreaming": true, "recipe": recipe}})
	if err != nil {
		t.Fatal(err)
	}
	prelude := make([]byte, 4)
	binary.BigEndian.PutUint32(prelude, uint32(len(envelope)))
	return append(append(prelude, envelope...), original...)
}

func TestZProxyHTTPDuplexReturnsTextBeforeRequestEOF(t *testing.T) {
	server := httptest.NewServer(&worker{cache: api.NewZProxyCache()})
	defer server.Close()
	connection, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	original := []byte(`{"model":"friendly","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"hi"}]}`)
	first := "data: {\"response\":{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"Hello\"}]}}]}}\n\n"
	prelude := append(testPrelude(t, original), []byte(first)...)
	_, err = fmt.Fprintf(connection, "POST /decode HTTP/1.1\r\nHost: private\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n%x\r\n%s\r\n", len(prelude), prelude)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || len(response.TransferEncoding) != 1 || response.TransferEncoding[0] != "chunked" {
		t.Fatalf("invalid private response: %+v", response)
	}
	reader := bufio.NewReader(response.Body)
	var received strings.Builder
	for !strings.Contains(received.String(), `"content":"Hello"`) {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("no text before upload EOF: %v, %s", err, received.String())
		}
		received.WriteString(line)
	}
	last := "data: {\"response\":{\"candidates\":[{\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":2,\"candidatesTokenCount\":1,\"totalTokenCount\":3}}}\n\n"
	_, err = fmt.Fprintf(connection, "%x\r\n%s\r\n0\r\n\r\n", len(last), last)
	if err != nil {
		t.Fatal(err)
	}
	tail, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	received.Write(tail)
	if !strings.Contains(received.String(), "data: [DONE]") || !strings.Contains(received.String(), `"total_tokens":3`) {
		t.Fatal(received.String())
	}
}

func TestZProxyPrivateJSONRoutesAndValidation(t *testing.T) {
	handler := &worker{cache: api.NewZProxyCache()}
	for _, row := range []struct {
		method, path, body string
		status             int
	}{
		{"GET", "/health", "", 200},
		{"POST", "/augment", `{"model":"friendly","messages":[{"role":"user","content":"hi"}]}`, 200},
		{"POST", "/augment", `{} {}`, 400},
		{"POST", "/prepare", `{"version":1,"request":{"model":"friendly","messages":[]},"model":{"id":"fixture","modelProvider":"MODEL_PROVIDER_GOOGLE","maxOutputTokens":1024,"maxTokens":8192,"apiKey":"forbidden"},"project":"project","session":"session"}`, 400},
		{"POST", "/unknown", "{}", 404},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(row.method, "http://private"+row.path, strings.NewReader(row.body)))
		if response.Code != row.status || response.Header().Get("Content-Length") != "" {
			t.Fatalf("%s: %d %s", row.path, response.Code, response.Body.String())
		}
	}
	bad := make([]byte, 4)
	binary.BigEndian.PutUint32(bad, 65537)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "http://private/decode", bytes.NewReader(bad)))
	if response.Code != 400 {
		t.Fatal("an oversized envelope was accepted")
	}
}

func TestZProxyRawBodyLimitIsNotASilentEOF(t *testing.T) {
	reader := &boundedBody{ReadCloser: io.NopCloser(strings.NewReader("too long")), left: 3}
	if _, err := io.ReadAll(reader); err == nil {
		t.Fatal("oversized raw response ended normally")
	}
}

func TestZProxyTokenLimitFinishesWithoutWaitingForUploadEOF(t *testing.T) {
	server := httptest.NewServer(&worker{cache: api.NewZProxyCache()})
	defer server.Close()
	connection, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	original := []byte(`{"model":"friendly","stream":true,"messages":[{"role":"user","content":"hi"}],"max_tokens":1}`)
	frame := "data: {\"response\":{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"over limit\"}]}}],\"usageMetadata\":{\"promptTokenCount\":2,\"candidatesTokenCount\":3,\"totalTokenCount\":5}}}\n\n"
	prefix := append(testPrelude(t, original), []byte(frame)...)
	if _, err := fmt.Fprintf(connection, "POST /decode HTTP/1.1\r\nHost: private\r\nTransfer-Encoding: chunked\r\n\r\n%x\r\n%s\r\n", len(prefix), prefix); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	output, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(output), `"finish_reason":"length"`) || !strings.Contains(string(output), "data: [DONE]") || strings.Contains(string(output), "over limit") {
		t.Fatalf("the decoder waited for source EOF or ignored the limit: %s", output)
	}
}
