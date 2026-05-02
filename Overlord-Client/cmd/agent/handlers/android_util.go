//go:build android

package handlers

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

func androidExec(ctx context.Context, timeout time.Duration, name string, args ...string) (string, error) {
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(execCtx, name, args...)
	out, err := cmd.Output()
	if err != nil {
		if execCtx.Err() == context.DeadlineExceeded {
			return "", fmt.Errorf("command timed out after %v: %s %s", timeout, name, strings.Join(args, " "))
		}
		if ee, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("%s: %s", strings.TrimSpace(string(ee.Stderr)), err)
		}
		return "", err
	}
	return strings.TrimSuffix(string(out), "\n"), nil
}
