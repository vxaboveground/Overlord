//go:build windows

package privacy

import (
	"log"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"overlord-client/cmd/agent/wininterop"

	"golang.org/x/sys/windows"
)

const (
	WS_EX_TOPMOST          = 0x00000008
	WS_EX_TOOLWINDOW       = 0x00000080
	WS_EX_NOACTIVATE       = 0x08000000
	WS_EX_TRANSPARENT      = 0x00000020
	WS_EX_LAYERED          = 0x00080000
	WS_POPUP               = 0x80000000
	WS_VISIBLE             = 0x10000000
	WDA_EXCLUDEFROMCAPTURE = 0x00000011

	WH_KEYBOARD_LL = 13
	WH_MOUSE_LL    = 14

	WM_QUIT       = 0x0012
	WM_TIMER      = 0x0113
	WM_KEYDOWN    = 0x0100
	WM_KEYUP      = 0x0101
	WM_SYSKEYDOWN = 0x0104
	WM_SYSKEYUP   = 0x0105

	LLKHF_INJECTED = 0x00000010

	LLMHF_INJECTED = 0x00000001

	VK_CONTROL  = 0x11
	VK_P        = 0x50
	VK_LCONTROL = 0xA2
	VK_RCONTROL = 0xA3

	SW_HIDE = 0
	SW_SHOW = 5

	SWP_NOSIZE     = 0x0001
	SWP_NOMOVE     = 0x0002
	SWP_NOACTIVATE = 0x0010
	SWP_SHOWWINDOW = 0x0040
	HWND_TOPMOST   = ^uintptr(0)

	privacyShieldTimerID       = 1
	privacyShieldIntervalMilli = 15

	LWA_ALPHA      = 0x00000002
	CURSOR_SHOWING = 0x00000001

	SM_XVIRTUALSCREEN  = 76
	SM_YVIRTUALSCREEN  = 77
	SM_CXVIRTUALSCREEN = 78
	SM_CYVIRTUALSCREEN = 79
)

var (
	user32 = syscall.NewLazyDLL("user32.dll")

	procCreateWindowExW            = user32.NewProc("CreateWindowExW")
	procDefWindowProcW             = user32.NewProc("DefWindowProcW")
	procDestroyWindow              = user32.NewProc("DestroyWindow")
	procGetMessageW                = user32.NewProc("GetMessageW")
	procTranslateMessage           = user32.NewProc("TranslateMessage")
	procDispatchMessageW           = user32.NewProc("DispatchMessageW")
	procPostThreadMessageW         = user32.NewProc("PostThreadMessageW")
	procRegisterClassExW           = user32.NewProc("RegisterClassExW")
	procSetWindowDisplayAffinity   = user32.NewProc("SetWindowDisplayAffinity")
	procSetWindowsHookExW          = user32.NewProc("SetWindowsHookExW")
	procUnhookWindowsHookEx        = user32.NewProc("UnhookWindowsHookEx")
	procCallNextHookEx             = user32.NewProc("CallNextHookEx")
	procShowWindow                 = user32.NewProc("ShowWindow")
	procUpdateWindow               = user32.NewProc("UpdateWindow")
	procSetWindowPos               = user32.NewProc("SetWindowPos")
	procSetLayeredWindowAttributes = user32.NewProc("SetLayeredWindowAttributes")
	procSetTimer                   = user32.NewProc("SetTimer")
	procKillTimer                  = user32.NewProc("KillTimer")
	procGetCursorInfo              = user32.NewProc("GetCursorInfo")
	procEnumDisplayMonitors        = user32.NewProc("EnumDisplayMonitors")
	procShowCursor                 = user32.NewProc("ShowCursor")
	procGetSystemMetrics           = user32.NewProc("GetSystemMetrics")
	procGetAsyncKeyState           = user32.NewProc("GetAsyncKeyState")

	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	procGetModuleHandleW   = kernel32.NewProc("GetModuleHandleW")
	procGetCurrentThreadID = kernel32.NewProc("GetCurrentThreadId")

	gdi32                = syscall.NewLazyDLL("gdi32.dll")
	procCreateSolidBrush = gdi32.NewProc("CreateSolidBrush")

	keyboardHook uintptr
	mouseHook    uintptr

	privacyWindows   []windows.HWND
	privacyWindowsMu sync.Mutex

	platformMu    sync.Mutex
	platform      *platformState
	cursorHideOps int
	shieldTimerID uintptr
	ctrlPressed   bool
)

type platformState struct {
	ready    chan error
	done     chan struct{}
	threadID uint32
}

type wndClassExW struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     windows.Handle
	hIcon         windows.Handle
	hCursor       windows.Handle
	hbrBackground windows.Handle
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       windows.Handle
}

type point struct {
	x int32
	y int32
}

type msg struct {
	hwnd    windows.HWND
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      point
}

type kbdllhookstruct struct {
	vkCode      uint32
	scanCode    uint32
	flags       uint32
	time        uint32
	dwExtraInfo uintptr
}

type msllhookstruct struct {
	pt          point
	mouseData   uint32
	flags       uint32
	time        uint32
	dwExtraInfo uintptr
}

type cursorInfo struct {
	cbSize      uint32
	flags       uint32
	hCursor     windows.Handle
	screenPoint point
}

func enablePlatform() error {
	platformMu.Lock()
	if platform != nil {
		platformMu.Unlock()
		return nil
	}

	st := &platformState{
		ready: make(chan error, 1),
		done:  make(chan struct{}),
	}
	platform = st
	go runPlatformThread(st)
	platformMu.Unlock()

	if err := <-st.ready; err != nil {
		platformMu.Lock()
		if platform == st {
			platform = nil
		}
		platformMu.Unlock()
		return err
	}

	return nil
}

func disablePlatform() {
	platformMu.Lock()
	st := platform
	platform = nil
	platformMu.Unlock()

	if st == nil {
		return
	}

	if st.threadID != 0 {
		procPostThreadMessageW.Call(uintptr(st.threadID), WM_QUIT, 0, 0)
	}
	<-st.done
}

func runPlatformThread(st *platformState) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(st.done)

	st.threadID = currentThreadID()

	if err := createPrivacyWindows(); err != nil {
		st.ready <- err
		return
	}

	if err := installInputHooks(); err != nil {
		destroyPrivacyWindows()
		st.ready <- err
		return
	}

	hideCursor()
	st.ready <- nil

	messagePump()

	stopPrivacyShieldTimer()
	restoreCursor()
	uninstallInputHooks()
	destroyPrivacyWindows()
}

func currentThreadID() uint32 {
	ret, _, _ := procGetCurrentThreadID.Call()
	return uint32(ret)
}

func createPrivacyWindows() error {
	className, err := syscall.UTF16PtrFromString("OverlordPrivacyWindow")
	if err != nil {
		return err
	}

	hInstance := getModuleHandle()

	brush, _, _ := procCreateSolidBrush.Call(0x00000000)

	wndClass := wndClassExW{
		cbSize:        uint32(unsafe.Sizeof(wndClassExW{})),
		style:         0,
		lpfnWndProc:   syscall.NewCallback(defWindowProcCallback),
		hInstance:     windows.Handle(hInstance),
		hCursor:       0,
		hbrBackground: windows.Handle(brush),
		lpszClassName: className,
	}

	ret, _, _ := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wndClass)))
	if ret == 0 {
		if err := syscall.GetLastError(); err != windows.ERROR_CLASS_ALREADY_EXISTS {
			return err
		}
	}

	monitors := enumerateMonitors()
	if len(monitors) == 0 {
		left := getSystemMetric(SM_XVIRTUALSCREEN)
		top := getSystemMetric(SM_YVIRTUALSCREEN)
		width := getSystemMetric(SM_CXVIRTUALSCREEN)
		height := getSystemMetric(SM_CYVIRTUALSCREEN)
		if width > 0 && height > 0 {
			monitors = append(monitors, monitorRect{
				left:   left,
				top:    top,
				right:  left + width,
				bottom: top + height,
			})
		}
	}

	for _, mon := range monitors {
		hwnd, _, _ := procCreateWindowExW.Call(
			uintptr(WS_EX_TOPMOST|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE|WS_EX_TRANSPARENT|WS_EX_LAYERED),
			uintptr(unsafe.Pointer(className)),
			0,
			uintptr(WS_POPUP|WS_VISIBLE),
			uintptr(mon.left),
			uintptr(mon.top),
			uintptr(mon.right-mon.left),
			uintptr(mon.bottom-mon.top),
			0, 0, uintptr(hInstance), 0,
		)
		if hwnd == 0 {
			log.Printf("privacy: failed to create window for monitor [%d %d %d %d]: %v",
				mon.left, mon.top, mon.right, mon.bottom, syscall.GetLastError())
			continue
		}

		procSetWindowDisplayAffinity.Call(hwnd, uintptr(WDA_EXCLUDEFROMCAPTURE))
		procSetLayeredWindowAttributes.Call(hwnd, 0, 255, uintptr(LWA_ALPHA))
		procSetWindowPos.Call(
			hwnd,
			HWND_TOPMOST,
			uintptr(mon.left),
			uintptr(mon.top),
			uintptr(mon.right-mon.left),
			uintptr(mon.bottom-mon.top),
			uintptr(SWP_NOACTIVATE|SWP_SHOWWINDOW),
		)
		procShowWindow.Call(hwnd, SW_SHOW)
		procUpdateWindow.Call(hwnd)

		privacyWindowsMu.Lock()
		privacyWindows = append(privacyWindows, windows.HWND(hwnd))
		privacyWindowsMu.Unlock()
	}

	if len(privacyWindows) == 0 {
		return syscall.GetLastError()
	}

	log.Printf("privacy: created %d privacy window(s)", len(privacyWindows))
	return nil
}

func getSystemMetric(index int32) int32 {
	ret, _, _ := procGetSystemMetrics.Call(uintptr(index))
	return int32(ret)
}

func hideCursor() {
	hideCursorIfVisible()
}

// Windows and applications can make the cursor visible again when injected
// mouse input crosses a window boundary. Keep driving the ShowCursor display
// count negative while privacy mode is active, and remember every decrement so
// it can be balanced exactly when privacy mode stops.
func hideCursorIfVisible() {
	ci := cursorInfo{cbSize: uint32(unsafe.Sizeof(cursorInfo{}))}
	visible, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci)))
	if visible == 0 || ci.flags&CURSOR_SHOWING == 0 {
		return
	}

	attempts := 0
	for {
		count := showCursor(false)
		cursorHideOps++
		attempts++
		if count < 0 || attempts > 32 {
			break
		}
	}
}

func restoreCursor() {
	for i := 0; i < cursorHideOps; i++ {
		showCursor(true)
	}
	cursorHideOps = 0
}

func showCursor(show bool) int32 {
	arg := uintptr(0)
	if show {
		arg = 1
	}
	ret, _, _ := procShowCursor.Call(arg)
	return int32(ret)
}

func destroyPrivacyWindows() {
	privacyWindowsMu.Lock()
	windows := privacyWindows
	privacyWindows = nil
	privacyWindowsMu.Unlock()

	for _, hwnd := range windows {
		procShowWindow.Call(uintptr(hwnd), SW_HIDE)
		procDestroyWindow.Call(uintptr(hwnd))
	}
	log.Printf("privacy: destroyed %d privacy window(s)", len(windows))
}

func startPrivacyShieldTimer() {
	timer, _, _ := procSetTimer.Call(0, privacyShieldTimerID, privacyShieldIntervalMilli, 0)
	shieldTimerID = timer
	if timer == 0 {
		log.Printf("privacy: failed to start shield timer: %v", syscall.GetLastError())
	}
}

func stopPrivacyShieldTimer() {
	if shieldTimerID != 0 {
		procKillTimer.Call(0, shieldTimerID)
		shieldTimerID = 0
	}
}

// Shell surfaces such as Start, search, Alt+Tab, and system flyouts can be
// placed above an existing topmost window after an injected key is handled.
// Reasserting the excluded privacy windows keeps those surfaces covered without
// activating the shield or interfering with the remotely controlled window.
func reassertPrivacyShield() {
	privacyWindowsMu.Lock()
	windows := append([]windows.HWND(nil), privacyWindows...)
	privacyWindowsMu.Unlock()

	for _, hwnd := range windows {
		procSetWindowPos.Call(
			uintptr(hwnd),
			HWND_TOPMOST,
			0, 0, 0, 0,
			uintptr(SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_SHOWWINDOW),
		)
	}
	hideCursorIfVisible()
}

type monitorRect struct {
	left, top, right, bottom int32
}

func enumerateMonitors() []monitorRect {
	var monitors []monitorRect
	var mu sync.Mutex

	cb := syscall.NewCallback(func(hMonitor, hdc, lprcMonitor, lparam uintptr) uintptr {
		rc := (*rect)(wininterop.Pointer(lprcMonitor))
		mu.Lock()
		monitors = append(monitors, monitorRect{
			left:   rc.left,
			top:    rc.top,
			right:  rc.right,
			bottom: rc.bottom,
		})
		mu.Unlock()
		return 1
	})

	procEnumDisplayMonitors.Call(0, 0, cb, 0)
	return monitors
}

type rect struct {
	left   int32
	top    int32
	right  int32
	bottom int32
}

func defWindowProcCallback(hwnd windows.HWND, msg uint32, wParam uintptr, lParam uintptr) uintptr {
	ret, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
	return ret
}

func getModuleHandle() windows.Handle {
	ret, _, _ := procGetModuleHandleW.Call(0)
	return windows.Handle(ret)
}

func installInputHooks() error {
	hInstance := getModuleHandle()

	kbCb := syscall.NewCallback(keyboardHookProc)
	kh, _, err := procSetWindowsHookExW.Call(
		uintptr(WH_KEYBOARD_LL),
		kbCb,
		uintptr(hInstance),
		0,
	)
	if kh == 0 {
		return err
	}
	keyboardHook = kh

	mCb := syscall.NewCallback(mouseHookProc)
	mh, _, err := procSetWindowsHookExW.Call(
		uintptr(WH_MOUSE_LL),
		mCb,
		uintptr(hInstance),
		0,
	)
	if mh == 0 {
		procUnhookWindowsHookEx.Call(keyboardHook)
		keyboardHook = 0
		return err
	}
	mouseHook = mh

	log.Printf("privacy: input hooks installed (kb=%d mouse=%d)", keyboardHook, mouseHook)
	return nil
}

func uninstallInputHooks() {
	if keyboardHook != 0 {
		procUnhookWindowsHookEx.Call(keyboardHook)
		keyboardHook = 0
	}
	if mouseHook != 0 {
		procUnhookWindowsHookEx.Call(mouseHook)
		mouseHook = 0
	}
	log.Printf("privacy: input hooks removed")
}

func keyboardHookProc(nCode int, wParam uintptr, lParam uintptr) uintptr {
	if nCode < 0 {
		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	}

	m := Get()
	if !m.IsEnabled() {
		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	}

	kb := (*kbdllhookstruct)(wininterop.Pointer(lParam))

	if kb.dwExtraInfo == InputMarker() {
		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	}

	if kb.flags&LLKHF_INJECTED != 0 {
		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	}

	switch kb.vkCode {
	case VK_CONTROL, VK_LCONTROL, VK_RCONTROL:
		if wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN {
			ctrlPressed = true
		} else {
			ctrlPressed = false
		}
		return 1

	}

	return 1
}

func mouseHookProc(nCode int, wParam uintptr, lParam uintptr) uintptr {
	if nCode < 0 {
		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	}

	if !Get().IsEnabled() {
		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	}

	ms := (*msllhookstruct)(wininterop.Pointer(lParam))

	if ms.dwExtraInfo == InputMarker() {
		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	}

	if ms.flags&LLMHF_INJECTED != 0 {
		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	}

	return 1
}

func messagePump() {
	log.Printf("privacy: message pump starting")
	startPrivacyShieldTimer()

	var m msg
	for {
		ret, _, _ := procGetMessageW.Call(
			uintptr(unsafe.Pointer(&m)),
			0, 0, 0,
		)
		if ret == 0 || ret == ^uintptr(0) {
			break
		}
		if m.message == WM_TIMER && m.wParam == shieldTimerID {
			reassertPrivacyShield()
			continue
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}

	log.Printf("privacy: message pump stopped")
}
