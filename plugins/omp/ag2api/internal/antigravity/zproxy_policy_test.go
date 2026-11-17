package antigravity

import (
	"io"
	"net/http"
	"net/netip"
	"strings"
	"testing"
)

func TestZProxyTokenSourceKeepsOnlyCurrentToken(t *testing.T) {
	source := &ZProxyTokenSource{}
	if err := source.Update("first-fixture"); err != nil { t.Fatal(err) }
	if err := source.Update("second-fixture"); err != nil { t.Fatal(err) }
	token, err := source.Token()
	if err != nil || token.AccessToken != "second-fixture" { t.Fatal("current token not used") }
	if err := source.Update("invalid token"); err == nil { t.Fatal("invalid token accepted") }
	token, err = source.Token()
	if err != nil || token.AccessToken != "second-fixture" { t.Fatal("invalid update changed token") }
	if err := source.Update("newer-fixture", 2000); err != nil { t.Fatal(err) }
	if err := source.Update("older-fixture", 1000); err == nil { t.Fatal("stale concurrent token accepted") }
	token, err = source.Token()
	if err != nil || token.AccessToken != "newer-fixture" { t.Fatal("stale token replaced the newer one") }
	source.Clear()
	if _, err := source.Token(); err == nil { t.Fatal("cleared token remained available") }
}

func TestZProxyOfficialDestinationsAndAddresses(t *testing.T) {
	if !zproxyAuthHost("daily-cloudcode-pa.googleapis.com") || zproxyAuthHost("daily-cloudcode-pa.googleapis.com.evil.example") || zproxyAuthHost("localhost") { t.Fatal("authentication host boundary failed") }
	if !zproxyWebHost("lh3.googleusercontent.com") || zproxyAuthHost("lh3.googleusercontent.com") { t.Fatal("unauthenticated host boundary failed") }
	for _, text := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"} {
		if zproxyPublicAddress(netip.MustParseAddr(text)) { t.Fatal("private or non-IPv4 address accepted") }
	}
	if !zproxyPublicAddress(netip.MustParseAddr("8.8.8.8")) { t.Fatal("public IPv4 address rejected") }
	if !zproxyPublicAddress(netip.MustParseAddr("::ffff:8.8.8.8")) { t.Fatal("mapped public IPv4 address rejected") }
}

func TestZProxyBoundedBodyStopsOversize(t *testing.T) {
	body := &zproxyLimitedBody{ReadCloser: io.NopCloser(strings.NewReader("123456")), remaining: 5}
	data, err := io.ReadAll(body)
	if err == nil || len(data) > 5 { t.Fatal("oversize response was accepted") }
	body = &zproxyLimitedBody{ReadCloser: io.NopCloser(strings.NewReader("12345")), remaining: 5}
	data, err = io.ReadAll(body)
	if err != nil || string(data) != "12345" { t.Fatal("bounded response changed") }
}

func TestZProxyRedirectDoesNotMoveCredentials(t *testing.T) {
	before, _ := http.NewRequest("GET", "https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=fixture", nil)
	after, _ := http.NewRequest("GET", "https://storage.googleapis.com/fixture", nil)
	if zproxyRedirect(zproxyWebHost, false)(after, []*http.Request{before}) != http.ErrUseLastResponse { t.Fatal("token-bearing redirect was allowed") }
	before, _ = http.NewRequest("GET", "https://daily-cloudcode-pa.googleapis.com/fixture", nil)
	after, _ = http.NewRequest("GET", "https://cloudcode-pa.googleapis.com/fixture", nil)
	if zproxyRedirect(zproxyAuthHost, true)(after, []*http.Request{before}) != http.ErrUseLastResponse { t.Fatal("authenticated cross-host redirect was allowed") }
}
