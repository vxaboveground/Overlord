# Sample TS Fullstack Plugin

This sample intentionally ships TypeScript source instead of generated JavaScript.

The server extracts the bundle, compiles `src/ui.ts` to `assets/sample-ts-fullstack.js`, and compiles `src/server.ts` to `server.js`. Both entrypoints import `src/shared.ts`, demonstrating that plugin authors can split logic across multiple TypeScript files.

No package install is performed during plugin extraction; use relative imports or APIs already available in the browser/server runtime.

On Windows, run this sample's local `build.bat` to create `sample-ts-fullstack.zip`. The batch file packages the TypeScript sources cleanly; compilation still happens on the server during extraction.
