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
	d3d11SdkVersion                      = 7
	d3d11CreateDeviceBgraSupport         = 0x20
	d3dDriverTypeUnknown                 = 0
	dxgiErrorNotFound            uintptr = 0x887A0002
	dxgiErrorWaitTimeout         uintptr = 0x887A0027
	dxgiErrorAccessLost          uintptr = 0x887A0026
	dxgiErrorDeviceRemoved       uintptr = 0x887A0005
	dxgiErrorDeviceReset         uintptr = 0x887A0007
	S_OK                         uintptr = 0
)

var (
	dxgiDLL                = syscall.NewLazyDLL("dxgi.dll")
	d3d11DLL               = syscall.NewLazyDLL("d3d11.dll")
	ole32DXGIDll           = syscall.NewLazyDLL("ole32.dll")
	procCreateDXGIFactory1 = dxgiDLL.NewProc("CreateDXGIFactory1")
	procD3D11CreateDevice  = d3d11DLL.NewProc("D3D11CreateDevice")
	procCoInitDXGI         = ole32DXGIDll.NewProc("CoInitializeEx")
	dxgiComInit            sync.Once
)

var (
	IID_IDXGIFactory1          = windows.GUID{Data1: 0x7b7166ec, Data2: 0x21c7, Data3: 0x44ae, Data4: [8]byte{0xb2, 0x1a, 0xc9, 0xae, 0x32, 0x1a, 0xe3, 0x69}}
	IID_IDXGIAdapter1          = windows.GUID{Data1: 0x29038f61, Data2: 0x3839, Data3: 0x4626, Data4: [8]byte{0x91, 0xfd, 0x08, 0x68, 0x79, 0x01, 0x1a, 0x05}}
	IID_IDXGIOutput1           = windows.GUID{Data1: 0x00cddea8, Data2: 0x939b, Data3: 0x4b83, Data4: [8]byte{0xa3, 0x40, 0xa6, 0x85, 0x22, 0x66, 0x66, 0xcc}}
	IID_IDXGIOutputDuplication = windows.GUID{Data1: 0x191cfac3, Data2: 0xa341, Data3: 0x470d, Data4: [8]byte{0xb2, 0x6e, 0xa8, 0x64, 0xf4, 0x28, 0x31, 0x9c}}
	IID_ID3D11Device           = windows.GUID{Data1: 0xdb6f6ddb, Data2: 0xac77, Data3: 0x4e88, Data4: [8]byte{0x82, 0x53, 0x81, 0x9d, 0xf9, 0xbb, 0xf1, 0x40}}
	IID_ID3D11DeviceContext    = windows.GUID{Data1: 0xc0bfa96c, Data2: 0xe089, Data3: 0x44fb, Data4: [8]byte{0x8e, 0xaf, 0x26, 0xf8, 0x79, 0x61, 0x90, 0xda}}
	IID_ID3D11Texture2D        = windows.GUID{Data1: 0x6f15aaf2, Data2: 0xd208, Data3: 0x4e89, Data4: [8]byte{0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c}}
)

const (
	d3d11UsageStaging           = 3
	d3d11CpuAccessRead          = 0x20000
	d3d11MapRead                = 1
	dxgiFormatR8G8B8A8UNorm     = 28
	dxgiFormatB8G8R8A8UNorm     = 87
	dxgiModeRotationUnspecified = 0
	dxgiModeRotationIdentity    = 1
	dxgiModeRotationRotate90    = 2
	dxgiModeRotationRotate180   = 3
	dxgiModeRotationRotate270   = 4
)

type iunknownVtbl struct {
	QueryInterface uintptr
	AddRef         uintptr
	Release        uintptr
}

type iunknown struct {
	lpVtbl *iunknownVtbl
}

func callSyscallN(fn uintptr, args ...uintptr) uintptr {
	r, _, _ := syscall.SyscallN(fn, args...)
	return r
}

func (u *iunknown) QueryInterface(iid *windows.GUID, obj unsafe.Pointer) uintptr {
	if u == nil || u.lpVtbl == nil {
		return 0
	}
	return callSyscallN(u.lpVtbl.QueryInterface, uintptr(unsafe.Pointer(u)), uintptr(unsafe.Pointer(iid)), uintptr(obj))
}

func (u *iunknown) Release() {
	if u == nil || u.lpVtbl == nil {
		return
	}
	syscall.SyscallN(u.lpVtbl.Release, uintptr(unsafe.Pointer(u)))
}

type idxgiFactory1Vtbl struct {
	QueryInterface          uintptr
	AddRef                  uintptr
	Release                 uintptr
	SetPrivateData          uintptr
	SetPrivateDataInterface uintptr
	GetPrivateData          uintptr
	GetParent               uintptr
	EnumAdapters            uintptr
	MakeWindowAssociation   uintptr
	GetWindowAssociation    uintptr
	CreateSwapChain         uintptr
	CreateSoftwareAdapter   uintptr
	EnumAdapters1           uintptr
	IsCurrent               uintptr
}

type idxgiFactory1 struct {
	lpVtbl *idxgiFactory1Vtbl
}

func (f *idxgiFactory1) Release() {
	if f == nil || f.lpVtbl == nil {
		return
	}
	syscall.SyscallN(f.lpVtbl.Release, uintptr(unsafe.Pointer(f)))
}

func (f *idxgiFactory1) EnumAdapters1(index uint32, adapter **idxgiAdapter1) uintptr {
	return callSyscallN(f.lpVtbl.EnumAdapters1, uintptr(unsafe.Pointer(f)), uintptr(index), uintptr(unsafe.Pointer(adapter)))
}

type idxgiAdapter1Vtbl struct {
	QueryInterface          uintptr
	AddRef                  uintptr
	Release                 uintptr
	SetPrivateData          uintptr
	SetPrivateDataInterface uintptr
	GetPrivateData          uintptr
	GetParent               uintptr
	EnumOutputs             uintptr
	GetDesc                 uintptr
	CheckInterfaceSupport   uintptr
	GetDesc1                uintptr
}

type idxgiAdapter1 struct {
	lpVtbl *idxgiAdapter1Vtbl
}

func (a *idxgiAdapter1) Release() {
	if a == nil || a.lpVtbl == nil {
		return
	}
	syscall.SyscallN(a.lpVtbl.Release, uintptr(unsafe.Pointer(a)))
}

func (a *idxgiAdapter1) EnumOutputs(index uint32, output **idxgiOutput) uintptr {
	return callSyscallN(a.lpVtbl.EnumOutputs, uintptr(unsafe.Pointer(a)), uintptr(index), uintptr(unsafe.Pointer(output)))
}

type dxgiOutputDesc struct {
	DeviceName         [32]uint16
	DesktopCoordinates rect
	AttachedToDesktop  int32
	Rotation           uint32
	Monitor            uintptr
}

type idxgiOutputVtbl struct {
	QueryInterface              uintptr
	AddRef                      uintptr
	Release                     uintptr
	SetPrivateData              uintptr
	SetPrivateDataInterface     uintptr
	GetPrivateData              uintptr
	GetParent                   uintptr
	GetDesc                     uintptr
	GetDisplayModeList          uintptr
	FindClosestMatchingMode     uintptr
	WaitForVBlank               uintptr
	TakeOwnership               uintptr
	ReleaseOwnership            uintptr
	GetGammaControlCapabilities uintptr
	SetGammaControl             uintptr
	GetGammaControl             uintptr
	SetDisplaySurface           uintptr
	GetDisplaySurfaceData       uintptr
	GetFrameStatistics          uintptr
}

type idxgiOutput struct {
	lpVtbl *idxgiOutputVtbl
}

func (o *idxgiOutput) Release() {
	if o == nil || o.lpVtbl == nil {
		return
	}
	syscall.SyscallN(o.lpVtbl.Release, uintptr(unsafe.Pointer(o)))
}

func (o *idxgiOutput) GetDesc(desc *dxgiOutputDesc) uintptr {
	return callSyscallN(o.lpVtbl.GetDesc, uintptr(unsafe.Pointer(o)), uintptr(unsafe.Pointer(desc)))
}

type idxgiOutput1Vtbl struct {
	QueryInterface              uintptr
	AddRef                      uintptr
	Release                     uintptr
	SetPrivateData              uintptr
	SetPrivateDataInterface     uintptr
	GetPrivateData              uintptr
	GetParent                   uintptr
	GetDesc                     uintptr
	GetDisplayModeList          uintptr
	FindClosestMatchingMode     uintptr
	WaitForVBlank               uintptr
	TakeOwnership               uintptr
	ReleaseOwnership            uintptr
	GetGammaControlCapabilities uintptr
	SetGammaControl             uintptr
	GetGammaControl             uintptr
	SetDisplaySurface           uintptr
	GetDisplaySurfaceData       uintptr
	GetFrameStatistics          uintptr
	GetDisplayModeList1         uintptr
	FindClosestMatchingMode1    uintptr
	GetDisplaySurfaceData1      uintptr
	DuplicateOutput             uintptr
}

type idxgiOutput1 struct {
	lpVtbl *idxgiOutput1Vtbl
}

func (o *idxgiOutput1) Release() {
	if o == nil || o.lpVtbl == nil {
		return
	}
	syscall.SyscallN(o.lpVtbl.Release, uintptr(unsafe.Pointer(o)))
}

func (o *idxgiOutput1) DuplicateOutput(device *iunknown, dup **idxgiOutputDuplication) uintptr {
	return callSyscallN(o.lpVtbl.DuplicateOutput, uintptr(unsafe.Pointer(o)), uintptr(unsafe.Pointer(device)), uintptr(unsafe.Pointer(dup)))
}

type dxgiRational struct {
	Numerator   uint32
	Denominator uint32
}

type dxgiModeDesc struct {
	Width            uint32
	Height           uint32
	RefreshRate      dxgiRational
	Format           uint32
	ScanlineOrdering uint32
	Scaling          uint32
}

type dxgiOutDuplDesc struct {
	ModeDesc                   dxgiModeDesc
	Rotation                   uint32
	DesktopImageInSystemMemory int32
}

type dxgiOutDuplPointerPosition struct {
	Position point
	Visible  int32
}

type dxgiOutDuplFrameInfo struct {
	LastPresentTime           uint64
	LastMouseUpdateTime       uint64
	AccumulatedFrames         uint32
	RectsCoalesced            uint32
	ProtectedContentMaskedOut uint32
	PointerPosition           dxgiOutDuplPointerPosition
	TotalMetadataBufferSize   uint32
	PointerShapeBufferSize    uint32
}

type dxgiMappedRect struct {
	Pitch int32
	Bits  *byte
}

type idxgiOutputDuplicationVtbl struct {
	QueryInterface          uintptr
	AddRef                  uintptr
	Release                 uintptr
	SetPrivateData          uintptr
	SetPrivateDataInterface uintptr
	GetPrivateData          uintptr
	GetParent               uintptr
	GetDesc                 uintptr
	AcquireNextFrame        uintptr
	GetFrameDirtyRects      uintptr
	GetFrameMoveRects       uintptr
	GetFramePointerShape    uintptr
	MapDesktopSurface       uintptr
	UnMapDesktopSurface     uintptr
	ReleaseFrame            uintptr
}

type idxgiOutputDuplication struct {
	lpVtbl *idxgiOutputDuplicationVtbl
}

type d3d11DeviceVtbl struct {
	QueryInterface                       uintptr
	AddRef                               uintptr
	Release                              uintptr
	CreateBuffer                         uintptr
	CreateTexture1D                      uintptr
	CreateTexture2D                      uintptr
	CreateTexture3D                      uintptr
	CreateShaderResourceView             uintptr
	CreateUnorderedAccessView            uintptr
	CreateRenderTargetView               uintptr
	CreateDepthStencilView               uintptr
	CreateInputLayout                    uintptr
	CreateVertexShader                   uintptr
	CreateGeometryShader                 uintptr
	CreateGeometryShaderWithStreamOutput uintptr
	CreatePixelShader                    uintptr
	CreateHullShader                     uintptr
	CreateDomainShader                   uintptr
	CreateComputeShader                  uintptr
	CreateClassLinkage                   uintptr
	CreateBlendState                     uintptr
	CreateDepthStencilState              uintptr
	CreateRasterizerState                uintptr
	CreateSamplerState                   uintptr
	CreateQuery                          uintptr
	CreatePredicate                      uintptr
	CreateCounter                        uintptr
	CreateDeferredContext                uintptr
	OpenSharedResource                   uintptr
	CheckFormatSupport                   uintptr
	CheckMultisampleQualityLevels        uintptr
	CheckCounterInfo                     uintptr
	CheckCounter                         uintptr
	CheckFeatureSupport                  uintptr
	GetPrivateData                       uintptr
	SetPrivateData                       uintptr
	SetPrivateDataInterface              uintptr
	GetFeatureLevel                      uintptr
	GetCreationFlags                     uintptr
	GetDeviceRemovedReason               uintptr
	GetImmediateContext                  uintptr
	SetExceptionMode                     uintptr
	GetExceptionMode                     uintptr
}

type d3d11Device struct {
	lpVtbl *d3d11DeviceVtbl
}

func (d *d3d11Device) Release() {
	if d == nil || d.lpVtbl == nil {
		return
	}
	callSyscallN(d.lpVtbl.Release, uintptr(unsafe.Pointer(d)))
}

func (d *d3d11Device) GetImmediateContext(ctx **d3d11DeviceContext) {
	if d == nil || d.lpVtbl == nil {
		return
	}
	callSyscallN(d.lpVtbl.GetImmediateContext, uintptr(unsafe.Pointer(d)), uintptr(unsafe.Pointer(ctx)))
}

func (d *d3d11Device) CreateTexture2D(desc *d3d11Texture2DDesc, initialData unsafe.Pointer, tex **d3d11Texture2D) uintptr {
	return callSyscallN(d.lpVtbl.CreateTexture2D, uintptr(unsafe.Pointer(d)), uintptr(unsafe.Pointer(desc)), uintptr(initialData), uintptr(unsafe.Pointer(tex)))
}

type d3d11DeviceContextVtbl struct {
	QueryInterface                            uintptr
	AddRef                                    uintptr
	Release                                   uintptr
	GetDevice                                 uintptr
	GetPrivateData                            uintptr
	SetPrivateData                            uintptr
	SetPrivateDataInterface                   uintptr
	VSSetConstantBuffers                      uintptr
	PSSetShaderResources                      uintptr
	PSSetShader                               uintptr
	PSSetSamplers                             uintptr
	VSSetShader                               uintptr
	DrawIndexed                               uintptr
	Draw                                      uintptr
	Map                                       uintptr
	Unmap                                     uintptr
	PSSetConstantBuffers                      uintptr
	IASetInputLayout                          uintptr
	IASetVertexBuffers                        uintptr
	IASetIndexBuffer                          uintptr
	DrawIndexedInstanced                      uintptr
	DrawInstanced                             uintptr
	GSSetConstantBuffers                      uintptr
	GSSetShader                               uintptr
	IASetPrimitiveTopology                    uintptr
	VSSetShaderResources                      uintptr
	VSSetSamplers                             uintptr
	Begin                                     uintptr
	End                                       uintptr
	GetData                                   uintptr
	SetPredication                            uintptr
	GSSetShaderResources                      uintptr
	GSSetSamplers                             uintptr
	OMSetRenderTargets                        uintptr
	OMSetRenderTargetsAndUnorderedAccessViews uintptr
	OMSetBlendState                           uintptr
	OMSetDepthStencilState                    uintptr
	SOSetTargets                              uintptr
	DrawAuto                                  uintptr
	DrawIndexedInstancedIndirect              uintptr
	DrawInstancedIndirect                     uintptr
	Dispatch                                  uintptr
	DispatchIndirect                          uintptr
	RSSetState                                uintptr
	RSSetViewports                            uintptr
	RSSetScissorRects                         uintptr
	CopySubresourceRegion                     uintptr
	CopyResource                              uintptr
	UpdateSubresource                         uintptr
	CopyStructureCount                        uintptr
	ClearRenderTargetView                     uintptr
	ClearUnorderedAccessViewUint              uintptr
	ClearUnorderedAccessViewFloat             uintptr
	ClearDepthStencilView                     uintptr
	GenerateMips                              uintptr
	SetResourceMinLOD                         uintptr
	GetResourceMinLOD                         uintptr
	ResolveSubresource                        uintptr
	ExecuteCommandList                        uintptr
	HSSetShaderResources                      uintptr
	HSSetShader                               uintptr
	HSSetSamplers                             uintptr
	HSSetConstantBuffers                      uintptr
	DSSetShaderResources                      uintptr
	DSSetShader                               uintptr
	DSSetSamplers                             uintptr
	DSSetConstantBuffers                      uintptr
	CSSetShaderResources                      uintptr
	CSSetUnorderedAccessViews                 uintptr
	CSSetShader                               uintptr
	CSSetSamplers                             uintptr
	CSSetConstantBuffers                      uintptr
	VSGetConstantBuffers                      uintptr
	PSGetShaderResources                      uintptr
	PSGetShader                               uintptr
	PSGetSamplers                             uintptr
	VSGetShader                               uintptr
	PSGetConstantBuffers                      uintptr
	IAGetInputLayout                          uintptr
	IAGetVertexBuffers                        uintptr
	IAGetIndexBuffer                          uintptr
	GSGetConstantBuffers                      uintptr
	GSGetShader                               uintptr
	IAGetPrimitiveTopology                    uintptr
	VSGetShaderResources                      uintptr
	VSGetSamplers                             uintptr
	GetPredication                            uintptr
	GSGetShaderResources                      uintptr
	GSGetSamplers                             uintptr
	OMGetRenderTargets                        uintptr
	OMGetRenderTargetsAndUnorderedAccessViews uintptr
	OMGetBlendState                           uintptr
	OMGetDepthStencilState                    uintptr
	SOGetTargets                              uintptr
	RSGetState                                uintptr
	RSGetViewports                            uintptr
	RSGetScissorRects                         uintptr
	HSGetShaderResources                      uintptr
	HSGetShader                               uintptr
	HSGetSamplers                             uintptr
	HSGetConstantBuffers                      uintptr
	DSGetShaderResources                      uintptr
	DSGetShader                               uintptr
	DSGetSamplers                             uintptr
	DSGetConstantBuffers                      uintptr
	CSGetShaderResources                      uintptr
	CSGetUnorderedAccessViews                 uintptr
	CSGetShader                               uintptr
	CSGetSamplers                             uintptr
	CSGetConstantBuffers                      uintptr
	ClearState                                uintptr
	Flush                                     uintptr
}

type d3d11DeviceContext struct {
	lpVtbl *d3d11DeviceContextVtbl
}

func (c *d3d11DeviceContext) Release() {
	if c == nil || c.lpVtbl == nil {
		return
	}
	callSyscallN(c.lpVtbl.Release, uintptr(unsafe.Pointer(c)))
}

func (c *d3d11DeviceContext) CopyResource(dst, src *d3d11Texture2D) {
	if c == nil || c.lpVtbl == nil {
		return
	}
	callSyscallN(c.lpVtbl.CopyResource, uintptr(unsafe.Pointer(c)), uintptr(unsafe.Pointer(dst)), uintptr(unsafe.Pointer(src)))
}

func (c *d3d11DeviceContext) Map(res *d3d11Texture2D, subresource uint32, mapType uint32, mapFlags uint32, mapped *d3d11MappedSubresource) uintptr {
	return callSyscallN(c.lpVtbl.Map, uintptr(unsafe.Pointer(c)), uintptr(unsafe.Pointer(res)), uintptr(subresource), uintptr(mapType), uintptr(mapFlags), uintptr(unsafe.Pointer(mapped)))
}

func (c *d3d11DeviceContext) Unmap(res *d3d11Texture2D, subresource uint32) {
	if c == nil || c.lpVtbl == nil {
		return
	}
	callSyscallN(c.lpVtbl.Unmap, uintptr(unsafe.Pointer(c)), uintptr(unsafe.Pointer(res)), uintptr(subresource))
}

type d3d11Texture2DVtbl struct {
	QueryInterface          uintptr
	AddRef                  uintptr
	Release                 uintptr
	GetDevice               uintptr
	GetPrivateData          uintptr
	SetPrivateData          uintptr
	SetPrivateDataInterface uintptr
	GetType                 uintptr
	SetEvictionPriority     uintptr
	GetEvictionPriority     uintptr
	GetDesc                 uintptr
}

type d3d11Texture2D struct {
	lpVtbl *d3d11Texture2DVtbl
}

func (t *d3d11Texture2D) Release() {
	if t == nil || t.lpVtbl == nil {
		return
	}
	callSyscallN(t.lpVtbl.Release, uintptr(unsafe.Pointer(t)))
}

func (t *d3d11Texture2D) GetDesc(desc *d3d11Texture2DDesc) {
	if t == nil || t.lpVtbl == nil {
		return
	}
	callSyscallN(t.lpVtbl.GetDesc, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(desc)))
}

type d3d11Texture2DDesc struct {
	Width      uint32
	Height     uint32
	MipLevels  uint32
	ArraySize  uint32
	Format     uint32
	SampleDesc struct {
		Count   uint32
		Quality uint32
	}
	Usage          uint32
	BindFlags      uint32
	CPUAccessFlags uint32
	MiscFlags      uint32
}

type d3d11MappedSubresource struct {
	Data       unsafe.Pointer
	RowPitch   uint32
	DepthPitch uint32
}

func (d *idxgiOutputDuplication) Release() {
	if d == nil || d.lpVtbl == nil {
		return
	}
	syscall.SyscallN(d.lpVtbl.Release, uintptr(unsafe.Pointer(d)))
}

func (d *idxgiOutputDuplication) GetDesc(desc *dxgiOutDuplDesc) uintptr {
	return callSyscallN(d.lpVtbl.GetDesc, uintptr(unsafe.Pointer(d)), uintptr(unsafe.Pointer(desc)))
}

func (d *idxgiOutputDuplication) AcquireNextFrame(timeoutMs uint32, info *dxgiOutDuplFrameInfo, resource **iunknown) uintptr {
	return callSyscallN(d.lpVtbl.AcquireNextFrame, uintptr(unsafe.Pointer(d)), uintptr(timeoutMs), uintptr(unsafe.Pointer(info)), uintptr(unsafe.Pointer(resource)))
}

func (d *idxgiOutputDuplication) MapDesktopSurface(mapped *dxgiMappedRect) uintptr {
	return callSyscallN(d.lpVtbl.MapDesktopSurface, uintptr(unsafe.Pointer(d)), uintptr(unsafe.Pointer(mapped)))
}

func (d *idxgiOutputDuplication) UnMapDesktopSurface() uintptr {
	return callSyscallN(d.lpVtbl.UnMapDesktopSurface, uintptr(unsafe.Pointer(d)))
}

func (d *idxgiOutputDuplication) ReleaseFrame() uintptr {
	return callSyscallN(d.lpVtbl.ReleaseFrame, uintptr(unsafe.Pointer(d)))
}

var (
	desktopDuplicationEnabled atomic.Bool
	dxgiState                 = &duplicationState{}
	directH264ActiveOnce      sync.Once
	directH264ScaleOnce       sync.Once
	directH264WarnOnce        sync.Once
)

type duplicationState struct {
	mu            sync.Mutex
	display       int
	outputName    string
	bounds        image.Rectangle
	cursorBounds  image.Rectangle
	factory       *idxgiFactory1
	adapter       *idxgiAdapter1
	output        *idxgiOutput
	output1       *idxgiOutput1
	dup           *idxgiOutputDuplication
	device        *d3d11Device
	context       *d3d11DeviceContext
	staging       *d3d11Texture2D
	stagingDesc   d3d11Texture2DDesc
	h264LastTex   *d3d11Texture2D
	h264LastDesc  d3d11Texture2DDesc
	desc          dxgiOutDuplDesc
	lastBase      *image.RGBA
	lastFrame     *image.RGBA
	lastFrameAt   time.Time
	lastFail      time.Time
	cursorScratch *image.RGBA
	createdAt     time.Time
}

func SetDesktopDuplication(enabled bool) {
	desktopDuplicationEnabled.Store(enabled)
	dxgiState.reset()
}

func useDesktopDuplication() bool {
	return desktopDuplicationEnabled.Load()
}

func captureDisplayDXGI(display int) (*image.RGBA, error) {
	return dxgiState.capture(display)
}

func captureDisplayDXGIH264(display int, forceKeyframe bool) ([]byte, int, int, time.Duration, time.Duration, bool, error) {
	return dxgiState.captureH264(display, forceKeyframe)
}

func (s *duplicationState) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeLocked()
}

func (s *duplicationState) closeLocked() {
	if s.dup != nil {
		s.dup.Release()
		s.dup = nil
	}
	if s.staging != nil {
		s.staging.Release()
		s.staging = nil
	}
	if s.h264LastTex != nil {
		s.h264LastTex.Release()
		s.h264LastTex = nil
		s.h264LastDesc = d3d11Texture2DDesc{}
	}
	resetH264D3D11TextureEncoder()
	if s.context != nil {
		s.context.Release()
		s.context = nil
	}
	if s.output1 != nil {
		s.output1.Release()
		s.output1 = nil
	}
	if s.output != nil {
		s.output.Release()
		s.output = nil
	}
	if s.adapter != nil {
		s.adapter.Release()
		s.adapter = nil
	}
	if s.factory != nil {
		s.factory.Release()
		s.factory = nil
	}
	if s.device != nil {
		s.device.Release()
		s.device = nil
	}
	s.outputName = ""
	s.bounds = image.Rectangle{}
	s.cursorBounds = image.Rectangle{}
	s.display = -1
	PutRGBA(s.lastBase)
	s.lastBase = nil
	PutRGBA(s.lastFrame)
	s.lastFrame = nil
	s.lastFrameAt = time.Time{}
	s.cursorScratch = nil
	s.createdAt = time.Time{}
}

func (s *duplicationState) capture(display int) (*image.RGBA, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.ensure(display); err != nil {
		s.lastFail = time.Now()
		return nil, err
	}

	var info dxgiOutDuplFrameInfo
	var resource *iunknown
	waitMs := uint32(5)
	hr := uintptr(0)
	for {
		hr = s.dup.AcquireNextFrame(waitMs, &info, &resource)
		if hr != dxgiErrorWaitTimeout {
			break
		}
		if s.lastBase != nil {
			img := s.composeFrame(s.lastBase, int(s.desc.ModeDesc.Width), int(s.desc.ModeDesc.Height))
			// composeFrame may return s.lastBase or s.cursorScratch directly;
			// both are reused across captures, so the caller's PutRGBA would
			// hand them to the pool and a subsequent capture would race.
			if img == s.lastBase || img == s.cursorScratch {
				img = cloneRGBA(img)
			}
			s.lastFrameAt = time.Now()
			return img, nil
		}
		if s.lastFrame != nil {
			return cloneRGBA(s.lastFrame), nil
		}
		if waitMs >= 50 {
			return nil, errors.New("dxgi: frame timeout")
		}
		waitMs = 50
	}
	if hr == dxgiErrorAccessLost {
		s.closeLocked()
		return nil, errors.New("dxgi: access lost")
	}
	if hr == dxgiErrorDeviceRemoved || hr == dxgiErrorDeviceReset {
		s.closeLocked()
		return nil, fmt.Errorf("dxgi: device lost 0x%x", hr)
	}
	if hr != S_OK {
		return nil, fmt.Errorf("dxgi: acquire frame failed 0x%x", hr)
	}
	if resource != nil {
		defer resource.Release()
	}

	width := int(s.desc.ModeDesc.Width)
	height := int(s.desc.ModeDesc.Height)
	if width <= 0 || height <= 0 {
		_ = s.dup.ReleaseFrame()
		return nil, errors.New("dxgi: invalid frame size")
	}

	var img *image.RGBA
	userScale := effectiveScale(width, height)
	dstW := int(float64(width) * userScale)
	dstH := int(float64(height) * userScale)
	withCursor := cursorCaptureEnabled.Load()
	wantScale := !withCursor && userScale != 1 && dstW > 0 && dstH > 0 && (dstW != width || dstH != height)

	if s.desc.DesktopImageInSystemMemory != 0 {
		var mapped dxgiMappedRect
		hr = s.dup.MapDesktopSurface(&mapped)
		if hr != S_OK {
			_ = s.dup.ReleaseFrame()
			return nil, fmt.Errorf("dxgi: map desktop surface failed 0x%x", hr)
		}
		// Unmap and release the frame on every exit, including a panic in
		// the conversion code below. Leaving the surface mapped wedges the
		// duplication object until the device is fully closed.
		dup := s.dup
		defer func() {
			_ = dup.UnMapDesktopSurface()
			_ = dup.ReleaseFrame()
		}()

		if mapped.Pitch <= 0 || mapped.Bits == nil {
			return nil, errors.New("dxgi: invalid mapped surface")
		}

		pitch := int(mapped.Pitch)
		if pitch < width*4 {
			return nil, fmt.Errorf("dxgi: pitch %d too small for width %d", pitch, width)
		}
		totalBytes := pitch * height
		if totalBytes/height != pitch {
			return nil, fmt.Errorf("dxgi: pitch*height overflow (%d * %d)", pitch, height)
		}
		src := unsafe.Slice(mapped.Bits, totalBytes)
		if wantScale {
			img = convertBGRAScaled(src, pitch, width, height, dstW, dstH, s.desc.Rotation)
		}
		if img == nil {
			img = convertBGRA(src, pitch, width, height, s.desc.Rotation)
		}
		if img == nil {
			return nil, errors.New("dxgi: pixel conversion failed (buffer too small)")
		}
	} else {
		img, hr = s.readbackFrame(width, height, s.desc.Rotation, resource,
			wantScale, dstW, dstH)
		_ = s.dup.ReleaseFrame()
		if hr != S_OK || img == nil {
			return nil, fmt.Errorf("dxgi: staging readback failed 0x%x", hr)
		}
	}

	// Cache an independent copy so the timeout path (which serves the cached
	// frame back to callers) doesn't alias a buffer the caller will return to
	// the RGBA pool via PutRGBA.
	captured := img
	s.copyLastBaseLocked(captured)
	img = s.composeFrame(captured, width, height)
	if img != captured {
		PutRGBA(captured)
	}
	if img == s.cursorScratch {
		// cursorScratch is reused across captures; clone before returning so
		// the next compose doesn't write into a buffer the caller has pooled.
		img = cloneRGBA(img)
	}
	s.lastFrame = nil
	s.lastFrameAt = time.Now()

	return img, nil
}

func (s *duplicationState) copyLastBaseLocked(src *image.RGBA) {
	if src == nil {
		PutRGBA(s.lastBase)
		s.lastBase = nil
		return
	}
	width := src.Rect.Dx()
	height := src.Rect.Dy()
	need := len(src.Pix)
	if s.lastBase != nil && cap(s.lastBase.Pix) >= need && cap(s.lastBase.Pix) <= need*2 {
		s.lastBase.Pix = s.lastBase.Pix[:need]
		s.lastBase.Stride = width * 4
		s.lastBase.Rect = image.Rect(0, 0, width, height)
		copy(s.lastBase.Pix, src.Pix)
		return
	}
	PutRGBA(s.lastBase)
	s.lastBase = cloneRGBA(src)
}

func (s *duplicationState) captureH264(display int, forceKeyframe bool) ([]byte, int, int, time.Duration, time.Duration, bool, error) {
	capStart := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()

	if !useDesktopDuplication() || cursorCaptureEnabled.Load() {
		return nil, 0, 0, 0, 0, false, errors.New("direct h264 requires DXGI duplication and cursor capture disabled")
	}
	if err := s.ensure(display); err != nil {
		s.lastFail = time.Now()
		return nil, 0, 0, 0, 0, false, err
	}

	width := int(s.desc.ModeDesc.Width)
	height := int(s.desc.ModeDesc.Height)
	if width <= 0 || height <= 0 || width%2 != 0 || height%2 != 0 {
		return nil, 0, 0, 0, 0, false, fmt.Errorf("direct h264 requires positive even dimensions, got %dx%d", width, height)
	}
	if s.desc.Rotation != dxgiModeRotationIdentity && s.desc.Rotation != dxgiModeRotationUnspecified {
		return nil, 0, 0, 0, 0, false, fmt.Errorf("direct h264 requires identity rotation, got %d", s.desc.Rotation)
	}
	encodeW, encodeH := width, height
	if scale := effectiveScale(width, height); scale != 1 {
		encodeW = int(float64(width) * scale)
		encodeH = int(float64(height) * scale)
		encodeW -= encodeW % 2
		encodeH -= encodeH % 2
		if encodeW <= 0 || encodeH <= 0 {
			return nil, 0, 0, 0, 0, false, fmt.Errorf("direct h264 computed invalid scaled output %dx%d", encodeW, encodeH)
		}
		directH264ScaleOnce.Do(func() {
			log.Printf("capture: direct DXGI hardware h264 scaling enabled scale=%.2f input=%dx%d output=%dx%d", scale, width, height, encodeW, encodeH)
		})
	}

	var info dxgiOutDuplFrameInfo
	var resource *iunknown
	hr := s.dup.AcquireNextFrame(5, &info, &resource)
	if hr == dxgiErrorWaitTimeout {
		if s.h264LastTex != nil {
			captureDur := time.Since(capStart)
			fps := activeH264FPS()
			encStart := time.Now()
			out, _, err := encodeH264D3D11Texture(h264D3D11TextureRequest{
				Device: unsafe.Pointer(s.device), Texture: unsafe.Pointer(s.h264LastTex),
				InputWidth: width, InputHeight: height, EncodeWidth: encodeW, EncodeHeight: encodeH,
				FPS: fps, DXGIFormat: s.h264LastDesc.Format, ForceIDR: forceKeyframe,
			})
			encodeDur := time.Since(encStart)
			if err != nil {
				directH264WarnOnce.Do(func() {
					log.Printf("capture: direct DXGI hardware h264 cached-frame encode failed for %dx%d@%dfps format=%d: %v; using readback path", width, height, fps, s.h264LastDesc.Format, err)
				})
				return nil, 0, 0, 0, 0, false, err
			}
			if len(out) == 0 {
				return nil, encodeW, encodeH, captureDur, encodeDur, true, nil
			}
			return out, encodeW, encodeH, captureDur, encodeDur, true, nil
		}
		return nil, encodeW, encodeH, time.Since(capStart), 0, true, nil
	}
	if hr == dxgiErrorAccessLost {
		s.closeLocked()
		return nil, 0, 0, 0, 0, false, errors.New("dxgi: access lost")
	}
	if hr == dxgiErrorDeviceRemoved || hr == dxgiErrorDeviceReset {
		s.closeLocked()
		return nil, 0, 0, 0, 0, false, fmt.Errorf("dxgi: device lost 0x%x", hr)
	}
	if hr != S_OK {
		return nil, 0, 0, 0, 0, false, fmt.Errorf("dxgi: acquire frame failed 0x%x", hr)
	}
	if resource != nil {
		defer resource.Release()
	}
	if resource == nil {
		return nil, 0, 0, 0, 0, false, errors.New("dxgi: acquired nil resource")
	}
	frameReleased := false
	defer func() {
		if !frameReleased {
			_ = s.dup.ReleaseFrame()
		}
	}()

	var tex *d3d11Texture2D
	hr = resource.QueryInterface(&IID_ID3D11Texture2D, unsafe.Pointer(&tex))
	if hr != S_OK || tex == nil {
		return nil, 0, 0, 0, 0, false, fmt.Errorf("dxgi: acquired resource is not ID3D11Texture2D 0x%x", hr)
	}
	defer tex.Release()

	var srcDesc d3d11Texture2DDesc
	tex.GetDesc(&srcDesc)
	if srcDesc.Width == 0 || srcDesc.Height == 0 {
		return nil, 0, 0, 0, 0, false, errors.New("dxgi: acquired texture has invalid dimensions")
	}
	if int(srcDesc.Width) != width || int(srcDesc.Height) != height {
		return nil, 0, 0, 0, 0, false, fmt.Errorf("dxgi: texture size %dx%d does not match duplication %dx%d", srcDesc.Width, srcDesc.Height, width, height)
	}
	if srcDesc.Format != dxgiFormatB8G8R8A8UNorm && srcDesc.Format != dxgiFormatR8G8B8A8UNorm {
		directH264WarnOnce.Do(func() {
			log.Printf("capture: direct DXGI hardware h264 unavailable: unsupported DXGI texture format %d; using readback path", srcDesc.Format)
		})
		return nil, 0, 0, 0, 0, false, fmt.Errorf("direct h264 unsupported DXGI texture format %d", srcDesc.Format)
	}
	if err := s.cacheH264TextureLocked(tex, srcDesc); err != nil {
		directH264WarnOnce.Do(func() {
			log.Printf("capture: direct DXGI hardware h264 cache setup failed for %dx%d format=%d: %v; using readback path", width, height, srcDesc.Format, err)
		})
		return nil, 0, 0, 0, 0, false, err
	}

	captureDur := time.Since(capStart)
	_ = s.dup.ReleaseFrame()
	frameReleased = true

	fps := activeH264FPS()
	encStart := time.Now()
	out, provider, err := encodeH264D3D11Texture(h264D3D11TextureRequest{
		Device: unsafe.Pointer(s.device), Texture: unsafe.Pointer(s.h264LastTex),
		InputWidth: width, InputHeight: height, EncodeWidth: encodeW, EncodeHeight: encodeH,
		FPS: fps, DXGIFormat: s.h264LastDesc.Format, ForceIDR: forceKeyframe,
	})
	encodeDur := time.Since(encStart)
	if err != nil {
		directH264WarnOnce.Do(func() {
			log.Printf("capture: direct DXGI hardware h264 failed for %dx%d@%dfps format=%d: %v; using readback path", width, height, fps, s.h264LastDesc.Format, err)
		})
		return nil, 0, 0, 0, 0, false, err
	}
	if len(out) == 0 {
		return nil, encodeW, encodeH, captureDur, encodeDur, true, nil
	}
	directH264ActiveOnce.Do(func() {
		log.Printf("capture: direct DXGI hardware h264 path active provider=%q input=%dx%d output=%dx%d fps=%d dxgi_format=%d", provider, width, height, encodeW, encodeH, fps, srcDesc.Format)
	})
	return out, encodeW, encodeH, captureDur, encodeDur, true, nil
}

func (s *duplicationState) cacheH264TextureLocked(src *d3d11Texture2D, srcDesc d3d11Texture2DDesc) error {
	if src == nil || s.device == nil || s.context == nil {
		return errors.New("nil D3D11 source/device/context")
	}
	recreate := s.h264LastTex == nil ||
		s.h264LastDesc.Width != srcDesc.Width ||
		s.h264LastDesc.Height != srcDesc.Height ||
		s.h264LastDesc.Format != srcDesc.Format
	if recreate {
		if s.h264LastTex != nil {
			s.h264LastTex.Release()
			s.h264LastTex = nil
		}
		cacheDesc := srcDesc
		cacheDesc.MipLevels = 1
		cacheDesc.ArraySize = 1
		cacheDesc.SampleDesc.Count = 1
		cacheDesc.SampleDesc.Quality = 0
		cacheDesc.Usage = 0 // D3D11_USAGE_DEFAULT
		cacheDesc.BindFlags = 0
		cacheDesc.CPUAccessFlags = 0
		cacheDesc.MiscFlags = 0
		var tex *d3d11Texture2D
		hr := s.device.CreateTexture2D(&cacheDesc, nil, &tex)
		if hr != S_OK || tex == nil {
			return fmt.Errorf("CreateTexture2D h264 cache failed 0x%x", hr)
		}
		s.h264LastTex = tex
		s.h264LastDesc = cacheDesc
	}
	s.context.CopyResource(s.h264LastTex, src)
	return nil
}

func (s *duplicationState) composeFrame(base *image.RGBA, nativeW, nativeH int) *image.RGBA {
	if base == nil {
		return nil
	}
	imgW := base.Bounds().Dx()
	imgH := base.Bounds().Dy()
	userScale := effectiveScale(nativeW, nativeH)
	withCursor := cursorCaptureEnabled.Load()

	dstW := int(float64(nativeW) * userScale)
	dstH := int(float64(nativeH) * userScale)
	alreadyScaled := (imgW == dstW && imgH == dstH) && (imgW != nativeW || imgH != nativeH)
	if !withCursor && (userScale == 1 || alreadyScaled) {
		return base
	}

	img := base
	if withCursor {
		img = s.ensureCursorScratch(base.Rect)
		copy(img.Pix, base.Pix)
	}
	bounds := s.bounds
	if bounds.Dx() != int(s.desc.ModeDesc.Width) || bounds.Dy() != int(s.desc.ModeDesc.Height) {
		bounds = image.Rect(bounds.Min.X, bounds.Min.Y, bounds.Min.X+int(s.desc.ModeDesc.Width), bounds.Min.Y+int(s.desc.ModeDesc.Height))
	}
	if withCursor {
		drawCursorRotated(img, s.cursorBounds, bounds, s.desc.Rotation)
	}

	if !alreadyScaled && dstW > 0 && dstH > 0 && (dstW != imgW || dstH != imgH) {
		img = resizeNearest(img, dstW, dstH)
	}
	return img
}

func (s *duplicationState) ensureCursorScratch(rect image.Rectangle) *image.RGBA {
	if s.cursorScratch == nil || s.cursorScratch.Rect != rect {
		s.cursorScratch = image.NewRGBA(rect)
	}
	return s.cursorScratch
}

func cloneRGBA(src *image.RGBA) *image.RGBA {
	if src == nil {
		return nil
	}
	dst := GetRGBA(src.Rect.Dx(), src.Rect.Dy())
	copy(dst.Pix, src.Pix)
	return dst
}

func (s *duplicationState) ensure(display int) error {
	dxgiComInit.Do(func() {
		const coinitMultithreaded = 0x0
		hr, _, _ := procCoInitDXGI.Call(0, coinitMultithreaded)
		if hr != S_OK && hr != 1 {
			log.Printf("capture: CoInitializeEx for DXGI failed: 0x%x", hr)
		}
	})
	const dxgiDeviceMaxAge = 4 * time.Hour
	if s.dup != nil && s.display == display {
		if !s.createdAt.IsZero() && time.Since(s.createdAt) > dxgiDeviceMaxAge {
			log.Printf("capture: dxgi device age exceeded %v; forcing re-init", dxgiDeviceMaxAge)
			s.closeLocked()
		} else {
			return nil
		}
	} else {
		s.closeLocked()
	}

	monitors := monitorList()
	if display < 0 || display >= len(monitors) {
		display = 0
	}
	if len(monitors) == 0 {
		return errors.New("dxgi: no monitors")
	}

	mon := monitors[display]
	desiredName := strings.TrimSpace(mon.name)
	bounds := resolveBounds(mon)
	cursorBounds := mon.rect

	factory, err := createDXGIFactory1()
	if err != nil {
		return err
	}

	output, adapter, outputName, err := findOutput(factory, desiredName, bounds, display)
	if err != nil {
		factory.Release()
		return err
	}

	device, context, err := createD3DDevice(adapter)
	if err != nil {
		output.Release()
		adapter.Release()
		factory.Release()
		return err
	}

	var output1 *idxgiOutput1
	hr := (*iunknown)(unsafe.Pointer(output)).QueryInterface(&IID_IDXGIOutput1, unsafe.Pointer(&output1))
	if hr != S_OK || output1 == nil {
		device.Release()
		output.Release()
		adapter.Release()
		factory.Release()
		return errors.New("dxgi: failed to query IDXGIOutput1")
	}

	var dup *idxgiOutputDuplication
	hr = output1.DuplicateOutput((*iunknown)(unsafe.Pointer(device)), &dup)
	if hr != S_OK || dup == nil {
		output1.Release()
		context.Release()
		device.Release()
		output.Release()
		adapter.Release()
		factory.Release()
		return fmt.Errorf("dxgi: DuplicateOutput failed 0x%x", hr)
	}

	var desc dxgiOutDuplDesc
	_ = dup.GetDesc(&desc)
	if desc.DesktopImageInSystemMemory == 0 {
		log.Printf("capture: dxgi duplication has no system-memory surface; using staging readback")
	}

	s.factory = factory
	s.adapter = adapter
	s.output = output
	s.output1 = output1
	s.device = device
	s.context = context
	s.dup = dup
	s.desc = desc
	s.outputName = outputName
	s.display = display
	s.bounds = bounds
	s.cursorBounds = cursorBounds
	s.createdAt = time.Now()

	return nil
}

func (s *duplicationState) readbackFrame(width, height int, rotation uint32, resource *iunknown,
	wantScale bool, dstW, dstH int) (*image.RGBA, uintptr) {
	if resource == nil || s.device == nil || s.context == nil {
		return nil, uintptr(1)
	}
	var tex *d3d11Texture2D
	hr := resource.QueryInterface(&IID_ID3D11Texture2D, unsafe.Pointer(&tex))
	if hr != S_OK || tex == nil {
		return nil, hr
	}
	defer tex.Release()

	var srcDesc d3d11Texture2DDesc
	tex.GetDesc(&srcDesc)
	if srcDesc.Width == 0 || srcDesc.Height == 0 {
		return nil, uintptr(1)
	}

	if s.staging == nil || s.stagingDesc.Width != srcDesc.Width || s.stagingDesc.Height != srcDesc.Height || s.stagingDesc.Format != srcDesc.Format {
		if s.staging != nil {
			s.staging.Release()
			s.staging = nil
		}
		stagingDesc := srcDesc
		stagingDesc.Usage = d3d11UsageStaging
		stagingDesc.BindFlags = 0
		stagingDesc.CPUAccessFlags = d3d11CpuAccessRead
		stagingDesc.MiscFlags = 0
		stagingDesc.MipLevels = 1
		stagingDesc.ArraySize = 1
		stagingDesc.SampleDesc.Count = 1
		stagingDesc.SampleDesc.Quality = 0
		var staging *d3d11Texture2D
		hr = s.device.CreateTexture2D(&stagingDesc, nil, &staging)
		if hr != S_OK || staging == nil {
			return nil, hr
		}
		s.staging = staging
		s.stagingDesc = stagingDesc
	}

	s.context.CopyResource(s.staging, tex)
	var mapped d3d11MappedSubresource
	hr = s.context.Map(s.staging, 0, d3d11MapRead, 0, &mapped)
	if hr != S_OK {
		return nil, hr
	}
	defer s.context.Unmap(s.staging, 0)
	if mapped.Data == nil || mapped.RowPitch == 0 {
		return nil, uintptr(1)
	}

	pitch := int(mapped.RowPitch)
	srcH := int(srcDesc.Height)
	srcW := int(srcDesc.Width)
	if pitch < srcW*4 {
		return nil, uintptr(1)
	}
	totalBytes := pitch * srcH
	if totalBytes/srcH != pitch {
		return nil, uintptr(1)
	}
	src := unsafe.Slice((*byte)(mapped.Data), totalBytes)
	var img *image.RGBA
	if wantScale {
		img = convertBGRAScaled(src, pitch, int(srcDesc.Width), int(srcDesc.Height), dstW, dstH, rotation)
	}
	if img == nil {
		img = convertBGRA(src, pitch, int(srcDesc.Width), int(srcDesc.Height), rotation)
	}

	return img, S_OK
}

func createDXGIFactory1() (*idxgiFactory1, error) {
	var factory *idxgiFactory1
	hr, _, _ := procCreateDXGIFactory1.Call(uintptr(unsafe.Pointer(&IID_IDXGIFactory1)), uintptr(unsafe.Pointer(&factory)))
	if hr != S_OK || factory == nil {
		return nil, fmt.Errorf("dxgi: CreateDXGIFactory1 failed 0x%x", hr)
	}
	return factory, nil
}

func findOutput(factory *idxgiFactory1, desiredName string, desiredBounds image.Rectangle, displayIndex int) (*idxgiOutput, *idxgiAdapter1, string, error) {
	var fallbackOutput *idxgiOutput
	var fallbackAdapter *idxgiAdapter1
	fallbackName := ""
	outIndex := 0

	for adapterIndex := 0; ; adapterIndex++ {
		var adapter *idxgiAdapter1
		hr := factory.EnumAdapters1(uint32(adapterIndex), &adapter)
		if hr == dxgiErrorNotFound {
			break
		}
		if hr != S_OK || adapter == nil {
			continue
		}

		for outputIndex := 0; ; outputIndex++ {
			var output *idxgiOutput
			hrOut := adapter.EnumOutputs(uint32(outputIndex), &output)
			if hrOut == dxgiErrorNotFound {
				break
			}
			if hrOut != S_OK || output == nil {
				continue
			}

			var desc dxgiOutputDesc
			_ = output.GetDesc(&desc)
			name := windows.UTF16ToString(desc.DeviceName[:])
			coords := image.Rect(int(desc.DesktopCoordinates.left), int(desc.DesktopCoordinates.top), int(desc.DesktopCoordinates.right), int(desc.DesktopCoordinates.bottom))

			if desiredBounds.Dx() > 0 && desiredBounds.Dy() > 0 && coords == desiredBounds {
				if fallbackOutput != nil && fallbackAdapter != nil {
					fallbackOutput.Release()
					fallbackAdapter.Release()
				}
				return output, adapter, name, nil
			}

			if desiredName != "" && strings.EqualFold(strings.TrimSpace(name), desiredName) {
				if fallbackOutput != nil && fallbackAdapter != nil {
					fallbackOutput.Release()
					fallbackAdapter.Release()
				}
				return output, adapter, name, nil
			}

			if outIndex == displayIndex && fallbackOutput == nil {
				fallbackOutput = output
				fallbackAdapter = adapter
				fallbackName = name
			} else {
				output.Release()
			}
			outIndex++
		}
		if fallbackOutput == nil {
			adapter.Release()
		}
	}

	if fallbackOutput != nil && fallbackAdapter != nil {
		return fallbackOutput, fallbackAdapter, fallbackName, nil
	}

	return nil, nil, "", errors.New("dxgi: output not found")
}

func createD3DDevice(adapter *idxgiAdapter1) (*d3d11Device, *d3d11DeviceContext, error) {
	var device *d3d11Device
	var context *d3d11DeviceContext
	var featureLevel uint32
	hr, _, _ := procD3D11CreateDevice.Call(
		uintptr(unsafe.Pointer(adapter)),
		uintptr(d3dDriverTypeUnknown),
		0,
		uintptr(d3d11CreateDeviceBgraSupport),
		0,
		0,
		uintptr(d3d11SdkVersion),
		uintptr(unsafe.Pointer(&device)),
		uintptr(unsafe.Pointer(&featureLevel)),
		uintptr(unsafe.Pointer(&context)),
	)
	if hr != S_OK || device == nil || context == nil {
		if context != nil {
			context.Release()
		}
		if device != nil {
			device.Release()
		}
		return nil, nil, fmt.Errorf("dxgi: D3D11CreateDevice failed 0x%x", hr)
	}
	return device, context, nil
}

func convertBGRA(src []byte, pitch, width, height int, rotation uint32) *image.RGBA {
	if len(src) < (height-1)*pitch+width*4 {
		return nil
	}
	switch rotation {
	case dxgiModeRotationRotate90:
		dst := GetRGBA(height, width)
		for y := 0; y < height; y++ {
			sRow := src[y*pitch : y*pitch+width*4]
			for x := 0; x < width; x++ {
				si := x * 4
				dx := height - 1 - y
				dy := x
				di := dy*dst.Stride + dx*4
				dst.Pix[di+0] = sRow[si+2]
				dst.Pix[di+1] = sRow[si+1]
				dst.Pix[di+2] = sRow[si+0]
				dst.Pix[di+3] = 255
			}
		}
		return dst
	case dxgiModeRotationRotate180:
		dst := GetRGBA(width, height)
		for y := 0; y < height; y++ {
			sRow := src[y*pitch : y*pitch+width*4]
			dy := height - 1 - y
			dRow := dst.Pix[dy*dst.Stride : dy*dst.Stride+width*4]
			for x := 0; x < width; x++ {
				si := x * 4
				dx := width - 1 - x
				di := dx * 4
				dRow[di+0] = sRow[si+2]
				dRow[di+1] = sRow[si+1]
				dRow[di+2] = sRow[si+0]
				dRow[di+3] = 255
			}
		}
		return dst
	case dxgiModeRotationRotate270:
		dst := GetRGBA(height, width)
		for y := 0; y < height; y++ {
			sRow := src[y*pitch : y*pitch+width*4]
			for x := 0; x < width; x++ {
				si := x * 4
				dx := y
				dy := width - 1 - x
				di := dy*dst.Stride + dx*4
				dst.Pix[di+0] = sRow[si+2]
				dst.Pix[di+1] = sRow[si+1]
				dst.Pix[di+2] = sRow[si+0]
				dst.Pix[di+3] = 255
			}
		}
		return dst
	default:
		dst := GetRGBA(width, height)
		for y := 0; y < height; y++ {
			sRow := src[y*pitch : y*pitch+width*4]
			dRow := dst.Pix[y*dst.Stride : y*dst.Stride+width*4]
			for x := 0; x < width; x++ {
				si := x * 4
				di := si
				dRow[di+0] = sRow[si+2]
				dRow[di+1] = sRow[si+1]
				dRow[di+2] = sRow[si+0]
				dRow[di+3] = 255
			}
		}
		return dst
	}
}

func convertBGRAScaled(src []byte, pitch, srcW, srcH, dstW, dstH int, rotation uint32) *image.RGBA {
	if rotation != dxgiModeRotationIdentity && rotation != 0 {
		return nil
	}
	if len(src) < (srcH-1)*pitch+srcW*4 {
		return nil
	}
	dst := GetRGBA(dstW, dstH)
	xOff := make([]int, dstW)
	for x := 0; x < dstW; x++ {
		xOff[x] = (x * srcW / dstW) * 4
	}
	dstPix := dst.Pix
	dstStride := dst.Stride
	for y := 0; y < dstH; y++ {
		sy := y * srcH / dstH
		sRow := src[sy*pitch:]
		dp := y * dstStride
		for x := 0; x < dstW; x++ {
			si := xOff[x]
			di := dp + x*4
			dstPix[di+0] = sRow[si+2]
			dstPix[di+1] = sRow[si+1]
			dstPix[di+2] = sRow[si+0]
			dstPix[di+3] = 255
		}
	}
	return dst
}

func drawCursorRotated(img *image.RGBA, cursorBounds, captureBounds image.Rectangle, rotation uint32) {
	if !cursorCaptureEnabled.Load() {
		return
	}
	var ci cursorInfo
	ci.cbSize = uint32(unsafe.Sizeof(ci))
	ret, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci)))
	if ret == 0 || (ci.flags&CURSOR_SHOWING) == 0 || ci.hCursor == 0 {
		return
	}

	curX := ci.ptScreenPos.x
	curY := ci.ptScreenPos.y

	if cursorBounds.Empty() {
		cursorBounds = captureBounds
	}

	localX := int(curX) - cursorBounds.Min.X
	localY := int(curY) - cursorBounds.Min.Y
	if localX < 0 || localY < 0 || localX >= cursorBounds.Dx() || localY >= cursorBounds.Dy() {
		return
	}

	scaleX := float64(captureBounds.Dx()) / float64(cursorBounds.Dx())
	scaleY := float64(captureBounds.Dy()) / float64(cursorBounds.Dy())
	localX = int(float64(localX) * scaleX)
	localY = int(float64(localY) * scaleY)

	w := captureBounds.Dx()
	h := captureBounds.Dy()
	var rx, ry int
	switch rotation {
	case dxgiModeRotationRotate90:
		rx = h - 1 - localY
		ry = localX
	case dxgiModeRotationRotate180:
		rx = w - 1 - localX
		ry = h - 1 - localY
	case dxgiModeRotationRotate270:
		rx = localY
		ry = w - 1 - localX
	default:
		rx = localX
		ry = localY
	}
	rotBounds := image.Rect(0, 0, img.Bounds().Dx(), img.Bounds().Dy())

	// Performance-first cursor overlay for duplication path: avoid per-frame
	// icon extraction/DC composition and draw a lightweight software cursor.
	drawCursor(img, int32(rx), int32(ry), rotBounds)
}

func drawRealCursorOnImage(img *image.RGBA, hCursor uintptr, hotX, hotY, xHotspot, yHotspot int32) bool {
	if img == nil || hCursor == 0 {
		return false
	}
	w := img.Bounds().Dx()
	h := img.Bounds().Dy()
	if w <= 0 || h <= 0 {
		return false
	}

	hdcScreen := createDisplayDC()
	fromCreateDC := hdcScreen != 0
	if hdcScreen == 0 {
		hdcScreen = getDC(0)
		if hdcScreen == 0 {
			return false
		}
	}
	defer func() {
		if fromCreateDC {
			deleteDC(hdcScreen)
		} else {
			releaseDC(0, hdcScreen)
		}
	}()

	hdcMem := createCompatibleDC(hdcScreen)
	if hdcMem == 0 {
		return false
	}
	defer deleteDC(hdcMem)

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
		return false
	}
	defer deleteObject(hbmp)

	old := selectObject(hdcMem, hbmp)
	if old == 0 {
		return false
	}
	defer selectObject(hdcMem, old)

	dib := unsafe.Slice((*byte)(bits), len(img.Pix))
	copy(dib, img.Pix)

	x := hotX - xHotspot
	y := hotY - yHotspot
	r, _, _ := procDrawIconEx.Call(
		hdcMem,
		uintptr(x),
		uintptr(y),
		hCursor,
		0,
		0,
		0,
		0,
		uintptr(DI_NORMAL),
	)
	if r == 0 {
		return false
	}

	copy(img.Pix, dib)
	return true
}
