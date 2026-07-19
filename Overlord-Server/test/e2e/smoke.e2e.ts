import { expect, test } from "@playwright/test";
import { ONBOARDING_USER } from "./credentials";
import { collectBrowserIssues, login, navigateFromMenu } from "./helpers";

test.describe("authenticated browser smoke tests", () => {
  test("onboarding completion survives a hard reload", async ({ page }) => {
    const issues = collectBrowserIssues(page);
    await login(page, ONBOARDING_USER);

    const continueButton = page.locator(".account-onboarding__continue");
    await expect(continueButton).toBeVisible();
    // The dashboard behind the modal keeps resizing GridStack during startup,
    // so dispatch directly to the already-visible modal control.
    await continueButton.click({ force: true });
    await expect(continueButton).toContainText("report bugs");
    await continueButton.click({ force: true });
    await expect(page.locator(".account-onboarding")).toHaveCount(0);

    await page.reload();
    await expect(page.locator("#top-nav")).toBeVisible();
    await expect(page.locator(".account-onboarding")).toHaveCount(0);
    expect(issues).toEqual([]);
  });

  test("repeated Turbo visits do not duplicate widgets or throw", async ({ page }) => {
    const issues = collectBrowserIssues(page);
    await login(page);

    for (let visit = 0; visit < 3; visit += 1) {
      await navigateFromMenu(page, "notifications-link");
      await expect(page).toHaveURL(/\/notifications$/);
      await expect(page.locator("#notification-table.tabulator")).toBeVisible();

      await navigateFromMenu(page, "plugins-link");
      await expect(page).toHaveURL(/\/plugins$/);
      await expect(page.locator("#plugin-list")).toBeVisible();
    }

    expect(issues).toEqual([]);
  });

  test("dashboard metrics and plugin signing layout respond to narrow content", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await expect(page.locator("#dashboard-stats")).toBeVisible();

    await page.setViewportSize({ width: 800, height: 900 });
    await expect(page.locator("#dashboard-stats")).toBeHidden();

    await page.goto("/plugins");
    await expect(page.locator("#trusted-keys-section")).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });

    const layoutFits = await page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    );
    expect(layoutFits).toBe(true);

    for (const selector of [".plugin-panel", "#trusted-key-form"]) {
      const box = await page.locator(selector).last().boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(376);
    }
  });

  test("password inputs expose browser-safe form semantics", async ({ page }) => {
    const issues = collectBrowserIssues(page);
    await login(page);

    await page.goto("/file-share");
    await expect(page.locator("#upload-password")).toHaveAttribute("autocomplete", "new-password");
    await expect(page.locator("#upload-password").locator("xpath=ancestor::form")).toHaveCount(1);
    await expect(page.locator("#edit-password")).toHaveAttribute("autocomplete", "new-password");
    await expect(page.locator("#edit-password").locator("xpath=ancestor::form")).toHaveCount(1);

    await page.goto("/users");
    await expect(page.locator("#password")).toHaveAttribute("autocomplete", "new-password");
    expect(issues).toEqual([]);
  });
});
