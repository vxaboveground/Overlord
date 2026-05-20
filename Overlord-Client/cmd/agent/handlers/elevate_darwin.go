//go:build darwin && !ios && !ios_target

package handlers

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"overlord-client/cmd/agent/mutex"
	agentRuntime "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

func HandleElevate(ctx context.Context, env *agentRuntime.Env, cmdID string, password string) error {
	if os.Getuid() == 0 {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        true,
			Message:   "already running as root",
		})
	}

	if password == "" {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   "password required for elevation",
		})
	}

	exePath, err := os.Executable()
	if err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   fmt.Sprintf("failed to resolve executable path: %v", err),
		})
	}

	validateCmd := exec.Command("sudo", "-S", "-k", "true")
	validateCmd.Stdin = strings.NewReader(password + "\n")
	if err := validateCmd.Run(); err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   "incorrect password",
		})
	}

	args := os.Args[1:]
	sudoArgs := append([]string{"-S", "-k", exePath}, args...)
	cmd := exec.Command("sudo", sudoArgs...)
	cmd.Stdin = strings.NewReader(password + "\n")
	cmd.Env = os.Environ()

	nullFile, _ := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if nullFile != nil {
		cmd.Stdout = nullFile
		cmd.Stderr = nullFile
	}

	if err := cmd.Start(); err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   fmt.Sprintf("failed to start elevated process: %v", err),
		})
	}

	mutex.ReleaseGlobal()
	log.Printf("[elevate] started elevated process pid=%d", cmd.Process.Pid)

	_ = wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        true,
		Message:   "elevating — new process started as root",
	})

	time.Sleep(500 * time.Millisecond)
	os.Exit(0)
	return nil
}
