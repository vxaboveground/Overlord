//go:build linux

package capture

func ResetDesktopCapture() {
	x11Reset()
}
