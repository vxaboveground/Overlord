@echo off
setlocal enabledelayedexpansion

set "PLUGIN_DIR=%~dp0"
set "PLUGIN_NAME=sample-ts-fullstack"

set "NATIVE_DIR=%PLUGIN_DIR%\native"
set "WASM_OUT=%PLUGIN_DIR%\%PLUGIN_NAME%.wasm"
set "ZIP_OUT=%PLUGIN_DIR%\%PLUGIN_NAME%.zip"

if not exist "%PLUGIN_DIR%\config.json" (
  echo [error] config.json not found in %PLUGIN_DIR%
  exit /b 1
)

set "WASM_SOURCE="
if exist "%NATIVE_DIR%" (
  for %%S in ("%NATIVE_DIR%\*.c") do (
    if not defined WASM_SOURCE set "WASM_SOURCE=%%~fS"
  )
)

if defined WASM_SOURCE (
  where clang >nul 2>&1
  if errorlevel 1 (
    echo [error] clang was not found. Install a WASI-capable clang or provide %WASM_OUT% yourself.
    exit /b 1
  )

  echo [build] clang --target=wasm32-wasi -O2 "!WASM_SOURCE!" ^> "%WASM_OUT%"
  clang --target=wasm32-wasi -O2 -Wl,--no-entry -Wl,--allow-undefined -Wl,--export=overlord_alloc -Wl,--export=overlord_free -Wl,--export=overlord_on_load -Wl,--export=overlord_on_event -Wl,--export=overlord_on_unload -o "%WASM_OUT%" "!WASM_SOURCE!"
  if errorlevel 1 (
    echo [error] WASM build failed
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
