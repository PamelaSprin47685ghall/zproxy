package antigravity

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"golang.org/x/oauth2"
)

// zproxyReply is one canned transport answer.
type zproxyReply struct {
	status int
	header http.Header
	body   string
}

// zproxyTrackedBody records whether a response body was closed.
type zproxyTrackedBody struct {
	io.Reader
	closed bool
}

func (body *zproxyTrackedBody) Close() error {
	body.closed = true
	return nil
}

// zproxyTransport is an in-memory RoundTripper: it records each request and
// answers with reply or err. It opens no socket.
type zproxyTransport struct {
	mu      sync.Mutex
	reply   zproxyReply
	err     error
	methods []string
	urls    []string
	headers []http.Header
	bodies  []string
	opened  *zproxyTrackedBody
}

func (transport *zproxyTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	var body string
	if request.Body != nil {
		data, err := io.ReadAll(request.Body)
		if err != nil {
			return nil, err
		}
		body = string(data)
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	transport.methods = append(transport.methods, request.Method)
	transport.urls = append(transport.urls, request.URL.String())
	transport.headers = append(transport.headers, request.Header.Clone())
	transport.bodies = append(transport.bodies, body)
	if transport.err != nil {
		return nil, transport.err
	}
	header := transport.reply.header
	if header == nil {
		header = http.Header{}
	}
	transport.opened = &zproxyTrackedBody{Reader: strings.NewReader(transport.reply.body)}
	return &http.Response{
		StatusCode:    transport.reply.status,
		Status:        http.StatusText(transport.reply.status),
		Header:        header.Clone(),
		Body:          transport.opened,
		ContentLength: int64(len(transport.reply.body)),
	}, nil
}

// last returns the fields of the most recent recorded request.
func (transport *zproxyTransport) last() (string, string, http.Header, string) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if len(transport.methods) == 0 {
		return "", "", nil, ""
	}
	index := len(transport.methods) - 1
	return transport.methods[index], transport.urls[index], transport.headers[index], transport.bodies[index]
}

func zproxyTestClient(t *testing.T, device Device, transport http.RoundTripper) *Client {
	t.Helper()
	source := &ZProxyTokenSource{}
	if err := source.Update("fixture-token"); err != nil { t.Fatal(err) }
	client, err := NewZProxyClient(device, source)
	if err != nil { t.Fatal(err) }
	client.http.Transport = &oauth2.Transport{Source: source, Base: transport}
	client.auth.Transport = &oauth2.Transport{Source: source, Base: transport}
	client.web.Transport = transport
	return client
}

func zproxyTestDevice() Device {
	return Device{OS: "linux", Arch: "amd64", TimeZone: "UTC", InstallationID: "installation"}
}

// TestNewZProxyClientSplitsTransports checks the official authenticated and web clients.
func TestNewZProxyClientSplitsTransports(t *testing.T) {
	transport := &zproxyTransport{reply: zproxyReply{status: http.StatusOK}}
	client := zproxyTestClient(t, zproxyTestDevice(), transport)
	if client.base != EndpointDaily {
		t.Fatalf("base = %q, want %q", client.base, EndpointDaily)
	}
	if client.project != "" {
		t.Fatalf("project = %q, want none", client.project)
	}
	if client.account != "zproxy" { t.Fatal("unexpected account label") }
	if _, ok := client.source.(*ZProxyTokenSource); !ok { t.Fatal("wrong token owner") }
	cases := []struct {
		name          string
		target        *http.Client
		authorization string
	}{
		{"http", client.http, "Bearer " + "fixture-token"},
		{"auth", client.auth, "Bearer " + "fixture-token"},
		{"web", client.web, ""},
	}
	for _, test := range cases {
		request, err := http.NewRequest(http.MethodGet, EndpointDaily+"/probe", nil)
		if err != nil {
			t.Fatalf("%s: new request: %v", test.name, err)
		}
		response, err := test.target.Do(request)
		if err != nil {
			t.Fatalf("%s: do: %v", test.name, err)
		}
		_ = response.Body.Close()
		method, target, header, _ := transport.last()
		if method != http.MethodGet || target != EndpointDaily+"/probe" {
			t.Fatalf("%s: request = %s %s", test.name, method, target)
		}
		if got := header.Get("Authorization"); got != test.authorization {
			t.Fatalf("%s: authorization = %q, want %q", test.name, got, test.authorization)
		}
	}
}

// TestZProxyRawReturnsRawStream proves the official hop runs unchanged and the
// successful body reaches the caller byte for byte, open and undecoded.
func TestZProxyRawReturnsRawStream(t *testing.T) {
	stream := "data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hi\"}]}}]}}\r\n\r\n"
	transport := &zproxyTransport{reply: zproxyReply{status: http.StatusOK,
		header: http.Header{"Content-Type": []string{"text/event-stream"}}, body: stream}}
	device := zproxyTestDevice()
	client := zproxyTestClient(t, device, transport)
	envelope := Envelope{Project: "project", RequestID: "request", Model: "model",
		UserAgent: envelopeUserAgent, RequestType: requestTypeAgent,
		Request: WireRequest{SessionID: sessionID}}
	response, err := client.ZProxyRaw(context.Background(), envelope)
	if err != nil {
		t.Fatalf("ZProxyRaw: %v", err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
	if got := response.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("content type = %q, want text/event-stream", got)
	}
	opened := transport.opened
	if opened == nil || opened.closed {
		t.Fatal("a successful body must stay open for the caller")
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(data) != stream {
		t.Fatalf("body = %q, want %q", data, stream)
	}
	_ = response.Body.Close()
	if !opened.closed {
		t.Fatal("closing the response must reach the upstream body")
	}
	method, target, header, body := transport.last()
	if method != http.MethodPost {
		t.Fatalf("method = %q, want POST", method)
	}
	if target != EndpointDaily+"/v1internal:streamGenerateContent?alt=sse" {
		t.Fatalf("target = %q", target)
	}
	if got := header.Get("Content-Type"); got != "application/json" {
		t.Fatalf("request content type = %q, want application/json", got)
	}
	if got := header.Get("User-Agent"); got != device.UserAgent() {
		t.Fatalf("user agent = %q, want %q", got, device.UserAgent())
	}
	want, err := device.hubJSON(envelope)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if body != string(want) {
		t.Fatalf("body = %q, want %q", body, want)
	}
}

// TestZProxyRawReportsUpstreamError proves a non-2xx answer returns the official
// error with its raw body, closed and redacted in the message.
func TestZProxyRawReportsUpstreamError(t *testing.T) {
	body := "{\"error\":{\"message\":\"caller a@example.com on projects/project-1\",\"status\":\"PERMISSION_DENIED\"}}"
	transport := &zproxyTransport{reply: zproxyReply{status: http.StatusForbidden, body: body}}
	client := zproxyTestClient(t, zproxyTestDevice(), transport)
	response, err := client.ZProxyRaw(context.Background(), Envelope{Project: "project", RequestType: requestTypeAgent})
	if response != nil {
		t.Fatalf("response = %v, want nil", response)
	}
	var upstream *UpstreamError
	if !errors.As(err, &upstream) {
		t.Fatalf("error = %v, want *UpstreamError", err)
	}
	if upstream.Status != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", upstream.Status)
	}
	if string(upstream.Body) != body {
		t.Fatalf("body = %q, want %q", upstream.Body, body)
	}
	if strings.Contains(err.Error(), "a@example.com") {
		t.Fatalf("the error message leaks an address: %v", err)
	}
	if transport.opened == nil || !transport.opened.closed {
		t.Fatal("a rejected body must be closed before the error returns")
	}
}

// TestZProxyRawReturnsTransportError proves a transport failure returns no response
// and keeps the transport error for the caller.
func TestZProxyRawReturnsTransportError(t *testing.T) {
	failure := errors.New("the injected transport refused the request")
	transport := &zproxyTransport{err: failure}
	client := zproxyTestClient(t, zproxyTestDevice(), transport)
	response, err := client.ZProxyRaw(context.Background(), Envelope{Project: "project", RequestType: requestTypeAgent})
	if response != nil {
		t.Fatalf("response = %v, want nil", response)
	}
	if !errors.Is(err, failure) {
		t.Fatalf("error = %v, want %v", err, failure)
	}
}

// TestZProxyRawUsesTabProfile proves a tab envelope keeps the official tab
// encoding and IDE User-Agent, so ZProxyRaw adds no request shaping.
func TestZProxyRawUsesTabProfile(t *testing.T) {
	transport := &zproxyTransport{reply: zproxyReply{status: http.StatusOK}}
	device := zproxyTestDevice()
	client := zproxyTestClient(t, device, transport)
	envelope := Envelope{Project: "project", RequestID: "request", Model: "model",
		UserAgent: envelopeUserAgent, RequestType: requestTypeTab}
	response, err := client.ZProxyRaw(context.Background(), envelope)
	if err != nil {
		t.Fatalf("ZProxyRaw: %v", err)
	}
	_ = response.Body.Close()
	_, _, header, body := transport.last()
	if got := header.Get("User-Agent"); got != device.IDEUserAgent() {
		t.Fatalf("user agent = %q, want %q", got, device.IDEUserAgent())
	}
	want, err := marshal(envelope)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if body != string(want) {
		t.Fatalf("body = %q, want %q", body, want)
	}
}
