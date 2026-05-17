//go:build !windows
// +build !windows

package handlers

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"

	"overlord-client/cmd/agent/wire"
)

func listProcesses() ([]wire.ProcessInfo, error) {
	selfPID := int32(os.Getpid())

	cmd := exec.Command("ps", "aux")
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	processes := make([]wire.ProcessInfo, 0)
	scanner := bufio.NewScanner(bytes.NewReader(output))

	scanner.Scan()

	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 11 {
			continue
		}

		pid, err := strconv.ParseInt(fields[1], 10, 32)
		if err != nil {
			continue
		}

		cpu, _ := strconv.ParseFloat(fields[2], 64)
		mem, _ := strconv.ParseFloat(fields[3], 64)

		memBytes := uint64(mem * 8 * 1024 * 1024 * 1024 / 100)

		name := fields[10]
		username := fields[0]

		ppid := int32(0)
		ppidCmd := exec.Command("ps", "-o", "ppid=", "-p", fields[1])
		if ppidOutput, err := ppidCmd.Output(); err == nil {
			ppidStr := strings.TrimSpace(string(ppidOutput))
			if ppidVal, err := strconv.ParseInt(ppidStr, 10, 32); err == nil {
				ppid = int32(ppidVal)
			}
		}

		procType := "other"
		if pid <= 2 || username == "root" {
			procType = "system"
		} else {

			currentUserCmd := exec.Command("whoami")
			if currentUserOutput, err := currentUserCmd.Output(); err == nil {
				currentUser := strings.TrimSpace(string(currentUserOutput))
				if username == currentUser {
					procType = "own"
				}
			}
		}

		processes = append(processes, wire.ProcessInfo{
			PID:      int32(pid),
			PPID:     ppid,
			Name:     name,
			CPU:      cpu,
			Memory:   memBytes,
			Username: username,
			Type:     procType,
			Self:     int32(pid) == selfPID,
		})
	}

	return processes, scanner.Err()
}

func killProcess(pid int32) error {
	return syscall.Kill(int(pid), syscall.SIGKILL)
}

func suspendProcess(pid int32) error {
	return syscall.Kill(int(pid), syscall.SIGSTOP)
}

func resumeProcess(pid int32) error {
	return syscall.Kill(int(pid), syscall.SIGCONT)
}
