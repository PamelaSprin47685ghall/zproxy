package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
	"github.com/Mag1cFall/Antigravity2API/internal/service"
)

func zproxyTestModel(provider string) ZProxyModel {
	return ZProxyModel{ID: "fixture-model", ModelProvider: ZProxyProvider(provider), MaxTokens: 8192,
		MaxOutputTokens: 1024, SupportsThinking: true, SupportsImages: true}
}

func zproxyFrame(parts string) string {
	return `data: {"response":{"modelVersion":"fixture-wire","candidates":[{"content":{"role":"model","parts":` + parts + `}}]}}` + "\n\n"
}

func zproxyEnd() string {
	return "data: {\"response\":{\"candidates\":[{\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":7,\"cachedContentTokenCount\":2,\"candidatesTokenCount\":3,\"thoughtsTokenCount\":2,\"totalTokenCount\":12}}}\n\n"
}

func zproxyDecodeFixture(t *testing.T, raw, response, family, path string, order bool, cache *ZProxyCache) *httptest.ResponseRecorder {
	t.Helper()
	writer := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "http://private/decode", nil)
	ZProxyDecode(writer, request, path, []byte(raw), zproxyTestModel(family), io.NopCloser(strings.NewReader(response)), order, cache)
	return writer
}

func TestZProxyPrepareUsesThePinnedToolAndSchemaRules(t *testing.T) {
	raw := []byte(`{"model":"friendly","messages":[{"role":"user","content":"Find a book"}],"tools":[{"type":"function","function":{"name":"find.book","parameters":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]},"strict":true}}],"tool_choice":"required","parallel_tool_calls":false,"max_tokens":20}`)
	body, err := ZProxyPrepare(raw, zproxyTestModel("anthropic"), "private-project", "fixture-session")
	if err != nil {
		t.Fatal(err)
	}
	if body.Model != "fixture-model" || body.Project != "private-project" || body.Request.Tools[0].FunctionDeclarations[0].Name != "find_book" {
		t.Fatalf("unexpected prepared wire: %+v", body)
	}
	if !strings.Contains(body.Request.SystemInstruction.Parts[0].Text, "Call at most one function") {
		t.Fatal("the upstream tool-choice rules were not applied")
	}
	if body.Request.GenerationConfig.MaxOutputTokens != 1024 {
		t.Fatal("the catalog output limit changed")
	}
}

func TestZProxyStreamPreservesToolsReasoningUsageAndNames(t *testing.T) {
	raw := `{"model":"friendly","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"Find a book"}],"tools":[{"type":"function","function":{"name":"find.book","parameters":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}}}]}`
	wire := zproxyFrame(`[{"thought":true,"text":"consider"}]`) + zproxyFrame(`[{"text":"Found it"}]`) +
		zproxyFrame(`[{"functionCall":{"id":"original-call","name":"find_book","args":{"title":"Example"}},"thoughtSignature":"tool-signature"}]`) + zproxyEnd()
	response := zproxyDecodeFixture(t, raw, wire, "anthropic", "/v1/chat/completions", false, nil)
	text := response.Body.String()
	for _, expected := range []string{`"model":"friendly"`, `"reasoning_content":"consider"`, `"content":"Found it"`,
		`"name":"find.book"`, `"id":"original-call"`, `"thought_signature":"tool-signature"`, `"finish_reason":"tool_calls"`,
		`"completion_tokens":5`, `"cached_tokens":2`, "data: [DONE]"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing %s in %s", expected, text)
		}
	}
}

func TestZProxyStopAndStrictJSONUseTheRealOutputProcessor(t *testing.T) {
	response := zproxyDecodeFixture(t, `{"model":"friendly","messages":[{"role":"user","content":"hello"}],"stop":"<STOP>"}`,
		zproxyFrame(`[{"text":"Hello<ST"}]`)+zproxyFrame(`[{"text":"OP>hidden"}]`)+zproxyEnd(), "google", "/v1/chat/completions", false, nil)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"content":"Hello"`) || strings.Contains(response.Body.String(), "hidden") {
		t.Fatal(response.Body.String())
	}
	request := `{"model":"friendly","messages":[{"role":"user","content":"JSON"}],"response_format":{"type":"json_schema","json_schema":{"schema":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}}}}`
	for _, valid := range []bool{true, false} {
		value := "```json\n{\"ok\":true}\n```"
		if !valid {
			value = `{"ok":"wrong"}`
		}
		part, _ := json.Marshal([]map[string]string{{"text": value}})
		result := zproxyDecodeFixture(t, request, zproxyFrame(string(part))+zproxyEnd(), "google", "/v1/chat/completions", false, nil)
		if valid && (result.Code != 200 || !strings.Contains(result.Body.String(), `"content":"{\"ok\":true}"`)) {
			t.Fatal(result.Body.String())
		}
		if !valid && result.Code != 502 {
			t.Fatalf("invalid JSON schema output returned %d", result.Code)
		}
	}
}

func TestZProxyStrictToolArgumentsAndOutputLimitRemainEnforced(t *testing.T) {
	request := `{"model":"friendly","stream":true,"messages":[{"role":"user","content":"tool"}],"tools":[{"type":"function","function":{"name":"lookup","strict":true,"parameters":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}}}]}`
	result := zproxyDecodeFixture(t, request, zproxyFrame(`[{"functionCall":{"id":"one","name":"lookup","args":{"key":42}}}]`)+zproxyEnd(), "google", "/v1/chat/completions", false, nil)
	if result.Code != 502 || !strings.Contains(result.Body.String(), `"error"`) {
		t.Fatal(result.Body.String())
	}
	limited := "data: {\"response\":{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"over limit\"}]}}],\"usageMetadata\":{\"promptTokenCount\":7,\"candidatesTokenCount\":3,\"totalTokenCount\":10}}}\n\n" + zproxyEnd()
	result = zproxyDecodeFixture(t, `{"model":"friendly","stream":true,"messages":[{"role":"user","content":"limit"}],"max_tokens":2}`,
		limited, "google", "/v1/chat/completions", false, nil)
	if strings.Contains(result.Body.String(), "over limit") || !strings.Contains(result.Body.String(), `"finish_reason":"length"`) {
		t.Fatal(result.Body.String())
	}
}

func TestZProxyLegacyAndReasoningOrder(t *testing.T) {
	wire := zproxyFrame(`[{"text":"visible"}]`) + zproxyFrame(`[{"thought":true,"text":"late-thought"}]`) + zproxyEnd()
	for _, streaming := range []bool{false, true} {
		request, _ := json.Marshal(map[string]any{"model": "friendly", "prompt": "hello", "stream": streaming})
		result := zproxyDecodeFixture(t, string(request), wire, "google", "/v1/completions", false, nil)
		if result.Code != 200 || !strings.Contains(result.Body.String(), `"object":"text_completion"`) || !strings.Contains(result.Body.String(), "visible") {
			t.Fatal(result.Body.String())
		}
	}
	for _, order := range []bool{false, true} {
		result := zproxyDecodeFixture(t, `{"model":"friendly","stream":true,"messages":[{"role":"user","content":"hi"}]}`, wire,
			"google", "/v1/chat/completions", order, nil)
		text := result.Body.String()
		if (strings.Index(text, "late-thought") < strings.Index(text, "visible")) != order {
			t.Fatal(text)
		}
	}
}

func TestZProxySignatureCacheBindsHistoryAndProvider(t *testing.T) {
	cache := NewZProxyCache()
	first := `{"model":"friendly","messages":[{"role":"user","content":"original prompt"}]}`
	result := zproxyDecodeFixture(t, first, zproxyFrame(`[{"text":"answer","thoughtSignature":"answer-signature"}]`)+zproxyEnd(),
		"google", "/v1/chat/completions", false, cache)
	if result.Code != 200 {
		t.Fatal(result.Body.String())
	}
	next := `{"model":"friendly","messages":[{"role":"user","content":"original prompt"},{"role":"assistant","content":"answer"},{"role":"user","content":"next"}]}`
	augmented, err := cache.Augment([]byte(next))
	if err != nil || !strings.Contains(string(augmented), "_zproxy_ag") {
		t.Fatalf("%s %v", augmented, err)
	}
	body, err := ZProxyPrepare(augmented, zproxyTestModel("google"), "project", "session")
	if err != nil {
		t.Fatal(err)
	}
	if body.Request.Contents[1].Parts[0].ThoughtSignature != "answer-signature" {
		t.Fatal("body signature was not restored")
	}
	body, err = ZProxyPrepare(augmented, zproxyTestModel("anthropic"), "project", "session")
	if err != nil || body.Request.Contents[1].Parts[0].ThoughtSignature != "" {
		t.Fatal("a foreign signature was restored")
	}
	changed, _ := cache.Augment([]byte(strings.Replace(next, "original prompt", "other prompt", 1)))
	if strings.Contains(string(changed), "_zproxy_ag") {
		t.Fatal("another history received the signature")
	}
	forged := bytesReplace(augmented, `"content":"answer"`, `"content":"changed"`)
	if _, err := ZProxyPrepare(forged, zproxyTestModel("google"), "project", "session"); err == nil {
		t.Fatal("modified history accepted an old capsule")
	}
}

func bytesReplace(value []byte, from, to string) []byte {
	return []byte(strings.Replace(string(value), from, to, 1))
}

func TestZProxyToolSignatureCacheAndExpiry(t *testing.T) {
	cache := NewZProxyCache()
	now := time.Now()
	cache.now = func() time.Time { return now }
	request := `{"model":"friendly","messages":[{"role":"user","content":"tool"}],"tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]}`
	result := zproxyDecodeFixture(t, request, zproxyFrame(`[{"functionCall":{"id":"call-1","name":"lookup","args":{}},"thoughtSignature":"call-signature"}]`)+zproxyEnd(),
		"google", "/v1/chat/completions", false, cache)
	if result.Code != 200 {
		t.Fatal(result.Body.String())
	}
	var next map[string]any
	_ = json.Unmarshal([]byte(request), &next)
	next["messages"] = append(next["messages"].([]any), map[string]any{"role": "assistant", "content": nil,
		"tool_calls": []any{map[string]any{"id": "call-1", "type": "function", "function": map[string]string{"name": "lookup", "arguments": "{}"}}}},
		map[string]any{"role": "tool", "tool_call_id": "call-1", "content": "result"})
	raw, _ := json.Marshal(next)
	augmented, err := cache.Augment(raw)
	if err != nil || !strings.Contains(string(augmented), "call-signature") {
		t.Fatalf("%s %v", augmented, err)
	}
	prepared, err := ZProxyPrepare(augmented, zproxyTestModel("google"), "project", "session")
	if err != nil {
		t.Fatal(err)
	}
	var restored bool
	for _, content := range prepared.Request.Contents {
		for _, part := range content.Parts {
			restored = restored || part.FunctionCall != nil && part.ThoughtSignature == "call-signature"
		}
	}
	if !restored {
		t.Fatal("the tool signature was not restored")
	}
	now = now.Add(zproxyCacheTTL + time.Second)
	augmented, _ = cache.Augment(raw)
	if strings.Contains(string(augmented), "_zproxy_ag") {
		t.Fatal("an expired signature was returned")
	}
}

func TestZProxyThinkingOffRequiresTheExplicitCatalogDecision(t *testing.T) {
	raw := []byte(`{"model":"friendly","messages":[{"role":"user","content":"hi"}],"reasoning_effort":"none"}`)
	model := zproxyTestModel("google")
	model.ThinkingLevel = 2
	for _, disabled := range []bool{false, true} {
		model.ThinkingDisabled = disabled
		body, err := ZProxyPrepare(raw, model, "project", "session")
		if err != nil {
			t.Fatal(err)
		}
		thinking := body.Request.GenerationConfig.ThinkingConfig
		if disabled {
			if thinking.IncludeThoughts || thinking.ThinkingLevel != nil || thinking.ThinkingBudget == nil || *thinking.ThinkingBudget != 0 {
				t.Fatalf("the approved off route did not disable thinking: %+v", thinking)
			}
		} else if !thinking.IncludeThoughts || thinking.ThinkingLevel != "MEDIUM" {
			t.Fatalf("a mandatory model lost its actual catalog tier: %+v", thinking)
		}
	}
}

func TestZProxyCacheIsBoundedAndRejectsUnknownPrivateFields(t *testing.T) {
	cache := NewZProxyCache()
	for index := 0; index < zproxyCacheEntries+20; index++ {
		raw, _ := json.Marshal(map[string]any{"model": "friendly", "messages": []any{map[string]any{"role": "user", "content": index}}})
		cache.save(raw, service.ZProxySummary{Complete: true, Digest: "digest", Provider: antigravity.ProviderGoogle, Signature: "signature"})
	}
	if len(cache.items) != zproxyCacheEntries || cache.bytes > zproxyCacheBytes {
		t.Fatal("the signature cache exceeded its limits")
	}
	request := []byte(`{"model":"friendly","messages":[],"_zproxy_ag":{"version":1,"messages":[],"apiKey":"not-accepted"}}`)
	if _, err := ZProxyPrepare(request, zproxyTestModel("google"), "project", "session"); err == nil {
		t.Fatal("an account-shaped signature context was accepted")
	}
}

type zproxyCloseReader struct {
	*io.PipeReader
	once   sync.Once
	closed chan struct{}
}

func (reader *zproxyCloseReader) Close() error {
	reader.once.Do(func() { close(reader.closed) })
	return reader.PipeReader.Close()
}

func TestZProxyCancellationClosesAndDrainsTheDecoder(t *testing.T) {
	for _, already := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		reader, writer := io.Pipe()
		source := &zproxyCloseReader{PipeReader: reader, closed: make(chan struct{})}
		if already {
			cancel()
		}
		done := make(chan struct{})
		go func() {
			defer close(done)
			r := httptest.NewRequest("POST", "http://private/decode", nil).WithContext(ctx)
			ZProxyDecode(httptest.NewRecorder(), r, "/v1/chat/completions", []byte(`{"model":"friendly","stream":true,"messages":[{"role":"user","content":"hi"}]}`),
				zproxyTestModel("google"), source, false, nil)
		}()
		if !already {
			if _, err := io.WriteString(writer, zproxyFrame(`[{"text":"first"}]`)); err != nil {
				t.Fatal(err)
			}
			cancel()
		}
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("decoder did not finish after cancellation")
		}
		select {
		case <-source.closed:
		default:
			t.Fatal("raw input was not closed")
		}
		_ = writer.Close()
		cancel()
	}
}

func TestZProxyRawErrorsCloseThePublicSSE(t *testing.T) {
	result := zproxyDecodeFixture(t, `{"model":"friendly","stream":true,"messages":[{"role":"user","content":"hi"}]}`,
		zproxyFrame(`[{"text":"partial"}]`)+"data: invalid-json\n\n", "google", "/v1/chat/completions", false, nil)
	if !strings.Contains(result.Body.String(), `"error"`) || !strings.Contains(result.Body.String(), "data: [DONE]") {
		t.Fatal(result.Body.String())
	}
}

func TestZProxyPromptRejectionKeepsItsHTTPStatusBeforeAnyContent(t *testing.T) {
	result := zproxyDecodeFixture(t, `{"model":"friendly","stream":true,"messages":[{"role":"user","content":"fixture"}]}`,
		"data: {\"response\":{\"promptFeedback\":{\"blockReason\":\"SAFETY\",\"blockReasonMessage\":\"fixture rejection\"}}}\n\n", "google", "/v1/chat/completions", false, nil)
	if result.Code != 400 || !strings.Contains(result.Body.String(), `"error"`) || strings.Contains(result.Body.String(), "data:") {
		t.Fatalf("%d %s", result.Code, result.Body.String())
	}
}
