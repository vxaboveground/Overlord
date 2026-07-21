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

  test("dashboard thumbnail preview modal opens when requested", async ({ page }) => {
    await login(page);
    await page.waitForFunction(() => document.getElementById("role-badge")?.textContent?.includes("Admin"));
    await page.waitForFunction(() => getComputedStyle(document.getElementById("pagination")!).visibility !== "hidden");
    await page.evaluate(() => {
      const grid = document.getElementById("grid");
      if (!grid) throw new Error("Dashboard grid not found");
      grid.innerHTML = `
        <article class="cv-row" data-client-row="rows" data-id="thumb-test" data-online="false">
          <div class="cv-thumb cv-thumb-host" data-thumb-host data-thumb-client="thumb-test" style="width: 80px; height: 50px;">
            <img class="thumb-img cv-thumb-img cv-thumb-overlay" data-thumb-img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="" />
          </div>
        </article>
      `;
      const host = grid.querySelector("[data-thumb-host]");
      if (!host) throw new Error("Thumbnail host not found");
      host.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const modal = page.locator(".modal").last();
    await expect(modal).toHaveClass(/flex/);
    await expect(modal).not.toHaveClass(/hidden/);
    await expect(page.locator("#modal-img")).toHaveAttribute("src", /data:image\/gif/);
  });

  test("change password page shows live password requirements", async ({ page }) => {
    await page.goto("/login.html");
    await page.evaluate(() => {
      sessionStorage.setItem("temp_token", "e2e-temp-token");
      sessionStorage.setItem("temp_user", JSON.stringify({ id: 1, username: "e2e-user" }));
    });
    await page.goto("/change-password.html");

    await expect(page.locator("#password-policy")).toContainText("At least 6 characters");
    await expect(page.locator('[data-password-rule="minLength"]')).toHaveClass(/is-unmet/);
    await page.locator("#new-pass").fill("abcdef");
    await expect(page.locator('[data-password-rule="minLength"]')).toHaveClass(/is-met/);
    await expect(page.locator('[data-password-rule="match"]')).toHaveClass(/is-unmet/);
    await page.locator("#confirm-pass").fill("abcdef");
    await expect(page.locator('[data-password-rule="match"]')).toHaveClass(/is-met/);
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

    await page.goto("/register.html");
    await expect(page.locator("#reg-user")).toHaveAttribute("pattern", "[a-zA-Z0-9_\\x2d]+");
    expect(issues).toEqual([]);
  });
});
