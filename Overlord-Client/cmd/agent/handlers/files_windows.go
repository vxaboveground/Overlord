//go:build windows
// +build windows

package handlers

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"overlord-client/cmd/agent/wire"
)

func enrichFileEntry(entry *wire.FileEntry, info os.FileInfo) {
	if d, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		entry.Attrs = d.FileAttributes
	}
}

func ChangeFilePermissions(path string, mode string) error {
	return fmt.Errorf("chmod not supported on Windows")
}

func ExecuteFile(path string) error {

	ext := ""
	lastDot := -1
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '.' {
			lastDot = i
			break
		}
		if path[i] == '/' || path[i] == '\\' {
			break
		}
	}
	if lastDot >= 0 {
		ext = path[lastDot:]
	}

	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("file not found: %s", path)
	}

	switch ext {
	case ".exe", ".com":

		return execCommand(path)
	case ".bat", ".cmd":

		return execCommand("cmd.exe", "/c", path)
	case ".ps1":

		return execCommand("powershell.exe", "-ExecutionPolicy", "Bypass", "-File", path)
	case ".vbs":

		return execCommand("wscript.exe", path)
	case ".py":

		return execCommand("python", path)
	case ".js":

		return execCommand("node", path)
	default:
		return fmt.Errorf("unsupported file type: %s", ext)
	}
}

func execCommand(name string, args ...string) error {
	cmd := exec.Command(name, args...)

	return cmd.Start()
}
