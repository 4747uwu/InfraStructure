package transcode

import (
	"sync"
	"testing"
)

// TestLiveSwitchesPlanWithoutRestart is the property the PACS compression
// policy depends on: a change made while the sender runs decides the plan for
// the very next series. Before Live, the settings were copied once at startup
// and a change did nothing until the process was restarted.
func TestLiveSwitchesPlanWithoutRestart(t *testing.T) {
	off := Settings{
		LossyEnabled:               false,
		LossyModalityRate:          map[string]int{"CT": 10},
		LossySkipAlreadyCompressed: true,
	}
	on := off
	on.LossyEnabled = true

	live := NewLive(off)
	if live.Active() {
		t.Fatal("Active() with every mode off")
	}
	if p := PlanFor(live.Get(), "CT"); p.Mode != ModeNone {
		t.Fatalf("plan with lossy off = %v, want none", p.Mode)
	}

	if !live.Set(on) {
		t.Fatal("Set did not report the lossy switch changing")
	}
	if !live.Active() {
		t.Fatal("Active() false after lossy was switched on")
	}
	p := PlanFor(live.Get(), "CT")
	if p.Mode != ModeLossy || p.Rate != 10 || !p.SkipAlreadyCompressed {
		t.Fatalf("plan after switching lossy on = %+v, want lossy 10:1 with skip", p)
	}
	// A modality with no ratio is still sent as-is: the switch turns the mode
	// on, the ratios decide what it applies to.
	if p := PlanFor(live.Get(), "MR"); p.Mode != ModeNone {
		t.Fatalf("MR with no ratio configured planned %v, want none", p.Mode)
	}

	// Changing only a ratio is not a switch change, but must still land.
	tuned := on
	tuned.LossyModalityRate = map[string]int{"CT": 10, "MR": 15}
	if live.Set(tuned) {
		t.Fatal("Set reported a switch change for a ratio-only edit")
	}
	if p := PlanFor(live.Get(), "MR"); p.Mode != ModeLossy || p.Rate != 15 {
		t.Fatalf("MR after ratio edit = %+v, want lossy 15:1", p)
	}

	if !live.Set(off) {
		t.Fatal("Set did not report the lossy switch changing back")
	}
	if p := PlanFor(live.Get(), "CT"); p.Mode != ModeNone {
		t.Fatalf("plan after switching lossy off = %v, want none", p.Mode)
	}
}

// TestLiveZeroValueMeansNoCompression: an engine that never configures
// compression must send everything as-is, not panic on a nil map.
func TestLiveZeroValueMeansNoCompression(t *testing.T) {
	var live Live
	if live.Active() {
		t.Fatal("zero Live reports compression active")
	}
	if p := PlanFor(live.Get(), "CT"); p.Mode != ModeNone {
		t.Fatalf("zero Live planned %v", p.Mode)
	}
}

// TestLiveConcurrentUse exercises the exact shape of production use: several
// queue workers planning series while the policy flips underneath them. Every
// plan must be one of the two legal answers — never a torn mix such as lossy
// with rate 0.
func TestLiveConcurrentUse(t *testing.T) {
	off := Settings{LossyModalityRate: map[string]int{"CT": 10}}
	on := Settings{LossyEnabled: true, LossyModalityRate: map[string]int{"CT": 10}}
	live := NewLive(off)

	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 2000; i++ {
			if i%2 == 0 {
				live.Set(on)
			} else {
				live.Set(off)
			}
		}
		close(stop)
	}()

	errs := make(chan string, 8)
	for w := 0; w < 6; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				p := PlanFor(live.Get(), "CT")
				switch {
				case p.Mode == ModeNone && p.Rate == 0:
				case p.Mode == ModeLossy && p.Rate == 10:
				default:
					select {
					case errs <- p.Mode.String():
					default:
					}
					return
				}
				_ = live.Active()
			}
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatalf("a worker saw a torn plan (mode %s)", e)
	}
}
