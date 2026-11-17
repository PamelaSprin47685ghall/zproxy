package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
	"github.com/Mag1cFall/Antigravity2API/internal/api"
	"github.com/Mag1cFall/Antigravity2API/internal/service"
)

// officialTestHandler serves the private worker with a fixed injected cold
// start, so an official route never opens a socket.
func officialTestHandler(t *testing.T, boot *officialTestBoot) *worker {
	t.Helper()
	runtime, _ := officialTestRuntime(t)
	if boot != nil {
		runtime.boot = boot.start
	}
	return &worker{cache: api.NewZProxyCache(), official: runtime}
}

// officialTestPost invokes one private route and returns the recorded answer.
func officialTestPost(handler http.Handler, path string, body any) *httptest.ResponseRecorder {
	var reader io.Reader
	if raw, ok := body.(string); ok {
		reader = strings.NewReader(raw)
	} else {
		data, err := json.Marshal(body)
		if err != nil {
			panic(err)
		}
		reader = bytes.NewReader(data)
	}
	request := httptest.NewRequest("POST", "http://private"+path, reader)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

// officialErrorMessage returns the fixed message of a private error reply.
func officialErrorMessage(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	var reply struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &reply); err != nil {
		t.Fatalf("the error reply is not JSON: %v %s", err, response.Body.String())
	}
	return reply.Error.Message
}

// officialTestEnvelope returns an envelope the send route accepts, so a test
// reaches the account lookup instead of the envelope check.
func officialTestEnvelope() antigravity.Envelope {
	return antigravity.Envelope{
		Project:     "",
		RequestID:   "agent/cascade/1/trajectory/0",
		Model:       "fixture-model",
		UserAgent:   "antigravity",
		RequestType: "agent",
		Request: antigravity.WireRequest{
			Contents: []antigravity.WireContent{{Role: "user", Parts: []antigravity.WirePart{{Text: "hi"}}}},
		},
	}
}

// officialTestPrepareInput returns a complete prepare exchange.
func officialTestPrepareInput(request string) map[string]any {
	return map[string]any{
		"version":     1,
		"request":     json.RawMessage(request),
		"model":       map[string]any{"id": "fixture-model", "modelProvider": "MODEL_PROVIDER_GOOGLE", "maxOutputTokens": 1024, "maxTokens": 8192},
		"scope":       "scope-fixture",
		"handle":      officialTestHandle("http-prepare"),
		"device":      officialTestDevice,
		"project":     "",
		"accessToken": officialTestToken,
		"expiresAt":   0,
	}
}

// officialTestSendInput returns a complete send exchange.
func officialTestSendInput() map[string]any {
	return map[string]any{
		"version":     1,
		"handle":      officialTestHandle("http-send"),
		"device":      officialTestDevice,
		"accessToken": officialTestToken,
		"expiresAt":   0,
		"body":        officialTestEnvelope(),
	}
}

func TestOfficialRoutesDoNotExistWithoutStateDirectory(t *testing.T) {
	// A local worker carries no account runtime, so both official routes are
	// unknown there and neither can start an account.
	handler := &worker{cache: api.NewZProxyCache()}
	for _, path := range []string{"/official-prepare", "/official-send"} {
		response := officialTestPost(handler, path, map[string]any{"version": 1})
		if response.Code != 404 {
			t.Fatalf("%s answered %d", path, response.Code)
		}
		if message := officialErrorMessage(t, response); !strings.Contains(message, "unknown private route") {
			t.Fatalf("%s reported %q", path, message)
		}
	}
}

func TestParseArgsAcceptsOnlyTheTwoDocumentedShapes(t *testing.T) {
	socket, stateDir, err := parseArgs([]string{"--socket", "/tmp/a.sock"})
	if err != nil || socket != "/tmp/a.sock" || stateDir != "" {
		t.Fatalf("the local shape parsed as %q %q %v", socket, stateDir, err)
	}
	socket, stateDir, err = parseArgs([]string{"--socket", "/tmp/a.sock", "--state-dir", "/tmp/state"})
	if err != nil || socket != "/tmp/a.sock" || stateDir != "/tmp/state" {
		t.Fatalf("the remote shape parsed as %q %q %v", socket, stateDir, err)
	}
	for _, args := range [][]string{
		nil,
		{"--socket"},
		{"--socket", "relative.sock"},
		{"--state-dir", "/tmp/state"},
		{"--socket", "/tmp/a.sock", "--state-dir", "relative"},
		{"--socket", "/tmp/a.sock", "--state-dir"},
		{"--socket", "/tmp/a.sock", "--state-dir", "/tmp/state", "extra"},
		{"--socket", "/tmp/a.sock", "--other", "/tmp/state"},
		{"--socket", "/tmp/a.sock", "--state-dir", "/tmp/state", "--state-dir", "/tmp/state2"},
	} {
		if _, _, err := parseArgs(args); err == nil {
			t.Fatalf("%v was accepted", args)
		}
	}
}

func TestOfficialPrepareRejectsInvalidInputBeforeStartingAnAccount(t *testing.T) {
	boot := &officialTestBoot{}
	handler := officialTestHandler(t, boot)
	valid := officialTestPrepareInput(`{"model":"fixture-model","messages":[{"role":"user","content":"hi"}]}`)
	cases := []struct {
		name string
		body any
	}{
		{"version", mutate(valid, "version", 2)},
		{"empty request", mutate(valid, "request", json.RawMessage(nil))},
		{"bad handle", mutate(valid, "handle", "short")},
		{"bad scope", mutate(valid, "scope", "")},
		{"control scope", mutate(valid, "scope", "a\nb")},
		{"control project", mutate(valid, "project", "a\nb")},
		{"missing device field", mutate(valid, "device", map[string]any{"os": "linux"})},
		{"control device field", mutate(valid, "device", map[string]any{
			"os": "linux", "arch": "amd64", "user_name": "fixture", "app_data_dir": "/a", "time_zone": "UTC", "installation_id": "a\tb",
		})},
		{"unknown field", mutate(valid, "email", "person@example.com")},
		{"not json", "{}{}"},
	}
	for _, row := range cases {
		response := officialTestPost(handler, "/official-prepare", row.body)
		if response.Code != 400 {
			t.Fatalf("%s answered %d: %s", row.name, response.Code, response.Body.String())
		}
		message := officialErrorMessage(t, response)
		if message != officialMessageInput {
			t.Fatalf("%s reported %q", row.name, message)
		}
		for _, secret := range []string{officialTestToken, "person@example.com", officialTestHandle("http-prepare"), "fixture"} {
			if strings.Contains(response.Body.String(), secret) {
				t.Fatalf("%s repeated %q: %s", row.name, secret, response.Body.String())
			}
		}
	}
	if boot.count() != 0 {
		t.Fatalf("refused input started %d cold starts", boot.count())
	}
}

// mutate returns a shallow copy of body with key set to value.
func mutate(body map[string]any, key string, value any) map[string]any {
	copied := make(map[string]any, len(body)+1)
	for name, current := range body {
		copied[name] = current
	}
	copied[key] = value
	return copied
}

func TestOfficialPrepareRefusesATokenBeforeAnyColdStart(t *testing.T) {
	boot := &officialTestBoot{}
	handler := officialTestHandler(t, boot)
	body := mutate(officialTestPrepareInput(`{"model":"fixture-model","messages":[]}`), "accessToken", "two words")
	response := officialTestPost(handler, "/official-prepare", body)
	if response.Code != 401 {
		t.Fatalf("an unusable token answered %d: %s", response.Code, response.Body.String())
	}
	if message := officialErrorMessage(t, response); message != errOfficialToken.Error() {
		t.Fatalf("an unusable token reported %q", message)
	}
	if boot.count() != 0 {
		t.Fatal("an unusable token started a cold start")
	}
	if strings.Contains(response.Body.String(), "two words") {
		t.Fatal("the reply repeated the token")
	}
}

func TestOfficialPrepareReportsAMissingModelWithoutComposing(t *testing.T) {
	// The injected cold start returns no catalog, so the selected model has no
	// account entry and the route answers before any official call.
	boot := &officialTestBoot{}
	handler := officialTestHandler(t, boot)
	response := officialTestPost(handler, "/official-prepare", officialTestPrepareInput(`{"model":"fixture-model","messages":[]}`))
	if response.Code != 503 {
		t.Fatalf("a missing model answered %d: %s", response.Code, response.Body.String())
	}
	if message := officialErrorMessage(t, response); message != officialMessageModel {
		t.Fatalf("a missing model reported %q", message)
	}
	if boot.count() != 1 {
		t.Fatalf("the model lookup ran %d cold starts", boot.count())
	}
}

func TestOfficialPrepareReportsAFailedColdStartWithoutItsText(t *testing.T) {
	boot := &officialTestBoot{err: errors.New("dial failed for person@example.com with fixture-access-token")}
	handler := officialTestHandler(t, boot)
	response := officialTestPost(handler, "/official-prepare", officialTestPrepareInput(`{"model":"fixture-model","messages":[]}`))
	if response.Code != 502 {
		t.Fatalf("a failed cold start answered %d: %s", response.Code, response.Body.String())
	}
	if message := officialErrorMessage(t, response); message != errOfficialBoot.Error() {
		t.Fatalf("a failed cold start reported %q", message)
	}
	for _, secret := range []string{"person@example.com", officialTestToken, "dial failed"} {
		if strings.Contains(response.Body.String(), secret) {
			t.Fatalf("the reply repeated %q: %s", secret, response.Body.String())
		}
	}
}

func TestOfficialPrepareRefusesAConflictingDevice(t *testing.T) {
	boot := &officialTestBoot{}
	handler := officialTestHandler(t, boot)
	body := mutate(officialTestPrepareInput(`{"model":"fixture-model","messages":[]}`), "handle", officialTestHandle("conflict"))
	// The first exchange starts the account, so the second profile conflicts.
	if response := officialTestPost(handler, "/official-prepare", body); response.Code != 503 {
		t.Fatalf("the first exchange answered %d: %s", response.Code, response.Body.String())
	}
	other := officialTestDevice
	other.InstallationID = "other-fixture"
	response := officialTestPost(handler, "/official-prepare", mutate(body, "device", other))
	if response.Code != 409 {
		t.Fatalf("a conflicting device answered %d: %s", response.Code, response.Body.String())
	}
	if message := officialErrorMessage(t, response); message != errOfficialDevice.Error() {
		t.Fatalf("a conflicting device reported %q", message)
	}
	if boot.count() != 1 {
		t.Fatalf("a device conflict ran %d cold starts", boot.count())
	}
}

func TestOfficialSendRejectsInvalidInputBeforeStartingAnAccount(t *testing.T) {
	boot := &officialTestBoot{}
	handler := officialTestHandler(t, boot)
	valid := officialTestSendInput()
	badEnvelope := officialTestEnvelope()
	badEnvelope.RequestType = "tab"
	cases := []struct {
		name   string
		body   any
		status int
	}{
		{"version", mutate(valid, "version", 2), 400},
		{"bad handle", mutate(valid, "handle", "../escape"), 400},
		{"missing device", mutate(valid, "device", map[string]any{"os": "linux"}), 400},
		{"non-agent envelope", mutate(valid, "body", badEnvelope), 400},
		{"empty model", mutate(valid, "body", antigravity.Envelope{RequestType: "agent"}), 400},
		{"control project", mutate(valid, "body", func() antigravity.Envelope {
			envelope := officialTestEnvelope()
			envelope.Project = "a\rb"
			return envelope
		}()), 400},
		{"oversized continuation", mutate(valid, "continuationToken", strings.Repeat("t", maxOfficialContinuation+1)), 400},
		{"unknown field", mutate(valid, "body", map[string]any{"requestType": "agent", "token": officialTestToken}), 400},
		{"not json", "}{", 400},
	}
	for _, row := range cases {
		response := officialTestPost(handler, "/official-send", row.body)
		if response.Code != row.status {
			t.Fatalf("%s answered %d: %s", row.name, response.Code, response.Body.String())
		}
		message := officialErrorMessage(t, response)
		if message != officialMessageEnvelope && message != officialMessageInput && message != errOfficialHandle.Error() {
			t.Fatalf("%s reported %q", row.name, message)
		}
		for _, secret := range []string{officialTestToken, "../escape"} {
			if strings.Contains(response.Body.String(), secret) {
				t.Fatalf("%s repeated %q: %s", row.name, secret, response.Body.String())
			}
		}
	}
	if boot.count() != 0 {
		t.Fatalf("refused input started %d cold starts", boot.count())
	}
}

func TestOfficialSendRefusesAnUnusableTokenBeforeAnyColdStart(t *testing.T) {
	boot := &officialTestBoot{}
	handler := officialTestHandler(t, boot)
	response := officialTestPost(handler, "/official-send", mutate(officialTestSendInput(), "accessToken", ""))
	if response.Code != 401 {
		t.Fatalf("an unusable token answered %d: %s", response.Code, response.Body.String())
	}
	if message := officialErrorMessage(t, response); message != errOfficialToken.Error() {
		t.Fatalf("an unusable token reported %q", message)
	}
	if boot.count() != 0 {
		t.Fatal("an unusable token started a cold start")
	}
}

// officialTestResponse builds an upstream answer over a fixed body.
func officialTestResponse(status int, header http.Header, body io.ReadCloser) *http.Response {
	return &http.Response{StatusCode: status, Header: header, Body: body}
}

// officialTestClosedBody records whether the stream was closed.
type officialTestClosedBody struct {
	io.Reader
	closed bool
	err    error
}

func (body *officialTestClosedBody) Close() error {
	body.closed = true
	return nil
}

func (body *officialTestClosedBody) Read(data []byte) (int, error) {
	if body.err != nil {
		return 0, body.err
	}
	return body.Reader.Read(data)
}

func TestOfficialStreamCopiesTheRawAnswerWithItsHeaders(t *testing.T) {
	body := &officialTestClosedBody{Reader: strings.NewReader("data: one\n\ndata: two\n\n")}
	header := http.Header{
		"Content-Type":  []string{"text/event-stream"},
		"Cache-Control": []string{"no-cache"},
		"Retry-After":   []string{"7"},
		"Set-Cookie":    []string{"secret=fixture"},
	}
	response := officialTestResponse(200, header, body)
	recorder := httptest.NewRecorder()
	streamOfficialBounded(&chunkedWriter{ResponseWriter: recorder}, response, maxRawResponse)
	if !body.closed {
		t.Fatal("the stream left the upstream body open")
	}
	if recorder.Code != 200 {
		t.Fatalf("the stream answered %d", recorder.Code)
	}
	if recorder.Body.String() != "data: one\n\ndata: two\n\n" {
		t.Fatalf("the stream changed the bytes: %q", recorder.Body.String())
	}
	if recorder.Header().Get("Content-Type") != "text/event-stream" || recorder.Header().Get("Cache-Control") != "no-cache" ||
		recorder.Header().Get("Retry-After") != "7" {
		t.Fatalf("the whitelisted headers were dropped: %v", recorder.Header())
	}
	if recorder.Header().Get("Set-Cookie") != "" {
		t.Fatal("a non-whitelisted header was forwarded")
	}
	if recorder.Header().Get("Content-Length") != "" {
		t.Fatal("the stream fixed a content length")
	}
}

func TestOfficialStreamStopsAtItsBound(t *testing.T) {
	payload := strings.Repeat("x", 64)
	body := &officialTestClosedBody{Reader: strings.NewReader(payload)}
	recorder := httptest.NewRecorder()
	func() {
		defer func() {
			if recover() != http.ErrAbortHandler {
				t.Fatal("an oversized stream did not abort the response")
			}
		}()
		streamOfficialBounded(&chunkedWriter{ResponseWriter: recorder}, officialTestResponse(200, http.Header{}, body), 10)
	}()
	if got := recorder.Body.Len(); got != 10 {
		t.Fatalf("the bounded stream copied %d bytes", got)
	}
	if !body.closed {
		t.Fatal("a truncated stream left the upstream body open")
	}
}

func TestOfficialStreamAllowsExactBound(t *testing.T) {
	body := &officialTestClosedBody{Reader: strings.NewReader("0123456789")}
	recorder := httptest.NewRecorder()
	streamOfficialBounded(&chunkedWriter{ResponseWriter: recorder}, officialTestResponse(200, http.Header{}, body), 10)
	if recorder.Body.String() != "0123456789" || !body.closed {
		t.Fatal("a stream exactly at the bound was not transferred and closed")
	}
}

func TestOfficialStreamReportsAnEarlyFailureWithoutLeaking(t *testing.T) {
	body := &officialTestClosedBody{Reader: strings.NewReader(""), err: errors.New("upstream wrote person@example.com")}
	recorder := httptest.NewRecorder()
	streamOfficialBounded(&chunkedWriter{ResponseWriter: recorder}, officialTestResponse(200, http.Header{}, body), maxRawResponse)
	if !body.closed {
		t.Fatal("a failed stream left the upstream body open")
	}
	if recorder.Code != 502 {
		t.Fatalf("an early failure answered %d", recorder.Code)
	}
	if message := officialErrorMessage(t, recorder); message != officialMessageTransport {
		t.Fatalf("an early failure reported %q", message)
	}
	if strings.Contains(recorder.Body.String(), "person@example.com") {
		t.Fatal("the failure repeated the upstream text")
	}
}

func TestOfficialFailureKeepsItsClassAndHidesAccountText(t *testing.T) {
	body, err := json.Marshal(map[string]any{"error": map[string]any{
		"status": "RESOURCE_EXHAUSTED", "message": "quota for person@example.com",
		"details": []map[string]any{{"reason": "RATE_LIMITED"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		err    error
		status int
		text   string
	}{
		{"handle", errOfficialHandle, 400, errOfficialHandle.Error()},
		{"token", errOfficialToken, 401, errOfficialToken.Error()},
		{"device", errOfficialDevice, 409, errOfficialDevice.Error()},
		{"full", errOfficialFull, 429, errOfficialFull.Error()},
		{"closed", errOfficialClosed, 503, errOfficialClosed.Error()},
		{"client", errOfficialClient, 503, errOfficialClient.Error()},
		{"expired", errOfficialExpired, 504, errOfficialExpired.Error()},
		{"boot", errOfficialBoot, 502, errOfficialBoot.Error()},
		{"upstream", &antigravity.UpstreamError{Status: 429, Body: body}, 429, officialMessageUpstream},
		{"service", &service.Error{Status: 400, Message: "the request was refused"}, 400, "the request was refused"},
		{"transport", errors.New("dial tcp: person@example.com"), 502, officialMessageTransport},
		{"canceled", context.Canceled, 499, officialMessageCanceled},
		{"timeout", context.DeadlineExceeded, 504, officialMessageTimeout},
	}
	for _, row := range cases {
		status, message := officialFailure(row.err)
		if status != row.status || message != row.text {
			t.Fatalf("%s mapped to %d %q", row.name, status, message)
		}
	}
	// A typed boot failure keeps the upstream status and never its reason.
	status, message := officialFailure(officialBootFailure(&antigravity.UpstreamError{Status: 401, Body: body}))
	if status != 401 || message != errOfficialBoot.Error() {
		t.Fatalf("a typed boot failure mapped to %d %q", status, message)
	}
	if strings.Contains(message, "person@example.com") || strings.Contains(message, "quota") {
		t.Fatalf("a boot failure repeated account text: %q", message)
	}
}

// officialTestUpstreamReply builds the exact body the official endpoint sends
// for a failure: an error object with an optional status, message, and details.
// A test therefore names real protocol shapes instead of a private struct.
func officialTestUpstreamReply(t *testing.T, status int, body map[string]any) *antigravity.UpstreamError {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return &antigravity.UpstreamError{Status: status, Body: encoded}
}

// officialTestFailReply runs the one official rejection reply and returns its
// status, the two headers this worker may set, and the whole body text, so a
// test can prove nothing else reached the caller.
func officialTestFailReply(t *testing.T, failure error) (int, string, string, string) {
	t.Helper()
	recorder := httptest.NewRecorder()
	officialFailureReply(recorder, failure)
	return recorder.Code, recorder.Header().Get(officialRefusalHeader),
		recorder.Header().Get("Retry-After"), recorder.Body.String()
}

func TestOfficialRejectionReportsARequestContentRefusalPrivately(t *testing.T) {
	// The pinned service treats a 429 with no ErrorInfo reason and no RetryInfo
	// as the upstream refusing the request content: the same content would be
	// refused by every account, so no account cools down. This worker reports
	// exactly that, privately, and keeps the status and the fixed sentence.
	refusal := officialTestUpstreamReply(t, http.StatusTooManyRequests, map[string]any{
		"error": map[string]any{"status": "RESOURCE_EXHAUSTED",
			"message": "the content was refused for person@example.com"},
	})
	status, header, retry, body := officialTestFailReply(t, refusal)
	if status != http.StatusTooManyRequests {
		t.Fatalf("a request-content refusal answered %d: %s", status, body)
	}
	if header != officialRefusalContent {
		t.Fatalf("a request-content refusal reported %q", header)
	}
	if retry != "" {
		t.Fatalf("a refusal without a retry moment set Retry-After %q", retry)
	}
	if !strings.Contains(body, officialMessageUpstream) {
		t.Fatalf("a refusal reported %q", body)
	}
	for _, secret := range []string{"person@example.com", "content was refused", "RESOURCE_EXHAUSTED"} {
		if strings.Contains(body, secret) {
			t.Fatalf("the reply repeated %q: %s", secret, body)
		}
	}
}

// TestOfficialRejectionReportsAnAccountRefusalPrivately proves an upstream
// refusal of the account itself carries its own private classification. The
// pinned service answers such a 403 by taking the account out of its pool, so
// the Bun owner benches the whole account for its usual interval instead of
// spending another request on the same refusal.
func TestOfficialRejectionReportsAnAccountRefusalPrivately(t *testing.T) {
	cases := []struct {
		name string
		body map[string]any
	}{
		{"terms of service reason", map[string]any{"error": map[string]any{
			"status": "PERMISSION_DENIED",
			"details": []map[string]any{{"reason": "TOS_VIOLATION"}},
			"message":  "This service has been disabled in this account for person@example.com",
		}}},
		{"verification reason", map[string]any{"error": map[string]any{
			"status":  "PERMISSION_DENIED",
			"details": []map[string]any{{"reason": "VALIDATION_REQUIRED"}},
			"message": "verify your account",
		}}},
		{"terms of service message", map[string]any{"error": map[string]any{
			"status":  "PERMISSION_DENIED",
			"message": "This service has been disabled for violation of Terms of Service.",
		}}},
	}
	for _, row := range cases {
		t.Run(row.name, func(t *testing.T) {
			refusal := officialTestUpstreamReply(t, http.StatusForbidden, row.body)
			status, header, retry, body := officialTestFailReply(t, refusal)
			if status != http.StatusForbidden {
				t.Fatalf("an account refusal answered %d: %s", status, body)
			}
			if header != officialBlockedContent {
				t.Fatalf("an account refusal reported %q", header)
			}
			if retry != "" {
				t.Fatalf("an account refusal set Retry-After %q", retry)
			}
			for _, secret := range []string{"person@example.com", "TOS_VIOLATION", "Terms of Service"} {
				if strings.Contains(body, secret) {
					t.Fatalf("the reply repeated %q: %s", secret, body)
				}
			}
		})
	}
}

// TestOfficialRejectionKeepsAnUnrelatedForbiddenOutOfTheAccountClass proves a
// 403 that names neither a terms-of-service violation nor a verification
// request stays an ordinary failure: only the account-level answer benches an
// account, and a model-specific refusal must not take its siblings down.
func TestOfficialRejectionKeepsAnUnrelatedForbiddenOutOfTheAccountClass(t *testing.T) {
	refusal := officialTestUpstreamReply(t, http.StatusForbidden, map[string]any{
		"error": map[string]any{"status": "PERMISSION_DENIED", "message": "the model is not enabled for this project"},
	})
	_, header, _, _ := officialTestFailReply(t, refusal)
	if header != "" {
		t.Fatalf("an unrelated 403 was classified as %q", header)
	}
}

func TestOfficialRejectionKeepsGenuineQuota429OutOfTheRefusalClass(t *testing.T) {
	// A quota reason and a named retry moment are account conditions, not a
	// request-content refusal. Both keep the account-status path, and the reply
	// forwards only a bounded future moment.
	cases := []struct {
		name    string
		body    map[string]any
		refusal string
		retry   string
	}{
		{
			name: "quota reason",
			body: map[string]any{"error": map[string]any{"status": "RESOURCE_EXHAUSTED",
				"message": "quota exhausted for person@example.com",
				"details": []map[string]any{{"reason": "QUOTA_EXHAUSTED"}}}},
		},
		{
			name: "credit reason",
			body: map[string]any{"error": map[string]any{"status": "RESOURCE_EXHAUSTED",
				"details": []map[string]any{{"reason": "INSUFFICIENT_G1_CREDITS_BALANCE"}}}},
		},
		{
			name:  "retry delay",
			retry: "4",
			body: map[string]any{"error": map[string]any{"status": "RESOURCE_EXHAUSTED",
				"details": []map[string]any{{"retryDelay": "4s"}}}},
		},
		{
			name:  "quota reset delay",
			retry: "3",
			body: map[string]any{"error": map[string]any{"status": "RESOURCE_EXHAUSTED",
				"details": []map[string]any{{"reason": "QUOTA_EXHAUSTED",
					"metadata": map[string]string{"quotaResetDelay": "3s"}}}}},
		},
		{
			name: "past retry moment",
			body: map[string]any{"error": map[string]any{"status": "RESOURCE_EXHAUSTED",
				"details": []map[string]any{{"retryDelay": "-1h"}}}},
		},
	}
	for _, row := range cases {
		failure := officialTestUpstreamReply(t, http.StatusTooManyRequests, row.body)
		status, header, retry, body := officialTestFailReply(t, failure)
		if status != http.StatusTooManyRequests {
			t.Fatalf("%s answered %d: %s", row.name, status, body)
		}
		if header != "" {
			t.Fatalf("%s was classified as a request-content refusal", row.name)
		}
		if retry != row.retry {
			t.Fatalf("%s set Retry-After %q, want %q", row.name, retry, row.retry)
		}
		if !strings.Contains(body, officialMessageUpstream) {
			t.Fatalf("%s reported %q", row.name, body)
		}
		for _, secret := range []string{"person@example.com", "QUOTA_EXHAUSTED", "credits", "quota"} {
			if strings.Contains(body, secret) {
				t.Fatalf("%s repeated %q: %s", row.name, secret, body)
			}
		}
	}
	// The classification belongs to 429: the same reasonless body at another
	// status stays an ordinary upstream rejection.
	status, header, retry, _ := officialTestFailReply(t, officialTestUpstreamReply(t, http.StatusForbidden, map[string]any{
		"error": map[string]any{"status": "PERMISSION_DENIED", "message": "denied for person@example.com"},
	}))
	if status != http.StatusForbidden || header != "" || retry != "" {
		t.Fatalf("a 403 reported %d %q %q", status, header, retry)
	}
}

func TestOfficialRetryAfterBoundsTheForwardedMoment(t *testing.T) {
	// Only a future, bounded retry moment becomes a header. An absent one, one
	// already past, and one beyond the routing owner's horizon are all dropped
	// rather than shortened into a hint this worker would not honor itself.
	cases := []struct {
		name   string
		status int
		detail map[string]any
		want   string
	}{
		{"future seconds", http.StatusTooManyRequests, map[string]any{"retryDelay": "90s"}, "90"},
		{"sub-second rounds up", http.StatusTooManyRequests, map[string]any{"retryDelay": "1.5s"}, "2"},
		{"no moment", http.StatusTooManyRequests, map[string]any{"reason": "RATE_LIMITED"}, ""},
		{"past moment", http.StatusTooManyRequests, map[string]any{"retryDelay": "-1h"}, ""},
		{"beyond the bound", http.StatusTooManyRequests, map[string]any{"retryDelay": "48h"}, ""},
		{"other status", http.StatusForbidden, map[string]any{"retryDelay": "90s"}, ""},
	}
	for _, row := range cases {
		failure := officialTestUpstreamReply(t, row.status, map[string]any{
			"error": map[string]any{"details": []map[string]any{row.detail}}})
		if got := officialRetryAfter(failure); got != row.want {
			t.Fatalf("%s returned %q, want %q", row.name, got, row.want)
		}
	}
	if got := officialRetryAfter(errors.New("dial failed")); got != "" {
		t.Fatalf("a transport failure returned %q", got)
	}
	// A retry moment beyond the bound is still not a refusal: the upstream
	// named a moment, so the account-status path owns that decision.
	beyond := officialTestUpstreamReply(t, http.StatusTooManyRequests, map[string]any{
		"error": map[string]any{"details": []map[string]any{{"retryDelay": "48h"}}}})
	if officialRefused(beyond) {
		t.Fatal("a named retry moment was classified as a request-content refusal")
	}
	if officialRetryAfter(beyond) != "" {
		t.Fatal("an unbounded retry moment reached the caller")
	}
	// A quota reason alone is not a refusal, whether or not it names a moment.
	quota := officialTestUpstreamReply(t, http.StatusTooManyRequests, map[string]any{
		"error": map[string]any{"details": []map[string]any{{"reason": "QUOTA_EXHAUSTED"}}}})
	if officialRefused(quota) {
		t.Fatal("a quota reason was classified as a request-content refusal")
	}
}

// officialTestHop replaces the official send of every account for one test, so
// the route itself is proven without a client transport seam.
func officialTestHop(t *testing.T, hop func(*antigravity.Client, context.Context, antigravity.Envelope) (*http.Response, error)) {
	t.Helper()
	previous := officialHop
	officialHop = hop
	t.Cleanup(func() { officialHop = previous })
}

func TestOfficialSendRouteCarriesThePrivateRefusalClassification(t *testing.T) {
	// The route, not just the reply helper, must attach the classification for
	// a request-content refusal and the bounded retry moment for a quota one.
	// Both keep the status and the fixed sentence, and neither repeats upstream
	// text, a reason, a project, a handle, an address, or a token.
	refusalBody, err := json.Marshal(map[string]any{"error": map[string]any{
		"status": "RESOURCE_EXHAUSTED", "message": "the content was refused for person@example.com"}})
	if err != nil {
		t.Fatal(err)
	}
	quotaBody, err := json.Marshal(map[string]any{"error": map[string]any{
		"status": "RESOURCE_EXHAUSTED", "message": "quota exhausted for person@example.com",
		"details": []map[string]any{{"reason": "QUOTA_EXHAUSTED", "retryDelay": "45s"}}}})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		err     error
		refusal string
		retry   string
	}{
		{"content refusal", &antigravity.UpstreamError{Status: http.StatusTooManyRequests, Body: refusalBody},
			officialRefusalContent, ""},
		{"quota", &antigravity.UpstreamError{Status: http.StatusTooManyRequests, Body: quotaBody}, "", "45"},
	}
	for _, row := range cases {
		handler := officialTestHandler(t, &officialTestBoot{})
		officialTestHop(t, func(*antigravity.Client, context.Context, antigravity.Envelope) (*http.Response, error) {
			return nil, row.err
		})
		response := officialTestPost(handler, "/official-send", officialTestSendInput())
		if response.Code != http.StatusTooManyRequests {
			t.Fatalf("%s answered %d: %s", row.name, response.Code, response.Body.String())
		}
		if got := response.Header().Get(officialRefusalHeader); got != row.refusal {
			t.Fatalf("%s reported %q, want %q", row.name, got, row.refusal)
		}
		if got := response.Header().Get("Retry-After"); got != row.retry {
			t.Fatalf("%s set Retry-After %q, want %q", row.name, got, row.retry)
		}
		if message := officialErrorMessage(t, response); message != officialMessageUpstream {
			t.Fatalf("%s reported %q", row.name, message)
		}
		for _, secret := range []string{"person@example.com", "QUOTA_EXHAUSTED", "content was refused", "quota exhausted"} {
			if strings.Contains(response.Body.String(), secret) {
				t.Fatalf("%s repeated %q: %s", row.name, secret, response.Body.String())
			}
		}
	}
}

func TestOfficialSendRouteLeavesOtherRejectionsUnclassified(t *testing.T) {
	// A 403 keeps the account-status path, so the route must add neither the
	// refusal classification nor a retry moment.
	handler := officialTestHandler(t, &officialTestBoot{})
	officialTestHop(t, func(*antigravity.Client, context.Context, antigravity.Envelope) (*http.Response, error) {
		return nil, &antigravity.UpstreamError{Status: http.StatusForbidden, Body: []byte(
			`{"error":{"status":"PERMISSION_DENIED","message":"denied for person@example.com","details":[{"retryDelay":"30s"}]}}`)}
	})
	response := officialTestPost(handler, "/official-send", officialTestSendInput())
	if response.Code != http.StatusForbidden {
		t.Fatalf("a 403 answered %d: %s", response.Code, response.Body.String())
	}
	if got := response.Header().Get(officialRefusalHeader); got != "" {
		t.Fatalf("a 403 was classified as %q", got)
	}
	if got := response.Header().Get("Retry-After"); got != "" {
		t.Fatalf("a 403 set Retry-After %q", got)
	}
	if strings.Contains(response.Body.String(), "person@example.com") {
		t.Fatal("a 403 repeated the upstream text")
	}
}
