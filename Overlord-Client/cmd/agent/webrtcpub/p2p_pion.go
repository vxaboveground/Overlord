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

type p2pSession struct {
	id        string
	pc        *webrtc.PeerConnection
	track     *webrtc.TrackLocalStaticSample
	onICE     func(ICECandidate)
	onClose   func()
	closeOnce sync.Once
}

var (
	p2pMu sync.Mutex
	p2p   *p2pSession
)

func StartP2POffer(ctx context.Context, sessionID, offerSDP string, opts P2POfferCallbacks) (string, error) {
	if sessionID == "" {
		return "", errors.New("webrtcpub: empty sessionID")
	}
	if offerSDP == "" {
		return "", errors.New("webrtcpub: empty offer SDP")
	}
	StopP2P()

	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeH264,
			ClockRate:   90000,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
		},
		PayloadType: 102,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return "", fmt.Errorf("register codec: %w", err)
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

	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264},
		"overlord-video-p2p", "overlord-desktop",
	)
	if err != nil {
		_ = pc.Close()
		return "", fmt.Errorf("new track: %w", err)
	}
	transceiver, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendonly,
	})
	if err != nil {
		_ = pc.Close()
		return "", fmt.Errorf("add transceiver: %w", err)
	}
	if sender := transceiver.Sender(); sender != nil {
		go drainRTCP(sender)
	}

	sess := &p2pSession{
		id:      sessionID,
		pc:      pc,
		track:   track,
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
		log.Printf("webrtcpub: P2P peer state=%s", state)
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

	p2pMu.Lock()
	p2p = sess
	p2pMu.Unlock()
	registerWriter(p2pWriterID(sessionID), &trackWriter{t: track})
	return answer.SDP, nil
}

func AddP2PICECandidate(sessionID string, c ICECandidate) {
	if c.Candidate == "" {
		return
	}
	p2pMu.Lock()
	sess := p2p
	p2pMu.Unlock()
	if sess == nil || sess.id != sessionID {
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

// StopP2P tears down the active P2P session, if any.
func StopP2P() {
	p2pMu.Lock()
	sess := p2p
	p2p = nil
	p2pMu.Unlock()
	if sess != nil {
		sess.closeAndUnregister()
	}
}

func (s *p2pSession) closeAndUnregister() {
	s.closeOnce.Do(func() {
		unregisterWriter(p2pWriterID(s.id))
		_ = s.pc.Close()
		if s.onClose != nil {
			s.onClose()
		}
	})
	p2pMu.Lock()
	if p2p == s {
		p2p = nil
	}
	p2pMu.Unlock()
}

func p2pWriterID(sessionID string) string {
	return "p2p:" + sessionID
}
