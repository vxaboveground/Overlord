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
				RequestKeyframe()
			}
		}
	}
}

type trackWriter struct {
	t *webrtc.TrackLocalStaticSample
}

func (w *trackWriter) WriteH264(nalu []byte, dur time.Duration) error {
	return w.t.WriteSample(media.Sample{Data: nalu, Duration: dur})
}

const whipWriterID = "whip"

type Publisher struct {
	pc          *webrtc.PeerConnection
	resourceURL string
	token       string
	httpClient  *http.Client
	closeOnce   sync.Once
}

var (
	whipMu sync.Mutex
	whip   *Publisher
)

func Start(ctx context.Context, opts Options) (*Publisher, error) {
	if strings.TrimSpace(opts.WhipURL) == "" {
		return nil, errors.New("webrtcpub: empty WhipURL")
	}
	if strings.TrimSpace(opts.PublishToken) == "" {
		return nil, errors.New("webrtcpub: empty PublishToken")
	}
	Stop()

	httpClient := buildHTTPClient(opts)

	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeH264,
			ClockRate:   90000,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
		},
		PayloadType: 102,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, fmt.Errorf("register codec: %w", err)
	}

	api := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, fmt.Errorf("new peer connection: %w", err)
	}

	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264},
		"overlord-video", "overlord-desktop",
	)
	if err != nil {
		_ = pc.Close()
		return nil, fmt.Errorf("new track: %w", err)
	}
	transceiver, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendonly,
	})
	if err != nil {
		_ = pc.Close()
		return nil, fmt.Errorf("add transceiver: %w", err)
	}
	if sender := transceiver.Sender(); sender != nil {
		go drainRTCP(sender)
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
		pc:          pc,
		resourceURL: resourceURL,
		token:       opts.PublishToken,
		httpClient:  httpClient,
	}

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("webrtcpub: WHIP peer state=%s", state)
		switch state {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			whipMu.Lock()
			if whip == pub {
				whip = nil
			}
			whipMu.Unlock()
			unregisterWriter(whipWriterID)
		}
	})

	whipMu.Lock()
	whip = pub
	whipMu.Unlock()
	registerWriter(whipWriterID, &trackWriter{t: track})
	log.Printf("webrtcpub: WHIP session established (resource=%s)", resourceURL)
	return pub, nil
}

func Stop() {
	whipMu.Lock()
	p := whip
	whip = nil
	whipMu.Unlock()
	unregisterWriter(whipWriterID)
	if p != nil {
		p.Close()
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
