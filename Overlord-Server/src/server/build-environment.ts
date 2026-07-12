// Agent builds must not inherit the server's environment. Bun may populate
// process.env from local .env files, and blindly forwarding it can expose
// secrets or make otherwise identical UI builds depend on the host machine.
// Keep only the small OS baseline required to locate and execute toolchains;
// target-specific Go/compiler variables are added explicitly by the builder.
const BUILD_ENV_BASELINE_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
] as const;

export function createIsolatedBuildEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {};
  for (const key of BUILD_ENV_BASELINE_KEYS) {
    const value = source[key];
    if (value !== undefined) isolated[key] = value;
  }
  return isolated;
}
