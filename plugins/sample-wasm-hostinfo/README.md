# Sample WASM HostInfo Plugin

This Plugin 2.0 sample is written in Go for TinyGo. It demonstrates how a universal WASM module can read HostInfo and emit it back to the UI.

On Windows, install TinyGo 0.41.0 or newer, then run this sample's local `build.bat`. TinyGo 0.41.0 added Go 1.26 support. The builder runs `tinygo build -target=wasi`, writes `sample-wasm-hostinfo.wasm`, and creates `sample-wasm-hostinfo.zip`.
