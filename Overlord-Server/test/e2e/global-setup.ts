import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { FullConfig } from "@playwright/test";
import { ADMIN, ONBOARDING_USER, OPERATOR, VIEWER } from "./credentials";

const PORT = 5193;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function loginCookie(username: string, password: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: username, pass: password }),
  });
  if (!response.ok) {
    throw new Error(`E2E seed login failed for ${username}: ${response.status}`);
  }
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error(`E2E seed login returned no cookie for ${username}`);
  return cookie;
}

async function authenticatedRequest(
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      ...init.headers,
    },
  });
}

async function seedBrowserUsers(): Promise<void> {
  const adminCookie = await loginCookie(ADMIN.username, ADMIN.password);
  const onboardingResponse = await authenticatedRequest(
    "/api/auth/onboarding/complete",
    adminCookie,
    { method: "POST" },
  );
  if (!onboardingResponse.ok) {
    throw new Error(`Could not complete admin onboarding: ${onboardingResponse.status}`);
  }

  for (const account of [ONBOARDING_USER, OPERATOR, VIEWER]) {
    const response = await authenticatedRequest("/api/users", adminCookie, {
      method: "POST",
      body: JSON.stringify(account),
    });
    if (!response.ok) {
      throw new Error(`Could not seed ${account.username}: ${response.status}`);
    }
  }

  for (const account of [OPERATOR, VIEWER]) {
    const cookie = await loginCookie(account.username, account.password);
    const response = await authenticatedRequest(
      "/api/auth/onboarding/complete",
      cookie,
      { method: "POST" },
    );
    if (!response.ok) {
      throw new Error(`Could not complete onboarding for ${account.username}: ${response.status}`);
    }
  }
}

async function waitForServer(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`E2E server exited before startup (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(`${BASE_URL}/login.html`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error("Timed out waiting for the isolated E2E server");
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export default async function globalSetup(_config: FullConfig) {
  const projectRoot = resolve(import.meta.dirname, "../..");
  const dataDir = mkdtempSync(join(tmpdir(), "overlord-e2e-"));
  writeFileSync(join(dataDir, "config.json"), "{}\n", "utf8");

  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      OVERLORD_TEST_DATA_DIR: "1",
      HOST: "127.0.0.1",
      PORT: String(PORT),
      OVERLORD_TLS_OFFLOAD: "true",
      OVERLORD_USER: "e2e-admin",
      OVERLORD_PASS: "E2ePassword!2026",
      JWT_SECRET: "e2e-jwt-secret-that-is-only-used-for-browser-tests",
      OVERLORD_AGENT_TOKEN: "e2e-agent-token-that-is-only-used-for-browser-tests",
    },
  });

  try {
    await waitForServer(child);
    await seedBrowserUsers();
  } catch (error) {
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }

  return async () => {
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
  };
}
