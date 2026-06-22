# Sample WASM Platform Note Plugin

This Plugin 2.0 sample is written in Rust. It reads HostInfo, branches on `os` and `arch`, and writes a small note into the approved `pluginData` bucket.

On Windows, install the Rust WASI target first:

```bat
rustup target add wasm32-wasip1
```

Then run this sample's local `build.bat`. The builder runs Cargo, writes `sample-wasm-platform-note.wasm`, and creates `sample-wasm-platform-note.zip`.
