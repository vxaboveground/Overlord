//go:build linux

package capture

import (
	"image"

	"github.com/kbinani/screenshot"
)

func displayBounds(idx int) image.Rectangle {
	if !isWaylandSession && !x11Disabled.Load() {
		if b := x11DisplayBounds(idx); b.Dx() > 0 && b.Dy() > 0 {
			return b
		}
	}
	n := screenshot.NumActiveDisplays()
	if idx < 0 || idx >= n {
		return image.Rectangle{}
	}
	return screenshot.GetDisplayBounds(idx)
}

func displayScale(idx int) float64 {
	return 1.0
}

func MonitorInfos() []MonitorInfo {
	n := displayCount()
	infos := make([]MonitorInfo, 0, n)
	for i := 0; i < n; i++ {
		b := displayBounds(i)
		infos = append(infos, MonitorInfo{
			Width:  b.Dx(),
			Height: b.Dy(),
		})
	}
	return infos
}
