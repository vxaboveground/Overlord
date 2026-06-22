@echo off
setlocal enabledelayedexpansion

set "PLUGIN_DIR=%~dp0"
set "PLUGIN_NAME=sample-wasm-platform-note"

set "NATIVE_DIR=%PLUGIN_DIR%\native"
set "WASM_OUT=%PLUGIN_DIR%\%PLUGIN_NAME%.wasm"
set "ZIP_OUT=%PLUGIN_DIR%\%PLUGIN_NAME%.zip"

if not exist "%PLUGIN_DIR%\config.json" (
  echo [error] config.json not found in %PLUGIN_DIR%
  exit /b 1
)

set "RUST_MANIFEST=%NATIVE_DIR%\Cargo.toml"

if exist "%RUST_MANIFEST%" (
  where cargo >nul 2>&1
  if errorlevel 1 (
    echo [error] cargo was not found. Install Rust or provide %WASM_OUT% yourself.
    exit /b 1
  )

  where rustup >nul 2>&1
  if errorlevel 1 (
    echo [error] rustup was not found. Install the Rust target manually: rustup target add wasm32-wasip1
    exit /b 1
  )

  rustup target list --installed | findstr /x "wasm32-wasip1" >nul 2>&1
  if errorlevel 1 (
    echo [setup] Installing Rust target wasm32-wasip1
    rustup target add wasm32-wasip1
    if errorlevel 1 (
      echo [error] Could not install wasm32-wasip1. Run this manually: rustup target add wasm32-wasip1
      exit /b 1
    )
  )

  echo [build] cargo build --manifest-path "%RUST_MANIFEST%" --release --target wasm32-wasip1
  cargo build --manifest-path "%RUST_MANIFEST%" --release --target wasm32-wasip1
  if errorlevel 1 (
    echo [error] WASM build failed
    exit /b 1
  )
  copy /Y "%NATIVE_DIR%\target\wasm32-wasip1\release\sample_wasm_platform_note.wasm" "%WASM_OUT%" >nul
  if errorlevel 1 (
    echo [error] could not copy built WASM to %WASM_OUT%
    exit /b 1
  )
)

if exist "%ZIP_OUT%" del /f /q "%ZIP_OUT%"

pushd "%PLUGIN_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$zip = '%ZIP_OUT%'; $items = @(); foreach ($file in @('config.json', '%PLUGIN_NAME%.html', '%PLUGIN_NAME%.css', '%PLUGIN_NAME%.js', '%PLUGIN_NAME%.wasm', 'server.js')) { if (Test-Path -LiteralPath $file -PathType Leaf) { $items += $file } }; foreach ($dir in @('src', 'assets')) { if (Test-Path -LiteralPath $dir -PathType Container) { $items += $dir } }; if ($items.Count -eq 0) { throw 'No plugin files found to package' }; Compress-Archive -Path $items -DestinationPath $zip -Force"
set "ZIP_STATUS=%ERRORLEVEL%"
popd
if not "%ZIP_STATUS%"=="0" exit /b %ZIP_STATUS%
if errorlevel 1 (
  echo [error] zip failed
  exit /b 1
)

if defined PLUGIN_SIGN_KEY (
  where bun >nul 2>&1
  if not errorlevel 1 (
    echo [sign] Signing plugin with key: %PLUGIN_SIGN_KEY%
    bun run "%~dp0..\..\Overlord-Server\scripts\plugin-sign.ts" --key "%PLUGIN_SIGN_KEY%" "%ZIP_OUT%"
  ) else (
    echo [warn] bun not found, skipping plugin signing
  )
)

echo [ok] %ZIP_OUT%
