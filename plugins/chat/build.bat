@echo off
setlocal enabledelayedexpansion

set "PLUGIN_DIR=%~dp0"
set "NATIVE_DIR=%PLUGIN_DIR%native"
set "PLUGIN_NAME=chat"
set "ZIP_OUT=%PLUGIN_DIR%%PLUGIN_NAME%.zip"

if not exist "%NATIVE_DIR%\plugin.cpp" (
  echo [error] native\plugin.cpp not found in %NATIVE_DIR%
  exit /b 1
)

REM Build targets - chat plugin is Windows-only (Win32 user32/gdi32)
if not defined BUILD_TARGETS set "BUILD_TARGETS=windows-amd64"

set "BUILT_FILES="
for %%T in (%BUILD_TARGETS%) do (
  for /f "tokens=1,2 delims=-" %%A in ("%%T") do (
    set "TARGET_OS=%%A"
    set "TARGET_ARCH=%%B"
  )

  if not "!TARGET_OS!"=="windows" (
    echo [error] chat plugin only supports windows targets, got !TARGET_OS!-!TARGET_ARCH!
    exit /b 1
  )

  set "OUTFILE=%PLUGIN_DIR%%PLUGIN_NAME%-!TARGET_OS!-!TARGET_ARCH!.dll"
  if exist "!OUTFILE!" del /f /q "!OUTFILE!"

  set "CL_MACHINE=/machine:X64"
  set "GXX_CMD=x86_64-w64-mingw32-g++"
  if "!TARGET_ARCH!"=="arm64" (
    set "CL_MACHINE=/machine:ARM64"
    set "GXX_CMD=aarch64-w64-mingw32-g++"
  )

  echo [build] cl /LD /EHsc /O2 plugin.cpp /Fe:!OUTFILE!
  pushd "%NATIVE_DIR%"
  cl /nologo /LD /EHsc /O2 plugin.cpp /Fe:"!OUTFILE!" user32.lib gdi32.lib uxtheme.lib dwmapi.lib comdlg32.lib shell32.lib /link !CL_MACHINE! >nul 2>&1
  set "CL_STATUS=!errorlevel!"
  popd
  if not "!CL_STATUS!"=="0" (
    echo [build] cl failed, trying !GXX_CMD!...
    !GXX_CMD! -shared -O2 -s -static -o "!OUTFILE!" "%NATIVE_DIR%\plugin.cpp" -luser32 -lgdi32 -luxtheme -ldwmapi -lcomdlg32 -lshell32
    if errorlevel 1 (
      echo [error] build failed for !TARGET_OS!-!TARGET_ARCH!
      exit /b 1
    )
  )

  REM Clean MSVC build artifacts
  if exist "%NATIVE_DIR%\plugin.obj" del /f /q "%NATIVE_DIR%\plugin.obj"
  if exist "%PLUGIN_DIR%%PLUGIN_NAME%-!TARGET_OS!-!TARGET_ARCH!.exp" del /f /q "%PLUGIN_DIR%%PLUGIN_NAME%-!TARGET_OS!-!TARGET_ARCH!.exp"
  if exist "%PLUGIN_DIR%%PLUGIN_NAME%-!TARGET_OS!-!TARGET_ARCH!.lib" del /f /q "%PLUGIN_DIR%%PLUGIN_NAME%-!TARGET_OS!-!TARGET_ARCH!.lib"

  echo [ok] !OUTFILE!
)

if exist "%ZIP_OUT%" del /f /q "%ZIP_OUT%"

set "ZIP_SOURCES="
for %%T in (%BUILD_TARGETS%) do (
  for /f "tokens=1,2 delims=-" %%A in ("%%T") do (
    set "TARGET_OS=%%A"
    set "TARGET_ARCH=%%B"
  )
  set "ZIP_SOURCES=!ZIP_SOURCES!,'%PLUGIN_DIR%%PLUGIN_NAME%-!TARGET_OS!-!TARGET_ARCH!.dll'"
)

if exist "%PLUGIN_DIR%%PLUGIN_NAME%.html" set "ZIP_SOURCES=!ZIP_SOURCES!,'%PLUGIN_DIR%%PLUGIN_NAME%.html'"
if exist "%PLUGIN_DIR%%PLUGIN_NAME%.css"  set "ZIP_SOURCES=!ZIP_SOURCES!,'%PLUGIN_DIR%%PLUGIN_NAME%.css'"
if exist "%PLUGIN_DIR%%PLUGIN_NAME%.js"   set "ZIP_SOURCES=!ZIP_SOURCES!,'%PLUGIN_DIR%%PLUGIN_NAME%.js'"
if exist "%PLUGIN_DIR%config.json"        set "ZIP_SOURCES=!ZIP_SOURCES!,'%PLUGIN_DIR%config.json'"
if exist "%PLUGIN_DIR%server.js"          set "ZIP_SOURCES=!ZIP_SOURCES!,'%PLUGIN_DIR%server.js'"

set "ZIP_SOURCES=!ZIP_SOURCES:~1!"

powershell -NoProfile -Command "Compress-Archive -Path !ZIP_SOURCES! -DestinationPath '%ZIP_OUT%'"
if errorlevel 1 (
  echo [error] zip creation failed
  exit /b 1
)

if defined PLUGIN_SIGN_KEY (
  where bun >nul 2>&1
  if not errorlevel 1 (
    set "SIGN_SCRIPT=%PLUGIN_DIR%..\..\Overlord-Server\scripts\plugin-sign.ts"
    if exist "!SIGN_SCRIPT!" (
      echo [sign] Signing with key: %PLUGIN_SIGN_KEY%
      bun run "!SIGN_SCRIPT!" --key "%PLUGIN_SIGN_KEY%" "%ZIP_OUT%"
    ) else (
      echo [warn] plugin-sign.ts not found, skipping signing
    )
  ) else (
    echo [warn] bun not found, skipping signing
  )
)

echo [ok] %ZIP_OUT%
