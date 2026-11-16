package main

import (
	"bufio"
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

func TestZProxyBadPreludeClosesWithoutWaitingForUploadEOF(t *testing.T) {
	server := httptest.NewServer(&worker{cache: api.NewZProxyCache()})
	defer server.Close()
	connection, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := fmt.Fprint(connection, "POST /decode HTTP/1.1\r\nHost: private\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n\x00\x01\x00\x01\r\n"); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != 400 || !strings.Contains(string(body), "invalid decode envelope size") {
		t.Fatalf("invalid input did not finish its response: %d %s %v", response.StatusCode, body, err)
	}
}
