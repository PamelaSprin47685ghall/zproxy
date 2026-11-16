package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/Mag1cFall/Antigravity2API/internal/api"
)

func TestZProxyAugmentHTTPPreservesLegacyJSON(t *testing.T) {
	server := httptest.NewServer(&worker{cache: api.NewZProxyCache()})
	t.Cleanup(server.Close)
	for _, framing := range []string{"chunked", "content-length"} {
		for index := range 6 {
			t.Run(fmt.Sprintf("%s-%d", framing, index), func(t *testing.T) {
				t.Parallel()
				connection, err := net.Dial("tcp", server.Listener.Addr().String())
				if err != nil {
					t.Fatal(err)
				}
				defer connection.Close()
				_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
				original := []byte(`{"model":"fixture-alias","prompt":"legacy-smoke","stream":false}`)
				headers := "POST /augment HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\n"
				if framing == "chunked" {
					_, err = fmt.Fprintf(connection, "%sTransfer-Encoding: chunked\r\n\r\n%x\r\n%s\r\n%x\r\n%s\r\n0\r\n\r\n",
						headers, 7, original[:7], len(original)-7, original[7:])
				} else {
					_, err = fmt.Fprintf(connection, "%sContent-Length: %d\r\n\r\n%s", headers, len(original), original)
				}
				if err != nil {
					t.Fatal(err)
				}
				response, err := http.ReadResponse(bufio.NewReader(connection), nil)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				body, err := io.ReadAll(response.Body)
				if err != nil {
					t.Fatalf("the short JSON response did not finish: %v; %s", err, body)
				}
				if response.StatusCode != 200 || response.ContentLength != -1 || len(response.TransferEncoding) != 1 || response.TransferEncoding[0] != "chunked" {
					t.Fatalf("invalid short JSON response: status=%d framing=%v length=%d body=%s", response.StatusCode, response.TransferEncoding, response.ContentLength, body)
				}
				var before, after map[string]any
				if err := json.Unmarshal(original, &before); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(body, &after); err != nil {
					t.Fatalf("invalid returned JSON: %v; %s", err, body)
				}
				if !reflect.DeepEqual(before, after) {
					t.Fatalf("augment changed the legacy request: %s", body)
				}
			})
		}
	}
}
