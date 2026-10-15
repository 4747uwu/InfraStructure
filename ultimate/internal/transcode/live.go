package transcode

import "sync"

// Live holds the compression Settings currently in force.
//
// Settings used to be copied out of the config once, at startup, and captured
// by the queue worker's closures. That made every later change inert until the
// sender was restarted: the Settings page saved "compression on", the config
// file said on, and series kept leaving uncompressed. It also left no way for
// the PACS-side compression policy to take effect on a running workstation.
//
// The worker now asks Live for the settings per series, so a change applies to
// the next series that becomes stable. A series already past that point keeps
// the route it was given: one queued for direct transfer is not pulled back to
// be transcoded, and one queued for transcoding that finds compression has
// since been switched off simply plans to ModeNone and is sent as-is.
//
// The zero value is usable and means "no compression".
type Live struct {
	mu sync.RWMutex
	s  Settings
}

// NewLive returns a Live seeded with s.
func NewLive(s Settings) *Live {
	return &Live{s: s}
}

// Get returns the settings in force. The maps inside are shared, not copied;
// callers must treat them as read-only, which PlanFor does.
func (l *Live) Get() Settings {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.s
}

// Set replaces the settings in force and reports whether either mode's
// enabled flag changed, which is the part worth logging.
func (l *Live) Set(s Settings) (changed bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	changed = l.s.LossyEnabled != s.LossyEnabled || l.s.LosslessEnabled != s.LosslessEnabled
	l.s = s
	return changed
}

// Active reports whether any mode could apply, which is what decides between
// the transcode queue and the direct transfer queue.
func (l *Live) Active() bool {
	s := l.Get()
	return s.LossyEnabled || s.LosslessEnabled
}
