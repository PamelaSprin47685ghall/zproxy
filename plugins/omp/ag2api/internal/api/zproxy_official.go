package api

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/Mag1cFall/Antigravity2API/internal/antigravity"
	"github.com/Mag1cFall/Antigravity2API/internal/service"
)

// ZProxyOfficialCompanion is the official client surface that one zproxy
// request needs. The real *antigravity.Client satisfies it as is, so the
// official start, marketplace, plugin, experiment, and session calls stay
// unmodified. The set is deliberately minimal: no reply, telemetry, or
// transport call belongs here, and this file adds no stand-in that could
// report a success the official client never observed.
type ZProxyOfficialCompanion interface {
	StartTrajectory(ctx context.Context, trajectory string, contents []antigravity.Content) time.Time
	LoadMarketplace(ctx context.Context) time.Time
	Plugins() string
	Experiments() map[string]bool
	SessionSend(turn antigravity.SessionTurn)
}

// Each failure repeats one fixed sentence. No error carries a scope, a
// project, an account, a model id, or an upstream body.
const (
	zproxyOfficialInvalidContext = "invalid private request context"
	zproxyOfficialInvalidRequest = "invalid request"
	zproxyOfficialUnknownModel   = "the selected model is not available"
	zproxyOfficialModelMismatch  = "the selected model does not match the account catalog"
	zproxyOfficialUnavailable    = "the official upstream is unavailable"
)

func zproxyOfficialError(status int, message string) error {
	return &service.Error{Status: status, Message: message}
}

// zproxyOfficialSafe accepts text of a bounded byte length without control
// characters, which the official wire fields cannot carry.
func zproxyOfficialSafe(value string, limit int) bool {
	if len(value) > limit {
		return false
	}
	return !strings.ContainsFunc(value, func(r rune) bool { return r < 32 || (r >= 127 && r <= 159) })
}

// zproxyOfficialWireID returns the catalog id without the "models/" prefix the
// directory response and the public projection may each carry.
func zproxyOfficialWireID(id string) string {
	return strings.TrimPrefix(id, "models/")
}

// zproxyOfficialEntry checks the catalog entry of the selected account against
// the public projection. The selected model is the identity the caller asked
// for and the entry the request is sent as, so the two ids must name one model;
// a projection that names another model would answer with one model's output
// under another model's name. The family and the wire enum must match too, and
// the account must not have disabled the entry. The entry itself stays the
// source of every model field it sets: a projected limit never replaces the
// metadata the account actually returned, and the only projected value that
// reaches the request is a thinking field the entry leaves unset, which
// zproxyOfficialRequestModel fills in.
func zproxyOfficialEntry(projection ZProxyModel, model antigravity.CatalogModel) error {
	if model.ID == "" || !zproxyOfficialSafe(model.ID, 256) ||
		model.Model == "" || !zproxyOfficialSafe(model.Model, 256) {
		return zproxyOfficialError(503, zproxyOfficialUnknownModel)
	}
	if zproxyFamily(model.ModelProvider) == "" || model.ModelProvider != projection.ModelProvider {
		return zproxyOfficialError(400, zproxyOfficialModelMismatch)
	}
	if zproxyOfficialWireID(projection.ID) != zproxyOfficialWireID(model.ID) {
		return zproxyOfficialError(400, zproxyOfficialModelMismatch)
	}
	// The projection carries the wire enum the caller's catalog chose and the
	// entry carries the enum the account serves. Within one id the tier is
	// fixed, so a different non-empty enum means the two catalogs disagree;
	// using the entry anyway would answer the caller's selected model with
	// another tier's metadata. An empty projected enum is a catalog that names
	// none, which the entry fills.
	if projection.Model != "" && projection.Model != model.Model {
		return zproxyOfficialError(400, zproxyOfficialModelMismatch)
	}
	// MaxOutputTokens reaches the wire, so it must be a usable limit. The
	// context window is advisory here: the envelope builder never sends it, and
	// an account entry may leave it unset.
	if model.Disabled || model.MaxOutputTokens < 1 || model.MaxOutputTokens > 2147483647 ||
		model.MaxTokens < 0 || model.MaxTokens > 2147483647 {
		return zproxyOfficialError(503, zproxyOfficialUnknownModel)
	}
	return nil
}

// zproxyOfficialPrepared maps a request-rule failure. The pinned rules return
// *service.Error for client faults, so this function keeps that status while
// hiding the message.
func zproxyOfficialPrepared(err error) error {
	var fault *service.Error
	if errors.As(err, &fault) && fault.Status >= 400 && fault.Status <= 599 {
		return zproxyOfficialError(fault.Status, zproxyOfficialInvalidRequest)
	}
	return zproxyOfficialError(400, zproxyOfficialInvalidRequest)
}

// zproxyOfficialComposition maps a composer failure to the fixed unavailable
// sentence. The official composer filters the client text the upstream rejects
// and only fails when its own template cannot run.
func zproxyOfficialComposition(error) error {
	return zproxyOfficialError(503, zproxyOfficialUnavailable)
}

// zproxyOfficialRequestModel returns the entry this request is sent as. The
// entry supplies every model field it sets, because it is what the account
// catalog returned for the selected id, and the account catalog is the wire
// truth for a tier the caller only names. The projection supplies the caller's
// request-level thinking choice, which the shared prepare path applies the same
// way, so a thinking field the entry leaves unset is filled from it: dropping
// that choice would send the account default instead of the tier the caller
// selected. A projection that turned thinking off keeps the entry as it is,
// because zproxyOfficialDisableThinking is what turns the output off and the
// session turn still reports the account model.
func zproxyOfficialRequestModel(projection ZProxyModel, model antigravity.CatalogModel) antigravity.CatalogModel {
	if projection.ThinkingDisabled {
		// zproxyOfficialDisableThinking turns the output off on the envelope, so
		// the entry keeps the account tier it reports to the session.
		return model
	}
	if projection.ThinkingLevel != 0 {
		if model.ThinkingLevel == 0 {
			model.ThinkingLevel = projection.ThinkingLevel
		}
	} else if projection.ThinkingBudget != nil && model.ThinkingBudget == nil {
		model.ThinkingBudget = projection.ThinkingBudget
	}
	return model
}

// zproxyOfficialDisableThinking turns thinking output off on the composed
// envelope, which is what the shared prepare path does for the same projection:
// a request that asked for no thinking sends no thoughts and a zero budget, and
// the entry the session turn reports stays the account model.
func zproxyOfficialDisableThinking(request *antigravity.WireRequest) {
	zero := int64(0)
	request.GenerationConfig.ThinkingConfig.IncludeThoughts = false
	request.GenerationConfig.ThinkingConfig.ThinkingLevel = nil
	request.GenerationConfig.ThinkingConfig.ThinkingBudget = &zero
}

// zproxyOfficialMessageTimes returns exactly one Unix second per message, which
// is the official per-message time: the times the chain already recorded first,
// then the current second for a message the chain has not seen. A stored time
// beyond the message count is dropped, and the result never shares its array
// with the caller's slice.
func zproxyOfficialMessageTimes(messages int, stored []int64) []int64 {
	times := make([]int64, messages)
	copy(times, stored)
	now := time.Now().Unix()
	for index := len(stored); index < messages; index++ {
		times[index] = now
	}
	return times
}

// ZProxyOfficialPrepare builds the official envelope for one selected account.
// It follows the pinned Service.Generate order: strip the billing lines,
// resolve the account catalog entry, prepare the request rules, begin the
// official conversation for the scope, derive it, start the trajectory or read
// the marketplace, read the official plugins and experiments, compose the
// full-tier system prompt, build the envelope, and send the official session
// turn. The caller owns authentication and transport, so the returned envelope
// is ready for the official streamGenerateContent hop.
//
// officialModel is the entry from the selected account catalog and supplies the
// model metadata. The projection supplies the requested model identity, its
// request family, and its request-level thinking choice; zproxyOfficialEntry
// checks the identity and the family against the entry, and
// zproxyOfficialRequestModel fills a thinking field the entry leaves unset, so
// the request keeps the tier the caller chose. The official composer filters the
// client phrases and user sentences the upstream rejects without a reason, so
// the composed request carries exactly what the official client would send.
func ZProxyOfficialPrepare(ctx context.Context, raw []byte, projection ZProxyModel, officialModel antigravity.CatalogModel,
	scope, project string, device antigravity.Device, sessions *service.ZProxySessions,
	client ZProxyOfficialCompanion) (antigravity.Envelope, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if sessions == nil || client == nil {
		return antigravity.Envelope{}, zproxyOfficialError(503, zproxyOfficialUnavailable)
	}
	if scope == "" || !zproxyOfficialSafe(scope, 256) || !zproxyOfficialSafe(project, 1024) {
		return antigravity.Envelope{}, zproxyOfficialError(400, zproxyOfficialInvalidContext)
	}
	if _, err := projection.catalog(); err != nil {
		return antigravity.Envelope{}, zproxyOfficialError(400, zproxyOfficialInvalidRequest)
	}
	if err := zproxyOfficialEntry(projection, officialModel); err != nil {
		return antigravity.Envelope{}, err
	}
	parsed, err := zproxyParse(raw, "/v1/chat/completions", projection.ModelProvider)
	if err != nil {
		return antigravity.Envelope{}, zproxyOfficialError(400, zproxyOfficialInvalidRequest)
	}
	// The billing-line cleanup is the first step of the official Generate, so
	// the session chain sees the same system prompt the upstream service chains.
	request := service.ZProxyStripBilling(parsed.generate)
	// The request rules need the thinking choice the caller made as well, so the
	// model this call sends is the entry with a thinking field it leaves unset
	// filled from the projection.
	requested := zproxyOfficialRequestModel(projection, officialModel)
	// The output rules belong to the decode stage, not to envelope assembly. ZProxyDecode
	// applies them to the raw upstream body with the same pinned request rules.
	prepared, _, err := service.ZProxyPrepare(request, requested, parsed.signed)
	if err != nil {
		return antigravity.Envelope{}, zproxyOfficialPrepared(err)
	}
	session, err := sessions.Begin(request, scope)
	if err != nil {
		return antigravity.Envelope{}, zproxyOfficialError(503, zproxyOfficialUnavailable)
	}
	conversation := antigravity.NewConversation(session.Cascade, session.Trajectory, prepared.Contents)
	local := service.ZProxyLocalTimes(zproxyOfficialMessageTimes(len(prepared.Contents), session.Times), device)
	// A new conversation records the official title request; a resumed one reads
	// the marketplace, exactly as the pinned Generate does per account.
	var anchor time.Time
	if session.New {
		anchor = client.StartTrajectory(ctx, session.Trajectory, prepared.Contents)
	} else {
		anchor = client.LoadMarketplace(ctx)
	}
	plugins, experiments := client.Plugins(), client.Experiments()
	composed, err := service.ZProxyCompose(prepared, requested, session.Cascade, local, device, plugins, experiments)
	if err != nil {
		return antigravity.Envelope{}, zproxyOfficialComposition(err)
	}
	envelope, err := antigravity.BuildEnvelope(project, requested, conversation, composed.System,
		composed.Contents, composed.Tools, composed.Config, time.Now())
	if err != nil {
		return antigravity.Envelope{}, zproxyOfficialError(400, zproxyOfficialInvalidRequest)
	}
	if projection.ThinkingDisabled {
		zproxyOfficialDisableThinking(&envelope.Request)
	}
	// The official session turn reports the model this request was sent as, uses
	// the composed contents and the same cascade, and counts the sections of the
	// request it sent, which is the per-section accounting of the pinned client.
	client.SessionSend(antigravity.SessionTurn{
		Conversation: conversation,
		New:          session.New,
		Model:        requested,
		Contents:     composed.Contents,
		Sections:     service.ZProxySectionTokens(requested, session.Cascade, device, plugins, experiments),
		Anchor:       anchor,
	})
	return envelope, nil
}
