package handlers

import (
	"context"
	"log"
	"overlord-client/cmd/agent/capture"
	rt "overlord-client/cmd/agent/runtime"
	"sync/atomic"
	"time"
)

var (
	virtualTargetFPS atomic.Int64
)

func VirtualStart(ctx context.Context, env *rt.Env) error {
	fps := activeVirtualTargetFPS()
	interval := time.Second / time.Duration(fps)
	capture.SetBackstageH264TargetFPS(fps)
	capture.SetFrameFlowTargetFPS(fps)
	log.Printf("virtual: starting stream (target fps %d)", fps)

	if err := capture.InitializeVirtualMode(); err != nil {
		log.Printf("virtual: failed to initialize virtual mode: %v", err)
		return err
	}
	defer capture.CleanupVirtualMode()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	currentFPS := fps
	for {
		select {
		case <-ctx.Done():
			log.Printf("virtual: stopping stream")
			return nil
		case <-ticker.C:
			fps := activeVirtualTargetFPS()
			if fps != currentFPS {
				currentFPS = fps
				capture.SetBackstageH264TargetFPS(fps)
				capture.SetFrameFlowTargetFPS(fps)
				ticker.Reset(time.Second / time.Duration(fps))
				log.Printf("virtual: target fps changed to %d", fps)
			}
			if err := capture.NowVirtual(ctx, env); err != nil {
				if ctx.Err() != nil {
					log.Printf("virtual: stopping stream")
					return nil
				}
				log.Printf("virtual: capture error: %v", err)
			}
		}
	}
}

func activeVirtualTargetFPS() int {
	if fps := int(virtualTargetFPS.Load()); fps > 0 {
		return fps
	}
	_, fps := streamInterval("OVERLORD_virtual_MAX_FPS", 120)
	return SetVirtualTargetFPS(fps)
}

func SetVirtualTargetFPS(fps int) int {
	fps = clampDesktopTargetFPS(fps)
	virtualTargetFPS.Store(int64(fps))
	capture.SetBackstageH264TargetFPS(fps)
	capture.SetFrameFlowTargetFPS(fps)
	return fps
}

func VirtualSelect(ctx context.Context, env *rt.Env, display int) error {
	log.Printf("virtual: set selected display to %d (virtual monitor always index 0)", display)
	return nil
}

func VirtualMouseControl(ctx context.Context, env *rt.Env, enabled bool) error {
	env.VirtualMouseControl = enabled
	log.Printf("virtual: mouse control %v", enabled)
	return nil
}

func VirtualKeyboardControl(ctx context.Context, env *rt.Env, enabled bool) error {
	env.VirtualKeyboardControl = enabled
	log.Printf("virtual: keyboard control %v", enabled)
	return nil
}

func VirtualCursorControl(ctx context.Context, env *rt.Env, enabled bool) error {
	env.VirtualCursorCapture = enabled
	capture.SetVirtualCursorCapture(enabled)
	log.Printf("virtual: cursor capture %v", enabled)
	return nil
}
