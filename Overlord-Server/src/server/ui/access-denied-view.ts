import { escapeHtml } from "./html";

export type AccessDeniedKind =
  | "permission"
  | "role"
  | "feature"
  | "client"
  | "unavailable";

type AccessDeniedViewOptions = {
  kind: AccessDeniedKind;
  title?: string;
  message: string;
  detail?: string;
  detailLabel?: string;
};

const ICONS: Record<AccessDeniedKind, string> = {
  permission: "fa-user-lock",
  role: "fa-shield-halved",
  feature: "fa-toggle-off",
  client: "fa-desktop",
  unavailable: "fa-circle-pause",
};

export function renderAccessDeniedPage(options: AccessDeniedViewOptions): string {
  const title = options.title || (
    options.kind === "unavailable" ? "This feature is unavailable" : "You don't have access"
  );
  const detail = options.detail
    ? `
          <div class="access-detail">
            <span>${escapeHtml(options.detailLabel || "Required access")}</span>
            <code>${escapeHtml(options.detail)}</code>
          </div>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="turbo-visit-control" content="reload" />
    <title>${escapeHtml(title)} · Overlord</title>
    <link rel="icon" type="image/x-icon" href="/assets/favicon.ico" />
    <link rel="stylesheet" href="/vendor/inter/400.css" />
    <link rel="stylesheet" href="/vendor/inter/600.css" />
    <link rel="stylesheet" href="/vendor/inter/700.css" />
    <link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css" />
    <link rel="stylesheet" href="/assets/access-denied.css" />
  </head>
  <body>
    <main class="access-shell">
      <section class="access-card" aria-labelledby="access-title">
        <div class="access-status">403 · Access restricted</div>
        <div class="access-icon" aria-hidden="true">
          <i class="fa-solid ${ICONS[options.kind]}"></i>
        </div>
        <h1 id="access-title">${escapeHtml(title)}</h1>
        <p class="access-message">${escapeHtml(options.message)}</p>
        ${detail}
        <p class="access-help">If you believe you should have access, ask an administrator to update your account.</p>
        <div class="access-actions">
          <a class="access-primary" href="/">
            <i class="fa-solid fa-border-all" aria-hidden="true"></i>
            Return to dashboard
          </a>
          <a class="access-secondary" href="/settings">
            <i class="fa-solid fa-gear" aria-hidden="true"></i>
            Account settings
          </a>
        </div>
      </section>
      <p class="access-footer"><i class="fa-solid fa-crown" aria-hidden="true"></i> Overlord</p>
    </main>
  </body>
</html>`;
}
