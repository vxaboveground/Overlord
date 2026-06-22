# Sample WASM Plugin

This is a Plugin 2.0 sample. It declares broad file needs in `config.json`, then uses the agent WASM host imports to write to `pluginData` and list `downloads`.

On Windows, run this sample's local `build.bat`. The builder uses a WASI-capable `clang` to compile `native/sample_wasm.c`, writes `sample-wasm.wasm`, and creates `sample-wasm.zip`.

You can also build `native/sample_wasm.c` manually with a WASI-capable clang, copy the resulting `sample-wasm.wasm` into this folder, then zip the folder contents.

The server will show the declared needs before the module can be sent to an agent.
