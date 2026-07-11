//go:build windows

package capture

import (
	"errors"
	"fmt"
	"image"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	mfVersion                = 0x00020070
	clsctxInprocServer       = 0x1
	coinitMultithreaded      = 0x0
	mfVideoInterlaceProgress = 2
	eNotImpl                 = 0x80004001

	mftEnumFlagSyncMFT       = 0x00000001
	mftEnumFlagAsyncMFT      = 0x00000002
	mftEnumFlagHardware      = 0x00000004
	mftEnumFlagSortAndFilter = 0x00000040

	mftMessageNotifyBeginStreaming = 0x10000000
	mftMessageNotifyStartOfStream  = 0x10000003
	mftMessageCommandFlush         = 0x00000000
	mftMessageNotifyEndOfStream    = 0x10000002
	mftMessageNotifyEndStreaming   = 0x10000001

	mftOutputStreamProvidesSamples = 0x00000100

	mfETransformNeedMoreInput = 0xC00D6D72
	mfETransformStreamChange  = 0xC00D6D61
	mfENoEventsAvailable      = 0xC00D3E80

	meTransformNeedInput     = 601
	meTransformHaveOutput    = 602
	meTransformDrainComplete = 603

	h264ProfileMain = 77
)

var (
	mfplatDLL  = syscall.NewLazyDLL("mfplat.dll")
	ole32MFDLL = syscall.NewLazyDLL("ole32.dll")

	procMFStartup            = mfplatDLL.NewProc("MFStartup")
	procMFShutdown           = mfplatDLL.NewProc("MFShutdown")
	procMFCreateMediaType    = mfplatDLL.NewProc("MFCreateMediaType")
	procMFCreateSample       = mfplatDLL.NewProc("MFCreateSample")
	procMFCreateMemoryBuffer = mfplatDLL.NewProc("MFCreateMemoryBuffer")
	procMFTEnumEx            = mfplatDLL.NewProc("MFTEnumEx")
	procMFCoCreateInstance   = ole32MFDLL.NewProc("CoCreateInstance")
	procMFCoInitializeEx     = ole32MFDLL.NewProc("CoInitializeEx")
	procMFCoTaskMemFree      = ole32MFDLL.NewProc("CoTaskMemFree")

	mfStartupOnce sync.Once
	mfStartupErr  error
)

var (
	CLSID_CMSH264EncoderMFT         = windows.GUID{Data1: 0x6ca50344, Data2: 0x051a, Data3: 0x4ded, Data4: [8]byte{0x97, 0x79, 0xa4, 0x33, 0x05, 0x16, 0x5e, 0x35}}
	IID_IMFTransform                = windows.GUID{Data1: 0xbf94c121, Data2: 0x5b05, Data3: 0x4e6f, Data4: [8]byte{0x80, 0x00, 0xba, 0x59, 0x89, 0x61, 0x41, 0x4d}}
	IID_IMFMediaType                = windows.GUID{Data1: 0x44ae0fa8, Data2: 0xea31, Data3: 0x4109, Data4: [8]byte{0x8d, 0x2e, 0x4c, 0xae, 0x49, 0x97, 0xc5, 0x55}}
	MFT_CATEGORY_VIDEO_ENCODER      = windows.GUID{Data1: 0xf79eac7d, Data2: 0xe545, Data3: 0x4387, Data4: [8]byte{0xbd, 0xee, 0xd6, 0x47, 0xd7, 0xbd, 0xe4, 0x2a}}
	MFMediaType_Video               = windows.GUID{Data1: 0x73646976, Data2: 0x0000, Data3: 0x0010, Data4: [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	MFVideoFormat_H264              = windows.GUID{Data1: 0x34363248, Data2: 0x0000, Data3: 0x0010, Data4: [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	MFVideoFormat_I420              = windows.GUID{Data1: 0x30323449, Data2: 0x0000, Data3: 0x0010, Data4: [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	MFVideoFormat_NV12              = windows.GUID{Data1: 0x3231564e, Data2: 0x0000, Data3: 0x0010, Data4: [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	MF_MT_MAJOR_TYPE                = windows.GUID{Data1: 0x48eba18e, Data2: 0xf8c9, Data3: 0x4687, Data4: [8]byte{0xbf, 0x11, 0x0a, 0x74, 0xc9, 0xf9, 0x6a, 0x8f}}
	MF_MT_SUBTYPE                   = windows.GUID{Data1: 0xf7e34c9a, Data2: 0x42e8, Data3: 0x4714, Data4: [8]byte{0xb7, 0x4b, 0xcb, 0x29, 0xd7, 0x2c, 0x35, 0xe5}}
	MF_MT_FRAME_SIZE                = windows.GUID{Data1: 0x1652c33d, Data2: 0xd6b2, Data3: 0x4012, Data4: [8]byte{0xb8, 0x34, 0x72, 0x03, 0x08, 0x49, 0xa3, 0x7d}}
	MF_MT_FRAME_RATE                = windows.GUID{Data1: 0xc459a2e8, Data2: 0x3d2c, Data3: 0x4e44, Data4: [8]byte{0xb1, 0x32, 0xfe, 0xe5, 0x15, 0x6c, 0x7b, 0xb0}}
	MF_MT_PIXEL_ASPECT_RATIO        = windows.GUID{Data1: 0xc6376a1e, Data2: 0x8d0a, Data3: 0x4027, Data4: [8]byte{0xbe, 0x45, 0x6d, 0x9a, 0x0a, 0xd3, 0x9b, 0xb6}}
	MF_MT_INTERLACE_MODE            = windows.GUID{Data1: 0xe2724bb8, Data2: 0xe676, Data3: 0x4806, Data4: [8]byte{0xb4, 0xb2, 0xa8, 0xd6, 0xef, 0xb4, 0x4c, 0xcd}}
	MF_MT_AVG_BITRATE               = windows.GUID{Data1: 0x20332624, Data2: 0xfB0d, Data3: 0x4d9e, Data4: [8]byte{0xbd, 0x0d, 0xcb, 0xf6, 0x78, 0x6c, 0x10, 0x2e}}
	MF_MT_MPEG2_LEVEL               = windows.GUID{Data1: 0x96f66574, Data2: 0x11c5, Data3: 0x4015, Data4: [8]byte{0x86, 0x66, 0xbf, 0xf5, 0x16, 0x43, 0x6d, 0xa7}}
	MF_MT_MPEG2_PROFILE             = windows.GUID{Data1: 0xad76a80b, Data2: 0x2d5c, Data3: 0x4e0b, Data4: [8]byte{0xb3, 0x75, 0x64, 0xe5, 0x20, 0x13, 0x70, 0x36}}
	MF_LOW_LATENCY                  = windows.GUID{Data1: 0x9c27891a, Data2: 0xed7a, Data3: 0x40e1, Data4: [8]byte{0x88, 0xe8, 0xb2, 0x27, 0x27, 0xa0, 0x24, 0xee}}
	MFT_FRIENDLY_NAME_Attribute     = windows.GUID{Data1: 0x314ffbae, Data2: 0x5b41, Data3: 0x4c95, Data4: [8]byte{0x9c, 0x19, 0x4e, 0x7d, 0x58, 0x6f, 0xac, 0xe3}}
	MFT_ENUM_HARDWARE_URL_Attribute = windows.GUID{Data1: 0x2fb866ac, Data2: 0xb078, Data3: 0x4942, Data4: [8]byte{0xab, 0x6c, 0x00, 0x3d, 0x05, 0xcd, 0xa6, 0x74}}
	MF_TRANSFORM_ASYNC              = windows.GUID{Data1: 0xf81a699a, Data2: 0x649a, Data3: 0x497d, Data4: [8]byte{0x8c, 0x73, 0x29, 0xf8, 0xfe, 0xd6, 0xad, 0x7a}}
	MF_TRANSFORM_ASYNC_UNLOCK       = windows.GUID{Data1: 0xe5666d6b, Data2: 0x3422, Data3: 0x4eb6, Data4: [8]byte{0xa4, 0x21, 0xda, 0x7d, 0xb1, 0xf8, 0xe2, 0x07}}
	MF_SA_D3D11_AWARE               = windows.GUID{Data1: 0x206b4fc8, Data2: 0xfcf9, Data3: 0x4c51, Data4: [8]byte{0xaf, 0xe3, 0x97, 0x64, 0x36, 0x9e, 0x33, 0xa0}}
	IID_IMFMediaEventGenerator      = windows.GUID{Data1: 0x2cd0bd52, Data2: 0xbcd5, Data3: 0x4b89, Data4: [8]byte{0xb6, 0x2c, 0xea, 0xdc, 0x0c, 0x03, 0x1e, 0x7d}}
)

type mfAttributesVtbl struct {
	QueryInterface     uintptr
	AddRef             uintptr
	Release            uintptr
	GetItem            uintptr
	GetItemType        uintptr
	CompareItem        uintptr
	Compare            uintptr
	GetUINT32          uintptr
	GetUINT64          uintptr
	GetDouble          uintptr
	GetGUID            uintptr
	GetStringLength    uintptr
	GetString          uintptr
	GetAllocatedString uintptr
	GetBlobSize        uintptr
	GetBlob            uintptr
	GetAllocatedBlob   uintptr
	GetUnknown         uintptr
	SetItem            uintptr
	DeleteItem         uintptr
	DeleteAllItems     uintptr
	SetUINT32          uintptr
	SetUINT64          uintptr
	SetDouble          uintptr
	SetGUID            uintptr
	SetString          uintptr
	SetBlob            uintptr
	SetUnknown         uintptr
	LockStore          uintptr
	UnlockStore        uintptr
	GetCount           uintptr
	GetItemByIndex     uintptr
	CopyAllItems       uintptr
}

type mfAttributes struct {
	lpVtbl *mfAttributesVtbl
}

func (a *mfAttributes) Release() {
	if a != nil && a.lpVtbl != nil {
		callSyscallN(a.lpVtbl.Release, uintptr(unsafe.Pointer(a)))
	}
}

func (a *mfAttributes) SetGUID(key, value *windows.GUID) uintptr {
	return callSyscallN(a.lpVtbl.SetGUID, uintptr(unsafe.Pointer(a)), uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(value)))
}

func (a *mfAttributes) SetUINT32(key *windows.GUID, value uint32) uintptr {
	return callSyscallN(a.lpVtbl.SetUINT32, uintptr(unsafe.Pointer(a)), uintptr(unsafe.Pointer(key)), uintptr(value))
}

func (a *mfAttributes) SetUINT64(key *windows.GUID, value uint64) uintptr {
	return callSyscallN(a.lpVtbl.SetUINT64, uintptr(unsafe.Pointer(a)), uintptr(unsafe.Pointer(key)), uintptr(value))
}

func (a *mfAttributes) GetUINT32(key *windows.GUID, value *uint32) uintptr {
	return callSyscallN(a.lpVtbl.GetUINT32, uintptr(unsafe.Pointer(a)), uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(value)))
}

func (a *mfAttributes) GetAllocatedString(key *windows.GUID) (string, bool) {
	var value *uint16
	var length uint32
	hr := callSyscallN(a.lpVtbl.GetAllocatedString, uintptr(unsafe.Pointer(a)), uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(&value)), uintptr(unsafe.Pointer(&length)))
	if failedHR(hr) || value == nil {
		return "", false
	}
	defer procMFCoTaskMemFree.Call(uintptr(unsafe.Pointer(value)))
	return windows.UTF16PtrToString(value), true
}

type mfMediaType struct {
	lpVtbl *mfAttributesVtbl
}

func (mt *mfMediaType) attrs() *mfAttributes {
	return (*mfAttributes)(unsafe.Pointer(mt))
}

func (mt *mfMediaType) Release() {
	if mt != nil && mt.lpVtbl != nil {
		callSyscallN(mt.lpVtbl.Release, uintptr(unsafe.Pointer(mt)))
	}
}

type mfTransformVtbl struct {
	QueryInterface            uintptr
	AddRef                    uintptr
	Release                   uintptr
	GetStreamLimits           uintptr
	GetStreamCount            uintptr
	GetStreamIDs              uintptr
	GetInputStreamInfo        uintptr
	GetOutputStreamInfo       uintptr
	GetAttributes             uintptr
	GetInputStreamAttributes  uintptr
	GetOutputStreamAttributes uintptr
	DeleteInputStream         uintptr
	AddInputStreams           uintptr
	GetInputAvailableType     uintptr
	GetOutputAvailableType    uintptr
	SetInputType              uintptr
	SetOutputType             uintptr
	GetInputCurrentType       uintptr
	GetOutputCurrentType      uintptr
	GetInputStatus            uintptr
	GetOutputStatus           uintptr
	SetOutputBounds           uintptr
	ProcessEvent              uintptr
	ProcessMessage            uintptr
	ProcessInput              uintptr
	ProcessOutput             uintptr
}

type mfTransform struct {
	lpVtbl *mfTransformVtbl
}

func (t *mfTransform) Release() {
	if t != nil && t.lpVtbl != nil {
		callSyscallN(t.lpVtbl.Release, uintptr(unsafe.Pointer(t)))
	}
}

func (t *mfTransform) SetInputType(id uint32, mt *mfMediaType, flags uint32) uintptr {
	return callSyscallN(t.lpVtbl.SetInputType, uintptr(unsafe.Pointer(t)), uintptr(id), uintptr(unsafe.Pointer(mt)), uintptr(flags))
}

func (t *mfTransform) SetOutputType(id uint32, mt *mfMediaType, flags uint32) uintptr {
	return callSyscallN(t.lpVtbl.SetOutputType, uintptr(unsafe.Pointer(t)), uintptr(id), uintptr(unsafe.Pointer(mt)), uintptr(flags))
}

func (t *mfTransform) GetOutputStreamInfo(id uint32, info *mftOutputStreamInfo) uintptr {
	return callSyscallN(t.lpVtbl.GetOutputStreamInfo, uintptr(unsafe.Pointer(t)), uintptr(id), uintptr(unsafe.Pointer(info)))
}

func (t *mfTransform) GetAttributes(attrs **mfAttributes) uintptr {
	return callSyscallN(t.lpVtbl.GetAttributes, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(attrs)))
}

func (t *mfTransform) ProcessMessage(msg uint32, param uintptr) uintptr {
	return callSyscallN(t.lpVtbl.ProcessMessage, uintptr(unsafe.Pointer(t)), uintptr(msg), param)
}

func (t *mfTransform) ProcessInput(id uint32, sample *mfSample, flags uint32) uintptr {
	return callSyscallN(t.lpVtbl.ProcessInput, uintptr(unsafe.Pointer(t)), uintptr(id), uintptr(unsafe.Pointer(sample)), uintptr(flags))
}

func (t *mfTransform) ProcessOutput(flags uint32, count uint32, samples *mftOutputDataBuffer, status *uint32) uintptr {
	return callSyscallN(t.lpVtbl.ProcessOutput, uintptr(unsafe.Pointer(t)), uintptr(flags), uintptr(count), uintptr(unsafe.Pointer(samples)), uintptr(unsafe.Pointer(status)))
}

type mfMediaEventGeneratorVtbl struct {
	QueryInterface uintptr
	AddRef         uintptr
	Release        uintptr
	GetEvent       uintptr
	BeginGetEvent  uintptr
	EndGetEvent    uintptr
	QueueEvent     uintptr
}

type mfMediaEventGenerator struct {
	lpVtbl *mfMediaEventGeneratorVtbl
}

func (g *mfMediaEventGenerator) Release() {
	if g != nil && g.lpVtbl != nil {
		callSyscallN(g.lpVtbl.Release, uintptr(unsafe.Pointer(g)))
	}
}

func (g *mfMediaEventGenerator) GetEvent(flags uint32, event **mfMediaEvent) uintptr {
	return callSyscallN(g.lpVtbl.GetEvent, uintptr(unsafe.Pointer(g)), uintptr(flags), uintptr(unsafe.Pointer(event)))
}

type mfMediaEventVtbl struct {
	mfAttributesVtbl
	GetType         uintptr
	GetExtendedType uintptr
	GetStatus       uintptr
	GetValue        uintptr
}

type mfMediaEvent struct {
	lpVtbl *mfMediaEventVtbl
}

func (e *mfMediaEvent) Release() {
	if e != nil && e.lpVtbl != nil {
		callSyscallN(e.lpVtbl.Release, uintptr(unsafe.Pointer(e)))
	}
}

func (e *mfMediaEvent) GetType(eventType *uint32) uintptr {
	return callSyscallN(e.lpVtbl.GetType, uintptr(unsafe.Pointer(e)), uintptr(unsafe.Pointer(eventType)))
}

func (e *mfMediaEvent) GetStatus(status *uint32) uintptr {
	return callSyscallN(e.lpVtbl.GetStatus, uintptr(unsafe.Pointer(e)), uintptr(unsafe.Pointer(status)))
}

type mfMediaBufferVtbl struct {
	QueryInterface   uintptr
	AddRef           uintptr
	Release          uintptr
	Lock             uintptr
	Unlock           uintptr
	GetCurrentLength uintptr
	SetCurrentLength uintptr
	GetMaxLength     uintptr
}

type mfMediaBuffer struct {
	lpVtbl *mfMediaBufferVtbl
}

func (b *mfMediaBuffer) Release() {
	if b != nil && b.lpVtbl != nil {
		callSyscallN(b.lpVtbl.Release, uintptr(unsafe.Pointer(b)))
	}
}

func (b *mfMediaBuffer) Lock(ptr **byte, maxLen *uint32, curLen *uint32) uintptr {
	return callSyscallN(b.lpVtbl.Lock, uintptr(unsafe.Pointer(b)), uintptr(unsafe.Pointer(ptr)), uintptr(unsafe.Pointer(maxLen)), uintptr(unsafe.Pointer(curLen)))
}

func (b *mfMediaBuffer) Unlock() uintptr {
	return callSyscallN(b.lpVtbl.Unlock, uintptr(unsafe.Pointer(b)))
}

func (b *mfMediaBuffer) GetCurrentLength(length *uint32) uintptr {
	return callSyscallN(b.lpVtbl.GetCurrentLength, uintptr(unsafe.Pointer(b)), uintptr(unsafe.Pointer(length)))
}

func (b *mfMediaBuffer) SetCurrentLength(length uint32) uintptr {
	return callSyscallN(b.lpVtbl.SetCurrentLength, uintptr(unsafe.Pointer(b)), uintptr(length))
}

type mfSampleVtbl struct {
	QueryInterface            uintptr
	AddRef                    uintptr
	Release                   uintptr
	GetItem                   uintptr
	GetItemType               uintptr
	CompareItem               uintptr
	Compare                   uintptr
	GetUINT32                 uintptr
	GetUINT64                 uintptr
	GetDouble                 uintptr
	GetGUID                   uintptr
	GetStringLength           uintptr
	GetString                 uintptr
	GetAllocatedString        uintptr
	GetBlobSize               uintptr
	GetBlob                   uintptr
	GetAllocatedBlob          uintptr
	GetUnknown                uintptr
	SetItem                   uintptr
	DeleteItem                uintptr
	DeleteAllItems            uintptr
	SetUINT32                 uintptr
	SetUINT64                 uintptr
	SetDouble                 uintptr
	SetGUID                   uintptr
	SetString                 uintptr
	SetBlob                   uintptr
	SetUnknown                uintptr
	LockStore                 uintptr
	UnlockStore               uintptr
	GetCount                  uintptr
	GetItemByIndex            uintptr
	CopyAllItems              uintptr
	GetSampleFlags            uintptr
	SetSampleFlags            uintptr
	GetSampleTime             uintptr
	SetSampleTime             uintptr
	GetSampleDuration         uintptr
	SetSampleDuration         uintptr
	GetBufferCount            uintptr
	GetBufferByIndex          uintptr
	ConvertToContiguousBuffer uintptr
	AddBuffer                 uintptr
	RemoveBufferByIndex       uintptr
	RemoveAllBuffers          uintptr
	GetTotalLength            uintptr
	CopyToBuffer              uintptr
}

type mfSample struct {
	lpVtbl *mfSampleVtbl
}

func (s *mfSample) Release() {
	if s != nil && s.lpVtbl != nil {
		callSyscallN(s.lpVtbl.Release, uintptr(unsafe.Pointer(s)))
	}
}

func (s *mfSample) AddBuffer(buf *mfMediaBuffer) uintptr {
	return callSyscallN(s.lpVtbl.AddBuffer, uintptr(unsafe.Pointer(s)), uintptr(unsafe.Pointer(buf)))
}

func (s *mfSample) SetSampleTime(v int64) uintptr {
	return callSyscallN(s.lpVtbl.SetSampleTime, uintptr(unsafe.Pointer(s)), uintptr(v))
}

func (s *mfSample) SetSampleDuration(v int64) uintptr {
	return callSyscallN(s.lpVtbl.SetSampleDuration, uintptr(unsafe.Pointer(s)), uintptr(v))
}

func (s *mfSample) ConvertToContiguousBuffer(buf **mfMediaBuffer) uintptr {
	return callSyscallN(s.lpVtbl.ConvertToContiguousBuffer, uintptr(unsafe.Pointer(s)), uintptr(unsafe.Pointer(buf)))
}

type mfActivateVtbl struct {
	QueryInterface     uintptr
	AddRef             uintptr
	Release            uintptr
	GetItem            uintptr
	GetItemType        uintptr
	CompareItem        uintptr
	Compare            uintptr
	GetUINT32          uintptr
	GetUINT64          uintptr
	GetDouble          uintptr
	GetGUID            uintptr
	GetStringLength    uintptr
	GetString          uintptr
	GetAllocatedString uintptr
	GetBlobSize        uintptr
	GetBlob            uintptr
	GetAllocatedBlob   uintptr
	GetUnknown         uintptr
	SetItem            uintptr
	DeleteItem         uintptr
	DeleteAllItems     uintptr
	SetUINT32          uintptr
	SetUINT64          uintptr
	SetDouble          uintptr
	SetGUID            uintptr
	SetString          uintptr
	SetBlob            uintptr
	SetUnknown         uintptr
	LockStore          uintptr
	UnlockStore        uintptr
	GetCount           uintptr
	GetItemByIndex     uintptr
	CopyAllItems       uintptr
	ActivateObject     uintptr
	ShutdownObject     uintptr
	DetachObject       uintptr
}

type mfActivate struct {
	lpVtbl *mfActivateVtbl
}

func (a *mfActivate) attrs() *mfAttributes {
	return (*mfAttributes)(unsafe.Pointer(a))
}

func (a *mfActivate) Release() {
	if a != nil && a.lpVtbl != nil {
		callSyscallN(a.lpVtbl.Release, uintptr(unsafe.Pointer(a)))
	}
}

func (a *mfActivate) ActivateObject(iid *windows.GUID, obj unsafe.Pointer) uintptr {
	return callSyscallN(a.lpVtbl.ActivateObject, uintptr(unsafe.Pointer(a)), uintptr(unsafe.Pointer(iid)), uintptr(obj))
}

type mftOutputStreamInfo struct {
	flags       uint32
	cbSize      uint32
	cbAlignment uint32
}

type mftOutputDataBuffer struct {
	streamID uint32
	sample   *mfSample
	status   uint32
	events   uintptr
}

type mftRegisterTypeInfo struct {
	majorType windows.GUID
	subtype   windows.GUID
}

type mfH264Encoder struct {
	transform    *mfTransform
	width        int
	height       int
	requestedFPS int
	fps          int
	frame        int64
	duration     int64
	scratch      []byte
	hardware     bool
	provider     string
	inputSubtype windows.GUID
	inputFormat  string
	asynchronous bool
	events       *mfMediaEventGenerator
	inputReady   int
	pendingOut   []byte
}

type h264FrameEncoder interface {
	Encode(*image.RGBA) ([]byte, error)
	Close()
	Matches(width, height, fps int) bool
}

type mfH264Candidate struct {
	fps          int
	inputSubtype windows.GUID
	inputFormat  string
}

var (
	h264TargetFPS atomic.Int64

	h264Mu      sync.Mutex
	h264Enc     h264FrameEncoder
	h264LastErr error

	hvncH264Mu  sync.Mutex
	hvncH264Enc h264FrameEncoder

	webcamH264Mu  sync.Mutex
	webcamH264Enc h264FrameEncoder
)

func encodeH264Frame(img *image.RGBA) ([]byte, error) {
	h264Mu.Lock()
	defer h264Mu.Unlock()
	out, err := encodeH264FrameWithEncoder(&h264Enc, "desktop", img)
	h264LastErr = err
	return out, err
}

func encodeH264FrameHVNC(img *image.RGBA) ([]byte, error) {
	hvncH264Mu.Lock()
	defer hvncH264Mu.Unlock()
	return encodeH264FrameWithEncoder(&hvncH264Enc, "backstage", img)
}

func encodeH264FrameWebcam(img *image.RGBA) ([]byte, error) {
	webcamH264Mu.Lock()
	defer webcamH264Mu.Unlock()
	return encodeH264FrameWithEncoder(&webcamH264Enc, "webcam", img)
}

func encodeH264FrameWithEncoder(slot *h264FrameEncoder, stream string, img *image.RGBA) ([]byte, error) {
	if img == nil {
		return nil, errors.New("nil h264 frame")
	}
	b := img.Bounds()
	width, height := b.Dx(), b.Dy()
	if width <= 0 || height <= 0 {
		return nil, fmt.Errorf("invalid h264 frame size %dx%d", width, height)
	}
	if width%2 != 0 || height%2 != 0 {
		return nil, fmt.Errorf("h264 frame size must be even, got %dx%d", width, height)
	}

	fps := activeH264FPS()
	if *slot == nil || !(*slot).Matches(width, height, fps) {
		if *slot != nil {
			(*slot).Close()
			*slot = nil
		}
		enc, err := newWindowsH264Encoder(stream, width, height, fps)
		if err != nil {
			return nil, err
		}
		*slot = enc
	}
	return (*slot).Encode(img)
}

func h264Available() bool {
	if nativeH264AvailabilityDetail() != "" {
		return true
	}
	return ensureMFStartup() == nil
}

func h264AvailabilityDetail() string {
	if detail := nativeH264AvailabilityDetail(); detail != "" {
		return detail
	}
	if err := ensureMFStartup(); err != nil {
		return fmt.Sprintf("Windows Media Foundation unavailable: %v", err)
	}
	ok, detail := hardwareH264MFTStatus()
	if ok {
		return "Windows Media Foundation H.264 MFT (hardware encoder available: " + detail + ")"
	}
	return "Windows Media Foundation H.264 MFT (Microsoft H.264 encoder fallback; hardware unavailable: " + detail + ")"
}

func SetH264TargetFPS(fps int) {
	if fps < 1 {
		fps = 1
	}
	h264TargetFPS.Store(int64(fps))
}

func activeH264FPS() int {
	if v := int(h264TargetFPS.Load()); v > 0 {
		return v
	}
	return 60
}

func resetH264Encoder() {
	h264Mu.Lock()
	defer h264Mu.Unlock()
	closeH264Encoder(&h264Enc)
}

func RequestDesktopH264Keyframe() {
	requestH264D3D11TextureKeyframe()
	resetH264Encoder()
}

func resetH264EncoderHVNC() {
	hvncH264Mu.Lock()
	defer hvncH264Mu.Unlock()
	closeH264Encoder(&hvncH264Enc)
}

func closeH264Encoder(slot *h264FrameEncoder) {
	if slot != nil && *slot != nil {
		(*slot).Close()
		*slot = nil
	}
}

func newWindowsH264Encoder(stream string, width, height, fps int) (h264FrameEncoder, error) {
	if stream == "desktop" && useDesktopSoftwareH264() {
		log.Printf("capture: desktop software h264 requested; skipping native NVENC and Media Foundation hardware encoders")
		return newMFSoftwareH264Encoder(width, height, fps)
	}
	if enc, err := newNativeH264Encoder(stream, width, height, fps); err == nil {
		return enc, nil
	} else {
		log.Printf("capture: native NVENC D3D11 h264 encoder unavailable stream=%s size=%dx%d fps=%d: %v; trying Media Foundation", stream, width, height, fps, err)
	}
	log.Printf("capture: media foundation h264 fallback selected stream=%s size=%dx%d fps=%d", stream, width, height, fps)
	return newMFH264Encoder(width, height, fps)
}

func newMFH264Encoder(width, height, fps int) (*mfH264Encoder, error) {
	if err := ensureMFStartup(); err != nil {
		return nil, err
	}

	if transform, detail, err := activateHardwareH264MFTDetailed(); err == nil && transform != nil {
		provider := detail.provider()
		log.Printf("capture: media foundation h264 hardware encoder selected provider=%q", provider)
		candidates := hardwareH264Candidates(fps)
		for idx, candidate := range candidates {
			enc := newMFH264EncoderFromTransform(transform, width, height, fps, candidate.fps, true, provider, candidate.inputSubtype, candidate.inputFormat)
			if err := enc.configure(); err == nil {
				logH264EncoderActive(enc)
				return enc, nil
			} else {
				log.Printf("capture: media foundation h264 hardware encoder config failed for %dx%d requested_fps=%d configured_fps=%d input=%s: %v", width, height, fps, candidate.fps, candidate.inputFormat, err)
				enc.Close()
			}

			if idx != len(candidates)-1 {
				var nextErr error
				var nextDetail mfHardwareEncoderDetail
				transform, nextDetail, nextErr = activateHardwareH264MFTDetailed()
				if nextErr != nil {
					log.Printf("capture: media foundation h264 hardware encoder reactivation failed after fps retry: %v; using Microsoft software encoder", nextErr)
					break
				}
				provider = nextDetail.provider()
			}
		}
		log.Printf("capture: media foundation h264 hardware encoder rejected all fps candidates for %dx%d requested_fps=%d; using Microsoft software encoder", width, height, fps)
	} else {
		log.Printf("capture: media foundation h264 hardware encoder unavailable: %v; using Microsoft software encoder", err)
	}

	transform, fallbackHardware, fallbackProvider, fallbackErr := createSoftwareH264Transform()
	if fallbackErr != nil {
		return nil, fallbackErr
	}
	return newMFH264EncoderFromSoftwareTransform(transform, fallbackHardware, fallbackProvider, width, height, fps)
}

func newMFSoftwareH264Encoder(width, height, fps int) (*mfH264Encoder, error) {
	if err := ensureMFStartup(); err != nil {
		return nil, err
	}
	transform, fallbackHardware, fallbackProvider, fallbackErr := createSoftwareH264Transform()
	if fallbackErr != nil {
		return nil, fallbackErr
	}
	return newMFH264EncoderFromSoftwareTransform(transform, fallbackHardware, fallbackProvider, width, height, fps)
}

func newMFH264EncoderFromSoftwareTransform(transform *mfTransform, fallbackHardware bool, fallbackProvider string, width, height, fps int) (*mfH264Encoder, error) {
	enc := newMFH264EncoderFromTransform(transform, width, height, fps, fps, fallbackHardware, fallbackProvider, MFVideoFormat_NV12, "NV12")
	if err := enc.configure(); err != nil {
		enc.Close()
		return nil, err
	}
	logH264EncoderActive(enc)
	return enc, nil
}

func newMFH264EncoderFromTransform(transform *mfTransform, width, height, requestedFPS, configuredFPS int, hardware bool, provider string, inputSubtype windows.GUID, inputFormat string) *mfH264Encoder {
	enc := &mfH264Encoder{
		transform:    transform,
		width:        width,
		height:       height,
		requestedFPS: requestedFPS,
		fps:          configuredFPS,
		duration:     int64(10_000_000 / configuredFPS),
		hardware:     hardware,
		provider:     provider,
		inputSubtype: inputSubtype,
		inputFormat:  inputFormat,
	}
	if enc.duration <= 0 {
		enc.duration = 333333
	}
	return enc
}

func hardwareH264FPSCandidates(requested int) []int {
	if requested <= 30 {
		return []int{requested}
	}
	if requested <= 60 {
		return []int{requested, 30}
	}
	return []int{requested, 60, 30}
}

func hardwareH264Candidates(requested int) []mfH264Candidate {
	fpsValues := hardwareH264FPSCandidates(requested)
	out := make([]mfH264Candidate, 0, len(fpsValues)*2)
	for _, fps := range fpsValues {
		out = append(out,
			mfH264Candidate{fps: fps, inputSubtype: MFVideoFormat_NV12, inputFormat: "NV12"},
			mfH264Candidate{fps: fps, inputSubtype: MFVideoFormat_I420, inputFormat: "I420"},
		)
	}
	return out
}

func logH264EncoderActive(enc *mfH264Encoder) {
	if enc.requestedFPS != enc.fps {
		log.Printf("capture: media foundation h264 encoder active provider=%s size=%dx%d requested_fps=%d configured_fps=%d input=%s bitrate=%d", enc.provider, enc.width, enc.height, enc.requestedFPS, enc.fps, enc.inputFormat, targetH264Bitrate(enc.width, enc.height, enc.fps))
		return
	}
	log.Printf("capture: media foundation h264 encoder active provider=%s size=%dx%d fps=%d input=%s bitrate=%d", enc.provider, enc.width, enc.height, enc.fps, enc.inputFormat, targetH264Bitrate(enc.width, enc.height, enc.fps))
}

func (e *mfH264Encoder) Close() {
	if e != nil && e.transform != nil {
		_ = e.transform.ProcessMessage(mftMessageNotifyEndOfStream, 0)
		_ = e.transform.ProcessMessage(mftMessageCommandFlush, 0)
		_ = e.transform.ProcessMessage(mftMessageNotifyEndStreaming, 0)
		if e.events != nil {
			e.events.Release()
			e.events = nil
		}
		e.transform.Release()
		e.transform = nil
	}
}

func (e *mfH264Encoder) Matches(width, height, fps int) bool {
	return e != nil && e.width == width && e.height == height && e.requestedFPS == fps
}

func (e *mfH264Encoder) configure() error {
	if err := e.configureAsyncMode(); err != nil {
		return err
	}
	e.setLowLatency()

	outType, err := createVideoType(MFVideoFormat_H264, e.width, e.height, e.fps)
	if err != nil {
		return err
	}
	defer outType.Release()
	outAttrs := outType.attrs()
	if hr := outAttrs.SetUINT32(&MF_MT_AVG_BITRATE, uint32(targetH264Bitrate(e.width, e.height, e.fps))); failedHR(hr) {
		return fmt.Errorf("mf h264: set bitrate failed 0x%x", hr)
	}
	_ = outAttrs.SetUINT32(&MF_MT_MPEG2_PROFILE, h264ProfileMain)
	_ = outAttrs.SetUINT32(&MF_MT_MPEG2_LEVEL, uint32(h264LevelFor(e.width, e.height, e.fps)))
	if hr := e.transform.SetOutputType(0, outType, 0); failedHR(hr) {
		return fmt.Errorf("mf h264: SetOutputType failed 0x%x", hr)
	}

	inType, err := createVideoType(e.inputSubtype, e.width, e.height, e.fps)
	if err != nil {
		return err
	}
	defer inType.Release()
	if hr := e.transform.SetInputType(0, inType, 0); failedHR(hr) {
		return fmt.Errorf("mf h264: SetInputType failed 0x%x", hr)
	}

	if hr := e.transform.ProcessMessage(mftMessageNotifyBeginStreaming, 0); failedHR(hr) && hr != eNotImpl {
		return fmt.Errorf("mf h264: begin streaming failed 0x%x", hr)
	}
	if hr := e.transform.ProcessMessage(mftMessageNotifyStartOfStream, 0); failedHR(hr) && hr != eNotImpl {
		return fmt.Errorf("mf h264: start stream failed 0x%x", hr)
	}
	if e.asynchronous {
		if err := e.waitForAsyncInput(500 * time.Millisecond); err != nil {
			return err
		}
	}
	return nil
}

func (e *mfH264Encoder) configureAsyncMode() error {
	var attrs *mfAttributes
	hr := e.transform.GetAttributes(&attrs)
	if failedHR(hr) || attrs == nil {
		return nil
	}
	defer attrs.Release()
	var async uint32
	_ = attrs.GetUINT32(&MF_TRANSFORM_ASYNC, &async)
	e.asynchronous = async != 0
	if !e.asynchronous {
		return nil
	}
	if hr := attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1); failedHR(hr) {
		return fmt.Errorf("mf h264: unlock asynchronous transform failed 0x%x", hr)
	}
	if e.events == nil {
		hr := (*iunknown)(unsafe.Pointer(e.transform)).QueryInterface(&IID_IMFMediaEventGenerator, unsafe.Pointer(&e.events))
		if failedHR(hr) || e.events == nil {
			return fmt.Errorf("mf h264: asynchronous transform has no event generator (0x%x)", hr)
		}
	}
	return nil
}

func (e *mfH264Encoder) setLowLatency() {
	var attrs *mfAttributes
	hr := e.transform.GetAttributes(&attrs)
	if failedHR(hr) || attrs == nil {
		return
	}
	defer attrs.Release()
	_ = attrs.SetUINT32(&MF_LOW_LATENCY, 1)
}

func (e *mfH264Encoder) Encode(img *image.RGBA) ([]byte, error) {
	nv12Len := e.width*e.height + (e.width*e.height)/2
	if cap(e.scratch) < nv12Len {
		e.scratch = make([]byte, nv12Len)
	} else {
		e.scratch = e.scratch[:nv12Len]
	}
	rgbaToH264Input(img, e.scratch, e.width, e.height, e.inputFormat)

	sample, err := createSampleFromBytes(e.scratch, e.frame*e.duration, e.duration)
	if err != nil {
		return nil, err
	}
	defer sample.Release()
	if e.asynchronous {
		return e.encodeAsync(sample)
	}

	hr := e.transform.ProcessInput(0, sample, 0)
	if failedHR(hr) {
		return nil, fmt.Errorf("mf h264: ProcessInput failed 0x%x", hr)
	}
	e.frame++

	out, err := e.processOutput()
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (e *mfH264Encoder) encodeAsync(sample *mfSample) ([]byte, error) {
	if err := e.waitForAsyncInput(500 * time.Millisecond); err != nil {
		return nil, err
	}
	e.inputReady--
	hr := e.transform.ProcessInput(0, sample, 0)
	if failedHR(hr) {
		return nil, fmt.Errorf("mf h264: asynchronous ProcessInput failed 0x%x", hr)
	}
	e.frame++

	deadline := time.Now().Add(100 * time.Millisecond)
	for len(e.pendingOut) == 0 && time.Now().Before(deadline) {
		hadEvent, err := e.pumpAsyncEvent()
		if err != nil {
			return nil, err
		}
		if !hadEvent {
			if e.inputReady > 0 {
				break
			}
			time.Sleep(time.Millisecond)
		}
	}
	return e.takePendingOutput(), nil
}

func (e *mfH264Encoder) waitForAsyncInput(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		for {
			hadEvent, err := e.pumpAsyncEvent()
			if err != nil {
				return err
			}
			if !hadEvent {
				break
			}
		}
		if e.inputReady > 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("mf h264: timed out waiting for asynchronous input request")
		}
		time.Sleep(time.Millisecond)
	}
}

func (e *mfH264Encoder) pumpAsyncEvent() (bool, error) {
	if e.events == nil {
		return false, errors.New("mf h264: asynchronous event generator is unavailable")
	}
	var event *mfMediaEvent
	hr := e.events.GetEvent(1, &event) // MF_EVENT_FLAG_NO_WAIT
	if hr == mfENoEventsAvailable {
		return false, nil
	}
	if failedHR(hr) {
		return false, fmt.Errorf("mf h264: GetEvent failed 0x%x", hr)
	}
	if event == nil {
		return false, errors.New("mf h264: GetEvent returned a nil event")
	}
	defer event.Release()
	var eventType uint32
	if hr := event.GetType(&eventType); failedHR(hr) {
		return false, fmt.Errorf("mf h264: event GetType failed 0x%x", hr)
	}
	var eventStatus uint32
	if hr := event.GetStatus(&eventStatus); failedHR(hr) {
		return false, fmt.Errorf("mf h264: event GetStatus failed 0x%x", hr)
	}
	if failedHR(uintptr(eventStatus)) {
		return false, fmt.Errorf("mf h264: asynchronous event %d failed 0x%x", eventType, eventStatus)
	}
	switch eventType {
	case meTransformNeedInput:
		e.inputReady++
	case meTransformHaveOutput:
		out, err := e.processOutput()
		if err != nil {
			return false, err
		}
		e.pendingOut = append(e.pendingOut, out...)
	case meTransformDrainComplete:
		// No action is required during normal streaming.
	}
	return true, nil
}

func (e *mfH264Encoder) takePendingOutput() []byte {
	if len(e.pendingOut) == 0 {
		return nil
	}
	out := append([]byte(nil), e.pendingOut...)
	e.pendingOut = e.pendingOut[:0]
	return out
}

func (e *mfH264Encoder) processOutput() ([]byte, error) {
	var info mftOutputStreamInfo
	hr := e.transform.GetOutputStreamInfo(0, &info)
	if failedHR(hr) {
		return nil, fmt.Errorf("mf h264: GetOutputStreamInfo failed 0x%x", hr)
	}

	var outSample *mfSample
	if info.flags&mftOutputStreamProvidesSamples == 0 {
		size := int(info.cbSize)
		minSize := e.width * e.height * 3 / 2
		if size < minSize {
			size = minSize
		}
		var err error
		outSample, err = createEmptySample(size)
		if err != nil {
			return nil, err
		}
		defer outSample.Release()
	}

	output := mftOutputDataBuffer{sample: outSample}
	var status uint32
	hr = e.transform.ProcessOutput(0, 1, &output, &status)
	if output.events != 0 {
		(*iunknown)(unsafe.Pointer(output.events)).Release()
	}
	switch hr {
	case 0:
	case mfETransformNeedMoreInput:
		return nil, nil
	case mfETransformStreamChange:
		if err := e.configure(); err != nil {
			return nil, err
		}
		return nil, nil
	default:
		if failedHR(hr) {
			return nil, fmt.Errorf("mf h264: ProcessOutput failed 0x%x", hr)
		}
	}
	if output.sample == nil {
		return nil, nil
	}
	if outSample == nil {
		defer output.sample.Release()
	}
	return sampleBytes(output.sample)
}

func createVideoType(subtype windows.GUID, width, height, fps int) (*mfMediaType, error) {
	var mt *mfMediaType
	hr, _, _ := procMFCreateMediaType.Call(uintptr(unsafe.Pointer(&mt)))
	if failedHR(hr) || mt == nil {
		return nil, fmt.Errorf("mf h264: MFCreateMediaType failed 0x%x", hr)
	}
	attrs := mt.attrs()
	if hr := attrs.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video); failedHR(hr) {
		mt.Release()
		return nil, fmt.Errorf("mf h264: set major type failed 0x%x", hr)
	}
	if hr := attrs.SetGUID(&MF_MT_SUBTYPE, &subtype); failedHR(hr) {
		mt.Release()
		return nil, fmt.Errorf("mf h264: set subtype failed 0x%x", hr)
	}
	if hr := attrs.SetUINT64(&MF_MT_FRAME_SIZE, packRatio(uint32(width), uint32(height))); failedHR(hr) {
		mt.Release()
		return nil, fmt.Errorf("mf h264: set frame size failed 0x%x", hr)
	}
	if hr := attrs.SetUINT64(&MF_MT_FRAME_RATE, packRatio(uint32(fps), 1)); failedHR(hr) {
		mt.Release()
		return nil, fmt.Errorf("mf h264: set frame rate failed 0x%x", hr)
	}
	if hr := attrs.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, packRatio(1, 1)); failedHR(hr) {
		mt.Release()
		return nil, fmt.Errorf("mf h264: set pixel aspect failed 0x%x", hr)
	}
	if hr := attrs.SetUINT32(&MF_MT_INTERLACE_MODE, mfVideoInterlaceProgress); failedHR(hr) {
		mt.Release()
		return nil, fmt.Errorf("mf h264: set interlace failed 0x%x", hr)
	}
	return mt, nil
}

func createSampleFromBytes(data []byte, sampleTime, duration int64) (*mfSample, error) {
	sample, err := createEmptySample(len(data))
	if err != nil {
		return nil, err
	}
	var mediaBuf *mfMediaBuffer
	if hr := sample.ConvertToContiguousBuffer(&mediaBuf); failedHR(hr) || mediaBuf == nil {
		sample.Release()
		return nil, fmt.Errorf("mf h264: input contiguous buffer failed 0x%x", hr)
	}
	defer mediaBuf.Release()

	var ptr *byte
	var maxLen uint32
	var curLen uint32
	if hr := mediaBuf.Lock(&ptr, &maxLen, &curLen); failedHR(hr) || ptr == nil {
		sample.Release()
		return nil, fmt.Errorf("mf h264: input buffer lock failed 0x%x", hr)
	}
	copy(unsafe.Slice(ptr, len(data)), data)
	_ = mediaBuf.Unlock()
	if hr := mediaBuf.SetCurrentLength(uint32(len(data))); failedHR(hr) {
		sample.Release()
		return nil, fmt.Errorf("mf h264: input length failed 0x%x", hr)
	}
	if hr := sample.SetSampleTime(sampleTime); failedHR(hr) {
		sample.Release()
		return nil, fmt.Errorf("mf h264: sample time failed 0x%x", hr)
	}
	if hr := sample.SetSampleDuration(duration); failedHR(hr) {
		sample.Release()
		return nil, fmt.Errorf("mf h264: sample duration failed 0x%x", hr)
	}
	return sample, nil
}

func createEmptySample(size int) (*mfSample, error) {
	var mediaBuf *mfMediaBuffer
	hr, _, _ := procMFCreateMemoryBuffer.Call(uintptr(size), uintptr(unsafe.Pointer(&mediaBuf)))
	if failedHR(hr) || mediaBuf == nil {
		return nil, fmt.Errorf("mf h264: MFCreateMemoryBuffer failed 0x%x", hr)
	}

	var sample *mfSample
	hr, _, _ = procMFCreateSample.Call(uintptr(unsafe.Pointer(&sample)))
	if failedHR(hr) || sample == nil {
		mediaBuf.Release()
		return nil, fmt.Errorf("mf h264: MFCreateSample failed 0x%x", hr)
	}
	if hr := sample.AddBuffer(mediaBuf); failedHR(hr) {
		mediaBuf.Release()
		sample.Release()
		return nil, fmt.Errorf("mf h264: AddBuffer failed 0x%x", hr)
	}
	mediaBuf.Release()
	return sample, nil
}

func sampleBytes(sample *mfSample) ([]byte, error) {
	var mediaBuf *mfMediaBuffer
	hr := sample.ConvertToContiguousBuffer(&mediaBuf)
	if failedHR(hr) || mediaBuf == nil {
		return nil, fmt.Errorf("mf h264: output contiguous buffer failed 0x%x", hr)
	}
	defer mediaBuf.Release()

	var ptr *byte
	var maxLen uint32
	var curLen uint32
	if hr := mediaBuf.Lock(&ptr, &maxLen, &curLen); failedHR(hr) || ptr == nil {
		return nil, fmt.Errorf("mf h264: output buffer lock failed 0x%x", hr)
	}
	defer mediaBuf.Unlock()

	if curLen == 0 {
		if hr := mediaBuf.GetCurrentLength(&curLen); failedHR(hr) {
			return nil, fmt.Errorf("mf h264: output length failed 0x%x", hr)
		}
	}
	if curLen == 0 {
		return nil, nil
	}
	out := make([]byte, curLen)
	copy(out, unsafe.Slice(ptr, int(curLen)))
	return out, nil
}

func createH264Transform() (*mfTransform, bool, string, error) {
	if transform, detail, err := activateHardwareH264MFTDetailed(); err == nil && transform != nil {
		provider := detail.provider()
		log.Printf("capture: media foundation h264 hardware encoder selected provider=%q", provider)
		return transform, true, provider, nil
	} else {
		log.Printf("capture: media foundation h264 hardware encoder unavailable: %v; using Microsoft software encoder", err)
	}
	return createSoftwareH264Transform()
}

func createSoftwareH264Transform() (*mfTransform, bool, string, error) {
	var transform *mfTransform
	hr, _, _ := procMFCoCreateInstance.Call(
		uintptr(unsafe.Pointer(&CLSID_CMSH264EncoderMFT)),
		0,
		clsctxInprocServer,
		uintptr(unsafe.Pointer(&IID_IMFTransform)),
		uintptr(unsafe.Pointer(&transform)),
	)
	if failedHR(hr) || transform == nil {
		return nil, false, "", fmt.Errorf("mf h264: CoCreateInstance encoder failed 0x%x", hr)
	}
	return transform, false, "Microsoft software", nil
}

type mfHardwareEncoderDetail struct {
	name         string
	hardwareURL  string
	asynchronous bool
	d3d11Aware   bool
}

func (d mfHardwareEncoderDetail) provider() string {
	if strings.TrimSpace(d.name) != "" {
		return d.name
	}
	return "Media Foundation hardware"
}

func activateHardwareH264MFT() (*mfTransform, error) {
	transform, _, err := activateHardwareH264MFTDetailed()
	return transform, err
}

func activateHardwareH264MFTDetailed() (*mfTransform, mfHardwareEncoderDetail, error) {
	input := mftRegisterTypeInfo{majorType: MFMediaType_Video, subtype: MFVideoFormat_NV12}
	output := mftRegisterTypeInfo{majorType: MFMediaType_Video, subtype: MFVideoFormat_H264}
	var activates **mfActivate
	var count uint32
	hr, _, _ := procMFTEnumEx.Call(
		uintptr(unsafe.Pointer(&MFT_CATEGORY_VIDEO_ENCODER)),
		uintptr(mftEnumFlagSyncMFT|mftEnumFlagAsyncMFT|mftEnumFlagHardware|mftEnumFlagSortAndFilter),
		uintptr(unsafe.Pointer(&input)),
		uintptr(unsafe.Pointer(&output)),
		uintptr(unsafe.Pointer(&activates)),
		uintptr(unsafe.Pointer(&count)),
	)
	if failedHR(hr) || count == 0 || activates == nil {
		return nil, mfHardwareEncoderDetail{}, fmt.Errorf("mf h264: no hardware encoder (0x%x)", hr)
	}
	defer procMFCoTaskMemFree.Call(uintptr(unsafe.Pointer(activates)))

	list := unsafe.Slice(activates, int(count))
	var found *mfTransform
	var foundDetail mfHardwareEncoderDetail
	for _, activate := range list {
		if activate == nil {
			continue
		}
		detail := mfHardwareEncoderDetail{}
		detail.name, _ = activate.attrs().GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute)
		detail.hardwareURL, _ = activate.attrs().GetAllocatedString(&MFT_ENUM_HARDWARE_URL_Attribute)
		if found == nil {
			var transform *mfTransform
			hr := activate.ActivateObject(&IID_IMFTransform, unsafe.Pointer(&transform))
			if !failedHR(hr) && transform != nil {
				var attrs *mfAttributes
				if !failedHR(transform.GetAttributes(&attrs)) && attrs != nil {
					var async, d3d11 uint32
					_ = attrs.GetUINT32(&MF_TRANSFORM_ASYNC, &async)
					_ = attrs.GetUINT32(&MF_SA_D3D11_AWARE, &d3d11)
					detail.asynchronous = async != 0
					detail.d3d11Aware = d3d11 != 0
					attrs.Release()
				}
				found = transform
				foundDetail = detail
			}
		}
		activate.Release()
	}
	if found != nil {
		log.Printf("capture: media foundation hardware h264 candidate selected name=%q asynchronous=%t d3d11_aware=%t hardware_url=%q", foundDetail.provider(), foundDetail.asynchronous, foundDetail.d3d11Aware, foundDetail.hardwareURL)
		return found, foundDetail, nil
	}
	return nil, mfHardwareEncoderDetail{}, errors.New("mf h264: hardware encoder activation failed")
}

func hardwareH264MFTStatus() (bool, string) {
	transform, detail, err := activateHardwareH264MFTDetailed()
	if err != nil {
		return false, err.Error()
	}
	transform.Release()
	return true, detail.provider()
}

func ensureMFStartup() error {
	mfStartupOnce.Do(func() {
		hr, _, _ := procMFCoInitializeEx.Call(0, coinitMultithreaded)
		if failedHR(hr) && hr != 0x80010106 {
			mfStartupErr = fmt.Errorf("CoInitializeEx failed 0x%x", hr)
			return
		}
		hr, _, _ = procMFStartup.Call(mfVersion, 0)
		if failedHR(hr) {
			mfStartupErr = fmt.Errorf("MFStartup failed 0x%x", hr)
		}
	})
	return mfStartupErr
}

func packRatio(n, d uint32) uint64 {
	return uint64(n)<<32 | uint64(d)
}

func failedHR(hr uintptr) bool {
	return hr&0x80000000 != 0
}

func targetH264Bitrate(width, height, fps int) int {
	pixelsPerSecond := float64(width * height * fps)
	bitrate := int(pixelsPerSecond * 0.08)
	return clampInt(bitrate, 1_500_000, 18_000_000)
}

func h264LevelFor(width, height, fps int) int {
	mbsPerFrame := ((width + 15) / 16) * ((height + 15) / 16)
	mbsPerSecond := mbsPerFrame * fps
	switch {
	case mbsPerFrame > 36864 || mbsPerSecond > 983040:
		return 52
	case mbsPerFrame > 22080 || mbsPerSecond > 522240:
		return 51
	case mbsPerFrame > 8704 || mbsPerSecond > 245760:
		return 42
	case mbsPerFrame > 8192 || mbsPerSecond > 245760:
		return 41
	case mbsPerSecond > 108000:
		return 40
	default:
		return 31
	}
}

func clampInt(v, min, max int) int {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

func rgbaToH264Input(img *image.RGBA, dst []byte, width, height int, format string) {
	if format == "I420" {
		rgbaToI420(img, dst, width, height)
		return
	}
	rgbaToNV12(img, dst, width, height)
}

func rgbaToNV12(img *image.RGBA, dst []byte, width, height int) {
	yPlane := dst[:width*height]
	uvPlane := dst[width*height:]
	rect := img.Bounds()

	for y := 0; y < height; y++ {
		src := img.Pix[(rect.Min.Y+y-img.Rect.Min.Y)*img.Stride+(rect.Min.X-img.Rect.Min.X)*4:]
		yd := yPlane[y*width:]
		for x := 0; x < width; x++ {
			r := int(src[x*4+0])
			g := int(src[x*4+1])
			b := int(src[x*4+2])
			yd[x] = byte(clampInt(((66*r+129*g+25*b+128)>>8)+16, 0, 255))
		}
	}

	for y := 0; y < height; y += 2 {
		row0 := img.Pix[(rect.Min.Y+y-img.Rect.Min.Y)*img.Stride+(rect.Min.X-img.Rect.Min.X)*4:]
		row1 := img.Pix[(rect.Min.Y+y+1-img.Rect.Min.Y)*img.Stride+(rect.Min.X-img.Rect.Min.X)*4:]
		uv := uvPlane[(y/2)*width:]
		for x := 0; x < width; x += 2 {
			r, g, b := average2x2RGB(row0, row1, x)
			u := ((-38*r - 74*g + 112*b + 128) >> 8) + 128
			v := ((112*r - 94*g - 18*b + 128) >> 8) + 128
			uv[x] = byte(clampInt(u, 0, 255))
			uv[x+1] = byte(clampInt(v, 0, 255))
		}
	}
}

func rgbaToI420(img *image.RGBA, dst []byte, width, height int) {
	yPlane := dst[:width*height]
	uPlane := dst[width*height : width*height+(width*height)/4]
	vPlane := dst[width*height+(width*height)/4:]
	rect := img.Bounds()

	for y := 0; y < height; y++ {
		src := img.Pix[(rect.Min.Y+y-img.Rect.Min.Y)*img.Stride+(rect.Min.X-img.Rect.Min.X)*4:]
		yd := yPlane[y*width:]
		for x := 0; x < width; x++ {
			r := int(src[x*4+0])
			g := int(src[x*4+1])
			b := int(src[x*4+2])
			yd[x] = byte(clampInt(((66*r+129*g+25*b+128)>>8)+16, 0, 255))
		}
	}

	halfW := width / 2
	for y := 0; y < height; y += 2 {
		row0 := img.Pix[(rect.Min.Y+y-img.Rect.Min.Y)*img.Stride+(rect.Min.X-img.Rect.Min.X)*4:]
		row1 := img.Pix[(rect.Min.Y+y+1-img.Rect.Min.Y)*img.Stride+(rect.Min.X-img.Rect.Min.X)*4:]
		uvIndex := (y / 2) * halfW
		for x := 0; x < width; x += 2 {
			r, g, b := average2x2RGB(row0, row1, x)
			u := ((-38*r - 74*g + 112*b + 128) >> 8) + 128
			v := ((112*r - 94*g - 18*b + 128) >> 8) + 128
			uPlane[uvIndex+x/2] = byte(clampInt(u, 0, 255))
			vPlane[uvIndex+x/2] = byte(clampInt(v, 0, 255))
		}
	}
}

func average2x2RGB(row0, row1 []byte, x int) (int, int, int) {
	i := x * 4
	j := i + 4
	r := int(row0[i+0]) + int(row0[j+0]) + int(row1[i+0]) + int(row1[j+0])
	g := int(row0[i+1]) + int(row0[j+1]) + int(row1[i+1]) + int(row1[j+1])
	b := int(row0[i+2]) + int(row0[j+2]) + int(row1[i+2]) + int(row1[j+2])
	return r / 4, g / 4, b / 4
}

func shutdownMediaFoundationForTest() {
	closeH264Encoder(&h264Enc)
	closeH264Encoder(&hvncH264Enc)
	closeH264Encoder(&webcamH264Enc)
	_, _, _ = procMFShutdown.Call()
}
