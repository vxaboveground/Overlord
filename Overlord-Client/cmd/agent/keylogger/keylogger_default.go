//go:build !windows && !linux && !darwin && !nokeylogger

package keylogger

import (
	"fmt"
	"log"
	"runtime"
	"time"
)

func (k *Keylogger) captureKeystrokes() error {
	log.Printf("[keylogger] keylogging is not implemented on %s - placeholder mode", runtime.GOOS)

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
