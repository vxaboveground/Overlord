import {
  getNotificationsEnabled,
  setNotificationsEnabled,
  getDesktopNotificationsEnabled,
  setDesktopNotificationsEnabled,
  requestDesktopNotificationPermission,
} from "./notify-client.js";
import { escapeHtml, formatBytes as formatSharedBytes, formatDate as formatSharedDate } from "./format.js";

const PREF_REFRESH_KEY = "overlord_refresh_interval_seconds";
const NAV_MODE_KEY = "sb_mode";
const NAV_HIDDEN_KEY = "nav_hidden";

const usernameEl = document.getElementById("settings-username");
const roleEl = document.getElementById("settings-role");
const messageEl = document.getElementById("settings-message");

const passwordForm = document.getElementById("password-form");
const currentPasswordInput = document.getElementById("current-password");
const newPasswordInput = document.getElementById("new-password");
const confirmPasswordInput = document.getElementById("confirm-password");
const passwordPolicyHint = document.getElementById("password-policy-hint");
const mfaStatusText = document.getElementById("mfa-status-text");
const mfaStartBtn = document.getElementById("mfa-start-btn");
const mfaSetupPanel = document.getElementById("mfa-setup-panel");
const mfaQrCode = document.getElementById("mfa-qr-code");
const mfaSecretText = document.getElementById("mfa-secret-text");
const mfaEnableCodeInput = document.getElementById("mfa-enable-code");
const mfaEnableBtn = document.getElementById("mfa-enable-btn");
const mfaOtpauthLink = document.getElementById("mfa-otpauth-link");
const mfaDisablePanel = document.getElementById("mfa-disable-panel");
const mfaDisablePasswordInput = document.getElementById("mfa-disable-password");
const mfaDisableCodeInput = document.getElementById("mfa-disable-code");
const mfaDisableBtn = document.getElementById("mfa-disable-btn");
const mfaMessage = document.getElementById("mfa-message");

const prefsForm = document.getElementById("prefs-form");
const prefNotificationsInput = document.getElementById("pref-notifications");
const prefDesktopNotificationsInput = document.getElementById("pref-desktop-notifications");
const prefDesktopNotificationsHint = document.getElementById("pref-desktop-notifications-hint");
const prefRefreshSecondsInput = document.getElementById("pref-refresh-seconds");

const inputArchiveUserForm = document.getElementById("input-archive-user-form");
const inputArchiveMyEnabledInput = document.getElementById("input-archive-my-enabled");
const inputArchiveAdminForm = document.getElementById("input-archive-admin-form");
const inputArchiveGlobalEnabledInput = document.getElementById("input-archive-global-enabled");
const inputArchiveRetentionDaysInput = document.getElementById("input-archive-retention-days");
const inputArchiveMaxFileMbInput = document.getElementById("input-archive-max-file-mb");
const inputArchivePollSecondsInput = document.getElementById("input-archive-poll-seconds");

const myTelegramChatIdInput = document.getElementById("my-telegram-chat-id");
const saveMyTelegramBtn = document.getElementById("save-my-telegram");

const bansTableBody = document.getElementById("bans-table-body");
const bansPermissionNote = document.getElementById("bans-permission-note");
const refreshBansBtn = document.getElementById("refresh-bans-btn");

const securityForm = document.getElementById("security-form");
const securityPermissionNote = document.getElementById("security-permission-note");
const securitySaveBtn = document.getElementById("security-save-btn");
const securitySessionTtlInput = document.getElementById("security-session-ttl");
const securityLoginMaxAttemptsInput = document.getElementById("security-login-max-attempts");
const securityLoginWindowInput = document.getElementById("security-login-window");
const securityLockoutInput = document.getElementById("security-lockout");
const securityPasswordMinInput = document.getElementById("security-password-min");
const securityRequireUppercaseInput = document.getElementById("security-require-uppercase");
const securityRequireLowercaseInput = document.getElementById("security-require-lowercase");
const securityRequireNumberInput = document.getElementById("security-require-number");
const securityRequireSymbolInput = document.getElementById("security-require-symbol");
const securityMfaAdminsInput = document.getElementById("security-mfa-admins");
const securityMfaNonAdminsInput = document.getElementById("security-mfa-non-admins");

const tlsForm = document.getElementById("tls-form");
const tlsPermissionNote = document.getElementById("tls-permission-note");
const tlsSaveBtn = document.getElementById("tls-save-btn");
const tlsCertbotAutoBtn = document.getElementById("tls-certbot-auto-btn");
const tlsCertbotEmailInput = document.getElementById("tls-certbot-email");
const tlsCertbotEnabledInput = document.getElementById("tls-certbot-enabled");
const tlsCertbotLivePathInput = document.getElementById("tls-certbot-live-path");
const tlsCertbotDomainInput = document.getElementById("tls-certbot-domain");
const tlsCertbotCertFileInput = document.getElementById("tls-certbot-cert-file");
const tlsCertbotKeyFileInput = document.getElementById("tls-certbot-key-file");
const tlsCertbotCaFileInput = document.getElementById("tls-certbot-ca-file");

const oidcForm = document.getElementById("oidc-form");
const oidcPermissionNote = document.getElementById("oidc-permission-note");
const oidcSaveBtn = document.getElementById("oidc-save-btn");
const oidcEnabledInput = document.getElementById("oidc-enabled");
const oidcLabelInput = document.getElementById("oidc-label");
const oidcIssuerInput = document.getElementById("oidc-issuer");
const oidcClientIdInput = document.getElementById("oidc-client-id");
const oidcClientSecretInput = document.getElementById("oidc-client-secret");
const oidcSecretHint = document.getElementById("oidc-secret-hint");
const oidcRedirectUriInput = document.getElementById("oidc-redirect-uri");
const oidcScopesInput = document.getElementById("oidc-scopes");
const oidcClientAuthMethodInput = document.getElementById("oidc-client-auth-method");
const oidcAutoProvisionInput = document.getElementById("oidc-auto-provision");
const oidcAllowEmailLinkInput = document.getElementById("oidc-allow-email-link");
const oidcDefaultRoleInput = document.getElementById("oidc-default-role");
const oidcAllowedDomainsInput = document.getElementById("oidc-allowed-domains");
const oidcAllowedEmailsInput = document.getElementById("oidc-allowed-emails");
const oidcGroupClaimInput = document.getElementById("oidc-group-claim");
const oidcAdminGroupsInput = document.getElementById("oidc-admin-groups");
const oidcOperatorGroupsInput = document.getElementById("oidc-operator-groups");
const oidcViewerGroupsInput = document.getElementById("oidc-viewer-groups");

const appearanceForm = document.getElementById("appearance-form");
const appearancePermissionNote = document.getElementById("appearance-permission-note");
const appearanceSaveBtn = document.getElementById("appearance-save-btn");
const appearanceCustomCssInput = document.getElementById("appearance-custom-css");
const brandProductNameInput = document.getElementById("brand-product-name");
const brandTabNameInput = document.getElementById("brand-tab-name");
const brandFaviconUrlInput = document.getElementById("brand-favicon-url");
const brandFaviconFileInput = document.getElementById("brand-favicon-file");
const brandDashboardBackgroundUrlInput = document.getElementById("brand-dashboard-background-url");
const brandDashboardBackgroundFileInput = document.getElementById("brand-dashboard-background-file");
const brandNavNameInput = document.getElementById("brand-nav-name");
const brandAccentColorInput = document.getElementById("brand-accent-color");
const brandIconClassInput = document.getElementById("brand-icon-class");
const brandNavLogoUrlInput = document.getElementById("brand-nav-logo-url");
const brandNavLogoFileInput = document.getElementById("brand-nav-logo-file");
const brandNavLogoAltInput = document.getElementById("brand-nav-logo-alt");
const brandLoginLogoUrlInput = document.getElementById("brand-login-logo-url");
const brandLoginLogoFileInput = document.getElementById("brand-login-logo-file");
const brandLoginLogoAltInput = document.getElementById("brand-login-logo-alt");
const brandLoginTitleInput = document.getElementById("brand-login-title");
const brandLoginSubtitleInput = document.getElementById("brand-login-subtitle");
const brandHeroImageUrlInput = document.getElementById("brand-hero-image-url");
const brandHeroImageFileInput = document.getElementById("brand-hero-image-file");
const brandHeroImageAltInput = document.getElementById("brand-hero-image-alt");
const brandFooterTextInput = document.getElementById("brand-footer-text");
const brandSupportTextInput = document.getElementById("brand-support-text");
const brandSupportUrlInput = document.getElementById("brand-support-url");

const exportImportSection = document.getElementById("export-import-section");
const exportSettingsBtn = document.getElementById("export-settings-btn");
const importSettingsFile = document.getElementById("import-settings-file");
const exportImportMessage = document.getElementById("export-import-message");

const wipeOfflineSection = document.getElementById("wipe-offline-section");
const wipeOfflineBtn = document.getElementById("wipe-offline-btn");
const wipeOfflineMessage = document.getElementById("wipe-offline-message");

let currentUser = null;
let securityConfig = null;
let tlsConfig = null;
let oidcConfig = null;

function showMessage(text, type = "ok") {
  if (!messageEl) return;
  messageEl.textContent = text;
  messageEl.classList.remove(
    "hidden",
    "text-emerald-200",
    "border-emerald-700",
    "bg-emerald-900/30",
    "text-rose-200",
    "border-rose-700",
    "bg-rose-900/30",
  );

  if (type === "error") {
    messageEl.classList.add("text-rose-200", "border-rose-700", "bg-rose-900/30");
  } else {
    messageEl.classList.add("text-emerald-200", "border-emerald-700", "bg-emerald-900/30");
  }
}

function formatDate(timestamp) {
  return formatSharedDate(timestamp, "-");
}

function showSettingsSuccess(text, showInline = showMessage) {
  showInline(text);
  window.showToast?.(text, "success");
}

function canManageClientBans(role) {
  return userHas("network:manage-bans");
}

function isAdmin(role) {
  return role === "admin";
}

function userHas(perm) {
  return !!currentUser?.permissions?.includes(perm);
}

function requireUiPermission(perm, message = "You do not have permission for this setting.") {
  if (userHas(perm)) return true;
  showMessage(message, "error");
  return false;
}

function applyPermissionVisibility() {
  document.querySelectorAll("[data-permission]").forEach((el) => {
    const perm = el.dataset.permission;
    if (perm && userHas(perm)) {
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  });

  const sidebar = document.getElementById("settings-sidebar");
  if (!sidebar) return;
  const children = Array.from(sidebar.children);
  for (let i = 0; i < children.length; i++) {
    const label = children[i];
    if (!label.classList.contains("settings-nav-group-label")) continue;
    let hasVisibleLink = false;
    for (let j = i + 1; j < children.length; j++) {
      const next = children[j];
      if (next.classList.contains("settings-nav-group-label")) break;
      if (next.classList.contains("settings-nav-link") && !next.classList.contains("hidden")) {
        hasVisibleLink = true;
        break;
      }
    }
    label.classList.toggle("hidden", !hasVisibleLink);
  }
}

async function renderPermissionsOverview() {
  const container = document.getElementById("settings-permissions-summary");
  if (!container || !currentUser) return;

  const granted = new Set(currentUser.permissions || []);
  let catalog = [];
  try {
    const res = await fetch("/api/permissions", { credentials: "include" });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      catalog = Array.isArray(data.permissions) ? data.permissions : [];
    }
  } catch {}

  const byId = new Map(catalog.map((perm) => [perm.id, perm.description]));
  const groups = [
    {
      title: "User Administration",
      icon: "fa-users-gear",
      perms: ["users:manage", "audit:view"],
    },
    {
      title: "Client Operations",
      icon: "fa-desktop",
      perms: [
        "clients:control",
        "clients:build",
        "clients:metadata",
        "clients:disconnect",
        "clients:reconnect",
        "clients:uninstall",
        "clients:elevate",
        "clients:winre",
      ],
    },
    {
      title: "System Settings",
      icon: "fa-sliders",
      perms: [
        "system:security",
        "system:tls",
        "system:oidc",
        "system:registration",
        "system:notifications",
        "system:chat",
        "system:appearance",
        "system:thumbnails",
        "system:input-archive",
        "system:build-limits",
        "system:export-import",
        "system:health",
        "system:health:manage",
        "system:profiler",
      ],
    },
  ];

  container.innerHTML = groups
    .map((group) => {
      const rows = group.perms
        .map((perm) => {
          const has = granted.has(perm);
          return `
            <div class="flex items-start justify-between gap-3 rounded bg-slate-950/70 border border-slate-800 px-3 py-2">
              <div class="min-w-0">
                <div class="font-mono text-xs ${has ? "text-slate-100" : "text-slate-500"}">${escapeHtml(perm)}</div>
                <div class="text-[11px] text-slate-500 leading-snug">${escapeHtml(byId.get(perm) || "")}</div>
              </div>
              <span class="shrink-0 text-xs ${has ? "text-emerald-300" : "text-slate-600"}">
                <i class="fa-solid ${has ? "fa-circle-check" : "fa-circle-minus"}"></i>
              </span>
            </div>
          `;
        })
        .join("");
      return `
        <div class="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
          <h3 class="text-sm font-semibold mb-3 flex items-center gap-2">
            <i class="fa-solid ${group.icon} text-violet-400"></i>${escapeHtml(group.title)}
          </h3>
          <div class="space-y-2">${rows}</div>
        </div>
      `;
    })
    .join("");
}

function getPasswordRequirementsText() {
  const minLength = Number(securityConfig?.passwordMinLength) || 6;
  const requirements = [`min ${minLength} chars`];
  if (securityConfig?.passwordRequireUppercase) requirements.push("uppercase");
  if (securityConfig?.passwordRequireLowercase) requirements.push("lowercase");
  if (securityConfig?.passwordRequireNumber) requirements.push("number");
  if (securityConfig?.passwordRequireSymbol) requirements.push("symbol");
  return requirements.join(", ");
}

function updatePasswordPolicyUi() {
  const minLength = Number(securityConfig?.passwordMinLength) || 6;
  if (newPasswordInput) {
    newPasswordInput.minLength = minLength;
    newPasswordInput.placeholder = `New password (${getPasswordRequirementsText()})`;
  }
  if (confirmPasswordInput) {
    confirmPasswordInput.minLength = minLength;
  }
  if (passwordPolicyHint) {
    passwordPolicyHint.textContent = `Policy: ${getPasswordRequirementsText()}`;
  }
}

function setSecurityFormDisabled(disabled) {
  const controls = [
    securitySessionTtlInput,
    securityLoginMaxAttemptsInput,
    securityLoginWindowInput,
    securityLockoutInput,
    securityPasswordMinInput,
    securityRequireUppercaseInput,
    securityRequireLowercaseInput,
    securityRequireNumberInput,
    securityRequireSymbolInput,
    securityMfaAdminsInput,
    securityMfaNonAdminsInput,
    securitySaveBtn,
  ];

  for (const control of controls) {
    if (!control) continue;
    control.disabled = disabled;
  }
}

function setTlsFormDisabled(disabled) {
  const controls = [
    tlsCertbotEmailInput,
    tlsCertbotEnabledInput,
    tlsCertbotLivePathInput,
    tlsCertbotDomainInput,
    tlsCertbotCertFileInput,
    tlsCertbotKeyFileInput,
    tlsCertbotCaFileInput,
    tlsSaveBtn,
    tlsCertbotAutoBtn,
  ];

  for (const control of controls) {
    if (!control) continue;
    control.disabled = disabled;
  }
}

function setTlsAutoSetupRunning(running) {
  if (!tlsCertbotAutoBtn) return;
  tlsCertbotAutoBtn.disabled = running;
  tlsCertbotAutoBtn.innerHTML = running
    ? '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Running Certbot Setup...'
    : '<i class="fa-solid fa-wand-magic-sparkles mr-2"></i>Auto Setup Free SSL (Let\'s Encrypt)';
}

function applySecurityForm() {
  if (!securityConfig) return;
  securitySessionTtlInput.value = String(securityConfig.sessionTtlHours || 168);
  securityLoginMaxAttemptsInput.value = String(securityConfig.loginMaxAttempts || 5);
  securityLoginWindowInput.value = String(securityConfig.loginWindowMinutes || 15);
  securityLockoutInput.value = String(securityConfig.loginLockoutMinutes || 30);
  securityPasswordMinInput.value = String(securityConfig.passwordMinLength || 6);
  securityRequireUppercaseInput.checked = Boolean(securityConfig.passwordRequireUppercase);
  securityRequireLowercaseInput.checked = Boolean(securityConfig.passwordRequireLowercase);
  securityRequireNumberInput.checked = Boolean(securityConfig.passwordRequireNumber);
  securityRequireSymbolInput.checked = Boolean(securityConfig.passwordRequireSymbol);
  if (securityMfaAdminsInput) securityMfaAdminsInput.checked = Boolean(securityConfig.mfaRequiredForAdmins);
  if (securityMfaNonAdminsInput) securityMfaNonAdminsInput.checked = Boolean(securityConfig.mfaRequiredForNonAdmins);
  updatePasswordPolicyUi();
}

async function loadSecurityPolicy() {
  if (!currentUser) return;

  if (!userHas("system:security")) {
    securityPermissionNote.classList.remove("hidden");
    setSecurityFormDisabled(true);
    securityConfig = {
      passwordMinLength: 6,
      passwordRequireUppercase: false,
      passwordRequireLowercase: false,
      passwordRequireNumber: false,
      passwordRequireSymbol: false,
      mfaRequiredForAdmins: false,
      mfaRequiredForNonAdmins: false,
    };
    updatePasswordPolicyUi();
    return;
  }

  securityPermissionNote.classList.add("hidden");

  const res = await fetch("/api/settings/security", { credentials: "include" });
  if (!res.ok) {
    showMessage("Failed to load security settings.", "error");
    setSecurityFormDisabled(true);
    return;
  }

  const data = await res.json().catch(() => ({}));
  securityConfig = data.security || null;
  applySecurityForm();
  setSecurityFormDisabled(false);
}

function applyTlsForm() {
  const certbot = tlsConfig?.certbot || {};
  tlsCertbotEnabledInput.checked = Boolean(certbot.enabled);
  tlsCertbotEmailInput.value = "";
  tlsCertbotLivePathInput.value = certbot.livePath || "/etc/letsencrypt/live";
  tlsCertbotDomainInput.value = certbot.domain || "";
  tlsCertbotCertFileInput.value = certbot.certFileName || "fullchain.pem";
  tlsCertbotKeyFileInput.value = certbot.keyFileName || "privkey.pem";
  tlsCertbotCaFileInput.value = certbot.caFileName || "chain.pem";
}

async function loadTlsSettings() {
  if (!currentUser) return;

  if (!userHas("system:tls")) {
    tlsPermissionNote.classList.remove("hidden");
    setTlsFormDisabled(true);
    tlsConfig = {
      certbot: {
        enabled: false,
        livePath: "/etc/letsencrypt/live",
        domain: "",
        certFileName: "fullchain.pem",
        keyFileName: "privkey.pem",
        caFileName: "chain.pem",
      },
    };
    applyTlsForm();
    return;
  }

  tlsPermissionNote.classList.add("hidden");
  const res = await fetch("/api/settings/tls", { credentials: "include" });
  if (!res.ok) {
    showMessage("Failed to load TLS settings.", "error");
    setTlsFormDisabled(true);
    return;
  }

  const data = await res.json().catch(() => ({}));
  tlsConfig = data.tls || null;
  applyTlsForm();
  setTlsFormDisabled(false);
}

function listToCsv(value) {
  return Array.isArray(value) ? value.join(", ") : "";
}

function csvToList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function setOidcFormDisabled(disabled) {
  const controls = [
    oidcEnabledInput,
    oidcLabelInput,
    oidcIssuerInput,
    oidcClientIdInput,
    oidcClientSecretInput,
    oidcRedirectUriInput,
    oidcScopesInput,
    oidcClientAuthMethodInput,
    oidcAutoProvisionInput,
    oidcAllowEmailLinkInput,
    oidcDefaultRoleInput,
    oidcAllowedDomainsInput,
    oidcAllowedEmailsInput,
    oidcGroupClaimInput,
    oidcAdminGroupsInput,
    oidcOperatorGroupsInput,
    oidcViewerGroupsInput,
    oidcSaveBtn,
  ];

  for (const control of controls) {
    if (!control) continue;
    control.disabled = disabled;
  }
}

function applyOidcForm() {
  const cfg = oidcConfig || {};
  if (oidcEnabledInput) oidcEnabledInput.checked = Boolean(cfg.enabled);
  if (oidcLabelInput) oidcLabelInput.value = cfg.label || "Single sign-on";
  if (oidcIssuerInput) oidcIssuerInput.value = cfg.issuer || "";
  if (oidcClientIdInput) oidcClientIdInput.value = cfg.clientId || "";
  if (oidcClientSecretInput) oidcClientSecretInput.value = "";
  if (oidcSecretHint) {
    oidcSecretHint.textContent = cfg.clientSecretSet
      ? "A client secret is saved. Leave this blank to keep it."
      : "No client secret is currently saved.";
  }
  if (oidcRedirectUriInput) oidcRedirectUriInput.value = cfg.redirectUri || "";
  if (oidcScopesInput) oidcScopesInput.value = listToCsv(cfg.scopes || ["openid", "profile", "email"]);
  if (oidcClientAuthMethodInput) oidcClientAuthMethodInput.value = cfg.clientAuthMethod || "client_secret_post";
  if (oidcAutoProvisionInput) oidcAutoProvisionInput.checked = cfg.autoProvision !== false;
  if (oidcAllowEmailLinkInput) oidcAllowEmailLinkInput.checked = Boolean(cfg.allowEmailLink);
  if (oidcDefaultRoleInput) oidcDefaultRoleInput.value = cfg.defaultRole || "viewer";
  if (oidcAllowedDomainsInput) oidcAllowedDomainsInput.value = listToCsv(cfg.allowedDomains);
  if (oidcAllowedEmailsInput) oidcAllowedEmailsInput.value = listToCsv(cfg.allowedEmails);
  if (oidcGroupClaimInput) oidcGroupClaimInput.value = cfg.groupClaim || "groups";
  if (oidcAdminGroupsInput) oidcAdminGroupsInput.value = listToCsv(cfg.adminGroups);
  if (oidcOperatorGroupsInput) oidcOperatorGroupsInput.value = listToCsv(cfg.operatorGroups);
  if (oidcViewerGroupsInput) oidcViewerGroupsInput.value = listToCsv(cfg.viewerGroups);
}

async function loadOidcSettings() {
  if (!currentUser) return;

  if (!userHas("system:oidc")) {
    if (oidcPermissionNote) oidcPermissionNote.classList.remove("hidden");
    setOidcFormDisabled(true);
    return;
  }

  if (oidcPermissionNote) oidcPermissionNote.classList.add("hidden");
  const res = await fetch("/api/settings/oidc", { credentials: "include" });
  if (!res.ok) {
    showMessage("Failed to load OIDC settings.", "error");
    setOidcFormDisabled(true);
    return;
  }

  const data = await res.json().catch(() => ({}));
  oidcConfig = data.oidc || null;
  applyOidcForm();
  setOidcFormDisabled(false);
}

function updateNavLayoutButtons(mode, sidebarBtn, topbarBtn) {
  const active = ["bg-indigo-600/80", "border-indigo-500", "text-white"];
  const inactive = ["bg-slate-800", "border-slate-700", "text-slate-400", "hover:bg-slate-700", "hover:text-slate-200"];
  const base = ["nav-layout-btn", "flex-1", "flex", "items-center", "justify-center", "gap-2", "px-3", "py-2", "rounded-lg", "border", "text-sm", "font-medium", "transition-colors"];

  sidebarBtn.className = [...base, ...(mode === "sidebar" ? active : inactive)].join(" ");
  topbarBtn.className = [...base, ...(mode === "topbar" ? active : inactive)].join(" ");
  sidebarBtn.dataset.selected = mode === "sidebar" ? "true" : "false";
  topbarBtn.dataset.selected = mode === "topbar" ? "true" : "false";
}

function loadPrefs() {
  prefNotificationsInput.checked = getNotificationsEnabled();
  if (prefDesktopNotificationsInput) {
    prefDesktopNotificationsInput.checked = getDesktopNotificationsEnabled();
  }
  const refreshSeconds = Number(localStorage.getItem(PREF_REFRESH_KEY) || 8);
  prefRefreshSecondsInput.value = String(Math.min(120, Math.max(3, refreshSeconds)));

  const navMode = localStorage.getItem(NAV_MODE_KEY) || "topbar";
  const sidebarBtn = document.getElementById("pref-nav-sidebar");
  const topbarBtn = document.getElementById("pref-nav-topbar");
  if (sidebarBtn && topbarBtn) {
    updateNavLayoutButtons(navMode === "topbar" ? "topbar" : "sidebar", sidebarBtn, topbarBtn);
  }

  const navHiddenInput = document.getElementById("pref-nav-hidden");
  if (navHiddenInput) {
    navHiddenInput.checked = localStorage.getItem(NAV_HIDDEN_KEY) === "true";
  }
}

async function loadCurrentUser() {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  if (!res.ok) {
    window.location.href = "/";
    return;
  }

  currentUser = await res.json();
  usernameEl.textContent = currentUser.username || "unknown";
  roleEl.textContent = currentUser.role || "unknown";
}

async function updatePassword(event) {
  event.preventDefault();
  if (!currentUser?.userId) return;

  const currentPassword = currentPasswordInput.value;
  const newPassword = newPasswordInput.value;
  const confirmPassword = confirmPasswordInput.value;
  const minLength = Number(securityConfig?.passwordMinLength) || 6;

  if (newPassword.length < minLength) {
    showMessage(`New password must be at least ${minLength} characters.`, "error");
    return;
  }

  if (newPassword !== confirmPassword) {
    showMessage("Password confirmation does not match.", "error");
    return;
  }

  const res = await fetch(`/api/users/${currentUser.userId}/password`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      currentPassword,
      newPassword,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showMessage(data.error || "Failed to update password.", "error");
    return;
  }

  passwordForm.reset();
  showSettingsSuccess("Password updated successfully.");
}

function showMfaMessage(text, type = "ok") {
  if (!mfaMessage) return;
  mfaMessage.textContent = text;
  mfaMessage.className = `text-sm rounded-lg px-3 py-2 border ${
    type === "error"
      ? "border-rose-800 bg-rose-900/20 text-rose-200"
      : "border-emerald-800 bg-emerald-900/20 text-emerald-200"
  }`;
  mfaMessage.classList.remove("hidden");
  setTimeout(() => mfaMessage.classList.add("hidden"), 5000);
}

async function loadMfaStatus() {
  if (!mfaStatusText) return;
  try {
    const res = await fetch("/api/mfa/status", { credentials: "include" });
    if (!res.ok) {
      mfaStatusText.textContent = "Failed to load MFA status.";
      return;
    }
    const data = await res.json();
    const requiredText = data.required ? " Required by policy." : "";
    mfaStatusText.textContent = data.enabled
      ? `MFA is enabled.${requiredText}`
      : `MFA is not enabled.${requiredText}`;
    if (mfaStartBtn) mfaStartBtn.classList.toggle("hidden", !!data.enabled);
    if (mfaDisablePanel) mfaDisablePanel.classList.toggle("hidden", !data.enabled);
    if (mfaDisableBtn) mfaDisableBtn.disabled = !!data.required;
    if (mfaDisablePanel) {
      mfaDisablePanel.classList.toggle("opacity-60", !!data.required);
    }
  } catch {
    mfaStatusText.textContent = "Failed to load MFA status.";
  }
}

async function startMfaSetup() {
  try {
    const res = await fetch("/api/mfa/setup", { method: "POST", credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showMfaMessage(data.error || "Failed to start MFA setup.", "error");
      return;
    }
    if (mfaQrCode) mfaQrCode.innerHTML = data.qrSvg || "";
    if (mfaSecretText) mfaSecretText.textContent = data.secret || "";
    if (mfaOtpauthLink) mfaOtpauthLink.href = data.otpauthUrl || "#";
    if (mfaSetupPanel) mfaSetupPanel.classList.remove("hidden");
    if (mfaEnableCodeInput) mfaEnableCodeInput.focus();
  } catch {
    showMfaMessage("Network error while starting MFA setup.", "error");
  }
}

async function enableMfa() {
  const code = String(mfaEnableCodeInput?.value || "").trim();
  try {
    const res = await fetch("/api/mfa/enable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showMfaMessage(data.error || "Failed to enable MFA.", "error");
      return;
    }
    if (mfaSetupPanel) mfaSetupPanel.classList.add("hidden");
    if (mfaEnableCodeInput) mfaEnableCodeInput.value = "";
    showMfaMessage("MFA enabled.");
    await loadMfaStatus();
  } catch {
    showMfaMessage("Network error while enabling MFA.", "error");
  }
}

async function disableMfa() {
  const currentPassword = String(mfaDisablePasswordInput?.value || "");
  const code = String(mfaDisableCodeInput?.value || "").trim();
  try {
    const res = await fetch("/api/mfa/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ currentPassword, code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showMfaMessage(data.error || "Failed to disable MFA.", "error");
      return;
    }
    if (mfaDisablePasswordInput) mfaDisablePasswordInput.value = "";
    if (mfaDisableCodeInput) mfaDisableCodeInput.value = "";
    showMfaMessage("MFA disabled.");
    await loadMfaStatus();
  } catch {
    showMfaMessage("Network error while disabling MFA.", "error");
  }
}

function savePrefs(event) {
  event.preventDefault();

  const refreshSeconds = Math.min(
    120,
    Math.max(3, Number(prefRefreshSecondsInput.value || 8)),
  );

  setNotificationsEnabled(prefNotificationsInput.checked);
  localStorage.setItem(PREF_REFRESH_KEY, String(refreshSeconds));
  prefRefreshSecondsInput.value = String(refreshSeconds);

  const wantsDesktop = prefDesktopNotificationsInput
    ? prefDesktopNotificationsInput.checked
    : false;

  if (wantsDesktop) {
    requestDesktopNotificationPermission().then((perm) => {
      if (perm === "granted") {
        setDesktopNotificationsEnabled(true);
        if (prefDesktopNotificationsHint) prefDesktopNotificationsHint.classList.add("hidden");
        showSettingsSuccess("Preferences saved. Desktop notifications enabled.");
      } else {
        setDesktopNotificationsEnabled(false);
        if (prefDesktopNotificationsInput) prefDesktopNotificationsInput.checked = false;
        if (prefDesktopNotificationsHint) prefDesktopNotificationsHint.classList.remove("hidden");
        showMessage("Desktop notifications require browser permission — not granted.", "error");
      }
    });
  } else {
    setDesktopNotificationsEnabled(false);
    if (prefDesktopNotificationsHint) prefDesktopNotificationsHint.classList.add("hidden");
    showSettingsSuccess("Preferences saved.");
  }

  const navHiddenInput = document.getElementById("pref-nav-hidden");
  if (navHiddenInput) {
    localStorage.setItem(NAV_HIDDEN_KEY, String(navHiddenInput.checked));
    document.body.classList.toggle("nav-hidden", navHiddenInput.checked);
  }
}

async function saveSecurityPolicy(event) {
  event.preventDefault();
  if (!requireUiPermission("system:security", "Security policy permission required.")) {
    return;
  }

  const payload = {
    sessionTtlHours: Number(securitySessionTtlInput.value || 168),
    loginMaxAttempts: Number(securityLoginMaxAttemptsInput.value || 5),
    loginWindowMinutes: Number(securityLoginWindowInput.value || 15),
    loginLockoutMinutes: Number(securityLockoutInput.value || 30),
    passwordMinLength: Number(securityPasswordMinInput.value || 6),
    passwordRequireUppercase: securityRequireUppercaseInput.checked,
    passwordRequireLowercase: securityRequireLowercaseInput.checked,
    passwordRequireNumber: securityRequireNumberInput.checked,
    passwordRequireSymbol: securityRequireSymbolInput.checked,
    mfaRequiredForAdmins: !!securityMfaAdminsInput?.checked,
    mfaRequiredForNonAdmins: !!securityMfaNonAdminsInput?.checked,
  };

  const res = await fetch("/api/settings/security", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showMessage(data.error || "Failed to save security policy.", "error");
    return;
  }

  securityConfig = data.security || payload;
  applySecurityForm();
  showSettingsSuccess("Security policy updated.");
}

async function saveTlsSettings(event) {
  event.preventDefault();
  if (!requireUiPermission("system:tls", "TLS settings permission required.")) {
    return;
  }

  const payload = {
    certbot: {
      enabled: tlsCertbotEnabledInput.checked,
      livePath: String(tlsCertbotLivePathInput.value || "").trim(),
      domain: String(tlsCertbotDomainInput.value || "").trim(),
      certFileName: String(tlsCertbotCertFileInput.value || "").trim(),
      keyFileName: String(tlsCertbotKeyFileInput.value || "").trim(),
      caFileName: String(tlsCertbotCaFileInput.value || "").trim(),
    },
  };

  const res = await fetch("/api/settings/tls", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showMessage(data.error || "Failed to save TLS settings.", "error");
    return;
  }

  tlsConfig = data.tls || payload;
  applyTlsForm();
  showSettingsSuccess("TLS settings updated. Restart server to apply.");
}

async function saveOidcSettings(event) {
  event.preventDefault();
  if (!requireUiPermission("system:oidc", "OIDC settings permission required.")) {
    return;
  }

  const payload = {
    enabled: !!oidcEnabledInput?.checked,
    label: String(oidcLabelInput?.value || "").trim(),
    issuer: String(oidcIssuerInput?.value || "").trim(),
    clientId: String(oidcClientIdInput?.value || "").trim(),
    redirectUri: String(oidcRedirectUriInput?.value || "").trim(),
    scopes: csvToList(oidcScopesInput?.value),
    clientAuthMethod: oidcClientAuthMethodInput?.value || "client_secret_post",
    autoProvision: !!oidcAutoProvisionInput?.checked,
    allowEmailLink: !!oidcAllowEmailLinkInput?.checked,
    defaultRole: oidcDefaultRoleInput?.value || "viewer",
    allowedDomains: csvToList(oidcAllowedDomainsInput?.value),
    allowedEmails: csvToList(oidcAllowedEmailsInput?.value),
    groupClaim: String(oidcGroupClaimInput?.value || "").trim(),
    adminGroups: csvToList(oidcAdminGroupsInput?.value),
    operatorGroups: csvToList(oidcOperatorGroupsInput?.value),
    viewerGroups: csvToList(oidcViewerGroupsInput?.value),
  };

  const clientSecret = String(oidcClientSecretInput?.value || "");
  if (clientSecret) {
    payload.clientSecret = clientSecret;
  }

  if (payload.enabled) {
    if (!payload.issuer) {
      showMessage("OIDC issuer URL is required when OIDC is enabled.", "error");
      oidcIssuerInput?.focus();
      return;
    }
    if (!payload.redirectUri) {
      showMessage("OIDC redirect URI is required when OIDC is enabled.", "error");
      oidcRedirectUriInput?.focus();
      return;
    }
    if (!payload.clientId) {
      showMessage("OIDC client ID is required when OIDC is enabled.", "error");
      oidcClientIdInput?.focus();
      return;
    }
    if (!payload.scopes.length || !payload.scopes.includes("openid")) {
      showMessage("OIDC scopes must include openid.", "error");
      oidcScopesInput?.focus();
      return;
    }
    if (payload.clientAuthMethod !== "none" && !clientSecret && !oidcConfig?.clientSecretSet) {
      showMessage("OIDC client secret is required for the selected client auth method.", "error");
      oidcClientSecretInput?.focus();
      return;
    }
  }

  const res = await fetch("/api/settings/oidc", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showMessage(data.error || "Failed to save OIDC settings.", "error");
    return;
  }

  oidcConfig = data.oidc || payload;
  applyOidcForm();
  showSettingsSuccess("OIDC settings saved. Environment variables still take priority after restart.");
}

async function runCertbotAutoSetup() {
  if (!requireUiPermission("system:tls", "TLS settings permission required.")) {
    return;
  }

  const domain = String(tlsCertbotDomainInput.value || "").trim();
  const email = String(tlsCertbotEmailInput.value || "").trim();
  const livePath = String(tlsCertbotLivePathInput.value || "").trim() || "/etc/letsencrypt/live";

  if (!domain) {
    showMessage("Please enter a domain first.", "error");
    return;
  }

  if (!email) {
    showMessage("Please enter an email first.", "error");
    return;
  }

  setTlsAutoSetupRunning(true);

  try {
    const res = await fetch("/api/settings/tls/certbot/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ domain, email, livePath }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showMessage(data.error || "Certbot setup failed.", "error");
      return;
    }

    tlsConfig = data.tls || tlsConfig;
    applyTlsForm();
    const details = data?.certbot?.certPath
      ? ` Cert: ${data.certbot.certPath}`
      : "";
    showMessage(`${data.message || "Certbot setup complete."}${details}`);
  } catch (error) {
    showMessage(`Certbot setup failed: ${String(error?.message || error)}`, "error");
  } finally {
    setTlsAutoSetupRunning(false);
  }
}

async function loadMyTelegram() {
  if (!myTelegramChatIdInput) return;
  if (currentUser?.telegramChatId) {
    myTelegramChatIdInput.value = currentUser.telegramChatId;
  } else {
    try {
      const res = await fetch("/api/settings/telegram", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        myTelegramChatIdInput.value = data.telegramChatId || "";
      }
    } catch {}
  }
}

async function saveMyTelegram() {
  if (!myTelegramChatIdInput) return;
  const chatId = myTelegramChatIdInput.value.trim();

  try {
    const res = await fetch("/api/settings/telegram", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ telegramChatId: chatId }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showMessage(data.error || "Failed to save Telegram settings.", "error");
      return;
    }

    myTelegramChatIdInput.value = data.telegramChatId || "";
    showSettingsSuccess(chatId ? "Telegram chat ID saved." : "Telegram notifications disabled.");
  } catch {
    showMessage("Failed to save Telegram settings.", "error");
  }
}

async function loadBannedIps() {
  if (!currentUser) return;

  if (!canManageClientBans(currentUser.role)) {
    bansPermissionNote.classList.remove("hidden");
    refreshBansBtn.disabled = true;
    bansTableBody.innerHTML = `
      <tr>
        <td colspan="4" class="px-3 py-6 text-center text-slate-500">No access</td>
      </tr>
    `;
    return;
  }

  bansPermissionNote.classList.add("hidden");

  const res = await fetch("/api/clients/banned-ips", { credentials: "include" });
  if (!res.ok) {
    bansTableBody.innerHTML = `
      <tr>
        <td colspan="4" class="px-3 py-6 text-center text-rose-300">Failed to load banned IPs</td>
      </tr>
    `;
    return;
  }

  const data = await res.json().catch(() => ({ items: [] }));
  const items = Array.isArray(data.items) ? data.items : [];

  if (items.length === 0) {
    bansTableBody.innerHTML = `
      <tr>
        <td colspan="4" class="px-3 py-6 text-center text-slate-400">No banned IPs</td>
      </tr>
    `;
    return;
  }

  bansTableBody.innerHTML = items
    .map(
      (item) => `
      <tr>
        <td class="px-3 py-2 font-mono text-xs sm:text-sm text-slate-100">${escapeHtml(item.ip)}</td>
        <td class="px-3 py-2 text-slate-300">${escapeHtml(item.reason || "Manual ban")}</td>
        <td class="px-3 py-2 text-slate-400">${formatDate(item.createdAt)}</td>
        <td class="px-3 py-2 text-right">
          <button
            type="button"
            class="unban-btn px-2.5 py-1.5 rounded bg-emerald-700/80 hover:bg-emerald-600 text-white text-xs"
            data-ip="${escapeHtml(item.ip)}"
          >
            <i class="fa-solid fa-unlock mr-1"></i>Unban
          </button>
        </td>
      </tr>
    `,
    )
    .join("");
}

async function handleUnbanClick(event) {
  const button = event.target.closest(".unban-btn");
  if (!button) return;

  const ip = button.dataset.ip;
  if (!ip) return;

  if (!confirm(`Unban ${ip}?`)) return;

  button.disabled = true;
  const res = await fetch(`/api/clients/banned-ips?ip=${encodeURIComponent(ip)}`, {
    method: "DELETE",
    credentials: "include",
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showMessage(data.error || `Failed to unban ${ip}.`, "error");
    button.disabled = false;
    return;
  }

  showMessage(`Unbanned ${ip}.`);
  await loadBannedIps();
}

// ---- Build IDs section ----------------------------------------------------

const buildsSection = document.getElementById("section-builds");
const buildsTableBody = document.getElementById("builds-table-body");
const refreshBuildsBtn = document.getElementById("refresh-builds-btn");
const buildsShowAllInput = document.getElementById("builds-show-all");
const buildsShowAllWrap = document.getElementById("builds-show-all-wrap");
const buildsMessageEl = document.getElementById("builds-message");

function showBuildsMessage(text, type = "ok") {
  if (!buildsMessageEl) return;
  buildsMessageEl.textContent = text;
  buildsMessageEl.classList.remove(
    "hidden",
    "text-emerald-200", "border-emerald-700", "bg-emerald-900/30",
    "text-rose-200", "border-rose-700", "bg-rose-900/30",
  );
  if (type === "error") {
    buildsMessageEl.classList.add("text-rose-200", "border-rose-700", "bg-rose-900/30");
  } else {
    buildsMessageEl.classList.add("text-emerald-200", "border-emerald-700", "bg-emerald-900/30");
  }
  setTimeout(() => buildsMessageEl.classList.add("hidden"), 4000);
}

function canManageBuilds(role) {
  return role === "admin" || role === "operator";
}

async function loadBuilds() {
  if (!buildsTableBody) return;
  if (!canManageBuilds(currentUser?.role)) return;

  const showAll = !!buildsShowAllInput?.checked && isAdmin(currentUser?.role);
  const url = showAll ? "/api/build/list?all=true" : "/api/build/list";

  buildsTableBody.innerHTML = `
    <tr><td colspan="6" class="px-3 py-6 text-center text-slate-400">Loading...</td></tr>
  `;

  let res;
  try {
    res = await fetch(url, { credentials: "include" });
  } catch {
    buildsTableBody.innerHTML = `
      <tr><td colspan="6" class="px-3 py-6 text-center text-rose-300">Network error</td></tr>
    `;
    return;
  }

  if (!res.ok) {
    buildsTableBody.innerHTML = `
      <tr><td colspan="6" class="px-3 py-6 text-center text-rose-300">Failed to load builds (HTTP ${res.status})</td></tr>
    `;
    return;
  }

  const data = await res.json().catch(() => ({ builds: [] }));
  const builds = Array.isArray(data.builds) ? data.builds : [];

  if (builds.length === 0) {
    buildsTableBody.innerHTML = `
      <tr><td colspan="6" class="px-3 py-6 text-center text-slate-400">No builds</td></tr>
    `;
    return;
  }

  buildsTableBody.innerHTML = builds.map((b) => {
    const tag = b.buildTag ? String(b.buildTag) : "";
    const tagShort = tag ? `${tag.substring(0, 8)}...` : "—";
    const idShort = `${String(b.id).substring(0, 8)}...`;
    const statusBadge = b.blocked
      ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-900/40 border border-red-700 text-red-200 text-xs"><i class="fa-solid fa-ban"></i>Blocked</span>`
      : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-900/30 border border-emerald-700 text-emerald-200 text-xs"><i class="fa-solid fa-circle-check"></i>Active</span>`;
    const actionBtn = b.blocked
      ? `<button type="button" class="builds-action-btn px-2.5 py-1.5 rounded bg-emerald-700/80 hover:bg-emerald-600 text-white text-xs" data-build-id="${escapeHtml(b.id)}" data-block="false"><i class="fa-solid fa-unlock mr-1"></i>Unblock</button>`
      : `<button type="button" class="builds-action-btn px-2.5 py-1.5 rounded bg-red-700/80 hover:bg-red-600 text-white text-xs" data-build-id="${escapeHtml(b.id)}" data-block="true"><i class="fa-solid fa-ban mr-1"></i>Block</button>`;
    const tagCell = tag
      ? `<span class="font-mono text-xs text-slate-300" title="${escapeHtml(tag)}">${escapeHtml(tagShort)}</span>`
      : `<span class="text-slate-500 text-xs">—</span>`;
    return `
      <tr>
        <td class="px-3 py-2 font-mono text-xs text-slate-100" title="${escapeHtml(b.id)}">${escapeHtml(idShort)}</td>
        <td class="px-3 py-2">${tagCell}</td>
        <td class="px-3 py-2">${statusBadge}</td>
        <td class="px-3 py-2 text-slate-400">${formatDate(b.startTime)}</td>
        <td class="px-3 py-2 text-right font-mono text-slate-200">${Number(b.claimCount) || 0}</td>
        <td class="px-3 py-2 text-right">${actionBtn}</td>
      </tr>
    `;
  }).join("");
}

async function handleBuildBlockClick(event) {
  const btn = event.target.closest(".builds-action-btn");
  if (!btn) return;
  const buildId = btn.dataset.buildId;
  const block = btn.dataset.block === "true";
  if (!buildId) return;

  const verb = block ? "Block" : "Unblock";
  if (block) {
    if (!confirm(`Block build ${buildId.substring(0, 8)}...?\n\nAny agent currently connected from this build will be disconnected, and future connection attempts with this build's tag will be rejected.`)) return;
  }

  btn.disabled = true;
  let res;
  try {
    res = await fetch(`/api/build/${encodeURIComponent(buildId)}/block`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocked: block }),
    });
  } catch {
    showBuildsMessage(`${verb} failed: network error`, "error");
    btn.disabled = false;
    return;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    showBuildsMessage(data.error || `${verb} failed`, "error");
    btn.disabled = false;
    return;
  }

  if (block && typeof data.disconnected === "number" && data.disconnected > 0) {
    showBuildsMessage(`Build blocked. Disconnected ${data.disconnected} live agent${data.disconnected === 1 ? "" : "s"}.`);
  } else {
    showBuildsMessage(`Build ${block ? "blocked" : "unblocked"}.`);
  }
  await loadBuilds();
}

// ---- Sidebar nav ---------------------------------------------------------

/**
 * Update the --settings-scroll-mt CSS variable to match whatever the top nav
 * is currently consuming at the top of the viewport. In topbar mode this is
 * the topbar's rendered height + an 8px buffer so the section title isn't
 * flush against the nav. In sidebar mode the nav doesn't obstruct the top, so
 * we use a small visual margin. Called on init and on viewport changes.
 */
function updateSettingsScrollOffset() {
  const root = document.documentElement;
  const nav = document.getElementById("top-nav");
  // Sidebar mode (left column): no top obstruction. Body gets `sb-ready` from
  // the adaptive nav layout.
  const isSidebarMode = document.body.classList.contains("sb-ready");
  // Nav hidden via Ctrl+\: also no obstruction.
  const isHidden = document.body.classList.contains("nav-hidden");

  let offsetPx = 16; // matches the old scroll-mt-4 default
  if (!isSidebarMode && !isHidden && nav) {
    const rect = nav.getBoundingClientRect();
    // Only treat as obstructing if the nav is actually pinned at the top and
    // spans most of the width. (Defensive — covers mobile/dropdown variations.)
    if (rect.top <= 0 && rect.height > 0 && rect.width >= window.innerWidth * 0.5) {
      offsetPx = Math.round(rect.height) + 8;
    }
  }
  root.style.setProperty("--settings-scroll-mt", `${offsetPx}px`);
}

function initSettingsSidebar() {
  const sidebar = document.getElementById("settings-sidebar");
  if (!sidebar) return;
  const links = Array.from(sidebar.querySelectorAll(".settings-nav-link"));

  // Build the section→link map up front so click + observer share it.
  const sectionMap = new Map();
  // sectionsInOrder preserves document order for "last visible at page bottom"
  // tie-breaking (see updateActive below).
  const sectionsInOrder = [];
  for (const link of links) {
    const id = link.dataset.target;
    const section = id ? document.getElementById(id) : null;
    if (section) {
      sectionMap.set(section, link);
      sectionsInOrder.push(section);
    }
  }
  if (sectionMap.size === 0) return;

  function setActive(link) {
    links.forEach((l) => l.classList.remove("active"));
    if (link) link.classList.add("active");
  }

  function isAtPageBottom() {
    return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
  }

  // Click → smooth scroll to section. Mark the link active immediately so the
  // bottom links (where scroll can't reach the section's top) still highlight.
  sidebar.addEventListener("click", (event) => {
    const link = event.target.closest(".settings-nav-link");
    if (!link) return;
    event.preventDefault();
    const id = link.dataset.target;
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    // Re-measure the topbar offset right before scrolling, so a layout shift
    // (nav-hidden toggle, viewport resize, dropdown opened) doesn't leave the
    // section partly hidden under the nav.
    updateSettingsScrollOffset();
    _clickLockUntil = Date.now() + 1200;
    setActive(link);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(null, "", `#${id}`);
  });

  // Active-section highlight via IntersectionObserver + page-bottom override.
  const visible = new Set();
  let _clickLockUntil = 0;
  function updateActive() {
    if (Date.now() < _clickLockUntil) return;
    // Special case: if the user has scrolled as far as the page allows, the
    // last visible section becomes active (otherwise the topmost-visible
    // heuristic would leave shorter trailing sections — like Custom CSS or
    // Export / Import — unable to ever become active because the page can't
    // scroll their headings to the top of the viewport).
    if (isAtPageBottom() && visible.size > 0) {
      let lastEl = null;
      for (const section of sectionsInOrder) {
        if (visible.has(section)) lastEl = section;
      }
      if (lastEl) {
        setActive(sectionMap.get(lastEl));
        return;
      }
    }
    // Default: topmost visible section.
    let topEl = null;
    let topY = Infinity;
    for (const el of visible) {
      const y = el.getBoundingClientRect().top;
      if (y < topY) { topY = y; topEl = el; }
    }
    if (topEl) setActive(sectionMap.get(topEl));
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      }
      updateActive();
    },
    { rootMargin: "-10% 0px -70% 0px", threshold: 0 },
  );
  for (const section of sectionMap.keys()) observer.observe(section);

  // Re-run the picker on raw scroll too, so the page-bottom override fires
  // even when no IntersectionObserver entry has changed (last sections may
  // already be inside `visible` and the rootMargin won't re-trigger).
  let scrollRaf = 0;
  window.addEventListener("scroll", () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      updateActive();
    });
  }, { passive: true });
}

const brandInputs = [
  brandProductNameInput,
  brandTabNameInput,
  brandFaviconUrlInput,
  brandFaviconFileInput,
  brandDashboardBackgroundUrlInput,
  brandDashboardBackgroundFileInput,
  brandNavNameInput,
  brandAccentColorInput,
  brandIconClassInput,
  brandNavLogoUrlInput,
  brandNavLogoFileInput,
  brandNavLogoAltInput,
  brandLoginLogoUrlInput,
  brandLoginLogoFileInput,
  brandLoginLogoAltInput,
  brandLoginTitleInput,
  brandLoginSubtitleInput,
  brandHeroImageUrlInput,
  brandHeroImageFileInput,
  brandHeroImageAltInput,
  brandFooterTextInput,
  brandSupportTextInput,
  brandSupportUrlInput,
];

function setAppearanceFormDisabled(disabled) {
  for (const input of [...brandInputs, appearanceCustomCssInput, appearanceSaveBtn]) {
    if (input) input.disabled = disabled;
  }
}

function applyBrandingForm(loginBranding = {}) {
  if (brandProductNameInput) brandProductNameInput.value = loginBranding.productName || "Overlord";
  if (brandTabNameInput) brandTabNameInput.value = loginBranding.tabName || loginBranding.productName || "Overlord";
  if (brandFaviconUrlInput) brandFaviconUrlInput.value = loginBranding.faviconUrl || "";
  if (brandDashboardBackgroundUrlInput) brandDashboardBackgroundUrlInput.value = loginBranding.dashboardBackgroundUrl || "";
  if (brandNavNameInput) brandNavNameInput.value = loginBranding.navName || loginBranding.productName || "Overlord";
  if (brandAccentColorInput) brandAccentColorInput.value = /^#[0-9a-fA-F]{6}$/.test(loginBranding.accentColor || "") ? loginBranding.accentColor : "#7a5bff";
  if (brandIconClassInput) brandIconClassInput.value = loginBranding.iconClass || "fa-solid fa-crown";
  if (brandNavLogoUrlInput) brandNavLogoUrlInput.value = loginBranding.navLogoUrl || "";
  if (brandNavLogoAltInput) brandNavLogoAltInput.value = loginBranding.navLogoAlt || "";
  if (brandLoginLogoUrlInput) brandLoginLogoUrlInput.value = loginBranding.logoUrl || "";
  if (brandLoginLogoAltInput) brandLoginLogoAltInput.value = loginBranding.logoAlt || "";
  if (brandLoginTitleInput) brandLoginTitleInput.value = loginBranding.title || "Welcome back";
  if (brandLoginSubtitleInput) brandLoginSubtitleInput.value = loginBranding.subtitle || "Sign in to your control plane";
  if (brandHeroImageUrlInput) brandHeroImageUrlInput.value = loginBranding.heroImageUrl || "";
  if (brandHeroImageAltInput) brandHeroImageAltInput.value = loginBranding.heroImageAlt || "";
  if (brandFooterTextInput) brandFooterTextInput.value = loginBranding.footerText || "";
  if (brandSupportTextInput) brandSupportTextInput.value = loginBranding.supportText || "";
  if (brandSupportUrlInput) brandSupportUrlInput.value = loginBranding.supportUrl || "";
}

function collectBrandingForm() {
  return {
    productName: String(brandProductNameInput?.value || "").trim(),
    tabName: String(brandTabNameInput?.value || "").trim(),
    faviconUrl: String(brandFaviconUrlInput?.value || "").trim(),
    dashboardBackgroundUrl: String(brandDashboardBackgroundUrlInput?.value || "").trim(),
    navName: String(brandNavNameInput?.value || "").trim(),
    accentColor: String(brandAccentColorInput?.value || "").trim(),
    iconClass: String(brandIconClassInput?.value || "").trim(),
    navLogoUrl: String(brandNavLogoUrlInput?.value || "").trim(),
    navLogoAlt: String(brandNavLogoAltInput?.value || "").trim(),
    logoUrl: String(brandLoginLogoUrlInput?.value || "").trim(),
    logoAlt: String(brandLoginLogoAltInput?.value || "").trim(),
    title: String(brandLoginTitleInput?.value || "").trim(),
    subtitle: String(brandLoginSubtitleInput?.value || "").trim(),
    heroImageUrl: String(brandHeroImageUrlInput?.value || "").trim(),
    heroImageAlt: String(brandHeroImageAltInput?.value || "").trim(),
    footerText: String(brandFooterTextInput?.value || "").trim(),
    supportText: String(brandSupportTextInput?.value || "").trim(),
    supportUrl: String(brandSupportUrlInput?.value || "").trim(),
  };
}

function setBrandingUploadName(fileInput) {
  const label = document.getElementById(`${fileInput.id}-name`);
  if (label) label.textContent = fileInput.files?.[0]?.name || "No file chosen";
}

async function uploadBrandingImage(fileInput, targetInput, kind, label) {
  const file = fileInput?.files?.[0];
  if (!file || !targetInput) return;

  if (!requireUiPermission("system:appearance", "Appearance settings permission required.")) {
    fileInput.value = "";
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    showMessage("Branding images must be 5 MB or smaller.", "error");
    fileInput.value = "";
    return;
  }

  const form = new FormData();
  form.append("kind", kind);
  form.append("file", file);

  fileInput.disabled = true;
  showMessage(`Uploading ${label}...`);
  try {
    const res = await fetch("/api/settings/appearance/image", {
      method: "POST",
      credentials: "include",
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showMessage(data.error || `Failed to upload ${label}.`, "error");
      return;
    }
    targetInput.value = data.url || "";
    showMessage(`${label} uploaded. Save Branding to apply it.`);
  } catch {
    showMessage(`Failed to upload ${label}.`, "error");
  } finally {
    fileInput.disabled = false;
    fileInput.value = "";
    setBrandingUploadName(fileInput);
  }
}

function initBrandingUploads() {
  if (brandDashboardBackgroundFileInput) {
    brandDashboardBackgroundFileInput.addEventListener("change", () => {
      setBrandingUploadName(brandDashboardBackgroundFileInput);
      uploadBrandingImage(brandDashboardBackgroundFileInput, brandDashboardBackgroundUrlInput, "dashboard-background", "Dashboard background");
    });
  }
  if (brandFaviconFileInput) {
    brandFaviconFileInput.addEventListener("change", () => {
      setBrandingUploadName(brandFaviconFileInput);
      uploadBrandingImage(brandFaviconFileInput, brandFaviconUrlInput, "tab-icon", "Browser tab icon");
    });
  }
  if (brandNavLogoFileInput) {
    brandNavLogoFileInput.addEventListener("change", () => {
      setBrandingUploadName(brandNavLogoFileInput);
      uploadBrandingImage(brandNavLogoFileInput, brandNavLogoUrlInput, "nav-logo", "Navigation logo");
    });
  }
  if (brandLoginLogoFileInput) {
    brandLoginLogoFileInput.addEventListener("change", () => {
      setBrandingUploadName(brandLoginLogoFileInput);
      uploadBrandingImage(brandLoginLogoFileInput, brandLoginLogoUrlInput, "login-logo", "Sign-in logo");
    });
  }
  if (brandHeroImageFileInput) {
    brandHeroImageFileInput.addEventListener("change", () => {
      setBrandingUploadName(brandHeroImageFileInput);
      uploadBrandingImage(brandHeroImageFileInput, brandHeroImageUrlInput, "hero-image", "Sign-in background image");
    });
  }
}

async function loadAppearanceSettings() {
  if (!currentUser) return;

  if (!userHas("system:appearance")) {
    if (appearancePermissionNote) appearancePermissionNote.classList.remove("hidden");
    setAppearanceFormDisabled(true);
    return;
  }

  if (appearancePermissionNote) appearancePermissionNote.classList.add("hidden");

  try {
    const res = await fetch("/api/settings/appearance", { credentials: "include" });
    if (!res.ok) {
      showMessage("Failed to load branding settings.", "error");
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (appearanceCustomCssInput) appearanceCustomCssInput.value = data.customCSS || "";
    applyBrandingForm(data.loginBranding || {});
    setAppearanceFormDisabled(false);
  } catch {
    showMessage("Failed to load branding settings.", "error");
  }
}

async function saveAppearanceSettings(event) {
  event.preventDefault();
  if (!requireUiPermission("system:appearance", "Appearance settings permission required.")) {
    return;
  }

  const customCSS = appearanceCustomCssInput ? appearanceCustomCssInput.value : "";
  if (customCSS.length > 51200) {
    showMessage("CSS exceeds the 50 KB size limit.", "error");
    return;
  }

  const res = await fetch("/api/settings/appearance", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ customCSS, loginBranding: collectBrandingForm() }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showMessage(data.error || "Failed to save branding.", "error");
    return;
  }

  applyBrandingForm(data.loginBranding || collectBrandingForm());
  showSettingsSuccess("Branding saved. Reload any open page to apply it everywhere.");
}

const chatSettingsSection = document.getElementById("chat-settings-section");
const chatSettingsForm = document.getElementById("chat-settings-form");
const chatRetentionDaysInput = document.getElementById("chat-retention-days");

async function loadChatSettings() {
  if (!userHas("system:chat")) return;
  if (chatSettingsSection) chatSettingsSection.classList.remove("hidden");
  try {
    const res = await fetch("/api/settings/chat", { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.chat) {
      if (chatRetentionDaysInput) chatRetentionDaysInput.value = data.chat.retentionDays ?? 30;
    }
  } catch {
    console.warn("Failed to load chat settings");
  }
}

async function loadInputArchiveSettings() {
  try {
    const res = await fetch("/api/settings/input-archive", { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    if (inputArchiveMyEnabledInput) inputArchiveMyEnabledInput.checked = !!data.myEnabled;
    const cfg = data.inputArchive || {};
    if (inputArchiveGlobalEnabledInput) inputArchiveGlobalEnabledInput.checked = !!cfg.enabled;
    if (inputArchiveRetentionDaysInput) inputArchiveRetentionDaysInput.value = cfg.retentionDays ?? 7;
    if (inputArchiveMaxFileMbInput) inputArchiveMaxFileMbInput.value = Math.max(1, Math.round((Number(cfg.maxFileBytes) || 0) / 1024 / 1024)) || 5;
    if (inputArchivePollSecondsInput) inputArchivePollSecondsInput.value = cfg.pollIntervalSeconds ?? 300;
  } catch {
    console.warn("Failed to load input archive settings");
  }
}

async function saveInputArchivePreference(event) {
  event.preventDefault();
  const res = await fetch("/api/settings/input-archive", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ myEnabled: !!inputArchiveMyEnabledInput?.checked }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showMessage(data.error || "Failed to save input archive preference.", "error");
    return;
  }
  showSettingsSuccess("Input archive preference saved.");
}

async function saveInputArchiveAdminSettings(event) {
  event.preventDefault();
  if (!requireUiPermission("system:input-archive", "Input archive settings permission required.")) {
    return;
  }

  const retentionDays = Number(inputArchiveRetentionDaysInput?.value);
  const maxFileMb = Number(inputArchiveMaxFileMbInput?.value);
  const pollIntervalSeconds = Number(inputArchivePollSecondsInput?.value);
  if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    showMessage("Archive retention must be 1-365 days.", "error");
    return;
  }
  if (!Number.isFinite(maxFileMb) || maxFileMb < 1 || maxFileMb > 50) {
    showMessage("Max file size must be 1-50 MB.", "error");
    return;
  }
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds < 0 || pollIntervalSeconds > 86400) {
    showMessage("Poll interval must be 0-86400 seconds.", "error");
    return;
  }

  const res = await fetch("/api/settings/input-archive", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      inputArchive: {
        enabled: !!inputArchiveGlobalEnabledInput?.checked,
        retentionDays,
        maxFileBytes: Math.round(maxFileMb * 1024 * 1024),
        pollIntervalSeconds: Math.round(pollIntervalSeconds),
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showMessage(data.error || "Failed to save input archive settings.", "error");
    return;
  }
  showSettingsSuccess("Input archive settings saved.");
}

async function saveChatSettings(event) {
  event.preventDefault();
  if (!requireUiPermission("system:chat", "Team chat settings permission required.")) {
    return;
  }

  const retentionDays = Number(chatRetentionDaysInput?.value);
  if (!Number.isFinite(retentionDays) || retentionDays < 0 || retentionDays > 365) {
    showMessage("Retention must be 0-365 days.", "error");
    return;
  }

  const res = await fetch("/api/settings/chat", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ retentionDays }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showMessage(data.error || "Failed to save chat settings.", "error");
    return;
  }

  showSettingsSuccess("Chat settings saved.");
}

function showExportImportMessage(text, type = "ok") {
  if (!exportImportMessage) return;
  exportImportMessage.textContent = text;
  exportImportMessage.classList.remove(
    "hidden",
    "text-emerald-200", "border-emerald-700", "bg-emerald-900/30",
    "text-rose-200", "border-rose-700", "bg-rose-900/30",
    "text-amber-200", "border-amber-700", "bg-amber-900/30",
  );

  if (type === "error") {
    exportImportMessage.classList.add("text-rose-200", "border-rose-700", "bg-rose-900/30");
  } else if (type === "warning") {
    exportImportMessage.classList.add("text-amber-200", "border-amber-700", "bg-amber-900/30");
  } else {
    exportImportMessage.classList.add("text-emerald-200", "border-emerald-700", "bg-emerald-900/30");
  }
}

async function exportSettings() {
  if (!requireUiPermission("system:export-import", "Export/import settings permission required.")) {
    return;
  }

  try {
    const res = await fetch("/api/settings/export", { credentials: "include" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showExportImportMessage(data.error || "Failed to export settings.", "error");
      return;
    }

    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
    const filename = filenameMatch ? filenameMatch[1] : "overlord-settings.json";

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showExportImportMessage("Settings exported successfully.");
  } catch (error) {
    showExportImportMessage(`Export failed: ${String(error?.message || error)}`, "error");
  }
}

async function importSettings(event) {
  if (!requireUiPermission("system:export-import", "Export/import settings permission required.")) {
    event.target.value = "";
    return;
  }

  const file = event.target.files?.[0];
  if (!file) return;

  event.target.value = "";

  if (file.size > 512 * 1024) {
    showExportImportMessage("File too large (max 512 KB).", "error");
    return;
  }

  let data;
  try {
    const text = await file.text();
    data = JSON.parse(text);
  } catch {
    showExportImportMessage("Invalid JSON file.", "error");
    return;
  }

  if (!data || typeof data !== "object") {
    showExportImportMessage("File does not contain a valid settings object.", "error");
    return;
  }

  if (!confirm("Import settings from this file? This will overwrite your current configuration.")) {
    return;
  }

  try {
    const res = await fetch("/api/settings/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(data),
    });

    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      showExportImportMessage(result.error || "Import failed.", "error");
      return;
    }

    const appliedStr = result.applied?.length ? result.applied.join(", ") : "nothing";
    const warningStr = result.warnings?.length ? " \u26A0 " + result.warnings.join(" ") : "";
    const msgType = result.warnings?.length ? "warning" : "ok";
    showExportImportMessage(`Imported: ${appliedStr}.${warningStr}`, msgType);

    await loadSecurityPolicy();
    await loadTlsSettings();
    await loadOidcSettings();
    await loadAppearanceSettings();
  } catch (error) {
    showExportImportMessage(`Import failed: ${String(error?.message || error)}`, "error");
  }
}

async function wipeOfflineClients() {
  if (!wipeOfflineMessage) return;
  if (!confirm("Remove ALL offline clients from the dashboard?\n\nThey will reappear if they reconnect later.")) return;

  wipeOfflineBtn.disabled = true;
  wipeOfflineMessage.className = "hidden text-sm rounded-lg px-3 py-2 border";

  try {
    const res = await fetch("/api/clients/offline", {
      method: "DELETE",
      credentials: "include",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      wipeOfflineMessage.textContent = data.error || "Failed to wipe offline clients.";
      wipeOfflineMessage.className = "text-sm rounded-lg px-3 py-2 border text-rose-200 border-rose-700 bg-rose-900/30";
    } else {
      const n = data.count ?? 0;
      wipeOfflineMessage.textContent = n === 0 ? "No offline clients found." : `Removed ${n} offline client${n === 1 ? "" : "s"}.`;
      wipeOfflineMessage.className = "text-sm rounded-lg px-3 py-2 border text-emerald-200 border-emerald-700 bg-emerald-900/30";
    }
  } catch {
    wipeOfflineMessage.textContent = "Request failed.";
    wipeOfflineMessage.className = "text-sm rounded-lg px-3 py-2 border text-rose-200 border-rose-700 bg-rose-900/30";
  } finally {
    wipeOfflineBtn.disabled = false;
  }
}

// ── Registration Settings ──────────────────────────────────────────────────

async function loadRegistrationSettings() {
  if (!userHas("system:registration")) return;

  try {
    const [regRes, groupsRes] = await Promise.all([
      fetch("/api/settings/registration", { credentials: "include" }),
      fetch("/api/permission-groups", { credentials: "include" }),
    ]);
    if (!regRes.ok) return;
    const data = await regRes.json();
    const reg = data.registration || {};
    const modeEl = document.getElementById("reg-mode");
    const roleEl = document.getElementById("reg-default-role");
    const maxEl = document.getElementById("reg-max-users");
    if (modeEl) modeEl.value = reg.mode || "off";
    if (roleEl) roleEl.value = reg.defaultRole || "operator";
    if (maxEl) maxEl.value = reg.maxUsersTotal ?? 0;

    const listEl = document.getElementById("reg-default-groups-list");
    if (listEl) {
      const groups = groupsRes.ok ? (await groupsRes.json()).groups || [] : [];
      const selected = new Set(reg.defaultGroupIds || []);
      listEl.innerHTML = groups.length === 0
        ? `<p class="text-slate-500 text-sm">No groups defined yet. Create one on the <a href="/users" class="text-sky-400 hover:underline">Users page</a>.</p>`
        : groups
            .map(
              (g) => `
        <label class="flex items-start gap-2 py-1 cursor-pointer hover:bg-slate-800/40 rounded px-2">
          <input type="checkbox" class="mt-1 h-4 w-4 accent-emerald-500" data-default-group="${g.id}" ${selected.has(g.id) ? "checked" : ""} />
          <div>
            <div class="text-sm font-medium text-slate-200">${g.name.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))}</div>
            <div class="text-xs text-slate-500">${g.permissions.length} permission${g.permissions.length === 1 ? "" : "s"}</div>
          </div>
        </label>`,
            )
            .join("");
    }

    updateRegSubsections(reg.mode || "off");
    if (reg.mode === "key" && userHas("users:manage")) loadRegistrationKeys();
    if (reg.mode === "approval" && userHas("users:manage")) loadPendingRegistrations();
  } catch (e) {
    console.error("Failed to load registration settings", e);
  }
}

function updateRegSubsections(mode) {
  const keySection = document.getElementById("reg-key-section");
  const pendingSection = document.getElementById("reg-pending-section");
  if (keySection) keySection.classList.toggle("hidden", mode !== "key" || !userHas("users:manage"));
  if (pendingSection) pendingSection.classList.toggle("hidden", mode !== "approval" || !userHas("users:manage"));
}

function showRegMsg(text, type) {
  const el = document.getElementById("reg-settings-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `text-sm rounded-lg px-3 py-2 border ${type === "error" ? "border-rose-800 bg-rose-900/20 text-rose-200" : "border-emerald-800 bg-emerald-900/20 text-emerald-200"}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 5000);
}

async function saveRegistrationSettings(e) {
  e.preventDefault();
  if (!requireUiPermission("system:registration", "Registration settings permission required.")) {
    return;
  }

  const mode = document.getElementById("reg-mode")?.value;
  const defaultRole = document.getElementById("reg-default-role")?.value;
  const maxUsersTotal = Number(document.getElementById("reg-max-users")?.value) || 0;
  const defaultGroupIds = Array.from(
    document.querySelectorAll("#reg-default-groups-list input[type=checkbox]:checked"),
  ).map((el) => Number(el.dataset.defaultGroup)).filter((n) => Number.isFinite(n));

  try {
    const res = await fetch("/api/settings/registration", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, defaultRole, maxUsersTotal, defaultGroupIds }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showRegMsg(data.error || "Failed to save", "error");
      return;
    }
    showSettingsSuccess("Registration settings saved.", (text) => showRegMsg(text, "success"));
    updateRegSubsections(mode);
    if (mode === "key" && userHas("users:manage")) loadRegistrationKeys();
    if (mode === "approval" && userHas("users:manage")) loadPendingRegistrations();
  } catch {
    showRegMsg("Network error.", "error");
  }
}

async function loadRegistrationKeys() {
  if (!userHas("users:manage")) return;
  const tbody = document.getElementById("reg-keys-tbody");
  if (!tbody) return;
  try {
    const res = await fetch("/api/registration/keys", { credentials: "include" });
    if (!res.ok) return;
    const data = await res.json();
    const keys = data.keys || [];
    if (keys.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="px-3 py-4 text-center text-slate-500">No keys generated yet.</td></tr>';
      return;
    }
    tbody.innerHTML = keys.map(k => {
      const status = k.used_by ? '<span class="text-amber-400">Used</span>'
        : (k.expires_at && k.expires_at < Date.now()) ? '<span class="text-slate-500">Expired</span>'
        : '<span class="text-emerald-400">Available</span>';
      const created = new Date(k.created_at).toLocaleDateString();
      const expires = k.expires_at ? new Date(k.expires_at).toLocaleDateString() : "Never";
      return `<tr class="border-b border-slate-800">
        <td class="px-3 py-2 font-mono text-xs">${escapeHtml(k.key.substring(0, 12))}...</td>
        <td class="px-3 py-2">${escapeHtml(k.label || "—")}</td>
        <td class="px-3 py-2">${status}</td>
        <td class="px-3 py-2">${created}</td>
        <td class="px-3 py-2">${expires}</td>
        <td class="px-3 py-2">${!k.used_by ? `<button data-delete-key="${k.id}" class="text-rose-400 hover:text-rose-300 text-xs"><i class="fa-solid fa-trash"></i></button>` : ""}</td>
      </tr>`;
    }).join("");
  } catch (e) {
    console.error("Failed to load keys", e);
  }
}

async function generateRegistrationKeys() {
  if (!requireUiPermission("users:manage", "User management permission required to generate registration keys.")) {
    return;
  }

  const count = Number(document.getElementById("reg-key-count")?.value) || 1;
  const label = document.getElementById("reg-key-label")?.value || undefined;
  const expiresInHours = Number(document.getElementById("reg-key-expires")?.value) || undefined;

  try {
    const res = await fetch("/api/registration/keys", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count, label, expiresInHours }),
    });
    if (!res.ok) {
      showRegMsg("Failed to generate keys", "error");
      return;
    }
    showRegMsg(`Generated ${count} key(s).`, "success");
    loadRegistrationKeys();
  } catch {
    showRegMsg("Network error.", "error");
  }
}

async function deleteRegistrationKey(keyId) {
  if (!requireUiPermission("users:manage", "User management permission required to delete registration keys.")) {
    return;
  }

  try {
    const res = await fetch(`/api/registration/keys/${keyId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) loadRegistrationKeys();
  } catch {}
}

async function loadPendingRegistrations() {
  if (!userHas("users:manage")) return;
  const tbody = document.getElementById("reg-pending-tbody");
  const emptyEl = document.getElementById("reg-pending-empty");
  if (!tbody) return;
  try {
    const res = await fetch("/api/registration/pending", { credentials: "include" });
    if (!res.ok) return;
    const data = await res.json();
    const pending = (data.pending || []).filter(p => p.status === "pending");
    if (pending.length === 0) {
      tbody.innerHTML = "";
      if (emptyEl) emptyEl.classList.remove("hidden");
      return;
    }
    if (emptyEl) emptyEl.classList.add("hidden");
    tbody.innerHTML = pending.map(p => {
      const requested = new Date(p.requested_at).toLocaleString();
      return `<tr class="border-b border-slate-800">
        <td class="px-3 py-2">${escapeHtml(p.username)}</td>
        <td class="px-3 py-2">${requested}</td>
        <td class="px-3 py-2"><span class="text-amber-400">Pending</span></td>
        <td class="px-3 py-2 space-x-2">
          <button data-approve-pending="${p.id}" class="text-emerald-400 hover:text-emerald-300 text-xs"><i class="fa-solid fa-check"></i> Approve</button>
          <button data-deny-pending="${p.id}" class="text-rose-400 hover:text-rose-300 text-xs"><i class="fa-solid fa-xmark"></i> Deny</button>
        </td>
      </tr>`;
    }).join("");
  } catch (e) {
    console.error("Failed to load pending registrations", e);
  }
}

async function handlePendingAction(id, action) {
  if (!requireUiPermission("users:manage", "User management permission required to approve registrations.")) {
    return;
  }

  try {
    const res = await fetch(`/api/registration/pending/${id}/${action}`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showRegMsg(data.error || `Failed to ${action}`, "error");
      return;
    }
    showRegMsg(`Registration ${action}d.`, "success");
    loadPendingRegistrations();
  } catch {
    showRegMsg("Network error.", "error");
  }
}

function initRegistrationHandlers() {
  const regForm = document.getElementById("registration-form");
  if (regForm) regForm.addEventListener("submit", saveRegistrationSettings);

  const modeEl = document.getElementById("reg-mode");
  if (modeEl) modeEl.addEventListener("change", () => {
    updateRegSubsections(modeEl.value);
    if (modeEl.value === "key" && userHas("users:manage")) loadRegistrationKeys();
    if (modeEl.value === "approval" && userHas("users:manage")) loadPendingRegistrations();
  });

  const genBtn = document.getElementById("reg-key-generate-btn");
  if (genBtn) genBtn.addEventListener("click", generateRegistrationKeys);

  // Delegate key delete and pending approve/deny
  document.addEventListener("click", (e) => {
    const deleteBtn = e.target.closest("[data-delete-key]");
    if (deleteBtn) {
      deleteRegistrationKey(Number(deleteBtn.dataset.deleteKey));
      return;
    }
    const approveBtn = e.target.closest("[data-approve-pending]");
    if (approveBtn) {
      handlePendingAction(Number(approveBtn.dataset.approvePending), "approve");
      return;
    }
    const denyBtn = e.target.closest("[data-deny-pending]");
    if (denyBtn) {
      handlePendingAction(Number(denyBtn.dataset.denyPending), "deny");
    }
  });
}

// ── File Transfer Limit Settings ──────────────────────────────────────────

async function loadFileTransferLimits() {
  if (!userHas("system:security")) return;
  try {
    const res = await fetch("/api/settings/file-transfers", { credentials: "include" });
    if (!res.ok) return;
    const data = await res.json();
    const limits = data.fileTransfers || {};
    const mb = 1024 * 1024;
    document.getElementById("ft-max-file-mb").value = Math.round((limits.maxFileBytes || 1024 * mb) / mb);
    document.getElementById("ft-max-staged-mb").value = Math.round((limits.maxStagedBytes || 4096 * mb) / mb);
    document.getElementById("ft-max-active-global").value = limits.maxActiveGlobal ?? 16;
    document.getElementById("ft-max-active-user").value = limits.maxActivePerUser ?? 4;
    document.getElementById("ft-intent-ttl-minutes").value = Math.round((limits.uploadIntentTtlMs || 30 * 60_000) / 60_000);
    document.getElementById("ft-pull-ttl-minutes").value = Math.round((limits.uploadPullTtlMs || 30 * 60_000) / 60_000);
  } catch (error) {
    console.error("Failed to load file transfer limits", error);
  }
}

function showFileTransferLimitsMsg(text, type) {
  const el = document.getElementById("file-transfer-limits-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `text-sm rounded-lg px-3 py-2 border ${type === "error" ? "border-rose-800 bg-rose-900/20 text-rose-200" : "border-emerald-800 bg-emerald-900/20 text-emerald-200"}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 5000);
}

async function saveFileTransferLimits(event) {
  event.preventDefault();
  if (!requireUiPermission("system:security", "Security settings permission required.")) return;
  const mb = 1024 * 1024;
  const maxFileMb = Number(document.getElementById("ft-max-file-mb")?.value);
  const maxStagedMb = Number(document.getElementById("ft-max-staged-mb")?.value);
  const maxActiveGlobal = Number(document.getElementById("ft-max-active-global")?.value);
  const maxActivePerUser = Number(document.getElementById("ft-max-active-user")?.value);
  const intentMinutes = Number(document.getElementById("ft-intent-ttl-minutes")?.value);
  const pullMinutes = Number(document.getElementById("ft-pull-ttl-minutes")?.value);
  if (![maxFileMb, maxStagedMb, maxActiveGlobal, maxActivePerUser, intentMinutes, pullMinutes].every(Number.isFinite)) {
    showFileTransferLimitsMsg("All limits must be valid numbers.", "error");
    return;
  }
  if (maxStagedMb < maxFileMb) {
    showFileTransferLimitsMsg("Total staging quota must be at least the maximum file size.", "error");
    return;
  }
  if (maxActivePerUser > maxActiveGlobal) {
    showFileTransferLimitsMsg("Per-user active transfers cannot exceed the global limit.", "error");
    return;
  }
  try {
    const res = await fetch("/api/settings/file-transfers", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maxFileBytes: Math.round(maxFileMb * mb),
        maxStagedBytes: Math.round(maxStagedMb * mb),
        maxActiveGlobal: Math.round(maxActiveGlobal),
        maxActivePerUser: Math.round(maxActivePerUser),
        uploadIntentTtlMs: Math.round(intentMinutes * 60_000),
        uploadPullTtlMs: Math.round(pullMinutes * 60_000),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showFileTransferLimitsMsg(data.error || "Failed to save transfer limits.", "error");
      return;
    }
    await loadFileTransferLimits();
    showFileTransferLimitsMsg("File transfer limits saved and active.", "success");
  } catch {
    showFileTransferLimitsMsg("Network error.", "error");
  }
}

function initFileTransferLimitHandlers() {
  document.getElementById("file-transfer-limits-form")?.addEventListener("submit", saveFileTransferLimits);
}

// ── Build Rate Limit Settings ──────────────────────────────────────────────

async function loadBuildRateLimitSettings() {
  if (!userHas("system:build-limits")) return;

  try {
    const res = await fetch("/api/settings/build-rate-limit", { credentials: "include" });
    if (!res.ok) return;
    const data = await res.json();
    const brl = data.buildRateLimit || {};
    const perHourEl = document.getElementById("brl-max-per-hour");
    const concUserEl = document.getElementById("brl-max-concurrent-user");
    const globalConcEl = document.getElementById("brl-global-concurrent");
    if (perHourEl) perHourEl.value = brl.maxBuildsPerHour ?? 5;
    if (concUserEl) concUserEl.value = brl.maxConcurrentPerUser ?? 1;
    if (globalConcEl) globalConcEl.value = brl.globalMaxConcurrent ?? 3;
  } catch (e) {
    console.error("Failed to load build rate limit settings", e);
  }
}

function showBrlMsg(text, type) {
  const el = document.getElementById("brl-settings-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `text-sm rounded-lg px-3 py-2 border ${type === "error" ? "border-rose-800 bg-rose-900/20 text-rose-200" : "border-emerald-800 bg-emerald-900/20 text-emerald-200"}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 5000);
}

async function saveBuildRateLimitSettings(e) {
  e.preventDefault();
  if (!requireUiPermission("system:build-limits", "Build rate limit settings permission required.")) {
    return;
  }

  const maxBuildsPerHour = Number(document.getElementById("brl-max-per-hour")?.value) || 5;
  const maxConcurrentPerUser = Number(document.getElementById("brl-max-concurrent-user")?.value) || 1;
  const globalMaxConcurrent = Number(document.getElementById("brl-global-concurrent")?.value) || 3;

  try {
    const res = await fetch("/api/settings/build-rate-limit", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxBuildsPerHour, maxConcurrentPerUser, globalMaxConcurrent }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showBrlMsg(data.error || "Failed to save", "error");
      return;
    }
    showSettingsSuccess("Build rate limit settings saved.", (text) => showBrlMsg(text, "success"));
  } catch {
    showBrlMsg("Network error.", "error");
  }
}

function initBuildRateLimitHandlers() {
  const brlForm = document.getElementById("build-rate-limit-form");
  if (brlForm) brlForm.addEventListener("submit", saveBuildRateLimitSettings);
}

// ── Thumbnail Settings ────────────────────────────────────────────────────

async function loadThumbnailSettings() {
  if (!userHas("system:thumbnails")) return;

  try {
    const res = await fetch("/api/settings/thumbnails", { credentials: "include" });
    if (!res.ok) return;
    const data = await res.json();
    const t = data.thumbnails || {};
    const dashEl = document.getElementById("thumb-dashboard-enabled");
    const wallEl = document.getElementById("thumb-wall-enabled");
    if (dashEl) dashEl.checked = t.dashboardEnabled !== false;
    if (wallEl) wallEl.checked = t.wallEnabled !== false;
  } catch (e) {
    console.error("Failed to load thumbnail settings", e);
  }
}

function showThumbnailsMsg(text, type) {
  const el = document.getElementById("thumbnails-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `text-sm rounded-lg px-3 py-2 border ${type === "error" ? "border-rose-800 bg-rose-900/20 text-rose-200" : "border-emerald-800 bg-emerald-900/20 text-emerald-200"}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 5000);
}

async function saveThumbnailSettings(e) {
  e.preventDefault();
  if (!requireUiPermission("system:thumbnails", "Thumbnail settings permission required.")) {
    return;
  }

  const dashboardEnabled = !!document.getElementById("thumb-dashboard-enabled")?.checked;
  const wallEnabled = !!document.getElementById("thumb-wall-enabled")?.checked;
  try {
    const res = await fetch("/api/settings/thumbnails", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dashboardEnabled, wallEnabled }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showThumbnailsMsg(data.error || "Failed to save", "error");
      return;
    }
    showSettingsSuccess("Thumbnail settings saved.", (text) => showThumbnailsMsg(text, "success"));
  } catch {
    showThumbnailsMsg("Network error.", "error");
  }
}

function initThumbnailHandlers() {
  const form = document.getElementById("thumbnails-form");
  if (form) form.addEventListener("submit", saveThumbnailSettings);
}

// ── Server Health ─────────────────────────────────────────────────────────

function formatBytes(bytes) {
  return formatSharedBytes(bytes, 1);
}

function formatUptime(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

let latestServerCpuProfile = null;

async function loadHealthStats() {
  if (!userHas("system:health")) return;

  const loading = document.getElementById("health-loading");
  const content = document.getElementById("health-content");
  if (loading) { loading.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading...'; loading.classList.remove("hidden"); }
  if (content) content.classList.add("hidden");

  try {
    const res = await fetch("/api/settings/health", { credentials: "include" });
    if (!res.ok) {
      if (loading) loading.textContent = "Failed to load health stats.";
      return;
    }
    const data = await res.json();

    const mem = data.memory || {};
    const rss = mem.rss || 0;
    const heapUsed = mem.heapUsed || 0;
    const ext = (mem.external || 0) + (mem.arrayBuffers || 0);

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    set("health-uptime", formatUptime(data.uptime || 0));
    set("health-rss", formatBytes(rss));
    set("health-heap-used", formatBytes(heapUsed));
    set("health-external", formatBytes(ext));
    const heapPct = rss > 0 ? Math.min(100, (heapUsed / rss) * 100) : 0;
    const extPct  = rss > 0 ? Math.min(100 - heapPct, (ext / rss) * 100) : 0;

    const heapBar = document.getElementById("health-heap-bar");
    const extBar  = document.getElementById("health-ext-bar");
    const heapBarLabel = document.getElementById("health-heap-bar-label");
    const barLabel = document.getElementById("health-bar-label");

    if (heapBar) {
      heapBar.style.width = `${heapPct.toFixed(1)}%`;
      heapBar.title = `Heap: ${formatBytes(heapUsed)} (${heapPct.toFixed(1)}% of RSS)`;
    }
    if (extBar) {
      extBar.style.width = `${extPct.toFixed(1)}%`;
      extBar.title = `External/Buffers: ${formatBytes(ext)} (${extPct.toFixed(1)}% of RSS)`;
    }
    if (heapBarLabel) {
      heapBarLabel.textContent = `${heapPct.toFixed(0)}%`;
      heapBarLabel.classList.toggle("hidden", heapPct < 8);
    }
    if (barLabel) {
      barLabel.textContent = rss > 0
        ? `${formatBytes(heapUsed)} heap + ${formatBytes(ext)} ext / ${formatBytes(rss)} RSS`
        : "-";
    }

    const t = data.components?.thumbnails || {};
    set("h-thumb-count", `${t.cachedCount ?? 0} / ${t.cacheMax ?? 0}`);
    set("h-thumb-bytes", formatBytes(t.cachedBytes || 0));
    set("h-thumb-frames", t.pendingFrames ?? 0);
    set("h-thumb-gen", `${t.genActive ?? 0} active, ${t.genQueued ?? 0} queued`);
    set("h-thumb-max", t.cacheMax ?? 0);

    const c = data.components?.clients || {};
    set("h-clients-mem", c.inMemory ?? 0);
    set("h-clients-online", c.online ?? 0);

    const db = data.components?.database || {};
    set("h-db-size", formatBytes(db.fileSizeBytes || 0));

    if (loading) loading.classList.add("hidden");
    if (content) content.classList.remove("hidden");
  } catch (e) {
    if (loading) loading.textContent = `Error: ${e.message}`;
  }
}

function formatMs(ms) {
  const n = Number(ms) || 0;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n)}ms`;
}

function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(n >= 10 ? 1 : 2)}%`;
}

function formatSignedBytes(value) {
  const n = Number(value) || 0;
  if (n === 0) return "0 B";
  return `${n > 0 ? "+" : "-"}${formatBytes(Math.abs(n))}`;
}

function setProfileMessage(text, type = "ok") {
  const el = document.getElementById("server-profile-message");
  if (!el) return;
  el.textContent = text;
  el.classList.remove(
    "hidden",
    "text-emerald-200",
    "border-emerald-700",
    "bg-emerald-900/30",
    "text-cyan-200",
    "border-cyan-700",
    "bg-cyan-900/30",
    "text-rose-200",
    "border-rose-700",
    "bg-rose-900/30",
  );
  if (type === "error") {
    el.classList.add("text-rose-200", "border-rose-700", "bg-rose-900/30");
  } else if (type === "busy") {
    el.classList.add("text-cyan-200", "border-cyan-700", "bg-cyan-900/30");
  } else {
    el.classList.add("text-emerald-200", "border-emerald-700", "bg-emerald-900/30");
  }
}

function renderProfileRows(tbodyId, rows, renderRow, emptyText) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="px-3 py-3 text-slate-500 text-center">${escapeHtml(emptyText)}</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(renderRow).join("");
}

function renderServerProfileResults(data) {
  const results = document.getElementById("server-profile-results");
  const downloadBtn = document.getElementById("server-profile-download-btn");
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  const cpu = data?.cpu || {};
  const summary = cpu.summary || {};
  const beforeMem = data?.memory?.before?.process || {};
  const afterMem = data?.memory?.after?.process || {};
  const rssDelta = (Number(afterMem.rss) || 0) - (Number(beforeMem.rss) || 0);

  latestServerCpuProfile = cpu.rawProfile || null;
  if (downloadBtn) downloadBtn.classList.toggle("hidden", !latestServerCpuProfile);

  set("profile-duration", formatMs(data?.durationMs || 0));
  set("profile-cpu-percent", formatPercent(cpu.processPercent));
  set("profile-samples", summary.totalSamples ?? 0);
  set("profile-rss-delta", formatSignedBytes(rssDelta));

  const totalSamples = Number(summary.totalSamples) || 0;
  renderProfileRows(
    "profile-functions-body",
    (summary.topFunctions || []).slice(0, 12),
    (fn) => {
      const pct = Number.isFinite(Number(fn.percent)) && Number(fn.percent) > 0
        ? Number(fn.percent)
        : (totalSamples > 0 ? (Number(fn.samples || 0) / totalSamples) * 100 : 0);
      return `<tr class="bg-slate-900/70">
        <td class="px-3 py-2 min-w-[15rem]">
          <div class="font-mono text-slate-100 truncate" title="${escapeHtml(fn.name || "")}">${escapeHtml(fn.name || "(anonymous)")}</div>
          <div class="font-mono text-[11px] text-slate-500 truncate" title="${escapeHtml(fn.location || "")}">${escapeHtml(fn.location || "(runtime)")}</div>
        </td>
        <td class="px-3 py-2 text-right font-mono text-cyan-300 whitespace-nowrap">${formatPercent(pct)}</td>
        <td class="px-3 py-2 text-right font-mono text-slate-300">${Number(fn.samples || 0)}</td>
      </tr>`;
    },
    "No CPU samples were captured.",
  );

  const topObjectTypes = data?.memory?.after?.jscHeap?.topObjectTypes || [];
  renderProfileRows(
    "profile-objects-body",
    topObjectTypes.slice(0, 12),
    (item) => `<tr class="bg-slate-900/70">
      <td class="px-3 py-2 font-mono text-slate-100 truncate" title="${escapeHtml(item.type || "")}">${escapeHtml(item.type || "-")}</td>
      <td class="px-3 py-2 text-right font-mono text-slate-300">${Number(item.count || 0).toLocaleString()}</td>
    </tr>`,
    "Heap object details are unavailable.",
  );

  const stacksEl = document.getElementById("profile-stacks-list");
  if (stacksEl) {
    const stacks = (summary.topStacks || []).slice(0, 5);
    stacksEl.innerHTML = stacks.length
      ? stacks.map((entry) => {
          const pct = Number.isFinite(Number(entry.percent)) && Number(entry.percent) > 0
            ? Number(entry.percent)
            : (totalSamples > 0 ? (Number(entry.samples || 0) / totalSamples) * 100 : 0);
          const stack = Array.isArray(entry.stack) ? entry.stack : [];
          return `<div class="rounded-lg bg-slate-950 border border-slate-800 px-3 py-2">
            <div class="flex items-center justify-between gap-3 text-xs">
              <span class="font-mono text-cyan-300">${formatPercent(pct)}</span>
              <span class="font-mono text-slate-500">${Number(entry.samples || 0)} samples</span>
            </div>
            <div class="mt-1 font-mono text-[11px] text-slate-300 leading-relaxed break-all">${escapeHtml(stack.join(" <- ") || "(runtime)")}</div>
          </div>`;
        }).join("")
      : '<div class="rounded-lg bg-slate-950 border border-slate-800 px-3 py-3 text-xs text-slate-500 text-center">No stack samples were captured.</div>';
  }

  if (results) results.classList.remove("hidden");
}

async function runServerProfile() {
  if (!requireUiPermission("system:profiler", "Server profiler permission required.")) {
    return;
  }

  const btn = document.getElementById("server-profile-btn");
  const durationEl = document.getElementById("server-profile-duration");
  const durationMs = Number(durationEl?.value || 5000);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>Capturing...';
  }
  setProfileMessage(`Capturing server CPU and memory for ${formatMs(durationMs)}. Keep using the server while this runs.`, "busy");

  try {
    const res = await fetch("/api/settings/profile", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ durationMs }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || res.statusText || "Profile failed");
    }
    renderServerProfileResults(data);
    const profilerError = data?.cpu?.profilerError;
    setProfileMessage(
      profilerError
        ? `Memory snapshot captured. CPU profiler was unavailable: ${profilerError}`
        : "Profile complete. Hot functions and memory object types are listed below.",
      profilerError ? "error" : "ok",
    );
  } catch (e) {
    setProfileMessage(`Profile failed: ${e.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-gauge-high"></i>Run Profile';
    }
  }
}

function downloadServerCpuProfile() {
  if (!latestServerCpuProfile) return;
  const blob = new Blob([JSON.stringify(latestServerCpuProfile, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `overlord-server-${stamp}.cpuprofile`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function runGC() {
  if (!requireUiPermission("system:health:manage", "Server health maintenance permission required.")) {
    return;
  }

  const gcBtn = document.getElementById("health-gc-btn");
  const msgEl = document.getElementById("health-gc-message");
  if (gcBtn) gcBtn.disabled = true;
  try {
    const res = await fetch("/api/settings/gc", { method: "POST", credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (msgEl) {
      msgEl.textContent = res.ok
        ? `GC complete — freed ~${formatBytes(data.freedBytes || 0)}`
        : `GC failed: ${data.error || res.statusText}`;
      msgEl.classList.remove("hidden");
      setTimeout(() => msgEl.classList.add("hidden"), 6000);
    }
    if (res.ok) await loadHealthStats();
  } catch (e) {
    if (msgEl) { msgEl.textContent = `Error: ${e.message}`; msgEl.classList.remove("hidden"); }
  } finally {
    if (gcBtn) gcBtn.disabled = false;
  }
}

function initHealthHandlers() {
  const refreshBtn = document.getElementById("health-refresh-btn");
  const gcBtn = document.getElementById("health-gc-btn");
  const profileBtn = document.getElementById("server-profile-btn");
  const downloadProfileBtn = document.getElementById("server-profile-download-btn");
  if (gcBtn && !userHas("system:health:manage")) {
    gcBtn.disabled = true;
    gcBtn.title = "Requires system:health:manage";
  }
  if (profileBtn && !userHas("system:profiler")) {
    profileBtn.disabled = true;
    profileBtn.title = "Requires system:profiler";
  }
  if (refreshBtn) refreshBtn.addEventListener("click", loadHealthStats);
  if (gcBtn) gcBtn.addEventListener("click", runGC);
  if (profileBtn) profileBtn.addEventListener("click", runServerProfile);
  if (downloadProfileBtn) downloadProfileBtn.addEventListener("click", downloadServerCpuProfile);
}

async function init() {
  try {
    await loadCurrentUser();
    applyPermissionVisibility();
    loadPrefs();
    await loadMfaStatus();

    if (userHas("clients:build")) {
      if (buildsShowAllWrap && !isAdmin(currentUser?.role)) {
        buildsShowAllWrap.classList.add("hidden");
      }
      await loadBuilds();
    }

    await loadSecurityPolicy();
    await loadTlsSettings();
    await loadAppearanceSettings();
    await loadChatSettings();
    await loadInputArchiveSettings();
    await loadBannedIps();

    if (userHas("users:manage")) {
      await renderPermissionsOverview();
    }

    if (userHas("system:registration")) {
      await loadRegistrationSettings();
      initRegistrationHandlers();
    }
    if (userHas("system:build-limits")) {
      await loadBuildRateLimitSettings();
      initBuildRateLimitHandlers();
    }
    if (userHas("system:security")) {
      await loadFileTransferLimits();
      initFileTransferLimitHandlers();
    }
    if (userHas("system:thumbnails")) {
      await loadThumbnailSettings();
      initThumbnailHandlers();
    }
    if (userHas("system:health")) {
      await loadHealthStats();
      initHealthHandlers();
    }

    passwordForm.addEventListener("submit", updatePassword);
    if (mfaStartBtn) mfaStartBtn.addEventListener("click", startMfaSetup);
    if (mfaEnableBtn) mfaEnableBtn.addEventListener("click", enableMfa);
    if (mfaDisableBtn) mfaDisableBtn.addEventListener("click", disableMfa);
    prefsForm.addEventListener("submit", savePrefs);

    const sidebarBtn = document.getElementById("pref-nav-sidebar");
    const topbarBtn = document.getElementById("pref-nav-topbar");
    if (sidebarBtn && topbarBtn) {
      sidebarBtn.addEventListener("click", () => {
        if (localStorage.getItem(NAV_MODE_KEY) === "sidebar") return;
        localStorage.setItem(NAV_MODE_KEY, "sidebar");
        window.location.reload();
      });
      topbarBtn.addEventListener("click", () => {
        if (localStorage.getItem(NAV_MODE_KEY) === "topbar") return;
        localStorage.setItem(NAV_MODE_KEY, "topbar");
        window.location.reload();
      });
    }

    securityForm.addEventListener("submit", saveSecurityPolicy);
    tlsForm.addEventListener("submit", saveTlsSettings);
    tlsCertbotAutoBtn.addEventListener("click", runCertbotAutoSetup);
    if (oidcForm) oidcForm.addEventListener("submit", saveOidcSettings);
    if (appearanceForm) appearanceForm.addEventListener("submit", saveAppearanceSettings);
    initBrandingUploads();
    if (chatSettingsForm) chatSettingsForm.addEventListener("submit", saveChatSettings);
    if (inputArchiveUserForm) inputArchiveUserForm.addEventListener("submit", saveInputArchivePreference);
    if (inputArchiveAdminForm) inputArchiveAdminForm.addEventListener("submit", saveInputArchiveAdminSettings);
    if (exportSettingsBtn) exportSettingsBtn.addEventListener("click", exportSettings);
    if (importSettingsFile) importSettingsFile.addEventListener("change", importSettings);
    refreshBansBtn.addEventListener("click", loadBannedIps);
    bansTableBody.addEventListener("click", handleUnbanClick);
    if (wipeOfflineBtn) wipeOfflineBtn.addEventListener("click", wipeOfflineClients);

    if (refreshBuildsBtn) refreshBuildsBtn.addEventListener("click", loadBuilds);
    if (buildsTableBody) buildsTableBody.addEventListener("click", handleBuildBlockClick);
    if (buildsShowAllInput) buildsShowAllInput.addEventListener("change", loadBuilds);

    initSettingsSidebar();

    // Compute the scroll offset now, then again after the nav has had a moment
    // to settle (the adaptive nav controller adjusts mode async based on
    // viewport width and content overflow), and on every resize.
    updateSettingsScrollOffset();
    setTimeout(updateSettingsScrollOffset, 0);
    setTimeout(updateSettingsScrollOffset, 200);
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(updateSettingsScrollOffset, 100);
    });

    // Honor a ?#section-id deep-link on first load so we land on that section.
    // Run AFTER the offset is set so the section lands under the topbar.
    if (window.location.hash) {
      const target = document.getElementById(window.location.hash.slice(1));
      if (target) {
        // Defer to the next frame so scroll-margin-top has been applied.
        requestAnimationFrame(() => target.scrollIntoView({ behavior: "auto", block: "start" }));
      }
    }

  } catch (error) {
    console.error("settings init failed", error);
    showMessage("Failed to load settings.", "error");
  }
}

init();
