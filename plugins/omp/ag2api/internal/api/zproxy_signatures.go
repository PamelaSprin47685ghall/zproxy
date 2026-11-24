package api

import (
	"bytes"
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Mag1cFall/Antigravity2API/internal/service"
)

const (
	zproxySignatureLimit = 64 << 10
	zproxyCapsuleLimit   = 512 << 10
	zproxyCacheBytes     = 4 << 20
	zproxyCacheEntries   = 256
	zproxyCacheTTL       = 30 * time.Minute
)

type zproxyCallSignature struct {
	ID        string `json:"id"`
	Signature string `json:"signature"`
}

type zproxyMessageSignature struct {
	Index     int                   `json:"index"`
	Digest    string                `json:"digest"`
	Provider  string                `json:"provider"`
	Signature string                `json:"signature,omitempty"`
	Calls     []zproxyCallSignature `json:"calls,omitempty"`
}

type zproxyCapsule struct {
	Version  int                      `json:"version"`
	Messages []zproxyMessageSignature `json:"messages"`
}

func zproxySignatureValid(value string) bool {
	if len(value) == 0 || len(value) > zproxySignatureLimit {
		return false
	}
	return !strings.ContainsFunc(value, func(r rune) bool { return r < 32 || (r >= 127 && r <= 159) })
}

func zproxyOrigin(signature string) string {
	hash := sha256.Sum256([]byte(signature))
	return hex.EncodeToString(hash[:16])
}

func zproxyReadSignatures(raw []byte, messages []chatMessage, provider string) (service.ZProxySignatures, error) {
	signed := service.ZProxySignatures{Calls: map[string]string{}, Origins: map[string]string{}}
	var root struct {
		Context json.RawMessage `json:"_zproxy_ag"`
	}
	if err := json.Unmarshal(raw, &root); err != nil {
		return signed, err
	}
	if len(root.Context) == 0 {
		return signed, nil
	}
	if len(root.Context) > zproxyCapsuleLimit {
		return signed, errors.New("the signature context exceeds its limit")
	}
	var capsule zproxyCapsule
	if err := ZProxyJSON(root.Context, &capsule, true); err != nil {
		return signed, err
	}
	if capsule.Version != 1 || len(capsule.Messages) > 128 {
		return signed, errors.New("invalid signature context")
	}
	seen := map[string]bool{}
	for _, item := range capsule.Messages {
		key := fmt.Sprintf("%d:%s", item.Index, item.Provider)
		if item.Index < 0 || item.Index >= len(messages) || messages[item.Index].Role != "assistant" ||
			ZProxyProvider(item.Provider) == "" || len(item.Digest) != 64 || len(item.Calls) > 128 || seen[key] {
			return signed, errors.New("invalid signature history reference")
		}
		seen[key] = true
		content, err := chatMessageContent(messages[item.Index])
		if err != nil || service.ZProxyAnswerKey(content.Parts) != item.Digest {
			return signed, errors.New("signature history does not match the request")
		}
		family := ZProxyProvider(item.Provider)
		if item.Signature != "" {
			if !zproxySignatureValid(item.Signature) {
				return signed, errors.New("invalid answer signature")
			}
			signed.Origins[zproxyOrigin(item.Signature)] = family
			if family == provider {
				// The service keys a reply signature by the answer's message position and its answer key.
				signed.Calls[fmt.Sprintf("reply:%d:%s", item.Index, item.Digest)] = item.Signature
			}
		}
		calls := map[string]bool{}
		for _, call := range messages[item.Index].ToolCalls {
			calls[call.ID] = true
		}
		for _, call := range item.Calls {
			if call.ID == "" || len(call.ID) > 4096 || !calls[call.ID] || !zproxySignatureValid(call.Signature) {
				return signed, errors.New("invalid tool signature reference")
			}
			calls[call.ID] = false
			signed.Origins[zproxyOrigin(call.Signature)] = family
			if family == provider {
				signed.Calls[call.ID] = call.Signature
			}
		}
	}
	return signed, nil
}

type zproxyCacheEntry struct {
	key     string
	value   zproxyMessageSignature
	bytes   int
	expires time.Time
}

// ZProxyCache is private to one local worker. It stores no account information.
type ZProxyCache struct {
	mu    sync.Mutex
	items map[string]*list.Element
	order list.List
	bytes int
	now   func() time.Time
}

func NewZProxyCache() *ZProxyCache {
	return &ZProxyCache{items: map[string]*list.Element{}, now: time.Now}
}

func zproxyHistory(raw []byte) (map[string]any, []any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var body map[string]any
	if err := decoder.Decode(&body); err != nil {
		return nil, nil, err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return nil, nil, errors.New("expected one OpenAI request")
	}
	if body == nil {
		return nil, nil, errors.New("an OpenAI request object is required")
	}
	messages, _ := body["messages"].([]any)
	return body, messages, nil
}

func zproxyPrefix(body map[string]any, messages []any, count int) string {
	data, _ := json.Marshal(struct {
		Model    any   `json:"model"`
		Tools    any   `json:"tools"`
		Messages []any `json:"messages"`
	}{body["model"], body["tools"], messages[:count]})
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func (cache *ZProxyCache) remove(element *list.Element) {
	entry := element.Value.(zproxyCacheEntry)
	delete(cache.items, entry.key)
	cache.bytes -= entry.bytes
	cache.order.Remove(element)
}

func (cache *ZProxyCache) save(raw []byte, summary service.ZProxySummary) {
	if !summary.Complete || zproxyFamily(summary.Provider) == "" || len(summary.Calls) > 128 {
		return
	}
	value := zproxyMessageSignature{Digest: summary.Digest, Provider: zproxyFamily(summary.Provider)}
	if zproxySignatureValid(summary.Signature) {
		value.Signature = summary.Signature
	}
	for id, signature := range summary.Calls {
		if id != "" && len(id) <= 4096 && zproxySignatureValid(signature) {
			value.Calls = append(value.Calls, zproxyCallSignature{ID: id, Signature: signature})
		}
	}
	if value.Signature == "" && len(value.Calls) == 0 {
		return
	}
	sort.Slice(value.Calls, func(a, b int) bool { return value.Calls[a].ID < value.Calls[b].ID })
	encoded, _ := json.Marshal(value)
	if len(encoded) > zproxyCapsuleLimit {
		return
	}
	body, messages, err := zproxyHistory(raw)
	if err != nil || len(messages) == 0 {
		return
	}
	key := zproxyPrefix(body, messages, len(messages)) + ":" + value.Digest + ":" + value.Provider
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if old := cache.items[key]; old != nil {
		cache.remove(old)
	}
	entry := zproxyCacheEntry{key: key, value: value, bytes: len(key) + len(encoded), expires: cache.now().Add(zproxyCacheTTL)}
	cache.items[key] = cache.order.PushFront(entry)
	cache.bytes += entry.bytes
	for cache.bytes > zproxyCacheBytes || len(cache.items) > zproxyCacheEntries {
		cache.remove(cache.order.Back())
	}
}

// Augment attaches only signatures that match an answer and its supplied prefix.
// It does not change public messages, tool IDs, or user-provided native signatures.
func (cache *ZProxyCache) Augment(raw []byte) ([]byte, error) {
	body, messages, err := zproxyHistory(raw)
	if err != nil {
		return nil, err
	}
	delete(body, "_zproxy_ag")
	capsule := zproxyCapsule{Version: 1}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	now := cache.now()
	for index, message := range messages {
		value, _ := message.(map[string]any)
		if value["role"] != "assistant" {
			continue
		}
		encoded, _ := json.Marshal(message)
		var chat chatMessage
		if json.Unmarshal(encoded, &chat) != nil {
			continue
		}
		content, err := chatMessageContent(chat)
		if err != nil {
			continue
		}
		digest := service.ZProxyAnswerKey(content.Parts)
		prefix := zproxyPrefix(body, messages, index)
		for _, family := range []string{"google", "anthropic", "openai"} {
			key := prefix + ":" + digest + ":" + family
			element := cache.items[key]
			if element == nil {
				continue
			}
			entry := element.Value.(zproxyCacheEntry)
			if !now.Before(entry.expires) {
				cache.remove(element)
				continue
			}
			item := entry.value
			item.Index = index
			// A matching answer can have rewritten IDs. Restore only unchanged IDs.
			item.Calls = nil
			for _, signed := range entry.value.Calls {
				for _, call := range chat.ToolCalls {
					if call.ID == signed.ID && (call.ExtraContent.Google.ThoughtSignature == "" || call.ExtraContent.Google.ThoughtSignature == signed.Signature) {
						item.Calls = append(item.Calls, signed)
						break
					}
				}
			}
			if item.Signature == "" && len(item.Calls) == 0 {
				continue
			}
			capsule.Messages = append(capsule.Messages, item)
			bytes, _ := json.Marshal(capsule)
			if len(capsule.Messages) > 128 || len(bytes) > zproxyCapsuleLimit {
				capsule.Messages = capsule.Messages[:len(capsule.Messages)-1]
				break
			}
			cache.order.MoveToFront(element)
		}
	}
	if len(capsule.Messages) > 0 {
		body["_zproxy_ag"] = capsule
	}
	return json.Marshal(body)
}
