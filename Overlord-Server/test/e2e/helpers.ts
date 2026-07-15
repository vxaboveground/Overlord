import { expect, type Page } from "@playwright/test";
import { ADMIN } from "./credentials";

export async function login(
  page: Page,
  credentials: { username: string; password: string } = ADMIN,
): Promise<void> {
  await page.goto("/login.html");
  await page.locator("#user").fill(credentials.username);
  await page.locator("#pass").fill(credentials.password);
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/"),
    page.locator("#login-form button[type='submit']").click(),
  ]);
  await expect(page.locator("#top-nav")).toBeVisible();
}

export async function navigateFromMenu(page: Page, linkId: string): Promise<void> {
  const link = page.locator(`#${linkId}`);
  const wrapper = link.locator("xpath=ancestor::*[contains(@class, 'nav-dd-wrapper')][1]");
  await wrapper.locator(":scope > .nav-dd-group-btn").click();
  await expect(link).toBeVisible();
  await link.click();
}

export function collectBrowserIssues(page: Page): string[] {
  const issues: string[] = [];
  page.on("pageerror", (error) => issues.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error") {
      issues.push(`console error: ${text}`);
      return;
    }
    if (
      message.type() === "warning" &&
      /duplicate definition|preload|password field|autocomplete/i.test(text)
    ) {
      issues.push(`console warning: ${text}`);
    }
  });
  return issues;
}
