package webrtcpub

import (
	"sync"
	"sync/atomic"
	"time"
)

type FrameWriter interface {
	WriteH264(nalu []byte, dur time.Duration) error
}

var (
	writersMu sync.RWMutex
	writers   = map[string]FrameWriter{}
)

func registerWriter(id string, w FrameWriter) {
	if id == "" || w == nil {
		return
	}
	writersMu.Lock()
	writers[id] = w
	writersMu.Unlock()
}

func unregisterWriter(id string) {
	if id == "" {
		return
	}
	writersMu.Lock()
	delete(writers, id)
	writersMu.Unlock()
}

func IsActive() bool {
	writersMu.RLock()
	defer writersMu.RUnlock()
	return len(writers) > 0
}

var keyframeWanted atomic.Bool

func RequestKeyframe() {
	keyframeWanted.Store(true)
}

func ConsumeKeyframeRequest() bool {
	return keyframeWanted.Swap(false)
}

func WriteH264(nalu []byte, dur time.Duration) error {
	if len(nalu) == 0 {
		return nil
	}
	writersMu.RLock()
	defer writersMu.RUnlock()
	for _, w := range writers {
		_ = w.WriteH264(nalu, dur)
	}
	return nil
}

// Deadass fuck WebRTC bro ts is so confusing
type Options struct {
	// (e.g. https://server:5173/api/webrtc/agents/abc/whip).
	WhipURL string
	// PublishToken is the bearer token issued by the server.
	PublishToken string
	// TLSInsecureSkipVerify mirrors the agent's existing TLS config.
	TLSInsecureSkipVerify bool
	// TLSCAPath is an optional custom CA bundle.
	TLSCAPath string
}

type ICECandidate struct {
	Candidate     string `msgpack:"candidate"`
	SDPMid        string `msgpack:"sdpMid"`
	SDPMLineIndex uint16 `msgpack:"sdpMLineIndex"`
}

type P2POfferCallbacks struct {
	OnICE   func(c ICECandidate)
	OnClose func()
}
