//go:build !windows || !overlord_webrtc || !webrtc_firewall_startup_prompt

package webrtcpub

func PromptFirewallPermissionOnStartup() {}
