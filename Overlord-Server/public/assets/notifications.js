import {
  startNotificationClient,
  subscribeNotifications,
  subscribeClientEvents,
  subscribeNotificationsCleared,
  subscribeReady,
  subscribeStatus,
  markAllNotificationsRead,
  getClientEventNotificationEnabled,
  setClientEventNotificationEnabled,
  requestDesktopNotificationPermission,
  setDesktopNotificationsEnabled,
} from "./notify-client.js";
import { createMonacoEditorAdapter, loadMonaco } from "./monaco-loader.js";
import { TabulatorFull as Tabulator } from "/vendor/tabulator/tabulator_esm.min.js";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const wsStatus = document.getElementById("ws-status");
const tableEl = document.getElementById("notification-table");
const emptyState = document.getElementById("empty-state");
const notificationScopeHint = document.getElementById("notification-scope-hint");
const searchInput = document.getElementById("notification-search");
const resultHint = document.getElementById("notification-result-hint");

// Keyword section
const keywordSection = document.getElementById("keyword-section");
const keywordInput = document.getElementById("keyword-input");
const clipboardEnabledInput = document.getElementById("clipboard-enabled");
const saveKeywordsBtn = document.getElementById("save-keywords");
const keywordHint = document.getElementById("keyword-hint");
const antiSpamMaxHitsInput = document.getElementById("antispam-max-hits");
const antiSpamWindowInput = document.getElementById("antispam-window");
const antiSpamCooldownInput = document.getElementById("antispam-cooldown");

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

const clientEventWebhookInput = document.getElementById("client-event-webhook");
const clientEventTelegramInput = document.getElementById("client-event-telegram");
const clientEventPushInput = document.getElementById("client-event-push");
const saveEventChannelsBtn = document.getElementById("save-event-channels");

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
let notificationTable = null;
let notificationTableReady = false;
let pageActive = true;
const subscriptionCleanups = [];

function tryFormatJsonText(text) {
  const source = String(text || "").trim();
  if (!source) return "";
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return null;
  }
}

async function initWebhookTemplateEditor() {
  if (!webhookTemplateInput) return;
  try {
    const monaco = await loadMonaco();
    if (!pageActive || !webhookTemplateInput.isConnected) return;
    const host = document.createElement("div");
    host.className = "w-full rounded-lg border border-slate-800 overflow-hidden";
    host.style.height = "180px";
    webhookTemplateInput.classList.add("hidden");
    webhookTemplateInput.insertAdjacentElement("afterend", host);

    monaco.editor.defineTheme("overlord-json", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#020617",
        "editor.foreground": "#e2e8f0",
        "editor.lineHighlightBackground": "#0f172a",
        "editorCursor.foreground": "#38bdf8",
        "editor.selectionBackground": "#2563eb66",
        "editorGutter.background": "#020617",
      },
    });

    const editor = monaco.editor.create(host, {
      value: webhookTemplateInput.value || "",
      language: "json",
      theme: "overlord-json",
      automaticLayout: true,
      fontFamily: '"JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize: 12,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: "on",
      padding: { top: 8, bottom: 8 },
    });

    webhookTemplateEditor = createMonacoEditorAdapter(editor, monaco);
    editor.onDidBlurEditorWidget(() => {
      const current = webhookTemplateEditor.getValue();
      const formatted = tryFormatJsonText(current);
      if (formatted !== null && formatted !== current) {
        const position = editor.getPosition();
        webhookTemplateEditor.setValue(formatted);
        if (position) editor.setPosition(position);
      }
    });
  } catch (err) {
    console.warn("Monaco webhook editor unavailable; falling back to textarea", err);
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

// ── Unified table state (notifications + client events) ──────────────────────
const tableState = {
  entries: new Map(),
  search: "",
  sortBy: "ts",
  sortDir: "desc",
};

let clientEventCounter = 0;

function getEntryUid(item, kind) {
  if (kind === "event") {
    return `event:${item.clientId || ""}:${item.event || ""}:${item.ts || 0}:${++clientEventCounter}`;
  }
  return `notification:${item.id || `${item.clientId || ""}:${item.ts || ""}:${item.title || ""}`}`;
}

function getSortValue(entry, key) {
  const item = entry.item;
  if (key === "ts") return Number(item.ts) || 0;
  if (key === "source") {
    if (entry.kind === "event") return `event:${item.event || ""}`;
    return `notif:${item.category || ""}`;
  }
  const value = item[key];
  return value == null ? "" : String(value).toLowerCase();
}

function compareEntries(a, b) {
  const key = tableState.sortBy;
  const av = getSortValue(a, key);
  const bv = getSortValue(b, key);
  let cmp;
  if (typeof av === "number" && typeof bv === "number") {
    cmp = av - bv;
  } else {
    cmp = String(av).localeCompare(String(bv));
  }
  if (cmp === 0) {
    cmp = (Number(a.item.ts) || 0) - (Number(b.item.ts) || 0);
  }
  return tableState.sortDir === "asc" ? cmp : -cmp;
}

function sourceHtml(entry) {
  if (entry.kind === "event") {
    return CLIENT_EVENT_BADGE[entry.item.event] ||
      `<span class="text-xs text-slate-400">${escapeHtml(entry.item.event)}</span>`;
  }
  const isClipboard = entry.item.category === "clipboard";
  const isCrash = entry.item.category === "crash_report";
  if (isCrash) {
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-red-900/60 text-red-300 border border-red-700/50"><i class="fa-solid fa-bug text-xs"></i> crash</span>`;
  }
  return isClipboard
    ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-violet-900/60 text-violet-300 border border-violet-700/50"><i class="fa-solid fa-clipboard text-xs"></i> clipboard</span>`
    : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-900/60 text-blue-300 border border-blue-700/50"><i class="fa-solid fa-desktop text-xs"></i> window</span>`;
}

function entryToRow(entry) {
  const item = entry.item;
  return {
    uid: entry.uid,
    kind: entry.kind,
    item,
    isLive: entry.isLive,
    ts: Number(item.ts) || 0,
    clientId: item.clientId || "",
    user: item.user || "-",
    title: entry.kind === "event" ? "client event" : (item.title || "-"),
    detail: entry.kind === "event" ? "" : (item.detail || item.processPath || ""),
    process: entry.kind === "event" ? (item.os || "-") : (item.process || "-"),
    keyword: entry.kind === "event" ? "-" : (item.keyword || "-"),
    source: entry.kind === "event" ? (item.event || "") : (item.category || "window"),
    sourceHtml: sourceHtml(entry),
  };
}

function entryMatchesSearch(entry, query) {
  if (!query) return true;
  const item = entry.item;
  const haystack = [
    item.clientId,
    item.user,
    item.host,
    item.title,
    item.process,
    item.processPath,
    item.detail,
    item.keyword,
    entry.kind === "event" ? item.event : item.category,
    item.os,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function applyTableView() {
  if (!pageActive) return;
  const q = tableState.search.trim().toLowerCase();
  const all = Array.from(tableState.entries.values());
  const filtered = q ? all.filter((entry) => entryMatchesSearch(entry, q)) : all;
  filtered.sort(compareEntries);
  const rows = filtered.map(entryToRow);
  if (notificationTable && notificationTableReady && tableEl?.isConnected) {
    void notificationTable.replaceData(rows).catch((err) => {
      if (pageActive) console.error("Failed to update notification table:", err);
    });
  }

  if (emptyState) {
    if (all.length === 0) {
      emptyState.textContent = "No notifications yet.";
      emptyState.classList.remove("hidden");
    } else if (filtered.length === 0) {
      emptyState.textContent = "No notifications match the current search.";
      emptyState.classList.remove("hidden");
    } else {
      emptyState.classList.add("hidden");
    }
  }

  if (resultHint) {
    if (q) {
      resultHint.textContent = `${filtered.length} of ${all.length}`;
    } else {
      resultHint.textContent = all.length > 0 ? `${all.length} total` : "";
    }
  }
}

function trimEntries() {
  if (tableState.entries.size <= MAX_ROWS) return;
  const ordered = Array.from(tableState.entries.entries())
    .sort((a, b) => (Number(b[1].item.ts) || 0) - (Number(a[1].item.ts) || 0));
  const keep = new Set(ordered.slice(0, MAX_ROWS).map(([uid]) => uid));
  for (const uid of tableState.entries.keys()) {
    if (!keep.has(uid)) tableState.entries.delete(uid);
  }
}

function upsertEntry(item, kind, isLive) {
  const uid = getEntryUid(item, kind);
  const existing = tableState.entries.get(uid);
  if (existing) {
    existing.item = { ...existing.item, ...item };
    return existing;
  }
  const entry = { uid, item, kind, isLive };
  tableState.entries.set(uid, entry);
  trimEntries();
  return entry;
}

function addNotification(item, isLive) {
  upsertEntry(item, "notification", isLive);
  applyTableView();
}

function addClientEvent(item) {
  upsertEntry(item, "event", true);
  applyTableView();
}

function clearTable() {
  tableState.entries.clear();
  applyTableView();
}

function removeEntriesForClient(clientId) {
  if (!clientId) return;
  let removed = false;
  for (const [uid, entry] of tableState.entries) {
    if (entry.item?.clientId === clientId) {
      tableState.entries.delete(uid);
      removed = true;
    }
  }
  if (removed) applyTableView();
}

// ── Client ID cell (collapsed by default, click to expand) ──────────────────
const CLIENT_ID_SHORT_LEN = 8;

function clientIdCellHtml(clientId) {
  const id = String(clientId || "");
  if (!id) {
    return `<td class="py-2 pr-4 whitespace-nowrap text-slate-500">-</td>`;
  }
  if (id.length <= CLIENT_ID_SHORT_LEN) {
    return `<td class="py-2 pr-4 whitespace-nowrap font-mono text-xs text-slate-300">${escapeHtml(id)}</td>`;
  }
  const safeFull = escapeHtml(id);
  const safeShort = escapeHtml(id.slice(0, CLIENT_ID_SHORT_LEN));
  return `<td class="py-2 pr-4 whitespace-nowrap"><button type="button" class="client-id-toggle inline-flex items-center gap-1 font-mono text-xs px-2 py-0.5 rounded border border-slate-700 bg-slate-900/80 hover:bg-slate-800 hover:border-slate-600 text-slate-300" data-full="${safeFull}" data-short="${safeShort}" title="${safeFull} (click to expand)"><span class="client-id-text">${safeShort}<span class="text-slate-500">…</span></span><i class="fa-solid fa-chevron-right text-[10px] text-slate-500"></i></button></td>`;
}

function clientIdFormatter(cell) {
  const id = String(cell.getValue() || "");
  if (!id) return `<span class="text-slate-500">-</span>`;
  if (id.length <= CLIENT_ID_SHORT_LEN) {
    return `<span class="font-mono text-xs text-slate-300">${escapeHtml(id)}</span>`;
  }
  const safeFull = escapeHtml(id);
  const safeShort = escapeHtml(id.slice(0, CLIENT_ID_SHORT_LEN));
  return `<button type="button" class="client-id-toggle inline-flex items-center gap-1 font-mono text-xs px-2 py-0.5 rounded border border-slate-700 bg-slate-900/80 hover:bg-slate-800 hover:border-slate-600 text-slate-300" data-full="${safeFull}" data-short="${safeShort}" title="${safeFull} (click to expand)"><span class="client-id-text">${safeShort}<span class="text-slate-500">...</span></span><i class="fa-solid fa-chevron-right text-[10px] text-slate-500"></i></button>`;
}

function previewFormatter(cell) {
  const row = cell.getRow().getData();
  const item = row.item || {};
  const wrapper = document.createElement("div");
  if (row.kind === "event") {
    wrapper.textContent = "";
    return wrapper;
  }

  const notificationId = item?.id || "";
  const skipFetch = !notificationId || (!row.isLive && !item?.screenshotId);
  if (skipFetch) {
    wrapper.textContent = "-";
    wrapper.className = "text-slate-500";
    return wrapper;
  }

  if (item._previewObjectUrl) {
    const img = createPreviewImage(item._previewObjectUrl);
    wrapper.appendChild(img);
    return wrapper;
  }

  wrapper.textContent = "Loading...";
  wrapper.className = "text-slate-500";
  let attempts = 0;
  const maxAttempts = 5;
  const fetchPreview = async () => {
    attempts += 1;
    try {
      const url = `/api/notifications/${encodeURIComponent(notificationId)}/screenshot?ts=${Date.now()}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        if ((res.status === 202 || res.status === 404) && attempts < maxAttempts) {
          setTimeout(fetchPreview, 1000 * attempts);
          return;
        }
        wrapper.textContent = "-";
        wrapper.className = "text-slate-500";
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      item._previewObjectUrl = objectUrl;
      wrapper.innerHTML = "";
      wrapper.className = "";
      wrapper.appendChild(createPreviewImage(objectUrl));
    } catch {
      if (attempts < maxAttempts) {
        setTimeout(fetchPreview, 1000 * attempts);
        return;
      }
      wrapper.textContent = "-";
      wrapper.className = "text-slate-500";
    }
  };
  fetchPreview();
  return wrapper;
}

function createPreviewImage(objectUrl) {
  const img = document.createElement("img");
  img.className = "max-h-32 w-auto rounded border border-slate-800/80 cursor-zoom-in opacity-0";
  img.loading = "lazy";
  img.alt = "Notification screenshot";
  img.src = objectUrl;
  img.dataset.previewUrl = objectUrl;
  img.addEventListener("load", () => img.classList.remove("opacity-0"));
  img.addEventListener("click", () => {
    if (!previewModal || !previewModalImg) return;
    previewModalImg.src = img.dataset.previewUrl || objectUrl;
    previewModal.classList.remove("hidden");
    previewModal.classList.add("flex");
  });
  if (img.decode) img.decode().catch(() => {});
  return img;
}

// ── Notification row factory ─────────────────────────────────────────────────
function createNotificationRowElement(item, isLive) {
  const isClipboard = item.category === "clipboard";
  const sourceBadge = isClipboard
    ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-violet-900/60 text-violet-300 border border-violet-700/50"><i class="fa-solid fa-clipboard text-xs"></i> clipboard</span>`
    : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-900/60 text-blue-300 border border-blue-700/50"><i class="fa-solid fa-desktop text-xs"></i> window</span>`;
  const row = document.createElement("tr");
  row.className = "border-t border-slate-800/60";
  row.innerHTML = `
    <td class="py-2 pr-4 whitespace-nowrap text-slate-400">${formatTime(item.ts)}</td>
    ${clientIdCellHtml(item.clientId)}
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
    const skipFetch = !notificationId || (!isLive && !item?.screenshotId);
    if (skipFetch) {
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
            if ((res.status === 202 || res.status === 404) && attempts < maxAttempts) {
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

  return row;
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
    if (antiSpamMaxHitsInput) {
      antiSpamMaxHitsInput.value = data?.notifications?.antiSpamMaxHits ?? 15;
    }
    if (antiSpamWindowInput) {
      antiSpamWindowInput.value = Math.round((data?.notifications?.antiSpamWindowMs ?? 600000) / 60000);
    }
    if (antiSpamCooldownInput) {
      antiSpamCooldownInput.value = Math.round((data?.notifications?.antiSpamCooldownMs ?? 600000) / 60000);
    }
  } catch {}
}

function wireKeywordSave() {
  if (!saveKeywordsBtn || !keywordInput) return;
  saveKeywordsBtn.addEventListener("click", async () => {
    const keywords = parseKeywords(keywordInput.value);
    const clipboardEnabled = clipboardEnabledInput ? clipboardEnabledInput.checked : false;
    const payload = { keywords, clipboardEnabled };
    if (antiSpamMaxHitsInput) {
      payload.antiSpamMaxHits = Math.max(1, parseInt(antiSpamMaxHitsInput.value, 10) || 15);
    }
    if (antiSpamWindowInput) {
      payload.antiSpamWindowMs = Math.max(1, parseInt(antiSpamWindowInput.value, 10) || 10) * 60000;
    }
    if (antiSpamCooldownInput) {
      payload.antiSpamCooldownMs = Math.max(1, parseInt(antiSpamCooldownInput.value, 10) || 10) * 60000;
    }
    try {
      const res = await fetch("/api/notifications/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
      if (antiSpamMaxHitsInput && data?.notifications?.antiSpamMaxHits) {
        antiSpamMaxHitsInput.value = data.notifications.antiSpamMaxHits;
      }
      if (antiSpamWindowInput && data?.notifications?.antiSpamWindowMs) {
        antiSpamWindowInput.value = Math.round(data.notifications.antiSpamWindowMs / 60000);
      }
      if (antiSpamCooldownInput && data?.notifications?.antiSpamCooldownMs) {
        antiSpamCooldownInput.value = Math.round(data.notifications.antiSpamCooldownMs / 60000);
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
  if (clientEventWebhookInput) clientEventWebhookInput.checked = settings.client_event_webhook !== 0;
  if (clientEventTelegramInput) clientEventTelegramInput.checked = settings.client_event_telegram !== 0;
  if (clientEventPushInput) clientEventPushInput.checked = settings.client_event_push !== 0;
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

  subscriptionCleanups.push(subscribeStatus((status) => {
    if (status === "connected") setStatus("Connected", "ok");
    if (status === "error") setStatus("Error", "error");
    if (status === "disconnected") setStatus("Disconnected", "warn");
  }));

  subscriptionCleanups.push(subscribeReady((history) => {
    if (!pageActive) return;
    tableState.entries.clear();
    for (const item of history) {
      upsertEntry(item, "notification", false);
    }
    applyTableView();
    markAllNotificationsRead();
  }));

  subscriptionCleanups.push(subscribeNotifications((item) => addNotification(item, true)));
  subscriptionCleanups.push(subscribeClientEvents((item) => addClientEvent(item)));
  subscriptionCleanups.push(subscribeNotificationsCleared((clientId) => removeEntriesForClient(clientId)));
}

const CLIENT_EVENT_BADGE = {
  client_online: `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-emerald-900/60 text-emerald-300 border border-emerald-700/50"><i class="fa-solid fa-circle text-xs"></i> online</span>`,
  client_offline: `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-rose-900/60 text-rose-300 border border-rose-700/50"><i class="fa-solid fa-circle text-xs"></i> offline</span>`,
  client_purgatory: `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-900/60 text-amber-300 border border-amber-700/50"><i class="fa-solid fa-hourglass-half text-xs"></i> purgatory</span>`,
};

function createClientEventRowElement(item) {
  const badge = CLIENT_EVENT_BADGE[item.event] ||
    `<span class="text-xs text-slate-400">${escapeHtml(item.event)}</span>`;
  const row = document.createElement("tr");
  row.className = "border-t border-slate-800/60";
  row.innerHTML = `
    <td class="py-2 pr-4 whitespace-nowrap text-slate-400">${formatTime(item.ts)}</td>
    ${clientIdCellHtml(item.clientId)}
    <td class="py-2 pr-4 whitespace-nowrap">${escapeHtml(item.user || "-")}</td>
    <td class="py-2 pr-4 max-w-xl truncate italic text-slate-400">client event</td>
    <td class="py-2 pr-4 whitespace-nowrap">${escapeHtml(item.os || "-")}</td>
    <td class="py-2 pr-4 whitespace-nowrap">-</td>
    <td class="py-2 pr-4 whitespace-nowrap">${badge}</td>
    <td class="py-2 pr-4"></td>
  `;
  return row;
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

function wireEventChannelsSave() {
  if (!saveEventChannelsBtn) return;
  saveEventChannelsBtn.addEventListener("click", async () => {
    try {
      await saveMySettings({
        client_event_webhook: clientEventWebhookInput?.checked ?? true,
        client_event_telegram: clientEventTelegramInput?.checked ?? true,
        client_event_push: clientEventPushInput?.checked ?? true,
      });
      window.showToast?.("Event delivery channel settings saved", "success", 3000);
    } catch (err) {
      window.showToast?.(err?.message || "Failed to save event channel settings", "error", 4000);
    }
  });
}

function wireClientIdToggle() {
  if (!tableEl) return;
  tableEl.addEventListener("click", (event) => {
    const btn = event.target.closest(".client-id-toggle");
    if (!btn) return;
    const textEl = btn.querySelector(".client-id-text");
    const icon = btn.querySelector("i");
    if (!textEl) return;
    const expanded = btn.classList.toggle("expanded");
    if (expanded) {
      textEl.textContent = btn.dataset.full || "";
      if (icon) icon.className = "fa-solid fa-chevron-left text-[10px] text-slate-500";
      btn.title = `${btn.dataset.full} (click to collapse)`;
    } else {
      textEl.innerHTML = `${escapeHtml(btn.dataset.short || "")}<span class="text-slate-500">…</span>`;
      if (icon) icon.className = "fa-solid fa-chevron-right text-[10px] text-slate-500";
      btn.title = `${btn.dataset.full} (click to expand)`;
    }
  });
}

function wireTableControls() {
  if (searchInput) {
    let debounce = null;
    searchInput.addEventListener("input", () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        tableState.search = searchInput.value || "";
        applyTableView();
      }, 100);
    });
  }
}

function initNotificationTable() {
  if (!tableEl) return;
  notificationTableReady = false;
  notificationTable = new Tabulator(tableEl, {
    data: [],
    height: "24rem",
    layout: "fitDataStretch",
    reactiveData: false,
    placeholder: "No notifications yet.",
    virtualDom: true,
    index: "uid",
    initialSort: [{ column: "ts", dir: "desc" }],
    columns: [
      {
        title: "Time",
        field: "ts",
        width: 190,
        sorter: "number",
        formatter: (cell) => `<span class="text-slate-400">${formatTime(cell.getValue())}</span>`,
      },
      {
        title: "Client",
        field: "clientId",
        width: 150,
        formatter: clientIdFormatter,
      },
      {
        title: "User",
        field: "user",
        width: 130,
        formatter: "plaintext",
      },
      {
        title: "Title / Content",
        field: "title",
        minWidth: 240,
        formatter: (cell) => {
          const row = cell.getRow().getData();
          const value = escapeHtml(cell.getValue() || "-");
          const detail = escapeHtml(row.detail || "");
          const tone = row.kind === "event" ? "italic text-slate-400" : "text-slate-100";
          if (row.item?.category === "crash_report" && detail) {
            return `<div class="space-y-1"><span class="${tone}" title="${value}">${value}</span><div class="max-w-xl truncate font-mono text-xs text-red-300/80" title="${detail}">${detail}</div></div>`;
          }
          return `<span class="${tone}" title="${value}">${value}</span>`;
        },
      },
      {
        title: "Process",
        field: "process",
        width: 160,
        formatter: "plaintext",
      },
      {
        title: "Keyword",
        field: "keyword",
        width: 130,
        formatter: "plaintext",
      },
      {
        title: "Source",
        field: "source",
        width: 140,
        formatter: (cell) => cell.getRow().getData().sourceHtml || "",
      },
      {
        title: "Preview",
        field: "uid",
        width: 180,
        headerSort: false,
        formatter: previewFormatter,
      },
    ],
  });
  notificationTable.on("tableBuilt", () => {
    if (!pageActive || !tableEl.isConnected) return;
    notificationTableReady = true;
    applyTableView();
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
initWebhookTemplateEditor();
initNotificationTable();
wireKeywordSave();
wireWebhookSave();
wireTelegramSave();
loadMySettings();
loadEventNotifPrefs();
wireEventNotifSave();
wireEventChannelsSave();
updateDesktopPermissionUi();
wireDesktopPermissionBtn();
wireTableControls();
wireClientIdToggle();
initRoleUi();
connect();

window.addEventListener("pagehide", () => {
  pageActive = false;
  notificationTableReady = false;
  for (const unsubscribe of subscriptionCleanups.splice(0)) unsubscribe();
  webhookTemplateEditor?.dispose?.();
  webhookTemplateEditor = null;
  try {
    notificationTable?.destroy();
  } catch {}
  notificationTable = null;
}, { once: true });
