//go:build windows

package handlers

import (
	"syscall"
	"unsafe"
)

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	procSetCursorPos     = user32.NewProc("SetCursorPos")
	procSendInput        = user32.NewProc("SendInput")
	procMapVirtualKeyW   = user32.NewProc("MapVirtualKeyW")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")
)

const (
	MOUSEEVENTF_MOVE        = 0x0001
	MOUSEEVENTF_LEFTDOWN    = 0x0002
	MOUSEEVENTF_LEFTUP      = 0x0004
	MOUSEEVENTF_RIGHTDOWN   = 0x0008
	MOUSEEVENTF_RIGHTUP     = 0x0010
	MOUSEEVENTF_MIDDLEDOWN  = 0x0020
	MOUSEEVENTF_MIDDLEUP    = 0x0040
	MOUSEEVENTF_WHEEL       = 0x0800
	MOUSEEVENTF_ABSOLUTE    = 0x8000
	MOUSEEVENTF_VIRTUALDESK = 0x4000

	INPUT_MOUSE    = 0
	INPUT_KEYBOARD = 1

	KEYEVENTF_EXTENDEDKEY = 0x0001
	KEYEVENTF_KEYUP       = 0x0002
	KEYEVENTF_UNICODE     = 0x0004
	KEYEVENTF_SCANCODE    = 0x0008

	SM_XVIRTUALSCREEN  = 76
	SM_YVIRTUALSCREEN  = 77
	SM_CXVIRTUALSCREEN = 78
	SM_CYVIRTUALSCREEN = 79
)

type mouseInput struct {
	dx          int32
	dy          int32
	mouseData   uint32
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

type keybdInput struct {
	wVk         uint16
	wScan       uint16
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

type hardwareInput struct {
	uMsg    uint32
	wParamL uint16
	wParamH uint16
}

type input struct {
	inputType uint32
	_         uint32
	union     [32]byte
}

func setCursorPos(x, y int32) {
	if !sendMouseMoveAbsolute(x, y) {
		_, _, _ = procSetCursorPos.Call(uintptr(x), uintptr(y))
	}
}

func sendMouseDown(button int) {
	switch button {
	case 0:
		sendMouseInput(MOUSEEVENTF_LEFTDOWN, 0)
	case 2:
		sendMouseInput(MOUSEEVENTF_RIGHTDOWN, 0)
	case 1:
		sendMouseInput(MOUSEEVENTF_MIDDLEDOWN, 0)
	}
}

func sendMouseUp(button int) {
	switch button {
	case 0:
		sendMouseInput(MOUSEEVENTF_LEFTUP, 0)
	case 2:
		sendMouseInput(MOUSEEVENTF_RIGHTUP, 0)
	case 1:
		sendMouseInput(MOUSEEVENTF_MIDDLEUP, 0)
	}
}

func sendMouseWheel(delta int32) {
	sendMouseInput(MOUSEEVENTF_WHEEL, uint32(delta))
}

func sendMouseInput(flags uint32, mouseData uint32) {
	//garble:controlflow block_splits=10 junk_jumps=10 flatten_passes=2
	var inp input
	inp.inputType = INPUT_MOUSE
	mi := (*mouseInput)(unsafe.Pointer(&inp.union[0]))
	mi.dx = 0
	mi.dy = 0
	mi.mouseData = mouseData
	mi.dwFlags = flags
	mi.time = 0
	mi.dwExtraInfo = 0
	_, _, _ = procSendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
}

func sendMouseMoveAbsolute(x, y int32) bool {
	left := getSystemMetrics(SM_XVIRTUALSCREEN)
	top := getSystemMetrics(SM_YVIRTUALSCREEN)
	width := getSystemMetrics(SM_CXVIRTUALSCREEN)
	height := getSystemMetrics(SM_CYVIRTUALSCREEN)
	if width <= 1 || height <= 1 {
		return false
	}

	const maxCoord = 65535
	relX := int64(x) - int64(left)
	relY := int64(y) - int64(top)
	if relX < 0 {
		relX = 0
	}
	if relY < 0 {
		relY = 0
	}
	if relX > int64(width-1) {
		relX = int64(width - 1)
	}
	if relY > int64(height-1) {
		relY = int64(height - 1)
	}

	normX := int32(relX * maxCoord / int64(width-1))
	normY := int32(relY * maxCoord / int64(height-1))

	var inp input
	inp.inputType = INPUT_MOUSE
	mi := (*mouseInput)(unsafe.Pointer(&inp.union[0]))
	mi.dx = normX
	mi.dy = normY
	mi.mouseData = 0
	mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
	mi.time = 0
	mi.dwExtraInfo = 0
	r, _, _ := procSendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
	return r != 0
}

func getSystemMetrics(index int32) int32 {
	r, _, _ := procGetSystemMetrics.Call(uintptr(index))
	return int32(r)
}

func sendKeyDown(vk uint16) {
	sendKeyInput(vk, false)
}

func sendKeyUp(vk uint16) {
	sendKeyInput(vk, true)
}

func sendKeyInput(vk uint16, keyUp bool) {
	//garble:controlflow block_splits=10 junk_jumps=10 flatten_passes=2
	var inp input
	inp.inputType = INPUT_KEYBOARD
	ki := (*keybdInput)(unsafe.Pointer(&inp.union[0]))
	ki.wVk = vk
	ki.wScan = uint16(mapVirtualKey(vk))
	flags := uint32(0)
	if keyUp {
		flags |= KEYEVENTF_KEYUP
	}
	if isExtendedKey(vk) {
		flags |= KEYEVENTF_EXTENDEDKEY
	}
	ki.dwFlags = flags
	ki.time = 0
	ki.dwExtraInfo = 0
	_, _, _ = procSendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
}

func isExtendedKey(vk uint16) bool {
	switch vk {
	case 0xA3, // VK_RCONTROL
		0xA5, // VK_RMENU
		0x21, // VK_PRIOR
		0x22, // VK_NEXT
		0x23, // VK_END
		0x24, // VK_HOME
		0x25, // VK_LEFT
		0x26, // VK_UP
		0x27, // VK_RIGHT
		0x28, // VK_DOWN
		0x2D, // VK_INSERT
		0x2E, // VK_DELETE
		0x6F, // VK_DIVIDE
		0x90: // VK_NUMLOCK
		return true
	default:
		return false
	}
}

func mapVirtualKey(vk uint16) uint32 {
	ret, _, _ := procMapVirtualKeyW.Call(uintptr(vk), 0)
	return uint32(ret)
}

func sendTextInput(text string) {
	for _, r := range text {
		switch r {
		case '\r', '\n':
			sendKeyDown(0x0D)
			sendKeyUp(0x0D)
		case '\t':
			sendKeyDown(0x09)
			sendKeyUp(0x09)
		case '\b':
			sendKeyDown(0x08)
			sendKeyUp(0x08)
		default:
			sendUnicodeRune(r)
		}
	}
}

func sendUnicodeRune(r rune) {
	var inp input
	inp.inputType = INPUT_KEYBOARD
	ki := (*keybdInput)(unsafe.Pointer(&inp.union[0]))
	ki.wVk = 0
	ki.wScan = uint16(r)
	ki.dwFlags = KEYEVENTF_UNICODE
	_, _, _ = procSendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))

	var inpUp input
	inpUp.inputType = INPUT_KEYBOARD
	kiUp := (*keybdInput)(unsafe.Pointer(&inpUp.union[0]))
	kiUp.wVk = 0
	kiUp.wScan = uint16(r)
	kiUp.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
	_, _, _ = procSendInput.Call(1, uintptr(unsafe.Pointer(&inpUp)), unsafe.Sizeof(inpUp))
}

func keyCodeToVK(code string) uint16 {
	vkMap := map[string]uint16{
		"KeyA": 0x41, "KeyB": 0x42, "KeyC": 0x43, "KeyD": 0x44, "KeyE": 0x45,
		"KeyF": 0x46, "KeyG": 0x47, "KeyH": 0x48, "KeyI": 0x49, "KeyJ": 0x4A,
		"KeyK": 0x4B, "KeyL": 0x4C, "KeyM": 0x4D, "KeyN": 0x4E, "KeyO": 0x4F,
		"KeyP": 0x50, "KeyQ": 0x51, "KeyR": 0x52, "KeyS": 0x53, "KeyT": 0x54,
		"KeyU": 0x55, "KeyV": 0x56, "KeyW": 0x57, "KeyX": 0x58, "KeyY": 0x59, "KeyZ": 0x5A,
		"Digit0": 0x30, "Digit1": 0x31, "Digit2": 0x32, "Digit3": 0x33, "Digit4": 0x34,
		"Digit5": 0x35, "Digit6": 0x36, "Digit7": 0x37, "Digit8": 0x38, "Digit9": 0x39,
		"Enter": 0x0D, "Space": 0x20, "Backspace": 0x08, "Tab": 0x09, "Escape": 0x1B,
		"ShiftLeft": 0xA0, "ShiftRight": 0xA1, "ControlLeft": 0xA2, "ControlRight": 0xA3,
		"AltLeft": 0xA4, "AltRight": 0xA5, "MetaLeft": 0x5B, "MetaRight": 0x5C,
		"ArrowLeft": 0x25, "ArrowUp": 0x26, "ArrowRight": 0x27, "ArrowDown": 0x28,
		"Delete": 0x2E, "Home": 0x24, "End": 0x23, "PageUp": 0x21, "PageDown": 0x22,
		"F1": 0x70, "F2": 0x71, "F3": 0x72, "F4": 0x73, "F5": 0x74, "F6": 0x75,
		"F7": 0x76, "F8": 0x77, "F9": 0x78, "F10": 0x79, "F11": 0x7A, "F12": 0x7B,
		"Slash":         0xBF,
		"Backquote":     0xC0,
		"Minus":         0xBD,
		"Equal":         0xBB,
		"BracketLeft":   0xDB,
		"BracketRight":  0xDD,
		"Backslash":     0xDC,
		"IntlBackslash": 0xDC,
		"Semicolon":     0xBA,
		"Quote":         0xDE,
		"Comma":         0xBC,
		"Period":        0xBE,
	}
	if vk, ok := vkMap[code]; ok {
		return vk
	}
	return 0
}
