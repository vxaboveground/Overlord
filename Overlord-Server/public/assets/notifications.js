import {
  startNotificationClient,
  subscribeNotifications,
  subscribeClientEvents,
  subscribeReady,
  subscribeStatus,
  markAllNotificationsRead,
  getClientEventNotificationEnabled,
  setClientEventNotificationEnabled,
  requestDesktopNotificationPermission,
  setDesktopNotificationsEnabled,
} from "./notify-client.js";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const wsStatus = document.getElementById("ws-status");
const listEl = document.getElementById("notification-list");
const emptyState = document.getElementById("empty-state");
const notificationScopeHint = document.getElementById("notification-scope-hint");

// Keyword section
const keywordSection = document.getElementById("keyword-section");
const keywordInput = document.getElementById("keyword-input");
const clipboardEnabledInput = document.getElementById("clipboard-enabled");
const saveKeywordsBtn = document.getElementById("save-keywords");
const keywordHint = document.getElementById("keyword-hint");

// Webhook section
const webhookEnabledInput = document.getElementById("webhook-enabled");
const webhookUrlInput = document.getElementById("webhook-url");
const webhookTemplateInput = document.getElementById("webhook-template");
const saveWebhookBtn = document.getElementById("save-webhook");
const webhookUrlToggle = document.getElementById("webhook-url-toggle");
const resetWebhookTemplateBtn = document.getElementById("reset-webhook-template");
const formatWebhookTemplateBtn = document.getElementById("format-webhook-template");
const previewWebhookTemplateBtn = document.getElementById("preview-webhook-template");
const webhookTemplatePreview = document.getElementById("webhook-template-preview");

// Telegram section
const telegramEnabledInput = document.getElementById("telegram-enabled");
const telegramBotTokenInput = document.getElementById("telegram-bot-token");
const telegramChatIdInput = document.getElementById("telegram-chat-id");
const telegramTemplateInput = document.getElementById("telegram-template");
const saveTelegramBtn = document.getElementById("save-telegram");
const telegramTokenToggle = document.getElementById("telegram-token-toggle");
const telegramChatidToggle = document.getElementById("telegram-chatid-toggle");
const resetTelegramTemplateBtn = document.getElementById("reset-telegram-template");
const previewTelegramTemplateBtn = document.getElementById("preview-telegram-template");
const telegramTemplatePreview = document.getElementById("telegram-template-preview");

const eventNotifOnlineInput = document.getElementById("event-notif-online");
const eventNotifOfflineInput = document.getElementById("event-notif-offline");
const eventNotifPurgatoryInput = document.getElementById("event-notif-purgatory");
const saveEventNotifsBtn = document.getElementById("save-event-notifs");

// Browser permission status bar
const desktopNotifStatusBar = document.getElementById("desktop-notif-status-bar");
const desktopNotifStatusIcon = document.getElementById("desktop-notif-status-icon");
const desktopNotifStatusText = document.getElementById("desktop-notif-status-text");
const desktopNotifEnableBtn = document.getElementById("desktop-notif-enable-btn");
const desktopNotifDeniedHint = document.getElementById("desktop-notif-denied-hint");

// Preview modal
const panel = document.getElementById("notification-panel");
const previewModal = document.getElementById("notification-preview-modal");
const previewModalImg = document.getElementById("notification-preview-image");
const previewModalClose = document.getElementById("notification-preview-close");

const MAX_ROWS = 200;

// Defaults loaded from /api/notifications/my-settings
let defaultWebhookTemplate = "";
let defaultTelegramTemplate = "";
let webhookTemplateEditor = null;

function tryFormatJsonText(text) {
  const source = String(text || "").trim();
  if (!source) return "";
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return null;
  }
}

function initWebhookTemplateEditor() {
  if (!webhookTemplateInput || typeof window.ace === "undefined") return;
  try {
    webhookTemplateEditor = window.ace.edit("webhook-template");
    webhookTemplateEditor.setTheme("ace/theme/tomorrow_night");
    webhookTemplateEditor.session.setMode("ace/mode/json");
    webhookTemplateEditor.session.setUseWrapMode(true);
    webhookTemplateEditor.setShowPrintMargin(false);
    webhookTemplateEditor.setOption("fontSize", "12px");
    webhookTemplateEditor.setOption("tabSize", 2);
    webhookTemplateEditor.setOption("useSoftTabs", true);
    webhookTemplateEditor.on("blur", () => {
      const formatted = tryFormatJsonText(webhookTemplateEditor.getValue());
      if (formatted !== null && formatted !== webhookTemplateEditor.getValue()) {
        const position = webhookTemplateEditor.getCursorPosition();
        webhookTemplateEditor.setValue(formatted, -1);
        webhookTemplateEditor.moveCursorToPosition(position);
      }
    });
  } catch {
    webhookTemplateEditor = null;
  }
}

function getWebhookTemplateValue() {
  if (webhookTemplateEditor) return webhookTemplateEditor.getValue();
  return webhookTemplateInput?.value || "";
}

function setWebhookTemplateValue(text) {
  const value = text || "";
  const formatted = tryFormatJsonText(value);
  const nextValue = formatted ?? value;
  if (webhookTemplateEditor) {
    webhookTemplateEditor.setValue(nextValue, -1);
    return;
  }
  if (webhookTemplateInput) webhookTemplateInput.value = nextValue;
}

function focusWebhookTemplateEditor() {
  if (webhookTemplateEditor) webhookTemplateEditor.focus();
}

// ── Sample data for template previews ────────────────────────────────────────
const SAMPLE_RECORD = {
  title: "Online Banking — Secure Login",
  keyword: "bank",
  clientId: "abc123def456",
  user: "john.doe",
  host: "DESKTOP-7G2ABK1",
  process: "chrome.exe",
  os: "windows",
  pid: "4392",
  ts: String(Date.now()),
};

function renderSampleTemplate(template, defaultTpl) {
  const tpl = template && template.trim() ? template : defaultTpl;
  return Object.entries(SAMPLE_RECORD).reduce(
    (s, [k, v]) => s.replaceAll(`{${k}}`, v),
    tpl,
  );
}

// ── Status indicator ──────────────────────────────────────────────────────────
function setStatus(text, tone = "neutral") {
  if (!wsStatus) return;
  const icon = wsStatus.querySelector("i");
  const label = wsStatus.querySelector("span");
  if (label) label.textContent = text;
  if (icon) {
    icon.className = "fa-solid fa-circle-dot";
    icon.classList.remove("text-green-400", "text-red-400", "text-yellow-400", "text-slate-400");
    if (tone === "ok") icon.classList.add("text-green-400");
    else if (tone === "error") icon.classList.add("text-red-400");
    else if (tone === "warn") icon.classList.add("text-yellow-400");
    else icon.classList.add("text-slate-400");
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatTime(ts) {
  if (ts == null) return "-";
  let normalized = typeof ts === "bigint" ? Number(ts) : Number(ts);
  if (!Number.isFinite(normalized)) return "-";
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function wireToggle(inputEl, btnEl) {
  if (!inputEl || !btnEl) return;
  btnEl.addEventListener("click", () => {
    const show = inputEl.type === "password";
    inputEl.type = show ? "text" : "password";
    const icon = btnEl.querySelector("i");
    if (icon) {
      icon.className = show ? "fa-solid fa-eye-slash" : "fa-solid fa-eye";
    }
  });
}

// ── Notification table row ────────────────────────────────────────────────────
function renderRow(item, prepend = true) {
  if (!listEl) return;
  const isClipboard = item.category === "clipboard";
  const sourceBadge = isClipboard
    ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-violet-900/60 text-violet-300 border border-violet-700/50"><i class="fa-solid fa-clipboard text-xs"></i> clipboard</span>`
    : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-900/60 text-blue-300 border border-blue-700/50"><i class="fa-solid fa-desktop text-xs"></i> window</span>`;
  const row = document.createElement("tr");
  row.className = "border-t border-slate-800/60";
  row.innerHTML = `
    <td class="py-2 pr-4 whitespace-nowrap text-slate-400">${formatTime(item.ts)}</td>
    <td class="py-2 pr-4 whitespace-nowrap">${escapeHtml(item.clientId || "-")}</td>
    <td class="py-2 pr-4 whitespace-nowrap">${escapeHtml(item.user || "-")}</td>
    <td class="py-2 pr-4 max-w-xl truncate" title="${escapeHtml(item.title || "")}">${escapeHtml(item.title || "-")}</td>
    <td class="py-2 pr-4 whitespace-nowrap">${escapeHtml(item.process || "-")}</td>
    <td class="py-2 pr-4 whitespace-nowrap">${escapeHtml(item.keyword || "-")}</td>
    <td class="py-2 pr-4 whitespace-nowrap">${sourceBadge}</td>
    <td class="py-2 pr-4"><div class="preview-slot"></div></td>
  `;

  const preview = row.querySelector(".preview-slot");
  if (preview) {
    const notificationId = item?.id || "";
    if (!notificationId) {
      preview.textContent = "-";
      preview.className = "text-slate-500";
    } else {
      preview.textContent = "Loading...";
      preview.className = "text-slate-500";
      const img = document.createElement("img");
      img.className = "max-h-32 w-auto rounded border border-slate-800/80 cursor-zoom-in";
      img.loading = "lazy";
      img.alt = "Notification screenshot";

      let attempts = 0;
      const maxAttempts = 5;
      const fetchPreview = async () => {
        attempts += 1;
        try {
          const url = `/api/notifications/${encodeURIComponent(notificationId)}/screenshot?ts=${Date.now()}`;
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) {
            if (res.status === 404 && attempts < maxAttempts) {
              setTimeout(fetchPreview, 1000 * attempts);
              return;
            }
            preview.textContent = "-";
            preview.className = "text-slate-500";
            return;
          }
          const blob = await res.blob();
          const objectUrl = URL.createObjectURL(blob);
          img.classList.add("opacity-0");
          preview.innerHTML = "";
          preview.className = "";
          preview.appendChild(img);
          img.addEventListener("load", () => img.classList.remove("opacity-0"));
          img.addEventListener("error", () => {
            preview.textContent = "-";
            preview.className = "text-slate-500";
            URL.revokeObjectURL(objectUrl);
          });
          img.src = objectUrl;
          img.dataset.previewUrl = objectUrl;
          if (img.decode) img.decode().catch(() => {});
          img.addEventListener("click", () => {
            if (!previewModal || !previewModalImg) return;
            previewModalImg.src = img.dataset.previewUrl || objectUrl;
            previewModal.classList.remove("hidden");
            previewModal.classList.add("flex");
          });
        } catch {
          if (attempts < maxAttempts) {
            setTimeout(fetchPreview, 1000 * attempts);
            return;
          }
          preview.textContent = "-";
          preview.className = "text-slate-500";
        }
      };
      fetchPreview();
    }
  }

  if (prepend) {
    listEl.prepend(row);
  } else {
    listEl.appendChild(row);
  }

  const rows = listEl.querySelectorAll("tr");
  if (rows.length > MAX_ROWS) rows[rows.length - 1].remove();

  if (emptyState) emptyState.classList.toggle("hidden", listEl.children.length > 0);
}

// ── Keyword section ───────────────────────────────────────────────────────────
function parseKeywords(text) {
  return text.split(/\r?\n/).map((k) => k.trim()).filter(Boolean);
}

function renderKeywordHint(count) {
  if (!keywordHint) return;
  keywordHint.textContent = `${count} keyword${count === 1 ? "" : "s"}`;
}

async function loadKeywords() {
  if (!keywordInput) return;
  try {
    const res = await fetch("/api/notifications/config");
    if (!res.ok) return;
    const data = await res.json();
    const keywords = data?.notifications?.keywords || [];
    keywordInput.value = keywords.join("\n");
    renderKeywordHint(keywords.length);
    if (clipboardEnabledInput) {
      clipboardEnabledInput.checked = data?.notifications?.clipboardEnabled === true;
    }
  } catch {}
}

function wireKeywordSave() {
  if (!saveKeywordsBtn || !keywordInput) return;
  saveKeywordsBtn.addEventListener("click", async () => {
    const keywords = parseKeywords(keywordInput.value);
    const clipboardEnabled = clipboardEnabledInput ? clipboardEnabledInput.checked : false;
    try {
      const res = await fetch("/api/notifications/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords, clipboardEnabled }),
      });
      if (!res.ok) {
        window.showToast?.("Failed to save keywords", "error", 4000);
        return;
      }
      const data = await res.json();
      const updated = data?.notifications?.keywords || keywords;
      keywordInput.value = updated.join("\n");
      renderKeywordHint(updated.length);
      if (clipboardEnabledInput && typeof data?.notifications?.clipboardEnabled === "boolean") {
        clipboardEnabledInput.checked = data.notifications.clipboardEnabled;
      }
      window.showToast?.("Keywords updated", "success", 3000);
    } catch {
      window.showToast?.("Failed to save keywords", "error", 4000);
    }
  });

  keywordInput.addEventListener("input", () => {
    renderKeywordHint(parseKeywords(keywordInput.value).length);
  });
}

// ── Per-user settings ─────────────────────────────────────────────────────────
function applyMySettings(settings) {
  if (webhookEnabledInput) webhookEnabledInput.checked = !!settings.webhook_enabled;
  if (webhookUrlInput) webhookUrlInput.value = settings.webhook_url || "";
  setWebhookTemplateValue(settings.webhook_template || "");
  if (telegramEnabledInput) telegramEnabledInput.checked = !!settings.telegram_enabled;
  if (telegramBotTokenInput) telegramBotTokenInput.value = settings.telegram_bot_token || "";
  if (telegramChatIdInput) telegramChatIdInput.value = settings.telegram_chat_id || "";
  if (telegramTemplateInput) telegramTemplateInput.value = settings.telegram_template || "";
}

async function loadMySettings() {
  try {
    const res = await fetch("/api/notifications/my-settings");
    if (!res.ok) return;
    const data = await res.json();
    if (data.defaults) {
      defaultWebhookTemplate = data.defaults.webhookTemplate || "";
      defaultTelegramTemplate = data.defaults.telegramTemplate || "";
      if (telegramTemplateInput) telegramTemplateInput.placeholder = `Premade template:\n${defaultTelegramTemplate}`;
    }
    if (data.settings) {
      applyMySettings(data.settings);
      if (!getWebhookTemplateValue().trim()) {
        setWebhookTemplateValue(defaultWebhookTemplate);
      }
      if (telegramTemplateInput && !telegramTemplateInput.value.trim()) {
        telegramTemplateInput.value = defaultTelegramTemplate;
      }
    }
  } catch {}
}

async function saveMySettings(patch) {
  const res = await fetch("/api/notifications/my-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || "Failed to save settings");
  }
  const data = await res.json();
  if (data.settings) applyMySettings(data.settings);
}

async function postWebhookPreview(webhookUrl, webhookTemplate) {
  const res = await fetch("/api/notifications/my-settings/preview/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ webhookUrl, webhookTemplate }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || "Failed to send preview webhook");
  }
  if (!data?.ok) {
    const details = data?.responseBody ? `: ${String(data.responseBody).slice(0, 120)}` : "";
    throw new Error(`Webhook responded with ${data?.status || "unknown status"}${details}`);
  }
  return data;
}

function wireWebhookSave() {
  wireToggle(webhookUrlInput, webhookUrlToggle);

  if (resetWebhookTemplateBtn) {
    resetWebhookTemplateBtn.addEventListener("click", () => {
      setWebhookTemplateValue(defaultWebhookTemplate);
      focusWebhookTemplateEditor();
      if (webhookTemplatePreview) {
        webhookTemplatePreview.textContent = renderSampleTemplate(defaultWebhookTemplate, defaultWebhookTemplate);
        webhookTemplatePreview.classList.remove("hidden");
      }
    });
  }

  if (formatWebhookTemplateBtn) {
    formatWebhookTemplateBtn.addEventListener("click", () => {
      const current = getWebhookTemplateValue().trim();
      if (!current) {
        setWebhookTemplateValue(defaultWebhookTemplate);
        return;
      }
      const formatted = tryFormatJsonText(current);
      if (formatted !== null) {
        setWebhookTemplateValue(formatted);
      } else {
        window.showToast?.("Template JSON is invalid. Fix syntax before formatting.", "error", 3500);
      }
    });
  }

  if (previewWebhookTemplateBtn && webhookTemplatePreview && webhookTemplateInput) {
    previewWebhookTemplateBtn.addEventListener("click", async () => {
      const webhookTemplateText = getWebhookTemplateValue();
      const rendered = renderSampleTemplate(webhookTemplateText, defaultWebhookTemplate);
      webhookTemplatePreview.textContent = rendered;
      webhookTemplatePreview.classList.remove("hidden");

      const webhookUrl = webhookUrlInput?.value?.trim() || "";
      const webhookTemplate = webhookTemplateText.trim() || defaultWebhookTemplate;
      if (!webhookUrl) {
        window.showToast?.("Enter a webhook URL first", "error", 3500);
        return;
      }

      try {
        const result = await postWebhookPreview(webhookUrl, webhookTemplate);
        const modeHint = result.mode === "discord" ? " (Discord mode)" : "";
        window.showToast?.(`Preview sent to webhook (HTTP ${result.status})${modeHint}`, "success", 3500);
      } catch (err) {
        window.showToast?.(err?.message || "Failed to send preview webhook", "error", 4000);
      }
    });
  }

  if (!saveWebhookBtn) return;
  saveWebhookBtn.addEventListener("click", async () => {
    try {
      const templateText = getWebhookTemplateValue().trim() || defaultWebhookTemplate;
      await saveMySettings({
        webhook_enabled: webhookEnabledInput?.checked ?? false,
        webhook_url: webhookUrlInput?.value?.trim() || "",
        webhook_template: templateText,
      });
      window.showToast?.("Webhook settings saved", "success", 3000);
    } catch (err) {
      window.showToast?.(err?.message || "Failed to save webhook", "error", 4000);
    }
  });
}

function wireTelegramSave() {
  wireToggle(telegramBotTokenInput, telegramTokenToggle);
  wireToggle(telegramChatIdInput, telegramChatidToggle);

  if (resetTelegramTemplateBtn) {
    resetTelegramTemplateBtn.addEventListener("click", () => {
      if (telegramTemplateInput) telegramTemplateInput.value = defaultTelegramTemplate;
      if (telegramTemplatePreview) {
        telegramTemplatePreview.textContent = renderSampleTemplate(defaultTelegramTemplate, defaultTelegramTemplate);
        telegramTemplatePreview.classList.remove("hidden");
      }
    });
  }

  if (previewTelegramTemplateBtn && telegramTemplatePreview && telegramTemplateInput) {
    previewTelegramTemplateBtn.addEventListener("click", () => {
      const rendered = renderSampleTemplate(telegramTemplateInput.value, defaultTelegramTemplate);
      telegramTemplatePreview.textContent = rendered;
      telegramTemplatePreview.classList.remove("hidden");
    });
  }

  if (!saveTelegramBtn) return;
  saveTelegramBtn.addEventListener("click", async () => {
    try {
      const templateText = telegramTemplateInput?.value?.trim() || defaultTelegramTemplate;
      await saveMySettings({
        telegram_enabled: telegramEnabledInput?.checked ?? false,
        telegram_bot_token: telegramBotTokenInput?.value?.trim() || "",
        telegram_chat_id: telegramChatIdInput?.value?.trim() || "",
        telegram_template: templateText,
      });
      window.showToast?.("Telegram settings saved", "success", 3000);
    } catch (err) {
      window.showToast?.(err?.message || "Failed to save Telegram settings", "error", 4000);
    }
  });
}

// ── Init role-based UI ────────────────────────────────────────────────────────
async function initRoleUi() {
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) return;
    const data = await res.json();
    const role = data?.role || "";
    if ((role === "admin" || role === "operator") && keywordSection) {
      keywordSection.classList.remove("hidden");
      loadKeywords();
    }
    if (notificationScopeHint) {
      notificationScopeHint.textContent =
        role === "admin"
          ? "Showing all notifications (admin)."
          : "Showing notifications for your accessible clients.";
    }
  } catch {}
}

// ── WebSocket connection ──────────────────────────────────────────────────────
function connect() {
  startNotificationClient();
  if (panel) markAllNotificationsRead();

  subscribeStatus((status) => {
    if (status === "connected") setStatus("Connected", "ok");
    if (status === "error") setStatus("Error", "error");
    if (status === "disconnected") setStatus("Disconnected", "warn");
  });

  subscribeReady((history) => {
    if (listEl) listEl.innerHTML = "";
    history.reverse().forEach((item) => renderRow(item, false));
    if (emptyState) emptyState.classList.toggle("hidden", history.length > 0);
    markAllNotificationsRead();
  });

  subscribeNotifications((item) => renderRow(item, true));
  subscribeClientEvents((item) => renderClientEventRow(item));
}

const CLIENT_EVENT_BADGE = {
  client_online: `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-emerald-900/60 text-emerald-300 border border-emerald-700/50"><i class="fa-solid fa-circle text-xs"></i> online</span>`,
  client_offline: `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-rose-900/60 text-rose-300 border border-rose-700/50"><i class="fa-solid fa-circle text-xs"></i> offline</span>`,
  client_purgatory: `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-900/60 text-amber-300 border border-amber-700/50"><i class="fa-solid fa-hourglass-half text-xs"></i> purgatory</span>`,
};

function renderClientEventRow(item) {
  if (!listEl) return;
  const badge = CLIENT_EVENT_BADGE[item.event] ||
    `<span class="text-xs text-slate-400">${escapeHtml(item.event)}</span>`;
  const row = document.createElement("tr");
  row.className = "border-t border-slate-800/60";
  row.innerHTML = `
    <td class="py-2 pr-4 whitespace-nowrap text-slate-400">${formatTime(item.ts)}</td>
    <td class="py-2 pr-4 whitespace-nowrap">${escapeHtml(item.clientId || "-")}</td>
    <td class="py-2 pr-4 whitespace-nowrap">${escapeHtml(item.user || "-")}</td>
    <td class="py-2 pr-4 max-w-xl truncate italic text-slate-400">client event</td>
    <td class="py-2 pr-4 whitespace-nowrap">${escapeHtml(item.os || "-")}</td>
    <td class="py-2 pr-4 whitespace-nowrap">-</td>
    <td class="py-2 pr-4 whitespace-nowrap">${badge}</td>
    <td class="py-2 pr-4"></td>
  `;
  listEl.prepend(row);
  const rows = listEl.querySelectorAll("tr");
  if (rows.length > MAX_ROWS) rows[rows.length - 1].remove();
  if (emptyState) emptyState.classList.add("hidden");
}

// ── Preview modal ─────────────────────────────────────────────────────────────
if (previewModal && previewModalClose && previewModalImg) {
  const closePreview = () => {
    previewModal.classList.add("hidden");
    previewModal.classList.remove("flex");
    previewModalImg.src = "";
  };
  previewModalClose.addEventListener("click", closePreview);
  previewModal.addEventListener("click", (event) => {
    if (event.target === previewModal) closePreview();
  });
}

// ── Clear unread badge when tab is visible ────────────────────────────────────
const clearIfActive = () => {
  if (document.visibilityState === "visible") markAllNotificationsRead();
};
document.addEventListener("visibilitychange", clearIfActive);
window.addEventListener("focus", clearIfActive);
clearIfActive();

function updateDesktopPermissionUi() {
  if (!desktopNotifStatusBar) return;
  const perm = (typeof Notification !== "undefined") ? Notification.permission : "denied";

  desktopNotifEnableBtn?.classList.add("hidden");
  desktopNotifDeniedHint?.classList.add("hidden");

  if (perm === "granted") {
    desktopNotifStatusBar.className = desktopNotifStatusBar.className
      .replace(/border-\S+/g, "").replace(/bg-\S+/g, "").trimEnd();
    desktopNotifStatusBar.classList.add("border-emerald-700/50", "bg-emerald-900/10");
    if (desktopNotifStatusIcon) {
      desktopNotifStatusIcon.className = "fa-solid fa-circle-dot text-base text-emerald-400";
    }
    if (desktopNotifStatusText) desktopNotifStatusText.textContent = "Browser notifications are enabled";
  } else if (perm === "denied") {
    desktopNotifStatusBar.className = desktopNotifStatusBar.className
      .replace(/border-\S+/g, "").replace(/bg-\S+/g, "").trimEnd();
    desktopNotifStatusBar.classList.add("border-red-700/50", "bg-red-900/10");
    if (desktopNotifStatusIcon) {
      desktopNotifStatusIcon.className = "fa-solid fa-circle-dot text-base text-red-400";
    }
    if (desktopNotifStatusText) desktopNotifStatusText.textContent = "Browser notifications are blocked";
    desktopNotifDeniedHint?.classList.remove("hidden");
  } else {
    desktopNotifStatusBar.className = desktopNotifStatusBar.className
      .replace(/border-\S+/g, "").replace(/bg-\S+/g, "").trimEnd();
    desktopNotifStatusBar.classList.add("border-slate-700", "bg-slate-900/40");
    if (desktopNotifStatusIcon) {
      desktopNotifStatusIcon.className = "fa-solid fa-circle-dot text-base text-slate-400";
    }
    if (desktopNotifStatusText) desktopNotifStatusText.textContent = "Browser notifications not yet enabled";
    desktopNotifEnableBtn?.classList.remove("hidden");
  }
}

function wireDesktopPermissionBtn() {
  if (!desktopNotifEnableBtn) return;
  desktopNotifEnableBtn.addEventListener("click", async () => {
    desktopNotifEnableBtn.disabled = true;
    const result = await requestDesktopNotificationPermission();
    if (result === "granted") {
      setDesktopNotificationsEnabled(true);
    }
    desktopNotifEnableBtn.disabled = false;
    updateDesktopPermissionUi();
  });
}

// ── Event notification toggles ───────────────────────────────────────────────
function loadEventNotifPrefs() {
  if (eventNotifOnlineInput)   eventNotifOnlineInput.checked   = getClientEventNotificationEnabled("client_online");
  if (eventNotifOfflineInput)  eventNotifOfflineInput.checked  = getClientEventNotificationEnabled("client_offline");
  if (eventNotifPurgatoryInput) eventNotifPurgatoryInput.checked = getClientEventNotificationEnabled("client_purgatory");
}

function wireEventNotifSave() {
  if (!saveEventNotifsBtn) return;
  saveEventNotifsBtn.addEventListener("click", () => {
    if (eventNotifOnlineInput)   setClientEventNotificationEnabled("client_online",   eventNotifOnlineInput.checked);
    if (eventNotifOfflineInput)  setClientEventNotificationEnabled("client_offline",  eventNotifOfflineInput.checked);
    if (eventNotifPurgatoryInput) setClientEventNotificationEnabled("client_purgatory", eventNotifPurgatoryInput.checked);
    window.showToast?.("Event notification preferences saved", "success", 3000);
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
initWebhookTemplateEditor();
wireKeywordSave();
wireWebhookSave();
wireTelegramSave();
loadMySettings();
loadEventNotifPrefs();
wireEventNotifSave();
updateDesktopPermissionUi();
wireDesktopPermissionBtn();
initRoleUi();
connect();
