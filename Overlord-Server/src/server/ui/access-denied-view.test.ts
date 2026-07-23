import { describe, expect, test } from "bun:test";
import { renderAccessDeniedPage } from "./access-denied-view";

describe("renderAccessDeniedPage", () => {
  test("renders a complete permission screen with recovery actions", () => {
    const html = renderAccessDeniedPage({
      kind: "permission",
      message: "This page requires additional access.",
      detail: "users:manage",
      detailLabel: "Missing permission",
    });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("You don&#39;t have access");
    expect(html).toContain("users:manage");
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/settings"');
  });

  test("escapes dynamic denial details", () => {
    const html = renderAccessDeniedPage({
      kind: "client",
      title: "<script>bad()</script>",
      message: "Client <not-allowed>",
      detail: '"><img src=x onerror=bad()>',
    });

    expect(html).not.toContain("<script>bad()</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html).toContain("&lt;not-allowed&gt;");
  });
});
