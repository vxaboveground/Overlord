//go:build !darwin && !windows

package handlers

import (
	"context"

	agentRuntime "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

func HandleElevate(ctx context.Context, env *agentRuntime.Env, cmdID string, password string) error {
	return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        false,
		Message:   "elevation via password is only supported on macOS",
	})
}
