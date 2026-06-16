//===============================================================================================//
// NT API Hooking Implementation
//===============================================================================================//
#ifdef __cplusplus
extern "C" {
#endif

#include "NtApiHooks.h"
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

        if (normalizedLength < searchLen) return FALSE;

        // Search for the search string in the normalized path (case-insensitive)
        for (SIZE_T i = 0; i <= normalizedLength - searchLen; i++) {
            if (wcsnicmp_custom(&normalizedPath[i], g_SearchString, searchLen) == 0) {
                return TRUE;
            }
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

                if (NeedsRedirection(ObjectAttributes->ObjectName->Buffer, pathLength)) {
                    SIZE_T newLength = 0;
                    buffer = ReplacePath(ObjectAttributes->ObjectName->Buffer, pathLength, &newLength);

                    if (buffer) {
                        if (newLength > UNICODE_STRING_MAX_WCHARS) {
                            // Replacement path too long to fit in a UNICODE_STRING (USHORT
                            // byte-count would wrap).  Skip redirection and use original path.
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

                if (NeedsRedirection(ObjectAttributes->ObjectName->Buffer, pathLength)) {
                    SIZE_T newLength = 0;
                    buffer = ReplacePath(ObjectAttributes->ObjectName->Buffer, pathLength, &newLength);

                    if (buffer) {
                        if (newLength > UNICODE_STRING_MAX_WCHARS) {
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
        DWORD loaderOffset = FindReflectiveLoaderFileOffset(dllBytes, dllSize);
        if (loaderOffset == 0) {
            return FALSE;
        }

        LPVOID remoteMem = VirtualAllocEx(hProcess, NULL, dllSize,
            MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
        if (!remoteMem) {
            return FALSE;
        }

        SIZE_T written;
        if (!WriteProcessMemory(hProcess, remoteMem, dllBytes, dllSize, &written)) {
            VirtualFreeEx(hProcess, remoteMem, 0, MEM_RELEASE);
            return FALSE;
        }

        LPTHREAD_START_ROUTINE remoteLoader =
            (LPTHREAD_START_ROUTINE)((BYTE*)remoteMem + loaderOffset);

        HANDLE hThread = CreateRemoteThread(hProcess, NULL, 1024 * 1024,
            remoteLoader, NULL, 0, NULL);
        if (!hThread) {
            return FALSE;
        }

        DWORD waitResult = WaitForSingleObject(hThread, 30000);
        CloseHandle(hThread);

        if (waitResult == WAIT_OBJECT_0) {
            return TRUE;
        } else if (waitResult == WAIT_TIMEOUT) {
            // The loader thread is still running.  Returning FALSE causes
            // HookedCreateProcessW to resume the child with a comment noting that
            // hooks may not be fully installed yet (fail-open policy: we still
            // resume to avoid leaving the child process permanently suspended).
            return FALSE;
        } else {
            // WAIT_FAILED or any unexpected value
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

        // Snapshot g_DllRawBytes / g_DllRawSize into locals *before* any check.
        // RemoveNtApiHooks() can race here: it calls UnmapViewOfFile(g_DllRawBytes)
        // and sets g_DllRawBytes = NULL on DLL_PROCESS_DETACH.  Without the snapshot,
        // a TOCTOU between the NULL-check below and the use inside ReflectiveInjectIntoChild
        // would pass the now-unmapped pointer to WriteProcessMemory, causing an AV.
        const BYTE* localDllBytes = (const BYTE*)g_DllRawBytes;
        DWORD       localDllSize  = g_DllRawSize;

        if (!g_HooksInitialized || !localDllBytes || localDllSize == 0) {
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
            ReflectiveInjectIntoChild(lpProcessInformation->hProcess, localDllBytes, localDllSize);

            // Always resume the child if we suspended it — don't leave zombie processes.
            // Even if injection failed we resume; the child runs without hooks rather than
            // hanging forever (fail-open policy).
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
            // Initialize to empty strings to prevent crashes
            g_SearchString[0] = L'\0';
            g_ReplacementString[0] = L'\0';
            g_DllSectionHandle = NULL;
            g_DllRawBytes = NULL;
            g_DllRawSize = 0;

            // Try to get configuration from environment variables
            __try {
                // Use the same capacity as the global g_SearchString / g_ReplacementString
                // buffers (2048 WCHARs) so that very long paths are never silently truncated.
                // GetEnvironmentVariableW returns 0 on error; if the return value equals the
                // buffer size, the value was truncated — treat that as an error and log it.
                WCHAR envSearchString[2048] = { 0 };
                WCHAR envReplaceString[2048] = { 0 };

                DWORD searchLen = GetEnvironmentVariableW(L"RDI_SEARCH_PATH", envSearchString, 2048);
                DWORD replaceLen = GetEnvironmentVariableW(L"RDI_REPLACE_PATH", envReplaceString, 2048);

                // A return value >= buffer capacity means the value was truncated.
                if (searchLen >= 2048) {
                    searchLen = 0;
                }
                if (replaceLen >= 2048) {
                    replaceLen = 0;
                }

                if (searchLen > 0 && replaceLen > 0) {
                    wcsncpy_s(g_SearchString, 2048, envSearchString, searchLen);
                    g_SearchString[searchLen] = L'\0';
                    wcsncpy_s(g_ReplacementString, 2048, envReplaceString, replaceLen);
                    g_ReplacementString[replaceLen] = L'\0';
                }

                // Read DLL section for child process injection (in-memory, no file on disk).
                // Section names are kernel object names — MAX_PATH (260) is more than enough,
                // but we use 512 to be safe.  DLL size is a plain decimal number, 32 is ample.
                WCHAR envSectionName[512] = { 0 };
                WCHAR envDllSize[32] = { 0 };
                DWORD sectionNameLen = GetEnvironmentVariableW(L"RDI_DLL_SECTION", envSectionName, 512);
                DWORD dllSizeLen     = GetEnvironmentVariableW(L"RDI_DLL_SIZE",    envDllSize,    32);

                if (sectionNameLen >= 512) {
                    sectionNameLen = 0;
                }
                if (dllSizeLen >= 32) {
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
                    }

                    if (g_DllRawSize == 0) {
                        goto skip_section_open;
                    }
                    g_DllSectionHandle = OpenFileMappingW(FILE_MAP_READ, FALSE, envSectionName);
                    if (g_DllSectionHandle) {
                        g_DllRawBytes = MapViewOfFile(g_DllSectionHandle, FILE_MAP_READ, 0, 0, g_DllRawSize);
                        if (!g_DllRawBytes) {
                            CloseHandle(g_DllSectionHandle);
                            g_DllSectionHandle = NULL;
                            g_DllRawSize = 0;
                        }
                    } else {
                        g_DllRawSize = 0;
                    }
                    skip_section_open:;
                }
            }
            __except (EXCEPTION_EXECUTE_HANDLER) {
                g_SearchString[0] = L'\0';
                g_ReplacementString[0] = L'\0';
            }

            // Initialize MinHook (this must succeed)
            if (MH_Initialize() != MH_OK) {
                return;
            }

            HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
            if (!ntdll) {
                MH_Uninitialize();
                return;
            }

            #define SAFE_HOOK(target, detour, ppOriginal, label) do { \
                MH_STATUS _cr = MH_CreateHook((LPVOID)(target), (LPVOID)(detour), (LPVOID*)(ppOriginal)); \
                if (_cr == MH_OK) { \
                    MH_STATUS _en = MH_EnableHook((LPVOID)(target)); \
                    if (_en != MH_OK) { \
                        MH_RemoveHook((LPVOID)(target)); \
                        *(ppOriginal) = NULL; \
                    } \
                } else { \
                    *(ppOriginal) = NULL; \
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
            } else {
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
            // Fail silently on hook installation.
        }
    }

    void RemoveNtApiHooks() {
        __try {
            g_HooksInitialized = FALSE;

            // Disable JMP patches in all target functions.
            MH_DisableHook(MH_ALL_HOOKS);

            // Give any thread that passed the g_HooksInitialized guard but has not yet
            // called Original*() a brief window to finish.  This is a best-effort
            // mitigation; a proper fix requires a reader-writer barrier (e.g. SRWLOCK).
            Sleep(50);

            // Free trampoline memory.  After this point the Original* pointers are
            // dangling.  NULL them immediately so any racing thread that calls through
            // them gets a clean NULL-dereference AV (caught by the hook's __try/__except)
            // rather than a use-after-free at an arbitrary freed address.
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
                UnmapViewOfFile(g_DllRawBytes);
                g_DllRawBytes = NULL;
            }
            g_DllRawSize = 0;
            if (g_DllSectionHandle) {
                CloseHandle(g_DllSectionHandle);
                g_DllSectionHandle = NULL;
            }
        }
        __except (EXCEPTION_EXECUTE_HANDLER) {
            // Fail silently on cleanup
        }
    }

#ifdef __cplusplus
}
#endif
