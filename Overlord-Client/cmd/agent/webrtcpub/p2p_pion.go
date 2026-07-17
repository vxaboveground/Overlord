//go:build overlord_webrtc

package webrtcpub

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"

	"github.com/pion/webrtc/v4"
)

// p2pSession is a direct browser ↔ agent peer connection. SDP and ICE
// candidates are relayed via the Overlord server's existing WS channels —
// MediaMTX is NOT involved on this path.
type p2pSession struct {
	kind      Kind
	id        string
	pc        *webrtc.PeerConnection
	onICE     func(ICECandidate)
	onClose   func()
	closeOnce sync.Once
}

var (
	p2pMu sync.Mutex
	// Keyed by kind|id so the same agent can host concurrent P2P sessions
	// for desktop, webcam, and audio without sessions stomping each other.
	p2pSessions = map[string]*p2pSession{}
)

func p2pSessionKey(kind Kind, sessionID string) string {
	return string(kind) + "|" + sessionID
}

// StartP2POffer accepts an SDP offer from an operator (proxied through the
// server WS), creates a peer connection with the requested tracks, and
// returns the SDP answer. The offer must contain matching m-sections — the
// browser side decides via its transceivers what to ask for. Trickle ICE
// candidates emitted by Pion are delivered to opts.OnICE.
func StartP2POffer(ctx context.Context, kind Kind, sessionID string, offerSDP string, opts P2POfferCallbacks, hasVideo, hasAudio bool) (string, error) {
	ensureFirewallRule()
	_ = ctx
	if sessionID == "" {
		return "", errors.New("webrtcpub: empty sessionID")
	}
	if offerSDP == "" {
		return "", errors.New("webrtcpub: empty offer SDP")
	}
	if !hasVideo && !hasAudio {
		return "", errors.New("webrtcpub: at least one of hasVideo/hasAudio must be true")
	}
	// Replace any previous session for this kind+id (operator restart).
	StopP2P(kind, sessionID)

	mediaEngine := &webrtc.MediaEngine{}
	if hasVideo {
		if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{
				MimeType:    webrtc.MimeTypeH264,
				ClockRate:   90000,
				SDPFmtpLine: h264SDPFmtpLine,
			},
			PayloadType: 102,
		}, webrtc.RTPCodecTypeVideo); err != nil {
			return "", fmt.Errorf("register video codec: %w", err)
		}
	}
	if hasAudio {
		if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{
				MimeType:    webrtc.MimeTypeOpus,
				ClockRate:   48000,
				Channels:    2,
				SDPFmtpLine: "minptime=10;useinbandfec=1",
			},
			PayloadType: 111,
		}, webrtc.RTPCodecTypeAudio); err != nil {
			return "", fmt.Errorf("register audio codec: %w", err)
		}
	}

	api := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine))
	pc, err := api.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	})
	if err != nil {
		return "", fmt.Errorf("new peer connection: %w", err)
	}

	var (
		videoTrack  *webrtc.TrackLocalStaticSample
		audioTrack  *webrtc.TrackLocalStaticSample
		audioWriter AudioWriter
	)
	if hasVideo {
		videoTrack, err = webrtc.NewTrackLocalStaticSample(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264},
			"overlord-video-p2p-"+string(kind), "overlord-"+string(kind),
		)
		if err != nil {
			_ = pc.Close()
			return "", fmt.Errorf("new video track: %w", err)
		}
		tx, err := pc.AddTransceiverFromTrack(videoTrack, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionSendonly,
		})
		if err != nil {
			_ = pc.Close()
			return "", fmt.Errorf("add video transceiver: %w", err)
		}
		if sender := tx.Sender(); sender != nil {
			go drainRTCP(sender)
		}
	}
	if hasAudio {
		audioTrack, err = webrtc.NewTrackLocalStaticSample(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"},
			"overlord-audio-p2p-"+string(kind), "overlord-"+string(kind),
		)
		if err != nil {
			_ = pc.Close()
			return "", fmt.Errorf("new audio track: %w", err)
		}
		audioWriter, err = newOpusAudioWriter(audioTrack)
		if err != nil {
			_ = pc.Close()
			return "", fmt.Errorf("new opus encoder: %w", err)
		}
		tx, err := pc.AddTransceiverFromTrack(audioTrack, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionSendonly,
		})
		if err != nil {
			_ = pc.Close()
			return "", fmt.Errorf("add audio transceiver: %w", err)
		}
		if sender := tx.Sender(); sender != nil {
			go drainRTCP(sender)
		}
	}

	sess := &p2pSession{
		kind:    kind,
		id:      sessionID,
		pc:      pc,
		onICE:   opts.OnICE,
		onClose: opts.OnClose,
	}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if sess.onICE == nil {
			return
		}
		if c == nil {
			sess.onICE(ICECandidate{Candidate: ""})
			return
		}
		init := c.ToJSON()
		mid := ""
		if init.SDPMid != nil {
			mid = *init.SDPMid
		}
		var idx uint16
		if init.SDPMLineIndex != nil {
			idx = *init.SDPMLineIndex
		}
		sess.onICE(ICECandidate{
			Candidate:     init.Candidate,
			SDPMid:        mid,
			SDPMLineIndex: idx,
		})
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("webrtcpub: P2P[%s/%s] peer state=%s", kind, sessionID, state)
		switch state {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed, webrtc.PeerConnectionStateDisconnected:
			sess.closeAndUnregister()
		}
	})

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  offerSDP,
	}); err != nil {
		_ = pc.Close()
		return "", fmt.Errorf("set remote desc: %w", err)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		_ = pc.Close()
		return "", fmt.Errorf("create answer: %w", err)
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		_ = pc.Close()
		return "", fmt.Errorf("set local desc: %w", err)
	}

	key := p2pSessionKey(kind, sessionID)
	p2pMu.Lock()
	p2pSessions[key] = sess
	p2pMu.Unlock()
	writerID := p2pWriterID(kind, sessionID)
	if videoTrack != nil {
		registerVideoWriter(kind, writerID, &h264TrackWriter{t: videoTrack})
	}
	if audioTrack != nil {
		registerAudioWriter(kind, writerID, audioWriter)
	}
	return answer.SDP, nil
}

// AddP2PICECandidate hands a remote ICE candidate to a specific P2P session.
func AddP2PICECandidate(kind Kind, sessionID string, c ICECandidate) {
	if c.Candidate == "" {
		return
	}
	p2pMu.Lock()
	sess := p2pSessions[p2pSessionKey(kind, sessionID)]
	p2pMu.Unlock()
	if sess == nil {
		return
	}
	mid := c.SDPMid
	idx := c.SDPMLineIndex
	if err := sess.pc.AddICECandidate(webrtc.ICECandidateInit{
		Candidate:     c.Candidate,
		SDPMid:        &mid,
		SDPMLineIndex: &idx,
	}); err != nil {
		log.Printf("webrtcpub: add p2p ICE candidate failed: %v", err)
	}
}

// StopP2P tears down a specific P2P session.
func StopP2P(kind Kind, sessionID string) {
	p2pMu.Lock()
	sess := p2pSessions[p2pSessionKey(kind, sessionID)]
	delete(p2pSessions, p2pSessionKey(kind, sessionID))
	p2pMu.Unlock()
	if sess != nil {
		sess.closeAndUnregister()
	}
}

// StopAllP2P tears down every active P2P session. Used on shutdown.
func StopAllP2P() {
	p2pMu.Lock()
	keys := make([]string, 0, len(p2pSessions))
	sessions := make([]*p2pSession, 0, len(p2pSessions))
	for k, s := range p2pSessions {
		keys = append(keys, k)
		sessions = append(sessions, s)
	}
	for _, k := range keys {
		delete(p2pSessions, k)
	}
	p2pMu.Unlock()
	for _, s := range sessions {
		s.closeAndUnregister()
	}
}

func (s *p2pSession) closeAndUnregister() {
	s.closeOnce.Do(func() {
		unregisterWriter(s.kind, p2pWriterID(s.kind, s.id))
		_ = s.pc.Close()
		if s.onClose != nil {
			s.onClose()
		}
	})
	p2pMu.Lock()
	key := p2pSessionKey(s.kind, s.id)
	if p2pSessions[key] == s {
		delete(p2pSessions, key)
	}
	p2pMu.Unlock()
}

func p2pWriterID(kind Kind, sessionID string) string {
	return "p2p:" + string(kind) + ":" + sessionID
}
