import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { extractTokenFromCookie, extractTokenFromHeader, generateToken } from "./auth";
import { getConfig, updateAppearanceConfig, type Config } from "./config";
import { generateTotpCode } from "./mfa";
import * as fs from "fs/promises";
import path from "path";
import {
  createUser,
  deleteUser,
  enableUserMfa,
  getUserById,
  setUserMfaSecret,
} from "./users";
import { handleAuthRoutes } from "./server/routes/auth-routes";
import { handleMiscRoutes } from "./server/routes/misc-routes";

const PASSWORD = "Aa1!AuthMfaTest_2026";
const mockServer = {
  requestIP: () => ({ address: "127.0.0.1" }),
};
let originalAppearance: Config["appearance"];
const uploadPublicRoot = path.resolve(".test-data", "branding-upload-public");

beforeAll(() => {
  originalAppearance = JSON.parse(JSON.stringify(getConfig().appearance));
});

afterAll(async () => {
  if (originalAppearance) {
    await updateAppearanceConfig(originalAppearance.customCSS, originalAppearance.loginBranding);
  }
  await fs.rm(uploadPublicRoot, { recursive: true, force: true });
});

describe("auth token extraction", () => {
  test("extractTokenFromHeader returns bearer token", () => {
    expect(extractTokenFromHeader("Bearer abc123")).toBe("abc123");
    expect(extractTokenFromHeader("Basic abc123")).toBeNull();
  });

  test("extractTokenFromCookie finds overlord_token", () => {
    const cookie = "other=1; overlord_token=token123; theme=dark";
    expect(extractTokenFromCookie(cookie)).toBe("token123");
  });

  test("extractTokenFromCookie returns null when missing", () => {
    expect(extractTokenFromCookie("foo=bar")).toBeNull();
  });
});

describe("login branding", () => {
  test("returns default public login branding", async () => {
    const url = new URL("https://localhost/api/login/branding");
    const res = await handleAuthRoutes(new Request(url), url, mockServer);
    expect(res?.status).toBe(200);

    const body = (await res!.json()) as any;
    expect(body.productName).toBe("Overlord");
    expect(body.navName).toBe("Overlord");
    expect(body.title).toBe("Welcome back");
    expect(body.logoUrl).toBe("");
    expect(body.navLogoUrl).toBe("");
    expect(body.heroImageUrl).toBe("");
    expect(body.accentColor).toBe("#7a5bff");
  });

  test("returns sanitized enterprise branding fields", async () => {
    await updateAppearanceConfig("", {
      productName: "Acme SOC",
      navName: "Acme Console",
      title: "Welcome to Acme",
      subtitle: "Use your Acme identity",
      iconClass: "fa-solid fa-shield-halved<script>",
      logoUrl: "javascript:alert(1)",
      navLogoUrl: "/assets/acme-nav.png",
      heroImageUrl: "https://cdn.example.test/login.jpg",
      accentColor: "#14B8A6",
      footerText: "Authorized access only",
      supportText: "Need help?",
      supportUrl: "https://help.example.test",
    });

    const url = new URL("https://localhost/api/login/branding");
    const res = await handleAuthRoutes(new Request(url), url, mockServer);
    expect(res?.status).toBe(200);

    const body = (await res!.json()) as any;
    expect(body.productName).toBe("Acme SOC");
    expect(body.navName).toBe("Acme Console");
    expect(body.iconClass).toBe("fa-solid fa-shield-halvedscript");
    expect(body.logoUrl).toBe("");
    expect(body.navLogoUrl).toBe("/assets/acme-nav.png");
    expect(body.heroImageUrl).toBe("https://cdn.example.test/login.jpg");
    expect(body.accentColor).toBe("#14b8a6");
    expect(body.footerText).toBe("Authorized access only");
    expect(body.supportUrl).toBe("https://help.example.test/");
  });
});

describe("branding uploads", () => {
  test("accepts admin image upload and returns a branding asset URL", async () => {
    const username = `branding_upload_${Date.now().toString(36)}`;
    const created = await createUser(username, PASSWORD, "admin", "test");
    expect(created.success).toBe(true);

    try {
      await fs.mkdir(uploadPublicRoot, { recursive: true });
      const user = getUserById(created.userId!);
      expect(user).toBeTruthy();
      const token = await generateToken(user!);
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d,
      ]);
      const form = new FormData();
      form.append("kind", "nav-logo");
      form.append("file", new File([pngBytes], "logo.png", { type: "image/png" }));

      const url = new URL("https://localhost/api/settings/appearance/image");
      const res = await handleMiscRoutes(
        new Request(url, {
          method: "POST",
          headers: { Cookie: `overlord_token=${token}` },
          body: form,
        }),
        url,
        {
          CORS_HEADERS: {},
          SERVER_VERSION: "test",
          PUBLIC_ROOT: uploadPublicRoot,
          requestIP: () => ({ address: "127.0.0.1" }),
          getConsoleSessionCount: () => 0,
          getRdSessionCount: () => 0,
          getFileBrowserSessionCount: () => 0,
          getProcessSessionCount: () => 0,
        },
      );

      expect(res?.status).toBe(200);
      const body = (await res!.json()) as any;
      expect(body.url).toMatch(/^\/assets\/branding\/nav-logo-[a-z0-9]+-[0-9a-f-]+\.png$/);
      expect(await Bun.file(path.join(uploadPublicRoot, body.url.replace("/assets/", "assets/"))).exists()).toBe(true);
    } finally {
      deleteUser(created.userId!);
    }
  });
});

describe("auth MFA login", () => {
  test("MFA-enabled user gets a challenge and can login with TOTP", async () => {
    const username = `mfa_user_${Date.now().toString(36)}`;
    const created = await createUser(username, PASSWORD, "operator", "test");
    expect(created.success).toBe(true);

    try {
      const secret = "JBSWY3DPEHPK3PXP";
      expect(setUserMfaSecret(created.userId!, secret).success).toBe(true);
      expect(enableUserMfa(created.userId!).success).toBe(true);

      const url = new URL("https://localhost/api/login");
      const challenge = await handleAuthRoutes(
        new Request(url, {
          method: "POST",
          body: JSON.stringify({ user: username, pass: PASSWORD }),
        }),
        url,
        mockServer,
      );
      expect(challenge?.status).toBe(202);
      expect((await challenge!.json()).mfaRequired).toBe(true);

      const login = await handleAuthRoutes(
        new Request(url, {
          method: "POST",
          body: JSON.stringify({
            user: username,
            pass: PASSWORD,
            mfaCode: generateTotpCode(secret),
          }),
        }),
        url,
        mockServer,
      );
      expect(login?.status).toBe(200);
      const body = (await login!.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.token).toBeTruthy();
      expect(getUserById(created.userId!)).not.toBeNull();
    } finally {
      deleteUser(created.userId!);
    }
  });
});
