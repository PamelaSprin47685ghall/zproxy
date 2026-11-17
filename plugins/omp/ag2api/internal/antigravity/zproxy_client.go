package antigravity

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"

	"golang.org/x/oauth2"
)

// ZProxyTokenSource holds only the access token selected by the remote OMP owner.
// It does not refresh or persist credentials.
type ZProxyTokenSource struct {
	mu sync.RWMutex
	access string
	expiresAt int64
}

func (source *ZProxyTokenSource) Update(access string, expiry ...int64) error {
	if len(access) == 0 || len(access) > 4096 || strings.ContainsFunc(access, func(r rune) bool { return r <= 32 || r >= 127 }) {
		return errors.New("invalid upstream access token")
	}
	expiresAt := int64(0)
	if len(expiry) != 0 { expiresAt = expiry[0] }
	if expiresAt < 0 { return errors.New("invalid upstream token expiry") }
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.access != "" && source.access != access && source.expiresAt > 0 && (expiresAt == 0 || expiresAt < source.expiresAt) {
		return errors.New("stale upstream token")
	}
	source.access, source.expiresAt = access, expiresAt
	return nil
}

func (source *ZProxyTokenSource) Clear() {
	source.mu.Lock()
	source.access, source.expiresAt = "", 0
	source.mu.Unlock()
}

func (source *ZProxyTokenSource) Token() (*oauth2.Token, error) {
	source.mu.RLock()
	access := source.access
	source.mu.RUnlock()
	if access == "" { return nil, errors.New("upstream access token is unavailable") }
	return &oauth2.Token{AccessToken: access, TokenType: "Bearer"}, nil
}

func zproxyAuthHost(host string) bool {
	switch strings.ToLower(host) {
	case "cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com", "businessaicode.googleapis.com", "aicode.googleapis.com", "www.googleapis.com", "play.googleapis.com":
		return true
	default:
		return false
	}
}

func zproxyWebHost(host string) bool {
	host = strings.ToLower(host)
	return zproxyAuthHost(host) || host == "storage.googleapis.com" || host == "raw.githubusercontent.com" || host == "open-vsx.org" || host == "marketplace.visualstudio.com" || strings.HasSuffix(host, ".googleusercontent.com")
}

var zproxySharedSpace = netip.MustParsePrefix("100.64.0.0/10")
var zproxyBenchmarkSpace = netip.MustParsePrefix("198.18.0.0/15")

func zproxyPublicAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.Is4() && ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !zproxySharedSpace.Contains(ip) && !zproxyBenchmarkSpace.Contains(ip)
}

// zproxyDialIPv4 resolves only A records. The original hostname remains on the
// HTTP request, so net/http keeps normal certificate and hostname validation.
func zproxyDialIPv4(allow func(string) bool) func(context.Context, string, string) (net.Conn, error) {
	resolver := &net.Resolver{PreferGo: true}
	dialer := &net.Dialer{}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil || port != "443" || !allow(host) { return nil, errors.New("official upstream destination is not allowed") }
		ips, err := resolver.LookupNetIP(ctx, "ip4", host)
		if err != nil { return nil, errors.New("official upstream DNS lookup failed") }
		for _, ip := range ips {
			ip = ip.Unmap()
			if !zproxyPublicAddress(ip) { continue }
			conn, err := dialer.DialContext(ctx, "tcp4", net.JoinHostPort(ip.String(), port))
			if err == nil { return conn, nil }
			if ctx.Err() != nil { return nil, ctx.Err() }
		}
		return nil, errors.New("official upstream connection failed")
	}
}

type zproxyBoundedTransport struct {
	transport *proxyTransport
	allow func(string) bool
}

func (transport *zproxyBoundedTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL == nil || request.URL.Scheme != "https" || request.URL.User != nil || !transport.allow(request.URL.Hostname()) || (request.URL.Port() != "" && request.URL.Port() != "443") {
		if request.Body != nil { _ = request.Body.Close() }
		return nil, errors.New("official upstream destination is not allowed")
	}
	response, err := transport.transport.RoundTrip(request)
	if err != nil { return nil, err }
	limit := int64(4 << 20)
	if response.StatusCode < 200 || response.StatusCode >= 300 { limit = 64 << 10 }
	if request.URL.Path == "/v1internal:streamGenerateContent" && response.StatusCode >= 200 && response.StatusCode < 300 { return response, nil }
	response.Body = &zproxyLimitedBody{ReadCloser: response.Body, remaining: limit}
	return response, nil
}

func (transport *zproxyBoundedTransport) CloseIdleConnections() {
	transport.transport.mu.Lock()
	defer transport.transport.mu.Unlock()
	for _, connection := range transport.transport.transports { connection.CloseIdleConnections() }
}

type zproxyLimitedBody struct {
	io.ReadCloser
	remaining int64
}

func (body *zproxyLimitedBody) Read(buffer []byte) (int, error) {
	if body.remaining < 0 { return 0, errors.New("official upstream response exceeds its limit") }
	if int64(len(buffer)) > body.remaining+1 { buffer = buffer[:body.remaining+1] }
	n, err := body.ReadCloser.Read(buffer)
	if int64(n) > body.remaining { body.remaining = -1; return 0, errors.New("official upstream response exceeds its limit") }
	body.remaining -= int64(n)
	return n, err
}

func zproxyConfigureResolver(transport *proxyTransport, allow func(string) bool) {
	build := transport.build
	transport.build = func(proxy Proxy) *http.Transport {
		connection := build(proxy)
		connection.DialContext = zproxyDialIPv4(allow)
		return connection
	}
}

func zproxyRedirect(allow func(string) bool, authenticated bool) func(*http.Request, []*http.Request) error {
	return func(request *http.Request, via []*http.Request) error {
		if len(via) >= 10 || request.URL.Scheme != "https" || request.URL.User != nil || !allow(request.URL.Hostname()) || (request.URL.Port() != "" && request.URL.Port() != "443") { return http.ErrUseLastResponse }
		if len(via) > 0 && !strings.EqualFold(request.URL.Hostname(), via[0].URL.Hostname()) && (authenticated || via[0].URL.Query().Has("access_token")) { return http.ErrUseLastResponse }
		return nil
	}
}

// NewZProxyClient keeps the official Client while restricting DNS and origins.
// Its token source is updated by OMP and stays in the remote process only.
func NewZProxyClient(device Device, source *ZProxyTokenSource) (*Client, error) {
	if source == nil { return nil, errors.New("the upstream token source is required") }
	client := NewClient("zproxy", source, device, nil)
	apiAuth, ok := client.http.Transport.(*oauth2.Transport)
	if !ok { return nil, errors.New("invalid official API transport") }
	api, ok := apiAuth.Base.(*proxyTransport)
	if !ok { return nil, errors.New("invalid official API transport") }
	web, ok := client.web.Transport.(*proxyTransport)
	if !ok { return nil, errors.New("invalid official web transport") }
	webAuth, ok := client.auth.Transport.(*oauth2.Transport)
	if !ok { return nil, errors.New("invalid official auth transport") }
	zproxyConfigureResolver(api, zproxyAuthHost)
	zproxyConfigureResolver(web, zproxyWebHost)
	apiAuth.Base = &zproxyBoundedTransport{transport: api, allow: zproxyAuthHost}
	webAuth.Base = &zproxyBoundedTransport{transport: web, allow: zproxyAuthHost}
	client.web.Transport = &zproxyBoundedTransport{transport: web, allow: zproxyWebHost}
	client.http.CheckRedirect = zproxyRedirect(zproxyAuthHost, true)
	client.auth.CheckRedirect = zproxyRedirect(zproxyAuthHost, true)
	client.web.CheckRedirect = zproxyRedirect(zproxyWebHost, false)
	return client, nil
}

// ZProxyRaw returns the official upstream response without decoding its stream.
func (client *Client) ZProxyRaw(ctx context.Context, envelope Envelope) (*http.Response, error) {
	exchange := &Exchange{URL: client.base + "/v1internal:streamGenerateContent?alt=sse"}
	response, _, err := client.streamHop(ctx, envelope, exchange)
	if err != nil { return nil, err }
	return response, nil
}

func (client *Client) ZProxyClose() {
	client.http.CloseIdleConnections()
	client.web.CloseIdleConnections()
	client.auth.CloseIdleConnections()
}
