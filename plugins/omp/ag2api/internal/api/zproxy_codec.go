package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
	"github.com/Mag1cFall/Antigravity2API/internal/service"
)

const ZProxyResponseLimit int64 = 16 << 20

// ZProxyModel is a public catalog projection. It cannot contain account state.
type ZProxyModel struct {
	ID                       string `json:"id"`
	Model                    string `json:"model,omitempty"`
	ModelProvider            string `json:"modelProvider"`
	MaxOutputTokens          int64  `json:"maxOutputTokens"`
	MaxTokens                int64  `json:"maxTokens"`
	ThinkingLevel            int    `json:"thinkingLevel,omitempty"`
	ThinkingDisabled         bool   `json:"thinkingDisabled,omitempty"`
	ThinkingBudget           *int64 `json:"thinkingBudget,omitempty"`
	MinThinkingBudget        int64  `json:"minThinkingBudget,omitempty"`
	SupportsThinking         bool   `json:"supportsThinking,omitempty"`
	SupportsAdaptiveThinking bool   `json:"supportsAdaptiveThinking,omitempty"`
	SupportsImages           bool   `json:"supportsImages,omitempty"`
	SupportsVideo            bool   `json:"supportsVideo,omitempty"`
}

func ZProxyProvider(family string) string {
	switch family {
	case "google":
		return antigravity.ProviderGoogle
	case "anthropic":
		return antigravity.ProviderAnthropic
	case "openai":
		return antigravity.ProviderOpenAI
	}
	return ""
}

func zproxyFamily(provider string) string {
	switch provider {
	case antigravity.ProviderGoogle:
		return "google"
	case antigravity.ProviderAnthropic:
		return "anthropic"
	case antigravity.ProviderOpenAI:
		return "openai"
	}
	return ""
}

func (model ZProxyModel) catalog() (antigravity.CatalogModel, error) {
	if model.ID == "" || len(model.ID) > 256 || strings.ContainsAny(model.ID, "\x00\r\n") || len(model.Model) > 256 ||
		zproxyFamily(model.ModelProvider) == "" || model.MaxOutputTokens < 1 || model.MaxOutputTokens > 2147483647 ||
		model.MaxTokens < 1 || model.MaxTokens > 2147483647 || model.MinThinkingBudget < 0 || model.MinThinkingBudget > 2147483647 {
		return antigravity.CatalogModel{}, errors.New("invalid public model")
	}
	if model.ThinkingBudget != nil && (*model.ThinkingBudget < -1 || *model.ThinkingBudget > 2147483647) {
		return antigravity.CatalogModel{}, errors.New("invalid thinking budget")
	}
	if model.ThinkingLevel != 0 && model.ThinkingLevel != 1 && model.ThinkingLevel != 2 && model.ThinkingLevel != 3 && model.ThinkingLevel != 100 {
		return antigravity.CatalogModel{}, errors.New("invalid thinking level")
	}
	return antigravity.CatalogModel{
		ID: model.ID, Model: model.Model, ModelProvider: model.ModelProvider, MaxOutputTokens: model.MaxOutputTokens,
		MaxTokens: model.MaxTokens, ThinkingLevel: model.ThinkingLevel, ThinkingBudget: model.ThinkingBudget,
		MinThinkingBudget: model.MinThinkingBudget, SupportsThinking: model.SupportsThinking,
		SupportsAdaptiveThinking: model.SupportsAdaptiveThinking, SupportsImages: model.SupportsImages, SupportsVideo: model.SupportsVideo,
	}, nil
}

type zproxyParsed struct {
	chat     chatRequest
	raw      []byte
	generate antigravity.GenerateRequest
	signed   service.ZProxySignatures
	legacy   bool
}

func zproxyParse(raw []byte, path, provider string) (zproxyParsed, error) {
	var parsed zproxyParsed
	parsed.raw = raw
	if path == "/v1/completions" {
		var body map[string]json.RawMessage
		if err := json.Unmarshal(raw, &body); err != nil {
			return parsed, err
		}
		var completion completionRequest
		if err := json.Unmarshal(raw, &completion); err != nil {
			return parsed, err
		}
		prompt, err := completion.promptText()
		if err != nil {
			return parsed, err
		}
		if completion.Suffix != "" || string(body["echo"]) == "true" || rawJSONConfigured(body["logprobs"]) ||
			(rawJSONConfigured(body["best_of"]) && string(body["best_of"]) != "1") {
			return parsed, errors.New("unsupported legacy completion option")
		}
		body["messages"], _ = json.Marshal([]map[string]string{{"role": "user", "content": prompt}})
		delete(body, "prompt")
		delete(body, "suffix")
		raw, _ = json.Marshal(body)
		parsed.legacy = true
	} else if path != "/v1/chat/completions" {
		return parsed, errors.New("unsupported OpenAI route")
	}
	if err := json.Unmarshal(raw, &parsed.chat); err != nil {
		return parsed, err
	}
	if parsed.chat.Model == "" || (parsed.chat.N != nil && *parsed.chat.N != 1) {
		return parsed, errors.New("a model and one completion are required")
	}
	if err := parsed.chat.mergeLegacyFunctions(); err != nil {
		return parsed, err
	}
	request, err := parsed.chat.toGenerateRequest(newID("chatcmpl"))
	if err != nil {
		return parsed, err
	}
	if request.Config.MaxOutputTokens != nil && (*request.Config.MaxOutputTokens < 1 || *request.Config.MaxOutputTokens > 2147483647) {
		return parsed, errors.New("invalid output token limit")
	}
	parsed.generate = request
	parsed.signed, err = zproxyReadSignatures(raw, parsed.chat.Messages, provider)
	return parsed, err
}

// zproxyPlan is shared by both ends. It does not resolve models or credentials.
func zproxyPlan(parsed zproxyParsed, projection ZProxyModel, project, session string) (antigravity.Envelope, *service.ZProxyOutput, error) {
	model, err := projection.catalog()
	if err != nil {
		return antigravity.Envelope{}, nil, err
	}
	prepared, output, err := service.ZProxyPrepare(parsed.generate, model, parsed.signed)
	if err != nil {
		return antigravity.Envelope{}, nil, err
	}
	conversation := antigravity.NewConversation(session, session, prepared.Contents)
	envelope, err := antigravity.BuildEnvelope(project, model, conversation, prepared.System, prepared.Contents,
		prepared.Tools, prepared.Config, time.Now())
	if err != nil {
		return antigravity.Envelope{}, nil, err
	}
	if projection.ThinkingDisabled {
		zero := int64(0)
		envelope.Request.GenerationConfig.ThinkingConfig.IncludeThoughts = false
		envelope.Request.GenerationConfig.ThinkingConfig.ThinkingLevel = nil
		envelope.Request.GenerationConfig.ThinkingConfig.ThinkingBudget = &zero
	}
	output.SetPrompt(envelope.Request)
	return envelope, output, nil
}

// ZProxyPrepare builds only the wire body. The caller owns authentication and I/O.
func ZProxyPrepare(raw []byte, model ZProxyModel, project, session string) (antigravity.Envelope, error) {
	parsed, err := zproxyParse(raw, "/v1/chat/completions", model.ModelProvider)
	if err != nil {
		return antigravity.Envelope{}, err
	}
	if len(project) == 0 || len(project) > 1024 || len(session) == 0 || len(session) > 256 || strings.ContainsAny(project+session, "\x00\r\n") {
		return antigravity.Envelope{}, errors.New("invalid private request context")
	}
	if err := zproxyInlineOnly(parsed.generate.Contents); err != nil {
		return antigravity.Envelope{}, err
	}
	envelope, _, err := zproxyPlan(parsed, model, project, session)
	return envelope, err
}

func zproxyInlineOnly(contents []antigravity.Content) error {
	var check func([]antigravity.Part) error
	check = func(parts []antigravity.Part) error {
		for _, part := range parts {
			if part.File != nil {
				if _, ok := youtubeURL(part.File.ID); !ok {
					return errors.New("remote media must be inlined before protocol preparation")
				}
			}
			if part.FunctionResult != nil {
				if err := check(part.FunctionResult.Parts); err != nil {
					return err
				}
			}
		}
		return nil
	}
	for _, content := range contents {
		if err := check(content.Parts); err != nil {
			return err
		}
	}
	return nil
}

// ZProxyDecode writes one OpenAI response from a single raw upstream body.
// It uses the pinned event decoder, output rules, and OpenAI field projections.
func ZProxyDecode(w http.ResponseWriter, r *http.Request, path string, raw []byte, model ZProxyModel,
	source io.ReadCloser, reasoningOrder bool, cache *ZProxyCache) {
	defer source.Close()
	parsed, err := zproxyParse(raw, path, model.ModelProvider)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	_, output, err := zproxyPlan(parsed, model, "", "local-response")
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	events := make(chan antigravity.Event)
	finished := make(chan struct{})
	var closeEvents sync.Once
	closeOutput := func() { closeEvents.Do(func() { close(events) }) }
	go func() {
		defer close(finished)
		defer closeOutput()
		ended := false
		emit := func(event antigravity.Event) error {
			if ended {
				return nil
			}
			select {
			case events <- event:
				if event.Kind == antigravity.EventFinish && (event.FinishReason == "MAX_TOKENS" || event.FinishReason == "STOP_SEQUENCE") {
					ended = true
					closeOutput()
				}
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		if reasoningOrder && parsed.chat.Stream {
			emit = zproxyReasoningFirst(emit)
		}
		summary, decodeError := output.Decode(ctx, source, ZProxyResponseLimit, emit)
		if summary.Complete && cache != nil {
			cache.save(parsed.raw, summary)
		}
		if decodeError != nil && ctx.Err() == nil {
			_ = emit(antigravity.Event{Kind: antigravity.EventError, Err: decodeError})
		}
	}()
	defer func() {
		cancel()
		_ = source.Close()
		for range events {
		}
		<-finished
	}()
	if !parsed.chat.Stream {
		result, consumeError := consumeEvents(ctx, events, nil)
		if consumeError != nil {
			writeOpenAIRequestError(w, consumeError)
			return
		}
		if parsed.legacy {
			body := zproxyLegacyChunk(parsed.chat.Model, parsed.generate.ID, time.Now().Unix(), result.text.String(), openAIFinishReason(result.finishReason, false))
			if result.usage != nil {
				body["usage"] = openAIUsage(result.usage)
			}
			writeJSON(w, http.StatusOK, body)
			_ = http.NewResponseController(w).Flush()
			return
		}
		writeJSON(w, http.StatusOK, officialOrder("chat", buildChatCompletion(parsed.generate.ID, time.Now().Unix(), parsed.chat.Model,
			[]generationResult{result}, parsed.chat.Tools, mediaOutput{})))
		_ = http.NewResponseController(w).Flush()
		return
	}
	ready, _, startError := startGeneration(ctx, true, func() (<-chan antigravity.Event, error) { return events, nil })
	if startError != nil {
		if shouldWriteRequestError(r, startError) {
			writeOpenAIRequestError(w, startError)
		}
		return
	}
	zproxyWriteStream(w, r.WithContext(ctx), parsed, ready)
}

func zproxyReasoningFirst(next func(antigravity.Event) error) func(antigravity.Event) error {
	var held []antigravity.Event
	var size int64
	return func(event antigravity.Event) error {
		if event.Kind == antigravity.EventReasoning || event.Kind == antigravity.EventThoughtSignature {
			return next(event)
		}
		if event.Kind == antigravity.EventFinish || event.Kind == antigravity.EventError {
			for _, item := range held {
				if err := next(item); err != nil {
					return err
				}
			}
			held, size = nil, 0
			return next(event)
		}
		size += service.ZProxyEventBytes(event)
		if size > ZProxyResponseLimit {
			return errors.New("the reasoning-order buffer exceeds its limit")
		}
		held = append(held, event)
		return nil
	}
}

func zproxyLegacyChunk(model, id string, created int64, text string, finish any) map[string]any {
	return map[string]any{"id": id, "object": "text_completion", "created": created, "model": model,
		"choices": []any{map[string]any{"text": text, "index": 0, "logprobs": nil, "finish_reason": finish}}}
}

func zproxyWriteStream(w http.ResponseWriter, r *http.Request, parsed zproxyParsed, events <-chan antigravity.Event) {
	stream, err := openStream(w, sseHeartbeat)
	defer stream.stop()
	if err != nil {
		return
	}
	w = stream
	created, id, model := time.Now().Unix(), parsed.generate.ID, parsed.chat.Model
	choice := &chatStreamChoice{tools: parsed.chat.Tools, media: mediaOutput{}}
	choice.write = func(index int, delta map[string]any, finish *string) error {
		return writeChatChunk(w, id, created, model, index, delta, finish, parsed.chat.StreamOptions.IncludeUsage)
	}
	if !parsed.legacy {
		if err := choice.write(0, map[string]any{"role": "assistant", "content": ""}, nil); err != nil {
			return
		}
	}
	var usage *antigravity.Usage
	var finish string
	hasTools, ended := false, false
	for {
		select {
		case <-r.Context().Done():
			return
		case event, ok := <-events:
			if !ok {
				if !ended {
					writeOpenAIStreamError(w, r, errIncompleteStream)
				} else if parsed.legacy {
					final := zproxyLegacyChunk(model, id, created, "", openAIFinishReason(finish, false))
					if parsed.chat.StreamOptions.IncludeUsage && usage != nil {
						final["usage"] = openAIUsage(usage)
					}
					if writeSSE(w, "", final) != nil {
						return
					}
				} else {
					reason := openAIFinishReason(finish, hasTools)
					if reason == "tool_calls" && legacyFunctionTools(parsed.chat.Tools) {
						reason = "function_call"
					}
					if choice.write(0, map[string]any{}, &reason) != nil {
						return
					}
					if parsed.chat.StreamOptions.IncludeUsage && usage != nil {
						if writeSSE(w, "", officialOrder("chat", map[string]any{"id": id, "object": "chat.completion.chunk", "created": created,
							"model": model, "choices": []any{}, "usage": openAIUsage(usage)})) != nil {
							return
						}
					}
				}
				_ = writeSSEText(w, "[DONE]")
				return
			}
			if event.Usage != nil {
				usage = event.Usage
			}
			switch event.Kind {
			case antigravity.EventError:
				writeOpenAIStreamError(w, r, event.Err)
				_ = writeSSEText(w, "[DONE]")
				return
			case antigravity.EventFinish:
				ended, finish = true, event.FinishReason
			case antigravity.EventToolCall:
				hasTools = true
				if len(event.ToolCall.Arguments) == 0 {
					event.ToolCall.Arguments = json.RawMessage(`{}`)
				}
				if !json.Valid(event.ToolCall.Arguments) {
					writeOpenAIStreamError(w, r, errors.New("upstream tool arguments are not JSON"))
					_ = writeSSEText(w, "[DONE]")
					return
				}
			}
			if parsed.legacy {
				if event.Kind == antigravity.EventText && writeSSE(w, "", zproxyLegacyChunk(model, id, created, event.Text, nil)) != nil {
					return
				}
			} else if err := choice.emit(event); err != nil {
				return
			}
		}
	}
}

// ZProxyJSON decodes exactly one value. Private envelopes reject unknown fields.
func ZProxyJSON(data []byte, target any, strict bool) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if strict {
		decoder.DisallowUnknownFields()
	}
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return fmt.Errorf("expected one JSON value")
	}
	return nil
}
