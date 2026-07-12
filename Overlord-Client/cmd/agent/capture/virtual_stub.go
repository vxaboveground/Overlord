//go:build !windows

package capture

import "image"

func InitializevirtualMode() error {
	return nil
}

func CleanupvirtualMode() {}

func SetvirtualCursorCapture(enabled bool) {}

func VirtualMonitorCount() int {
	return 0
}

func virtualCaptureDisplay() (*image.RGBA, error) {
	return nil, nil
}

func virtualCaptureDisplayFallback() (*image.RGBA, error) {
	return nil, nil
}

func StartvirtualProcess(filePath string) (uint32, error) {
	return 0, nil
}

func virtualKillAll() error {
	return nil
}

func virtualEnumWindows() ([]HVNCWindowInfo, []HVNCMonitorInfo) {
	return nil, nil
}

func virtualInputMouseMove(x, y int32) error {
	return nil
}

func virtualInputMouseDown(button int) error {
	return nil
}

func virtualInputMouseUp(button int) error {
	return nil
}

func virtualInputKeyDown(vk uint16) error {
	return nil
}

func virtualInputKeyUp(vk uint16) error {
	return nil
}

func virtualInputMouseWheel(delta int32) error {
	return nil
}
