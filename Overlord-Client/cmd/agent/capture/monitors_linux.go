//go:build linux

package capture

import (
	"image"

	"github.com/kbinani/screenshot"
)

func displayBounds(idx int) image.Rectangle {
	return screenshot.GetDisplayBounds(idx)
}

func displayScale(idx int) float64 {
	return 1.0
}

func MonitorInfos() []MonitorInfo {
	n := screenshot.NumActiveDisplays()
	infos := make([]MonitorInfo, 0, n)
	for i := 0; i < n; i++ {
		b := screenshot.GetDisplayBounds(i)
		infos = append(infos, MonitorInfo{
			Width:  b.Dx(),
			Height: b.Dy(),
		})
	}
	return infos
}
