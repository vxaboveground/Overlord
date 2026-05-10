//go:build !windows

package main

import (
	"os"
	"path/filepath"
)

// isRunningInMemory returns true when the agent is executing as
// in-memory shellcode (e.g. Linux memfd_create / execveat stub).
// On Linux the memfd path cannot be stat'd as a regular file.
func isRunningInMemory() bool {
	exePath, err := os.Executable()
	if err != nil {
		return true
	}
	if realPath, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = realPath
	}
	absPath, err := filepath.Abs(exePath)
	if err != nil {
		return true
	}
	info, err := os.Stat(absPath)
	if err != nil || !info.Mode().IsRegular() {
		return true
	}
	return false
}
