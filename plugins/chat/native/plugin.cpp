/*
 * Chat Plugin — spawns a Win32 chat window on the target (Windows only).
 *
 * Build (MSVC):
 *   cl /LD /EHsc /O2 plugin.cpp /Fe:chat-windows-amd64.dll user32.lib gdi32.lib uxtheme.lib dwmapi.lib
 *
 * Build (MinGW):
 *   x86_64-w64-mingw32-g++ -shared -O2 -o chat-windows-amd64.dll plugin.cpp -luser32 -lgdi32 -luxtheme -ldwmapi
 */

#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <string>

#define EXPORT extern "C" __declspec(dllexport)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <uxtheme.h>
#include <dwmapi.h>

#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif
#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1
#define DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1 19
#endif

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

#define WM_CHAT_APPEND (WM_APP + 1)
#define WM_CHAT_CLOSE  (WM_APP + 2)

#define IDC_LOG   101
#define IDC_INPUT 102
#define IDC_SEND  103

static const char *WND_CLASS_NAME = "OverlordChatWnd";

/* ------------------------------------------------------------------ */
/* Host callback                                                       */
/* ------------------------------------------------------------------ */

typedef void (__stdcall *host_callback_t)(
    const char *event, uintptr_t eventLen,
    const char *payload, uintptr_t payloadLen);

/* ------------------------------------------------------------------ */
/* Chat configuration                                                  */
/* ------------------------------------------------------------------ */

struct ChatConfig {
    char operatorName[128];
    char targetName[128];
    char title[256];
    bool closable;
    bool alwaysOnTop;
};

/* ------------------------------------------------------------------ */
/* Global state                                                        */
/* ------------------------------------------------------------------ */

static host_callback_t g_callback       = nullptr;
static CRITICAL_SECTION g_cs;
static bool             g_cs_init       = false;
static char             g_client_id[256] = {0};
static ChatConfig       g_config        = {"Operator", "User", "Chat", true, false};
static HWND             g_hwnd          = NULL;
static HWND             g_hwnd_log      = NULL;
static HWND             g_hwnd_input    = NULL;
static HWND             g_hwnd_send     = NULL;
static HANDLE           g_thread        = NULL;
static bool             g_class_reg     = false;
static HFONT            g_font          = NULL;
static HBRUSH           g_bg_brush      = NULL;
static HBRUSH           g_log_brush     = NULL;
static HBRUSH           g_input_brush   = NULL;
static WNDPROC          g_orig_input_proc = NULL;
static HINSTANCE        g_hInstance     = NULL;

/* ------------------------------------------------------------------ */
/* DllMain                                                             */
/* ------------------------------------------------------------------ */

BOOL WINAPI DllMain(HINSTANCE hDll, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) g_hInstance = hDll;
    return TRUE;
}

/* ------------------------------------------------------------------ */
/* JSON helpers                                                        */
/* ------------------------------------------------------------------ */

static std::string json_extract(const char *json, int len, const char *key) {
    if (!json || len <= 0) return "";
    std::string hay(json, (size_t)len);
    std::string needle = std::string("\"") + key + "\":\"";
    auto pos = hay.find(needle);
    if (pos == std::string::npos) {
        needle = std::string("\"") + key + "\": \"";
        pos = hay.find(needle);
    }
    if (pos == std::string::npos) return "";
    pos += needle.size();
    std::string result;
    while (pos < hay.size() && hay[pos] != '"') {
        if (hay[pos] == '\\' && pos + 1 < hay.size()) {
            pos++;
            switch (hay[pos]) {
                case '"':  result += '"';  break;
                case '\\': result += '\\'; break;
                case 'n':  result += '\n'; break;
                case 'r':  result += '\r'; break;
                case 't':  result += '\t'; break;
                default:   result += hay[pos]; break;
            }
        } else {
            result += hay[pos];
        }
        pos++;
    }
    return result;
}

static bool json_extract_bool(const char *json, int len, const char *key, bool def) {
    if (!json || len <= 0) return def;
    std::string hay(json, (size_t)len);
    std::string needle = std::string("\"") + key + "\":";
    auto pos = hay.find(needle);
    if (pos == std::string::npos) return def;
    pos += needle.size();
    while (pos < hay.size() && hay[pos] == ' ') pos++;
    if (pos >= hay.size()) return def;
    return hay[pos] == 't';
}

static std::string json_escape(const std::string &s) {
    std::string out;
    out.reserve(s.size() + 16);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if ((unsigned char)c >= 0x20) out += c;
                break;
        }
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* send_event — call host callback                                     */
/* ------------------------------------------------------------------ */

static void send_event(const char *event, const char *payload) {
    host_callback_t cb = g_callback;
    if (!cb) return;
    int elen = event   ? (int)strlen(event)   : 0;
    int plen = payload ? (int)strlen(payload)  : 0;
    cb(event, (uintptr_t)elen, payload, (uintptr_t)plen);
}

/* ------------------------------------------------------------------ */
/* Chat window helpers                                                 */
/* ------------------------------------------------------------------ */

static void append_to_log(const char *text) {
    if (!g_hwnd_log) return;
    int len = GetWindowTextLengthA(g_hwnd_log);
    SendMessageA(g_hwnd_log, EM_SETSEL, (WPARAM)len, (LPARAM)len);
    SendMessageA(g_hwnd_log, EM_REPLACESEL, FALSE, (LPARAM)text);
    SendMessageA(g_hwnd_log, EM_SCROLLCARET, 0, 0);
}

static void do_send_message() {
    char buf[4096];
    int len = GetWindowTextA(g_hwnd_input, buf, sizeof(buf));
    if (len <= 0) return;
    SetWindowTextA(g_hwnd_input, "");

    std::string text(buf, (size_t)len);
    std::string display = std::string(g_config.targetName) + ": " + text + "\r\n";
    append_to_log(display.c_str());

    std::string payload = "{\"from\":\"" + json_escape(g_config.targetName) +
                          "\",\"text\":\"" + json_escape(text) + "\"}";
    send_event("chat_message", payload.c_str());
}

/* ------------------------------------------------------------------ */
/* Input subclass — Enter key sends message                            */
/* ------------------------------------------------------------------ */

static LRESULT CALLBACK InputSubclassProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_KEYDOWN && wp == VK_RETURN) {
        do_send_message();
        return 0;
    }
    return CallWindowProcA(g_orig_input_proc, hwnd, msg, wp, lp);
}

/* ------------------------------------------------------------------ */
/* Window procedure                                                    */
/* ------------------------------------------------------------------ */

static LRESULT CALLBACK ChatWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {

    case WM_CREATE: {
        g_bg_brush    = CreateSolidBrush(RGB(30, 33, 40));
        g_log_brush   = CreateSolidBrush(RGB(18, 20, 26));
        g_input_brush = CreateSolidBrush(RGB(35, 38, 48));
        g_font = CreateFontA(-15, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                             CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, "Segoe UI");

        g_hwnd_log = CreateWindowExA(
            0, "EDIT", "",
            WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL,
            0, 0, 0, 0, hwnd, (HMENU)(uintptr_t)IDC_LOG, g_hInstance, NULL);

        SetWindowTheme(g_hwnd_log, L"DarkMode_Explorer", NULL);

        g_hwnd_input = CreateWindowExA(
            0, "EDIT", "",
            WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | WS_TABSTOP,
            0, 0, 0, 0, hwnd, (HMENU)(uintptr_t)IDC_INPUT, g_hInstance, NULL);

        SetWindowTheme(g_hwnd_input, L"DarkMode_Explorer", NULL);

        g_hwnd_send = CreateWindowExA(
            0, "BUTTON", "Send",
            WS_CHILD | WS_VISIBLE | BS_OWNERDRAW | WS_TABSTOP,
            0, 0, 0, 0, hwnd, (HMENU)(uintptr_t)IDC_SEND, g_hInstance, NULL);

        SendMessageA(g_hwnd_log,   WM_SETFONT, (WPARAM)g_font, TRUE);
        SendMessageA(g_hwnd_input, WM_SETFONT, (WPARAM)g_font, TRUE);
        SendMessageA(g_hwnd_send,  WM_SETFONT, (WPARAM)g_font, TRUE);

        g_orig_input_proc = (WNDPROC)SetWindowLongPtrA(
            g_hwnd_input, GWLP_WNDPROC, (LONG_PTR)InputSubclassProc);

        if (!g_config.closable) {
            HMENU sys = GetSystemMenu(hwnd, FALSE);
            if (sys) EnableMenuItem(sys, SC_CLOSE, MF_BYCOMMAND | MF_DISABLED | MF_GRAYED);
        }

        return 0;
    }

    case WM_SIZE: {
        RECT rc;
        GetClientRect(hwnd, &rc);
        int w = rc.right, h = rc.bottom;
        int pad = 10, inputH = 32, btnW = 65, gap = 8;

        MoveWindow(g_hwnd_log,   pad, pad, w - 2 * pad, h - inputH - 3 * pad, TRUE);
        MoveWindow(g_hwnd_input, pad, h - inputH - pad, w - btnW - 2 * pad - gap, inputH, TRUE);
        MoveWindow(g_hwnd_send,  w - btnW - pad, h - inputH - pad, btnW, inputH, TRUE);
        return 0;
    }

    case WM_GETMINMAXINFO: {
        MINMAXINFO *mmi = (MINMAXINFO *)lp;
        mmi->ptMinTrackSize.x = 300;
        mmi->ptMinTrackSize.y = 250;
        return 0;
    }

    case WM_COMMAND:
        if (LOWORD(wp) == IDC_SEND && HIWORD(wp) == BN_CLICKED) {
            do_send_message();
            SetFocus(g_hwnd_input);
            return 0;
        }
        break;

    case WM_CTLCOLOREDIT: {
        HDC hdc = (HDC)wp;
        HWND ctrl = (HWND)lp;
        SetTextColor(hdc, RGB(220, 225, 234));
        if (ctrl == g_hwnd_log) {
            SetBkColor(hdc, RGB(18, 20, 26));
            return (LRESULT)g_log_brush;
        }
        SetBkColor(hdc, RGB(35, 38, 48));
        return (LRESULT)g_input_brush;
    }

    case WM_CTLCOLORSTATIC: {
        HDC hdc = (HDC)wp;
        SetTextColor(hdc, RGB(220, 225, 234));
        SetBkColor(hdc, RGB(18, 20, 26));
        return (LRESULT)g_log_brush;
    }

    case WM_ERASEBKGND: {
        HDC hdc = (HDC)wp;
        RECT rc;
        GetClientRect(hwnd, &rc);
        FillRect(hdc, &rc, g_bg_brush);
        return 1;
    }

    case WM_DRAWITEM: {
        DRAWITEMSTRUCT *dis = (DRAWITEMSTRUCT *)lp;
        if (dis->CtlID == IDC_SEND) {
            COLORREF col = (dis->itemState & ODS_SELECTED)
                               ? RGB(29, 78, 216)
                               : RGB(37, 99, 235);
            HBRUSH br = CreateSolidBrush(col);
            FillRect(dis->hDC, &dis->rcItem, br);
            DeleteObject(br);

            HPEN pen = CreatePen(PS_SOLID, 1, RGB(30, 64, 175));
            HPEN oldPen = (HPEN)SelectObject(dis->hDC, pen);
            HBRUSH oldBr = (HBRUSH)SelectObject(dis->hDC, GetStockObject(NULL_BRUSH));
            RoundRect(dis->hDC, dis->rcItem.left, dis->rcItem.top,
                      dis->rcItem.right, dis->rcItem.bottom, 6, 6);
            SelectObject(dis->hDC, oldPen);
            SelectObject(dis->hDC, oldBr);
            DeleteObject(pen);

            SetTextColor(dis->hDC, RGB(255, 255, 255));
            SetBkMode(dis->hDC, TRANSPARENT);
            SelectObject(dis->hDC, g_font);
            DrawTextA(dis->hDC, "Send", -1, &dis->rcItem,
                      DT_CENTER | DT_VCENTER | DT_SINGLELINE);
            return TRUE;
        }
        break;
    }

    case WM_CHAT_APPEND: {
        char *text = (char *)lp;
        if (text) {
            append_to_log(text);
            free(text);
        }
        return 0;
    }

    case WM_CHAT_CLOSE:
        DestroyWindow(hwnd);
        return 0;

    case WM_CLOSE:
        if (!g_config.closable) return 0;
        send_event("chat_closed", "{}");
        DestroyWindow(hwnd);
        return 0;

    case WM_DESTROY:
        if (g_orig_input_proc && g_hwnd_input) {
            SetWindowLongPtrA(g_hwnd_input, GWLP_WNDPROC, (LONG_PTR)g_orig_input_proc);
            g_orig_input_proc = NULL;
        }
        g_hwnd_log   = NULL;
        g_hwnd_input = NULL;
        g_hwnd_send  = NULL;
        g_hwnd       = NULL;
        if (g_font)        { DeleteObject(g_font);        g_font        = NULL; }
        if (g_bg_brush)    { DeleteObject(g_bg_brush);    g_bg_brush    = NULL; }
        if (g_log_brush)   { DeleteObject(g_log_brush);   g_log_brush   = NULL; }
        if (g_input_brush) { DeleteObject(g_input_brush); g_input_brush = NULL; }
        PostQuitMessage(0);
        return 0;
    }

    return DefWindowProcA(hwnd, msg, wp, lp);
}

/* ------------------------------------------------------------------ */
/* Window thread                                                       */
/* ------------------------------------------------------------------ */

static DWORD WINAPI WindowThreadProc(LPVOID) {
    if (!g_class_reg) {
        WNDCLASSEXA wc = {};
        wc.cbSize        = sizeof(wc);
        wc.style         = CS_HREDRAW | CS_VREDRAW;
        wc.lpfnWndProc   = ChatWndProc;
        wc.hInstance      = g_hInstance;
        wc.hCursor       = LoadCursor(NULL, IDC_ARROW);
        wc.lpszClassName = WND_CLASS_NAME;
        wc.hbrBackground = NULL;
        if (RegisterClassExA(&wc)) g_class_reg = true;
        else return 1;
    }

    int screenW = GetSystemMetrics(SM_CXSCREEN);
    int screenH = GetSystemMetrics(SM_CYSCREEN);
    int winW = 420, winH = 520;
    int x = (screenW - winW) / 2;
    int y = (screenH - winH) / 2;

    DWORD style = WS_OVERLAPPEDWINDOW;
    if (!g_config.closable) {
        style &= ~WS_SYSMENU;
        style |= WS_CAPTION | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME;
    }

    g_hwnd = CreateWindowExA(
        g_config.alwaysOnTop ? WS_EX_TOPMOST : 0,
        WND_CLASS_NAME, g_config.title,
        style,
        x, y, winW, winH,
        NULL, NULL, g_hInstance, NULL);

    if (!g_hwnd) return 1;

    BOOL darkTitleBar = TRUE;
    if (FAILED(DwmSetWindowAttribute(g_hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE,
                                     &darkTitleBar, sizeof(darkTitleBar)))) {
        DwmSetWindowAttribute(g_hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE_BEFORE_20H1,
                              &darkTitleBar, sizeof(darkTitleBar));
    }

    ShowWindow(g_hwnd, SW_SHOW);
    UpdateWindow(g_hwnd);
    SetForegroundWindow(g_hwnd);

    send_event("chat_opened", "{}");

    MSG msg;
    while (GetMessageA(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageA(&msg);
    }

    return 0;
}

/* ------------------------------------------------------------------ */
/* Open / close helpers                                                */
/* ------------------------------------------------------------------ */

static void close_chat_window() {
    if (g_hwnd) {
        PostMessageA(g_hwnd, WM_CHAT_CLOSE, 0, 0);
    }
    if (g_thread) {
        if (WaitForSingleObject(g_thread, 5000) == WAIT_TIMEOUT) {
            TerminateThread(g_thread, 0);
        }
        CloseHandle(g_thread);
        g_thread = NULL;
    }
}

static void open_chat_window() {
    close_chat_window();
    g_thread = CreateThread(NULL, 0, WindowThreadProc, NULL, 0, NULL);
}

/* ------------------------------------------------------------------ */
/* Plugin ABI exports                                                  */
/* ------------------------------------------------------------------ */

EXPORT const char *PluginGetRuntime() {
    return "cpp";
}

EXPORT void PluginSetCallback(uint64_t cb) {
    g_callback = reinterpret_cast<host_callback_t>(static_cast<uintptr_t>(cb));
}

EXPORT int PluginOnLoad(const char *hostInfo, int hostInfoLen, uint64_t cb) {
    g_callback = reinterpret_cast<host_callback_t>(static_cast<uintptr_t>(cb));

    if (!g_cs_init) {
        InitializeCriticalSection(&g_cs);
        g_cs_init = true;
    }

    std::string cid = json_extract(hostInfo, hostInfoLen, "clientId");
    strncpy(g_client_id, cid.c_str(), sizeof(g_client_id) - 1);
    g_client_id[sizeof(g_client_id) - 1] = '\0';

    fprintf(stderr, "[chat] loaded, clientId=%s\n", g_client_id);
    send_event("ready", "{\"message\":\"chat plugin ready\"}");
    return 0;
}

EXPORT int PluginOnEvent(const char *event, int eventLen,
                         const char *payload, int payloadLen) {
    std::string ev(event, (size_t)eventLen);
    std::string pl(payload ? payload : "", payload ? (size_t)payloadLen : 0u);

    if (ev == "open_chat") {
        std::string opName = json_extract(pl.c_str(), (int)pl.size(), "operatorName");
        std::string tgName = json_extract(pl.c_str(), (int)pl.size(), "targetName");
        std::string title  = json_extract(pl.c_str(), (int)pl.size(), "title");
        bool closable      = json_extract_bool(pl.c_str(), (int)pl.size(), "closable", true);
        bool onTop          = json_extract_bool(pl.c_str(), (int)pl.size(), "alwaysOnTop", false);

        EnterCriticalSection(&g_cs);
        if (!opName.empty()) strncpy(g_config.operatorName, opName.c_str(), sizeof(g_config.operatorName) - 1);
        if (!tgName.empty()) strncpy(g_config.targetName,   tgName.c_str(), sizeof(g_config.targetName)   - 1);
        if (!title.empty())  strncpy(g_config.title,         title.c_str(),  sizeof(g_config.title)        - 1);
        g_config.closable    = closable;
        g_config.alwaysOnTop = onTop;
        LeaveCriticalSection(&g_cs);

        open_chat_window();
        return 0;
    }

    if (ev == "chat_message") {
        std::string from = json_extract(pl.c_str(), (int)pl.size(), "from");
        std::string text = json_extract(pl.c_str(), (int)pl.size(), "text");
        if (from.empty()) from = g_config.operatorName;
        std::string display = from + ": " + text + "\r\n";

        if (g_hwnd) {
            char *dup = _strdup(display.c_str());
            PostMessageA(g_hwnd, WM_CHAT_APPEND, 0, (LPARAM)dup);
        }
        return 0;
    }

    if (ev == "close_chat") {
        if (g_hwnd) send_event("chat_closed", "{}");
        close_chat_window();
        return 0;
    }

    fprintf(stderr, "[chat] unhandled event: %s\n", ev.c_str());
    return 0;
}

EXPORT void PluginOnUnload() {
    fprintf(stderr, "[chat] unloading\n");
    close_chat_window();
    g_callback = nullptr;
    g_client_id[0] = '\0';
    if (g_cs_init) {
        DeleteCriticalSection(&g_cs);
        g_cs_init = false;
    }
    if (g_class_reg) {
        UnregisterClassA(WND_CLASS_NAME, g_hInstance);
        g_class_reg = false;
    }
}
