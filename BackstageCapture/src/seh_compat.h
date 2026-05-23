// Compatibility header for building with MinGW (which lacks MSVC's __try/__except)
#ifndef _HVNC_SEH_COMPAT_H
#define _HVNC_SEH_COMPAT_H

#ifdef __MINGW32__
// MinGW doesn't support MSVC structured exception handling.
// Replace __try/__except with plain code execution (no SEH guard).
#define __try
#define __except(x) if (0)
#define __finally

// MSVC uses GetExceptionCode() inside __except; provide a stub.
#ifndef GetExceptionCode
#define GetExceptionCode() 0
#endif
#endif // __MINGW32__

#endif // _HVNC_SEH_COMPAT_H
