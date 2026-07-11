//go:build !windows

package privacy

import "errors"

func enablePlatform() error {
	return errors.New("privacy mode is only supported on Windows")
}

func disablePlatform() {}
