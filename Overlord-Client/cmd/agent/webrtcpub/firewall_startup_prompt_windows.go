//go:build windows && overlord_webrtc && webrtc_firewall_startup_prompt

package webrtcpub

import (
	"log"
	"net"
	"time"

	"golang.org/x/sys/windows"
)

func PromptFirewallPermissionOnStartup() {
	go func() {
		ensureFirewallRule()
		if windows.GetCurrentProcessToken().IsElevated() {
			return
		}
		probeFirewallPermissionPrompt()
	}()
}

func probeFirewallPermissionPrompt() {
	pc, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		log.Printf("webrtcpub: firewall permission probe failed: %v", err)
		return
	}
	defer pc.Close()

	_ = pc.SetReadDeadline(time.Now().Add(5 * time.Second))
	var buf [1]byte
	_, _, _ = pc.ReadFrom(buf[:])
}
