@echo off
echo === Building Overlord Desktop (Tauri) ===
cd /d "%~dp0Overlord-Desktop"

where bun >nul 2>&1
if errorlevel 1 (
  echo error: bun is required ^(https://bun.sh^)
  exit /b 1
)
where cargo >nul 2>&1
if errorlevel 1 (
  echo error: rust toolchain is required ^(https://rustup.rs^)
  exit /b 1
)

call bun install || exit /b 1
call bun run vendor || exit /b 1
call bun run build:win || exit /b 1
echo === Done — bundle output: Overlord-Desktop\src-tauri\target\release\bundle\ ===
pause
