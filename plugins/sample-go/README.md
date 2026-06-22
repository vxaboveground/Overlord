# Sample Go Plugin (sample)

This sample lives in the `plugins/` directory and builds a native Go plugin.

## Files to include in the plugin zip

At the root of the zip:
- sample-linux-amd64.so / sample-darwin-arm64.dylib / sample-windows-amd64.dll
- sample.html
- sample.css
- sample.js

## Build

Use the provided build scripts:

```bash
# Linux/macOS
cd sample-go
./build.sh

# Multiple targets
BUILD_TARGETS="linux-amd64 linux-arm64 darwin-arm64" ./build.sh

# Windows
sample-go\build.bat
```

## Create the zip

The build script automatically creates `sample.zip` containing the built
binaries and web assets.

Then place `sample.zip` in `Overlord-Server/plugins`.

## Open the UI

Navigate to:
- /plugins/sample?clientId=<CLIENT_ID>

Click "Send event" and the plugin will echo back to the server logs.

## OS detection (Windows-only logic)

The plugin receives host metadata in the `init` payload. The sample plugin shows
how to detect the host OS and branch logic (see
`sample-go/native/main.go`). For example:

- If `host.os == "windows"`, you can safely run Windows-only flows (e.g., WinAPI-backed behavior).
- Otherwise, skip or provide a fallback path.
