package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
	"github.com/Mag1cFall/Antigravity2API/internal/api"
	"github.com/Mag1cFall/Antigravity2API/internal/service"
)

// maxOfficialEnvelope bounds one official send envelope. The official prepare
// already bounds the caller request it was built from, and the envelope adds
// labels, tools, and signatures to that request, so the message limit plus a
// fixed overhead covers every envelope this worker produces.
const maxOfficialEnvelope = maxRequest + (4 << 20)

// maxOfficialContinuation bounds one Google continuation token. The pinned
// continuation loop refuses a longer token, so this worker refuses it first.
const maxOfficialContinuation = 65536

// Each fixed sentence below is the whole message an official endpoint reports.
// None of them repeats a state directory, a handle, a device, a token, a
// project, a scope, or an upstream response body.
const (
	officialMessageInput      = "invalid official request"
	officialMessageEnvelope   = "invalid official envelope"
	officialMessageModel      = "the selected model is not available"
	officialMessageCanceled   = "the official request was canceled"
	officialMessageTimeout    = "the official request timed out"
	officialMessageUpstream   = "the official upstream rejected the request"
	officialMessageTransport  = "the official upstream is unavailable"
	officialMessageEnvelopeSz = "the official envelope exceeds its limit"
)

// officialRefusalHeader names the private classification of one official
// answer. Its only value is officialRefusalContent, and it carries no reason,
// no body, no project, no handle, no device, and no token: the Bun owner reads
// it to keep one refusal out of its account accounting, and the public reply
// keeps only the status and the fixed sentence.
const officialRefusalHeader = "X-Zproxy-Refusal"

// officialRefusalContent is the only value of officialRefusalHeader. It
// reports that the official endpoint refused the request content, which the
// pinned service never cools an account down for.
const officialRefusalContent = "request"

// officialBlockedContent is the other value of officialRefusalHeader. It
// reports that the upstream refused the account itself: a terms-of-service or
// account-verification answer, which the pinned service handles by taking that
// account out of its own pool. The Bun owner reads it as a cooldown of its own,
// never as a permanent exclusion, so the account returns once that cooldown
// ends and the upstream lets it back in.
const officialBlockedContent = "blocked"

// maxOfficialRetryAfter bounds one forwarded retry moment. A longer upstream
// delay is the routing owner's cooling decision rather than a hint a caller can
// act on, so it is dropped instead of shortened.
const maxOfficialRetryAfter = 6 * time.Hour

// officialHop is the one official send of an account client. Production uses
// the official method unchanged; a test replaces it to prove what the route
// writes, because the account client pins its own transports and cannot be
// handed a test one.
var officialHop = (*antigravity.Client).ZProxyRaw

// officialPrepareInput is the private prepare exchange. It carries the account
// selection, the caller request, the public model projection, and the short
// lived access token that never leaves the remote process.
type officialPrepareInput struct {
	Version     int                `json:"version"`
	Request     json.RawMessage    `json:"request"`
	Model       api.ZProxyModel    `json:"model"`
	Scope       string             `json:"scope"`
	Handle      string             `json:"handle"`
	Device      antigravity.Device `json:"device"`
	Project     string             `json:"project"`
	AccessToken string             `json:"accessToken"`
	ExpiresAt   int64              `json:"expiresAt"`
}

// officialSendInput is the private send exchange. Body is the envelope the
// prepare endpoint produced, and the optional continuation token is applied to
// it before the hop, so a caller may keep one envelope for every segment.
type officialSendInput struct {
	Version           int                  `json:"version"`
	Handle            string               `json:"handle"`
	Device            antigravity.Device   `json:"device"`
	AccessToken       string               `json:"accessToken"`
	ExpiresAt         int64                `json:"expiresAt"`
	ContinuationToken string               `json:"continuationToken"`
	Body              antigravity.Envelope `json:"body"`
}

// officialReply writes one fixed error. The status is the only detail that
// varies beyond the message and the class, and neither repeats account data.
func officialReply(w http.ResponseWriter, status int, message string) {
	kind := "invalid_request"
	switch {
	case status == 499:
		kind = "request_canceled"
	case status == 401:
		kind = "authentication_error"
	case status == 403:
		kind = "permission_error"
	case status == 409:
		kind = "conflict"
	case status == 429:
		kind = "rate_limit_error"
	case status >= 500:
		kind = "upstream_error"
	}
	jsonReply(w, status, map[string]any{"error": map[string]any{"type": kind, "message": message}})
}

// officialText accepts a string of a bounded byte length that the official
// wire fields can carry. Unlike plain it allows the empty string, because a
// project and a continuation token may each be absent.
func officialText(value string, limit int) bool {
	return len(value) <= limit && utf8.ValidString(value) &&
		!strings.ContainsFunc(value, func(r rune) bool { return r < 32 || (r >= 127 && r <= 159) })
}

// officialObject reports whether raw is one non-empty JSON object. The prepare
// path already bounds its length; this check only rejects a scalar or an empty
// value before the request rules see it.
func officialObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 1 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}'
}

// officialDeviceOK accepts exactly the six official device fields, each
// non-empty and within the limit the Bun owner applies, so a caller cannot
// smuggle an account field or a token into the device profile.
func officialDeviceOK(device antigravity.Device) bool {
	return plain(device.OS, 64) && plain(device.Arch, 64) && plain(device.UserName, 256) &&
		plain(device.AppDataDir, 512) && plain(device.TimeZone, 128) && plain(device.InstallationID, 128)
}

// officialProjectionOK accepts the public model projection a caller may send.
// The projection is a client input, so a malformed one is a caller fault and
// must not reach the account lookup, where it would read as a missing model.
// The account entry stays the wire truth; this check only refuses a projection
// that could never describe an official model.
func officialProjectionOK(model api.ZProxyModel) bool {
	if !plain(model.ID, 256) {
		return false
	}
	switch model.ModelProvider {
	case antigravity.ProviderGoogle, antigravity.ProviderAnthropic, antigravity.ProviderOpenAI:
	default:
		return false
	}
	// The wire enum is optional, and a present one must be plain like any other
	// official wire field.
	if model.Model != "" && !plain(model.Model, 256) {
		return false
	}
	if model.MaxOutputTokens < 1 || model.MaxOutputTokens > 2147483647 ||
		model.MaxTokens < 1 || model.MaxTokens > 2147483647 {
		return false
	}
	switch model.ThinkingLevel {
	case 0, 1, 2, 3, 100:
	default:
		return false
	}
	return model.ThinkingBudget == nil || (*model.ThinkingBudget >= -1 && *model.ThinkingBudget <= 2147483647)
}

// officialEnvelopeOK accepts a bounded official envelope. The prepare endpoint
// built it, so this check refuses a body that never came from there: an empty
// project is allowed because the account may carry none, but the identity
// fields that reach the wire must be present and plain.
func officialEnvelopeOK(envelope antigravity.Envelope) bool {
	if !officialText(envelope.Project, 1024) || !plain(envelope.Model, 256) ||
		!plain(envelope.RequestID, 4096) || !plain(envelope.UserAgent, 512) {
		return false
	}
	if envelope.RequestType != "agent" {
		return false
	}
	// The prepare endpoint bounds the caller request, so the contents count is
	// only a fixed ceiling here; an empty history stays the upstream's call.
	if len(envelope.Request.Contents) > 100000 {
		return false
	}
	return officialText(envelope.Request.ContinuationToken, maxOfficialContinuation)
}

// officialFailure maps one internal error to a fixed status and sentence. The
// typed cold-start status keeps the upstream code, which tells a rejected
// credential from a retryable answer, and never its body, reason, or account.
func officialFailure(err error) (int, string) {
	if errors.Is(err, context.Canceled) {
		return 499, officialMessageCanceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return 504, officialMessageTimeout
	}
	switch {
	case errors.Is(err, errOfficialHandle):
		return 400, errOfficialHandle.Error()
	case errors.Is(err, errOfficialToken):
		return 401, errOfficialToken.Error()
	case errors.Is(err, errOfficialDevice):
		return 409, errOfficialDevice.Error()
	case errors.Is(err, errOfficialFull):
		return 429, errOfficialFull.Error()
	case errors.Is(err, errOfficialClosed):
		return 503, errOfficialClosed.Error()
	case errors.Is(err, errOfficialExpired):
		return 504, errOfficialExpired.Error()
	case errors.Is(err, errOfficialClient):
		return 503, errOfficialClient.Error()
	}
	var boot *officialBootStatus
	if errors.As(err, &boot) {
		if boot.Status >= 400 && boot.Status <= 599 {
			return boot.Status, errOfficialBoot.Error()
		}
		return 502, errOfficialBoot.Error()
	}
	if errors.Is(err, errOfficialBoot) {
		return 502, errOfficialBoot.Error()
	}
	var upstream *antigravity.UpstreamError
	if errors.As(err, &upstream) && upstream.Status >= 400 && upstream.Status <= 599 {
		return upstream.Status, officialMessageUpstream
	}
	// ZProxyOfficialPrepare reports every client fault as a *service.Error with
	// one fixed sentence, so neither the status nor the message can carry
	// caller text or an upstream body.
	var fault *service.Error
	if errors.As(err, &fault) && fault.Status >= 400 && fault.Status <= 599 {
		return fault.Status, fault.Message
	}
	return 502, officialMessageTransport
}

// officialRefused reports whether err is the official answer to a request the
// upstream refused by content. The pinned service reads exactly these three
// facts, in this order, and returns without cooling the account, because the
// same request would be refused by every account. This worker reads the same
// facts so its classification cannot disagree with the official behaviour, and
// it keeps nothing of them: the reply carries one flag and one fixed sentence.
func officialRefused(err error) bool {
	var upstream *antigravity.UpstreamError
	if !errors.As(err, &upstream) || upstream.Status != http.StatusTooManyRequests {
		return false
	}
	return upstream.Reason() == "" && upstream.RetryAt(time.Now()).IsZero()
}

// officialBlocked reports whether err is the upstream refusing the account
// rather than this request. The pinned service answers a 403 whose reason is a
// terms-of-service or validation violation, or whose message says so, by
// stopping that account for the rest of its own run. This worker reports the
// same condition to the Bun owner, which cools the account instead of
// excluding it, because an upstream block can be lifted again.
func officialBlocked(err error) bool {
	var upstream *antigravity.UpstreamError
	if !errors.As(err, &upstream) || upstream.Status != http.StatusForbidden {
		return false
	}
	switch upstream.Reason() {
	case "TOS_VIOLATION", "VALIDATION_REQUIRED":
		return true
	}
	_, message := upstream.Message()
	lower := strings.ToLower(message)
	return strings.Contains(lower, "terms of service") || strings.Contains(lower, "verify your account")
}

// officialDiagnose writes one fixed diagnostic line to stderr for an official
// answer the worker classified as an account-level refusal candidate. It exists
// so an operator can tell an upstream reason code apart from a transport fault
// without any of that text reaching a caller: the line carries only the status,
// the ErrorInfo reason, and whether the retry moment was present. No body, no
// project, no handle, no device, no token, and no mailbox is written.
func officialDiagnose(err error) {
	var upstream *antigravity.UpstreamError
	if !errors.As(err, &upstream) {
		return
	}
	reason := upstream.Reason()
	if reason != "" {
		reason = plainReason(reason)
	}
	fmt.Fprintf(os.Stderr, "zproxy-ag: upstream status=%d reason=%q\n", upstream.Status, reason)
}

// plainReason keeps only the characters an upstream reason code is made of, so
// a broken peer cannot smuggle a newline or a control byte into a log line.
func plainReason(value string) string {
	const limit = 64
	var out strings.Builder
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '_' || char == '-' {
			out.WriteRune(char)
		}
		if out.Len() >= limit {
			break
		}
	}
	return out.String()
}

// officialRetryAfter returns the Retry-After value for one official rejection:
// the future moment the upstream named, as a whole number of seconds. A moment
// that is absent, already past, or further away than maxOfficialRetryAfter
// yields no value, so this worker never asks a caller to wait on a hint the
// routing owner would not honor itself. The upstream body and its reason never
// reach the value.
func officialRetryAfter(err error) string {
	var upstream *antigravity.UpstreamError
	if !errors.As(err, &upstream) || upstream.Status != http.StatusTooManyRequests {
		return ""
	}
	now := time.Now()
	until := upstream.RetryAt(now)
	delay := until.Sub(now)
	if until.IsZero() || delay <= 0 || delay > maxOfficialRetryAfter {
		return ""
	}
	seconds := int64((delay + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	return strconv.FormatInt(seconds, 10)
}

// officialFailureReply writes one official rejection. A refusal of the request
// content carries the private classification, so the Bun owner keeps it out of
// its account accounting; any other 429 carries the upstream retry moment when
// it named a bounded future one. Both keep the status and the fixed sentence,
// and neither repeats a reason, a body, a project, a handle, or a token.
func officialFailureReply(w http.ResponseWriter, err error) {
	status, message := officialFailure(err)
	if status >= 500 || status == http.StatusForbidden {
		officialDiagnose(err)
	}
	if officialBlocked(err) {
		w.Header().Set(officialRefusalHeader, officialBlockedContent)
	} else if officialRefused(err) {
		w.Header().Set(officialRefusalHeader, officialRefusalContent)
	} else if retry := officialRetryAfter(err); retry != "" {
		w.Header().Set("Retry-After", retry)
	}
	officialReply(w, status, message)
}

// officialPrepare builds the envelope for one selected account. The runtime
// yields the account, its own catalog entry supplies the wire model, and the
// pinned official prepare composes the request under the official rules. The
// reply holds the envelope and nothing else: no handle, device, token, expiry,
// catalog, or session state reaches the caller.
func (worker *worker) officialPrepare(w http.ResponseWriter, r *http.Request) {
	var input officialPrepareInput
	if err := readJSON(r.Body, maxRequest+(64<<10), &input); err != nil {
		officialReply(w, 400, officialMessageInput)
		return
	}
	if input.Version != 1 || !officialObject(input.Request) || len(input.Request) > maxRequest ||
		!plain(input.Scope, 256) || !officialText(input.Project, 1024) ||
		!officialHandle(input.Handle) || !officialDeviceOK(input.Device) || !officialProjectionOK(input.Model) {
		officialReply(w, 400, officialMessageInput)
		return
	}
	account, err := worker.official.get(r.Context(), input.Handle, input.Device, input.AccessToken, input.ExpiresAt)
	if err != nil {
		officialDiagnose(err)
		officialFailureReply(w, err)
		return
	}
	officialModel, ok := account.model(input.Model.ID)
	if !ok {
		officialReply(w, 503, officialMessageModel)
		return
	}
	envelope, err := api.ZProxyOfficialPrepare(r.Context(), input.Request, input.Model, officialModel,
		input.Scope, input.Project, account.device, worker.official.sessions, account.client)
	if err != nil {
		officialDiagnose(err)
		officialFailureReply(w, err)
		return
	}
	body, err := json.Marshal(envelope)
	if err != nil || len(body) > maxOfficialEnvelope {
		officialReply(w, 502, officialMessageEnvelopeSz)
		return
	}
	// The reply is written directly so the body stays one bounded object and
	// no encoder can stream an unexpected error page.
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(append(append([]byte(`{"body":`), body...), '}'))
}

// officialSend forwards one official envelope to the upstream and returns the
// raw SSE stream. The account is selected through the same runtime, so a
// refreshed token updates the existing account instead of starting another
// one. A caller that sends one envelope per segment reuses the same cascade.
func (worker *worker) officialSend(w http.ResponseWriter, r *http.Request) {
	var input officialSendInput
	if err := readJSON(r.Body, maxOfficialEnvelope+(64<<10), &input); err != nil {
		officialReply(w, 400, officialMessageInput)
		return
	}
	if input.Version != 1 || !officialHandle(input.Handle) || !officialDeviceOK(input.Device) {
		officialReply(w, 400, officialMessageInput)
		return
	}
	envelope := input.Body
	if input.ContinuationToken != "" {
		if !officialText(input.ContinuationToken, maxOfficialContinuation) {
			officialReply(w, 400, officialMessageEnvelope)
			return
		}
		envelope.Request.ContinuationToken = input.ContinuationToken
	}
	if !officialEnvelopeOK(envelope) {
		officialReply(w, 400, officialMessageEnvelope)
		return
	}
	account, err := worker.official.get(r.Context(), input.Handle, input.Device, input.AccessToken, input.ExpiresAt)
	if err != nil {
		status, message := officialFailure(err)
		officialReply(w, status, message)
		return
	}
	response, err := officialHop(account.client, r.Context(), envelope)
	if err != nil {
		officialFailureReply(w, err)
		return
	}
	worker.streamOfficial(w, response)
}

// streamOfficial copies the upstream stream with a fixed bound and takes
// ownership of its body, so every exit path closes the upstream read. The first
// read happens before any header is committed, so an upstream that fails before
// its first byte still answers with a status; after that the status is
// committed, a read error or an exceeded bound aborts the HTTP response rather
// than presenting a truncated stream as a successful EOF.
func (worker *worker) streamOfficial(w http.ResponseWriter, response *http.Response) {
	streamOfficialBounded(w, response, maxRawResponse)
}

// streamOfficialBounded is streamOfficial with an explicit byte bound. It
// closes the response body on every path, so no failure leaks the upstream
// read.
func streamOfficialBounded(w http.ResponseWriter, response *http.Response, limit int64) {
	defer response.Body.Close()
	buffer := make([]byte, 32<<10)
	read, readErr := response.Body.Read(buffer)
	if read == 0 && readErr != nil && !errors.Is(readErr, io.EOF) {
		officialReply(w, 502, officialMessageTransport)
		return
	}
	header := w.Header()
	for _, key := range []string{"Content-Type", "Cache-Control", "Retry-After"} {
		if value := response.Header.Get(key); value != "" {
			header.Set(key, value)
		}
	}
	if header.Get("Content-Type") == "" {
		header.Set("Content-Type", "text/event-stream")
	}
	w.WriteHeader(response.StatusCode)
	controller := http.NewResponseController(w)
	total := int64(0)
	for {
		if read > 0 {
			chunk := buffer[:read]
			overflow := false
			if remaining := limit - total; int64(len(chunk)) > remaining {
				if remaining <= 0 {
					panic(http.ErrAbortHandler)
				}
				chunk = chunk[:remaining]
				overflow = true
			}
			total += int64(len(chunk))
			if _, err := w.Write(chunk); err != nil {
				return
			}
			if err := controller.Flush(); err != nil {
				return
			}
			if overflow {
				panic(http.ErrAbortHandler)
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				panic(http.ErrAbortHandler)
			}
			return
		}
		next := buffer
		if remaining := limit - total; remaining < int64(len(next)) {
			next = next[:remaining+1]
		}
		read, readErr = response.Body.Read(next)
	}
}
