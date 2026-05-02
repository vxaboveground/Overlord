//go:build !android

package handlers

import (
	"context"
	"fmt"
	goruntime "runtime"

	"overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

func HandleAndroidDevice(ctx context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	return wire.WriteMsg(ctx, env.Conn, wire.AndroidDeviceInfo{
		Type: "android_device",
	})
}

func HandleAndroidSMS(ctx context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	cmdID, _ := envelope["commandId"].(string)
	return wire.WriteMsg(ctx, env.Conn, wire.AndroidSMSResult{
		Type: "android_sms", CommandID: cmdID,
		Error: fmt.Sprintf("android_sms not supported on %s", goruntime.GOOS),
	})
}

func HandleAndroidContacts(ctx context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	cmdID, _ := envelope["commandId"].(string)
	return wire.WriteMsg(ctx, env.Conn, wire.AndroidContactsResult{
		Type: "android_contacts", CommandID: cmdID,
		Error: fmt.Sprintf("android_contacts not supported on %s", goruntime.GOOS),
	})
}

func HandleAndroidCallLog(ctx context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	cmdID, _ := envelope["commandId"].(string)
	return wire.WriteMsg(ctx, env.Conn, wire.AndroidCallLogResult{
		Type: "android_calllog", CommandID: cmdID,
		Error: fmt.Sprintf("android_calllog not supported on %s", goruntime.GOOS),
	})
}

func HandleAndroidLocation(ctx context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	cmdID, _ := envelope["commandId"].(string)
	return wire.WriteMsg(ctx, env.Conn, wire.AndroidLocation{
		Type: "android_location", CommandID: cmdID,
		Error: fmt.Sprintf("android_location not supported on %s", goruntime.GOOS),
	})
}

func HandleAndroidApps(ctx context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	cmdID, _ := envelope["commandId"].(string)
	return wire.WriteMsg(ctx, env.Conn, wire.AndroidAppListResult{
		Type: "android_apps", CommandID: cmdID,
		Error: fmt.Sprintf("android_apps not supported on %s", goruntime.GOOS),
	})
}
