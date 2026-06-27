//go:build noprint
// +build noprint

package main

import (
	"overlord-client/cmd/agent/config"
	"overlord-client/cmd/agent/securelog"
)

func init() {
	securelog.Install(config.DefaultSecureLogPublicKey)
}
