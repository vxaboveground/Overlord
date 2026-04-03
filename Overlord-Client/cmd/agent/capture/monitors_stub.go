//go:build !windows && !linux

package capture

import "image"

func displayBounds(idx int) image.Rectangle {
	return image.Rectangle{}
}

func displayScale(idx int) float64 {
	return 1.0
}

func MonitorInfos() []MonitorInfo {
	return nil
}
