@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT_DIR=%%~fI"
set "DEST_DIR=%ROOT_DIR%\Overlord-Client\third_party\nvcodec"
set "DEST_HEADER=%DEST_DIR%\nvEncodeAPI.h"
if "%NV_CODEC_HEADERS_REPO%"=="" set "NV_CODEC_HEADERS_REPO=https://github.com/FFmpeg/nv-codec-headers.git"
if "%NV_CODEC_HEADERS_REF%"=="" set "NV_CODEC_HEADERS_REF=master"

set "FORCE=%FORCE_NV_CODEC_HEADERS%"
if /I "%~1"=="--force" set "FORCE=1"

if exist "%DEST_HEADER%" if not "%FORCE%"=="1" (
    echo nvEncodeAPI.h already exists: "%DEST_HEADER%"
    echo Use --force or set FORCE_NV_CODEC_HEADERS=1 to refresh it.
    exit /b 0
)

where git >nul 2>&1
if errorlevel 1 (
    echo git is required to vendor nv-codec-headers
    exit /b 1
)

set "TMP_DIR=%DEST_DIR%\.nv-codec-headers.tmp"
if exist "%TMP_DIR%" rd /s /q "%TMP_DIR%"
if not exist "%DEST_DIR%" mkdir "%DEST_DIR%"

echo Cloning %NV_CODEC_HEADERS_REPO% (%NV_CODEC_HEADERS_REF%)...
git clone --depth 1 --branch "%NV_CODEC_HEADERS_REF%" "%NV_CODEC_HEADERS_REPO%" "%TMP_DIR%"
if errorlevel 1 goto :err

set "SRC_HEADER=%TMP_DIR%\include\ffnvcodec\nvEncodeAPI.h"
if not exist "%SRC_HEADER%" (
    echo Expected header not found: "%SRC_HEADER%"
    goto :err
)

copy /y "%SRC_HEADER%" "%DEST_HEADER%" >nul
if errorlevel 1 goto :err
rd /s /q "%TMP_DIR%"

echo Vendored "%DEST_HEADER%"
exit /b 0

:err
if exist "%TMP_DIR%" rd /s /q "%TMP_DIR%"
echo Failed to vendor nv-codec-headers
exit /b 1
