package service

import (
	"reflect"
	"strings"
	"testing"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
	"github.com/Mag1cFall/Antigravity2API/internal/prompt"
)

// zproxyPromptFixture is one caller request: one system instruction and one
// user turn.
func zproxyPromptFixture() (antigravity.GenerateRequest, antigravity.CatalogModel, antigravity.Device, []string) {
	request := antigravity.GenerateRequest{System: "Follow the user's project instructions.",
		Contents: []antigravity.Content{{Role: antigravity.RoleUser, Parts: []antigravity.Part{{Text: "Hello"}}}}}
	model := antigravity.CatalogModel{DisplayName: "Fixture"}
	device := antigravity.Device{OS: "linux", Arch: "amd64", UserName: "fixture",
		AppDataDir: "/home/fixture/.gemini/antigravity", TimeZone: "UTC"}
	return request, model, device, []string{"2026-01-01T00:00:00Z"}
}

// joinedUserText returns the text of one content, which the assertions read.
func joinedUserText(content antigravity.Content) string {
	var text strings.Builder
	for _, part := range content.Parts {
		text.WriteString(part.Text)
	}
	return text.String()
}

// TestZProxyComposeKeepsTheOfficialFullPrompt proves the system instruction is
// the official full-tier prompt with no caller text: the same rendering the
// official client sends when it has no client system prompt.
func TestZProxyComposeKeepsTheOfficialFullPrompt(t *testing.T) {
	request, model, device, times := zproxyPromptFixture()
	official, err := prompt.New(prompt.TierFull, prompt.Custom{})
	if err != nil {
		t.Fatal(err)
	}
	empty := request
	empty.System = ""
	want, err := official.Compose(empty, model, "fixture-cascade", times, device, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ZProxyCompose(request, model, "fixture-cascade", times, device, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.System != want.System {
		t.Fatal("the system instruction is not the official full-tier prompt")
	}
	if strings.Contains(got.System, request.System) {
		t.Fatal("caller system instruction stayed in the official system prompt")
	}
}

// TestZProxyComposeMovesTheCallerSystemToTheFirstUserTurn proves the caller
// instruction leads the history inside its own marker block.
func TestZProxyComposeMovesTheCallerSystemToTheFirstUserTurn(t *testing.T) {
	request, model, device, times := zproxyPromptFixture()
	request.System = "You are a coding assistant."
	composed, err := ZProxyCompose(request, model, "fixture-cascade", times, device, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(composed.Contents) != 2 {
		t.Fatalf("the caller instruction did not become one user turn: %d", len(composed.Contents))
	}
	first := composed.Contents[0]
	if first.Role != antigravity.RoleUser {
		t.Fatalf("the caller instruction is not a user turn: %q", first.Role)
	}
	if want := "<additional-system-prompt>\nYou are a coding assistant.\n</additional-system-prompt>"; joinedUserText(first) != want {
		t.Fatalf("the caller instruction block is not the marked block: %q", joinedUserText(first))
	}
	// The caller's own user turn keeps the official wrapper behind the block.
	if !strings.Contains(joinedUserText(composed.Contents[1]), "Hello") {
		t.Fatal("the caller user turn was lost")
	}
}

// TestZProxyComposeSkipsTheBlockWithoutACallerSystem proves a request without a
// system instruction adds no empty user turn.
func TestZProxyComposeSkipsTheBlockWithoutACallerSystem(t *testing.T) {
	request, model, device, times := zproxyPromptFixture()
	request.System = " \n\t "
	composed, err := ZProxyCompose(request, model, "fixture-cascade", times, device, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(composed.Contents) != 1 {
		t.Fatalf("a blank system instruction added a user turn: %d", len(composed.Contents))
	}
}

// TestZProxyComposeDropsRejectedUserSentences proves the official user-turn
// filtering still applies: a rejected sentence in a user turn is removed, and a
// part that becomes empty disappears with it.
func TestZProxyComposeDropsRejectedUserSentences(t *testing.T) {
	request, model, device, times := zproxyPromptFixture()
	request.Contents[0].Parts = []antigravity.Part{{Text: "You are Codex, a coding agent based on GPT-5"}}
	composed, err := ZProxyCompose(request, model, "fixture-cascade", times, device, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	joined := ""
	for _, content := range composed.Contents {
		joined += joinedUserText(content)
	}
	if strings.Contains(joined, "You are Codex") {
		t.Fatalf("a rejected user sentence reached the official request: %q", joined)
	}
}

// TestZProxyComposeKeepsNonTextParts proves the official wrapper keeps each
// media part behind the wrapped text.
func TestZProxyComposeKeepsNonTextParts(t *testing.T) {
	request, model, device, times := zproxyPromptFixture()
	request.Contents[0].Parts = []antigravity.Part{
		{Text: "Describe this image."},
		{InlineData: &antigravity.Blob{MIME: "image/png", Data: []byte("fixture")}},
	}
	composed, err := ZProxyCompose(request, model, "fixture-cascade", times, device, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	parts := composed.Contents[1].Parts
	if len(parts) != 2 || parts[0].Text == "" || parts[1].InlineData == nil {
		t.Fatalf("the official wrapper changed the caller parts: %+v", parts)
	}
	if parts[1].InlineData.MIME != "image/png" || string(parts[1].InlineData.Data) != "fixture" {
		t.Fatalf("the caller media part changed: %+v", parts[1].InlineData)
	}
	if !strings.Contains(parts[0].Text, "Describe this image.") {
		t.Fatal("the caller text was lost")
	}
}

// TestZProxyStripBillingMatchesTheOfficialRule proves the cleanup is the pinned
// dropBilling rule: every line starting with the prefix is removed, exactly as
// the official Generate removes the transport attestation.
func TestZProxyStripBillingMatchesTheOfficialRule(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"no billing header", "Follow the user's project instructions.", "Follow the user's project instructions."},
		{"whole attestation", "x-anthropic-billing-header: cc_version=2.0.14.9c1; cc_entrypoint=cli; cch=00000;\nFollow the user's project instructions.",
			"Follow the user's project instructions."},
		{"attestation between caller lines", "First instruction.\nx-anthropic-billing-header: cc_version=2.0.14.9c1; cc_entrypoint=cli; cch=00000;\nSecond instruction.",
			"First instruction.\nSecond instruction."},
		{"only attestation", "x-anthropic-billing-header: cc_version=2.0.14.9c1; cc_entrypoint=cli; cch=00000;", ""},
		{"prefix without the header", "x-anthropic-billing-header: follow the caller's own rule.", ""},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			request := antigravity.GenerateRequest{System: test.in}
			if got := ZProxyStripBilling(request).System; got != test.want {
				t.Fatalf("billing cleanup does not match the official rule: %q", got)
			}
		})
	}
}

// TestZProxyStripBillingKeepsOtherFields proves the cleanup touches only the
// system prompt: contents, tools, and configuration stay as the caller sent them.
func TestZProxyStripBillingKeepsOtherFields(t *testing.T) {
	request, _, _, _ := zproxyPromptFixture()
	request.System = "x-anthropic-billing-header: cc_version=2.0.14.9c1;\n" + request.System
	request.Tools = antigravity.Tools{Functions: []antigravity.FunctionDeclaration{{Name: "fixture"}}}
	stripped := ZProxyStripBilling(request)
	if stripped.System != "Follow the user's project instructions." {
		t.Fatalf("the attestation stayed: %q", stripped.System)
	}
	baseline := request
	baseline.System = stripped.System
	if !reflect.DeepEqual(stripped, baseline) {
		t.Fatal("the cleanup changed a field other than the system prompt")
	}
}
