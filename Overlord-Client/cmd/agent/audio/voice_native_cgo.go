//go:build cgo

package audio

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/gen2brain/malgo"
)

const (
	voiceSampleRate         = 16000
	voiceChannels           = 1
	voiceBytesPerSample     = 2
	maxPlaybackBufferMillis = 250
)

const maxPlaybackBufferBytes = (voiceSampleRate * voiceChannels * voiceBytesPerSample * maxPlaybackBufferMillis) / 1000

type playbackBuffer struct {
	mu   sync.Mutex
	data []byte
}

func (b *playbackBuffer) Push(p []byte) {
	if len(p) == 0 {
		return
	}
	copyBytes := append([]byte(nil), p...)
	b.mu.Lock()
	b.data = append(b.data, copyBytes...)
	if len(b.data) > maxPlaybackBufferBytes {
		b.data = b.data[len(b.data)-maxPlaybackBufferBytes:]
	}
	b.mu.Unlock()
}

func (b *playbackBuffer) PopInto(out []byte) {
	if len(out) == 0 {
		return
	}
	for i := range out {
		out[i] = 0
	}
	b.mu.Lock()
	n := copy(out, b.data)
	if n > 0 {
		b.data = b.data[n:]
	}
	b.mu.Unlock()
}

type Session struct {
	ctx      context.Context
	cancel   context.CancelFunc
	audioCtx *malgo.AllocatedContext
	capture  *malgo.Device
	playback *malgo.Device

	uplink chan []byte
	queue  *playbackBuffer

	wg       sync.WaitGroup
	closeMu  sync.Mutex
	isClosed bool
}

func ProbeCapabilities() Capabilities {
	ctx, err := malgo.InitContext(nil, malgo.ContextConfig{}, nil)
	if err != nil {
		return Capabilities{
			Available:   false,
			RequiresCGO: true,
			Sources:     []string{"default"},
			Detail:      "audio backend init failed",
		}
	}
	defer ctx.Free()

	caps := Capabilities{
		Available:     true,
		RequiresCGO:   true,
		Sources:       []string{"default", "system"},
		DefaultSource: "default",
	}

	for _, name := range listCaptureDeviceNames(ctx.Context) {
		caps.Sources = append(caps.Sources, "device:"+name)
	}
	return caps
}

func listCaptureDeviceNames(ctx malgo.Context) []string {
	devices, err := ctx.Devices(malgo.Capture)
	if err != nil {
		return nil
	}

	seen := map[string]bool{}
	out := make([]string, 0, len(devices))
	for i := range devices {
		name := strings.TrimSpace(devices[i].Name())
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, name)
	}

	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i]) < strings.ToLower(out[j])
	})
	return out
}

func findCaptureDeviceByName(ctx malgo.Context, wanted string) (*malgo.DeviceID, string, bool) {
	wanted = strings.TrimSpace(wanted)
	if wanted == "" {
		return nil, "", false
	}

	devices, err := ctx.Devices(malgo.Capture)
	if err != nil {
		return nil, "", false
	}

	for i := range devices {
		name := strings.TrimSpace(devices[i].Name())
		if strings.EqualFold(name, wanted) {
			id := devices[i].ID
			return &id, name, true
		}
	}

	return nil, "", false
}

func findSystemCaptureDevice(ctx malgo.Context) (*malgo.DeviceID, string, bool) {
	devices, err := ctx.Devices(malgo.Capture)
	if err != nil {
		return nil, "", false
	}

	keywords := []string{
		"stereo mix",
		"what u hear",
		"monitor",
		"loopback",
		"output",
		"speakers",
	}

	for i := range devices {
		name := strings.ToLower(devices[i].Name())
		for _, keyword := range keywords {
			if strings.Contains(name, keyword) {
				id := devices[i].ID
				return &id, devices[i].Name(), true
			}
		}
	}

	return nil, "", false
}

func StartVoiceSession(parent context.Context, source string, onCapture func([]byte)) (*Session, error) {
	if onCapture == nil {
		return nil, errors.New("voice capture callback is required")
	}
	source = strings.TrimSpace(source)

	audioCtx, err := malgo.InitContext(nil, malgo.ContextConfig{}, nil)
	if err != nil {
		return nil, fmt.Errorf("audio init failed: %w", err)
	}

	ctx, cancel := context.WithCancel(parent)
	s := &Session{
		ctx:      ctx,
		cancel:   cancel,
		audioCtx: audioCtx,
		uplink:   make(chan []byte, 24),
		queue:    &playbackBuffer{},
	}

	playCfg := malgo.DefaultDeviceConfig(malgo.Playback)
	playCfg.SampleRate = voiceSampleRate
	playCfg.Playback.Format = malgo.FormatS16
	playCfg.Playback.Channels = voiceChannels

	playCallbacks := malgo.DeviceCallbacks{
		Data: func(output, _ []byte, _ uint32) {
			s.queue.PopInto(output)
		},
	}
	playDev, err := malgo.InitDevice(audioCtx.Context, playCfg, playCallbacks)
	if err != nil {
		audioCtx.Free()
		cancel()
		return nil, fmt.Errorf("audio playback init failed: %w", err)
	}
	s.playback = playDev

	capCfg := malgo.DefaultDeviceConfig(malgo.Capture)
	capCfg.SampleRate = voiceSampleRate
	capCfg.Capture.Format = malgo.FormatS16
	capCfg.Capture.Channels = voiceChannels
	if strings.EqualFold(source, "system") {
		deviceID, deviceName, ok := findSystemCaptureDevice(audioCtx.Context)
		if !ok || deviceID == nil {
			s.playback.Stop()
			s.playback.Uninit()
			audioCtx.Free()
			cancel()
			return nil, errors.New("system audio capture device was not found on this client")
		}
		_ = deviceName
		capCfg.Capture.DeviceID = deviceID.Pointer()
	} else if strings.HasPrefix(strings.ToLower(source), "device:") {
		deviceName := strings.TrimSpace(source[len("device:"):])
		deviceID, _, ok := findCaptureDeviceByName(audioCtx.Context, deviceName)
		if !ok || deviceID == nil {
			s.playback.Stop()
			s.playback.Uninit()
			audioCtx.Free()
			cancel()
			return nil, fmt.Errorf("audio capture device was not found: %s", deviceName)
		}
		capCfg.Capture.DeviceID = deviceID.Pointer()
	} else if source != "" && !strings.EqualFold(source, "default") && !strings.EqualFold(source, "microphone") {
		deviceID, _, ok := findCaptureDeviceByName(audioCtx.Context, source)
		if !ok || deviceID == nil {
			s.playback.Stop()
			s.playback.Uninit()
			audioCtx.Free()
			cancel()
			return nil, fmt.Errorf("audio capture device was not found: %s", source)
		}
		capCfg.Capture.DeviceID = deviceID.Pointer()
	}

	capCallbacks := malgo.DeviceCallbacks{
		Data: func(_, input []byte, _ uint32) {
			if len(input) == 0 {
				return
			}
			chunk := append([]byte(nil), input...)
			select {
			case s.uplink <- chunk:
			default:
				// Drop oldest when overloaded to keep latency bounded.
				select {
				case <-s.uplink:
				default:
				}
				select {
				case s.uplink <- chunk:
				default:
				}
			}
		},
	}
	capDev, err := malgo.InitDevice(audioCtx.Context, capCfg, capCallbacks)
	if err != nil {
		playDev.Uninit()
		audioCtx.Free()
		cancel()
		return nil, fmt.Errorf("audio capture init failed: %w", err)
	}
	s.capture = capDev

	if err := playDev.Start(); err != nil {
		s.capture.Uninit()
		s.playback.Uninit()
		audioCtx.Free()
		cancel()
		return nil, fmt.Errorf("audio playback start failed: %w", err)
	}
	if err := capDev.Start(); err != nil {
		s.playback.Stop()
		s.capture.Uninit()
		s.playback.Uninit()
		audioCtx.Free()
		cancel()
		return nil, fmt.Errorf("audio capture start failed: %w", err)
	}

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			select {
			case <-s.ctx.Done():
				return
			case chunk := <-s.uplink:
				onCapture(chunk)
			}
		}
	}()

	return s, nil
}

func (s *Session) WritePlayback(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	s.closeMu.Lock()
	closed := s.isClosed
	s.closeMu.Unlock()
	if closed {
		return errors.New("voice session is closed")
	}
	s.queue.Push(data)
	return nil
}

func (s *Session) Close() error {
	s.closeMu.Lock()
	if s.isClosed {
		s.closeMu.Unlock()
		return nil
	}
	s.isClosed = true
	s.closeMu.Unlock()

	s.cancel()

	if s.capture != nil {
		_ = s.capture.Stop()
		s.capture.Uninit()
	}
	if s.playback != nil {
		_ = s.playback.Stop()
		s.playback.Uninit()
	}
	if s.audioCtx != nil {
		s.audioCtx.Free()
	}

	s.wg.Wait()
	return nil
}

func StartCaptureOnlySession(parent context.Context, source string, onCapture func([]byte)) (*Session, error) {
	if onCapture == nil {
		return nil, errors.New("capture callback is required")
	}
	source = strings.TrimSpace(source)

	audioCtx, err := malgo.InitContext(nil, malgo.ContextConfig{}, nil)
	if err != nil {
		return nil, fmt.Errorf("audio init failed: %w", err)
	}

	ctx, cancel := context.WithCancel(parent)
	s := &Session{
		ctx:      ctx,
		cancel:   cancel,
		audioCtx: audioCtx,
		uplink:   make(chan []byte, 24),
		queue:    &playbackBuffer{},
	}

	capCfg := malgo.DefaultDeviceConfig(malgo.Capture)
	capCfg.SampleRate = voiceSampleRate
	capCfg.Capture.Format = malgo.FormatS16
	capCfg.Capture.Channels = voiceChannels
	useLoopback := false
	if strings.EqualFold(source, "system") {
		capCfg = malgo.DefaultDeviceConfig(malgo.Loopback)
		capCfg.SampleRate = voiceSampleRate
		capCfg.Capture.Format = malgo.FormatS16
		capCfg.Capture.Channels = voiceChannels
		useLoopback = true
	} else if strings.HasPrefix(strings.ToLower(source), "device:") {
		deviceName := strings.TrimSpace(source[len("device:"):])
		deviceID, _, ok := findCaptureDeviceByName(audioCtx.Context, deviceName)
		if !ok || deviceID == nil {
			audioCtx.Free()
			cancel()
			return nil, fmt.Errorf("audio capture device was not found: %s", deviceName)
		}
		capCfg.Capture.DeviceID = deviceID.Pointer()
	} else if source != "" && !strings.EqualFold(source, "default") && !strings.EqualFold(source, "microphone") {
		deviceID, _, ok := findCaptureDeviceByName(audioCtx.Context, source)
		if !ok || deviceID == nil {
			audioCtx.Free()
			cancel()
			return nil, fmt.Errorf("audio capture device was not found: %s", source)
		}
		capCfg.Capture.DeviceID = deviceID.Pointer()
	}

	capCallbacks := malgo.DeviceCallbacks{
		Data: func(_, input []byte, _ uint32) {
			if len(input) == 0 {
				return
			}
			chunk := append([]byte(nil), input...)
			select {
			case s.uplink <- chunk:
			default:
				select {
				case <-s.uplink:
				default:
				}
				select {
				case s.uplink <- chunk:
				default:
				}
			}
		},
	}
	capDev, err := malgo.InitDevice(audioCtx.Context, capCfg, capCallbacks)
	if err != nil && useLoopback {
		capCfg = malgo.DefaultDeviceConfig(malgo.Capture)
		capCfg.SampleRate = voiceSampleRate
		capCfg.Capture.Format = malgo.FormatS16
		capCfg.Capture.Channels = voiceChannels
		deviceID, _, ok := findSystemCaptureDevice(audioCtx.Context)
		if !ok || deviceID == nil {
			audioCtx.Free()
			cancel()
			return nil, errors.New("system audio capture device was not found on this client")
		}
		capCfg.Capture.DeviceID = deviceID.Pointer()
		capDev, err = malgo.InitDevice(audioCtx.Context, capCfg, capCallbacks)
	}
	if err != nil {
		audioCtx.Free()
		cancel()
		return nil, fmt.Errorf("audio capture init failed: %w", err)
	}
	s.capture = capDev

	if err := capDev.Start(); err != nil {
		s.capture.Uninit()
		audioCtx.Free()
		cancel()
		return nil, fmt.Errorf("audio capture start failed: %w", err)
	}

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			select {
			case <-s.ctx.Done():
				return
			case chunk := <-s.uplink:
				onCapture(chunk)
			}
		}
	}()

	return s, nil
}
