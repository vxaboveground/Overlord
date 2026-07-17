//go:build overlord_webrtc

package webrtcpub

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

func drainRTCP(sender *webrtc.RTPSender) {
	buf := make([]byte, 1500)
	for {
		n, _, err := sender.Read(buf)
		if err != nil {
			return
		}
		packets, err := rtcp.Unmarshal(buf[:n])
		if err != nil {
			continue
		}
		for _, p := range packets {
			switch p.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				handleRTCPKeyframeFeedback()
			}
		}
	}
}

const h264SDPFmtpLine = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640034"

var rtcpKeyframeLogOnce sync.Once
var lastRTCPKeyframeRequest atomic.Int64

const rtcpKeyframeMinInterval = 750 * time.Millisecond

func handleRTCPKeyframeFeedback() {
	if !honorRTCPKeyframes() {
		rtcpKeyframeLogOnce.Do(func() {
			log.Printf("webrtcpub: RTCP video keyframe recovery disabled by OVERLORD_WEBRTC_RTCP_KEYFRAMES")
		})
		return
	}
	now := time.Now().UnixNano()
	for {
		last := lastRTCPKeyframeRequest.Load()
		if last > 0 && time.Duration(now-last) < rtcpKeyframeMinInterval {
			return
		}
		if lastRTCPKeyframeRequest.CompareAndSwap(last, now) {
			break
		}
	}
	RequestKeyframe()
}

func honorRTCPKeyframes() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("OVERLORD_WEBRTC_RTCP_KEYFRAMES"))) {
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

type h264TrackWriter struct {
	t *webrtc.TrackLocalStaticSample
}

func (w *h264TrackWriter) WriteH264(nalu []byte, dur time.Duration) error {
	return w.t.WriteSample(media.Sample{Data: nalu, Duration: dur})
}

type Publisher struct {
	kind        Kind
	pc          *webrtc.PeerConnection
	resourceURL string
	token       string
	httpClient  *http.Client
	closeOnce   sync.Once
}

var (
	whipMu     sync.Mutex
	whipByKind = map[Kind]*Publisher{}
)

func Start(ctx context.Context, kind Kind, opts Options) (*Publisher, error) {
	ensureFirewallRule()
	if strings.TrimSpace(opts.WhipURL) == "" {
		return nil, errors.New("webrtcpub: empty WhipURL")
	}
	if strings.TrimSpace(opts.PublishToken) == "" {
		return nil, errors.New("webrtcpub: empty PublishToken")
	}
	if !opts.HasVideo && !opts.HasAudio {
		return nil, errors.New("webrtcpub: at least one of HasVideo/HasAudio must be true")
	}
	Stop(kind)

	httpClient := buildHTTPClient(opts)

	mediaEngine := &webrtc.MediaEngine{}
	if opts.HasVideo {
		if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{
				MimeType:    webrtc.MimeTypeH264,
				ClockRate:   90000,
				SDPFmtpLine: h264SDPFmtpLine,
			},
			PayloadType: 102,
		}, webrtc.RTPCodecTypeVideo); err != nil {
			return nil, fmt.Errorf("register video codec: %w", err)
		}
	}
	if opts.HasAudio {
		if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{
				MimeType:    webrtc.MimeTypeOpus,
				ClockRate:   48000,
				Channels:    2,
				SDPFmtpLine: "minptime=10;useinbandfec=1",
			},
			PayloadType: 111,
		}, webrtc.RTPCodecTypeAudio); err != nil {
			return nil, fmt.Errorf("register audio codec: %w", err)
		}
	}

	api := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, fmt.Errorf("new peer connection: %w", err)
	}

	var (
		videoTrack  *webrtc.TrackLocalStaticSample
		audioTrack  *webrtc.TrackLocalStaticSample
		audioWriter AudioWriter
	)
	if opts.HasVideo {
		videoTrack, err = webrtc.NewTrackLocalStaticSample(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264},
			"overlord-video-"+string(kind), "overlord-"+string(kind),
		)
		if err != nil {
			_ = pc.Close()
			return nil, fmt.Errorf("new video track: %w", err)
		}
		tx, err := pc.AddTransceiverFromTrack(videoTrack, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionSendonly,
		})
		if err != nil {
			_ = pc.Close()
			return nil, fmt.Errorf("add video transceiver: %w", err)
		}
		if sender := tx.Sender(); sender != nil {
			go drainRTCP(sender)
		}
	}
	if opts.HasAudio {
		audioTrack, err = webrtc.NewTrackLocalStaticSample(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"},
			"overlord-audio-"+string(kind), "overlord-"+string(kind),
		)
		if err != nil {
			_ = pc.Close()
			return nil, fmt.Errorf("new audio track: %w", err)
		}
		audioWriter, err = newOpusAudioWriter(audioTrack)
		if err != nil {
			_ = pc.Close()
			return nil, fmt.Errorf("new opus encoder: %w", err)
		}
		tx, err := pc.AddTransceiverFromTrack(audioTrack, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionSendonly,
		})
		if err != nil {
			_ = pc.Close()
			return nil, fmt.Errorf("add audio transceiver: %w", err)
		}
		if sender := tx.Sender(); sender != nil {
			go drainRTCP(sender)
		}
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		_ = pc.Close()
		return nil, fmt.Errorf("create offer: %w", err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		_ = pc.Close()
		return nil, fmt.Errorf("set local desc: %w", err)
	}

	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		log.Printf("webrtcpub: ICE gathering timeout; continuing with partial candidates")
	case <-ctx.Done():
		_ = pc.Close()
		return nil, ctx.Err()
	}

	answerSDP, resourceURL, err := postWhip(ctx, httpClient, opts.WhipURL, opts.PublishToken, pc.LocalDescription().SDP)
	if err != nil {
		_ = pc.Close()
		return nil, err
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  answerSDP,
	}); err != nil {
		_ = pc.Close()
		return nil, fmt.Errorf("set remote desc: %w", err)
	}

	pub := &Publisher{
		kind:        kind,
		pc:          pc,
		resourceURL: resourceURL,
		token:       opts.PublishToken,
		httpClient:  httpClient,
	}

	writerID := whipWriterID(kind)
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("webrtcpub: WHIP[%s] peer state=%s", kind, state)
		switch state {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			whipMu.Lock()
			if whipByKind[kind] == pub {
				delete(whipByKind, kind)
			}
			whipMu.Unlock()
			unregisterWriter(kind, writerID)
		}
	})

	whipMu.Lock()
	whipByKind[kind] = pub
	whipMu.Unlock()
	if videoTrack != nil {
		registerVideoWriter(kind, writerID, &h264TrackWriter{t: videoTrack})
	}
	if audioTrack != nil {
		registerAudioWriter(kind, writerID, audioWriter)
	}
	log.Printf("webrtcpub: WHIP[%s] session established (resource=%s)", kind, resourceURL)
	return pub, nil
}

func Stop(kind Kind) {
	whipMu.Lock()
	p := whipByKind[kind]
	delete(whipByKind, kind)
	whipMu.Unlock()
	unregisterWriter(kind, whipWriterID(kind))
	if p != nil {
		p.Close()
	}
}

func StopAll() {
	whipMu.Lock()
	kinds := make([]Kind, 0, len(whipByKind))
	for k := range whipByKind {
		kinds = append(kinds, k)
	}
	whipMu.Unlock()
	for _, k := range kinds {
		Stop(k)
	}
}

func (p *Publisher) Close() {
	p.closeOnce.Do(func() {
		if p.resourceURL != "" {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodDelete, p.resourceURL, nil)
			if err == nil {
				if p.token != "" {
					req.Header.Set("Authorization", "Bearer "+p.token)
				}
				if resp, err := p.httpClient.Do(req); err == nil {
					_ = resp.Body.Close()
				}
			}
		}
		_ = p.pc.Close()
	})
}

func whipWriterID(kind Kind) string {
	return "whip:" + string(kind)
}

func postWhip(ctx context.Context, client *http.Client, whipURL, token, sdp string) (string, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, whipURL, strings.NewReader(sdp))
	if err != nil {
		return "", "", fmt.Errorf("build whip request: %w", err)
	}
	req.Header.Set("Content-Type", "application/sdp")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("whip post: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return "", "", fmt.Errorf("whip post: %s: %s", resp.Status, bytes.TrimSpace(body))
	}

	resource := resp.Header.Get("Location")
	if resource != "" {
		if parsed, err := url.Parse(resource); err == nil && !parsed.IsAbs() {
			base, _ := url.Parse(whipURL)
			if base != nil {
				resource = base.ResolveReference(parsed).String()
			}
		}
	}
	return string(body), resource, nil
}

func buildHTTPClient(opts Options) *http.Client {
	tlsCfg := &tls.Config{
		InsecureSkipVerify: opts.TLSInsecureSkipVerify,
		MinVersion:         tls.VersionTLS12,
	}
	if path := strings.TrimSpace(opts.TLSCAPath); path != "" {
		if pem, err := os.ReadFile(path); err == nil {
			pool := x509.NewCertPool()
			if pool.AppendCertsFromPEM(pem) {
				tlsCfg.RootCAs = pool
			}
		}
	}
	return &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: tlsCfg,
		},
	}
}
