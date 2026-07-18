//go:build !windows

package capture

import (
	"errors"
	"image"
)

func encodeHEVCFrame(_ *image.RGBA) ([]byte, error) {
	return nil, errors.New("HEVC NVENC is only available on Windows")
}

func hevcAvailable() bool { return false }

func hevcAvailabilityDetail() string { return "HEVC NVENC is only available on Windows" }

func resetHEVCEncoder() {}
