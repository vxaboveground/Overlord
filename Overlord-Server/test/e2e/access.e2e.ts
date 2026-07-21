import { expect, test } from "@playwright/test";
import { OPERATOR, VIEWER } from "./credentials";
import { collectBrowserIssues, login } from "./helpers";

test.describe("authentication and authorization", () => {
  test("rejects invalid credentials without creating a session", async ({ page }) => {
    await page.goto("/login.html");
    await page.locator("#user").fill("not-a-real-user");
    await page.locator("#pass").fill("not-the-password");
    await page.locator("#login-form button[type='submit']").click();

    await expect(page.locator("#error")).toContainText("Invalid credentials");
    await expect(page).toHaveURL(/\/login\.html$/);
    const me = await page.request.get("/api/auth/me");
    expect(me.status()).toBe(401);
  });

  test("serves login instead of protected content when unauthenticated", async ({ page }) => {
    const response = await page.goto("/settings");
    expect(response?.status()).toBe(200);
    await expect(page.locator("#login-form")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Settings" })).toHaveCount(0);
  });

  test("logout revokes the browser session", async ({ page }) => {
    await login(page);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#user-actions-btn").click();
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/"),
      page.locator("#logout-btn").click(),
    ]);
    await expect(page.locator("#login-form")).toBeVisible();

    const me = await page.request.get("/api/auth/me");
    expect(me.status()).toBe(401);
    await page.goto("/users");
    await expect(page.locator("#login-form")).toBeVisible();
  });

  test("viewer navigation and direct routes enforce read-only access", async ({ page }) => {
    await login(page, VIEWER);
    await expect(page.locator("#role-badge")).toContainText("Viewer");

    for (const id of [
      "users-link",
      "build-link",
      "plugins-link",
      "scripts-link",
      "file-share-link",
      "notifications-link",
      "enrollment-link",
    ]) {
      await expect(page.locator(`#${id}`)).toBeHidden();
    }

    const denied = await page.goto("/users");
    expect(denied?.status()).toBe(403);
    await expect(page.locator("body")).toContainText("missing permission users:manage");

    const allowed = await page.goto("/metrics");
    expect(allowed?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Metrics Dashboard" })).toBeVisible();
  });

  test("operator can use operational pages but not admin pages", async ({ page }) => {
    await login(page, OPERATOR);
    await expect(page.locator("#role-badge")).toContainText("Operator");
    await expect(page.locator("#build-link")).not.toHaveClass(/hidden/);
    await expect(page.locator("#users-link")).toBeHidden();

    const build = await page.goto("/build");
    expect(build?.status()).toBe(200);
    await expect(page.locator("#build-form")).toBeVisible();

    const users = await page.goto("/users");
    expect(users?.status()).toBe(403);
  });
});

test("admin can generate passwords and inspect combined permission sources", async ({ page }) => {
  await login(page);
  await page.goto("/users");

  await page.locator("#add-user-btn").click();
  await expect(page.locator("#must-change-password")).toBeChecked();
  await page.locator("#generate-password-btn").click();
  const generatedPassword = await page.locator("#password").inputValue();
  expect(generatedPassword.length).toBeGreaterThanOrEqual(20);
  await expect(page.locator("#generated-password-hint")).toBeVisible();
  await page.locator("#cancel-btn").click();

  await expect(page.locator(`[data-action="feature-permissions"]`)).toHaveCount(0);
  await page.locator(`[data-action="permissions"][data-username="${OPERATOR.username}"]`).click();
  await expect(page.locator("#user-perms-modal")).toBeVisible();
  await expect(page.locator("#user-features-list")).toContainText("Console");
  await expect(page.locator("#user-features-list")).toContainText("console");
  await expect(page.locator("#user-effective-perms-list")).toContainText("clients:control");
  await expect(page.locator("#user-effective-perms-list")).toContainText("operator role");
  await expect(page.locator("#user-effective-perms-list")).toContainText("clients:build");
  await expect(page.locator("#user-effective-perms-list")).toContainText("Build permission toggle");
  await expect(page.locator("#user-effective-perms-list")).toContainText("Client scope");
});

test("admin page sweep loads without browser errors", async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);

  const routes = [
    ["/", "#grid"],
    ["/metrics", "h1"],
    ["/graph", "h1"],
    ["/settings", "#prefs-form"],
    ["/logs", "#page-info"],
    ["/notifications", "#notification-table"],
    ["/users", "#users-table-body"],
    ["/build", "#build-form"],
    ["/sol-publish", "#rpc-endpoint-list"],
    ["/plugins", "#plugin-list"],
    ["/scripts", "#saved-scripts-list"],
    ["/deploy", "#client-list"],
    ["/socks5-manager", "body"],
    ["/file-share", "#upload-form"],
    ["/purgatory", "#enrollment-table"],
  ] as const;

  const context = page.context();
  await page.close();

  for (const [path, selector] of routes) {
    const routePage = await context.newPage();
    // This sweep validates static/HTTP initialization. Opening two long-lived
    // sockets per page would only exercise the server's WebSocket rate limiter;
    // socket lifecycle is covered by the Turbo navigation test.
    await routePage.routeWebSocket(/.*/, (socket) => socket.close());
    const issues = collectBrowserIssues(routePage);
    const response = await routePage.goto(path);
    expect(response?.status(), `${path} should return 200`).toBe(200);
    await expect(routePage.locator("#top-nav"), `${path} should mount navigation`).toBeVisible();
    await expect(routePage.locator(selector).first(), `${path} should render ${selector}`).toBeVisible();
    await routePage.waitForTimeout(250);
    expect(issues, `${path} should not log browser errors`).toEqual([]);
    await routePage.close();
  }
});
