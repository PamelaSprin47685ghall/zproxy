package api

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
	"github.com/Mag1cFall/Antigravity2API/internal/prompt"
	"github.com/Mag1cFall/Antigravity2API/internal/service"
)

// The real official client must satisfy the companion surface unchanged. A
// compile-time assertion proves the interface wraps no substitute and hides no
// telemetry call behind a stand-in that could report a success.
var _ ZProxyOfficialCompanion = (*antigravity.Client)(nil)

// zproxyFakeCompanion records only the five official calls the prepare path
// may make. Every other client behavior stays outside this interface.
type zproxyFakeCompanion struct {
	starts      []string
	marketplace []time.Time
	turns       []antigravity.SessionTurn
	plugins     string
	experiments map[string]bool
	startAt     time.Time
	marketAt    time.Time
}

func (fake *zproxyFakeCompanion) StartTrajectory(_ context.Context, trajectory string, _ []antigravity.Content) time.Time {
	fake.starts = append(fake.starts, trajectory)
	return fake.startAt
}

func (fake *zproxyFakeCompanion) LoadMarketplace(_ context.Context) time.Time {
	fake.marketplace = append(fake.marketplace, fake.marketAt)
	return fake.marketAt
}

func (fake *zproxyFakeCompanion) Plugins() string { return fake.plugins }

func (fake *zproxyFakeCompanion) Experiments() map[string]bool { return fake.experiments }

func (fake *zproxyFakeCompanion) SessionSend(turn antigravity.SessionTurn) {
	fake.turns = append(fake.turns, turn)
}

// zproxyOfficialTestProjection returns the public projection the selected
// account resolved to. Its id names the selected model, and its limits differ
// from the account entry on purpose, because the entry is authoritative.
func zproxyOfficialTestProjection() ZProxyModel {
	return ZProxyModel{ID: "gemini-fixture", ModelProvider: antigravity.ProviderGoogle, MaxTokens: 4096,
		MaxOutputTokens: 1024, SupportsThinking: true}
}

func zproxyOfficialTestCatalog() antigravity.CatalogModel {
	return antigravity.CatalogModel{ID: "gemini-fixture", Model: "gemini-fixture", DisplayName: "Gemini Fixture",
		ModelProvider: antigravity.ProviderGoogle, MaxTokens: 8192, MaxOutputTokens: 2048, SupportsThinking: true}
}

func zproxyOfficialTestDevice() antigravity.Device {
	return antigravity.Device{OS: "linux", Arch: "amd64", UserName: "fixture",
		AppDataDir: "/home/fixture/.gemini/antigravity", TimeZone: "UTC", InstallationID: "fixture-installation"}
}

func zproxyOfficialTestSessions(t *testing.T) *service.ZProxySessions {
	t.Helper()
	return zproxyOfficialTestSessionsAt(t, t.TempDir())
}

// zproxyOfficialTestSessionsAt opens the session store in dir, so a test can
// also observe what the store wrote.
func zproxyOfficialTestSessionsAt(t *testing.T, dir string) *service.ZProxySessions {
	t.Helper()
	sessions, err := service.NewZProxySessions(dir)
	if err != nil {
		t.Fatal(err)
	}
	return sessions
}

// zproxyOfficialStoredSessions counts the session files the store wrote in dir.
func zproxyOfficialStoredSessions(t *testing.T, dir string) int {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	return len(entries)
}

func zproxyOfficialStatus(err error) int {
	var fault *service.Error
	if errors.As(err, &fault) {
		return fault.HTTPStatus()
	}
	return 0
}

// zproxyOfficialTime matches the local timestamp the official user-turn wrapper
// writes with the selected device zone.
var zproxyOfficialTime = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})`)

// zproxyOfficialNormalizeTimes serializes one wire request and replaces only its
// local timestamps, so a comparison ignores the clock and nothing else.
func zproxyOfficialNormalizeTimes(t *testing.T, request antigravity.WireRequest) string {
	t.Helper()
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return zproxyOfficialTime.ReplaceAllString(string(encoded), "<time>")
}

// TestZProxyOfficialPrepareMatchesTheOfficialComposer proves the returned
// envelope carries exactly what the official full-tier composer and the official
// envelope builder produce for the same input and catalog entry.
func TestZProxyOfficialPrepareMatchesTheOfficialComposer(t *testing.T) {
	raw := []byte(`{"model":"friendly","messages":[{"role":"system","content":"Answer briefly."},{"role":"user","content":"Hello"}]}`)
	projection, model := zproxyOfficialTestProjection(), zproxyOfficialTestCatalog()
	device := zproxyOfficialTestDevice()
	sessions := zproxyOfficialTestSessions(t)
	fake := &zproxyFakeCompanion{plugins: "fixture-plugins", experiments: map[string]bool{"fixture": true},
		startAt: time.Unix(1_700_000_000, 0), marketAt: time.Unix(1_700_000_100, 0)}
	got, err := ZProxyOfficialPrepare(context.Background(), raw, projection, model, "scope-a", "fixture-project", device, sessions, fake)
	if err != nil {
		t.Fatal(err)
	}
	// The official conversation the call reported is the reference: the same
	// input through the pinned request rules, the official full-tier composer,
	// and the official envelope builder must reproduce the same wire request.
	parsed, err := zproxyParse(raw, "/v1/chat/completions", projection.ModelProvider)
	if err != nil {
		t.Fatal(err)
	}
	request := service.ZProxyStripBilling(parsed.generate)
	prepared, _, err := service.ZProxyPrepare(request, model, parsed.signed)
	if err != nil {
		t.Fatal(err)
	}
	if len(fake.turns) != 1 {
		t.Fatalf("expected one official session turn, got %d", len(fake.turns))
	}
	conversation := fake.turns[0].Conversation
	official, err := prompt.New(prompt.TierFull, prompt.Custom{})
	if err != nil {
		t.Fatal(err)
	}
	times := make([]string, len(prepared.Contents))
	for index := range times {
		times[index] = time.Unix(1_700_000_000, 0).In(device.Location()).Format(time.RFC3339)
	}
	// The reference composition is the official composer with no client system
	// prompt, plus the caller instruction as the leading user block the adapter
	// adds. Building both halves here keeps the comparison byte for byte.
	reference := prepared
	reference.System = ""
	composed, err := official.Compose(reference, model, conversation.CascadeID, times, device, fake.plugins, fake.experiments)
	if err != nil {
		t.Fatal(err)
	}
	composed.Contents = append([]antigravity.Content{{Role: antigravity.RoleUser, Parts: []antigravity.Part{
		{Text: "<additional-system-prompt>\nAnswer briefly.\n</additional-system-prompt>"}}}}, composed.Contents...)
	want, err := antigravity.BuildEnvelope("fixture-project", model, conversation, composed.System,
		composed.Contents, composed.Tools, composed.Config, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// The request id carries the construction time, so it cannot match; every
	// other envelope field must equal the official result.
	if got.RequestID == "" || got.Project != want.Project || got.Model != want.Model ||
		got.UserAgent != want.UserAgent || got.RequestType != want.RequestType {
		t.Fatalf("unexpected envelope identity: %+v", got)
	}
	// The user-turn wrapper carries each message's local time, which the pinned
	// composer derives from the session clock. Normalize only those timestamps so
	// the rest of the official wire request must match byte for byte.
	if zproxyOfficialNormalizeTimes(t, got.Request) != zproxyOfficialNormalizeTimes(t, want.Request) {
		t.Fatal("the official wire request changed")
	}
	if strings.Contains(got.Request.SystemInstruction.Parts[0].Text, "Answer briefly.") {
		t.Fatal("the caller system instruction stayed in the official system prompt")
	}
	if got.Request.GenerationConfig.MaxOutputTokens != model.MaxOutputTokens {
		t.Fatal("the account catalog output limit was not used")
	}
}

// TestZProxyOfficialPrepareMovesTheCallerSystemToAUserBlock proves the caller
// system instruction travels as the leading user block and keeps its text,
// because the upstream refuses an instruction phrase in the system prompt.
func TestZProxyOfficialPrepareMovesTheCallerSystemToAUserBlock(t *testing.T) {
	const identity = "You are Claude Code, Anthropic's official CLI for Claude."
	raw, err := json.Marshal(map[string]any{"model": "friendly", "messages": []map[string]string{
		{"role": "system", "content": identity + "\nAnswer briefly."},
		{"role": "user", "content": "Hello"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	fake := &zproxyFakeCompanion{}
	envelope, err := ZProxyOfficialPrepare(context.Background(), raw, zproxyOfficialTestProjection(),
		zproxyOfficialTestCatalog(), "scope", "project", zproxyOfficialTestDevice(),
		zproxyOfficialTestSessions(t), fake)
	if err != nil {
		t.Fatal(err)
	}
	system := envelope.Request.SystemInstruction.Parts[0].Text
	if strings.Contains(system, "You are Claude Code") {
		t.Fatalf("a caller instruction phrase stayed in the official system prompt: %q", system)
	}
	block := envelope.Request.Contents[0]
	if block.Role != "user" || !strings.Contains(block.Parts[0].Text, "Answer briefly.") {
		t.Fatalf("the caller instruction did not become the leading user block: %+v", block)
	}
	if !strings.Contains(block.Parts[0].Text, "You are Claude Code") {
		t.Fatal("the caller instruction block lost caller text")
	}
}

// TestZProxyOfficialPrepareUsesTheOfficialBillingRule proves the caller system
// prompt is cleaned with the pinned dropBilling rule before it moves into the
// user block: every line starting with the transport prefix is removed.
func TestZProxyOfficialPrepareUsesTheOfficialBillingRule(t *testing.T) {
	attestation := "x-anthropic-billing-header: cc_version=2.0.14.9c1; cc_entrypoint=cli; cch=00000;"
	raw, err := json.Marshal(map[string]any{"model": "friendly", "messages": []map[string]string{
		{"role": "system", "content": attestation + "\nAnswer briefly."},
		{"role": "user", "content": "Hello"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	fake := &zproxyFakeCompanion{}
	envelope, err := ZProxyOfficialPrepare(context.Background(), raw, zproxyOfficialTestProjection(),
		zproxyOfficialTestCatalog(), "scope", "project", zproxyOfficialTestDevice(),
		zproxyOfficialTestSessions(t), fake)
	if err != nil {
		t.Fatal(err)
	}
	system := envelope.Request.SystemInstruction.Parts[0].Text
	if strings.Contains(system, attestation) {
		t.Fatal("the billing attestation reached the official system prompt")
	}
	block := envelope.Request.Contents[0]
	if strings.Contains(block.Parts[0].Text, attestation) {
		t.Fatal("the billing attestation reached the caller instruction block")
	}
	if !strings.Contains(block.Parts[0].Text, "Answer briefly.") {
		t.Fatalf("the billing cleanup removed the caller instruction: %+v", block)
	}
}

// TestZProxyOfficialPrepareKeepsTheAccountEntryOverTheProjection proves the
// projection cannot replace the selected account's catalog entry: the entry
// supplies the wire model, the limits, the thinking tier, and the displayed name
// the official user-turn wrapper writes, for the envelope and the session turn.
func TestZProxyOfficialPrepareKeepsTheAccountEntryOverTheProjection(t *testing.T) {
	raw := []byte(`{"model":"friendly","messages":[{"role":"user","content":"Hello"}]}`)
	projection := zproxyOfficialTestProjection()
	model := zproxyOfficialTestCatalog()
	model.Model = "MODEL_ACCOUNT_ENTRY"
	model.DisplayName = "Account Fixture"
	model.MaxOutputTokens, model.MaxTokens = 4096, 16384
	model.ThinkingLevel = 3
	// The projection names the same wire enum and family, which the entry check
	// accepts, and no thinking choice, so the entry's own tier is used. Every
	// other projected field stays out of the request.
	projection.Model = model.Model
	projection.MaxOutputTokens, projection.MaxTokens = 1024, 4096
	fake := &zproxyFakeCompanion{}
	envelope, err := ZProxyOfficialPrepare(context.Background(), raw, projection, model, "scope", "project",
		zproxyOfficialTestDevice(), zproxyOfficialTestSessions(t), fake)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Model != model.ID || envelope.Request.GenerationConfig.MaxOutputTokens != model.MaxOutputTokens {
		t.Fatalf("the envelope did not use the account entry: %+v", envelope)
	}
	if envelope.Request.Labels["model_enum"] != model.Model {
		t.Fatalf("the envelope did not carry the account entry wire model: %v", envelope.Request.Labels)
	}
	thinking := envelope.Request.GenerationConfig.ThinkingConfig
	// The projection names no thinking choice in this case, so the account entry
	// keeps its own tier.
	if thinking.ThinkingLevel != "HIGH" || thinking.ThinkingBudget != nil {
		t.Fatalf("the account entry thinking level was not used: %+v", thinking)
	}
	if len(fake.turns) != 1 || fake.turns[0].Model.Model != model.Model ||
		fake.turns[0].Model.MaxOutputTokens != model.MaxOutputTokens ||
		fake.turns[0].Sections == nil {
		t.Fatal("the session turn did not carry the account entry")
	}
	// The official user-turn wrapper names the selected model display name, and
	// the caller's own text stays inside the wrapper.
	wrapped := envelope.Request.Contents[len(envelope.Request.Contents)-1].Parts[0].Text
	if !strings.Contains(wrapped, model.DisplayName) || !strings.Contains(wrapped, "Hello") {
		t.Fatalf("the user turn did not use the account entry display name: %q", wrapped)
	}
}

// TestZProxyOfficialPrepareAppliesTheProjectionThinkingChoice proves the one
// request-level field the projection owns besides the model identity takes
// effect on the wire, exactly as the shared prepare path applies it: a request
// that disables thinking sends no thinking output and no thinking budget, a
// projected level reaches the envelope as that level, and a projected budget
// reaches it as that budget.
func TestZProxyOfficialPrepareAppliesTheProjectionThinkingChoice(t *testing.T) {
	raw := []byte(`{"model":"friendly","messages":[{"role":"user","content":"Hello"}]}`)
	t.Run("disabled", func(t *testing.T) {
		projection := zproxyOfficialTestProjection()
		projection.ThinkingDisabled = true
		projection.ThinkingBudget = func() *int64 { zero := int64(0); return &zero }()
		fake := &zproxyFakeCompanion{}
		envelope, err := ZProxyOfficialPrepare(context.Background(), raw, projection, zproxyOfficialTestCatalog(),
			"scope", "project", zproxyOfficialTestDevice(), zproxyOfficialTestSessions(t), fake)
		if err != nil {
			t.Fatal(err)
		}
		thinking := envelope.Request.GenerationConfig.ThinkingConfig
		if thinking.IncludeThoughts || thinking.ThinkingLevel != nil || thinking.ThinkingBudget == nil || *thinking.ThinkingBudget != 0 {
			t.Fatalf("the projection thinking switch was ignored: %+v", thinking)
		}
		// The session turn reports the model this request was sent as, which keeps
		// the account capabilities the caller did not ask to rewrite.
		if len(fake.turns) != 1 || !fake.turns[0].Model.SupportsThinking ||
			fake.turns[0].Model.ThinkingLevel != 0 || fake.turns[0].Model.ThinkingBudget != nil {
			t.Fatal("the session turn must report the model this request used")
		}
	})
	t.Run("level", func(t *testing.T) {
		projection := zproxyOfficialTestProjection()
		projection.ThinkingLevel = 2
		envelope, err := ZProxyOfficialPrepare(context.Background(), raw, projection, zproxyOfficialTestCatalog(),
			"scope", "project", zproxyOfficialTestDevice(), zproxyOfficialTestSessions(t), &zproxyFakeCompanion{})
		if err != nil {
			t.Fatal(err)
		}
		thinking := envelope.Request.GenerationConfig.ThinkingConfig
		if !thinking.IncludeThoughts || thinking.ThinkingLevel != "MEDIUM" || thinking.ThinkingBudget != nil {
			t.Fatalf("the projected level was not applied: %+v", thinking)
		}
	})
	t.Run("budget", func(t *testing.T) {
		projection := zproxyOfficialTestProjection()
		projection.ThinkingBudget = func() *int64 { budget := int64(2048); return &budget }()
		envelope, err := ZProxyOfficialPrepare(context.Background(), raw, projection, zproxyOfficialTestCatalog(),
			"scope", "project", zproxyOfficialTestDevice(), zproxyOfficialTestSessions(t), &zproxyFakeCompanion{})
		if err != nil {
			t.Fatal(err)
		}
		thinking := envelope.Request.GenerationConfig.ThinkingConfig
		if !thinking.IncludeThoughts || thinking.ThinkingLevel != nil || thinking.ThinkingBudget == nil ||
			*thinking.ThinkingBudget != 2048 {
			t.Fatalf("the projected budget was not applied: %+v", thinking)
		}
	})
}

// TestZProxyOfficialPrepareFillsUnsetThinkingFields proves a thinking field the
// account entry leaves unset takes the caller's selection, so the request still
// carries the tier the caller asked for, while a field the entry sets keeps the
// account value.
func TestZProxyOfficialPrepareFillsUnsetThinkingFields(t *testing.T) {
	raw := []byte(`{"model":"friendly","messages":[{"role":"user","content":"Hello"}]}`)
	t.Run("caller level", func(t *testing.T) {
		projection := zproxyOfficialTestProjection()
		projection.ThinkingLevel = 1
		envelope, err := ZProxyOfficialPrepare(context.Background(), raw, projection, zproxyOfficialTestCatalog(),
			"scope", "project", zproxyOfficialTestDevice(), zproxyOfficialTestSessions(t), &zproxyFakeCompanion{})
		if err != nil {
			t.Fatal(err)
		}
		if level := envelope.Request.GenerationConfig.ThinkingConfig.ThinkingLevel; level != "LOW" {
			t.Fatalf("the caller tier was dropped: %+v", envelope.Request.GenerationConfig.ThinkingConfig)
		}
	})
	t.Run("account level", func(t *testing.T) {
		model := zproxyOfficialTestCatalog()
		model.ThinkingLevel = 3
		envelope, err := ZProxyOfficialPrepare(context.Background(), raw, zproxyOfficialTestProjection(), model,
			"scope", "project", zproxyOfficialTestDevice(), zproxyOfficialTestSessions(t), &zproxyFakeCompanion{})
		if err != nil {
			t.Fatal(err)
		}
		if level := envelope.Request.GenerationConfig.ThinkingConfig.ThinkingLevel; level != "HIGH" {
			t.Fatalf("the account tier was dropped: %+v", envelope.Request.GenerationConfig.ThinkingConfig)
		}
	})
	t.Run("caller budget", func(t *testing.T) {
		projection := zproxyOfficialTestProjection()
		projection.ThinkingBudget = func() *int64 { budget := int64(2048); return &budget }()
		envelope, err := ZProxyOfficialPrepare(context.Background(), raw, projection, zproxyOfficialTestCatalog(),
			"scope", "project", zproxyOfficialTestDevice(), zproxyOfficialTestSessions(t), &zproxyFakeCompanion{})
		if err != nil {
			t.Fatal(err)
		}
		thinking := envelope.Request.GenerationConfig.ThinkingConfig
		if thinking.ThinkingLevel != nil || thinking.ThinkingBudget == nil || *thinking.ThinkingBudget != 2048 {
			t.Fatalf("the caller budget was dropped: %+v", thinking)
		}
	})
}

// TestZProxyOfficialPrepareKeepsScopesApart proves two scopes with an equal
// request take different official conversations, while one scope resumes its
// own. The official store keys sessions on a scope digest, so this test checks
// the isolation the caller relies on.
func TestZProxyOfficialPrepareKeepsScopesApart(t *testing.T) {
	raw := []byte(`{"model":"friendly","messages":[{"role":"user","content":"Hello"}]}`)
	projection, model, device := zproxyOfficialTestProjection(), zproxyOfficialTestCatalog(), zproxyOfficialTestDevice()
	sessions := zproxyOfficialTestSessions(t)
	first := &zproxyFakeCompanion{}
	if _, err := ZProxyOfficialPrepare(context.Background(), raw, projection, model, "scope-a", "project", device, sessions, first); err != nil {
		t.Fatal(err)
	}
	second := &zproxyFakeCompanion{}
	if _, err := ZProxyOfficialPrepare(context.Background(), raw, projection, model, "scope-b", "project", device, sessions, second); err != nil {
		t.Fatal(err)
	}
	again := &zproxyFakeCompanion{}
	if _, err := ZProxyOfficialPrepare(context.Background(), raw, projection, model, "scope-a", "project", device, sessions, again); err != nil {
		t.Fatal(err)
	}
	left, right, resumed := first.turns[0], second.turns[0], again.turns[0]
	if left.Conversation.CascadeID == right.Conversation.CascadeID && left.Conversation.TrajectoryID == right.Conversation.TrajectoryID {
		t.Fatal("two scopes resumed one official conversation")
	}
	if !left.New || !right.New || resumed.New {
		t.Fatal("a first request per scope must start a new conversation")
	}
	if resumed.Conversation.CascadeID != left.Conversation.CascadeID || resumed.Conversation.TrajectoryID != left.Conversation.TrajectoryID {
		t.Fatal("one scope did not resume its own conversation")
	}
	if len(first.starts) != 1 || len(second.starts) != 1 || len(again.starts) != 0 ||
		len(again.marketplace) != 1 {
		t.Fatal("a new conversation starts a trajectory; a resumed one reads the marketplace")
	}
}

func TestZProxyOfficialPrepareKeepsTheWirePrefixOnAppend(t *testing.T) {
	projection, model, device := zproxyOfficialTestProjection(), zproxyOfficialTestCatalog(), zproxyOfficialTestDevice()
	sessions := zproxyOfficialTestSessions(t)
	client := &zproxyFakeCompanion{}
	prepare := func(messages string) antigravity.WireRequest {
		t.Helper()
		raw := []byte(`{"model":"friendly","messages":[{"role":"system","content":"Keep answers short"},{"role":"user","content":"Hello"}` + messages + `]}`)
		envelope, err := ZProxyOfficialPrepare(context.Background(), raw, projection, model, "scope", "project", device, sessions, client)
		if err != nil {
			t.Fatal(err)
		}
		return envelope.Request
	}
	first := prepare("")
	next := prepare(`,{"role":"assistant","content":"Hi"},{"role":"user","content":"How are you?"}`)
	if !reflect.DeepEqual(first.SystemInstruction, next.SystemInstruction) {
		t.Fatal("continuing a conversation changed its wire system instruction")
	}
	if len(next.Contents) != len(first.Contents)+2 ||
		!reflect.DeepEqual(first.Contents, next.Contents[:len(first.Contents)]) {
		t.Fatal("continuing a conversation changed its existing wire messages")
	}
}

// TestZProxyOfficialPrepareSendsTheOfficialSessionFields proves the session
// turn carries the official fields: the derived conversation, the new flag, the
// account catalog entry, the composed contents, the per-section token counts,
// and the anchor of the start or marketplace call.
func TestZProxyOfficialPrepareSendsTheOfficialSessionFields(t *testing.T) {
	raw := []byte(`{"model":"friendly","messages":[{"role":"user","content":"Hello"}]}`)
	projection, model, device := zproxyOfficialTestProjection(), zproxyOfficialTestCatalog(), zproxyOfficialTestDevice()
	anchor := time.Unix(1_700_000_500, 0)
	fake := &zproxyFakeCompanion{plugins: "fixture-plugins", experiments: map[string]bool{"fixture": true}, startAt: anchor}
	envelope, err := ZProxyOfficialPrepare(context.Background(), raw, projection, model, "scope", "project", device,
		zproxyOfficialTestSessions(t), fake)
	if err != nil {
		t.Fatal(err)
	}
	if len(fake.turns) != 1 {
		t.Fatalf("expected one session turn, got %d", len(fake.turns))
	}
	turn := fake.turns[0]
	if !turn.New || turn.Model.ID != model.ID || turn.Model.Model != model.Model ||
		turn.Model.MaxOutputTokens != model.MaxOutputTokens {
		t.Fatal("the session turn did not carry the account catalog entry")
	}
	if turn.Conversation.CascadeID == "" || turn.Conversation.TrajectoryID == "" || turn.Conversation.Step < 1 {
		t.Fatalf("the session turn carried an incomplete conversation: %+v", turn.Conversation)
	}
	if !turn.Anchor.Equal(anchor) {
		t.Fatal("the new conversation must anchor on the trajectory start")
	}
	if len(turn.Sections) != len(antigravity.SessionSections(model)) {
		t.Fatalf("section token counts must follow the official sections: %d", len(turn.Sections))
	}
	want := service.ZProxySectionTokens(model, turn.Conversation.CascadeID, device, fake.plugins, fake.experiments)
	if !reflect.DeepEqual(turn.Sections, want) {
		t.Fatal("the section token counts diverged from the official accounting")
	}
	// The session turn must describe the same contents the envelope carries.
	if len(turn.Contents) != len(envelope.Request.Contents) {
		t.Fatal("the session turn contents and the envelope contents diverged")
	}
	for index, content := range turn.Contents {
		if string(content.Role) != envelope.Request.Contents[index].Role {
			t.Fatalf("contents[%d] role changed between the session turn and the envelope", index)
		}
	}
	if envelope.Project != "project" || envelope.Model != model.ID {
		t.Fatal("the envelope did not use the selected project and catalog entry")
	}
}

// TestZProxyOfficialPrepareRejectsUnusableCatalogEntries proves the function
// never invents model metadata: a projection that names another model or
// another family, a disabled entry, a missing wire model, an unusable
// projection, and a missing client each fail with a fixed sentence and the
// 400/503 split.
func TestZProxyOfficialPrepareRejectsUnusableCatalogEntries(t *testing.T) {
	raw := []byte(`{"model":"friendly","messages":[{"role":"user","content":"Hello"}]}`)
	device := zproxyOfficialTestDevice()
	projection, model := zproxyOfficialTestProjection(), zproxyOfficialTestCatalog()
	cases := []struct {
		name       string
		projection ZProxyModel
		model      antigravity.CatalogModel
		client     ZProxyOfficialCompanion
		status     int
	}{
		{"disabled catalog entry", projection, zproxyOfficialEditedCatalog(model, func(m *antigravity.CatalogModel) { m.Disabled = true }), &zproxyFakeCompanion{}, 503},
		{"missing wire model", projection, zproxyOfficialEditedCatalog(model, func(m *antigravity.CatalogModel) { m.Model = "" }), &zproxyFakeCompanion{}, 503},
		{"foreign family", projection, zproxyOfficialEditedCatalog(model, func(m *antigravity.CatalogModel) { m.ModelProvider = antigravity.ProviderAnthropic }), &zproxyFakeCompanion{}, 400},
		{"other projection family", zproxyOfficialEditedProjection(projection, func(m *ZProxyModel) { m.ModelProvider = antigravity.ProviderAnthropic }), model, &zproxyFakeCompanion{}, 400},
		{"projection names another model", zproxyOfficialEditedProjection(projection, func(m *ZProxyModel) { m.ID = "another-model" }), model, &zproxyFakeCompanion{}, 400},
		{"projection names another wire enum", zproxyOfficialEditedProjection(projection, func(m *ZProxyModel) { m.Model = "MODEL_OTHER_TIER" }), model, &zproxyFakeCompanion{}, 400},
		{"empty projection id", zproxyOfficialEditedProjection(projection, func(m *ZProxyModel) { m.ID = "" }), model, &zproxyFakeCompanion{}, 400},
		{"unusable projection", ZProxyModel{}, model, &zproxyFakeCompanion{}, 400},
		{"missing companion", projection, model, nil, 503},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fake, _ := test.client.(*zproxyFakeCompanion)
			dir := t.TempDir()
			_, err := ZProxyOfficialPrepare(context.Background(), raw, test.projection, test.model,
				"scope", "project", device, zproxyOfficialTestSessionsAt(t, dir), test.client)
			if err == nil {
				t.Fatal("an unusable catalog entry was accepted")
			}
			if zproxyOfficialStatus(err) != test.status {
				t.Fatalf("status %d, want %d", zproxyOfficialStatus(err), test.status)
			}
			for _, secret := range []string{"scope", "project", model.ID, model.Model, test.projection.ID} {
				if secret != "" && strings.Contains(err.Error(), secret) {
					t.Fatalf("the error repeated private data: %q", err.Error())
				}
			}
			if fake != nil && (len(fake.starts) != 0 || len(fake.marketplace) != 0 || len(fake.turns) != 0) {
				t.Fatal("an official call ran for a rejected catalog entry")
			}
			if stored := zproxyOfficialStoredSessions(t, dir); stored != 0 {
				t.Fatalf("a rejected catalog entry changed the session store: %d files", stored)
			}
		})
	}
}

// TestZProxyOfficialPrepareAcceptsTheCatalogIDForms proves the id comparison
// follows the directory: the catalog keys an entry as "models/<id>" and repeats
// the bare id, and the public projection may carry either form.
func TestZProxyOfficialPrepareAcceptsTheCatalogIDForms(t *testing.T) {
	raw := []byte(`{"model":"friendly","messages":[{"role":"user","content":"Hello"}]}`)
	for _, test := range []struct{ projection, model string }{
		{"gemini-fixture", "models/gemini-fixture"},
		{"models/gemini-fixture", "gemini-fixture"},
		{"models/gemini-fixture", "models/gemini-fixture"},
	} {
		projection := zproxyOfficialTestProjection()
		projection.ID = test.projection
		model := zproxyOfficialTestCatalog()
		model.ID = test.model
		fake := &zproxyFakeCompanion{}
		if _, err := ZProxyOfficialPrepare(context.Background(), raw, projection, model, "scope", "project",
			zproxyOfficialTestDevice(), zproxyOfficialTestSessions(t), fake); err != nil {
			t.Fatalf("%q against %q was rejected: %v", test.projection, test.model, err)
		}
		if len(fake.turns) != 1 {
			t.Fatal("the accepted catalog form did not reach the session turn")
		}
	}
}

// zproxyOfficialEditedCatalog returns a copy of model after edit changes it.
func zproxyOfficialEditedCatalog(model antigravity.CatalogModel, edit func(*antigravity.CatalogModel)) antigravity.CatalogModel {
	edit(&model)
	return model
}

// zproxyOfficialEditedProjection returns a copy of projection after edit
// changes it.
func zproxyOfficialEditedProjection(projection ZProxyModel, edit func(*ZProxyModel)) ZProxyModel {
	edit(&projection)
	return projection
}

// TestZProxyOfficialPrepareRejectsPrivateContextAndRequest proves a control
// character in the scope or project and a malformed body each fail before any
// official call, so no session or telemetry state changes.
func TestZProxyOfficialPrepareRejectsPrivateContextAndRequest(t *testing.T) {
	raw := []byte(`{"model":"friendly","messages":[{"role":"user","content":"Hello"}]}`)
	projection, model, device := zproxyOfficialTestProjection(), zproxyOfficialTestCatalog(), zproxyOfficialTestDevice()
	for _, target := range []string{"scope", "project"} {
		fake := &zproxyFakeCompanion{}
		scope, project := "scope", "project"
		if target == "scope" {
			scope = "bad\nscope"
		} else {
			project = "bad\x00project"
		}
		_, err := ZProxyOfficialPrepare(context.Background(), raw, projection, model, scope, project, device,
			zproxyOfficialTestSessions(t), fake)
		if zproxyOfficialStatus(err) != 400 {
			t.Fatalf("%s was accepted: %v", target, err)
		}
		if len(fake.turns) != 0 || len(fake.starts) != 0 || len(fake.marketplace) != 0 {
			t.Fatal("an official call ran before the context was validated")
		}
	}
	fake := &zproxyFakeCompanion{}
	if _, err := ZProxyOfficialPrepare(context.Background(), []byte(`{"messages":[]}`), projection, model,
		"scope", "project", device, zproxyOfficialTestSessions(t), fake); zproxyOfficialStatus(err) != 400 {
		t.Fatalf("a request without a model was accepted: %v", err)
	}
	if len(fake.turns) != 0 {
		t.Fatal("a malformed request reached the official session")
	}
}
