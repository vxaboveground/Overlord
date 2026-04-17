//go:build windows

package plugins

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

func loadNativePlugin(data []byte) (NativePlugin, error) {
	if len(data) == 0 {
		return nil, errors.New("empty plugin binary")
	}

	type initResult struct {
		dp  *dllPlugin
		err error
	}
	ch := make(chan initResult, 1)

	go func() {
		runtime.LockOSThread()

		mm, err := LoadMemoryModule(data)
		if err != nil {
			ch <- initResult{err: fmt.Errorf("pe load: %w", err)}
			runtime.UnlockOSThread()
			return
		}

		if err := mm.CallEntryPoint(dllProcessAttach); err != nil {
			mm.Free()
			ch <- initResult{err: fmt.Errorf("DllMain init: %w", err)}
			runtime.UnlockOSThread()
			return
		}

		onLoad, err := mm.GetExport("PluginOnLoad")
		if err != nil {
			mm.Free()
			ch <- initResult{err: err}
			runtime.UnlockOSThread()
			return
		}
		onEvent, err := mm.GetExport("PluginOnEvent")
		if err != nil {
			mm.Free()
			ch <- initResult{err: err}
			runtime.UnlockOSThread()
			return
		}
		onUnload, err := mm.GetExport("PluginOnUnload")
		if err != nil {
			mm.Free()
			ch <- initResult{err: err}
			runtime.UnlockOSThread()
			return
		}

		setCallback, _ := mm.GetExport("PluginSetCallback")

		rt := "go"
		if getRuntimeAddr, err := mm.GetExport("PluginGetRuntime"); err == nil {
			ret, _, _ := syscall.SyscallN(getRuntimeAddr)
			if ret != 0 {
				var buf [32]byte
				for i := range buf {
					b := *(*byte)(unsafe.Pointer(ret + uintptr(i)))
					if b == 0 {
						rt = string(buf[:i])
						break
					}
					buf[i] = b
				}
			}
		}

		dp := &dllPlugin{
			mem:             mm,
			onLoadAddr:      onLoad,
			onEventAddr:     onEvent,
			onUnloadAddr:    onUnload,
			setCallbackAddr: setCallback,
			pluginRuntime:   rt,
			workCh:          make(chan pluginWork),
		}

		ch <- initResult{dp: dp}

		dp.workerLoop()

		runtime.UnlockOSThread()
	}()

	res := <-ch
	if res.err != nil {
		return nil, res.err
	}
	return res.dp, nil
}

type pluginWork struct {
	fn   func() error
	done chan error
}

type dllPlugin struct {
	mem             *MemoryModule
	onLoadAddr      uintptr
	onEventAddr     uintptr
	onUnloadAddr    uintptr
	setCallbackAddr uintptr
	callbackHandle  uintptr // prevent GC of the callback closure
	pluginRuntime   string  // "go", "c", "cpp", etc.
	workCh          chan pluginWork
}

func (p *dllPlugin) workerLoop() {
	for w := range p.workCh {
		w.done <- w.fn()
	}
}

func (p *dllPlugin) runOnWorker(fn func() error) error {
	done := make(chan error, 1)
	p.workCh <- pluginWork{fn: fn, done: done}
	return <-done
}

func (p *dllPlugin) Load(send func(string, []byte), hostInfo []byte) error {
	return p.runOnWorker(func() error {
		// Create a stdcall callback the DLL can invoke to send events to the host.
		cb := syscall.NewCallback(func(eventPtr, eventLen, payloadPtr, payloadLen uintptr) uintptr {
			event := make([]byte, eventLen)
			if eventLen > 0 {
				copy(event, unsafe.Slice((*byte)(unsafe.Pointer(eventPtr)), eventLen))
			}
			payload := make([]byte, payloadLen)
			if payloadLen > 0 {
				copy(payload, unsafe.Slice((*byte)(unsafe.Pointer(payloadPtr)), payloadLen))
			}
			send(string(event), payload)
			return 0
		})
		p.callbackHandle = cb

		if p.setCallbackAddr != 0 {
			syscall.SyscallN(p.setCallbackAddr, cb)
		}

		var infoPtr uintptr
		infoLen := uintptr(len(hostInfo))
		if len(hostInfo) > 0 {
			infoPtr = uintptr(unsafe.Pointer(&hostInfo[0]))
		}
		ret, _, _ := syscall.SyscallN(p.onLoadAddr, infoPtr, infoLen, cb)
		if int32(ret) != 0 {
			return errors.New("PluginOnLoad returned non-zero")
		}
		return nil
	})
}

func (p *dllPlugin) Event(event string, payload []byte) error {
	eventBytes := []byte(event)
	payloadCopy := make([]byte, len(payload))
	copy(payloadCopy, payload)

	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		cleanup := p.mem.SetupThreadTLS()
		defer cleanup()

		var eventPtr, payloadPtr uintptr
		eventLen := uintptr(len(eventBytes))
		payloadLen := uintptr(len(payloadCopy))
		if len(eventBytes) > 0 {
			eventPtr = uintptr(unsafe.Pointer(&eventBytes[0]))
		}
		if len(payloadCopy) > 0 {
			payloadPtr = uintptr(unsafe.Pointer(&payloadCopy[0]))
		}

		syscall.SyscallN(p.onEventAddr, eventPtr, eventLen, payloadPtr, payloadLen)
	}()
	return nil
}

func (p *dllPlugin) Unload() {
	_ = p.runOnWorker(func() error {
		if p.onUnloadAddr != 0 {
			syscall.SyscallN(p.onUnloadAddr)
		}
		return nil
	})
}

func (p *dllPlugin) Close() error {
	p.Unload()
	close(p.workCh)
	if p.pluginRuntime != "go" {
		if p.mem != nil {
			p.mem.Free()
			p.mem = nil
		}
	} else {
		p.mem = nil
	}
	return nil
}

func (p *dllPlugin) Runtime() string {
	return p.pluginRuntime
}
