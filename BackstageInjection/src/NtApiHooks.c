//===============================================================================================//
// NT API Hooking Implementation
//===============================================================================================//
#ifdef __cplusplus
extern "C" {
#endif

#include "NtApiHooks.h"
#include "NtApiHooksConfig.h"
#include "MinHook.h"
#include <stdio.h>
#include <string.h>

#ifdef _MSC_VER
#pragma comment(lib, "ntdll.lib")
#endif

// Portable secure string helpers for MinGW compatibility
#ifndef _MSC_VER
#ifndef _HVNC_PORTABLE_CRT
#define _HVNC_PORTABLE_CRT
static inline void _hvnc_wcsncpy_s(wchar_t *dst, size_t dstSize, const wchar_t *src, size_t count) {
    if (!dst || dstSize == 0) return;
    size_t toCopy = (count < dstSize - 1) ? count : dstSize - 1;
    size_t i;
    for (i = 0; i < toCopy && src[i] != L'\0'; i++)
        dst[i] = src[i];
    dst[i] = L'\0';
}
#define wcsncpy_s(dst, dstSize, src, count) _hvnc_wcsncpy_s((dst), (dstSize), (src), (count))
#define sprintf_s(buf, size, ...) snprintf((buf), (size), __VA_ARGS__)
#endif
#endif

    // Global search and replacement strings (filled from environment variables).
    // 2048 WCHARs (4 KB) accommodates deep UNC paths and long-path-enabled paths
    // well beyond the legacy MAX_PATH of 260.
    static WCHAR g_SearchString[2048] = { 0 };
    static WCHAR g_ReplacementString[2048] = { 0 };

    // UNICODE_STRING.Length / .MaximumLength are USHORT (max 65,535 bytes = 32,767 WCHARs).
    // Any replacement path longer than this cannot be represented without wrapping.
    #define UNICODE_STRING_MAX_WCHARS  ((SIZE_T)32767)
    static BOOL g_HooksInitialized = FALSE;
    static HANDLE g_LogFile = INVALID_HANDLE_VALUE;
    static HANDLE g_CrashLog = INVALID_HANDLE_VALUE;
    static volatile LONG g_CrashStageSeq = 0;
    static char g_CrashStage[192] = "not started";
    static LPTOP_LEVEL_EXCEPTION_FILTER g_PreviousUnhandledFilter = NULL;

    // %TEMP%\crashlogovd.log
    // Both CrashLog (narrow) and CrashLogW (wide) write UTF-16LE so the file
    // is a single coherent encoding.  The BOM is written once when the file is
    // opened (see InstallNtApiHooks).  This makes paths containing Cyrillic,
    // Chinese, Arabic, etc. readable in any standard text editor.
    void CrashLog(const char* message) {
        if (g_CrashLog != INVALID_HANDLE_VALUE) {
            DWORD written;
            // Convert the narrow (ASCII/UTF-8) string to UTF-16LE before writing
            // so the file stays a single coherent encoding.
            int wlen = MultiByteToWideChar(CP_ACP, 0, message, -1, NULL, 0);
            if (wlen > 0) {
                WCHAR wbuf[512];
                int copyLen = (wlen <= 512) ? wlen : 512;
                MultiByteToWideChar(CP_ACP, 0, message, -1, wbuf, copyLen);
                wbuf[copyLen - 1] = L'\0'; // ensure null termination
                DWORD byteLen = (DWORD)(wcslen(wbuf) * sizeof(WCHAR));
                WriteFile(g_CrashLog, wbuf, byteLen, &written, NULL);
            }
            const WCHAR newline[] = L"\r\n";
            WriteFile(g_CrashLog, newline, (DWORD)(2 * sizeof(WCHAR)), &written, NULL);
            FlushFileBuffers(g_CrashLog);
        }
    }

    void CrashLogW(const WCHAR* message) {
        if (g_CrashLog != INVALID_HANDLE_VALUE) {
            DWORD written;
            DWORD messageLen = (DWORD)wcslen(message) * sizeof(WCHAR);
            WriteFile(g_CrashLog, message, messageLen, &written, NULL);
            const WCHAR newline[] = L"\r\n";
            WriteFile(g_CrashLog, newline, (DWORD)(2 * sizeof(WCHAR)), &written, NULL);
            FlushFileBuffers(g_CrashLog);
        }
    }

    static void SetCrashStage(const char* stage) {
        if (!stage) return;

        size_t i = 0;
        for (; i < sizeof(g_CrashStage) - 1 && stage[i] != '\0'; i++) {
            g_CrashStage[i] = stage[i];
        }
        g_CrashStage[i] = '\0';

        LONG seq = InterlockedIncrement(&g_CrashStageSeq);
        char msg[256];
        sprintf_s(msg, 256, "[STAGE %ld] %s", seq, g_CrashStage);
        CrashLog(msg);
    }

    static void CrashLogModuleForAddress(PVOID address) {
        HMODULE module = NULL;
        WCHAR modulePath[1024] = { 0 };

        if (GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                (LPCWSTR)address,
                &module) &&
            module &&
            GetModuleFileNameW(module, modulePath, 1024) > 0) {
            CrashLog("[CRASH] Module for exception address:");
            CrashLogW(modulePath);
        } else {
            CrashLog("[CRASH] Module for exception address: <unknown>");
        }
    }

    static LONG WINAPI HvncUnhandledExceptionFilter(EXCEPTION_POINTERS* exceptionInfo) {
        CrashLog("=== Unhandled exception observed ===");

        if (exceptionInfo && exceptionInfo->ExceptionRecord) {
            EXCEPTION_RECORD* rec = exceptionInfo->ExceptionRecord;
            char msg[512];
            sprintf_s(msg, 512,
                "[CRASH] code=0x%08lX flags=0x%08lX address=%p lastStage=%ld:%s",
                rec->ExceptionCode,
                rec->ExceptionFlags,
                rec->ExceptionAddress,
                g_CrashStageSeq,
                g_CrashStage);
            CrashLog(msg);

            if (rec->NumberParameters > 0) {
                char params[512];
                sprintf_s(params, 512,
                    "[CRASH] params count=%lu p0=0x%p p1=0x%p p2=0x%p",
                    rec->NumberParameters,
                    rec->NumberParameters > 0 ? (PVOID)rec->ExceptionInformation[0] : NULL,
                    rec->NumberParameters > 1 ? (PVOID)rec->ExceptionInformation[1] : NULL,
                    rec->NumberParameters > 2 ? (PVOID)rec->ExceptionInformation[2] : NULL);
                CrashLog(params);
            }

            CrashLogModuleForAddress(rec->ExceptionAddress);
        } else {
            CrashLog("[CRASH] exceptionInfo was NULL");
        }

        if (g_PreviousUnhandledFilter && g_PreviousUnhandledFilter != HvncUnhandledExceptionFilter) {
            return g_PreviousUnhandledFilter(exceptionInfo);
        }
        return EXCEPTION_CONTINUE_SEARCH;
    }

    // Helper function to log debug info (verbose, compile-time gated)
    void LogDebug(const WCHAR* message) {
#if ENABLE_DEBUG_LOGGING
        if (g_LogFile != INVALID_HANDLE_VALUE) {
            DWORD written;
            DWORD messageLen = (DWORD)wcslen(message) * sizeof(WCHAR);
            WriteFile(g_LogFile, message, messageLen, &written, NULL);

            const WCHAR newline[] = L"\r\n";
            WriteFile(g_LogFile, newline, sizeof(newline) - sizeof(WCHAR), &written, NULL);
            FlushFileBuffers(g_LogFile);
        }
#endif
    }

    void LogDebugA(const char* message) {
#if ENABLE_DEBUG_LOGGING
        if (g_LogFile != INVALID_HANDLE_VALUE) {
            DWORD written;
            // Convert narrow string to UTF-16LE to keep the log file a single
            // coherent encoding (UTF-16LE with BOM written at file open).
            int wlen = MultiByteToWideChar(CP_ACP, 0, message, -1, NULL, 0);
            if (wlen > 0) {
                WCHAR wbuf[512];
                int copyLen = (wlen <= 512) ? wlen : 512;
                MultiByteToWideChar(CP_ACP, 0, message, -1, wbuf, copyLen);
                wbuf[copyLen - 1] = L'\0';
                DWORD byteLen = (DWORD)(wcslen(wbuf) * sizeof(WCHAR));
                WriteFile(g_LogFile, wbuf, byteLen, &written, NULL);
            }
            const WCHAR newline[] = L"\r\n";
            WriteFile(g_LogFile, newline, (DWORD)(2 * sizeof(WCHAR)), &written, NULL);
            FlushFileBuffers(g_LogFile);
        }
#endif
    }

    // Helper function for case-insensitive wide string comparison.
    // Uses CompareStringOrdinal so Cyrillic, Greek, and other non-ASCII
    // characters are properly case-folded (fixing crashes on Russian/Chinese
    // Windows where the ASCII-only approach produced false mismatches).
    int wcsnicmp_custom(const WCHAR* s1, const WCHAR* s2, SIZE_T count) {
        if (count == 0) return 0;
        int result = CompareStringOrdinal(s1, (int)count, s2, (int)count, TRUE);
        if (result == CSTR_EQUAL) return 0;
        return (result == CSTR_LESS_THAN) ? -1 : 1;
    }

    // Helper function to normalize NT paths - skip \??\ prefix if present.
    //
    // Handled prefixes:
    //   \??\          — NT object namespace prefix for DOS device paths (e.g. \??\C:\...)
    //   \??\UNC\      — NT UNC path (e.g. \??\UNC\server\share\...) — strip only the \??\
    //                   leaving UNC\ visible so search/replace still matches correctly
    //   \??\Volume{…} — Volume GUID paths — strip only the \??\ prefix
    //   \Device\      — Raw device paths — left as-is (no stripping)
    const WCHAR* NormalizePath(const WCHAR* path, SIZE_T* adjustedLength) {
        if (!path || !adjustedLength) return path;

        SIZE_T length = *adjustedLength;

        // Check for \??\ prefix (NT object namespace for DOS devices, UNC, and GUID volumes).
        // Strip the 4-character prefix in all cases; the caller then sees the "canonical"
        // Win32-equivalent form (C:\..., UNC\server\share\..., Volume{GUID}\...).
        if (length >= 4 && path[0] == L'\\' && path[1] == L'?' && path[2] == L'?' && path[3] == L'\\') {
            *adjustedLength = length - 4;
            return path + 4;
        }

        // Check for \Device\ prefix (raw device path — e.g. \Device\HarddiskVolume3\...).
        // Do NOT strip: these are not Win32-rooted paths and the search string is
        // expected to be a Win32-style path, so the match would be spurious.
        if (length >= 8 && wcsnicmp_custom(path, L"\\Device\\", 8) == 0) {
            return path;
        }

        return path;
    }

    // NT API typedefs
    typedef struct _UNICODE_STRING {
        USHORT Length;
        USHORT MaximumLength;
        PWSTR  Buffer;
    } UNICODE_STRING, * PUNICODE_STRING;

    typedef struct _OBJECT_ATTRIBUTES {
        ULONG Length;
        HANDLE RootDirectory;
        PUNICODE_STRING ObjectName;
        ULONG Attributes;
        PVOID SecurityDescriptor;
        PVOID SecurityQualityOfService;
    } OBJECT_ATTRIBUTES, * POBJECT_ATTRIBUTES;

    typedef struct _IO_STATUS_BLOCK {
        union {
            LONG Status;
            PVOID Pointer;
        };
        ULONG_PTR Information;
    } IO_STATUS_BLOCK, * PIO_STATUS_BLOCK;

    typedef enum _FILE_INFORMATION_CLASS {
        FileDirectoryInformation = 1,
        FileFullDirectoryInformation,
        FileBothDirectoryInformation,
        FileBasicInformation,
        FileStandardInformation,
        FileInternalInformation,
        FileEaInformation,
        FileAccessInformation,
        FileNameInformation,
        FileRenameInformation = 10,
        FileLinkInformation,
        FileNamesInformation,
        FileDispositionInformation,
        FilePositionInformation,
        FileFullEaInformation,
        FileModeInformation,
        FileAlignmentInformation,
        FileAllInformation,
        FileAllocationInformation,
        FileEndOfFileInformation,
        FileAlternateNameInformation,
        FileStreamInformation,
        FilePipeInformation,
        FilePipeLocalInformation,
        FilePipeRemoteInformation,
        FileMailslotQueryInformation,
        FileMailslotSetInformation,
        FileCompressionInformation,
        FileObjectIdInformation,
        FileCompletionInformation,
        FileMoveClusterInformation,
        FileQuotaInformation,
        FileReparsePointInformation,
        FileNetworkOpenInformation,
        FileAttributeTagInformation,
        FileTrackingInformation,
        FileIdBothDirectoryInformation,
        FileIdFullDirectoryInformation,
        FileValidDataLengthInformation,
        FileShortNameInformation,
        FileIoCompletionNotificationInformation,
        FileIoStatusBlockRangeInformation,
        FileIoPriorityHintInformation,
        FileSfioReserveInformation,
        FileSfioVolumeInformation,
        FileHardLinkInformation,
        FileProcessIdsUsingFileInformation,
        FileNormalizedNameInformation,
        FileNetworkPhysicalNameInformation,
        FileIdGlobalTxDirectoryInformation,
        FileIsRemoteDeviceInformation,
        FileUnusedInformation,
        FileNumaNodeInformation,
        FileStandardLinkInformation,
        FileRemoteProtocolInformation,
        FileRenameInformationBypassAccessCheck,
        FileLinkInformationBypassAccessCheck,
        FileVolumeNameInformation,
        FileIdInformation,
        FileIdExtdDirectoryInformation,
        FileReplaceCompletionInformation,
        FileHardLinkFullIdInformation,
        FileIdExtdBothDirectoryInformation,
        FileRenameInformationEx = 65,
        FileRenameInformationExBypassAccessCheck,
        FileMaximumInformation
    } FILE_INFORMATION_CLASS, * PFILE_INFORMATION_CLASS;

    // NT API function pointers
    typedef LONG NTSTATUS;

    typedef NTSTATUS(NTAPI* pNtCreateFile)(
        PHANDLE FileHandle,
        ULONG DesiredAccess,
        POBJECT_ATTRIBUTES ObjectAttributes,
        PIO_STATUS_BLOCK IoStatusBlock,
        PLARGE_INTEGER AllocationSize,
        ULONG FileAttributes,
        ULONG ShareAccess,
        ULONG CreateDisposition,
        ULONG CreateOptions,
        PVOID EaBuffer,
        ULONG EaLength
        );

    typedef NTSTATUS(NTAPI* pNtOpenFile)(
        PHANDLE FileHandle,
        ULONG DesiredAccess,
        POBJECT_ATTRIBUTES ObjectAttributes,
        PIO_STATUS_BLOCK IoStatusBlock,
        ULONG ShareAccess,
        ULONG OpenOptions
        );

    typedef NTSTATUS(NTAPI* pNtDeleteFile)(
        POBJECT_ATTRIBUTES ObjectAttributes
        );

    typedef NTSTATUS(NTAPI* pNtSetInformationFile)(
        HANDLE FileHandle,
        PIO_STATUS_BLOCK IoStatusBlock,
        PVOID FileInformation,
        ULONG Length,
        FILE_INFORMATION_CLASS FileInformationClass
        );

    typedef NTSTATUS(NTAPI* pNtQueryAttributesFile)(
        POBJECT_ATTRIBUTES ObjectAttributes,
        PVOID FileInformation
        );

    typedef NTSTATUS(NTAPI* pNtQueryFullAttributesFile)(
        POBJECT_ATTRIBUTES ObjectAttributes,
        PVOID FileInformation
        );

    typedef NTSTATUS(NTAPI* pNtQueryDirectoryFile)(
        HANDLE FileHandle,
        HANDLE Event,
        PVOID ApcRoutine,
        PVOID ApcContext,
        PIO_STATUS_BLOCK IoStatusBlock,
        PVOID FileInformation,
        ULONG Length,
        FILE_INFORMATION_CLASS FileInformationClass,
        BOOLEAN ReturnSingleEntry,
        PUNICODE_STRING FileName,
        BOOLEAN RestartScan
        );

    typedef NTSTATUS(NTAPI* pNtQueryDirectoryFileEx)(
        HANDLE FileHandle,
        HANDLE Event,
        PVOID ApcRoutine,
        PVOID ApcContext,
        PIO_STATUS_BLOCK IoStatusBlock,
        PVOID FileInformation,
        ULONG Length,
        FILE_INFORMATION_CLASS FileInformationClass,
        ULONG QueryFlags,
        PUNICODE_STRING FileName
        );

    // Original function pointers
    pNtCreateFile OriginalNtCreateFile = NULL;
    pNtOpenFile OriginalNtOpenFile = NULL;
    pNtDeleteFile OriginalNtDeleteFile = NULL;
    pNtSetInformationFile OriginalNtSetInformationFile = NULL;
    pNtQueryAttributesFile OriginalNtQueryAttributesFile = NULL;
    pNtQueryFullAttributesFile OriginalNtQueryFullAttributesFile = NULL;
    pNtQueryDirectoryFile OriginalNtQueryDirectoryFile = NULL;
    pNtQueryDirectoryFileEx OriginalNtQueryDirectoryFileEx = NULL;

    typedef BOOL(WINAPI* pCreateProcessW)(
        LPCWSTR lpApplicationName,
        LPWSTR lpCommandLine,
        LPSECURITY_ATTRIBUTES lpProcessAttributes,
        LPSECURITY_ATTRIBUTES lpThreadAttributes,
        BOOL bInheritHandles,
        DWORD dwCreationFlags,
        LPVOID lpEnvironment,
        LPCWSTR lpCurrentDirectory,
        LPSTARTUPINFOW lpStartupInfo,
        LPPROCESS_INFORMATION lpProcessInformation
        );
    pCreateProcessW OriginalCreateProcessW = NULL;

    // In-memory DLL bytes for child injection (mapped from named section)
    static HANDLE g_DllSectionHandle = NULL;
    static LPVOID g_DllRawBytes = NULL;
    static DWORD  g_DllRawSize = 0;

    // Helper function to check if path needs redirection
    BOOL NeedsRedirection(const WCHAR* path, SIZE_T length) {
        if (!path || length == 0) return FALSE;

        SIZE_T searchLen = wcslen(g_SearchString);
        if (searchLen == 0 || length < searchLen) return FALSE;

        // Normalize the path (strip \??\ prefix if present)
        SIZE_T normalizedLength = length;
        const WCHAR* normalizedPath = NormalizePath(path, &normalizedLength);

        if (g_LogFile != INVALID_HANDLE_VALUE) {
            WCHAR tempPath[512] = { 0 };
            SIZE_T copyLen = normalizedLength < 511 ? normalizedLength : 511;
            wcsncpy_s(tempPath, 512, normalizedPath, copyLen);
            LogDebug(L"[NeedsRedirection] Checking normalized path: ");
            LogDebug(tempPath);
            LogDebug(L"[NeedsRedirection] Against search string: ");
            LogDebug(g_SearchString);
        }

        if (normalizedLength < searchLen) return FALSE;

        // Search for the search string in the normalized path (case-insensitive)
        for (SIZE_T i = 0; i <= normalizedLength - searchLen; i++) {
            if (wcsnicmp_custom(&normalizedPath[i], g_SearchString, searchLen) == 0) {
                if (g_LogFile != INVALID_HANDLE_VALUE) {
                    LogDebug(L"[NeedsRedirection] MATCH FOUND at position ");
                    WCHAR posStr[32];
                    wsprintfW(posStr, L"%Iu", i); // %Iu is the Win32 API SIZE_T format specifier; %zu is C99 CRT-only
                    LogDebug(posStr);
                }
                return TRUE;
            }
        }

        if (g_LogFile != INVALID_HANDLE_VALUE) {
            LogDebug(L"[NeedsRedirection] NO MATCH");
        }
        return FALSE;
    }

    // Helper function to replace search string with the replacement string
    WCHAR* ReplacePath(const WCHAR* originalPath, SIZE_T originalLength, SIZE_T* newLength) {
        if (!originalPath || originalLength == 0 || !newLength) return NULL;

        SIZE_T searchLen = wcslen(g_SearchString);
        SIZE_T replaceLen = wcslen(g_ReplacementString);

        if (searchLen == 0 || originalLength < searchLen) return NULL;

        // Normalize the path
        SIZE_T normalizedLength = originalLength;
        const WCHAR* normalizedPath = NormalizePath(originalPath, &normalizedLength);
        SIZE_T prefixLength = originalLength - normalizedLength; // Length of \??\ or other prefix

        if (normalizedLength < searchLen) return NULL;

        // Count occurrences (case-insensitive) in normalized portion
        SIZE_T occurrences = 0;
        for (SIZE_T i = 0; i <= normalizedLength - searchLen; i++) {
            if (wcsnicmp_custom(&normalizedPath[i], g_SearchString, searchLen) == 0) {
                occurrences++;
                i += searchLen - 1; // Skip past this occurrence
            }
        }

        if (occurrences == 0) return NULL;

        // Calculate new length (prefix + modified path).
        // Avoid SIZE_T unsigned underflow when replaceLen < searchLen by computing
        // additions and subtractions separately (all terms are non-negative).
        SIZE_T calcNewLength = prefixLength + normalizedLength
            - (occurrences * searchLen)
            + (occurrences * replaceLen);
        WCHAR* newPath = (WCHAR*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (calcNewLength + 1) * sizeof(WCHAR));
        if (!newPath) return NULL;

        // Copy prefix (\??\ or other) if present
        SIZE_T destIdx = 0;
        for (SIZE_T i = 0; i < prefixLength; i++) {
            newPath[destIdx++] = originalPath[i];
        }

        // Perform replacement in normalized portion (case-insensitive)
        SIZE_T srcIdx = 0;

        while (srcIdx < normalizedLength) {
            if (srcIdx <= normalizedLength - searchLen &&
                wcsnicmp_custom(&normalizedPath[srcIdx], g_SearchString, searchLen) == 0) {
                // Copy replacement string
                for (SIZE_T j = 0; j < replaceLen; j++) {
                    newPath[destIdx++] = g_ReplacementString[j];
                }
                srcIdx += searchLen;
            }
            else {
                newPath[destIdx++] = normalizedPath[srcIdx++];
            }
        }

        *newLength = destIdx;
        return newPath;
    }

    // Hook implementations
    NTSTATUS NTAPI HookedNtCreateFile(
        PHANDLE FileHandle,
        ULONG DesiredAccess,
        POBJECT_ATTRIBUTES ObjectAttributes,
        PIO_STATUS_BLOCK IoStatusBlock,
        PLARGE_INTEGER AllocationSize,
        ULONG FileAttributes,
        ULONG ShareAccess,
        ULONG CreateDisposition,
        ULONG CreateOptions,
        PVOID EaBuffer,
        ULONG EaLength
    ) {
        PUNICODE_STRING originalString = NULL;
        UNICODE_STRING newString = { 0 };
        WCHAR* buffer = NULL;

        if (!OriginalNtCreateFile) return 0xC0000001L; // STATUS_UNSUCCESSFUL

        __try {
            if (g_HooksInitialized && ObjectAttributes && ObjectAttributes->ObjectName && ObjectAttributes->ObjectName->Buffer) {
                SIZE_T pathLength = ObjectAttributes->ObjectName->Length / sizeof(WCHAR);

                if (g_LogFile != INVALID_HANDLE_VALUE && pathLength > 0) {
                    WCHAR tempPath[512] = { 0 };
                    SIZE_T copyLen = pathLength < 511 ? pathLength : 511;
                    wcsncpy_s(tempPath, 512, ObjectAttributes->ObjectName->Buffer, copyLen);
                    LogDebug(L"");
                    LogDebug(L"[NtCreateFile] Original Path: ");
                    LogDebug(tempPath);
                }

                if (NeedsRedirection(ObjectAttributes->ObjectName->Buffer, pathLength)) {
                    SIZE_T newLength = 0;
                    buffer = ReplacePath(ObjectAttributes->ObjectName->Buffer, pathLength, &newLength);

                    if (buffer) {
                        if (newLength > UNICODE_STRING_MAX_WCHARS) {
                            // Replacement path too long to fit in a UNICODE_STRING (USHORT
                            // byte-count would wrap).  Skip redirection and use original path.
                            CrashLog("[NtCreateFile] WARN: replacement path exceeds UNICODE_STRING max — skipping redirect");
                            HeapFree(GetProcessHeap(), 0, buffer);
                            buffer = NULL;
                        } else {
                            WCHAR tempBuf[512] = { 0 };
                            SIZE_T copyLen = newLength < 511 ? newLength : 511;
                            wcsncpy_s(tempBuf, 512, buffer, copyLen);
                            LogDebug(L"[NtCreateFile] *** REDIRECTING TO: ");
                            LogDebug(tempBuf);

                            originalString = ObjectAttributes->ObjectName;
                            newString.Buffer = buffer;
                            newString.Length = (USHORT)(newLength * sizeof(WCHAR));
                            newString.MaximumLength = (USHORT)((newLength + 1) * sizeof(WCHAR));
                            ObjectAttributes->ObjectName = &newString;
                        }
                    }
                    else {
                        LogDebug(L"[NtCreateFile] ReplacePath returned NULL");
                    }
                }
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {
            char _excMsg[64]; sprintf_s(_excMsg, 64, "[HOOK] NtCreateFile exception: 0x%X", GetExceptionCode()); CrashLog(_excMsg);
            if (originalString) { ObjectAttributes->ObjectName = originalString; originalString = NULL; }
            if (buffer) { HeapFree(GetProcessHeap(), 0, buffer); buffer = NULL; }
        }

        NTSTATUS result = OriginalNtCreateFile(FileHandle, DesiredAccess, ObjectAttributes, IoStatusBlock,
            AllocationSize, FileAttributes, ShareAccess, CreateDisposition,
            CreateOptions, EaBuffer, EaLength);

        if (originalString) {
            ObjectAttributes->ObjectName = originalString;
            if (buffer) HeapFree(GetProcessHeap(), 0, buffer);
        }

        return result;
    }

    NTSTATUS NTAPI HookedNtOpenFile(
        PHANDLE FileHandle,
        ULONG DesiredAccess,
        POBJECT_ATTRIBUTES ObjectAttributes,
        PIO_STATUS_BLOCK IoStatusBlock,
        ULONG ShareAccess,
        ULONG OpenOptions
    ) {
        if (!OriginalNtOpenFile) return 0xC0000001L; // STATUS_UNSUCCESSFUL

        PUNICODE_STRING originalString = NULL;
        UNICODE_STRING newString = { 0 };
        WCHAR* buffer = NULL;

        __try {
            if (g_HooksInitialized && ObjectAttributes && ObjectAttributes->ObjectName && ObjectAttributes->ObjectName->Buffer) {
                SIZE_T pathLength = ObjectAttributes->ObjectName->Length / sizeof(WCHAR);

                if (g_LogFile != INVALID_HANDLE_VALUE && pathLength > 0) {
                    WCHAR tempPath[512] = { 0 };
                    SIZE_T copyLen = pathLength < 511 ? pathLength : 511;
                    wcsncpy_s(tempPath, 512, ObjectAttributes->ObjectName->Buffer, copyLen);
                    LogDebug(L"");
                    LogDebug(L"[NtOpenFile] Original Path: ");
                    LogDebug(tempPath);
                }

                if (NeedsRedirection(ObjectAttributes->ObjectName->Buffer, pathLength)) {
                    SIZE_T newLength = 0;
                    buffer = ReplacePath(ObjectAttributes->ObjectName->Buffer, pathLength, &newLength);

                    if (buffer) {
                        if (newLength > UNICODE_STRING_MAX_WCHARS) {
                            CrashLog("[NtOpenFile] WARN: replacement path exceeds UNICODE_STRING max — skipping redirect");
                            HeapFree(GetProcessHeap(), 0, buffer);
                            buffer = NULL;
                        } else {
                            WCHAR tempBuf[512] = { 0 };
                            SIZE_T copyLen = newLength < 511 ? newLength : 511;
                            wcsncpy_s(tempBuf, 512, buffer, copyLen);
                            LogDebug(L"[NtOpenFile] *** REDIRECTING TO: ");
                            LogDebug(tempBuf);

                            originalString = ObjectAttributes->ObjectName;
                            newString.Buffer = buffer;
                            newString.Length = (USHORT)(newLength * sizeof(WCHAR));
                            newString.MaximumLength = (USHORT)((newLength + 1) * sizeof(WCHAR));
                            ObjectAttributes->ObjectName = &newString;
                        }
                    }
                    else {
                        LogDebug(L"[NtOpenFile] ReplacePath returned NULL");
                    }
                }
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {
            char _excMsg[64]; sprintf_s(_excMsg, 64, "[HOOK] NtOpenFile exception: 0x%X", GetExceptionCode()); CrashLog(_excMsg);
            if (originalString) { ObjectAttributes->ObjectName = originalString; originalString = NULL; }
            if (buffer) { HeapFree(GetProcessHeap(), 0, buffer); buffer = NULL; }
        }

        NTSTATUS result = OriginalNtOpenFile(FileHandle, DesiredAccess, ObjectAttributes, IoStatusBlock, ShareAccess, OpenOptions);

        if (originalString) {
            ObjectAttributes->ObjectName = originalString;
            if (buffer) HeapFree(GetProcessHeap(), 0, buffer);
        }

        return result;
    }

    NTSTATUS NTAPI HookedNtDeleteFile(POBJECT_ATTRIBUTES ObjectAttributes) {
        if (!OriginalNtDeleteFile) return 0xC0000001L; // STATUS_UNSUCCESSFUL

        PUNICODE_STRING originalString = NULL;
        UNICODE_STRING newString = { 0 };
        WCHAR* buffer = NULL;

        __try {
            if (g_HooksInitialized && ObjectAttributes && ObjectAttributes->ObjectName && ObjectAttributes->ObjectName->Buffer) {
                SIZE_T pathLength = ObjectAttributes->ObjectName->Length / sizeof(WCHAR);

                if (NeedsRedirection(ObjectAttributes->ObjectName->Buffer, pathLength)) {
                    SIZE_T newLength = 0;
                    buffer = ReplacePath(ObjectAttributes->ObjectName->Buffer, pathLength, &newLength);

                    if (buffer) {
                        if (newLength > UNICODE_STRING_MAX_WCHARS) {
                            CrashLog("[NtDeleteFile] WARN: replacement path exceeds UNICODE_STRING max — skipping redirect");
                            HeapFree(GetProcessHeap(), 0, buffer);
                            buffer = NULL;
                        } else {
                            originalString = ObjectAttributes->ObjectName;
                            newString.Buffer = buffer;
                            newString.Length = (USHORT)(newLength * sizeof(WCHAR));
                            newString.MaximumLength = (USHORT)((newLength + 1) * sizeof(WCHAR));
                            ObjectAttributes->ObjectName = &newString;
                        }
                    }
                }
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {
            char _excMsg[64]; sprintf_s(_excMsg, 64, "[HOOK] NtDeleteFile exception: 0x%X", GetExceptionCode()); CrashLog(_excMsg);
            if (originalString) { ObjectAttributes->ObjectName = originalString; originalString = NULL; }
            if (buffer) { HeapFree(GetProcessHeap(), 0, buffer); buffer = NULL; }
        }

        NTSTATUS result = OriginalNtDeleteFile(ObjectAttributes);

        if (originalString) {
            ObjectAttributes->ObjectName = originalString;
            if (buffer) HeapFree(GetProcessHeap(), 0, buffer);
        }

        return result;
    }

    NTSTATUS NTAPI HookedNtSetInformationFile(
        HANDLE FileHandle,
        PIO_STATUS_BLOCK IoStatusBlock,
        PVOID FileInformation,
        ULONG Length,
        FILE_INFORMATION_CLASS FileInformationClass
    ) {
        if (!OriginalNtSetInformationFile) return 0xC0000001L; // STATUS_UNSUCCESSFUL

        // FileRenameInformation (class 10): BOOLEAN ReplaceIfExists + HANDLE + ULONG len + WCHAR[]
        // FileRenameInformationEx (class 65): ULONG Flags (32-bit bitfield) + HANDLE + ULONG len + WCHAR[]
        // These have different first-field types; use separate structs to avoid truncating Flags.
        typedef struct {
            BOOLEAN ReplaceIfExists;
            HANDLE  RootDirectory;
            ULONG   FileNameLength;
            WCHAR   FileName[1];
        } FILE_RENAME_INFO_V1;

        typedef struct {
            ULONG  Flags;           // FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS | ...
            HANDLE RootDirectory;
            ULONG  FileNameLength;
            WCHAR  FileName[1];
        } FILE_RENAME_INFO_V2;

        WCHAR* newPath = NULL;

        __try {
            if (g_HooksInitialized && FileInformation && (FileInformationClass == FileRenameInformation || FileInformationClass == FileRenameInformationEx)) {
                // Use V1 layout to read FileNameLength (offset is the same in both structs
                // after the first field + alignment).  Only access FileName[], which starts
                // at the same relative position in both.
                FILE_RENAME_INFO_V1* renameInfoV1 = (FILE_RENAME_INFO_V1*)FileInformation;
                FILE_RENAME_INFO_V2* renameInfoV2 = (FILE_RENAME_INFO_V2*)FileInformation;

                ULONG  fileNameLength = (FileInformationClass == FileRenameInformation)
                                        ? renameInfoV1->FileNameLength
                                        : renameInfoV2->FileNameLength;
                WCHAR* fileName       = (FileInformationClass == FileRenameInformation)
                                        ? renameInfoV1->FileName
                                        : renameInfoV2->FileName;

                if (fileNameLength > 0) {
                    SIZE_T pathLength = fileNameLength / sizeof(WCHAR);

                    if (NeedsRedirection(fileName, pathLength)) {
                        SIZE_T newLength = 0;
                        newPath = ReplacePath(fileName, pathLength, &newLength);

                        if (newPath) {
                            ULONG newInfoSize;
                            LPVOID newRenameInfo = NULL;

                            if (FileInformationClass == FileRenameInformation) {
                                newInfoSize = (ULONG)(sizeof(FILE_RENAME_INFO_V1) - sizeof(WCHAR) + newLength * sizeof(WCHAR));
                                FILE_RENAME_INFO_V1* ni = (FILE_RENAME_INFO_V1*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, newInfoSize);
                                if (ni) {
                                    ni->ReplaceIfExists = renameInfoV1->ReplaceIfExists;
                                    ni->RootDirectory   = renameInfoV1->RootDirectory;
                                    ni->FileNameLength  = (ULONG)(newLength * sizeof(WCHAR));
                                    memcpy(ni->FileName, newPath, ni->FileNameLength);
                                    newRenameInfo = ni;
                                }
                            } else {
                                newInfoSize = (ULONG)(sizeof(FILE_RENAME_INFO_V2) - sizeof(WCHAR) + newLength * sizeof(WCHAR));
                                FILE_RENAME_INFO_V2* ni = (FILE_RENAME_INFO_V2*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, newInfoSize);
                                if (ni) {
                                    ni->Flags          = renameInfoV2->Flags;    // preserve all 32-bit flags
                                    ni->RootDirectory  = renameInfoV2->RootDirectory;
                                    ni->FileNameLength = (ULONG)(newLength * sizeof(WCHAR));
                                    memcpy(ni->FileName, newPath, ni->FileNameLength);
                                    newRenameInfo = ni;
                                }
                            }

                            HeapFree(GetProcessHeap(), 0, newPath);
                            newPath = NULL;

                            if (newRenameInfo) {
                                NTSTATUS result = OriginalNtSetInformationFile(FileHandle, IoStatusBlock, newRenameInfo, newInfoSize, FileInformationClass);
                                HeapFree(GetProcessHeap(), 0, newRenameInfo);
                                return result;
                            }
                        }
                    }
                }
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {
            char _excMsg[64]; sprintf_s(_excMsg, 64, "[HOOK] NtSetInfoFile exception: 0x%X", GetExceptionCode()); CrashLog(_excMsg);
            // Free newPath if an exception fires after allocation but before the HeapFree below.
            if (newPath) { HeapFree(GetProcessHeap(), 0, newPath); newPath = NULL; }
        }

        return OriginalNtSetInformationFile(FileHandle, IoStatusBlock, FileInformation, Length, FileInformationClass);
    }

    NTSTATUS NTAPI HookedNtQueryAttributesFile(
        POBJECT_ATTRIBUTES ObjectAttributes,
        PVOID FileInformation
    ) {
        if (!OriginalNtQueryAttributesFile) return 0xC0000001L; // STATUS_UNSUCCESSFUL

        PUNICODE_STRING originalString = NULL;
        UNICODE_STRING newString = { 0 };
        WCHAR* buffer = NULL;

        __try {
            if (g_HooksInitialized && ObjectAttributes && ObjectAttributes->ObjectName && ObjectAttributes->ObjectName->Buffer) {
                SIZE_T pathLength = ObjectAttributes->ObjectName->Length / sizeof(WCHAR);

                if (NeedsRedirection(ObjectAttributes->ObjectName->Buffer, pathLength)) {
                    SIZE_T newLength = 0;
                    buffer = ReplacePath(ObjectAttributes->ObjectName->Buffer, pathLength, &newLength);

                    if (buffer) {
                        if (newLength > UNICODE_STRING_MAX_WCHARS) {
                            CrashLog("[NtQueryAttribs] WARN: replacement path exceeds UNICODE_STRING max — skipping redirect");
                            HeapFree(GetProcessHeap(), 0, buffer);
                            buffer = NULL;
                        } else {
                            originalString = ObjectAttributes->ObjectName;
                            newString.Buffer = buffer;
                            newString.Length = (USHORT)(newLength * sizeof(WCHAR));
                            newString.MaximumLength = (USHORT)((newLength + 1) * sizeof(WCHAR));
                            ObjectAttributes->ObjectName = &newString;
                        }
                    }
                }
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {
            char _excMsg[64]; sprintf_s(_excMsg, 64, "[HOOK] NtQueryAttribs exception: 0x%X", GetExceptionCode()); CrashLog(_excMsg);
            if (originalString) { ObjectAttributes->ObjectName = originalString; originalString = NULL; }
            if (buffer) { HeapFree(GetProcessHeap(), 0, buffer); buffer = NULL; }
        }

        NTSTATUS result = OriginalNtQueryAttributesFile(ObjectAttributes, FileInformation);

        if (originalString) {
            ObjectAttributes->ObjectName = originalString;
            if (buffer) HeapFree(GetProcessHeap(), 0, buffer);
        }

        return result;
    }

    NTSTATUS NTAPI HookedNtQueryFullAttributesFile(
        POBJECT_ATTRIBUTES ObjectAttributes,
        PVOID FileInformation
    ) {
        if (!OriginalNtQueryFullAttributesFile) return 0xC0000001L; // STATUS_UNSUCCESSFUL

        PUNICODE_STRING originalString = NULL;
        UNICODE_STRING newString = { 0 };
        WCHAR* buffer = NULL;

        __try {
            if (g_HooksInitialized && ObjectAttributes && ObjectAttributes->ObjectName && ObjectAttributes->ObjectName->Buffer) {
                SIZE_T pathLength = ObjectAttributes->ObjectName->Length / sizeof(WCHAR);

                if (NeedsRedirection(ObjectAttributes->ObjectName->Buffer, pathLength)) {
                    SIZE_T newLength = 0;
                    buffer = ReplacePath(ObjectAttributes->ObjectName->Buffer, pathLength, &newLength);

                    if (buffer) {
                        if (newLength > UNICODE_STRING_MAX_WCHARS) {
                            CrashLog("[NtQueryFullAttribs] WARN: replacement path exceeds UNICODE_STRING max — skipping redirect");
                            HeapFree(GetProcessHeap(), 0, buffer);
                            buffer = NULL;
                        } else {
                            originalString = ObjectAttributes->ObjectName;
                            newString.Buffer = buffer;
                            newString.Length = (USHORT)(newLength * sizeof(WCHAR));
                            newString.MaximumLength = (USHORT)((newLength + 1) * sizeof(WCHAR));
                            ObjectAttributes->ObjectName = &newString;
                        }
                    }
                }
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {
            char _excMsg[64]; sprintf_s(_excMsg, 64, "[HOOK] NtQueryFullAttribs exception: 0x%X", GetExceptionCode()); CrashLog(_excMsg);
            if (originalString) { ObjectAttributes->ObjectName = originalString; originalString = NULL; }
            if (buffer) { HeapFree(GetProcessHeap(), 0, buffer); buffer = NULL; }
        }

        NTSTATUS result = OriginalNtQueryFullAttributesFile(ObjectAttributes, FileInformation);

        if (originalString) {
            ObjectAttributes->ObjectName = originalString;
            if (buffer) HeapFree(GetProcessHeap(), 0, buffer);
        }

        return result;
    }

    NTSTATUS NTAPI HookedNtQueryDirectoryFile(
        HANDLE FileHandle,
        HANDLE Event,
        PVOID ApcRoutine,
        PVOID ApcContext,
        PIO_STATUS_BLOCK IoStatusBlock,
        PVOID FileInformation,
        ULONG Length,
        FILE_INFORMATION_CLASS FileInformationClass,
        BOOLEAN ReturnSingleEntry,
        PUNICODE_STRING FileName,
        BOOLEAN RestartScan
    ) {
        if (!OriginalNtQueryDirectoryFile) return 0xC0000001L; // STATUS_UNSUCCESSFUL
        return OriginalNtQueryDirectoryFile(FileHandle, Event, ApcRoutine, ApcContext, IoStatusBlock,
            FileInformation, Length, FileInformationClass,
            ReturnSingleEntry, FileName, RestartScan);
    }

    NTSTATUS NTAPI HookedNtQueryDirectoryFileEx(
        HANDLE FileHandle,
        HANDLE Event,
        PVOID ApcRoutine,
        PVOID ApcContext,
        PIO_STATUS_BLOCK IoStatusBlock,
        PVOID FileInformation,
        ULONG Length,
        FILE_INFORMATION_CLASS FileInformationClass,
        ULONG QueryFlags,
        PUNICODE_STRING FileName
    ) {
        if (!OriginalNtQueryDirectoryFileEx) return 0xC0000001L; // STATUS_UNSUCCESSFUL
        return OriginalNtQueryDirectoryFileEx(FileHandle, Event, ApcRoutine, ApcContext, IoStatusBlock,
            FileInformation, Length, FileInformationClass,
            QueryFlags, FileName);
    }

    // Inject the DLL into a child process via reflective injection (no file on disk)
    static DWORD _rva2fo(DWORD rva, const BYTE* pe, DWORD peSize, DWORD sectionOff, WORD numSections) {
        for (WORD i = 0; i < numSections; i++) {
            DWORD off = sectionOff + (DWORD)i * 40;
            if (off + 40 > peSize) break;
            DWORD virtualAddr = *(DWORD*)(pe + off + 12);
            DWORD rawDataSize = *(DWORD*)(pe + off + 16);
            DWORD rawDataPtr  = *(DWORD*)(pe + off + 20);
            if (rva >= virtualAddr && rva < virtualAddr + rawDataSize) {
                return rva - virtualAddr + rawDataPtr;
            }
        }
        // Fallback: if the RVA falls before any section's raw data it maps 1:1.
        // Guard the read of the first section's PointerToRawData (offset +20) so a
        // malformed or truncated PE with sectionOff near the end of the buffer does
        // not produce an out-of-bounds read.
        if (numSections > 0 && sectionOff + 24 <= peSize) {
            DWORD firstRawPtr = *(DWORD*)(pe + sectionOff + 20);
            if (rva < firstRawPtr) return rva;
        }
        return 0;
    }

    static DWORD FindReflectiveLoaderFileOffset(const BYTE* pe, DWORD peSize) {
        if (peSize < 64 || pe[0] != 'M' || pe[1] != 'Z') return 0;

        DWORD lfanew = *(DWORD*)(pe + 60);
        if (lfanew + 4 > peSize) return 0;
        if (*(DWORD*)(pe + lfanew) != 0x00004550) return 0; // PE sig

        DWORD coffOff = lfanew + 4;
        if (coffOff + 20 > peSize) return 0;
        WORD numberOfSections = *(WORD*)(pe + coffOff + 2);
        WORD sizeOfOptionalHeader = *(WORD*)(pe + coffOff + 16);

        DWORD optOff = coffOff + 20;
        if (optOff + 2 > peSize) return 0;
        WORD magic = *(WORD*)(pe + optOff);

        DWORD exportDirRVA = 0;
        if (magic == 0x20b) { // PE32+
            DWORD ddOff = optOff + 112;
            if (ddOff + 8 > peSize) return 0;
            exportDirRVA = *(DWORD*)(pe + ddOff);
        } else if (magic == 0x10b) { // PE32
            DWORD ddOff = optOff + 96;
            if (ddOff + 8 > peSize) return 0;
            exportDirRVA = *(DWORD*)(pe + ddOff);
        } else {
            return 0;
        }
        if (exportDirRVA == 0) return 0;

        DWORD sectionOff = optOff + sizeOfOptionalHeader;
        // sizeOfOptionalHeader is an untrusted WORD from the PE header.  If it is
        // abnormally large, sectionOff would exceed peSize and every subsequent
        // _rva2fo call and section-table read would be out-of-bounds.
        if (sectionOff > peSize) return 0;

        // RVA to file offset helper (inline)
        #define RVA2FO(rva) _rva2fo((rva), pe, peSize, sectionOff, numberOfSections)
        DWORD exportDirFO = RVA2FO(exportDirRVA);
        if (exportDirFO == 0 || exportDirFO + 40 > peSize) return 0;

        DWORD numberOfNames         = *(DWORD*)(pe + exportDirFO + 24);
        // A legitimately built DLL will have far fewer than 65536 exports.  Cap the
        // value to prevent integer overflow in the loop index arithmetic (i * 4) when
        // the PE contains an abnormally large numberOfNames.
        if (numberOfNames > 0x10000) return 0;
        DWORD addressOfFunctionsRVA  = *(DWORD*)(pe + exportDirFO + 28);
        DWORD addressOfNamesRVA      = *(DWORD*)(pe + exportDirFO + 32);
        DWORD addressOfOrdinalsRVA   = *(DWORD*)(pe + exportDirFO + 36);

        DWORD namesFO    = RVA2FO(addressOfNamesRVA);
        DWORD funcsFO    = RVA2FO(addressOfFunctionsRVA);
        DWORD ordinalsFO = RVA2FO(addressOfOrdinalsRVA);
        if (namesFO == 0 || funcsFO == 0 || ordinalsFO == 0) return 0;

        for (DWORD i = 0; i < numberOfNames; i++) {
            if (namesFO + i * 4 + 4 > peSize) break;
            DWORD nameRVA = *(DWORD*)(pe + namesFO + i * 4);
            DWORD nameFO  = RVA2FO(nameRVA);
            if (nameFO == 0 || nameFO >= peSize) continue;

            // Check for "ReflectiveLoader" substring
            const char* name = (const char*)(pe + nameFO);
            BOOL found = FALSE;
            for (DWORD k = 0; nameFO + k < peSize && name[k] != 0; k++) {
                if (name[k] == 'R' && nameFO + k + 16 <= peSize) {
                    if (memcmp(&name[k], "ReflectiveLoader", 16) == 0) {
                        found = TRUE;
                        break;
                    }
                }
            }
            if (!found) continue;

            if (ordinalsFO + i * 2 + 2 > peSize) continue;
            WORD ordinal = *(WORD*)(pe + ordinalsFO + i * 2);
            if (funcsFO + ordinal * 4 + 4 > peSize) continue;
            DWORD funcRVA = *(DWORD*)(pe + funcsFO + ordinal * 4);
            return RVA2FO(funcRVA);
        }
        #undef RVA2FO
        return 0;
    }

    static BOOL ReflectiveInjectIntoChild(HANDLE hProcess, const BYTE* dllBytes, DWORD dllSize) {
        SetCrashStage("ChildInject: locating ReflectiveLoader");
        DWORD loaderOffset = FindReflectiveLoaderFileOffset(dllBytes, dllSize);
        if (loaderOffset == 0) {
            CrashLog("[ChildInject] FAIL: ReflectiveLoader export not found in DLL");
            LogDebug(L"[ChildInject] ReflectiveLoader export not found");
            return FALSE;
        }

        SetCrashStage("ChildInject: VirtualAllocEx");
        LPVOID remoteMem = VirtualAllocEx(hProcess, NULL, dllSize,
            MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
        if (!remoteMem) {
            CrashLog("[ChildInject] FAIL: VirtualAllocEx failed");
            LogDebug(L"[ChildInject] VirtualAllocEx failed");
            return FALSE;
        }

        SetCrashStage("ChildInject: WriteProcessMemory");
        SIZE_T written;
        if (!WriteProcessMemory(hProcess, remoteMem, dllBytes, dllSize, &written)) {
            VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
            CrashLog("[ChildInject] FAIL: WriteProcessMemory failed");
            LogDebug(L"[ChildInject] WriteProcessMemory failed");
            return FALSE;
        }
        {
            char msg[160];
            sprintf_s(msg, 160, "[ChildInject] WriteProcessMemory wrote %llu/%lu bytes", (unsigned long long)written, dllSize);
            CrashLog(msg);
        }

        LPTHREAD_START_ROUTINE remoteLoader =
            (LPTHREAD_START_ROUTINE)((BYTE*)remoteMem + loaderOffset);

        SetCrashStage("ChildInject: CreateRemoteThread");
        HANDLE hThread = CreateRemoteThread(hProcess, NULL, 1024 * 1024,
            remoteLoader, NULL, 0, NULL);
        if (!hThread) {
            CrashLog("[ChildInject] FAIL: CreateRemoteThread failed");
            LogDebug(L"[ChildInject] CreateRemoteThread failed");
            return FALSE;
        }

        SetCrashStage("ChildInject: waiting for loader thread");
        DWORD waitResult = WaitForSingleObject(hThread, 30000);
        DWORD loaderExitCode = 0;
        GetExitCodeThread(hThread, &loaderExitCode);
        {
            char msg[160];
            sprintf_s(msg, 160, "[ChildInject] loader wait=0x%lX exit=0x%lX", waitResult, loaderExitCode);
            CrashLog(msg);
        }
        CloseHandle(hThread);

        if (waitResult == WAIT_OBJECT_0) {
            SetCrashStage("ChildInject: loader thread completed");
            CrashLog("[ChildInject] OK: child injection completed");
            return TRUE;
        } else if (waitResult == WAIT_TIMEOUT) {
            // The loader thread is still running.  Returning FALSE causes
            // HookedCreateProcessW to resume the child with a comment noting that
            // hooks may not be fully installed yet (fail-open policy: we still
            // resume to avoid leaving the child process permanently suspended).
            CrashLog("[ChildInject] WARN: loader thread timed out after 30s — hooks may not be active in child");
            LogDebug(L"[ChildInject] Loader thread timeout — child will resume without guaranteed hooks");
            return FALSE;
        } else {
            // WAIT_FAILED or any unexpected value
            char msg[128];
            sprintf_s(msg, 128, "[ChildInject] FAIL: WaitForSingleObject error 0x%lX", GetLastError());
            CrashLog(msg);
            return FALSE;
        }
    }

    BOOL WINAPI HookedCreateProcessW(
        LPCWSTR lpApplicationName,
        LPWSTR lpCommandLine,
        LPSECURITY_ATTRIBUTES lpProcessAttributes,
        LPSECURITY_ATTRIBUTES lpThreadAttributes,
        BOOL bInheritHandles,
        DWORD dwCreationFlags,
        LPVOID lpEnvironment,
        LPCWSTR lpCurrentDirectory,
        LPSTARTUPINFOW lpStartupInfo,
        LPPROCESS_INFORMATION lpProcessInformation
    ) {
        if (!OriginalCreateProcessW) return FALSE;
        SetCrashStage("HookedCreateProcessW: entered");

        // Snapshot g_DllRawBytes / g_DllRawSize into locals *before* any check.
        // RemoveNtApiHooks() can race here: it calls UnmapViewOfFile(g_DllRawBytes)
        // and sets g_DllRawBytes = NULL on DLL_PROCESS_DETACH.  Without the snapshot,
        // a TOCTOU between the NULL-check below and the use inside ReflectiveInjectIntoChild
        // would pass the now-unmapped pointer to WriteProcessMemory, causing an AV.
        const BYTE* localDllBytes = (const BYTE*)g_DllRawBytes;
        DWORD       localDllSize  = g_DllRawSize;

        if (!g_HooksInitialized || !localDllBytes || localDllSize == 0) {
            SetCrashStage("HookedCreateProcessW: bypassing child injection");
            return OriginalCreateProcessW(
                lpApplicationName, lpCommandLine,
                lpProcessAttributes, lpThreadAttributes,
                bInheritHandles, dwCreationFlags,
                lpEnvironment, lpCurrentDirectory,
                lpStartupInfo, lpProcessInformation
            );
        }

        BOOL wasSuspended = (dwCreationFlags & CREATE_SUSPENDED) != 0;
        DWORD modifiedFlags = dwCreationFlags | CREATE_SUSPENDED;

        SetCrashStage("HookedCreateProcessW: calling original CreateProcessW");
        BOOL result = OriginalCreateProcessW(
            lpApplicationName, lpCommandLine,
            lpProcessAttributes, lpThreadAttributes,
            bInheritHandles, modifiedFlags,
            lpEnvironment, lpCurrentDirectory,
            lpStartupInfo, lpProcessInformation
        );

        if (result && lpProcessInformation) {
            SetCrashStage("HookedCreateProcessW: child created, injecting");
            CrashLog("[CreateProcessW] Injecting DLL into child process...");
            LogDebug(L"[CreateProcessW] Reflective-injecting DLL into child process");
            BOOL injected = ReflectiveInjectIntoChild(lpProcessInformation->hProcess,
                                localDllBytes, localDllSize);
            if (!injected) {
                CrashLog("[CreateProcessW] Child injection FAILED");
                LogDebug(L"[CreateProcessW] Child injection failed");
            } else {
                CrashLog("[CreateProcessW] Child injection OK");
                LogDebug(L"[CreateProcessW] Child injection succeeded");
            }

            // Always resume the child if we suspended it — don't leave zombie processes.
            // Even if injection failed we resume; the child runs without hooks rather than
            // hanging forever (fail-open policy).
            if (!wasSuspended) {
                SetCrashStage("HookedCreateProcessW: resuming child thread");
                ResumeThread(lpProcessInformation->hThread);
            }
        }

        SetCrashStage("HookedCreateProcessW: returning");
        return result;
    }

    // Install all hooks
    void InstallNtApiHooks(LPVOID lpParameter) {
        // Use a global try-catch to prevent any crashes
        __try {
            __try {
                WCHAR crashLogPath[1024];
                ExpandEnvironmentStringsW(L"%TEMP%\\crashlogovd.log", crashLogPath, 1024);
                g_CrashLog = CreateFileW(crashLogPath, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
                if (g_CrashLog != INVALID_HANDLE_VALUE) {
                    // Write UTF-16LE BOM so all log entries (including wide paths) are
                    // readable in any standard text editor on non-English systems.
                    DWORD written;
                    const WCHAR bom = 0xFEFF;
                    WriteFile(g_CrashLog, &bom, sizeof(WCHAR), &written, NULL);
                }
            }
            __except (EXCEPTION_EXECUTE_HANDLER) {
                g_CrashLog = INVALID_HANDLE_VALUE;
            }

            g_PreviousUnhandledFilter = SetUnhandledExceptionFilter(HvncUnhandledExceptionFilter);
            SetCrashStage("InstallNtApiHooks: crash log opened");
            CrashLog("=== Overlord HVNC DLL Loaded ===");

#if ENABLE_DEBUG_LOGGING
            // Enable verbose logging for debugging
            WCHAR logPath[1024];
            __try {
                ExpandEnvironmentStringsW(L"%TEMP%\\rdi_hooks.log", logPath, 1024);
                g_LogFile = CreateFileW(logPath, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
                if (g_LogFile != INVALID_HANDLE_VALUE) {
                    // Write UTF-16LE BOM for consistent encoding across all log entries.
                    DWORD written;
                    const WCHAR bom = 0xFEFF;
                    WriteFile(g_LogFile, &bom, sizeof(WCHAR), &written, NULL);
                }
            }
            __except (EXCEPTION_EXECUTE_HANDLER) {
                g_LogFile = INVALID_HANDLE_VALUE;
            }

            if (g_LogFile != INVALID_HANDLE_VALUE) {
                LogDebugA("=== DLL Injection Started ===");
            }
#else
            g_LogFile = INVALID_HANDLE_VALUE;
#endif

            // Initialize to empty strings to prevent crashes
            g_SearchString[0] = L'\0';
            g_ReplacementString[0] = L'\0';
            g_DllSectionHandle = NULL;
            g_DllRawBytes = NULL;
            g_DllRawSize = 0;

            // Try to get configuration from environment variables
            SetCrashStage("InstallNtApiHooks: reading environment");
            __try {
                // Use the same capacity as the global g_SearchString / g_ReplacementString
                // buffers (2048 WCHARs) so that very long paths are never silently truncated.
                // GetEnvironmentVariableW returns 0 on error; if the return value equals the
                // buffer size, the value was truncated — treat that as an error and log it.
                WCHAR envSearchString[2048] = { 0 };
                WCHAR envReplaceString[2048] = { 0 };

                DWORD searchLen = GetEnvironmentVariableW(L"RDI_SEARCH_PATH", envSearchString, 2048);
                DWORD replaceLen = GetEnvironmentVariableW(L"RDI_REPLACE_PATH", envReplaceString, 2048);
                {
                    char msg[160];
                    sprintf_s(msg, 160, "[ENV] RDI path lengths search=%lu replace=%lu", searchLen, replaceLen);
                    CrashLog(msg);
                }

                // A return value >= buffer capacity means the value was truncated.
                if (searchLen >= 2048) {
                    CrashLog("[ENV] WARN: RDI_SEARCH_PATH is >= 2048 chars and was truncated — path redirection disabled");
                    searchLen = 0;
                }
                if (replaceLen >= 2048) {
                    CrashLog("[ENV] WARN: RDI_REPLACE_PATH is >= 2048 chars and was truncated — path redirection disabled");
                    replaceLen = 0;
                }

                if (searchLen > 0 && replaceLen > 0) {
                    CrashLog("[ENV] Search/Replace paths found");
                    CrashLogW(envSearchString);
                    CrashLog(" -> ");
                    CrashLogW(envReplaceString);
                    wcsncpy_s(g_SearchString, 2048, envSearchString, searchLen);
                    g_SearchString[searchLen] = L'\0';
                    wcsncpy_s(g_ReplacementString, 2048, envReplaceString, replaceLen);
                    g_ReplacementString[replaceLen] = L'\0';

                    if (g_LogFile != INVALID_HANDLE_VALUE) {
                        LogDebug(L"========================================");
                        LogDebug(L"[ENV] Search string from env: ");
                        LogDebug(g_SearchString);
                        LogDebug(L"[ENV] Replacement string from env: ");
                        LogDebug(g_ReplacementString);

                        char lenMsg[256];
                        sprintf_s(lenMsg, 256, "[ENV] Search string length: %zu characters", wcslen(g_SearchString));
                        LogDebugA(lenMsg);
                        LogDebug(L"========================================");
                    }
                }
                else {
                    CrashLog("[ENV] RDI_SEARCH_PATH / RDI_REPLACE_PATH not found or empty — path redirection disabled");
                    if (g_LogFile != INVALID_HANDLE_VALUE) {
                        LogDebugA("Environment variables not found, hooks disabled");
                    }
                }

                // Read DLL section for child process injection (in-memory, no file on disk).
                // Section names are kernel object names — MAX_PATH (260) is more than enough,
                // but we use 512 to be safe.  DLL size is a plain decimal number, 32 is ample.
                WCHAR envSectionName[512] = { 0 };
                WCHAR envDllSize[32] = { 0 };
                DWORD sectionNameLen = GetEnvironmentVariableW(L"RDI_DLL_SECTION", envSectionName, 512);
                DWORD dllSizeLen     = GetEnvironmentVariableW(L"RDI_DLL_SIZE",    envDllSize,    32);
                {
                    char msg[160];
                    sprintf_s(msg, 160, "[ENV] RDI dll metadata lengths section=%lu size=%lu", sectionNameLen, dllSizeLen);
                    CrashLog(msg);
                }

                if (sectionNameLen >= 512) {
                    CrashLog("[ENV] WARN: RDI_DLL_SECTION is >= 512 chars and was truncated — child injection disabled");
                    sectionNameLen = 0;
                }
                if (dllSizeLen >= 32) {
                    CrashLog("[ENV] WARN: RDI_DLL_SIZE is >= 32 chars and was truncated — child injection disabled");
                    dllSizeLen = 0;
                }

                if (sectionNameLen > 0 && dllSizeLen > 0) {
                    // Validate that every character is an ASCII digit before converting.
                    // On non-English systems the string could theoretically contain locale-
                    // specific digit characters (e.g. Arabic-Indic numerals) which would
                    // cause the old subtraction-based parser to produce garbage values and
                    // later crash when MapViewOfFile mapped the wrong size.
                    BOOL allDigits = TRUE;
                    for (DWORD i = 0; i < dllSizeLen; i++) {
                        if (envDllSize[i] < L'0' || envDllSize[i] > L'9') { allDigits = FALSE; break; }
                    }
                    if (allDigits) {
                        WCHAR* endPtr = NULL;
                        g_DllRawSize = (DWORD)wcstoul(envDllSize, &endPtr, 10);
                    } else {
                        g_DllRawSize = 0;
                        CrashLog("[ENV] WARN: RDI_DLL_SIZE contains non-digit characters — child injection disabled");
                    }

                    if (g_DllRawSize == 0) {
                        CrashLog("[ENV] WARN: g_DllRawSize is 0 after parsing — skipping section open");
                        goto skip_section_open;
                    }
                    g_DllSectionHandle = OpenFileMappingW(FILE_MAP_READ, FALSE, envSectionName);
                    if (g_DllSectionHandle) {
                        SetCrashStage("InstallNtApiHooks: mapping DLL section");
                        g_DllRawBytes = MapViewOfFile(g_DllSectionHandle, FILE_MAP_READ, 0, 0, g_DllRawSize);
                        if (g_DllRawBytes) {
                            char msg[256];
                            sprintf_s(msg, 256, "[ENV] DLL shared memory mapped OK: %lu bytes", g_DllRawSize);
                            CrashLog(msg);
                            if (g_LogFile != INVALID_HANDLE_VALUE) {
                                LogDebugA(msg);
                            }
                        } else {
                            CloseHandle(g_DllSectionHandle);
                            g_DllSectionHandle = NULL;
                            g_DllRawSize = 0;
                            CrashLog("[ENV] FAIL: MapViewOfFile failed for DLL section");
                            if (g_LogFile != INVALID_HANDLE_VALUE) {
                                LogDebugA("[ENV] MapViewOfFile failed for DLL section");
                            }
                        }
                    } else {
                        g_DllRawSize = 0;
                        CrashLog("[ENV] FAIL: OpenFileMappingW failed for DLL section");
                        if (g_LogFile != INVALID_HANDLE_VALUE) {
                            LogDebugA("[ENV] OpenFileMappingW failed for DLL section");
                        }
                    }
                    skip_section_open:;
                }
            }
            __except (EXCEPTION_EXECUTE_HANDLER) {
                if (g_LogFile != INVALID_HANDLE_VALUE) {
                    LogDebugA("Exception reading environment variables");
                }
                g_SearchString[0] = L'\0';
                g_ReplacementString[0] = L'\0';
            }

            // Initialize MinHook (this must succeed)
            SetCrashStage("InstallNtApiHooks: initializing MinHook");
            if (g_LogFile != INVALID_HANDLE_VALUE) {
                LogDebugA("Initializing MinHook...");
            }

            if (MH_Initialize() != MH_OK) {
                CrashLog("FATAL: MH_Initialize() failed — MinHook could not start");
                if (g_LogFile != INVALID_HANDLE_VALUE) {
                    LogDebugA("ERROR: MinHook initialization failed!");
                }
                return;
            }
            CrashLog("[INIT] MinHook initialized OK");

            if (g_LogFile != INVALID_HANDLE_VALUE) {
                LogDebugA("MinHook initialized successfully");
            }

            SetCrashStage("InstallNtApiHooks: resolving ntdll");
            HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
            if (!ntdll) {
                CrashLog("FATAL: GetModuleHandleW(ntdll.dll) returned NULL");
                if (g_LogFile != INVALID_HANDLE_VALUE) {
                    LogDebugA("ERROR: Failed to get ntdll.dll handle!");
                }
                MH_Uninitialize();
                return;
            }

            if (g_LogFile != INVALID_HANDLE_VALUE) {
                LogDebugA("Got ntdll.dll handle");
            }

            SetCrashStage("InstallNtApiHooks: creating hooks");
            #define SAFE_HOOK(target, detour, ppOriginal, label) do { \
                MH_STATUS _cr = MH_CreateHook((LPVOID)(target), (LPVOID)(detour), (LPVOID*)(ppOriginal)); \
                if (_cr == MH_OK) { \
                    MH_STATUS _en = MH_EnableHook((LPVOID)(target)); \
                    if (_en != MH_OK) { \
                        MH_RemoveHook((LPVOID)(target)); \
                        *(ppOriginal) = NULL; \
                        CrashLog("FAIL: MH_EnableHook failed for " label); \
                        if (g_LogFile != INVALID_HANDLE_VALUE) LogDebugA("WARN: MH_EnableHook failed for " label); \
                    } else { \
                        CrashLog("[HOOK] OK: " label); \
                        if (g_LogFile != INVALID_HANDLE_VALUE) LogDebugA("Hooked " label); \
                    } \
                } else { \
                    *(ppOriginal) = NULL; \
                    CrashLog("FAIL: MH_CreateHook failed for " label); \
                    if (g_LogFile != INVALID_HANDLE_VALUE) LogDebugA("WARN: MH_CreateHook failed for " label); \
                } \
            } while(0)

            // Hook all the NT APIs
            FARPROC pNtCreateFile = GetProcAddress(ntdll, "NtCreateFile");
            if (pNtCreateFile) {
                SAFE_HOOK(pNtCreateFile, &HookedNtCreateFile, &OriginalNtCreateFile, "NtCreateFile");
            }

            FARPROC pNtOpenFile = GetProcAddress(ntdll, "NtOpenFile");
            if (pNtOpenFile) {
                SAFE_HOOK(pNtOpenFile, &HookedNtOpenFile, &OriginalNtOpenFile, "NtOpenFile");
            }

            FARPROC pNtDeleteFile = GetProcAddress(ntdll, "NtDeleteFile");
            if (pNtDeleteFile) {
                SAFE_HOOK(pNtDeleteFile, &HookedNtDeleteFile, &OriginalNtDeleteFile, "NtDeleteFile");
            }

            FARPROC pNtSetInformationFile = GetProcAddress(ntdll, "NtSetInformationFile");
            if (pNtSetInformationFile) {
                SAFE_HOOK(pNtSetInformationFile, &HookedNtSetInformationFile, &OriginalNtSetInformationFile, "NtSetInformationFile");
            }

            FARPROC pNtQueryAttributesFile = GetProcAddress(ntdll, "NtQueryAttributesFile");
            if (pNtQueryAttributesFile) {
                SAFE_HOOK(pNtQueryAttributesFile, &HookedNtQueryAttributesFile, &OriginalNtQueryAttributesFile, "NtQueryAttributesFile");
            }

            FARPROC pNtQueryFullAttributesFile = GetProcAddress(ntdll, "NtQueryFullAttributesFile");
            if (pNtQueryFullAttributesFile) {
                SAFE_HOOK(pNtQueryFullAttributesFile, &HookedNtQueryFullAttributesFile, &OriginalNtQueryFullAttributesFile, "NtQueryFullAttributesFile");
            }

            FARPROC pNtQueryDirectoryFile = GetProcAddress(ntdll, "NtQueryDirectoryFile");
            if (pNtQueryDirectoryFile) {
                SAFE_HOOK(pNtQueryDirectoryFile, &HookedNtQueryDirectoryFile, &OriginalNtQueryDirectoryFile, "NtQueryDirectoryFile");
            }

            FARPROC pNtQueryDirectoryFileEx = GetProcAddress(ntdll, "NtQueryDirectoryFileEx");
            if (pNtQueryDirectoryFileEx) {
                SAFE_HOOK(pNtQueryDirectoryFileEx, &HookedNtQueryDirectoryFileEx, &OriginalNtQueryDirectoryFileEx, "NtQueryDirectoryFileEx");
            }

            HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
            if (k32) {
                FARPROC pCreateProcessW = GetProcAddress(k32, "CreateProcessW");
                if (pCreateProcessW) {
                    SAFE_HOOK(pCreateProcessW, &HookedCreateProcessW, &OriginalCreateProcessW, "CreateProcessW");
                }
            }

            #undef SAFE_HOOK

            if (OriginalNtCreateFile && OriginalNtOpenFile) {
                SetCrashStage("InstallNtApiHooks: hooks initialized");
                g_HooksInitialized = TRUE;
                CrashLog("=== All hooks installed successfully ===");
                if (g_LogFile != INVALID_HANDLE_VALUE) {
                    LogDebugA("=== All hooks installed successfully ===");
                }
            } else {
                SetCrashStage("InstallNtApiHooks: critical hook failure cleanup");
                CrashLog("FATAL: Critical hooks (NtCreateFile/NtOpenFile) failed — tearing down all hooks");
                if (g_LogFile != INVALID_HANDLE_VALUE) {
                    LogDebugA("ERROR: Critical hooks (NtCreateFile/NtOpenFile) failed. Removing all hooks.");
                }
                MH_DisableHook(MH_ALL_HOOKS);
                MH_Uninitialize();
                OriginalNtCreateFile = NULL;
                OriginalNtOpenFile = NULL;
                OriginalNtDeleteFile = NULL;
                OriginalNtSetInformationFile = NULL;
                OriginalNtQueryAttributesFile = NULL;
                OriginalNtQueryFullAttributesFile = NULL;
                OriginalNtQueryDirectoryFile = NULL;
                OriginalNtQueryDirectoryFileEx = NULL;
                OriginalCreateProcessW = NULL;
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {
            {
                char excMsg[256];
                sprintf_s(excMsg, 256, "CRITICAL EXCEPTION during hook install! Code: 0x%X", GetExceptionCode());
                CrashLog(excMsg);
                if (g_LogFile != INVALID_HANDLE_VALUE) {
                    LogDebugA(excMsg);
                }
            }
        }
    }

    void RemoveNtApiHooks() {
        __try {
            SetCrashStage("RemoveNtApiHooks: begin");
            CrashLog("=== Removing hooks ===");
            LogDebugA("=== Removing hooks ===");
            g_HooksInitialized = FALSE;

            // Disable JMP patches in all target functions.
            SetCrashStage("RemoveNtApiHooks: disabling hooks");
            MH_DisableHook(MH_ALL_HOOKS);

            // Give any thread that passed the g_HooksInitialized guard but has not yet
            // called Original*() a brief window to finish.  This is a best-effort
            // mitigation; a proper fix requires a reader-writer barrier (e.g. SRWLOCK).
            Sleep(50);

            // Free trampoline memory.  After this point the Original* pointers are
            // dangling.  NULL them immediately so any racing thread that calls through
            // them gets a clean NULL-dereference AV (caught by the hook's __try/__except)
            // rather than a use-after-free at an arbitrary freed address.
            SetCrashStage("RemoveNtApiHooks: uninitializing MinHook");
            MH_Uninitialize();

            OriginalNtCreateFile             = NULL;
            OriginalNtOpenFile               = NULL;
            OriginalNtDeleteFile             = NULL;
            OriginalNtSetInformationFile     = NULL;
            OriginalNtQueryAttributesFile    = NULL;
            OriginalNtQueryFullAttributesFile = NULL;
            OriginalNtQueryDirectoryFile     = NULL;
            OriginalNtQueryDirectoryFileEx   = NULL;
            OriginalCreateProcessW           = NULL;

            if (g_DllRawBytes) {
                SetCrashStage("RemoveNtApiHooks: unmapping DLL section");
                UnmapViewOfFile(g_DllRawBytes);
                g_DllRawBytes = NULL;
            }
            g_DllRawSize = 0;
            if (g_DllSectionHandle) {
                SetCrashStage("RemoveNtApiHooks: closing DLL section");
                CloseHandle(g_DllSectionHandle);
                g_DllSectionHandle = NULL;
            }

            SetCrashStage("RemoveNtApiHooks: cleanup complete");
            CrashLog("=== Cleanup complete ===");

            if (g_LogFile != INVALID_HANDLE_VALUE) {
                CloseHandle(g_LogFile);
                g_LogFile = INVALID_HANDLE_VALUE;
            }
            if (g_CrashLog != INVALID_HANDLE_VALUE) {
                CloseHandle(g_CrashLog);
                g_CrashLog = INVALID_HANDLE_VALUE;
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {
            // Fail silently on cleanup
        }
    }

#ifdef __cplusplus
}
#endif
