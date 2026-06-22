@echo off
setlocal enabledelayedexpansion

set "PLUGIN_DIR=%~dp0."
if not "%~1"=="" set "PLUGIN_DIR=%~1"

set "NATIVE_DIR=%PLUGIN_DIR%\native"
set "PLUGIN_NAME=sample-rust"
set "ZIP_OUT=%PLUGIN_DIR%\%PLUGIN_NAME%.zip"

if not exist "%NATIVE_DIR%\Cargo.toml" (
  echo [error] native\Cargo.toml not found in %NATIVE_DIR%
  exit /b 1
)

REM Build targets - default to windows-amd64 on Windows
if not defined BUILD_TARGETS set "BUILD_TARGETS=windows-amd64"

set "BUILT_FILES="
for %%T in (%BUILD_TARGETS%) do (
  for /f "tokens=1,2 delims=-" %%A in ("%%T") do (
    set "TARGET_OS=%%A"
    set "TARGET_ARCH=%%B"
  )

  if "!TARGET_OS!"=="windows" (
    set "EXT=dll"
    set "RUST_TARGET=x86_64-pc-windows-msvc"
    if "!TARGET_ARCH!"=="arm64" set "RUST_TARGET=aarch64-pc-windows-msvc"
  ) else if "!TARGET_OS!"=="darwin" (
    set "EXT=dylib"
    set "RUST_TARGET=x86_64-apple-darwin"
    if "!TARGET_ARCH!"=="arm64" set "RUST_TARGET=aarch64-apple-darwin"
  ) else (
    set "EXT=so"
    set "RUST_TARGET=x86_64-unknown-linux-gnu"
    if "!TARGET_ARCH!"=="arm64" set "RUST_TARGET=aarch64-unknown-linux-gnu"
  )

  set "OUTFILE=%PLUGIN_DIR%\%PLUGIN_NAME%-!TARGET_OS!-!TARGET_ARCH!.!EXT!"

  echo [build] cargo build --release --target=!RUST_TARGET! in %NATIVE_DIR%
  pushd "%NATIVE_DIR%"
  cargo build --release --target=!RUST_TARGET!
  if errorlevel 1 (
    echo [error] build failed for !TARGET_OS!-!TARGET_ARCH!
    popd
    exit /b 1
  )
  popd

  REM Cargo outputs to target/<triple>/release/ — find the cdylib
  if "!TARGET_OS!"=="windows" (
    copy /Y "%NATIVE_DIR%\target\!RUST_TARGET!\release\sample_rust.dll" "!OUTFILE!" >nul
  ) else if "!TARGET_OS!"=="darwin" (
    copy /Y "%NATIVE_DIR%\target\!RUST_TARGET!\release\libsample_rust.dylib" "!OUTFILE!" >nul
  ) else (
    copy /Y "%NATIVE_DIR%\target\!RUST_TARGET!\release\libsample_rust.so" "!OUTFILE!" >nul
  )
  if errorlevel 1 (
    echo [error] copy failed for !TARGET_OS!-!TARGET_ARCH!
    exit /b 1
  )
  set "BUILT_FILES=!BUILT_FILES! '!OUTFILE!'"
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
