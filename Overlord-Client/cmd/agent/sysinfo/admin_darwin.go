//go:build darwin && !ios && !ios_target

package sysinfo

import (
	"os"
)

func IsAdmin() bool {
	return os.Getuid() == 0
}

func Elevation() string {
	if os.Getuid() == 0 {
		return "admin"
	}
	return ""
}

func DarwinPermissions() map[string]bool {
	return map[string]bool{
		"screenRecording": false,
		"accessibility":   false,
		"fullDiskAccess":  false,
		"root":            os.Getuid() == 0,
	}
}
