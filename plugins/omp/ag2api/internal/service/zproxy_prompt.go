package service

import (
	"context"
	"strings"
	"sync"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
	"github.com/Mag1cFall/Antigravity2API/internal/prompt"
)

// zproxyAdditionalPromptOpen and zproxyAdditionalPromptClose wrap the caller
// system instruction when it travels as a user turn.
const (
	zproxyAdditionalPromptOpen  = "<additional-system-prompt>"
	zproxyAdditionalPromptClose = "</additional-system-prompt>"
)

var zproxyPromptOnce sync.Once
var zproxyPrompt *prompt.Composer
var zproxyPromptError error

// zproxyComposer returns the official full-tier composer once.
func zproxyComposer() (*prompt.Composer, error) {
	zproxyPromptOnce.Do(func() { zproxyPrompt, zproxyPromptError = prompt.New(prompt.TierFull, prompt.Custom{}) })
	return zproxyPrompt, zproxyPromptError
}

// zproxyAdditionalPrompt wraps one caller system instruction as the text of a
// user turn. The upstream reads systemInstruction as user content anyway, and
// an instruction phrase there is what it answers with an unexplained 429, so
// the caller text travels inside a marked block instead of at the top of the
// official system prompt.
func zproxyAdditionalPrompt(system string) string {
	return zproxyAdditionalPromptOpen + "\n" + system + "\n" + zproxyAdditionalPromptClose
}

// ZProxyCompose renders the official full-tier system prompt verbatim and
// moves the caller system instruction into a leading user turn. The official
// full prompt stays byte-identical to the pinned template, so the request
// carries the same identity and sections the official client sends; the caller
// instruction is user content the upstream judges as a request rather than as
// an impersonated system prompt. The official composer still filters the user
// sentences the upstream rejects without a reason, and the caller instruction
// keeps its own text because it is the request the user wrote.
func ZProxyCompose(request antigravity.GenerateRequest, model antigravity.CatalogModel, cascade string, times []string, device antigravity.Device, plugins string, experiments map[string]bool) (antigravity.GenerateRequest, error) {
	composer, err := zproxyComposer()
	if err != nil {
		return request, err
	}
	additional := strings.TrimSpace(request.System)
	request.System = ""
	composed, err := composer.Compose(request, model, cascade, times, device, plugins, experiments)
	if err != nil {
		return composed, err
	}
	if additional == "" {
		return composed, nil
	}
	// The block leads the history, so it stays in front of the first user turn
	// the official wrapper already rewrote and keeps that wrapper's times.
	contents := make([]antigravity.Content, 0, len(composed.Contents)+1)
	contents = append(contents, antigravity.Content{Role: antigravity.RoleUser,
		Parts: []antigravity.Part{{Text: zproxyAdditionalPrompt(additional)}}})
	composed.Contents = append(contents, composed.Contents...)
	return composed, nil
}

// ZProxyBoot starts the unmodified official account initialization.
func ZProxyBoot(ctx, watch context.Context, client *antigravity.Client) (*antigravity.Companion, antigravity.Initialization, error) {
	return boot(ctx, watch, client, "zproxy", false, false)
}

// ZProxyStripBilling removes the Claude Code billing header lines with the
// official dropBilling rule, which is the first step of the official Generate.
func ZProxyStripBilling(request antigravity.GenerateRequest) antigravity.GenerateRequest {
	request.System = dropBilling(request.System)
	return request
}

// ZProxySectionTokens uses the official per-section token accounting.
func ZProxySectionTokens(model antigravity.CatalogModel, cascade string, device antigravity.Device, plugins string, experiments map[string]bool) []int {
	return sectionTokens(model, cascade, device, plugins, experiments)
}

// ZProxyLocalTimes formats stored message times with the selected device zone.
func ZProxyLocalTimes(times []int64, device antigravity.Device) []string {
	return localTimes(times, device)
}
