//go:build !windows

package capture

import (
	"image"
)

func SetCursorCapture(enabled bool) {}

func DesktopCursorState(display, frameWidth, frameHeight int) DesktopCursorMetadata {
	return DesktopCursorMetadata{}
}

func DrawCursorOnImage(img *image.RGBA, captureBounds image.Rectangle) {
	// if you're not windows fuck you
}
