package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bharatpacs/tarang-sender/internal/config"
	"github.com/bharatpacs/tarang-sender/internal/labstatus"
	"github.com/bharatpacs/tarang-sender/internal/log"
	"github.com/bharatpacs/tarang-sender/internal/store"
)

// compressionRig is an API server wired the way main.go wires it: a real
// config on disk, a real lab-status checker pointed at a stub backend, and the
// OnCompression -> ApplyCompressionPolicy -> OnConfigApplied chain intact.
type compressionRig struct {
	t       *testing.T
	srv     *Server
	cfg     *config.Config
	cfgPath string
	checker *labstatus.Checker
	backend atomic.Value // string: the JSON the stub PACS answers with
	base    string

	mu      sync.Mutex
	applied []config.Config // every config handed to OnConfigApplied
}

const rigToken = "rig-token"

func newCompressionRig(t *testing.T, lossyAtStart bool) *compressionRig {
	t.Helper()
	_ = log.Init(t.TempDir(), "error")
	t.Cleanup(log.Close)

	st, err := store.Open(filepath.Join(t.TempDir(), "rig.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	r := &compressionRig{t: t}
	r.backend.Store(`{"success":true,"active":true,"status":"active"}`)
	pacs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, r.backend.Load().(string))
	}))
	t.Cleanup(pacs.Close)

	cfg := config.Default()
	cfg.LabID, cfg.OrgID = "LAB1", "ORG"
	cfg.Peer.Name, cfg.Peer.URL = "GANESHAM", "http://127.0.0.1:1"
	cfg.HTTP.APIToken = rigToken
	cfg.Storage.DataDir = t.TempDir()
	cfg.LabStatus.BackendURL = pacs.URL
	cfg.Compression.Enabled = lossyAtStart
	if err := cfg.Validate(); err != nil {
		t.Fatalf("rig config invalid: %v", err)
	}
	r.cfg = &cfg
	r.cfgPath = filepath.Join(t.TempDir(), "config.json")
	if err := cfg.Save(r.cfgPath); err != nil {
		t.Fatalf("save rig config: %v", err)
	}

	r.checker = labstatus.New(pacs.URL, "", cfg.LabID, cfg.OrgID, "TEST-PC", "test")
	r.checker.StaleAfter = time.Millisecond

	r.srv = &Server{
		Addr:       "127.0.0.1:0",
		APIToken:   rigToken,
		Store:      st,
		DataDir:    cfg.Storage.DataDir,
		Version:    "test",
		LabID:      cfg.LabID,
		OrgID:      cfg.OrgID,
		ConfigPath: r.cfgPath,
		Config:     r.cfg,
		LabChecker: r.checker,
		OnConfigApplied: func(c config.Config) {
			r.mu.Lock()
			r.applied = append(r.applied, c)
			r.mu.Unlock()
		},
	}
	r.checker.OnCompression = func(enabled bool) {
		if _, err := r.srv.ApplyCompressionPolicy(enabled); err != nil {
			t.Errorf("ApplyCompressionPolicy(%v): %v", enabled, err)
		}
	}

	if err := r.srv.Start(context.Background()); err != nil {
		t.Fatalf("start api: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = r.srv.Stop(ctx)
	})
	r.base = "http://" + r.srv.listener.Addr().String()
	return r
}

// pacsSays swaps the stub backend's answer and runs one activation check,
// exactly what the 60-second poll does.
func (r *compressionRig) pacsSays(body string) labstatus.Verdict {
	r.backend.Store(body)
	return r.checker.Refresh(context.Background(), "poll")
}

func (r *compressionRig) appliedCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.applied)
}

func (r *compressionRig) lastApplied() config.Config {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.applied) == 0 {
		r.t.Fatal("OnConfigApplied was never called")
	}
	return r.applied[len(r.applied)-1]
}

// onDisk re-reads the config file the way the engine does at startup.
func (r *compressionRig) onDisk() config.Config {
	r.t.Helper()
	c, err := config.Load(r.cfgPath)
	if err != nil {
		r.t.Fatalf("reload config from disk: %v", err)
	}
	return c
}

func (r *compressionRig) call(method, path string, body any) map[string]any {
	r.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, r.base+path, rd)
	req.Header.Set("Authorization", "Bearer "+rigToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		r.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		r.t.Fatalf("%s %s: HTTP %d: %s", method, path, res.StatusCode, raw)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		r.t.Fatalf("%s %s: bad JSON: %v", method, path, err)
	}
	return out
}

// TestPACSPolicyTurnsLossyOn is the feature end to end inside the engine:
// PACS says "compression on" for the lab -> lossy is on in memory, on disk,
// handed to the transcoder, and visible to the UI.
func TestPACSPolicyTurnsLossyOn(t *testing.T) {
	r := newCompressionRig(t, false)

	// Before the PACS has said anything, nothing is managed.
	st := r.call(http.MethodGet, "/api/status", nil)
	if st["compression_managed"] != false || st["lossy_compression"] != false {
		t.Fatalf("fresh engine: managed=%v lossy=%v, want false/false",
			st["compression_managed"], st["lossy_compression"])
	}

	r.pacsSays(`{"success":true,"active":true,"status":"active","compression":true}`)

	if !r.cfg.Compression.Enabled {
		t.Fatal("PACS policy ON did not enable lossy compression in the running config")
	}
	if !r.onDisk().Compression.Enabled {
		t.Fatal("PACS policy ON was not persisted — a restart would lose it")
	}
	if got := r.lastApplied(); !got.Compression.Enabled {
		t.Fatal("the transcoder hook was not handed the enabled config")
	}

	st = r.call(http.MethodGet, "/api/status", nil)
	if st["compression_managed"] != true || st["compression_policy"] != true || st["lossy_compression"] != true {
		t.Fatalf("/api/status after policy ON: managed=%v policy=%v lossy=%v",
			st["compression_managed"], st["compression_policy"], st["lossy_compression"])
	}
	ls := r.call(http.MethodGet, "/api/lab-status", nil)
	if ls["compression_managed"] != true || ls["compression_policy"] != true {
		t.Fatalf("/api/lab-status after policy ON: %v", ls)
	}

	// The operator's own tuning must be untouched: only the switch moved.
	disk := r.onDisk()
	if disk.Compression.ModalityRate["CT"] != 10 || !disk.Compression.SkipAlreadyCompressed {
		t.Fatalf("policy rewrote more than the switch: %+v", disk.Compression)
	}
	if disk.Compression.Lossless.Enabled {
		t.Fatal("policy enabled the lossless mode, which it does not govern")
	}
}

// TestPACSPolicyTurnsLossyOff: the switch works in both directions, including
// over a workstation where someone had turned lossy on locally.
func TestPACSPolicyTurnsLossyOff(t *testing.T) {
	r := newCompressionRig(t, true)

	r.pacsSays(`{"success":true,"active":true,"status":"active","compression":false}`)

	if r.cfg.Compression.Enabled {
		t.Fatal("PACS policy OFF left lossy compression enabled")
	}
	if r.onDisk().Compression.Enabled {
		t.Fatal("PACS policy OFF was not persisted")
	}
	if got := r.lastApplied(); got.Compression.Enabled {
		t.Fatal("the transcoder hook still sees lossy enabled")
	}
}

// TestPACSPolicyAppliesWhileLabInactive: an inactive lab is held, not ignored.
// Its policy has to be in place before it is switched back on.
func TestPACSPolicyAppliesWhileLabInactive(t *testing.T) {
	r := newCompressionRig(t, false)

	v := r.pacsSays(`{"success":true,"active":false,"status":"inactive","message":"Account inactive.","compression":true}`)
	if v.Active {
		t.Fatal("stub said inactive but the verdict is active")
	}
	if !r.cfg.Compression.Enabled || !r.onDisk().Compression.Enabled {
		t.Fatal("compression policy was not applied for an inactive lab")
	}

	st := r.call(http.MethodGet, "/api/status", nil)
	if st["lab_active"] != false || st["lossy_compression"] != true {
		t.Fatalf("inactive lab: lab_active=%v lossy=%v, want false/true", st["lab_active"], st["lossy_compression"])
	}
}

// TestSettingsSaveCannotOverridePolicy: the Settings page sends the whole
// compression block on every save, including its own copy of the switch. Once
// the PACS manages the lab, that copy must lose — while the ratios in the same
// PATCH are still honoured.
func TestSettingsSaveCannotOverridePolicy(t *testing.T) {
	r := newCompressionRig(t, false)
	r.pacsSays(`{"success":true,"active":true,"status":"active","compression":true}`)

	out := r.call(http.MethodPatch, "/api/config", map[string]any{
		"compression": map[string]any{
			"enabled":       false, // the operator unticked it
			"default_rate":  12,
			"modality_rate": map[string]any{"CT": 8, "MR": 15},
		},
	})
	comp := out["compression"].(map[string]any)
	if comp["enabled"] != true {
		t.Fatal("a Settings save switched off compression that the PACS manages")
	}
	if !r.cfg.Compression.Enabled || !r.onDisk().Compression.Enabled {
		t.Fatal("PACS-managed switch was overridden in memory or on disk")
	}
	disk := r.onDisk()
	if disk.Compression.DefaultRate != 12 || disk.Compression.ModalityRate["CT"] != 8 || disk.Compression.ModalityRate["MR"] != 15 {
		t.Fatalf("the operator's ratios were dropped: %+v", disk.Compression)
	}
	if got := r.lastApplied(); got.Compression.ModalityRate["MR"] != 15 || !got.Compression.Enabled {
		t.Fatalf("transcoder hook did not get the saved ratios with the policy switch: %+v", got.Compression)
	}

	// The mirror image: PACS says off, operator ticks it on.
	r.pacsSays(`{"success":true,"active":true,"status":"active","compression":false}`)
	out = r.call(http.MethodPatch, "/api/config", map[string]any{
		"compression": map[string]any{"enabled": true},
	})
	if out["compression"].(map[string]any)["enabled"] != false {
		t.Fatal("a Settings save switched on compression that the PACS has off")
	}
}

// TestSettingsSaveStillWorksWhenUnmanaged: against a backend that does not
// send the field, nothing is managed and the local switch behaves as it always
// did — and now takes effect without a restart.
func TestSettingsSaveStillWorksWhenUnmanaged(t *testing.T) {
	r := newCompressionRig(t, false)
	r.pacsSays(`{"success":true,"active":true,"status":"active"}`) // no compression field

	if r.appliedCount() != 0 {
		t.Fatal("a policy-less answer triggered a config change")
	}

	r.call(http.MethodPatch, "/api/config", map[string]any{
		"compression": map[string]any{"enabled": true},
	})
	if !r.cfg.Compression.Enabled || !r.onDisk().Compression.Enabled {
		t.Fatal("local switch did not take effect on an unmanaged workstation")
	}
	if got := r.lastApplied(); !got.Compression.Enabled {
		t.Fatal("a Settings save was not handed to the transcoder — it would need a restart to apply")
	}
	st := r.call(http.MethodGet, "/api/status", nil)
	if st["compression_managed"] != false || st["lossy_compression"] != true {
		t.Fatalf("unmanaged status: managed=%v lossy=%v", st["compression_managed"], st["lossy_compression"])
	}
}

// TestPolicySurvivesBackendOutage: once learned, an outage must not undo it.
func TestPolicySurvivesBackendOutage(t *testing.T) {
	r := newCompressionRig(t, false)
	r.pacsSays(`{"success":true,"active":true,"status":"active","compression":true}`)
	before := r.appliedCount()

	r.pacsSays(`not json at all`)
	r.pacsSays(`{"success":true,"active":true,"status":"active"}`)

	if !r.cfg.Compression.Enabled || !r.onDisk().Compression.Enabled {
		t.Fatal("an unusable backend answer switched compression off")
	}
	if r.appliedCount() != before {
		t.Fatal("unusable answers caused config churn")
	}
	st := r.call(http.MethodGet, "/api/status", nil)
	if st["compression_managed"] != true || st["compression_policy"] != true {
		t.Fatalf("policy forgotten during an outage: %v / %v", st["compression_managed"], st["compression_policy"])
	}
}

// TestApplyCompressionPolicyIsIdempotent: the poll runs every minute; applying
// the policy already in force must not rewrite the config file each time.
func TestApplyCompressionPolicyIsIdempotent(t *testing.T) {
	r := newCompressionRig(t, false)

	changed, err := r.srv.ApplyCompressionPolicy(true)
	if err != nil || !changed {
		t.Fatalf("first apply: changed=%v err=%v, want true/nil", changed, err)
	}
	changed, err = r.srv.ApplyCompressionPolicy(true)
	if err != nil || changed {
		t.Fatalf("repeat apply: changed=%v err=%v, want false/nil", changed, err)
	}
	if r.appliedCount() != 1 {
		t.Fatalf("OnConfigApplied called %d times, want 1", r.appliedCount())
	}
}
