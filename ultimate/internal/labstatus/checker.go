// Package labstatus implements the lab activation gate.
//
// Before the sender announces a study and before it uploads one, it asks the
// backend "is this lab still allowed to transmit?". An inactive answer holds
// transmission — notifications are parked, queue entries are re-enqueued — and
// raises a banner in the app. Nothing is refused at the DICOM door and nothing
// is marked failed: studies keep arriving and keep being stored, they just
// don't leave the workstation until the lab is active again.
//
// # The failure policy is deliberately asymmetric
//
// The two mistakes this gate can make are not equally bad. Wrongly blocking a
// working lab loses studies for good, because the retention sweeper deletes
// delivered-or-not studies after its window and the central PACS never heard
// of them. Wrongly allowing a lapsed lab costs a few uploads. So:
//
//   - "inactive" is only ever concluded from an answer the backend actually
//     gave. It then persists until the backend says otherwise.
//   - An unreachable backend is "unknown", never "inactive". Unknown keeps the
//     last known verdict, so a backend outage, an expired TLS cert or a
//     clinic's flaky link cannot strand studies.
//   - With no verdict ever received, FailOpen (default true) decides.
//
// This is why a backend must not answer 404 for a lab it doesn't recognise:
// 404 reads as "route missing" and falls through to the failure policy. An
// explicit block is 200 with {"active": false}.
//
// # The compression policy rides on the same answer
//
// The PACS keeps one switch per lab — "compression on / off" — and the answer
// to the activation question carries it as a boolean "compression". It is read
// on every check, for active and inactive labs alike, and it is tracked
// separately from the activation verdict: a lab that is suspended still has a
// policy, and it must already be in force the moment the lab is reactivated
// and its held studies start to move.
//
// The same asymmetry applies. A policy is only ever concluded from a body that
// states one; an unreachable backend, or an older one that does not send the
// field, leaves the last known policy standing.
package labstatus

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/bharatpacs/tarang-sender/internal/log"
	"github.com/bharatpacs/tarang-sender/internal/httpx"
)

// ErrInactive is returned by GateUpload when the lab is not allowed to
// transmit. The queue worker treats it like any other ConnCheck failure: the
// entry is re-enqueued rather than failed, so the retry budget is untouched.
var ErrInactive = errors.New("lab is not active — transmission held")

// DefaultInactiveMessage is shown to the operator when the backend says
// inactive but supplies no message of its own.
const DefaultInactiveMessage = "Your account is inactive. Please contact Ganesham Teleradiology."

const (
	// defaultStaleAfter is how long a verdict is reused before the next call
	// re-checks. The ingest path consults the gate per study, so without this
	// a busy morning would hammer the backend; with it, expect roughly one
	// request per minute per workstation.
	defaultStaleAfter = 60 * time.Second

	// defaultPollInterval is the background refresh cadence, which is what
	// makes a deactivation take effect within about a minute even on an idle
	// workstation.
	defaultPollInterval = 60 * time.Second

	// defaultInactiveHold is how long GateUpload waits for a lab to come back
	// before giving up and returning ErrInactive. It is deliberately finite:
	// the queue entry has already been popped from the store, so blocking
	// forever would lose it if the process died.
	defaultInactiveHold = 30 * time.Second

	// gateRecheckInterval is how often GateUpload re-checks while holding.
	gateRecheckInterval = 5 * time.Second

	// heartbeatInterval restates an unchanged verdict at Info level, so that
	// tailing the log proves the gate is polling. Without it a healthy gate
	// logs nothing and is indistinguishable from one that never started.
	heartbeatInterval = 10 * time.Minute

	// blockedWarnInterval rate-limits "transmission blocked" warnings. The log
	// file is itself shipped to the backend, so an inactive lab left running
	// overnight must not generate a warning per queued series.
	blockedWarnInterval = time.Minute

	requestTimeout = 90 * time.Second
)

// Verdict is a point-in-time answer about whether the lab may transmit.
type Verdict struct {
	// Active is the decision the rest of the sender acts on.
	Active bool
	// Known is false when the backend could not be reached or answered
	// something unrecognisable. An unknown verdict never downgrades a known
	// one — Active carries the last known answer, or FailOpen.
	Known bool
	// Status is the backend's own label ("active", "suspended", "expired", …).
	Status string
	// Message is shown to the operator verbatim.
	Message string
	// CheckedAt is when this verdict was produced.
	CheckedAt time.Time
	// HTTPStatus is the last response code seen (0 on a transport failure).
	HTTPStatus int
	// LastError describes the most recent failure, if any.
	LastError string
	// Enabled mirrors whether the gate is switched on at all.
	Enabled bool

	// Compression is the PACS-side lossy-compression policy for this lab, and
	// CompressionKnown reports whether the backend has ever stated one. They
	// are independent of Active and Known: an inactive lab has a policy too,
	// and a backend that predates the field leaves CompressionKnown false
	// forever, which callers must read as "not managed centrally".
	Compression      bool
	CompressionKnown bool
}

// Checker polls the backend and answers activation questions from cache.
//
// The zero value is not usable; construct one with New.
type Checker struct {
	BackendURL   string
	APIKey       string

	// Failover sends the check to a second backend host when the first does
	// not answer. Nil is fine — it then behaves exactly as before.
	Failover *httpx.Failover
	LabID        string
	OrgID        string
	Hostname     string
	AgentVersion string

	// PollInterval is the background refresh cadence.
	PollInterval time.Duration
	// StaleAfter is how long Allowed reuses a verdict before re-checking.
	StaleAfter time.Duration
	// InactiveHold is how long GateUpload waits before returning ErrInactive.
	InactiveHold time.Duration
	// RecheckInterval is how often GateUpload re-checks while holding.
	RecheckInterval time.Duration
	// FailOpen decides only when no verdict has ever been received.
	FailOpen bool

	// OnCompression is called when the backend's compression policy for this
	// lab is first learned, and again whenever it changes. It runs on the
	// goroutine that performed the check, after the verdict is stored and with
	// no lock held, so it may call back into the Checker. Nil is fine.
	OnCompression func(enabled bool)

	// LossyState reports the lossy-compression mode the sender is actually
	// running, which is sent to the backend with every check as
	// "lossy_compression". That is what lets the PACS show whether a change to
	// the lab's compression switch has taken effect on this workstation — and
	// it is the EFFECTIVE mode, so a machine where gdcmconv cannot run reports
	// false however the policy is set. ok=false, or a nil func, omits the
	// field entirely.
	LossyState func() (enabled, ok bool)

	client *http.Client

	mu            sync.Mutex
	verdict       Verdict
	checks        int
	inflight      chan struct{}
	lastHeartbeat time.Time
	lastBlocked   time.Time
}

// New builds a Checker. An empty backendURL yields a disabled checker: Allowed
// always says yes and no HTTP traffic is generated at all.
func New(backendURL, apiKey, labID, orgID, hostname, agentVersion string) *Checker {
	return &Checker{
		BackendURL:      strings.TrimSpace(backendURL),
		APIKey:          apiKey,
		LabID:           labID,
		OrgID:           orgID,
		Hostname:        hostname,
		AgentVersion:    agentVersion,
		PollInterval:    defaultPollInterval,
		StaleAfter:      defaultStaleAfter,
		InactiveHold:    defaultInactiveHold,
		RecheckInterval: gateRecheckInterval,
		FailOpen:        true,
		client:          httpx.NewClient(requestTimeout),
	}
}

// Enabled reports whether the gate will actually contact a backend.
func (c *Checker) Enabled() bool {
	return c != nil && c.BackendURL != ""
}

// Snapshot returns the current verdict without contacting the backend.
func (c *Checker) Snapshot() Verdict {
	if !c.Enabled() {
		return Verdict{Active: true, Known: true, Status: "disabled", Enabled: false}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	v := c.verdict
	v.Enabled = true
	if !v.Known && v.CheckedAt.IsZero() {
		// Nothing has ever been decided; FailOpen is the standing answer.
		v.Active = c.FailOpen
	}
	return v
}

// Start performs an immediate check, then refreshes on PollInterval until ctx
// is cancelled. It returns immediately; polling runs in its own goroutine.
func (c *Checker) Start(ctx context.Context) {
	if !c.Enabled() {
		// This is the state in which studies transmit unchecked, so say so at
		// a level that survives a log filter.
		log.L().Warn("lab activation gate DISABLED — studies will transmit without an activation check")
		return
	}

	log.L().Info("lab activation gate ENABLED",
		"url", c.BackendURL,
		"poll_seconds", int(c.PollInterval/time.Second),
		"fail_open", c.FailOpen,
		"lab_id", c.LabID,
		"org_id", c.OrgID,
	)

	go func() {
		c.Refresh(ctx, "startup")

		t := time.NewTicker(c.PollInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				c.Refresh(ctx, "poll")
			}
		}
	}()
}

// Allowed answers from cache when the cached verdict is fresh, and re-checks
// when it is stale or absent. It returns the operator-facing message alongside
// the decision so callers can log or display it.
//
// Callers that must see the effect of a just-changed account — the app's
// "Check again" button — have to use Refresh instead: Allowed may legitimately
// answer from a verdict that is only seconds old.
func (c *Checker) Allowed(ctx context.Context, reason string) (bool, string) {
	if !c.Enabled() {
		return true, ""
	}

	c.mu.Lock()
	age := time.Since(c.verdict.CheckedAt)
	never := c.verdict.CheckedAt.IsZero()
	c.mu.Unlock()

	if never || age >= c.StaleAfter {
		v := c.Refresh(ctx, reason)
		return v.Active, v.Message
	}

	v := c.Snapshot()
	return v.Active, v.Message
}

// Refresh forces a check, bypassing the cache, and returns the resulting
// verdict. Concurrent callers collapse onto a single in-flight HTTP request.
func (c *Checker) Refresh(ctx context.Context, reason string) Verdict {
	if !c.Enabled() {
		return c.Snapshot()
	}

	c.mu.Lock()
	if wait := c.inflight; wait != nil {
		c.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
		}
		return c.Snapshot()
	}
	done := make(chan struct{})
	c.inflight = done
	c.mu.Unlock()

	// Root the request at Background, not at the caller's ctx: whoever won the
	// race must not be able to cancel the check that everyone else is now
	// waiting on.
	reqCtx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	fresh := c.check(reqCtx, reason)
	cancel()

	c.mu.Lock()
	before := c.verdict
	c.apply(fresh)
	after := c.verdict
	c.checks++
	c.inflight = nil
	c.mu.Unlock()

	// Tell the owner before releasing the waiters, so anyone who was blocked
	// on this check resumes with the new policy already in force.
	if after.CompressionKnown &&
		(!before.CompressionKnown || before.Compression != after.Compression) {
		log.L().Info("lab compression policy",
			"compression", after.Compression,
			"previous_known", before.CompressionKnown,
			"previous", before.Compression,
			"lab_active", after.Active,
			"reason", reason,
		)
		if c.OnCompression != nil {
			c.OnCompression(after.Compression)
		}
	}
	close(done)

	return c.Snapshot()
}

// apply merges a fresh reading into the stored verdict. Caller holds c.mu.
//
// The merge is where the failure policy lives: an unknown reading updates the
// diagnostics but must never overwrite a known Active/Status/Message.
func (c *Checker) apply(fresh Verdict) {
	prev := c.verdict

	// The compression policy is merged on its own terms, before the
	// activation merge below. A reading that does not state a policy — a
	// transport failure, a 5xx, an older backend — keeps the last one, exactly
	// as an unknown activation reading keeps the last verdict. A reading that
	// does state one is taken even when its activation half is unusable.
	if !fresh.CompressionKnown {
		fresh.Compression = prev.Compression
		fresh.CompressionKnown = prev.CompressionKnown
	}

	if fresh.Known {
		c.verdict = fresh
		c.logVerdict(prev, fresh)
		return
	}

	merged := prev
	merged.Compression = fresh.Compression
	merged.CompressionKnown = fresh.CompressionKnown
	merged.CheckedAt = fresh.CheckedAt
	merged.HTTPStatus = fresh.HTTPStatus
	merged.LastError = fresh.LastError
	if !prev.Known {
		// Never had an answer — FailOpen is the standing decision.
		merged.Active = c.FailOpen
		merged.Status = "unknown"
	}
	c.verdict = merged
	c.logVerdict(prev, merged)
}

// logVerdict reports transitions loudly and steady state quietly, but not so
// quietly that a healthy gate is indistinguishable from one that never ran.
// Caller holds c.mu.
func (c *Checker) logVerdict(prev, now Verdict) {
	changed := prev.CheckedAt.IsZero() ||
		prev.Active != now.Active ||
		prev.Known != now.Known ||
		prev.Status != now.Status

	if changed {
		lg := log.L().Info
		if !now.Active {
			lg = log.L().Warn
		}
		lg("lab activation verdict",
			"active", now.Active,
			"known", now.Known,
			"status", now.Status,
			"http_status", now.HTTPStatus,
			"message", now.Message,
			"err", now.LastError,
			"checks", c.checks+1,
		)
		c.lastHeartbeat = time.Now()
		return
	}

	if time.Since(c.lastHeartbeat) >= heartbeatInterval {
		log.L().Info("lab activation gate heartbeat",
			"active", now.Active,
			"known", now.Known,
			"status", now.Status,
			"checks", c.checks+1,
		)
		c.lastHeartbeat = time.Now()
	}
}

// GateUpload blocks an upload while the lab is inactive, for up to
// InactiveHold, then gives up with ErrInactive.
//
// It does not wait indefinitely on purpose: the queue entry has already been
// popped from the durable store, so a goroutine parked here forever would lose
// it if the process were killed. Returning ErrInactive puts it back.
func (c *Checker) GateUpload(ctx context.Context) error {
	if !c.Enabled() {
		return nil
	}

	if ok, _ := c.Allowed(ctx, "upload"); ok {
		return nil
	}

	deadline := time.Now().Add(c.InactiveHold)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		wait := c.RecheckInterval
		if wait <= 0 {
			wait = gateRecheckInterval
		}
		if remaining < wait {
			wait = remaining
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		if v := c.Refresh(ctx, "upload"); v.Active {
			return nil
		}
	}

	c.mu.Lock()
	msg := c.verdict.Message
	warn := time.Since(c.lastBlocked) >= blockedWarnInterval
	if warn {
		c.lastBlocked = time.Now()
	}
	c.mu.Unlock()

	if warn {
		log.L().Warn("transmission blocked — lab is not active", "message", msg)
	}
	if msg == "" {
		msg = DefaultInactiveMessage
	}
	return fmt.Errorf("%w: %s", ErrInactive, msg)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type request struct {
	LabID        string `json:"lab_id"`
	OrgID        string `json:"org_id"`
	Hostname     string `json:"hostname"`
	AgentVersion string `json:"agent_version"`
	Reason       string `json:"reason"`
	// A pointer so "not reported" is an absent field rather than a false: the
	// backend must be able to tell a sender that is not compressing from one
	// that never said.
	LossyCompression *bool `json:"lossy_compression,omitempty"`
}

// check performs one HTTP round trip and interprets the answer. It never
// returns an error: an unreachable backend is a legitimate "unknown" verdict.
func (c *Checker) check(ctx context.Context, reason string) Verdict {
	req := request{
		LabID:        c.LabID,
		OrgID:        c.OrgID,
		Hostname:     c.Hostname,
		AgentVersion: c.AgentVersion,
		Reason:       reason,
	}
	if c.LossyState != nil {
		if enabled, ok := c.LossyState(); ok {
			req.LossyCompression = &enabled
		}
	}
	body, err := json.Marshal(req)
	if err != nil {
		return interpretResponse(0, nil, err)
	}

	res, err := c.Failover.PostJSON(ctx, c.client, c.BackendURL, body,
		func(req *http.Request) {
			req.Header.Set("Accept", "application/json")
			if c.APIKey != "" {
				req.Header.Set("Authorization", "Bearer "+c.APIKey)
			}
		})
	// Status 0 means NO host answered at all. Any real status — including the
	// 404 this endpoint currently returns — is an answer and must go through
	// interpretResponse unchanged, exactly as the single-host version did.
	if res.Status == 0 {
		return interpretResponse(0, nil, err)
	}
	return interpretResponse(res.Status, res.Body, nil)
}

// ---------------------------------------------------------------------------
// Interpretation — the executable form of the backend contract
// ---------------------------------------------------------------------------

// activeLabels and inactiveLabels are matched case-insensitively against the
// body's "status" field. The aliases exist so an existing controller can be
// reused unchanged; new backends should just return "active".
var activeLabels = map[string]bool{
	"active": true, "enabled": true, "live": true, "ok": true,
	"valid": true, "approved": true, "running": true,
}

var inactiveLabels = map[string]bool{
	"inactive": true, "disabled": true, "suspended": true, "expired": true,
	"blocked": true, "banned": true, "terminated": true, "cancelled": true,
	"canceled": true, "unpaid": true, "overdue": true, "deleted": true,
	"pending": true, "not_found": true, "notfound": true, "unauthorized": true,
}

// deliberateRefusal lists the status codes that mean "I am refusing this lab",
// as opposed to "I could not answer". Anything else non-2xx is unknown.
func deliberateRefusal(code int) bool {
	switch code {
	case http.StatusPaymentRequired, // 402
		http.StatusForbidden,                  // 403
		http.StatusLocked,                     // 423
		http.StatusUnavailableForLegalReasons: // 451
		return true
	}
	return false
}

// interpretResponse maps one HTTP outcome onto a Verdict, applying the rules
// in order — the first that matches decides. It is pure, which is what makes
// the whole backend contract testable without a network.
func interpretResponse(httpStatus int, body []byte, transportErr error) Verdict {
	v := Verdict{CheckedAt: time.Now(), HTTPStatus: httpStatus, Enabled: true}

	// 2. Transport failure, DNS, timeout — unknown, never inactive.
	if transportErr != nil {
		v.LastError = transportErr.Error()
		return v
	}

	parsed := parseBody(body)
	msg := lookupString(parsed, "message")

	// The compression policy is read before the activation ladder and
	// independently of it, so every return below carries it: a refusal, an
	// inactive lab and an active one all state a policy the same way. It is
	// only believed from an answer the backend meant to give — a 2xx or a
	// deliberate refusal — never from the body of a 5xx.
	if (httpStatus >= 200 && httpStatus < 300) || deliberateRefusal(httpStatus) {
		v.Compression, v.CompressionKnown = lookupCompression(parsed)
	}

	// 1. Deliberate refusal.
	if deliberateRefusal(httpStatus) {
		v.Known = true
		v.Active = false
		v.Status = lookupString(parsed, "status")
		if v.Status == "" {
			v.Status = fmt.Sprintf("http_%d", httpStatus)
		}
		v.Message = msg
		if v.Message == "" {
			v.Message = DefaultInactiveMessage
		}
		return v
	}

	// 2. Everything else non-2xx — 5xx, 404, 429, 400, 401 — is unknown. A
	// backend that cannot answer must not be able to block a working lab.
	if httpStatus < 200 || httpStatus >= 300 {
		v.LastError = fmt.Sprintf("backend returned HTTP %d", httpStatus)
		return v
	}

	// 2 (cont). A 200 whose body isn't JSON tells us nothing.
	if parsed == nil {
		v.LastError = "backend returned a non-JSON body"
		return v
	}

	// 3. An explicit boolean wins over everything else.
	for _, key := range []string{"active", "is_active", "lab_active"} {
		if b, ok := lookupBool(parsed, key); ok {
			v.Known = true
			v.Active = b
			v.Status = lookupString(parsed, "status")
			v.Message = messageFor(b, msg, v.Status)
			return v
		}
	}

	// 4. A status label.
	if s := lookupString(parsed, "status"); s != "" {
		key := strings.ToLower(strings.TrimSpace(s))
		if activeLabels[key] {
			v.Known, v.Active, v.Status = true, true, s
			v.Message = messageFor(true, msg, s)
			return v
		}
		if inactiveLabels[key] {
			v.Known, v.Active, v.Status = true, false, s
			v.Message = messageFor(false, msg, s)
			return v
		}
		// An unrecognised label is not a licence to block.
		v.LastError = fmt.Sprintf("unrecognised status %q", s)
		return v
	}

	// 5. Only "success".
	if b, ok := lookupBool(parsed, "success"); ok {
		v.Known = true
		v.Active = b
		v.Message = messageFor(b, msg, "")
		return v
	}

	// 6. A 200 with nothing recognisable in it.
	v.LastError = "backend response contained no activation fields"
	return v
}

// messageFor supplies the operator-facing text: the backend's own message when
// it gave one, a stock line when it blocked without explaining, nothing at all
// when the lab is fine.
func messageFor(active bool, msg, status string) string {
	if msg != "" {
		return msg
	}
	if active {
		return ""
	}
	_ = status
	return DefaultInactiveMessage
}

// compressionKeys are the spellings accepted for the lab's compression policy.
// "compression" is the documented one; the rest exist so a backend can hand
// over its own model field unchanged.
var compressionKeys = []string{
	"compression", "compression_enabled", "enable_compression",
	"enableCompression", "compressionEnabled", "lossy_compression",
}

// lookupCompression reports the policy and whether the body stated one. Only a
// JSON boolean counts: a string or a number is not a policy, and guessing at
// one would switch lossy encoding on from a typo.
func lookupCompression(m map[string]any) (enabled, known bool) {
	for _, key := range compressionKeys {
		if b, ok := lookupBool(m, key); ok {
			return b, true
		}
	}
	return false, false
}

func parseBody(body []byte) map[string]any {
	if len(bytes.TrimSpace(body)) == 0 {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return nil
	}
	return m
}

// dataEnvelope returns the nested "data" object, so {"data":{"active":true}}
// is read the same as {"active":true}.
func dataEnvelope(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	d, ok := m["data"].(map[string]any)
	if !ok {
		return nil
	}
	return d
}

// lookupBool checks the top level first, then the data envelope.
func lookupBool(m map[string]any, key string) (bool, bool) {
	if m == nil {
		return false, false
	}
	if b, ok := m[key].(bool); ok {
		return b, true
	}
	if d := dataEnvelope(m); d != nil {
		if b, ok := d[key].(bool); ok {
			return b, true
		}
	}
	return false, false
}

// lookupString checks the top level first, then the data envelope.
func lookupString(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if s, ok := m[key].(string); ok && s != "" {
		return s
	}
	if d := dataEnvelope(m); d != nil {
		if s, ok := d[key].(string); ok && s != "" {
			return s
		}
	}
	return ""
}
