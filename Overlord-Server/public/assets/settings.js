import {
  getNotificationsEnabled,
  setNotificationsEnabled,
  getDesktopNotificationsEnabled,
  setDesktopNotificationsEnabled,
  requestDesktopNotificationPermission,
} from "./notify-client.js";

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

const prefsForm = document.getElementById("prefs-form");
const prefNotificationsInput = document.getElementById("pref-notifications");
const prefDesktopNotificationsInput = document.getElementById("pref-desktop-notifications");
const prefDesktopNotificationsHint = document.getElementById("pref-desktop-notifications-hint");
const prefRefreshSecondsInput = document.getElementById("pref-refresh-seconds");

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

const appearanceForm = document.getElementById("appearance-form");
const appearancePermissionNote = document.getElementById("appearance-permission-note");
const appearanceSaveBtn = document.getElementById("appearance-save-btn");
const appearanceCustomCssInput = document.getElementById("appearance-custom-css");

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

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function formatDate(timestamp) {
  const ts = Number(timestamp) || 0;
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

function canManageClientBans(role) {
  return role === "admin" || role === "operator";
}

function isAdmin(role) {
  return role === "admin";
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
  updatePasswordPolicyUi();
}

async function loadSecurityPolicy() {
  if (!currentUser) return;

  if (!isAdmin(currentUser.role)) {
    securityPermissionNote.classList.remove("hidden");
    setSecurityFormDisabled(true);
    securityConfig = {
      passwordMinLength: 6,
      passwordRequireUppercase: false,
      passwordRequireLowercase: false,
      passwordRequireNumber: false,
      passwordRequireSymbol: false,
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

  if (!isAdmin(currentUser.role)) {
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
  showMessage("Password updated successfully.");
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
        showMessage("Preferences saved. Desktop notifications enabled.");
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
    showMessage("Preferences saved.");
  }

  const navHiddenInput = document.getElementById("pref-nav-hidden");
  if (navHiddenInput) {
    localStorage.setItem(NAV_HIDDEN_KEY, String(navHiddenInput.checked));
    document.body.classList.toggle("nav-hidden", navHiddenInput.checked);
  }
}

async function saveSecurityPolicy(event) {
  event.preventDefault();
  if (!isAdmin(currentUser?.role)) {
    showMessage("Admin role required.", "error");
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
  showMessage("Security policy updated.");
}

async function saveTlsSettings(event) {
  event.preventDefault();
  if (!isAdmin(currentUser?.role)) {
    showMessage("Admin role required.", "error");
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
  showMessage("TLS settings updated. Restart server to apply.");
}

async function runCertbotAutoSetup() {
  if (!isAdmin(currentUser?.role)) {
    showMessage("Admin role required.", "error");
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
    showMessage(chatId ? "Telegram chat ID saved." : "Telegram notifications disabled.");
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

  // Hide nav links and group labels whose target sections are admin-only /
  // admin-or-operator when the current user isn't authorized. We hide rather
  // than disable so the sidebar stays uncluttered for non-admins.
  const gated = sidebar.querySelectorAll("[data-admin-only], [data-admin-or-operator]");
  for (const el of gated) {
    if (el.dataset.adminOnly !== undefined && !isAdmin(currentUser?.role)) {
      el.classList.add("hidden");
    }
    if (el.dataset.adminOrOperator !== undefined && !canManageBuilds(currentUser?.role)) {
      el.classList.add("hidden");
    }
  }

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
    setActive(link);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(null, "", `#${id}`);
  });

  // Active-section highlight via IntersectionObserver + page-bottom override.
  const visible = new Set();
  function updateActive() {
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

async function loadAppearanceSettings() {
  if (!currentUser) return;

  if (!isAdmin(currentUser.role)) {
    if (appearancePermissionNote) appearancePermissionNote.classList.remove("hidden");
    if (appearanceCustomCssInput) appearanceCustomCssInput.disabled = true;
    if (appearanceSaveBtn) appearanceSaveBtn.disabled = true;
    return;
  }

  if (appearancePermissionNote) appearancePermissionNote.classList.add("hidden");

  try {
    const res = await fetch("/api/settings/appearance", { credentials: "include" });
    if (!res.ok) {
      showMessage("Failed to load custom CSS settings.", "error");
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (appearanceCustomCssInput) appearanceCustomCssInput.value = data.customCSS || "";
    if (appearanceSaveBtn) appearanceSaveBtn.disabled = false;
  } catch {
    showMessage("Failed to load custom CSS settings.", "error");
  }
}

async function saveAppearanceSettings(event) {
  event.preventDefault();
  if (!isAdmin(currentUser?.role)) {
    showMessage("Admin role required.", "error");
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
    body: JSON.stringify({ customCSS }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showMessage(data.error || "Failed to save custom CSS.", "error");
    return;
  }

  showMessage("Custom CSS saved. Reload the page to apply the new styles.");
}

const chatSettingsSection = document.getElementById("chat-settings-section");
const chatSettingsForm = document.getElementById("chat-settings-form");
const chatRetentionDaysInput = document.getElementById("chat-retention-days");

async function loadChatSettings() {
  if (!isAdmin(currentUser?.role)) return;
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

async function saveChatSettings(event) {
  event.preventDefault();
  if (!isAdmin(currentUser?.role)) {
    showMessage("Admin role required.", "error");
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

  showMessage("Chat settings saved.");
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

const sessionsTableBody = document.getElementById("sessions-table-body");
const sessionsMessage = document.getElementById("sessions-message");
const refreshSessionsBtn = document.getElementById("refresh-sessions-btn");
const removeInactiveSessionsBtn = document.getElementById("remove-inactive-sessions-btn");

function parseUserAgent(ua) {
  if (!ua) return "Unknown";
  if (ua.length > 80) return ua.substring(0, 77) + "...";
  return ua;
}

function formatRelativeTime(epochSeconds) {
  if (!epochSeconds) return "—";
  const diff = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function showSessionsMessage(text, type = "ok") {
  if (!sessionsMessage) return;
  sessionsMessage.textContent = text;
  sessionsMessage.classList.remove(
    "hidden",
    "text-emerald-200", "border-emerald-700", "bg-emerald-900/30",
    "text-rose-200", "border-rose-700", "bg-rose-900/30",
  );
  if (type === "error") {
    sessionsMessage.classList.add("text-rose-200", "border-rose-700", "bg-rose-900/30");
  } else {
    sessionsMessage.classList.add("text-emerald-200", "border-emerald-700", "bg-emerald-900/30");
  }
  setTimeout(() => sessionsMessage.classList.add("hidden"), 5000);
}

async function loadSessions() {
  if (!sessionsTableBody) return;

  try {
    const res = await fetch("/api/sessions", { credentials: "include" });
    if (!res.ok) {
      sessionsTableBody.innerHTML = `
        <tr>
          <td colspan="6" class="px-3 py-6 text-center text-rose-300">Failed to load sessions</td>
        </tr>
      `;
      return;
    }

    const data = await res.json();
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];

    if (sessions.length === 0) {
      sessionsTableBody.innerHTML = `
        <tr>
          <td colspan="6" class="px-3 py-6 text-center text-slate-400">No sessions found</td>
        </tr>
      `;
      return;
    }

    sessionsTableBody.innerHTML = sessions
      .map((s) => {
        const isExpired = s.expiresAt && s.expiresAt < Math.floor(Date.now() / 1000);
        const statusLabel = s.revoked
          ? '<span class="text-rose-400">Revoked</span>'
          : isExpired
            ? '<span class="text-slate-500">Expired</span>'
            : '<span class="text-emerald-400">Active</span>';
        const currentBadge = s.current
          ? ' <span class="ml-1 px-1.5 py-0.5 text-[10px] rounded bg-sky-600/30 text-sky-300 border border-sky-500/30">Current</span>'
          : "";
        const canRevoke = !s.revoked && !isExpired;

        return `
        <tr>
          <td class="px-3 py-2 font-mono text-xs text-slate-100">${escapeHtml(s.ip || "—")}</td>
          <td class="px-3 py-2 text-slate-300 text-xs max-w-[200px] truncate" title="${escapeHtml(s.userAgent || "")}">${escapeHtml(parseUserAgent(s.userAgent))}</td>
          <td class="px-3 py-2 text-slate-400 text-xs">${formatDate(s.createdAt * 1000)}</td>
          <td class="px-3 py-2 text-slate-400 text-xs">${formatRelativeTime(s.lastActivity)}</td>
          <td class="px-3 py-2 text-xs">${statusLabel}${currentBadge}</td>
          <td class="px-3 py-2 text-right">
            ${canRevoke ? `
              <button
                type="button"
                class="revoke-session-btn px-2.5 py-1.5 rounded bg-red-700/80 hover:bg-red-600 text-white text-xs"
                data-session-id="${escapeHtml(s.id)}"
                ${s.current ? 'data-is-current="true"' : ""}
              >
                <i class="fa-solid fa-right-from-bracket mr-1"></i>Revoke
              </button>
            ` : ""}
          </td>
        </tr>
      `;
      })
      .join("");
  } catch (err) {
    sessionsTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="px-3 py-6 text-center text-rose-300">Error loading sessions</td>
      </tr>
    `;
  }
}

async function handleRevokeSessionClick(event) {
  const button = event.target.closest(".revoke-session-btn");
  if (!button) return;

  const sessionId = button.dataset.sessionId;
  const isCurrent = button.dataset.isCurrent === "true";

  if (isCurrent) {
    if (!confirm("This will revoke your current session and log you out. Continue?")) return;
  }

  button.disabled = true;

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      credentials: "include",
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showSessionsMessage(data.error || "Failed to revoke session", "error");
      button.disabled = false;
      return;
    }

    if (isCurrent) {
      window.location.href = "/";
      return;
    }

    showSessionsMessage("Session revoked successfully");
    await loadSessions();
  } catch {
    showSessionsMessage("Request failed", "error");
    button.disabled = false;
  }
}

async function handleRemoveInactiveSessions() {
  if (!confirm("Remove all expired and revoked sessions?")) return;

  if (removeInactiveSessionsBtn) removeInactiveSessionsBtn.disabled = true;

  try {
    const res = await fetch("/api/sessions/inactive", {
      method: "DELETE",
      credentials: "include",
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showSessionsMessage(data.error || "Failed to remove inactive sessions", "error");
      return;
    }

    showSessionsMessage(`Removed ${data.removed || 0} inactive session(s)`);
    await loadSessions();
  } catch {
    showSessionsMessage("Request failed", "error");
  } finally {
    if (removeInactiveSessionsBtn) removeInactiveSessionsBtn.disabled = false;
  }
}

// ── Registration Settings ──────────────────────────────────────────────────

async function loadRegistrationSettings() {
  try {
    const res = await fetch("/api/settings/registration", { credentials: "include" });
    if (!res.ok) return;
    const data = await res.json();
    const reg = data.registration || {};
    const modeEl = document.getElementById("reg-mode");
    const roleEl = document.getElementById("reg-default-role");
    const maxEl = document.getElementById("reg-max-users");
    if (modeEl) modeEl.value = reg.mode || "off";
    if (roleEl) roleEl.value = reg.defaultRole || "operator";
    if (maxEl) maxEl.value = reg.maxUsersTotal ?? 0;
    updateRegSubsections(reg.mode || "off");
    if (reg.mode === "key") loadRegistrationKeys();
    if (reg.mode === "approval") loadPendingRegistrations();
  } catch (e) {
    console.error("Failed to load registration settings", e);
  }
}

function updateRegSubsections(mode) {
  const keySection = document.getElementById("reg-key-section");
  const pendingSection = document.getElementById("reg-pending-section");
  if (keySection) keySection.classList.toggle("hidden", mode !== "key");
  if (pendingSection) pendingSection.classList.toggle("hidden", mode !== "approval");
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
  const mode = document.getElementById("reg-mode")?.value;
  const defaultRole = document.getElementById("reg-default-role")?.value;
  const maxUsersTotal = Number(document.getElementById("reg-max-users")?.value) || 0;

  try {
    const res = await fetch("/api/settings/registration", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, defaultRole, maxUsersTotal }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showRegMsg(data.error || "Failed to save", "error");
      return;
    }
    showRegMsg("Registration settings saved.", "success");
    updateRegSubsections(mode);
    if (mode === "key") loadRegistrationKeys();
    if (mode === "approval") loadPendingRegistrations();
  } catch {
    showRegMsg("Network error.", "error");
  }
}

async function loadRegistrationKeys() {
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
  try {
    const res = await fetch(`/api/registration/keys/${keyId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) loadRegistrationKeys();
  } catch {}
}

async function loadPendingRegistrations() {
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
    if (modeEl.value === "key") loadRegistrationKeys();
    if (modeEl.value === "approval") loadPendingRegistrations();
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

// ── Build Rate Limit Settings ──────────────────────────────────────────────

async function loadBuildRateLimitSettings() {
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
    showBrlMsg("Build rate limit settings saved.", "success");
  } catch {
    showBrlMsg("Network error.", "error");
  }
}

function initBuildRateLimitHandlers() {
  const brlForm = document.getElementById("build-rate-limit-form");
  if (brlForm) brlForm.addEventListener("submit", saveBuildRateLimitSettings);
}

async function init() {
  try {
    await loadCurrentUser();
    loadPrefs();

    if (isAdmin(currentUser?.role) && exportImportSection) {
      exportImportSection.classList.remove("hidden");
    }

    if (canManageClientBans(currentUser?.role) && wipeOfflineSection) {
      wipeOfflineSection.classList.remove("hidden");
    }

    if (canManageBuilds(currentUser?.role)) {
      if (buildsSection) buildsSection.classList.remove("hidden");
      // Hide the "show all" toggle for non-admins
      if (buildsShowAllWrap && !isAdmin(currentUser?.role)) {
        buildsShowAllWrap.classList.add("hidden");
      }
      await loadBuilds();
    }

    await loadSecurityPolicy();
    await loadTlsSettings();
    await loadAppearanceSettings();
    await loadChatSettings();
    await loadBannedIps();

    // Registration + Build Rate Limit (admin only)
    if (isAdmin(currentUser?.role)) {
      const regSection = document.getElementById("registration-section");
      const brlSection = document.getElementById("build-rate-limit-section");
      if (regSection) regSection.classList.remove("hidden");
      if (brlSection) brlSection.classList.remove("hidden");
      await loadRegistrationSettings();
      await loadBuildRateLimitSettings();
      initRegistrationHandlers();
      initBuildRateLimitHandlers();
    }

    passwordForm.addEventListener("submit", updatePassword);
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
    if (appearanceForm) appearanceForm.addEventListener("submit", saveAppearanceSettings);
    if (chatSettingsForm) chatSettingsForm.addEventListener("submit", saveChatSettings);
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

    await loadSessions();
    if (refreshSessionsBtn) refreshSessionsBtn.addEventListener("click", loadSessions);
    if (removeInactiveSessionsBtn) removeInactiveSessionsBtn.addEventListener("click", handleRemoveInactiveSessions);
    if (sessionsTableBody) sessionsTableBody.addEventListener("click", handleRevokeSessionClick);
  } catch (error) {
    console.error("settings init failed", error);
    showMessage("Failed to load settings.", "error");
  }
}

init();
