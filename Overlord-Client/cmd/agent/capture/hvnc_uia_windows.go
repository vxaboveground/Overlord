//go:build windows

package capture

import (
	"fmt"
	"log"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	ole32DLL             = syscall.NewLazyDLL("ole32.dll")
	procCoInitializeEx   = ole32DLL.NewProc("CoInitializeEx")
	procCoCreateInstance = ole32DLL.NewProc("CoCreateInstance")
	procCoUninitialize   = ole32DLL.NewProc("CoUninitialize")

	procGetClassNameW            = user32.NewProc("GetClassNameW")
	procEnumChildWindows         = user32.NewProc("EnumChildWindows")
	procRealChildWindowFromPoint = user32.NewProc("RealChildWindowFromPoint")
)

const (
	COINIT_MULTITHREADED = 0x0
	CLSCTX_INPROC_SERVER = 0x1
	CLSCTX_ALL           = 0x17

	uiaTreeScopeElement     = 0x1
	uiaTreeScopeChildren    = 0x2
	uiaTreeScopeSubtree     = 0x7
	uiaTreeScopeDescendants = 0x4

	uiaInvokePatternID         = 10000
	uiaSelectionPatternID      = 10001
	uiaValuePatternID          = 10002
	uiaRangeValuePatternID     = 10003
	uiaScrollPatternID         = 10004
	uiaExpandCollapsePatternID = 10005
	uiaTogglePatternID         = 10015
	uiaTransformPatternID      = 10016
	uiaScrollItemPatternID     = 10017
	uiaSelectionItemPatternID  = 10010

	uiaScrollAmountLargeDecrement = 0
	uiaScrollAmountSmallDecrement = 1
	uiaScrollAmountNoAmount       = 2
	uiaScrollAmountLargeIncrement = 3
	uiaScrollAmountSmallIncrement = 4

	uiaExpandCollapseStateCollapsed         = 0
	uiaExpandCollapseStateExpanded          = 1
	uiaExpandCollapseStatePartiallyExpanded = 2
	uiaExpandCollapseStateLeafNode          = 3

	uiaBoundingRectanglePropertyID  = 30001
	uiaClassNamePropertyID          = 30012
	uiaNativeWindowHandlePropertyID = 30020
	uiaIsEnabledPropertyID          = 30010
	uiaControlTypePropertyID        = 30003
	uiaNamePropertyID               = 30005
	uiaHasKeyboardFocusPropertyID   = 30008

	VT_EMPTY = 0
	VT_I4    = 3
	VT_BSTR  = 8
	VT_R8    = 5
	VT_BOOL  = 11

	WM_POINTERUPDATE = 0x0245
	WM_POINTERDOWN   = 0x0246
	WM_POINTERUP     = 0x0247
	WM_POINTERWHEEL  = 0x024E

	WM_CONTEXTMENU = 0x007B
)

var (
	CLSID_CUIAutomation = windows.GUID{
		Data1: 0xFF48DBA4, Data2: 0x60EF, Data3: 0x4201,
		Data4: [8]byte{0xAA, 0x87, 0x54, 0x10, 0x3E, 0xEF, 0x59, 0x4E},
	}
	IID_IUIAutomation = windows.GUID{
		Data1: 0x30CBE57D, Data2: 0xD9D0, Data3: 0x452A,
		Data4: [8]byte{0xAB, 0x13, 0x7A, 0xC5, 0xAC, 0x48, 0x25, 0xEE},
	}
	IID_IUIAutomationElement = windows.GUID{
		Data1: 0xD22108AA, Data2: 0x8AC5, Data3: 0x49A5,
		Data4: [8]byte{0x83, 0x7B, 0x37, 0xBB, 0xB3, 0xD7, 0x59, 0x1E},
	}
	IID_IUIAutomationInvokePattern = windows.GUID{
		Data1: 0xFB377FBE, Data2: 0x8EA6, Data3: 0x46D5,
		Data4: [8]byte{0x9C, 0x73, 0x64, 0x99, 0x64, 0x2D, 0x30, 0x59},
	}
	IID_IUIAutomationTogglePattern = windows.GUID{
		Data1: 0x94CF8058, Data2: 0x9B8D, Data3: 0x4AB9,
		Data4: [8]byte{0x8B, 0xFD, 0x4C, 0xD0, 0xA3, 0x3C, 0x8C, 0x70},
	}
	IID_IUIAutomationScrollPattern = windows.GUID{
		Data1: 0x88F4D42A, Data2: 0xE5F9, Data3: 0x459B,
		Data4: [8]byte{0xB1, 0xDE, 0x77, 0xE3, 0x5F, 0x1C, 0x8D, 0x3A},
	}
	IID_IUIAutomationValuePattern = windows.GUID{
		Data1: 0xA94CD8B1, Data2: 0x0844, Data3: 0x4CD6,
		Data4: [8]byte{0x9D, 0x2D, 0x64, 0x05, 0x37, 0xAB, 0x39, 0xE9},
	}
	IID_IUIAutomationExpandCollapsePattern = windows.GUID{
		Data1: 0x619BE086, Data2: 0x1F4E, Data3: 0x4EE4,
		Data4: [8]byte{0xBA, 0xFA, 0x21, 0x01, 0x28, 0x73, 0x87, 0x30},
	}
	IID_IUIAutomationSelectionItemPattern = windows.GUID{
		Data1: 0xA8EFA66A, Data2: 0x0FDA, Data3: 0x421A,
		Data4: [8]byte{0x91, 0x94, 0x38, 0x02, 0x1F, 0x35, 0x78, 0xEA},
	}
	IID_IUIAutomationTransformPattern = windows.GUID{
		Data1: 0xA9B55844, Data2: 0xA55B, Data3: 0x4EF0,
		Data4: [8]byte{0x92, 0x6D, 0x56, 0x9C, 0x16, 0xFF, 0x89, 0xBB},
	}
)

type iuiAutomationVtbl struct {
	// IUnknown (0-2)
	QueryInterface uintptr
	AddRef         uintptr
	Release        uintptr
	// IUIAutomation (3+)
	CompareElements                   uintptr // 3
	CompareRuntimeIds                 uintptr // 4
	GetRootElement                    uintptr // 5
	ElementFromHandle                 uintptr // 6
	ElementFromPoint                  uintptr // 7
	GetFocusedElement                 uintptr // 8
	GetRootElementBuildCache          uintptr // 9
	ElementFromHandleBuildCache       uintptr // 10
	ElementFromPointBuildCache        uintptr // 11
	GetFocusedElementBuildCache       uintptr // 12
	CreateTreeWalker                  uintptr // 13
	ControlViewWalker                 uintptr // 14
	ContentViewWalker                 uintptr // 15
	RawViewWalker                     uintptr // 16
	RawViewCondition                  uintptr // 17
	ControlViewCondition              uintptr // 18
	ContentViewCondition              uintptr // 19
	CreateCacheRequest                uintptr // 20
	CreateTrueCondition               uintptr // 21
	CreateFalseCondition              uintptr // 22
	CreatePropertyCondition           uintptr // 23
	CreatePropertyConditionEx         uintptr // 24
	CreateAndCondition                uintptr // 25
	CreateAndConditionFromArray       uintptr // 26
	CreateAndConditionFromNativeArray uintptr // 27
	CreateOrCondition                 uintptr // 28
	CreateOrConditionFromArray        uintptr // 29
	CreateOrConditionFromNativeArray  uintptr // 30
	CreateNotCondition                uintptr // 31
}

type iuiAutomation struct {
	lpVtbl *iuiAutomationVtbl
}

func (a *iuiAutomation) Release() {
	if a == nil || a.lpVtbl == nil {
		return
	}
	syscall.SyscallN(a.lpVtbl.Release, uintptr(unsafe.Pointer(a)))
}

func (a *iuiAutomation) ElementFromHandle(hwnd uintptr) *iuiAutomationElement {
	var elem *iuiAutomationElement
	hr := callSyscallN(a.lpVtbl.ElementFromHandle,
		uintptr(unsafe.Pointer(a)),
		hwnd,
		uintptr(unsafe.Pointer(&elem)),
	)
	if hr != S_OK || elem == nil {
		return nil
	}
	return elem
}

func (a *iuiAutomation) ElementFromPoint(pt point) *iuiAutomationElement {
	var elem *iuiAutomationElement
	hr := callSyscallN(a.lpVtbl.ElementFromPoint,
		uintptr(unsafe.Pointer(a)),
		uintptr(*(*int64)(unsafe.Pointer(&pt))),
		uintptr(unsafe.Pointer(&elem)),
	)
	if hr != S_OK || elem == nil {
		return nil
	}
	return elem
}

func (a *iuiAutomation) GetFocusedElement() *iuiAutomationElement {
	var elem *iuiAutomationElement
	hr := callSyscallN(a.lpVtbl.GetFocusedElement,
		uintptr(unsafe.Pointer(a)),
		uintptr(unsafe.Pointer(&elem)),
	)
	if hr != S_OK || elem == nil {
		return nil
	}
	return elem
}

func (a *iuiAutomation) CreateTrueCondition() *iuiAutomationCondition {
	var cond *iuiAutomationCondition
	hr := callSyscallN(a.lpVtbl.CreateTrueCondition,
		uintptr(unsafe.Pointer(a)),
		uintptr(unsafe.Pointer(&cond)),
	)
	if hr != S_OK || cond == nil {
		return nil
	}
	return cond
}

func (a *iuiAutomation) GetControlViewWalker() *iuiAutomationTreeWalker {
	var walker *iuiAutomationTreeWalker
	hr := callSyscallN(a.lpVtbl.ControlViewWalker,
		uintptr(unsafe.Pointer(a)),
		uintptr(unsafe.Pointer(&walker)),
	)
	if hr != S_OK || walker == nil {
		return nil
	}
	return walker
}

type iuiAutomationTreeWalkerVtbl struct {
	QueryInterface                      uintptr // 0
	AddRef                              uintptr // 1
	Release                             uintptr // 2
	GetParentElement                    uintptr // 3
	GetFirstChildElement                uintptr // 4
	GetLastChildElement                 uintptr // 5
	GetNextSiblingElement               uintptr // 6
	GetPreviousSiblingElement           uintptr // 7
	NormalizeElement                    uintptr // 8
	GetParentElementBuildCache          uintptr // 9
	GetFirstChildElementBuildCache      uintptr // 10
	GetLastChildElementBuildCache       uintptr // 11
	GetNextSiblingElementBuildCache     uintptr // 12
	GetPreviousSiblingElementBuildCache uintptr // 13
	NormalizeElementBuildCache          uintptr // 14
	Condition                           uintptr // 15
}

type iuiAutomationTreeWalker struct {
	lpVtbl *iuiAutomationTreeWalkerVtbl
}

func (w *iuiAutomationTreeWalker) Release() {
	if w == nil || w.lpVtbl == nil {
		return
	}
	syscall.SyscallN(w.lpVtbl.Release, uintptr(unsafe.Pointer(w)))
}

func (w *iuiAutomationTreeWalker) GetParentElement(elem *iuiAutomationElement) *iuiAutomationElement {
	var parent *iuiAutomationElement
	hr := callSyscallN(w.lpVtbl.GetParentElement,
		uintptr(unsafe.Pointer(w)),
		uintptr(unsafe.Pointer(elem)),
		uintptr(unsafe.Pointer(&parent)),
	)
	if hr != S_OK || parent == nil {
		return nil
	}
	return parent
}

type iuiAutomationConditionVtbl struct {
	QueryInterface uintptr
	AddRef         uintptr
	Release        uintptr
}

type iuiAutomationCondition struct {
	lpVtbl *iuiAutomationConditionVtbl
}

func (c *iuiAutomationCondition) Release() {
	if c == nil || c.lpVtbl == nil {
		return
	}
	syscall.SyscallN(c.lpVtbl.Release, uintptr(unsafe.Pointer(c)))
}

type iuiAutomationElementVtbl struct {
	QueryInterface uintptr // 0
	AddRef         uintptr // 1
	Release        uintptr // 2

	SetFocus                    uintptr // 3
	GetRuntimeId                uintptr // 4
	FindFirst                   uintptr // 5
	FindAll                     uintptr // 6
	FindFirstBuildCache         uintptr // 7
	FindAllBuildCache           uintptr // 8
	BuildUpdatedCache           uintptr // 9
	GetCurrentPropertyValue     uintptr // 10
	GetCurrentPropertyValueEx   uintptr // 11
	GetCachedPropertyValue      uintptr // 12
	GetCachedPropertyValueEx    uintptr // 13
	GetCurrentPatternAs         uintptr // 14
	GetCachedPatternAs          uintptr // 15
	GetCurrentPattern           uintptr // 16
	GetCachedPattern            uintptr // 17
	GetCachedParent             uintptr // 18
	GetCachedChildren           uintptr // 19
	CurrentProcessId            uintptr // 20
	CurrentControlType          uintptr // 21
	CurrentLocalizedControlType uintptr // 22
	CurrentName                 uintptr // 23
	CurrentAcceleratorKey       uintptr // 24
	CurrentAccessKey            uintptr // 25
	CurrentHasKeyboardFocus     uintptr // 26
	CurrentIsKeyboardFocusable  uintptr // 27
	CurrentIsEnabled            uintptr // 28
	CurrentAutomationId         uintptr // 29
	CurrentClassName            uintptr // 30
	CurrentHelpText             uintptr // 31
	CurrentCulture              uintptr // 32
	CurrentIsControlElement     uintptr // 33
	CurrentIsContentElement     uintptr // 34
	CurrentIsPassword           uintptr // 35
	CurrentNativeWindowHandle   uintptr // 36
	CurrentItemType             uintptr // 37
	CurrentIsOffscreen          uintptr // 38
	CurrentOrientation          uintptr // 39
	CurrentFrameworkId          uintptr // 40
	CurrentIsRequiredForForm    uintptr // 41
	CurrentItemStatus           uintptr // 42
	CurrentBoundingRectangle    uintptr // 43
	CurrentLabeledBy            uintptr // 44
	CurrentAriaRole             uintptr // 45
	CurrentAriaProperties       uintptr // 46
	CurrentIsDataValidForForm   uintptr // 47
	CurrentControllerFor        uintptr // 48
	CurrentDescribedBy          uintptr // 49
	CurrentFlowsTo              uintptr // 50
	CurrentProviderDescription  uintptr // 51
	CachedProcessId             uintptr // 52
	CachedControlType           uintptr // 53
	CachedLocalizedControlType  uintptr // 54
	CachedName                  uintptr // 55
	CachedAcceleratorKey        uintptr // 56
	CachedAccessKey             uintptr // 57
	CachedHasKeyboardFocus      uintptr // 58
	CachedIsKeyboardFocusable   uintptr // 59
	CachedIsEnabled             uintptr // 60
	CachedAutomationId          uintptr // 61
	CachedClassName             uintptr // 62
	CachedHelpText              uintptr // 63
	CachedCulture               uintptr // 64
	CachedIsControlElement      uintptr // 65
	CachedIsContentElement      uintptr // 66
	CachedIsPassword            uintptr // 67
	CachedNativeWindowHandle    uintptr // 68
	CachedItemType              uintptr // 69
	CachedIsOffscreen           uintptr // 70
	CachedOrientation           uintptr // 71
	CachedFrameworkId           uintptr // 72
	CachedIsRequiredForForm     uintptr // 73
	CachedItemStatus            uintptr // 74
	CachedBoundingRectangle     uintptr // 75
	CachedLabeledBy             uintptr // 76
	CachedAriaRole              uintptr // 77
	CachedAriaProperties        uintptr // 78
	CachedIsDataValidForForm    uintptr // 79
	CachedControllerFor         uintptr // 80
	CachedDescribedBy           uintptr // 81
	CachedFlowsTo               uintptr // 82
	CachedProviderDescription   uintptr // 83
	GetClickablePoint           uintptr // 84
}

type iuiAutomationElement struct {
	lpVtbl *iuiAutomationElementVtbl
}

func (e *iuiAutomationElement) Release() {
	if e == nil || e.lpVtbl == nil {
		return
	}
	syscall.SyscallN(e.lpVtbl.Release, uintptr(unsafe.Pointer(e)))
}

func (e *iuiAutomationElement) SetFocus() uintptr {
	return callSyscallN(e.lpVtbl.SetFocus, uintptr(unsafe.Pointer(e)))
}

func (e *iuiAutomationElement) GetCurrentPattern(patternID int32) *iunknown {
	var pat *iunknown
	hr := callSyscallN(e.lpVtbl.GetCurrentPattern,
		uintptr(unsafe.Pointer(e)),
		uintptr(patternID),
		uintptr(unsafe.Pointer(&pat)),
	)
	if hr != S_OK || pat == nil {
		return nil
	}
	return pat
}

func (e *iuiAutomationElement) GetCurrentPropertyValue(propID int32, val *uiaVariant) uintptr {
	return callSyscallN(e.lpVtbl.GetCurrentPropertyValue,
		uintptr(unsafe.Pointer(e)),
		uintptr(propID),
		uintptr(unsafe.Pointer(val)),
	)
}

func (e *iuiAutomationElement) GetCurrentName() string {
	var bstr uintptr
	hr := callSyscallN(e.lpVtbl.CurrentName,
		uintptr(unsafe.Pointer(e)),
		uintptr(unsafe.Pointer(&bstr)),
	)
	if hr != S_OK || bstr == 0 {
		return ""
	}
	s := bstrToString(bstr)
	sysFreeString(bstr)
	return s
}

func (e *iuiAutomationElement) GetCurrentClassName() string {
	var bstr uintptr
	hr := callSyscallN(e.lpVtbl.CurrentClassName,
		uintptr(unsafe.Pointer(e)),
		uintptr(unsafe.Pointer(&bstr)),
	)
	if hr != S_OK || bstr == 0 {
		return ""
	}
	s := bstrToString(bstr)
	sysFreeString(bstr)
	return s
}

func (e *iuiAutomationElement) GetCurrentBoundingRectangle() (left, top, right, bottom float64) {
	var r [4]float64
	callSyscallN(e.lpVtbl.CurrentBoundingRectangle,
		uintptr(unsafe.Pointer(e)),
		uintptr(unsafe.Pointer(&r[0])),
	)
	return r[0], r[1], r[0] + r[2], r[1] + r[3]
}

func (e *iuiAutomationElement) GetClickablePoint() (x, y float64, gotIt bool) {
	var pt [2]float64
	var ok int32
	callSyscallN(e.lpVtbl.GetClickablePoint,
		uintptr(unsafe.Pointer(e)),
		uintptr(unsafe.Pointer(&pt[0])),
		uintptr(unsafe.Pointer(&ok)),
	)
	return pt[0], pt[1], ok != 0
}

func (e *iuiAutomationElement) FindFirst(scope int32, condition *iuiAutomationCondition) *iuiAutomationElement {
	var found *iuiAutomationElement
	hr := callSyscallN(e.lpVtbl.FindFirst,
		uintptr(unsafe.Pointer(e)),
		uintptr(scope),
		uintptr(unsafe.Pointer(condition)),
		uintptr(unsafe.Pointer(&found)),
	)
	if hr != S_OK || found == nil {
		return nil
	}
	return found
}

func (e *iuiAutomationElement) GetNativeWindowHandle() uintptr {
	var hwnd uintptr
	callSyscallN(e.lpVtbl.CurrentNativeWindowHandle,
		uintptr(unsafe.Pointer(e)),
		uintptr(unsafe.Pointer(&hwnd)),
	)
	return hwnd
}

// ---------------------------------------------------------------------------
// UIA Pattern vtable structs
// ---------------------------------------------------------------------------

// IUIAutomationInvokePattern: IUnknown(0-2), Invoke(3)
type iuiAutomationInvokePatternVtbl struct {
	QueryInterface uintptr
	AddRef         uintptr
	Release        uintptr
	Invoke         uintptr // 3
}

type iuiAutomationInvokePattern struct {
	lpVtbl *iuiAutomationInvokePatternVtbl
}

func (p *iuiAutomationInvokePattern) Release() {
	if p == nil || p.lpVtbl == nil {
		return
	}
	syscall.SyscallN(p.lpVtbl.Release, uintptr(unsafe.Pointer(p)))
}

func (p *iuiAutomationInvokePattern) Invoke() uintptr {
	return callSyscallN(p.lpVtbl.Invoke, uintptr(unsafe.Pointer(p)))
}

// IUIAutomationTogglePattern: IUnknown(0-2), Toggle(3), CurrentToggleState(4)
type iuiAutomationTogglePatternVtbl struct {
	QueryInterface     uintptr
	AddRef             uintptr
	Release            uintptr
	Toggle             uintptr // 3
	CurrentToggleState uintptr // 4
	CachedToggleState  uintptr // 5
}

type iuiAutomationTogglePattern struct {
	lpVtbl *iuiAutomationTogglePatternVtbl
}

func (p *iuiAutomationTogglePattern) Release() {
	if p == nil || p.lpVtbl == nil {
		return
	}
	syscall.SyscallN(p.lpVtbl.Release, uintptr(unsafe.Pointer(p)))
}

func (p *iuiAutomationTogglePattern) Toggle() uintptr {
	return callSyscallN(p.lpVtbl.Toggle, uintptr(unsafe.Pointer(p)))
}

// IUIAutomationExpandCollapsePattern: IUnknown(0-2), Expand(3), Collapse(4), CurrentExpandCollapseState(5)
type iuiAutomationExpandCollapsePatternVtbl struct {
	QueryInterface             uintptr
	AddRef                     uintptr
	Release                    uintptr
	Expand                     uintptr // 3
	Collapse                   uintptr // 4
	CurrentExpandCollapseState uintptr // 5
	CachedExpandCollapseState  uintptr // 6
}

type iuiAutomationExpandCollapsePattern struct {
	lpVtbl *iuiAutomationExpandCollapsePatternVtbl
}

func (p *iuiAutomationExpandCollapsePattern) Release() {
	if p == nil || p.lpVtbl == nil {
		return
	}
	syscall.SyscallN(p.lpVtbl.Release, uintptr(unsafe.Pointer(p)))
}

func (p *iuiAutomationExpandCollapsePattern) Expand() uintptr {
	return callSyscallN(p.lpVtbl.Expand, uintptr(unsafe.Pointer(p)))
}

func (p *iuiAutomationExpandCollapsePattern) Collapse() uintptr {
	return callSyscallN(p.lpVtbl.Collapse, uintptr(unsafe.Pointer(p)))
}

func (p *iuiAutomationExpandCollapsePattern) GetCurrentExpandCollapseState() int32 {
	var state int32
	callSyscallN(p.lpVtbl.CurrentExpandCollapseState,
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&state)),
	)
	return state
}

// IUIAutomationSelectionItemPattern: IUnknown(0-2), Select(3), AddToSelection(4), RemoveFromSelection(5), CurrentIsSelected(6)
type iuiAutomationSelectionItemPatternVtbl struct {
	QueryInterface            uintptr
	AddRef                    uintptr
	Release                   uintptr
	Select                    uintptr // 3
	AddToSelection            uintptr // 4
	RemoveFromSelection       uintptr // 5
	CurrentIsSelected         uintptr // 6
	CurrentSelectionContainer uintptr // 7
	CachedIsSelected          uintptr // 8
	CachedSelectionContainer  uintptr // 9
}

type iuiAutomationSelectionItemPattern struct {
	lpVtbl *iuiAutomationSelectionItemPatternVtbl
}

func (p *iuiAutomationSelectionItemPattern) Release() {
	if p == nil || p.lpVtbl == nil {
		return
	}
	syscall.SyscallN(p.lpVtbl.Release, uintptr(unsafe.Pointer(p)))
}

func (p *iuiAutomationSelectionItemPattern) Select() uintptr {
	return callSyscallN(p.lpVtbl.Select, uintptr(unsafe.Pointer(p)))
}

// IUIAutomationScrollPattern: IUnknown(0-2), Scroll(3), SetScrollPercent(4), get_CurrentHorizontalScrollPercent(5)...
type iuiAutomationScrollPatternVtbl struct {
	QueryInterface                 uintptr
	AddRef                         uintptr
	Release                        uintptr
	Scroll                         uintptr // 3
	SetScrollPercent               uintptr // 4
	CurrentHorizontalScrollPercent uintptr // 5
	CurrentVerticalScrollPercent   uintptr // 6
	CurrentHorizontalViewSize      uintptr // 7
	CurrentVerticalViewSize        uintptr // 8
	CurrentHorizontallyScrollable  uintptr // 9
	CurrentVerticallyScrollable    uintptr // 10
	CachedHorizontalScrollPercent  uintptr // 11
	CachedVerticalScrollPercent    uintptr // 12
	CachedHorizontalViewSize       uintptr // 13
	CachedVerticalViewSize         uintptr // 14
	CachedHorizontallyScrollable   uintptr // 15
	CachedVerticallyScrollable     uintptr // 16
}

type iuiAutomationScrollPattern struct {
	lpVtbl *iuiAutomationScrollPatternVtbl
}

func (p *iuiAutomationScrollPattern) Release() {
	if p == nil || p.lpVtbl == nil {
		return
	}
	syscall.SyscallN(p.lpVtbl.Release, uintptr(unsafe.Pointer(p)))
}

func (p *iuiAutomationScrollPattern) Scroll(horizAmount, vertAmount int32) uintptr {
	return callSyscallN(p.lpVtbl.Scroll,
		uintptr(unsafe.Pointer(p)),
		uintptr(horizAmount),
		uintptr(vertAmount),
	)
}

func (p *iuiAutomationScrollPattern) SetScrollPercent(horizPercent, vertPercent float64) uintptr {
	return callSyscallN(p.lpVtbl.SetScrollPercent,
		uintptr(unsafe.Pointer(p)),
		uintptr(*(*uint64)(unsafe.Pointer(&horizPercent))),
		uintptr(*(*uint64)(unsafe.Pointer(&vertPercent))),
	)
}

// IUIAutomationValuePattern: IUnknown(0-2), SetValue(3), CurrentValue(4)
type iuiAutomationValuePatternVtbl struct {
	QueryInterface    uintptr
	AddRef            uintptr
	Release           uintptr
	SetValue          uintptr // 3
	CurrentValue      uintptr // 4
	CurrentIsReadOnly uintptr // 5
	CachedValue       uintptr // 6
	CachedIsReadOnly  uintptr // 7
}

type iuiAutomationValuePattern struct {
	lpVtbl *iuiAutomationValuePatternVtbl
}

func (p *iuiAutomationValuePattern) Release() {
	if p == nil || p.lpVtbl == nil {
		return
	}
	syscall.SyscallN(p.lpVtbl.Release, uintptr(unsafe.Pointer(p)))
}

func (p *iuiAutomationValuePattern) SetValue(val string) uintptr {
	bstr := stringToBSTR(val)
	if bstr == 0 {
		return 1
	}
	defer sysFreeString(bstr)
	return callSyscallN(p.lpVtbl.SetValue,
		uintptr(unsafe.Pointer(p)),
		bstr,
	)
}

func (p *iuiAutomationValuePattern) GetCurrentValue() string {
	var bstr uintptr
	hr := callSyscallN(p.lpVtbl.CurrentValue,
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&bstr)),
	)
	if hr != S_OK || bstr == 0 {
		return ""
	}
	s := bstrToString(bstr)
	sysFreeString(bstr)
	return s
}

// IUIAutomationTransformPattern: IUnknown(0-2), Move(3), Resize(4), Rotate(5)
type iuiAutomationTransformPatternVtbl struct {
	QueryInterface   uintptr
	AddRef           uintptr
	Release          uintptr
	Move             uintptr // 3
	Resize           uintptr // 4
	Rotate           uintptr // 5
	CurrentCanMove   uintptr // 6
	CurrentCanResize uintptr // 7
	CurrentCanRotate uintptr // 8
	CachedCanMove    uintptr // 9
	CachedCanResize  uintptr // 10
	CachedCanRotate  uintptr // 11
}

type iuiAutomationTransformPattern struct {
	lpVtbl *iuiAutomationTransformPatternVtbl
}

func (p *iuiAutomationTransformPattern) Release() {
	if p == nil || p.lpVtbl == nil {
		return
	}
	syscall.SyscallN(p.lpVtbl.Release, uintptr(unsafe.Pointer(p)))
}

func (p *iuiAutomationTransformPattern) Move(x, y float64) uintptr {
	return callSyscallN(p.lpVtbl.Move,
		uintptr(unsafe.Pointer(p)),
		uintptr(*(*uint64)(unsafe.Pointer(&x))),
		uintptr(*(*uint64)(unsafe.Pointer(&y))),
	)
}

var (
	oleaut32DLL        = syscall.NewLazyDLL("oleaut32.dll")
	procSysAllocString = oleaut32DLL.NewProc("SysAllocString")
	procSysFreeString  = oleaut32DLL.NewProc("SysFreeString")
	procSysStringLen   = oleaut32DLL.NewProc("SysStringLen")
)

func stringToBSTR(s string) uintptr {
	u16, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		return 0
	}
	bstr, _, _ := procSysAllocString.Call(uintptr(unsafe.Pointer(u16)))
	return bstr
}

func sysFreeString(bstr uintptr) {
	if bstr != 0 {
		procSysFreeString.Call(bstr)
	}
}

func bstrToString(bstr uintptr) string {
	if bstr == 0 {
		return ""
	}
	length, _, _ := procSysStringLen.Call(bstr)
	if length == 0 {
		return ""
	}
	slice := unsafe.Slice((*uint16)(unsafe.Pointer(bstr)), length)
	return syscall.UTF16ToString(slice)
}

type uiaVariant struct {
	vt       uint16
	reserved [6]byte
	val      [8]byte // union
}

func (v *uiaVariant) Int32() int32 {
	return *(*int32)(unsafe.Pointer(&v.val[0]))
}

func (v *uiaVariant) Float64() float64 {
	return *(*float64)(unsafe.Pointer(&v.val[0]))
}

func (v *uiaVariant) BSTR() uintptr {
	return *(*uintptr)(unsafe.Pointer(&v.val[0]))
}

var (
	uiaSingleton      *iuiAutomation
	uiaTreeWalker     *iuiAutomationTreeWalker
	uiaInitOnce       sync.Once
	uiaInitErr        error
	uiaCOMInitialized bool
)

func uiaInit() error {
	uiaInitOnce.Do(func() {
		hr, _, _ := procCoInitializeEx.Call(0, COINIT_MULTITHREADED)
		if hr != 0 && hr != 1 {
			uiaInitErr = fmt.Errorf("CoInitializeEx failed: 0x%x", hr)
			return
		}
		uiaCOMInitialized = true

		hr, _, _ = procCoCreateInstance.Call(
			uintptr(unsafe.Pointer(&CLSID_CUIAutomation)),
			0,
			CLSCTX_INPROC_SERVER,
			uintptr(unsafe.Pointer(&IID_IUIAutomation)),
			uintptr(unsafe.Pointer(&uiaSingleton)),
		)
		if hr != S_OK || uiaSingleton == nil {
			uiaInitErr = fmt.Errorf("CoCreateInstance(CUIAutomation) failed: 0x%x", hr)
			if uiaCOMInitialized {
				procCoUninitialize.Call()
				uiaCOMInitialized = false
			}
			return
		}
		uiaTreeWalker = uiaSingleton.GetControlViewWalker()
		log.Printf("hvnc uia: IUIAutomation initialized successfully (walker=%v)", uiaTreeWalker != nil)
	})
	return uiaInitErr
}

func uiaCleanup() {
	uiaStopWorker()

	if uiaTreeWalker != nil {
		uiaTreeWalker.Release()
		uiaTreeWalker = nil
	}
	if uiaSingleton != nil {
		uiaSingleton.Release()
		uiaSingleton = nil
	}
	if uiaCOMInitialized {
		procCoUninitialize.Call()
		uiaCOMInitialized = false
	}
	uiaInitOnce = sync.Once{}
	uiaInitErr = nil
}

var (
	uiaWorkerCh   chan func()
	uiaWorkerOnce sync.Once
	uiaWorkerDone chan struct{}
)

func uiaEnsureWorker() {
	uiaWorkerOnce.Do(func() {
		uiaWorkerCh = make(chan func(), 64)
		uiaWorkerDone = make(chan struct{})
		go uiaWorkerLoop()
	})
}

func uiaWorkerLoop() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(uiaWorkerDone)

	hvncDesktopMu.Lock()
	dh := hvncDesktopHandle
	hvncDesktopMu.Unlock()
	if dh != 0 {
		r, _, err := procSetThreadDesktop.Call(dh)
		if r == 0 {
			log.Printf("hvnc uia: worker SetThreadDesktop failed: %v", err)
			for range uiaWorkerCh {
			}
			return
		}
	} else {
		log.Printf("hvnc uia: warning — worker started before HVNC desktop exists")
	}

	if err := uiaInit(); err != nil {
		log.Printf("hvnc uia: worker init failed: %v", err)
		for range uiaWorkerCh {
		}
		return
	}

	for fn := range uiaWorkerCh {
		fn()
	}
}

func uiaRunAsync(fn func()) {
	uiaEnsureWorker()
	select {
	case uiaWorkerCh <- fn:
	default:
	}
}

func uiaStopWorker() {
	if uiaWorkerCh != nil {
		close(uiaWorkerCh)
		<-uiaWorkerDone
		uiaWorkerCh = nil
	}
	uiaWorkerOnce = sync.Once{}
}

var (
	winui3CacheMu    sync.Mutex
	winui3Cache      map[uintptr]winui3CacheEntry
	winui3CacheClean time.Time
)

type winui3CacheEntry struct {
	isWinUI3 bool
	ts       time.Time
}

const winui3CacheTTL = 5 * time.Second
const winui3CacheMaxSize = 256

func getWindowClassName(hwnd uintptr) string {
	buf := make([]uint16, 256)
	n, _, _ := procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), 256)
	if n == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:n])
}

var winui3ClassPrefixes = []string{
	"WinUIDesktopWin32WindowClass",
	"Microsoft.UI.Content.DesktopChildSiteBridge",
	"Windows.UI.Input.InputSite.WindowClass",
	"Microsoft.UI.Windowing.DesktopWindowBridge",
	"Windows.UI.Composition.DesktopWindowContentBridge",
	"DesktopWindowXamlSource",
}

func classMatchesWinUI3(cls string) bool {
	if cls == "" {
		return false
	}
	for _, prefix := range winui3ClassPrefixes {
		if cls == prefix {
			return true
		}
	}
	// Also match generic "Microsoft.UI." prefix
	if len(cls) > 13 && cls[:13] == "Microsoft.UI." {
		return true
	}
	return false
}

func isWinUI3Window(hwnd uintptr) bool {
	if hwnd == 0 {
		return false
	}

	now := time.Now()
	winui3CacheMu.Lock()
	if winui3Cache != nil {
		if entry, ok := winui3Cache[hwnd]; ok && now.Sub(entry.ts) < winui3CacheTTL {
			winui3CacheMu.Unlock()
			return entry.isWinUI3
		}
	}
	winui3CacheMu.Unlock()

	result := detectWinUI3(hwnd)

	winui3CacheMu.Lock()
	if winui3Cache == nil {
		winui3Cache = make(map[uintptr]winui3CacheEntry, 32)
	}
	if now.Sub(winui3CacheClean) > 10*time.Second {
		for k, v := range winui3Cache {
			if now.Sub(v.ts) > winui3CacheTTL*2 {
				delete(winui3Cache, k)
			}
		}
		if len(winui3Cache) > winui3CacheMaxSize {
			winui3Cache = make(map[uintptr]winui3CacheEntry, 32)
		}
		winui3CacheClean = now
	}
	winui3Cache[hwnd] = winui3CacheEntry{isWinUI3: result, ts: now}
	winui3CacheMu.Unlock()
	return result
}

func detectWinUI3(hwnd uintptr) bool {
	cls := getWindowClassName(hwnd)
	if classMatchesWinUI3(cls) {
		return true
	}
	root := rootWindow(hwnd)
	if root != 0 && root != hwnd {
		cls = getWindowClassName(root)
		if classMatchesWinUI3(cls) {
			return true
		}
	}
	parent := hwnd
	for i := 0; i < 4; i++ {
		p, _, _ := procGetAncestor.Call(parent, 1) // GA_PARENT=1
		if p == 0 || p == parent {
			break
		}
		cls = getWindowClassName(p)
		if classMatchesWinUI3(cls) {
			return true
		}
		parent = p
	}
	return false
}

func resetWinUI3Cache() {
	winui3CacheMu.Lock()
	winui3Cache = nil
	winui3CacheMu.Unlock()
}

var (
	inputSiteCacheMu sync.Mutex
	inputSiteCache   map[uintptr]inputSiteCacheEntry
)

type inputSiteCacheEntry struct {
	inputSite uintptr
	ts        time.Time
}

func findInputSiteChild(hwnd uintptr) uintptr {
	if hwnd == 0 {
		return 0
	}
	root := rootWindow(hwnd)
	if root == 0 {
		root = hwnd
	}

	now := time.Now()
	inputSiteCacheMu.Lock()
	if inputSiteCache != nil {
		if entry, ok := inputSiteCache[root]; ok && now.Sub(entry.ts) < 10*time.Second {
			inputSiteCacheMu.Unlock()
			return entry.inputSite
		}
	}
	inputSiteCacheMu.Unlock()

	found := enumChildrenForInputSite(root)

	inputSiteCacheMu.Lock()
	if inputSiteCache == nil {
		inputSiteCache = make(map[uintptr]inputSiteCacheEntry, 16)
	}
	inputSiteCache[root] = inputSiteCacheEntry{inputSite: found, ts: now}
	inputSiteCacheMu.Unlock()
	return found
}

func enumChildrenForInputSite(parent uintptr) uintptr {
	var result uintptr
	cb := syscall.NewCallback(func(hwnd uintptr, lparam uintptr) uintptr {
		cls := getWindowClassName(hwnd)
		if cls == "Windows.UI.Input.InputSite.WindowClass" {
			*(*uintptr)(unsafe.Pointer(lparam)) = hwnd
			return 0 // stop enumeration
		}
		child := enumChildrenForInputSite(hwnd)
		if child != 0 {
			*(*uintptr)(unsafe.Pointer(lparam)) = child
			return 0
		}
		return 1 // continue
	})
	procEnumChildWindows.Call(parent, cb, uintptr(unsafe.Pointer(&result)))
	return result
}

func resetInputSiteCache() {
	inputSiteCacheMu.Lock()
	inputSiteCache = nil
	inputSiteCacheMu.Unlock()
}

var (
	uiaActiveElement *iuiAutomationElement
	uiaActiveMu      sync.Mutex
	uiaDragActive    bool
	uiaDragStartPt   point
	uiaLastClickTime time.Time
	uiaLastClickHwnd uintptr
)

func uiaSetActiveElement(elem *iuiAutomationElement) {
	uiaActiveMu.Lock()
	if uiaActiveElement != nil {
		uiaActiveElement.Release()
	}
	uiaActiveElement = elem
	uiaActiveMu.Unlock()
}

func uiaGetActiveElement() *iuiAutomationElement {
	uiaActiveMu.Lock()
	e := uiaActiveElement
	uiaActiveMu.Unlock()
	return e
}

func uiaClearActiveElement() {
	uiaSetActiveElement(nil)
}

func uiaHandleMouseMove(hwnd uintptr, screenPt point) {
	uiaEnsureWorker()

	inputSite := findInputSiteChild(hwnd)
	if inputSite != 0 {
		clientPt := screenPt
		procScreenToClient.Call(inputSite, uintptr(unsafe.Pointer(&clientPt)))
		postMouseMessage(inputSite, WM_MOUSEMOVE, uintptr(currentMouseButtons()), clientPt)
	}

	uiaActiveMu.Lock()
	dragging := uiaDragActive
	elem := uiaActiveElement
	uiaActiveMu.Unlock()

	if dragging && elem != nil {
		pt := screenPt // copy for closure
		uiaRunAsync(func() {
			uiaActiveMu.Lock()
			startPt := uiaDragStartPt
			uiaActiveMu.Unlock()

			dx := float64(pt.x - startPt.x)
			dy := float64(pt.y - startPt.y)
			pat := elem.GetCurrentPattern(uiaTransformPatternID)
			if pat != nil {
				tp := (*iuiAutomationTransformPattern)(unsafe.Pointer(pat))
				tp.Move(dx, dy)
				tp.Release()
			}
		})
	}
}

func uiaHandleMouseButton(hwnd uintptr, screenPt point, button int, down bool) error {
	uiaEnsureWorker()

	if down {
		uiaActiveMu.Lock()
		uiaDragStartPt = screenPt
		uiaDragActive = false
		uiaActiveMu.Unlock()

		inputSite := findInputSiteChild(hwnd)
		if inputSite != 0 {
			clientPt := screenPt
			procScreenToClient.Call(inputSite, uintptr(unsafe.Pointer(&clientPt)))
			switch button {
			case 0:
				postMouseMessage(inputSite, WM_LBUTTONDOWN, MK_LBUTTON, clientPt)
			case 2:
				postMouseMessage(inputSite, WM_RBUTTONDOWN, MK_RBUTTON, clientPt)
			}
		}
		return nil
	}

	inputSite := findInputSiteChild(hwnd)
	if inputSite != 0 {
		clientPt := screenPt
		procScreenToClient.Call(inputSite, uintptr(unsafe.Pointer(&clientPt)))
		switch button {
		case 0:
			postMouseMessage(inputSite, WM_LBUTTONUP, 0, clientPt)
		case 2:
			postMouseMessage(inputSite, WM_RBUTTONUP, 0, clientPt)
		}
	}

	uiaActiveMu.Lock()
	wasInDrag := uiaDragActive
	uiaDragActive = false
	uiaActiveMu.Unlock()

	if wasInDrag {
		return nil
	}

	now := time.Now()
	isDoubleClick := now.Sub(uiaLastClickTime) < 400*time.Millisecond && uiaLastClickHwnd == hwnd
	uiaLastClickTime = now
	uiaLastClickHwnd = hwnd

	pt := screenPt // copy for closure
	btn := button
	isDbl := isDoubleClick
	is := inputSite
	h := hwnd
	uiaRunAsync(func() {
		uiaMouseUpWorker(h, pt, btn, isDbl, is)
	})
	return nil
}

func uiaMouseUpWorker(hwnd uintptr, screenPt point, button int, isDoubleClick bool, inputSite uintptr) {
	if uiaSingleton == nil {
		return
	}

	elem := uiaSingleton.ElementFromPoint(screenPt)
	if elem == nil {
		elem = uiaSingleton.ElementFromHandle(hwnd)
	}
	if elem == nil {
		return
	}
	defer elem.Release()

	switch button {
	case 0: // Left click
		if uiaTryAction(elem, isDoubleClick) {
			return
		}
		if uiaTreeWalker != nil {
			current := elem
			for i := 0; i < 6; i++ {
				parent := uiaTreeWalker.GetParentElement(current)
				if parent == nil {
					break
				}
				if current != elem {
					current.Release()
				}
				current = parent
				if uiaTryAction(current, isDoubleClick) {
					if current != elem {
						current.Release()
					}
					return
				}
			}
			if current != elem {
				current.Release()
			}
		}
		elem.SetFocus()

	case 2: // Right click — context menu
		if inputSite != 0 {
			procPostMessageW.Call(inputSite, WM_CONTEXTMENU, inputSite, makeLParam(screenPt.x, screenPt.y))
		}
	}
}

func uiaTryAction(elem *iuiAutomationElement, isDoubleClick bool) bool {
	if uiaInvoke(elem) {
		if isDoubleClick {
			uiaInvoke(elem)
		}
		return true
	}
	if uiaToggle(elem) {
		return true
	}
	if uiaExpandCollapse(elem) {
		return true
	}
	if uiaSelectItem(elem) {
		return true
	}
	return false
}

func uiaHandleMouseWheel(hwnd uintptr, screenPt point, delta int32) error {
	uiaEnsureWorker()

	inputSite := findInputSiteChild(hwnd)
	if inputSite != 0 {
		wparam := (uintptr(uint16(delta)) << 16) | uintptr(currentMouseButtons())
		procPostMessageW.Call(inputSite, WM_MOUSEWHEEL, wparam, makeLParam(screenPt.x, screenPt.y))
	}

	pt := screenPt
	h := hwnd
	d := delta
	uiaRunAsync(func() {
		if uiaSingleton == nil {
			return
		}
		elem := uiaSingleton.ElementFromPoint(pt)
		if elem == nil {
			elem = uiaSingleton.ElementFromHandle(h)
		}
		if elem == nil {
			return
		}
		defer elem.Release()
		uiaScrollElement(elem, d)
	})
	return nil
}

func uiaHandleKey(hwnd uintptr, vk uint16, down bool) error {
	uiaEnsureWorker()

	inputSite := findInputSiteChild(hwnd)
	if inputSite != 0 {
		if down {
			if ch := virtualKeyToChars(vk); len(ch) > 0 && !isNonPrintableVK(vk) {
				for _, r := range ch {
					procPostMessageW.Call(inputSite, WM_CHAR, uintptr(r), uintptr(1))
				}
			} else {
				postKeyMessage(inputSite, WM_KEYDOWN, vk)
			}
		} else {
			postKeyMessage(inputSite, WM_KEYUP, vk)
		}
	}

	if down {
		key := vk
		uiaRunAsync(func() {
			if uiaSingleton == nil {
				return
			}
			if !isModifierVK(key) && !isNonPrintableVK(key) {
				elem := uiaSingleton.GetFocusedElement()
				if elem != nil {
					uiaTypeChar(elem, key)
					elem.Release()
				}
			} else if key == 0x08 || key == 0x2E {
				elem := uiaSingleton.GetFocusedElement()
				if elem != nil {
					uiaHandleDeleteKey(elem, key)
					elem.Release()
				}
			}
		})
	}
	return nil
}

func uiaInvoke(elem *iuiAutomationElement) bool {
	pat := elem.GetCurrentPattern(uiaInvokePatternID)
	if pat == nil {
		return false
	}
	ip := (*iuiAutomationInvokePattern)(unsafe.Pointer(pat))
	defer ip.Release()
	ip.Invoke()
	return true
}

func uiaToggle(elem *iuiAutomationElement) bool {
	pat := elem.GetCurrentPattern(uiaTogglePatternID)
	if pat == nil {
		return false
	}
	tp := (*iuiAutomationTogglePattern)(unsafe.Pointer(pat))
	defer tp.Release()
	tp.Toggle()
	return true
}

func uiaExpandCollapse(elem *iuiAutomationElement) bool {
	pat := elem.GetCurrentPattern(uiaExpandCollapsePatternID)
	if pat == nil {
		return false
	}
	ecp := (*iuiAutomationExpandCollapsePattern)(unsafe.Pointer(pat))
	defer ecp.Release()
	state := ecp.GetCurrentExpandCollapseState()
	if state == uiaExpandCollapseStateCollapsed || state == uiaExpandCollapseStatePartiallyExpanded {
		ecp.Expand()
	} else if state == uiaExpandCollapseStateExpanded {
		ecp.Collapse()
	}
	return true
}

func uiaSelectItem(elem *iuiAutomationElement) bool {
	pat := elem.GetCurrentPattern(uiaSelectionItemPatternID)
	if pat == nil {
		return false
	}
	sip := (*iuiAutomationSelectionItemPattern)(unsafe.Pointer(pat))
	defer sip.Release()
	sip.Select()
	return true
}

func uiaScrollElement(elem *iuiAutomationElement, delta int32) bool {
	pat := elem.GetCurrentPattern(uiaScrollPatternID)
	if pat == nil {
		return false
	}
	sp := (*iuiAutomationScrollPattern)(unsafe.Pointer(pat))
	defer sp.Release()

	var vertAmount int32
	if delta > 0 {
		vertAmount = uiaScrollAmountSmallDecrement // scroll up
	} else {
		vertAmount = uiaScrollAmountSmallIncrement // scroll down
	}
	notches := int(delta / 120)
	if notches < 0 {
		notches = -notches
	}
	if notches < 1 {
		notches = 1
	}
	for i := 0; i < notches; i++ {
		sp.Scroll(uiaScrollAmountNoAmount, vertAmount)
	}
	return true
}

func uiaTypeChar(elem *iuiAutomationElement, vk uint16) bool {
	pat := elem.GetCurrentPattern(uiaValuePatternID)
	if pat == nil {
		return false
	}
	vp := (*iuiAutomationValuePattern)(unsafe.Pointer(pat))
	defer vp.Release()

	ch := virtualKeyToChars(vk)
	if len(ch) == 0 {
		return false
	}

	current := vp.GetCurrentValue()
	newVal := current + string(ch)
	vp.SetValue(newVal)
	return true
}

func uiaHandleDeleteKey(elem *iuiAutomationElement, vk uint16) bool {
	pat := elem.GetCurrentPattern(uiaValuePatternID)
	if pat == nil {
		return false
	}
	vp := (*iuiAutomationValuePattern)(unsafe.Pointer(pat))
	defer vp.Release()

	current := vp.GetCurrentValue()
	if len(current) == 0 {
		return true
	}

	if vk == 0x08 { // Backspace — remove last char
		runes := []rune(current)
		if len(runes) > 0 {
			vp.SetValue(string(runes[:len(runes)-1]))
		}
	}

	return vk == 0x08
}

func uiaHandleDragMove(screenPt point) {
	uiaActiveMu.Lock()
	if !uiaDragActive {
		dx := screenPt.x - uiaDragStartPt.x
		dy := screenPt.y - uiaDragStartPt.y
		if dx*dx+dy*dy > 25 {
			uiaDragActive = true
		}
	}
	uiaActiveMu.Unlock()
}
