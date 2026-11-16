package service

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
)

func zproxyOutputFixture(t *testing.T, request antigravity.GenerateRequest, family string) *ZProxyOutput {
	t.Helper()
	model := antigravity.CatalogModel{ID: "fixture", ModelProvider: family, MaxOutputTokens: 1024, MaxTokens: 8192, SupportsImages: true}
	prepared, out, err := ZProxyPrepare(request, model, ZProxySignatures{})
	if err != nil {
		t.Fatal(err)
	}
	body, err := antigravity.BuildEnvelope("", model, antigravity.Conversation{}, prepared.System, prepared.Contents, prepared.Tools, prepared.Config, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	out.SetPrompt(body.Request)
	return out
}

func TestZProxyOutputRetainsClaudeEnumRepair(t *testing.T) {
	request := antigravity.GenerateRequest{Contents: []antigravity.Content{{Role: antigravity.RoleUser, Parts: []antigravity.Part{{Text: "choose"}}}},
		Tools: antigravity.Tools{Functions: []antigravity.FunctionDeclaration{{Name: "color", Parameters: json.RawMessage(`{"type":"object","properties":{"color":{"type":"string","enum":["red","blue"]}}}`)}}}}
	out := zproxyOutputFixture(t, request, antigravity.ProviderAnthropic)
	wire := "data: {\"response\":{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"functionCall\":{\"id\":\"call\",\"name\":\"color\",\"args\":{\"color\":\"\\\"red\\\"\"}}}]},\"finishReason\":\"STOP\"}]}}\n\n"
	var args string
	_, err := out.Decode(context.Background(), io.NopCloser(strings.NewReader(wire)), 1<<20, func(event antigravity.Event) error {
		if event.ToolCall != nil {
			args = string(event.ToolCall.Arguments)
		}
		return nil
	})
	if err != nil || args != `{"color":"red"}` {
		t.Fatalf("repaired args %s, error %v", args, err)
	}
}

func TestZProxyDecodedSizeLimitIsAnError(t *testing.T) {
	request := antigravity.GenerateRequest{Contents: []antigravity.Content{{Role: antigravity.RoleUser, Parts: []antigravity.Part{{Text: "hi"}}}}}
	out := zproxyOutputFixture(t, request, antigravity.ProviderGoogle)
	wire := "data: {\"response\":{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"long answer\"}]},\"finishReason\":\"STOP\"}]}}\n\n"
	var errorEvent bool
	result, err := out.Decode(context.Background(), io.NopCloser(strings.NewReader(wire)), 16, func(event antigravity.Event) error {
		errorEvent = errorEvent || event.Kind == antigravity.EventError
		return nil
	})
	if err == nil || !errorEvent || result.Complete {
		t.Fatalf("limit was ignored: %+v %v", result, err)
	}
}

type zproxyLimitReader struct{ data *strings.Reader }

func (reader *zproxyLimitReader) Read(p []byte) (int, error) {
	n, err := reader.data.Read(p)
	if err == io.EOF {
		err = ZProxyRawLimitError
	}
	return n, err
}
func (*zproxyLimitReader) Close() error { return nil }

func TestZProxyRawLimitCannotBecomeSuccessAfterAToolCall(t *testing.T) {
	request := antigravity.GenerateRequest{Contents: []antigravity.Content{{Role: antigravity.RoleUser, Parts: []antigravity.Part{{Text: "hi"}}}},
		Tools: antigravity.Tools{Functions: []antigravity.FunctionDeclaration{{Name: "lookup", Parameters: json.RawMessage(`{"type":"object"}`)}}}}
	out := zproxyOutputFixture(t, request, antigravity.ProviderGoogle)
	wire := "data: {\"response\":{\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"functionCall\":{\"id\":\"call\",\"name\":\"lookup\",\"args\":{}}}]}}]}}\n\n"
	var errorEvent bool
	result, err := out.Decode(context.Background(), &zproxyLimitReader{data: strings.NewReader(wire)}, 1<<20, func(event antigravity.Event) error {
		errorEvent = errorEvent || event.Kind == antigravity.EventError
		return nil
	})
	if err == nil || !errorEvent || result.Complete {
		t.Fatalf("raw limit became success: %+v %v", result, err)
	}
}
