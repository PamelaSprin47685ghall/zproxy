package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
)

// ZProxySignatures contains only response signatures from the current history.
type ZProxySignatures struct {
	Calls   map[string]string
	Origins map[string]string
}

// ZProxySummary is the bounded, local signature-cache update for one answer.
type ZProxySummary struct {
	Digest    string
	Provider  string
	Signature string
	Calls     map[string]string
	Complete  bool
}

// ZProxyOutput owns the upstream output rules. It has no account or transport.
type ZProxyOutput struct {
	state *output
}

var ZProxyRawLimitError = errors.New("the raw response exceeds its limit")

// ZProxyAnswerKey uses the same answer fingerprint as the upstream service.
func ZProxyAnswerKey(parts []antigravity.Part) string { return answerKey(parts) }

// ZProxyPrepare reuses the request and output rules without starting a Service.
func ZProxyPrepare(request antigravity.GenerateRequest, model antigravity.CatalogModel, signed ZProxySignatures) (antigravity.GenerateRequest, *ZProxyOutput, error) {
	prepared, state, err := prepare(request, model, signatureRecord{calls: signed.Calls, origins: signed.Origins})
	if err != nil {
		return request, nil, err
	}
	return prepared, &ZProxyOutput{state: state}, nil
}

// SetPrompt supplies the actual wire tools for argument repair and token counts.
func (out *ZProxyOutput) SetPrompt(request antigravity.WireRequest) { out.state.prompt = request }

// ZProxyEventBytes bounds retained response data before the output rules see it.
func ZProxyEventBytes(event antigravity.Event) int64 {
	size := int64(len(event.Text) + len(event.ThoughtSignature))
	if call := event.ToolCall; call != nil {
		size += int64(len(call.ID) + len(call.Name) + len(call.Arguments) + len(call.ThoughtSignature))
	}
	if event.Media != nil {
		size += int64(len(event.Media.Data))
	}
	if event.Grounding != nil {
		for _, query := range event.Grounding.WebSearchQueries {
			size += int64(len(query))
		}
		for _, chunk := range event.Grounding.GroundingChunks {
			if chunk.Web != nil {
				size += int64(len(chunk.Web.URI) + len(chunk.Web.Title))
			}
		}
		for _, support := range event.Grounding.GroundingSupports {
			size += int64(len(support.Segment.Text) + 8*len(support.GroundingChunkIndices))
		}
	}
	return size + 128
}

// Decode closes and drains the source on cancellation. No source can be replayed.
// The upstream decoder and output rules stay unchanged in the pinned source.
func (out *ZProxyOutput) Decode(ctx context.Context, source io.ReadCloser, limit int64, emit func(antigravity.Event) error) (ZProxySummary, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var closeOnce sync.Once
	closeSource := func() { closeOnce.Do(func() { _ = source.Close() }) }
	defer closeSource()
	stopClose := context.AfterFunc(ctx, closeSource)
	defer stopClose()
	raw := make(chan antigravity.Event)
	go func() {
		defer close(raw)
		antigravity.DecodeStream(source, raw)
	}()
	bounded := make(chan antigravity.Event)
	go func() {
		defer close(bounded)
		var size int64
		failed := false
		for event := range raw {
			if failed || ctx.Err() != nil {
				continue
			}
			size += ZProxyEventBytes(event)
			if event.Kind == antigravity.EventFinish && errors.Is(event.Err, ZProxyRawLimitError) {
				event = antigravity.Event{Kind: antigravity.EventError, Err: ZProxyRawLimitError}
			}
			if size > limit {
				failed = true
				closeSource()
				event = antigravity.Event{Kind: antigravity.EventError, Err: fmt.Errorf("the decoded response exceeds its limit")}
			}
			select {
			case bounded <- event:
			case <-ctx.Done():
			}
		}
	}()
	deadline := watch(ctx, 120*time.Second)
	defer deadline.stop()
	stopDeadline := context.AfterFunc(deadline.Context, func() {
		// A local output limit stops this watchdog before the HTTP response ends.
		// The consumer closes the input after it writes the terminal response.
		if ctx.Err() != nil || deadline.timedOut() {
			closeSource()
		}
	})
	defer stopDeadline()
	var writeError error
	_, final, err := forward(bounded, func(event antigravity.Event) {
		if writeError != nil || ctx.Err() != nil {
			return
		}
		if writeError = emit(event); writeError != nil {
			cancel()
		}
	}, out.state, deadline)
	if writeError != nil {
		err = writeError
	} else if ctx.Err() != nil {
		err = ctx.Err()
	} else if deadline.timedOut() {
		err = errors.New("the upstream body stalled")
	}
	signed := out.state.signatures()
	return ZProxySummary{
		Digest: out.state.reply(), Provider: out.state.provider, Signature: signed.reply, Calls: signed.calls,
		Complete: err == nil && final.Kind == antigravity.EventFinish && final.Err == nil,
	}, err
}
