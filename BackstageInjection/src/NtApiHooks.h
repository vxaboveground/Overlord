//===============================================================================================//
// NT API Hooking Header
//===============================================================================================//
#ifndef _NTAPIHOOKS_H
#define _NTAPIHOOKS_H

#include <windows.h>

#ifdef __cplusplus
extern "C" {
#endif

	// Initialize all NT API hooks
	void InstallNtApiHooks(LPVOID lpParameter);

	// Remove all NT API hooks
	void RemoveNtApiHooks();

#ifdef __cplusplus
}
#endif

#endif // _NTAPIHOOKS_H
