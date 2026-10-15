package labstatus

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// testTimeout bounds the tests that would otherwise hang on a deadlock.
func testTimeout() <-chan time.Time { return time.After(5 * time.Second) }

// TestCompressionPolicyMatrix pins how the lab's compression policy is read
// off the activation answer. The rule the table exists to protect: the policy
// is read for ACTIVE AND INACTIVE labs alike, and only ever from a body that
// actually states one.
func TestCompressionPolicyMatrix(t *testing.T) {
	cases := []struct {
		name       string
		httpStatus int
		body       string
		transport  error
		wantKnown  bool // CompressionKnown
		wantOn     bool // Compression, only asserted when wantKnown
		wantActive bool // the activation half must be unaffected
		wantVerd   bool // Known
	}{
		// ---- the documented shape, both lab states, both policies ------
		{name: "active lab, compression on", httpStatus: 200,
			body:      `{"success":true,"active":true,"status":"active","compression":true}`,
			wantKnown: true, wantOn: true, wantActive: true, wantVerd: true},
		{name: "active lab, compression off", httpStatus: 200,
			body:      `{"success":true,"active":true,"status":"active","compression":false}`,
			wantKnown: true, wantOn: false, wantActive: true, wantVerd: true},
		{name: "inactive lab, compression on", httpStatus: 200,
			body:      `{"success":true,"active":false,"status":"inactive","compression":true}`,
			wantKnown: true, wantOn: true, wantActive: false, wantVerd: true},
		{name: "inactive lab, compression off", httpStatus: 200,
			body:      `{"success":true,"active":false,"status":"inactive","compression":false}`,
			wantKnown: true, wantOn: false, wantActive: false, wantVerd: true},
		{name: "suspended lab still states a policy", httpStatus: 200,
			body:      `{"success":true,"active":false,"status":"suspended","message":"x","compression":true}`,
			wantKnown: true, wantOn: true, wantActive: false, wantVerd: true},
		{name: "expired lab still states a policy", httpStatus: 200,
			body:      `{"success":true,"active":false,"status":"expired","compression":true}`,
			wantKnown: true, wantOn: true, wantActive: false, wantVerd: true},

		// ---- a refusal is an answer, so its policy counts --------------
		{name: "403 refusal carrying a policy", httpStatus: 403,
			body:      `{"active":false,"status":"unauthorized","compression":true}`,
			wantKnown: true, wantOn: true, wantActive: false, wantVerd: true},

		// ---- no policy stated: unknown, never "off" --------------------
		{name: "older backend, no field", httpStatus: 200,
			body:      `{"success":true,"active":true,"status":"active"}`,
			wantKnown: false, wantActive: true, wantVerd: true},
		{name: "unregistered workstation states no policy", httpStatus: 200,
			body:      `{"success":true,"active":false,"status":"not_found"}`,
			wantKnown: false, wantActive: false, wantVerd: true},
		{name: "500 with a policy in the body is not believed", httpStatus: 500,
			body:      `{"compression":true}`,
			wantKnown: false, wantVerd: false},
		{name: "404 is not believed", httpStatus: 404,
			body:      `{"compression":true}`,
			wantKnown: false, wantVerd: false},
		{name: "transport failure", httpStatus: 0,
			transport: errors.New("dial tcp: no such host"),
			wantKnown: false, wantVerd: false},
		{name: "200 with HTML", httpStatus: 200,
			body:      `<html>captive portal</html>`,
			wantKnown: false, wantVerd: false},

		// ---- only a JSON boolean is a policy ---------------------------
		{name: "string true is not a policy", httpStatus: 200,
			body:      `{"active":true,"compression":"true"}`,
			wantKnown: false, wantActive: true, wantVerd: true},
		{name: "number is not a policy", httpStatus: 200,
			body:      `{"active":true,"compression":1}`,
			wantKnown: false, wantActive: true, wantVerd: true},
		{name: "null is not a policy", httpStatus: 200,
			body:      `{"active":true,"compression":null}`,
			wantKnown: false, wantActive: true, wantVerd: true},

		// ---- accepted spellings and the data envelope ------------------
		{name: "model field name", httpStatus: 200,
			body:      `{"active":true,"enableCompression":true}`,
			wantKnown: true, wantOn: true, wantActive: true, wantVerd: true},
		{name: "snake case alias", httpStatus: 200,
			body:      `{"active":true,"compression_enabled":true}`,
			wantKnown: true, wantOn: true, wantActive: true, wantVerd: true},
		{name: "inside the data envelope", httpStatus: 200,
			body:      `{"success":true,"data":{"active":true,"compression":true}}`,
			wantKnown: true, wantOn: true, wantActive: true, wantVerd: true},

		// ---- a policy with no usable activation half -------------------
		{name: "policy alone does not decide activation", httpStatus: 200,
			body:      `{"compression":true}`,
			wantKnown: true, wantOn: true, wantVerd: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := interpretResponse(tc.httpStatus, []byte(tc.body), tc.transport)
			if v.CompressionKnown != tc.wantKnown {
				t.Fatalf("CompressionKnown = %v, want %v (verdict %+v)", v.CompressionKnown, tc.wantKnown, v)
			}
			if tc.wantKnown && v.Compression != tc.wantOn {
				t.Fatalf("Compression = %v, want %v", v.Compression, tc.wantOn)
			}
			if !tc.wantKnown && v.Compression {
				t.Fatal("Compression is true on a reading that stated no policy")
			}
			if v.Known != tc.wantVerd {
				t.Fatalf("Known = %v, want %v — reading the policy changed the activation verdict", v.Known, tc.wantVerd)
			}
			if tc.wantVerd && v.Active != tc.wantActive {
				t.Fatalf("Active = %v, want %v — reading the policy changed the activation verdict", v.Active, tc.wantActive)
			}
		})
	}
}

// policyBackend is a stub lab-status endpoint whose answer can be swapped
// between checks.
type policyBackend struct {
	reply atomic.Value // func(http.ResponseWriter)
	srv   *httptest.Server
}

func newPolicyBackend(t *testing.T) *policyBackend {
	t.Helper()
	b := &policyBackend{}
	b.json(`{"success":true,"active":true,"status":"active"}`)
	b.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b.reply.Load().(func(http.ResponseWriter))(w)
	}))
	t.Cleanup(b.srv.Close)
	return b
}

func (b *policyBackend) json(body string) {
	b.reply.Store(func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, body)
	})
}

func (b *policyBackend) status(code int) {
	b.reply.Store(func(w http.ResponseWriter) { w.WriteHeader(code) })
}

// recorder collects OnCompression calls.
type recorder struct {
	mu    sync.Mutex
	calls []bool
}

func (r *recorder) hook(enabled bool) {
	r.mu.Lock()
	r.calls = append(r.calls, enabled)
	r.mu.Unlock()
}

func (r *recorder) got() []bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]bool(nil), r.calls...)
}

func sameCalls(a, b []bool) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestOnCompressionFiresOnLearnAndChange is the contract main.go relies on:
// told once when the policy is first learned (even if it is "off", because the
// local setting may be on), told again on every flip, and not told at all on
// the fifty-nine polls an hour where nothing changed.
func TestOnCompressionFiresOnLearnAndChange(t *testing.T) {
	b := newPolicyBackend(t)
	c := newTestChecker(b.srv.URL)
	var rec recorder
	c.OnCompression = rec.hook
	ctx := context.Background()

	// An older backend that says nothing about compression: no call at all.
	c.Refresh(ctx, "startup")
	if got := rec.got(); len(got) != 0 {
		t.Fatalf("hook fired %v with no policy stated", got)
	}
	if v := c.Snapshot(); v.CompressionKnown {
		t.Fatalf("policy reported as known with none stated: %+v", v)
	}

	// First statement of a policy — "off" is still news.
	b.json(`{"success":true,"active":true,"status":"active","compression":false}`)
	c.Refresh(ctx, "poll")
	if got := rec.got(); !sameCalls(got, []bool{false}) {
		t.Fatalf("after first policy: hook calls = %v, want [false]", got)
	}

	// Unchanged polls are silent.
	c.Refresh(ctx, "poll")
	c.Refresh(ctx, "poll")
	if got := rec.got(); !sameCalls(got, []bool{false}) {
		t.Fatalf("unchanged polls fired the hook: %v", got)
	}

	// Switched on in the PACS.
	b.json(`{"success":true,"active":true,"status":"active","compression":true}`)
	v := c.Refresh(ctx, "poll")
	if !v.CompressionKnown || !v.Compression {
		t.Fatalf("verdict after enable = %+v", v)
	}
	if got := rec.got(); !sameCalls(got, []bool{false, true}) {
		t.Fatalf("after enable: hook calls = %v, want [false true]", got)
	}

	// And off again.
	b.json(`{"success":true,"active":true,"status":"active","compression":false}`)
	c.Refresh(ctx, "poll")
	if got := rec.got(); !sameCalls(got, []bool{false, true, false}) {
		t.Fatalf("after disable: hook calls = %v, want [false true false]", got)
	}
}

// TestCompressionPolicyAppliesToInactiveLab is the "active and inactive labs"
// half of the feature. A lab switched off in the PACS keeps receiving and
// storing studies; whatever compression policy it has must be in force before
// it is reactivated, or the backlog leaves in the wrong encoding.
func TestCompressionPolicyAppliesToInactiveLab(t *testing.T) {
	b := newPolicyBackend(t)
	c := newTestChecker(b.srv.URL)
	var rec recorder
	c.OnCompression = rec.hook
	ctx := context.Background()

	b.json(`{"success":true,"active":false,"status":"inactive","message":"Account inactive.","compression":true}`)
	v := c.Refresh(ctx, "startup")

	if v.Active {
		t.Fatal("an inactive lab was reported active")
	}
	if !v.CompressionKnown || !v.Compression {
		t.Fatalf("inactive lab's policy was not read: %+v", v)
	}
	if got := rec.got(); !sameCalls(got, []bool{true}) {
		t.Fatalf("hook calls for an inactive lab = %v, want [true]", got)
	}
	// The gate must still hold: reading the policy grants nothing.
	if ok, _ := c.Allowed(ctx, "upload"); ok {
		t.Fatal("reading the compression policy let an inactive lab transmit")
	}

	// Policy flips while the lab is still inactive.
	b.json(`{"success":true,"active":false,"status":"suspended","compression":false}`)
	c.Refresh(ctx, "poll")
	if got := rec.got(); !sameCalls(got, []bool{true, false}) {
		t.Fatalf("policy change on an inactive lab: hook calls = %v, want [true false]", got)
	}

	// Reactivated with compression on: one more call, and the gate opens.
	b.json(`{"success":true,"active":true,"status":"active","compression":true}`)
	v = c.Refresh(ctx, "poll")
	if !v.Active || !v.Compression {
		t.Fatalf("after reactivation: %+v", v)
	}
	if got := rec.got(); !sameCalls(got, []bool{true, false, true}) {
		t.Fatalf("after reactivation: hook calls = %v, want [true false true]", got)
	}
}

// TestCompressionPolicySurvivesOutage mirrors TestKnownVerdictSurvivesOutage.
// A backend that falls over, a 404, or a rollback to a build without the field
// must not read as "compression off" — that would silently stop compressing at
// a site that pays for bandwidth by the megabyte.
func TestCompressionPolicySurvivesOutage(t *testing.T) {
	b := newPolicyBackend(t)
	c := newTestChecker(b.srv.URL)
	var rec recorder
	c.OnCompression = rec.hook
	ctx := context.Background()

	b.json(`{"success":true,"active":true,"status":"active","compression":true}`)
	c.Refresh(ctx, "startup")

	for _, outage := range []struct {
		name string
		set  func()
	}{
		{"500", func() { b.status(http.StatusInternalServerError) }},
		{"502", func() { b.status(http.StatusBadGateway) }},
		{"404", func() { b.status(http.StatusNotFound) }},
		{"non-JSON 200", func() {
			b.reply.Store(func(w http.ResponseWriter) { fmt.Fprint(w, "<html>proxy error</html>") })
		}},
		{"backend without the field", func() {
			b.json(`{"success":true,"active":true,"status":"active"}`)
		}},
		{"unregistered answer", func() {
			b.json(`{"success":true,"active":false,"status":"not_found"}`)
		}},
	} {
		outage.set()
		v := c.Refresh(ctx, "poll")
		if !v.CompressionKnown || !v.Compression {
			t.Fatalf("%s dropped the compression policy: %+v", outage.name, v)
		}
	}

	if got := rec.got(); !sameCalls(got, []bool{true}) {
		t.Fatalf("outages fired the hook: %v, want just [true]", got)
	}

	// Dead backend, nothing listening at all.
	b.srv.Close()
	if v := c.Refresh(ctx, "poll"); !v.CompressionKnown || !v.Compression {
		t.Fatalf("a dead backend dropped the compression policy: %+v", v)
	}
}

// TestOnCompressionMayCallBack guards the "no lock held" promise. main.go's
// hook reads the checker's Snapshot via the API server; if the hook ran under
// c.mu that would deadlock the gate — and with it every upload.
func TestOnCompressionMayCallBack(t *testing.T) {
	b := newPolicyBackend(t)
	b.json(`{"success":true,"active":true,"compression":true}`)
	c := newTestChecker(b.srv.URL)

	var seen Verdict
	c.OnCompression = func(bool) { seen = c.Snapshot() }

	done := make(chan struct{})
	go func() {
		c.Refresh(context.Background(), "startup")
		close(done)
	}()
	select {
	case <-done:
	case <-testTimeout():
		t.Fatal("Refresh deadlocked when the hook called back into the checker")
	}
	if !seen.CompressionKnown || !seen.Compression {
		t.Fatalf("hook ran before the verdict was stored: %+v", seen)
	}
}

// TestDisabledCheckerStatesNoPolicy: with the gate switched off there is no
// backend conversation, so nothing manages compression and the local setting
// stands.
func TestDisabledCheckerStatesNoPolicy(t *testing.T) {
	c := newTestChecker("")
	var rec recorder
	c.OnCompression = rec.hook

	v := c.Refresh(context.Background(), "startup")
	if v.CompressionKnown {
		t.Fatalf("disabled checker reported a compression policy: %+v", v)
	}
	if got := rec.got(); len(got) != 0 {
		t.Fatalf("disabled checker fired the hook: %v", got)
	}
}

// TestRequestReportsLossyState pins the half of the conversation that flows
// the other way: the sender tells the backend which mode it is really in, so
// the PACS can show whether a change to the lab's switch has taken effect.
// "Not reported" must be an absent field, not a false — an older sender and a
// sender that is not compressing are different facts.
func TestRequestReportsLossyState(t *testing.T) {
	got := make(chan map[string]any, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = decodeJSON(r, &body)
		got <- body
		fmt.Fprint(w, `{"success":true,"active":true,"compression":true}`)
	}))
	defer srv.Close()
	ctx := context.Background()

	// No reporter wired: the field is absent.
	c := newTestChecker(srv.URL)
	c.Refresh(ctx, "poll")
	if body := <-got; hasKey(body, "lossy_compression") {
		t.Fatalf("lossy_compression sent with no reporter: %v", body["lossy_compression"])
	}

	// A reporter that declines (ok=false) also omits it.
	c.LossyState = func() (bool, bool) { return true, false }
	c.Refresh(ctx, "poll")
	if body := <-got; hasKey(body, "lossy_compression") {
		t.Fatalf("lossy_compression sent although the reporter declined: %v", body["lossy_compression"])
	}

	// Reporting false is a real false, not an omission.
	lossy := false
	c.LossyState = func() (bool, bool) { return lossy, true }
	c.Refresh(ctx, "poll")
	if body := <-got; body["lossy_compression"] != false {
		t.Fatalf("lossy_compression = %v, want an explicit false", body["lossy_compression"])
	}

	// And it follows the live state from one poll to the next.
	lossy = true
	c.Refresh(ctx, "poll")
	if body := <-got; body["lossy_compression"] != true {
		t.Fatalf("lossy_compression = %v, want true", body["lossy_compression"])
	}
}

func hasKey(m map[string]any, key string) bool {
	_, ok := m[key]
	return ok
}
