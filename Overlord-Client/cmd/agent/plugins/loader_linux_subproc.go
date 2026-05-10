//go:build linux && cgo

package plugins

/*
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdint.h>

#ifndef MFD_CLOEXEC
#define MFD_CLOEXEC 0x0001U
#endif

static int make_socketpair(int fds[2]) {
	return socketpair(AF_UNIX, SOCK_STREAM, 0, fds);
}

static int sp_memfd_create(void) {
	return (int)syscall(SYS_memfd_create, "plugin", MFD_CLOEXEC);
}

// No CLOEXEC — the fd must survive fexecve/exec into the shim process.
static int sp_memfd_create_nocloe(void) {
	return (int)syscall(SYS_memfd_create, "ph", 0);
}

static int sp_write_all(int fd, const void* buf, size_t len) {
	const char* p = (const char*)buf;
	while (len > 0) {
		ssize_t n = write(fd, p, len);
		if (n <= 0) return -1;
		p += n;
		len -= (size_t)n;
	}
	return 0;
}
*/
import "C"

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"sync"
	"syscall"
	"unsafe"
)

// Message type constants — must match plugin_host.c
const (
	phMsgLoad       = 0x01
	phMsgEvent      = 0x02
	phMsgUnload     = 0x03
	phMsgCallback   = 0x10
	phMsgReady      = 0x11
	phMsgErr        = 0x12
	phMsgLoadResult = 0x13
)

// loadNativePluginSubproc attempts to load the plugin by fork+exec-ing the
// embedded plugin_host shim.  Returns an error if pluginHostBinary is empty
// (not compiled) or if any setup step fails.
func loadNativePluginSubproc(soData []byte) (NativePlugin, error) {
	if len(pluginHostBinary) == 0 {
		return nil, errors.New("plugin host shim not available for this architecture")
	}

	// Write the .so to a memfd so the shim can dlopen it.
	soFd := int(C.sp_memfd_create())
	if soFd < 0 {
		return nil, errors.New("memfd_create failed for plugin .so")
	}
	if C.sp_write_all(C.int(soFd), unsafe.Pointer(&soData[0]), C.size_t(len(soData))) != 0 {
		syscall.Close(soFd)
		return nil, errors.New("write to plugin .so memfd failed")
	}

	// Write the shim binary to a memfd WITHOUT close-on-exec so it survives exec.
	shimFdC := C.sp_memfd_create_nocloe()
	if shimFdC < 0 {
		syscall.Close(soFd)
		return nil, errors.New("memfd_create for shim failed")
	}
	shimFile := os.NewFile(uintptr(shimFdC), "plugin_host_shim")
	if _, err := shimFile.Write(pluginHostBinary); err != nil {
		shimFile.Close()
		syscall.Close(soFd)
		return nil, fmt.Errorf("write shim to memfd: %w", err)
	}

	// Create a socketpair for bidirectional communication.
	var fds [2]C.int
	if C.make_socketpair(&fds[0]) != 0 {
		shimFile.Close()
		syscall.Close(soFd)
		return nil, errors.New("socketpair failed")
	}
	parentSock := int(fds[0])
	childSock  := int(fds[1])

	// ForkExec the shim.  Pass fds to the child via ProcAttr.Files:
	//   child fd 0 = /dev/null
	//   child fd 1 = parent stdout (for debug output)
	//   child fd 2 = parent stderr
	//   child fd 3 = .so memfd
	//   child fd 4 = child end of socketpair
	devNull, _ := syscall.Open("/dev/null", syscall.O_RDONLY, 0)
	shimPath := fmt.Sprintf("/proc/self/fd/%d", int(shimFdC))
	pid, err := syscall.ForkExec(shimPath, []string{"plugin_host",
		strconv.Itoa(3), strconv.Itoa(4)},
		&syscall.ProcAttr{
			Files: []uintptr{
				uintptr(devNull),
				1,
				2,
				uintptr(soFd),
				uintptr(childSock),
			},
		},
	)
	// Parent no longer needs these fds.
	syscall.Close(devNull)
	syscall.Close(soFd)
	syscall.Close(childSock)
	shimFile.Close()

	if err != nil {
		syscall.Close(parentSock)
		return nil, fmt.Errorf("forkexec plugin_host: %w", err)
	}

	p := &subProcPlugin{
		pid:          pid,
		sock:         os.NewFile(uintptr(parentSock), "plugin_sock"),
		loadResultCh: make(chan error, 1),
		stopCh:       make(chan struct{}),
	}
	go p.readLoop()

	// Wait for MSG_READY (or MSG_ERR) to confirm the shim loaded the .so.
	select {
	case err := <-p.loadResultCh:
		if err != nil {
			p.sock.Close()
			return nil, err
		}
	case <-p.stopCh:
		p.sock.Close()
		return nil, errors.New("plugin host exited before sending READY")
	}

	return p, nil
}

// subProcPlugin implements NativePlugin by routing calls through the shim subprocess.
type subProcPlugin struct {
	pid           int
	sock          *os.File
	mu            sync.Mutex
	pluginRuntime string
	sendFn        func(string, []byte)
	loadResultCh  chan error
	stopCh        chan struct{}
	stopOnce      sync.Once
}

func (p *subProcPlugin) readLoop() {
	defer p.stopOnce.Do(func() { close(p.stopCh) })

	for {
		msgType, payload, err := p.recvMsg()
		if err != nil {
			return
		}

		switch msgType {
		case phMsgReady:
			p.mu.Lock()
			p.pluginRuntime = string(payload)
			p.mu.Unlock()
			// Signal the constructor that the shim is ready.
			select {
			case p.loadResultCh <- nil:
			default:
			}

		case phMsgErr:
			select {
			case p.loadResultCh <- fmt.Errorf("plugin_host: %s", payload):
			default:
			}
			return

		case phMsgLoadResult:
			if len(payload) > 0 && payload[0] != 0 {
				select {
				case p.loadResultCh <- errors.New("PluginOnLoad returned non-zero"):
				default:
				}
			} else {
				select {
				case p.loadResultCh <- nil:
				default:
				}
			}

		case phMsgCallback:
			if len(payload) < 6 {
				continue
			}
			evLen := int(binary.LittleEndian.Uint16(payload[0:2]))
			if len(payload) < 2+evLen+4 {
				continue
			}
			plLen := int(binary.LittleEndian.Uint32(payload[2+evLen:]))
			event := string(payload[2 : 2+evLen])
			var pl []byte
			if plLen > 0 && len(payload) >= 2+evLen+4+plLen {
				pl = payload[2+evLen+4 : 2+evLen+4+plLen]
			}
			p.mu.Lock()
			fn := p.sendFn
			p.mu.Unlock()
			if fn != nil {
				fn(event, pl)
			}
		}
	}
}

func (p *subProcPlugin) sendMsg(msgType uint8, payload []byte) error {
	total := uint32(1 + len(payload))
	hdr := make([]byte, 5)
	binary.LittleEndian.PutUint32(hdr[:4], total)
	hdr[4] = msgType
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, err := p.sock.Write(hdr); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := p.sock.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

func (p *subProcPlugin) recvMsg() (uint8, []byte, error) {
	hdr := make([]byte, 5)
	if _, err := io.ReadFull(p.sock, hdr); err != nil {
		return 0, nil, err
	}
	total := binary.LittleEndian.Uint32(hdr[:4])
	if total == 0 {
		return 0, nil, errors.New("zero-length message")
	}
	msgType := hdr[4]
	payloadLen := total - 1
	if payloadLen == 0 {
		return msgType, nil, nil
	}
	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(p.sock, payload); err != nil {
		return 0, nil, err
	}
	return msgType, payload, nil
}

func (p *subProcPlugin) Load(send func(string, []byte), hostInfo []byte) error {
	p.mu.Lock()
	p.sendFn = send
	p.mu.Unlock()

	// Send MSG_LOAD; shim will call PluginOnLoad and reply with MSG_LOAD_RESULT.
	if err := p.sendMsg(phMsgLoad, hostInfo); err != nil {
		return fmt.Errorf("send MSG_LOAD: %w", err)
	}

	select {
	case err := <-p.loadResultCh:
		return err
	case <-p.stopCh:
		return errors.New("plugin host exited during load")
	}
}

func (p *subProcPlugin) Event(event string, payload []byte) error {
	evBytes := []byte(event)
	evLen := len(evBytes)
	plLen := len(payload)
	msg := make([]byte, 2+evLen+4+plLen)
	binary.LittleEndian.PutUint16(msg[0:2], uint16(evLen))
	copy(msg[2:], evBytes)
	binary.LittleEndian.PutUint32(msg[2+evLen:], uint32(plLen))
	if plLen > 0 {
		copy(msg[2+evLen+4:], payload)
	}
	return p.sendMsg(phMsgEvent, msg)
}

func (p *subProcPlugin) Unload() {
	_ = p.sendMsg(phMsgUnload, nil)
}

func (p *subProcPlugin) Close() error {
	p.Unload()
	p.sock.Close()
	// Reap the child process.
	if p.pid > 0 {
		syscall.Wait4(p.pid, nil, 0, nil)
	}
	return nil
}

func (p *subProcPlugin) Runtime() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.pluginRuntime
}
