@echo off
setlocal EnableDelayedExpansion
REM Build HVNCCapture DLL for Windows x64 using MSBuild (vcxproj).
REM Run from VS Developer Command Prompt, or let the script detect VS.

set ROOT=%~dp0
set PROJ=%ROOT%HVNCCapture\HVNCCapture.vcxproj
set OUT_DIR=%ROOT%Overlord-Server\dist-clients
set CONFIG=Release
set PLATFORM=x64

REM Locate MSBuild via vswhere if not already on PATH
where msbuild.exe >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo msbuild.exe not found, searching for Visual Studio ...
    set "FOUND_VS="
    for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.Component.MSBuild -find MSBuild\**\Bin\MSBuild.exe 2^>nul`) do (
        set "MSBUILD_PATH=%%i"
        set "FOUND_VS=1"
    )
    if not defined FOUND_VS (
        echo ERROR: Visual Studio with MSBuild not found.
        exit /b 1
    )
    echo Found MSBuild at: !MSBUILD_PATH!
)

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

echo Building HVNCCapture.vcxproj [%CONFIG%^|%PLATFORM%] ...
if defined MSBUILD_PATH (
    "!MSBUILD_PATH!" "%PROJ%" /p:Configuration=%CONFIG% /p:Platform=%PLATFORM% /p:OutDir="%OUT_DIR%\\" /m /nologo /v:minimal
) else (
    msbuild.exe "%PROJ%" /p:Configuration=%CONFIG% /p:Platform=%PLATFORM% /p:OutDir="%OUT_DIR%\\" /m /nologo /v:minimal
)
if %ERRORLEVEL% neq 0 goto :error

if not exist "%OUT_DIR%\HVNCCapture.x64.dll" (
    echo ERROR: DLL not found in output directory.
    goto :error
)

echo.
echo Built: %OUT_DIR%\HVNCCapture.x64.dll
dir "%OUT_DIR%\HVNCCapture.x64.dll"

echo Done.
exit /b 0

:error
echo.
echo BUILD FAILED
exit /b 1
