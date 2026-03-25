//go:build windows && persist_taskscheduler
// +build windows,persist_taskscheduler

package persistence

import (
	"fmt"
	"strings"
)

func init() {
	persistInstallFn = installTaskScheduler
	persistUninstallFns = append(persistUninstallFns, uninstallTaskScheduler)
}

func installTaskScheduler(targetPath string) error {
	taskName := deriveTaskName(targetPath)
	safe := strings.ReplaceAll(targetPath, "'", "''")
	script := fmt.Sprintf(
		`$a = New-ScheduledTaskAction -Execute '%s'; `+
			`$t = New-ScheduledTaskTrigger -AtLogOn; `+
			`$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable; `+
			`$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest; `+
			`Register-ScheduledTask -TaskName '%s' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null`,
		safe, taskName)
	return runPowerShell(script)
}

func uninstallTaskScheduler() error {
	prefix := executablePrefix()
	return runPowerShell(
		`Get-ScheduledTask -ErrorAction SilentlyContinue | ` +
			`Where-Object { $_.TaskName -like '` + prefix + `*' } | ` +
			`Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue`)
}
