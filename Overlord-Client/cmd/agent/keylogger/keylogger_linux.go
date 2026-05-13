//go:build linux && !nokeylogger
// +build linux,!nokeylogger

package keylogger

import (
	"fmt"
	"log"
	"time"
)

func (k *Keylogger) captureKeystrokes() error {
	log.Printf("[keylogger] Linux keylogging not fully implemented - placeholder mode")

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-k.stopCh:
			return nil
		case <-ticker.C:
			k.logKey(fmt.Sprintf("[System Activity Detected at %s]", time.Now().Format("15:04:05")))
		}
	}
}

func getWindowTitle() string {
	return ""
}
