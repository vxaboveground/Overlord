//go:build linux

package capture

import (
	"image"

	"github.com/kbinani/screenshot"
)

var activeDisplays = func() int {
	return screenshot.NumActiveDisplays()
}

var captureDisplayFn = func(display int) (*image.RGBA, error) {
	return screenshot.CaptureDisplay(display)
}

func displayCount() int {
	return screenshot.NumActiveDisplays()
}
