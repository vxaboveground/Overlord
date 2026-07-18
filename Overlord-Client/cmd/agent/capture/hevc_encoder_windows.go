//go:build windows

package capture

import (
	"errors"
	"fmt"
	"image"
	"sync"
)

var (
	hevcMu          sync.Mutex
	hevcEnc         h264FrameEncoder
	hevcProbeOnce   sync.Once
	hevcProbeOK     bool
	hevcProbeDetail string
)

func encodeHEVCFrame(img *image.RGBA) ([]byte, error) {
	if img == nil {
		return nil, errors.New("nil hevc frame")
	}
	b := img.Bounds()
	width, height := b.Dx(), b.Dy()
	if width <= 0 || height <= 0 || width%2 != 0 || height%2 != 0 {
		return nil, fmt.Errorf("hevc frame size must be positive and even, got %dx%d", width, height)
	}

	hevcMu.Lock()
	defer hevcMu.Unlock()
	fps := activeH264FPS()
	if hevcEnc == nil || !hevcEnc.Matches(width, height, fps) {
		closeH264Encoder(&hevcEnc)
		enc, err := newNativeHEVCEncoder("desktop", width, height, fps)
		if err != nil {
			return nil, err
		}
		hevcEnc = enc
	}
	return hevcEnc.Encode(img)
}

func hevcAvailable() bool {
	hevcProbeOnce.Do(func() {
		enc, err := newNativeHEVCEncoder("probe", 1280, 720, 30)
		if err != nil {
			hevcProbeDetail = err.Error()
			return
		}
		enc.Close()
		hevcProbeOK = true
		hevcProbeDetail = "NVIDIA NVENC HEVC Main profile"
	})
	return hevcProbeOK
}

func hevcAvailabilityDetail() string {
	hevcAvailable()
	return hevcProbeDetail
}

func resetHEVCEncoder() {
	hevcMu.Lock()
	defer hevcMu.Unlock()
	closeH264Encoder(&hevcEnc)
	resetNativeHEVCD3D11TextureEncoder()
}
