//go:build android

package config

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"os"
	"strings"
)

const androidMachineIDFile = "/data/local/tmp/.overlord_id"

func platformMachineID() string {
	data, err := os.ReadFile(androidMachineIDFile)
	if err == nil {
		if id := strings.TrimSpace(string(data)); id != "" {
			return id
		}
	}

	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		log.Printf("[identity] WARNING: failed to generate android machine ID: %v", err)
		return ""
	}
	id := hex.EncodeToString(b)

	if err := os.MkdirAll("config", 0700); err != nil {
		log.Printf("[identity] WARNING: failed to create config dir for android machine ID: %v", err)
		return id
	}
	if err := os.WriteFile(androidMachineIDFile, []byte(id), 0600); err != nil {
		log.Printf("[identity] WARNING: failed to persist android machine ID: %v", err)
	}
	return id
}
