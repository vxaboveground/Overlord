@echo off
setlocal enabledelayedexpansion

set "PLUGIN_DIR=%~dp0."
if not "%~1"=="" set "PLUGIN_DIR=%~1"

set "NATIVE_DIR=%PLUGIN_DIR%\native"
set "PLUGIN_NAME=sample-c"
set "ZIP_OUT=%PLUGIN_DIR%\%PLUGIN_NAME%.zip"

if not exist "%NATIVE_DIR%\plugin.c" (
  echo [error] native\plugin.c not found in %NATIVE_DIR%
  exit /b 1
)

REM Build targets - default to windows-amd64 on Windows
if not defined BUILD_TARGETS set "BUILD_TARGETS=windows-amd64"

REM Detect host architecture
set "HOST_ARCH=amd64"
if "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "HOST_ARCH=arm64"

set "BUILT_FILES="
for %%T in (%BUILD_TARGETS%) do (
  for /f "tokens=1,2 delims=-" %%A in ("%%T") do (
    set "TARGET_OS=%%A"
    set "TARGET_ARCH=%%B"
  )

  if "!TARGET_OS!"=="windows" (
    set "EXT=dll"
  ) else if "!TARGET_OS!"=="darwin" (
    set "EXT=dylib"
  ) else (
    set "EXT=so"
  )
  set "OUTFILE=%PLUGIN_DIR%\%PLUGIN_NAME%-!TARGET_OS!-!TARGET_ARCH!.!EXT!"

  if "!TARGET_OS!"=="windows" (
    REM Pick cross-compiler flags for MSVC or gcc
    set "CL_MACHINE="
    set "GCC_CMD=gcc"
    if "!TARGET_ARCH!"=="arm64" (
      set "CL_MACHINE=/machine:ARM64"
      set "GCC_CMD=aarch64-w64-mingw32-gcc"
    ) else if "!TARGET_ARCH!"=="amd64" (
      set "CL_MACHINE=/machine:X64"
      set "GCC_CMD=x86_64-w64-mingw32-gcc"
    )

    echo [build] cl /LD /O2 "%NATIVE_DIR%\plugin.c" /Fe:"!OUTFILE!" /link !CL_MACHINE!
    cl /LD /O2 "%NATIVE_DIR%\plugin.c" /Fe:"!OUTFILE!" /link !CL_MACHINE! >nul 2>&1
    if errorlevel 1 (
      echo [build] cl failed, trying !GCC_CMD!...
      !GCC_CMD! -shared -O2 -o "!OUTFILE!" "%NATIVE_DIR%\plugin.c"
      if errorlevel 1 (
        echo [error] build failed for !TARGET_OS!-!TARGET_ARCH!
        exit /b 1
      )
    )
  ) else (
    REM Cross-compile for non-Windows targets
    set "GCC_CMD=gcc"
    if "!TARGET_OS!"=="linux" (
      if "!TARGET_ARCH!"=="arm64" set "GCC_CMD=aarch64-linux-gnu-gcc"
      if "!TARGET_ARCH!"=="amd64" set "GCC_CMD=x86_64-linux-gnu-gcc"
    )
    echo [build] !GCC_CMD! -shared -fPIC -O2 -o "!OUTFILE!" "%NATIVE_DIR%\plugin.c"
    !GCC_CMD! -shared -fPIC -O2 -o "!OUTFILE!" "%NATIVE_DIR%\plugin.c"
    if errorlevel 1 (
      echo [error] build failed for !TARGET_OS!-!TARGET_ARCH!
      exit /b 1
    )
  )
  set "BUILT_FILES=!BUILT_FILES! '%PLUGIN_DIR%\%PLUGIN_NAME%-!TARGET_OS!-!TARGET_ARCH!.!EXT!'"
)

if exist "%ZIP_OUT%" del /f /q "%ZIP_OUT%"

REM Collect all build outputs and web assets
set "ZIP_SOURCES="
for %%T in (%BUILD_TARGETS%) do (
  for /f "tokens=1,2 delims=-" %%A in ("%%T") do (
    set "TARGET_OS=%%A"
    set "TARGET_ARCH=%%B"
  )
  if "!TARGET_OS!"=="windows" (
    set "ZIP_SOURCES=!ZIP_SOURCES!,'%PLUGIN_DIR%\%PLUGIN_NAME%-!TARGET_OS!-!TARGET_ARCH!.dll'"
  ) else if "!TARGET_OS!"=="darwin" (
    set "ZIP_SOURCES=!ZIP_SOURCES!,'%PLUGIN_DIR%\%PLUGIN_NAME%-!TARGET_OS!-!TARGET_ARCH!.dylib'"
  ) else (
    set "ZIP_SOURCES=!ZIP_SOURCES!,'%PLUGIN_DIR%\%PLUGIN_NAME%-!TARGET_OS!-!TARGET_ARCH!.so'"
  )
)

REM Add web assets
if exist "%PLUGIN_DIR%\%PLUGIN_NAME%.html" set "ZIP_SOURCES=!ZIP_SOURCES!,'%PLUGIN_DIR%\%PLUGIN_NAME%.html'"
if exist "%PLUGIN_DIR%\%PLUGIN_NAME%.css" set "ZIP_SOURCES=!ZIP_SOURCES!,'%PLUGIN_DIR%\%PLUGIN_NAME%.css'"
if exist "%PLUGIN_DIR%\%PLUGIN_NAME%.js" set "ZIP_SOURCES=!ZIP_SOURCES!,'%PLUGIN_DIR%\%PLUGIN_NAME%.js'"

REM Remove leading comma
set "ZIP_SOURCES=!ZIP_SOURCES:~1!"

powershell -NoProfile -Command "Compress-Archive -Path !ZIP_SOURCES! -DestinationPath '%ZIP_OUT%'"
if errorlevel 1 (
  echo [error] zip failed
  exit /b 1
)

echo [ok] %ZIP_OUT%
