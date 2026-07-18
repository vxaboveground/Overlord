//go:build windows

package capture

import (
	"fmt"
	"image"
	"sort"
	"strings"
	"sync"
	"time"
	"unsafe"
)

const desktopCapabilityCacheTTL = 10 * time.Minute

var desktopCapabilityCache = struct {
	sync.Mutex
	entries map[string]desktopCapabilityCacheEntry
}{entries: make(map[string]desktopCapabilityCacheEntry)}

type desktopCapabilityCacheEntry struct {
	at   time.Time
	caps DesktopEncoderCapabilities
}

type desktopProbeSize struct {
	maxHeight int
	width     int
	height    int
}

type desktopProfileProbe struct {
	name string
	run  func(h264D3D11TextureRequest) (time.Duration, error)
}

func ProbeDesktopEncoderCapabilities(display int) DesktopEncoderCapabilities {
	bounds := DisplayBounds(display)
	cacheKey := fmt.Sprintf("%d:%d:%d:%d:%d:%.3f", display, bounds.Min.X, bounds.Min.Y, bounds.Dx(), bounds.Dy(), captureScale())
	desktopCapabilityCache.Lock()
	if cached, ok := desktopCapabilityCache.entries[cacheKey]; ok && time.Since(cached.at) < desktopCapabilityCacheTTL {
		desktopCapabilityCache.Unlock()
		return cached.caps
	}
	caps := probeDesktopEncoderCapabilities(display, bounds)
	caps = completeDesktopEncoderCapabilities(caps)
	desktopCapabilityCache.entries[cacheKey] = desktopCapabilityCacheEntry{at: time.Now(), caps: caps}
	for key, entry := range desktopCapabilityCache.entries {
		if time.Since(entry.at) >= desktopCapabilityCacheTTL {
			delete(desktopCapabilityCache.entries, key)
		}
	}
	desktopCapabilityCache.Unlock()
	return caps
}

func probeDesktopEncoderCapabilities(display int, bounds image.Rectangle) DesktopEncoderCapabilities {
	caps := DesktopEncoderCapabilities{Display: display}
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		caps.Profiles = safeDesktopProfiles(1280, 720)
		caps.Detail = "Could not determine the selected display size; safe software profiles are shown."
		return caps
	}

	factory, err := createDXGIFactory1()
	if err != nil {
		caps.Profiles = safeDesktopProfiles(bounds.Dx(), bounds.Dy())
		caps.Detail = err.Error()
		return caps
	}
	defer factory.Release()
	output, adapter, _, err := findOutput(factory, "", bounds, display)
	if err != nil {
		caps.Profiles = safeDesktopProfiles(bounds.Dx(), bounds.Dy())
		caps.Detail = err.Error()
		return caps
	}
	defer output.Release()
	defer adapter.Release()
	device, context, err := createD3DDevice(adapter)
	if err != nil {
		caps.Profiles = safeDesktopProfiles(bounds.Dx(), bounds.Dy())
		caps.Detail = err.Error()
		return caps
	}
	defer context.Release()
	defer device.Release()

	nativeWidth, nativeHeight := even(bounds.Dx()), even(bounds.Dy())
	textureDesc := d3d11Texture2DDesc{
		Width:     uint32(nativeWidth),
		Height:    uint32(nativeHeight),
		MipLevels: 1,
		ArraySize: 1,
		Format:    dxgiFormatB8G8R8A8UNorm,
	}
	textureDesc.SampleDesc.Count = 1
	var texture *d3d11Texture2D
	if hr := device.CreateTexture2D(&textureDesc, nil, &texture); hr != S_OK || texture == nil {
		caps.Profiles = safeDesktopProfiles(nativeWidth, nativeHeight)
		caps.Detail = fmt.Sprintf("D3D11 capability texture creation failed 0x%x", hr)
		return caps
	}
	defer texture.Release()

	probes := []desktopProfileProbe{
		{name: "NVIDIA NVENC", run: func(req h264D3D11TextureRequest) (time.Duration, error) {
			return probeNativeD3D11TextureProfile(req.Device, req.Texture, req.InputWidth, req.InputHeight, req.EncodeWidth, req.EncodeHeight, req.FPS, req.DXGIFormat)
		}},
	}
	if backend := newQSVD3D11TextureBackend(); backend != nil {
		probes = append(probes, backendProfileProbe(backend))
	}
	if backend := newAMFD3D11TextureBackend(); backend != nil {
		probes = append(probes, backendProfileProbe(backend))
	}

	fpsOptions := []int{240, 165, 144, 120, 90, 60, 30}
	sizes := desktopProbeSizes(nativeWidth, nativeHeight)
	providersByProfile := make(map[string][]string)
	for _, size := range sizes {
		for _, probe := range probes {
			maxFPS := 0
			for _, fps := range fpsOptions {
				req := h264D3D11TextureRequest{
					Device: unsafe.Pointer(device), Texture: unsafe.Pointer(texture),
					InputWidth: nativeWidth, InputHeight: nativeHeight,
					EncodeWidth: size.width, EncodeHeight: size.height,
					FPS: fps, DXGIFormat: dxgiFormatB8G8R8A8UNorm, ForceIDR: true,
				}
				averageEncode, err := probe.run(req)
				frameBudget := time.Second / time.Duration(fps)
				if err == nil && averageEncode <= frameBudget+frameBudget/5 {
					maxFPS = fps
					break
				}
			}
			if maxFPS == 0 {
				continue
			}
			for _, fps := range fpsOptions {
				if fps <= maxFPS {
					key := desktopProfileKey(size.width, size.height, fps)
					providersByProfile[key] = appendUniqueString(providersByProfile[key], probe.name)
				}
			}
		}
	}
	hardwareProfilesFound := len(providersByProfile) > 0

	for _, safe := range safeDesktopProfiles(nativeWidth, nativeHeight) {
		key := desktopProfileKey(safe.Width, safe.Height, safe.FPS)
		providersByProfile[key] = appendUniqueString(providersByProfile[key], "Software H.264 / JPEG")
	}

	for _, size := range sizes {
		for _, fps := range fpsOptions {
			providers := providersByProfile[desktopProfileKey(size.width, size.height, fps)]
			if len(providers) == 0 {
				continue
			}
			caps.Profiles = append(caps.Profiles, DesktopEncoderProfile{
				MaxHeight: size.maxHeight, Width: size.width, Height: size.height, FPS: fps,
				Label: desktopProfileLabel(size.width, size.height, fps), Providers: providers,
			})
		}
	}
	sort.SliceStable(caps.Profiles, func(i, j int) bool {
		if caps.Profiles[i].Height != caps.Profiles[j].Height {
			return caps.Profiles[i].Height < caps.Profiles[j].Height
		}
		return caps.Profiles[i].FPS > caps.Profiles[j].FPS
	})
	caps.Probed = true
	if len(caps.Profiles) == 0 {
		caps.Profiles = safeDesktopProfiles(nativeWidth, nativeHeight)
	}
	if !hardwareProfilesFound {
		caps.Detail = "No hardware H.264 profile initialized successfully; safe software profiles are shown."
	} else {
		caps.Detail = "Profiles were tested on the selected display adapter."
	}
	return caps
}

func backendProfileProbe(backend h264D3D11TextureBackend) desktopProfileProbe {
	return desktopProfileProbe{name: backend.Name(), run: func(req h264D3D11TextureRequest) (time.Duration, error) {
		defer backend.Reset()
		producedOutput := false
		for frame := 0; frame < 2; frame++ {
			req.ForceIDR = frame == 0
			out, err := backend.Encode(req)
			if err != nil {
				return 0, err
			}
			producedOutput = producedOutput || len(out) > 0
		}
		started := time.Now()
		for frame := 0; frame < 6; frame++ {
			req.ForceIDR = false
			out, err := backend.Encode(req)
			if err != nil {
				return 0, err
			}
			producedOutput = producedOutput || len(out) > 0
		}
		average := time.Since(started) / 6
		if !producedOutput {
			return average, fmt.Errorf("encoder produced no output during capability probe")
		}
		return average, nil
	}}
}

func desktopProbeSizes(nativeWidth, nativeHeight int) []desktopProbeSize {
	maxHeights := []int{720, 1080, 1440, -1}
	seen := make(map[string]bool)
	out := make([]desktopProbeSize, 0, len(maxHeights))
	for _, maxHeight := range maxHeights {
		scale := captureScale()
		if maxHeight > 0 && nativeHeight > maxHeight {
			if capScale := float64(maxHeight) / float64(nativeHeight); capScale < scale {
				scale = capScale
			}
		}
		width, height := even(int(float64(nativeWidth)*scale)), even(int(float64(nativeHeight)*scale))
		if width <= 0 || height <= 0 {
			continue
		}
		key := fmt.Sprintf("%dx%d", width, height)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, desktopProbeSize{maxHeight: maxHeight, width: width, height: height})
	}
	return out
}

func safeDesktopProfiles(nativeWidth, nativeHeight int) []DesktopEncoderProfile {
	profiles := make([]DesktopEncoderProfile, 0, 4)
	for _, size := range desktopProbeSizes(even(nativeWidth), even(nativeHeight)) {
		if size.height > 1080 {
			continue
		}
		for _, fps := range []int{60, 30} {
			profiles = append(profiles, DesktopEncoderProfile{
				MaxHeight: size.maxHeight, Width: size.width, Height: size.height, FPS: fps,
				Label: desktopProfileLabel(size.width, size.height, fps), Providers: []string{"Software H.264 / JPEG"},
			})
		}
	}
	return profiles
}

func desktopProfileKey(width, height, fps int) string {
	return fmt.Sprintf("%dx%d@%d", width, height, fps)
}

func desktopProfileLabel(width, height, fps int) string {
	resolution := fmt.Sprintf("%dx%d", width, height)
	if height == 720 || height == 1080 || height == 1440 || height == 2160 {
		resolution = fmt.Sprintf("%dp", height)
	}
	return fmt.Sprintf("%d FPS - %s", fps, resolution)
}

func appendUniqueString(values []string, value string) []string {
	for _, existing := range values {
		if strings.EqualFold(existing, value) {
			return values
		}
	}
	return append(values, value)
}

func even(value int) int { return value - value%2 }
