import {
  formatAgo,
  formatPing,
  countryToFlag,
  osBadge,
  archBadge,
  versionBadge,
  monitorsBadge,
  shortId,
} from "./viewUtils.js";
import { applyImageSrcSmooth } from "./thumbnail-loader.js";

function wireThumbImg(img) {
  if (!(img instanceof HTMLImageElement) || img.dataset.thumbErrWired === "1") return;
  img.dataset.thumbErrWired = "1";
  const handleError = () => {
    img.style.display = "none";
    img.removeAttribute("src");
    img.removeAttribute("data-thumb-url");
  };
  img.addEventListener("error", handleError);
  if (img.complete && img.src && !img.naturalWidth) handleError();
}

if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        if (n.matches?.("img[data-thumb-img]")) wireThumbImg(n);
        n.querySelectorAll?.("img[data-thumb-img]").forEach(wireThumbImg);
      });
    }
  });
  const start = () => {
    if (!document.body) return;
    observer.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll("img[data-thumb-img]").forEach(wireThumbImg);
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

const ROW_SELECTOR = "[data-client-row]";

function pingTone(ms) {
  if (ms === null || ms === undefined) return "ping-unknown";
  if (ms < 30) return "ping-good";
  if (ms < 80) return "ping-mid";
  return "ping-bad";
}

function metaSeparator() {
  return `<span class="cv-mid" aria-hidden="true">·</span>`;
}

const FAUX_PALETTES = [
  ["#1e3a8a", "#0ea5e9", "#22d3ee"],
  ["#0f172a", "#475569", "#94a3b8"],
  ["#3b0764", "#a21caf", "#f472b6"],
  ["#064e3b", "#10b981", "#bbf7d0"],
  ["#7c2d12", "#ea580c", "#fdba74"],
  ["#082f49", "#0284c7", "#7dd3fc"],
];

function paletteFor(id) {
  const s = String(id || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return FAUX_PALETTES[h % FAUX_PALETTES.length];
}

function fauxDesktopHtml(client, opts = {}) {
  const palette = paletteFor(client.id);
  const op = !client.online ? 0.3 : 1.0;
  const small = !!opts.small;
  const dotR = small ? 4 : 6;
  return `
    <div class="cv-faux" style="--p1:${palette[0]};--p2:${palette[1]};--p3:${palette[2]};--op:${op}">
      <div class="cv-faux-dots">
        <i style="width:${dotR}px;height:${dotR}px"></i>
        <i style="width:${dotR}px;height:${dotR}px"></i>
        <i style="width:${dotR}px;height:${dotR}px"></i>
      </div>
      <div class="cv-faux-window">
        <span style="width:78%"></span>
        <span style="width:62%"></span>
        <span style="width:48%"></span>
        <span style="width:36%"></span>
        <span style="width:24%"></span>
      </div>
      <div class="cv-faux-bar">
        <i></i><i></i><i></i><i></i><i></i>
      </div>
    </div>
  `;
}

function thumbHtml(client, { width, height, small = false } = {}) {
  const hasThumb = !!client.hasThumbnail;
  const version = Number(client.thumbnailVersion) || 0;
  const opacityStyle = client.online ? "" : "opacity:0.35";
  const idAttr = escapeHtml(client.id);
  const initialSrc = hasThumb
    ? `/api/clients/${encodeURIComponent(client.id)}/thumbnail${version ? `?v=${version}` : ""}`
    : "";
  const initialDisplay = hasThumb ? "display:block" : "display:none";
  return `
    <div class="cv-thumb cv-thumb-host"
         data-thumb-host
         data-thumb-client="${idAttr}"
         data-thumb-version="${version}"
         data-thumb-online="${client.online ? "1" : "0"}"
         style="width:${width}px;height:${height}px;${opacityStyle}">
      ${fauxDesktopHtml(client, { small })}
      <img class="thumb-img cv-thumb-img cv-thumb-overlay"
           data-thumb-img
           alt=""
           loading="lazy"
           decoding="async"
           ${initialSrc ? `src="${initialSrc}" data-thumb-url="${initialSrc}"` : ""}
           style="${initialDisplay}">
    </div>`;
}

function statusDot(client) {
  return `<span class="cv-dot ${client.online ? "is-online" : "is-offline"}"></span>`;
}

function groupPillHtml(client) {
  const name = String(client.groupName || "").trim();
  if (!name) return "";
  const color = String(client.groupColor || "").trim() || "#64748b";
  return `<span class="cv-group" style="--gc:${escapeHtml(color)}">${escapeHtml(name)}</span>`;
}

function shortenCpu(raw = "") {
  return String(raw)
    .replace(/\(R\)|\(TM\)|\(tm\)|\(r\)/g, "")
    .replace(/\b(CPU|Processor|Genuine|Intel|AMD)\b/gi, (m) => (m.toUpperCase() === "INTEL" || m.toUpperCase() === "AMD" ? m : ""))
    .replace(/@\s*[\d.]+\s*GHz.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 38);
}

function cpuBrand(raw = "") {
  const text = String(raw).toLowerCase();
  const appleMatch = text.match(/\bapple\s+(m\d+(?:\s*(?:pro|max|ultra))?)\b/i);
  if (appleMatch) {
    return { vendor: "apple", chip: appleMatch[1].replace(/\s+/g, " ").toUpperCase() };
  }
  const intelMatch = text.match(/\b(?:intel(?:\(r\))?\s+)?(?:core\(tm\)\s+)?(i[3579]-\d{3,5}[a-z0-9]*)\b/i);
  if (text.includes("intel") || intelMatch) {
    return { vendor: "intel", chip: intelMatch ? intelMatch[1].toUpperCase() : "CPU" };
  }
  const amdMatch = text.match(/\b(?:amd\s+)?(?:ryzen\s+)?([3579]\s+\d{4}[a-z0-9]*)\b/i);
  if (text.includes("amd") || text.includes("ryzen")) {
    return { vendor: "amd", chip: amdMatch ? amdMatch[1].replace(/\s+/g, " ").toUpperCase() : "RYZEN" };
  }
  return null;
}

function cpuBadgeHtml(raw = "", { compact = false } = {}) {
  const brand = cpuBrand(raw);
  const label = shortenCpu(raw) || "CPU";
  if (!brand) {
    return `<span class="cv-cpu-badge cv-cpu-generic" title="${escapeHtml(raw || label)}"><i class="fa-solid fa-microchip"></i><span>${escapeHtml(label)}</span></span>`;
  }
  if (brand.vendor === "apple") {
    return `<span class="cv-cpu-badge cv-cpu-apple" title="${escapeHtml(raw)}"><i class="fa-brands fa-apple"></i><strong>${escapeHtml(brand.chip)}</strong></span>`;
  }
  if (brand.vendor === "intel") {
    return `<span class="cv-cpu-badge cv-cpu-intel" title="${escapeHtml(raw)}"><strong>intel</strong>${compact ? "" : `<span>${escapeHtml(brand.chip)}</span>`}</span>`;
  }
  return `<span class="cv-cpu-badge cv-cpu-amd" title="${escapeHtml(raw)}"><strong>AMD</strong>${compact ? "" : `<span>${escapeHtml(brand.chip)}</span>`}</span>`;
}

function batteryInfo(client) {
  const n = Number(client.batteryPercent);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return { percent: Math.round(n), charging: client.batteryCharging === true };
}

function batteryHtml(client, { compact = false } = {}) {
  const battery = batteryInfo(client);
  if (!battery) return "";
  const tone = battery.percent < 20 ? "is-low" : battery.percent <= 35 ? "is-mid" : "is-good";
  const title = `Battery ${battery.percent}%${battery.charging ? " charging" : ""}`;
  return `<span class="cv-battery ${tone} ${battery.charging ? "is-charging" : ""}" title="${escapeHtml(title)}">
    <span class="cv-battery-shell"><span class="cv-battery-fill" style="width:${battery.percent}%"></span></span>
    <span class="cv-battery-text">${battery.percent}%${battery.charging ? ` <i class="fa-solid fa-bolt"></i>` : ""}</span>
    ${compact ? "" : `<span class="cv-battery-label">${battery.charging ? "Charging" : "Battery"}</span>`}
  </span>`;
}

function isMacClient(client) {
  const os = String(client?.os || "").toLowerCase();
  return os.includes("mac") || os.includes("darwin");
}

const MAC_PERMISSION_LABELS = [
  ["accessibility", "Accessibility"],
  ["screenRecording", "Screen Recording"],
  ["inputMonitoring", "Input Monitoring"],
  ["fullDiskAccess", "Full Disk Access"],
];

function macPermissionState(client) {
  if (!isMacClient(client) || !client.permissions || typeof client.permissions !== "object") return null;
  const items = MAC_PERMISSION_LABELS
    .filter(([key]) => typeof client.permissions[key] === "boolean")
    .map(([key, label]) => ({ key, label, granted: client.permissions[key] === true }));
  if (!items.length) return null;
  const missing = items.filter((item) => !item.granted);
  return { items, missing };
}

function macPermissionBadgeHtml(client) {
  const state = macPermissionState(client);
  if (!state) return "";
  const title = state.items.map((item) => `${item.label}: ${item.granted ? "granted" : "missing"}`).join(" · ");
  const ok = state.missing.length === 0;
  return `<span class="cv-mini-pill cv-pill-macperm ${ok ? "is-ok" : "is-warn"}" title="${escapeHtml(title)}"><i class="fa-solid ${ok ? "fa-key" : "fa-triangle-exclamation"}"></i></span>`;
}

function macPermissionDetailHtml(client) {
  const state = macPermissionState(client);
  if (!state) return "";
  const ok = state.missing.length === 0;
  const summary = ok ? "All required permissions granted" : `Missing: ${state.missing.map((item) => item.label).join(", ")}`;
  const granted = Object.fromEntries(state.items.map((item) => [item.key, item.granted]));
  const featureItems = [
    {
      label: "Remote Desktop",
      ready: granted.screenRecording && granted.accessibility,
      missing: ["screenRecording", "accessibility"].filter((key) => !granted[key]),
    },
    {
      label: "Keylogger",
      ready: granted.accessibility && granted.inputMonitoring,
      missing: ["accessibility", "inputMonitoring"].filter((key) => !granted[key]),
    },
    {
      label: "Files",
      ready: granted.fullDiskAccess,
      missing: granted.fullDiskAccess ? [] : ["fullDiskAccess"],
    },
  ];
  const labelFor = (key) => MAC_PERMISSION_LABELS.find(([k]) => k === key)?.[1] || key;
  const chips = state.items.map((item) => `
    <button type="button" class="cv-perm-chip ${item.granted ? "is-ok" : "is-missing"}" data-mac-permission-key="${escapeHtml(item.key)}" title="${escapeHtml(item.key === "inputMonitoring" ? "Request Input Monitoring permission; reconnect required after granting" : `Request ${item.label} permission`)}">
      <i class="fa-solid ${item.granted ? "fa-check" : "fa-xmark"}"></i>${escapeHtml(item.label)}
    </button>
  `).join("");
  const readiness = featureItems.map((item) => `
    <span class="cv-ready-chip ${item.ready ? "is-ok" : "is-warn"}" title="${escapeHtml(item.ready ? "Ready" : `Missing ${item.missing.map(labelFor).join(", ")}`)}">
      <i class="fa-solid ${item.ready ? "fa-circle-check" : "fa-circle-exclamation"}"></i>${escapeHtml(item.label)}
    </span>
  `).join("");
  return `<div class="cv-field cv-field-wide cv-field-macperms"><span class="cv-field-label">macOS Permissions</span><span class="cv-field-value cv-perm-list"><span class="cv-perm-summary ${ok ? "is-ok" : "is-warn"}">${escapeHtml(summary)}</span>${chips}<span class="cv-perm-freshness">Checked ${escapeHtml(formatAgo(client.lastSeen))}; Input Monitoring updates after reconnect</span><span class="cv-perm-readiness">${readiness}</span><span class="cv-perm-actions"><button type="button" class="cv-perm-tool" data-mac-permission-refresh="1" title="Re-check permissions except Input Monitoring"><i class="fa-solid fa-rotate"></i>Refresh</button><button type="button" class="cv-perm-tool" data-mac-permission-apply="1" title="Reconnect agent to apply newly granted permissions"><i class="fa-solid fa-power-off"></i>Apply</button></span></span></div>`;
}

function shortOsLabel(osRaw = "") {
  const badge = osBadge(osRaw || "");
  if (badge?.label && badge.label !== "Linux" && badge.label !== "Windows") return badge.label;
  const o = String(osRaw).toLowerCase();
  const winVersion = o.match(/\bwindows\s+(10|11)\b/i);
  if (winVersion) return `W${winVersion[1]}`;
  if (o.includes("windows 11")) return "W11";
  if (o.includes("windows 10")) return "W10";
  if (o.includes("windows")) return "Win";
  if (o.includes("linux mint")) return "Mint";
  if (o.includes("pop!_os") || o.includes("pop os") || o.includes("pop-os")) return "Pop!_OS";
  if (o.includes("ubuntu")) return "Ubuntu";
  if (o.includes("debian")) return "Debian";
  if (o.includes("manjaro")) return "Manjaro";
  if (o.includes("arch")) return "Arch";
  if (o.includes("kali")) return "Kali";
  if (o.includes("fedora")) return "Fedora";
  if (o.includes("red hat") || o.includes("rhel")) return "RHEL";
  if (o.includes("rocky")) return "Rocky";
  if (o.includes("alma")) return "Alma";
  if (o.includes("centos")) return "CentOS";
  if (o.includes("opensuse")) return "openSUSE";
  if (o.includes("suse")) return "SUSE";
  if (o.includes("raspbian") || o.includes("raspberry")) return "Raspberry Pi";
  if (o.includes("freebsd")) return "FreeBSD";
  if (o.includes("nixos") || o.includes("nix os")) return "NixOS";
  if (o.includes("gentoo")) return "Gentoo";
  if (o.includes("alpine")) return "Alpine";
  if (o.includes("android")) return "Android";
  if (o.includes("mac") || o.includes("darwin")) return "macOS";
  if (o.includes("linux")) return "Linux";
  return osRaw || "?";
}

function normalizeVersion(version) {
  return String(version || "").trim().replace(/^v/i, "");
}

function isClientVersionCurrent(clientVersion, serverVersion) {
  const client = normalizeVersion(clientVersion);
  const server = normalizeVersion(serverVersion);
  if (!client || !server || server === "unknown" || server === "unavailable") return true;
  return client === server;
}

export function createRenderer({
  grid,
  totalPill,
  pageLabel,
  openMenu,
  openModal,
  requestPreview,
  requestThumbnail,
  pingClient,
  onOpenWebcam,
  onMacPermissionRequest,
  onMacPermissionRefresh,
  onMacPermissionApply,
  userRole,
  getServerVersion,
  getDisplayFields,
  getDashboardBadges,
}) {
  const isViewer = userRole === "viewer";
  const LARGE_CLIENT_THRESHOLD = 50_000;
  const MAX_ANIMATED_CARDS = 0;
  const INSERT_BATCH_SIZE = 40;
  const TOUCH_LONG_PRESS_MS = 520;
  const TOUCH_MOVE_CANCEL_PX = 10;
  let renderToken = 0;
  let gridDelegated = false;
  let currentLayout = (grid?.dataset.layout || "rows").toLowerCase();
  let tableScaffoldDigest = "";
  let currentDisplayDigest = "";

  function displayFields() {
    return typeof getDisplayFields === "function" ? getDisplayFields() || {} : {};
  }

  function showField(name) {
    return displayFields()[name] !== false;
  }

  function displayDigest() {
    return JSON.stringify(displayFields());
  }

  function getCardContainer() {
    if (currentLayout === "table") {
      return grid.querySelector("tbody.clients-table-body") || grid;
    }
    return grid;
  }

  function ensureLayoutScaffold() {
    if (currentLayout === "table") {
      const prefs = displayFields();
      const scaffoldDigest = displayDigest();
      if (grid.querySelector("table.clients-table") && tableScaffoldDigest === scaffoldDigest) return;
      tableScaffoldDigest = scaffoldDigest;
      grid.innerHTML = `
        <table class="clients-table">
          <thead>
            <tr>
              <th class="cv-th-check"></th>
              <th class="cv-th-star"></th>
              <th class="cv-th-thumb"></th>
              <th>Client</th>
              <th class="cv-th-status">Status</th>
              <th class="cv-th-last">Last seen</th>
              ${prefs.system !== false ? `<th class="cv-th-system">System</th>` : ""}
              <th class="cv-th-ping">Ping</th>
              ${prefs.group !== false ? `<th class="cv-th-group">Group</th>` : ""}
              <th class="cv-th-actions">Actions</th>
            </tr>
          </thead>
          <tbody class="clients-table-body"></tbody>
        </table>
      `;
    } else {
      tableScaffoldDigest = "";
      const t = grid.querySelector("table.clients-table");
      if (t) t.remove();
    }
  }

  function setLayout(layout) {
    const next = ["rows", "table", "cards"].includes(layout) ? layout : "rows";
    if (currentLayout === next && grid.dataset.layout === next) return;
    currentLayout = next;
    grid.dataset.layout = next;
    grid.innerHTML = "";
    ensureLayoutScaffold();
  }

  /* ── Event delegation ─────────────────────────────────────────── */

  function setupGridDelegation() {
    if (gridDelegated) return;
    gridDelegated = true;

    grid.addEventListener("click", (e) => {
      const card = e.target.closest(ROW_SELECTOR);
      if (!card) return;
      const clientId = card.dataset.id;

      if (e.target.closest(".client-checkbox")) {
        e.stopPropagation();
        if (window.toggleClientSelection) window.toggleClientSelection(clientId);
        return;
      }

      const bookmarkBtn = e.target.closest(".bookmark-btn");
      if (bookmarkBtn) {
        e.stopPropagation();
        handleBookmarkClick(card, bookmarkBtn);
        return;
      }

      const macPermBtn = e.target.closest(".cv-perm-chip[data-mac-permission-key]");
      if (macPermBtn) {
        e.preventDefault();
        e.stopPropagation();
        if (onMacPermissionRequest) onMacPermissionRequest(clientId, card, macPermBtn.dataset.macPermissionKey);
        return;
      }

      if (e.target.closest("[data-mac-permission-refresh]")) {
        e.preventDefault();
        e.stopPropagation();
        if (onMacPermissionRefresh) onMacPermissionRefresh(clientId, card);
        return;
      }

      if (e.target.closest("[data-mac-permission-apply]")) {
        e.preventDefault();
        e.stopPropagation();
        if (onMacPermissionApply) onMacPermissionApply(clientId, card);
        return;
      }

      const copyBtn = e.target.closest(".copy-id-btn");
      if (copyBtn) {
        e.stopPropagation();
        const fullId = copyBtn.dataset.copy;
        if (fullId) {
          navigator.clipboard.writeText(fullId).then(() => {
            const icon = copyBtn.querySelector(".copy-id-icon");
            if (icon) { icon.className = "fa-solid fa-check copy-id-icon"; setTimeout(() => { icon.className = "fa-regular fa-copy copy-id-icon"; }, 1200); }
          }).catch(() => {});
        }
        return;
      }

      if (e.target.closest(".command-btn")) {
        e.stopPropagation();
        const rect = e.target.closest(".command-btn").getBoundingClientRect();
        openMenu(clientId, rect.right, rect.bottom);
        return;
      }

      if (e.target.closest(".ban-btn")) {
        e.stopPropagation();
        if (window.banClient) window.banClient(clientId);
        return;
      }

      if (e.target.closest(".kebab-btn")) {
        e.stopPropagation();
        const rect = e.target.closest(".kebab-btn").getBoundingClientRect();
        openMenu(clientId, rect.right, rect.bottom);
        return;
      }

      if (e.target.closest(".cv-webcam-btn")) {
        e.stopPropagation();
        if (onOpenWebcam) onOpenWebcam(clientId);
        return;
      }

      if (e.target.closest(".cv-ping-btn")) {
        e.stopPropagation();
        if (pingClient) pingClient(clientId);
        return;
      }

      if (e.target.closest(".client-tag-toggle")) {
        e.stopPropagation();
        handleTagToggle(card);
        return;
      }

      if (e.target.closest(".hw-toggle")) {
        e.stopPropagation();
        handleHwToggle(card);
        return;
      }

      if (e.target.closest(".cv-expand-btn")) {
        e.stopPropagation();
        handleExpandToggle(card);
        return;
      }

      if (e.target.closest(".cv-plugin-badge")) {
        e.stopPropagation();
        return;
      }

      const thumbHost = e.target.closest("[data-thumb-host]");
      if (thumbHost) {
        e.preventDefault();
        e.stopPropagation();
        if (card.dataset.online === "true") {
          if (pingClient) pingClient(clientId);
          requestThumbnail(clientId);
        }
        const thumbImg = thumbHost.querySelector("img[data-thumb-img]");
        const src = thumbImg?.currentSrc || thumbImg?.src || "";
        if (src) openModal(src);
        return;
      }

      if (card._longPressTriggered) {
        card._longPressTriggered = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.target.closest("button")) return;
      if (e.target.closest(".client-checkbox")) return;
      const checkbox = card.querySelector(".client-checkbox");
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        if (checkbox && !checkbox.disabled) {
          checkbox.checked = !checkbox.checked;
          if (window.toggleClientSelection) window.toggleClientSelection(clientId);
        }
        return;
      }
      if (card.dataset.online !== "true") return;
      if (pingClient) pingClient(clientId);
      requestThumbnail(clientId);
    });

    grid.addEventListener("contextmenu", (e) => {
      const card = e.target.closest(ROW_SELECTOR);
      if (!card || isViewer) return;
      e.preventDefault();
      openMenu(card.dataset.id, e.clientX, e.clientY);
    });

    grid.addEventListener("pointerdown", (e) => {
      if (isViewer || e.pointerType !== "touch") return;
      if (e.target.closest("button") || e.target.closest(".client-checkbox")) return;
      const card = e.target.closest(ROW_SELECTOR);
      if (!card) return;
      card._longPressTriggered = false;
      card._pointerStartX = e.clientX;
      card._pointerStartY = e.clientY;
      clearTimeout(card._longPressTimer);
      card._longPressTimer = setTimeout(() => {
        card._longPressTriggered = true;
        openMenu(card.dataset.id, e.clientX, e.clientY);
      }, TOUCH_LONG_PRESS_MS);
    });

    grid.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "touch") return;
      const card = e.target.closest(ROW_SELECTOR);
      if (!card || !card._longPressTimer) return;
      if (
        Math.abs(e.clientX - card._pointerStartX) > TOUCH_MOVE_CANCEL_PX ||
        Math.abs(e.clientY - card._pointerStartY) > TOUCH_MOVE_CANCEL_PX
      ) {
        clearTimeout(card._longPressTimer);
        card._longPressTimer = null;
      }
    });

    const clearLongPress = (e) => {
      if (e.pointerType !== "touch") return;
      const card = e.target.closest(ROW_SELECTOR);
      if (card) { clearTimeout(card._longPressTimer); card._longPressTimer = null; }
    };
    grid.addEventListener("pointerup", clearLongPress);
    grid.addEventListener("pointercancel", clearLongPress);
    grid.addEventListener("pointerleave", clearLongPress, true);
  }

  async function handleBookmarkClick(card, btn) {
    const id = card.dataset.id;
    const isBookmarked = card.dataset.bookmarked === "true";
    try {
      const res = await fetch(`/api/clients/${id}/bookmark`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookmarked: !isBookmarked }),
      });
      if (res.ok) {
        card.dataset.bookmarked = String(!isBookmarked);
        const icon = btn.querySelector("i");
        if (icon) {
          icon.classList.toggle("fa-solid", !isBookmarked);
          icon.classList.toggle("fa-regular", isBookmarked);
        }
        btn.classList.toggle("is-on", !isBookmarked);
        btn.title = !isBookmarked ? "Remove bookmark" : "Bookmark";
      }
    } catch (err) {
      console.error("bookmark toggle failed", err);
    }
  }

  function handleTagToggle(card) {
    const notePanel = card.querySelector(".client-tag-note");
    if (!notePanel) return;
    const expanded = notePanel.classList.toggle("hidden") === false;
    card.dataset.tagNoteExpanded = expanded ? "true" : "false";
    const tagToggle = card.querySelector(".client-tag-toggle");
    tagToggle?.setAttribute("aria-expanded", expanded ? "true" : "false");
    const chevron = tagToggle?.querySelector(".fa-chevron-up, .fa-chevron-down");
    if (chevron) {
      chevron.classList.toggle("fa-chevron-up", expanded);
      chevron.classList.toggle("fa-chevron-down", !expanded);
    }
  }

  function handleHwToggle(card) {
    const hwPanel = card.querySelector(".hw-panel");
    if (!hwPanel) return;
    const expanded = hwPanel.classList.toggle("hidden") === false;
    card.dataset.hwExpanded = expanded ? "true" : "false";
    const hwToggle = card.querySelector(".hw-toggle");
    hwToggle?.setAttribute("aria-expanded", expanded ? "true" : "false");
    const chevron = hwToggle?.querySelector(".fa-chevron-up, .fa-chevron-down");
    if (chevron) {
      chevron.classList.toggle("fa-chevron-up", expanded);
      chevron.classList.toggle("fa-chevron-down", !expanded);
    }
  }

  function handleExpandToggle(card) {
    const panel = card.querySelector(".cv-expand-panel");
    if (!panel) return;
    const expanded = panel.classList.toggle("hidden") === false;
    card.dataset.expanded = expanded ? "true" : "false";
    const btn = card.querySelector(".cv-expand-btn");
    btn?.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function reorderCards(items) {
    const container = getCardContainer();
    const cards = container.querySelectorAll(ROW_SELECTOR);
    let needsReorder = cards.length !== items.length;
    if (!needsReorder) {
      for (let i = 0; i < items.length; i++) {
        if (cards[i]?.dataset?.id !== items[i].id) { needsReorder = true; break; }
      }
    }
    if (!needsReorder) return;
    const byId = new Map();
    cards.forEach((card) => byId.set(card.dataset.id, card));
    items.forEach((client) => {
      const card = byId.get(client.id);
      if (card) container.appendChild(card);
    });
  }

  function dashboardBadges(client) {
    if (typeof getDashboardBadges !== "function") return [];
    const badges = getDashboardBadges(client) || [];
    return Array.isArray(badges) ? badges.slice(0, 8) : [];
  }

  function dashboardBadgesDigest(client) {
    return JSON.stringify(dashboardBadges(client).map((badge) => ({
      id: badge.id,
      pluginId: badge.pluginId,
      label: badge.label,
      title: badge.title,
      icon: badge.icon,
      imageUrl: badge.imageUrl,
      href: badge.href,
      tone: badge.tone,
      priority: badge.priority,
    })));
  }

  function dashboardBadgesHtml(client) {
    return dashboardBadges(client)
      .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0))
      .map((badge) => {
        const label = String(badge.label || badge.title || badge.pluginId || "Plugin");
        const title = String(badge.title || label);
        const tone = String(badge.tone || "info").replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "info";
        const icon = String(badge.icon || "").replace(/[^a-z0-9_\- ]/gi, "").trim();
        const imageUrl = String(badge.imageUrl || "").trim();
        const href = String(badge.href || "").trim();
        const visual = imageUrl
          ? `<img src="${escapeHtml(imageUrl)}" alt="">`
          : `<i class="${escapeHtml(icon || "fa-solid fa-puzzle-piece")}"></i>`;
        const inner = `${visual}<span>${escapeHtml(label)}</span>`;
        const attrs = `class="cv-mini-pill cv-plugin-badge cv-plugin-badge-${escapeHtml(tone)}" title="${escapeHtml(title)}"`;
        return href
          ? `<a ${attrs} href="${escapeHtml(href)}" target="_blank" rel="noopener">${inner}</a>`
          : `<span ${attrs}>${inner}</span>`;
      })
      .join("");
  }

  function cardDigest(c) {
    return `${currentDisplayDigest}|${currentLayout}|${dashboardBadgesDigest(c)}|${c.id}|${!!c.online}|${c.lastSeen}|${c.pingMs}|${c.host}|${c.user}|${c.os}|${c.arch}|${c.version}|${c.monitors}|${c.country}|${c.nickname}|${c.customTag}|${c.customTagNote}|${!!c.bookmarked}|${!!c.isAdmin}|${c.elevation}|${JSON.stringify(c.permissions || {})}|${c.cpu}|${c.gpu}|${c.ram}|${c.batteryPercent}|${c.batteryCharging}|${!!c.webcamAvailable}|${JSON.stringify(c.webcamDevices || [])}|${c.hwid}|${c.disconnectReason}|${c.disconnectDetail}|${c.groupId}|${c.groupName}|${c.groupColor}|${!!c.notificationsMuted}`;
  }

  function cardThumbDigest(c) {
    return `${!!c.hasThumbnail}|${Number(c.thumbnailVersion) || 0}`;
  }

  function softThumbUpdate(card, client) {
    const host = card.querySelector("[data-thumb-host]");
    if (!host) return;
    const newVersion = Number(client.thumbnailVersion) || 0;
    host.dataset.thumbVersion = String(newVersion);
    host.dataset.thumbOnline = client.online ? "1" : "0";
    if (!client.hasThumbnail) return;
    const img = host.querySelector("img[data-thumb-img]");
    if (!img) return;
    const url = `/api/clients/${encodeURIComponent(client.id)}/thumbnail${newVersion ? `?v=${newVersion}` : ""}`;
    applyImageSrcSmooth(img, url);
  }

  function renderMerge(data, options = {}) {
    setupGridDelegation();
    currentDisplayDigest = displayDigest();
    ensureLayoutScaffold();
    const container = getCardContainer();
    const { reorder = false } = options;
    totalPill.textContent = `${data.online ?? data.total} online / ${data.total} total`;
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    if (pageLabel) pageLabel.textContent = "Page";
    if (typeof window.setDashboardPageBounds === "function") {
      window.setDashboardPageBounds(data.page, totalPages);
    }
    prevBtnState(data.page, totalPages);

    const items = data.items || [];
    const seen = new Set();
    const newClients = [];
    const renderId = ++renderToken;
    const largeClientSet = (Number(data.total) || 0) >= LARGE_CLIENT_THRESHOLD;
    document.documentElement.classList.toggle("large-client-set", largeClientSet);
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const existingCards = container.querySelectorAll(ROW_SELECTOR);
    const hadCards = existingCards.length > 0;
    const existingById = new Map();
    existingCards.forEach((card) => existingById.set(card.dataset.id, card));

    const uninstallingIds = window.__uninstallingClientIds;

    items.forEach((client) => {
      seen.add(client.id);
      if (uninstallingIds && uninstallingIds.has(client.id)) return;
      const existing = existingById.get(client.id);
      if (existing) {
        if (existing.classList.contains("card-uninstalling")) return;
        const digest = cardDigest(client);
        const thumbDigest = cardThumbDigest(client);
        const structureChanged = existing._cardDigest !== digest;
        const thumbChanged = existing._thumbDigest !== thumbDigest;
        if (!structureChanged && !thumbChanged) return;
        if (structureChanged) {
          existing._cardDigest = digest;
          existing._thumbDigest = thumbDigest;
          updateCard(existing, client);
        } else {
          existing._thumbDigest = thumbDigest;
          softThumbUpdate(existing, client);
        }
        return;
      }
      newClients.push(client);
    });

    Array.from(existingCards)
      .filter((el) => !seen.has(el.dataset.id) && !el.classList.contains("card-uninstalling"))
      .forEach((el) => el.remove());

    if (reorder) {
      reorderCards(items);
    }

    if (newClients.length === 0) return;

    const allowAnimation = MAX_ANIMATED_CARDS > 0 && !largeClientSet && !hadCards && !prefersReducedMotion && items.length <= 1000 && currentLayout !== "table";
    const animateLimit = Math.min(newClients.length, MAX_ANIMATED_CARDS);

    let idx = 0;
    const insertBatch = () => {
      if (renderId !== renderToken) return;
      const fragment = document.createDocumentFragment();
      for (
        let batch = 0;
        batch < INSERT_BATCH_SIZE && idx < newClients.length;
        batch++, idx++
      ) {
        const client = newClients[idx];
        const shouldAnimate = allowAnimation && idx < animateLimit;
        const card = buildCard(client, {
          animate: shouldAnimate,
          delayIndex: idx,
        });
        fragment.appendChild(card);
      }
      container.appendChild(fragment);
      if (idx < newClients.length) {
        requestAnimationFrame(insertBatch);
        return;
      }
      reorderCards(items);
    };

    insertBatch();
  }

  function prevBtnState(currentPage, totalPages) {
    const prevBtn = document.getElementById("prev");
    const nextBtn = document.getElementById("next");
    if (prevBtn) prevBtn.disabled = currentPage <= 1;
    if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
  }

  function setSharedDataset(el, client) {
    el.dataset.clientRow = currentLayout;
    el.dataset.id = client.id;
    el.dataset.hwid = client.hwid || "";
    el.dataset.online = String(!!client.online);
    el.dataset.os = String(client.os || "").toLowerCase();
    el.dataset.nickname = String(client.nickname || "");
    el.dataset.customTag = String(client.customTag || "");
    el.dataset.bookmarked = String(!!client.bookmarked);
    el.dataset.notificationsMuted = String(!!client.notificationsMuted);
    el.dataset.hasWebcam = String(!!client.webcamAvailable);
    el.dataset.admin = String(!!client.isAdmin);
    el.dataset.groupId = String(client.groupId || "");
    el.dataset.groupName = String(client.groupName || "");
    el.dataset.groupColor = String(client.groupColor || "");
    el._customTagNote = String(client.customTagNote || "");
    if (!client.bookmarked && client.groupColor) {
      el.style.setProperty("--group-color", client.groupColor);
    } else {
      el.style.removeProperty("--group-color");
    }
  }

  function buildCard(client, options = {}) {
    const node =
      currentLayout === "table"
        ? buildRowB(client, options)
        : currentLayout === "cards"
          ? buildCardC(client, options)
          : buildRowA(client, options);

    node._cardDigest = cardDigest(client);
    node._thumbDigest = cardThumbDigest(client);

    if (options.animate && currentLayout !== "table") {
      node.classList.add("card-animate");
      node.style.animationDelay = `${(options.delayIndex || 0) * 0.05}s`;
      node.style.opacity = "0";
      node.style.transform = "translateY(10px)";
      if (typeof anime !== "undefined") {
        requestAnimationFrame(() => {
          anime({
            targets: node,
            opacity: [0, 1],
            translateY: [10, 0],
            duration: 400,
            easing: "easeOutQuad",
          });
        });
      }
    }

    return node;
  }

  function webcamButtonHtml(client, extraClass = "") {
    if (!client.webcamAvailable || isViewer) return "";
    return `<button type="button" class="cv-icon-btn cv-webcam-btn ${extraClass}" title="Open webcam" aria-label="Open webcam"><i class="fa-solid fa-video"></i></button>`;
  }

  function webcamBadgeHtml(client) {
    if (!client.webcamAvailable || isViewer) return "";
    return `<button type="button" class="cv-mini-pill cv-pill-webcam cv-webcam-btn" title="Open webcam" aria-label="Open webcam"><i class="fa-solid fa-video"></i></button>`;
  }

  function updateCard(card, client) {
    const wasChecked = card.querySelector(".client-checkbox")?.checked || false;
    const wasTagNoteExpanded = card.dataset.tagNoteExpanded === "true";
    const wasHwExpanded = card.dataset.hwExpanded === "true";
    const wasExpanded = card.dataset.expanded === "true";

    const fresh = buildCard(client, { animate: false });

    fresh.dataset.tagNoteExpanded = wasTagNoteExpanded ? "true" : "false";
    fresh.dataset.hwExpanded = wasHwExpanded ? "true" : "false";
    fresh.dataset.expanded = wasExpanded ? "true" : "false";
    if (wasTagNoteExpanded) fresh.querySelector(".client-tag-note")?.classList.remove("hidden");
    if (wasHwExpanded) fresh.querySelector(".hw-panel")?.classList.remove("hidden");
    if (wasExpanded) fresh.querySelector(".cv-expand-panel")?.classList.remove("hidden");

    const cb = fresh.querySelector(".client-checkbox");
    if (cb) {
      const isSelected = typeof window.isClientSelected === "function"
        ? window.isClientSelected(client.id)
        : false;
      if ((wasChecked || isSelected) && client.online) cb.checked = true;
    }

    card.replaceWith(fresh);
  }

  /* ── VARIANT A: Row cards ─────────────────────────────────────── */

  function buildRowA(client, _options) {
    const article = document.createElement("article");
    article.className = `cv-row ${client.online ? "" : "cv-offline"} ${client.bookmarked ? "is-bookmarked" : ""}`;
    setSharedDataset(article, client);

    const os = osBadge(client.os || "unknown");
    const arch = archBadge(client.arch || "");
    const ver = versionBadge(client.version || "");
    const mons = monitorsBadge(client.monitors);
    const deviceId = shortId(client.id);
    const hwid = shortId(client.hwid || "");
    const nickname = String(client.nickname || "").trim();
    const customTag = String(client.customTag || "").trim();
    const customTagNote = String(client.customTagNote || "");
    const displayName = nickname || client.host || deviceId;
    const userLine = client.user || client.host || deviceId;
    const hasTagNote = customTag.length > 0 && customTagNote.length > 0;
    const showHardware = showField("hardware");
    const showBattery = showField("battery");
    const cpuHtml = client.cpu ? cpuBadgeHtml(client.cpu) : "—";
    const batteryIndicator = showBattery ? batteryHtml(client) : "";
    const verLatest = isClientVersionCurrent(client.version, typeof getServerVersion === "function" ? getServerVersion() : "");
    const pluginBadges = dashboardBadgesHtml(client);

    const metaParts = [
      showField("system") ? `<span class="cv-os cv-tone-${os.tone}"><i class="fa ${os.icon}"></i> ${escapeHtml(shortOsLabel(client.os))}</span>` : "",
      showField("system") ? `<span class="cv-arch cv-tone-${arch.tone}">${escapeHtml(arch.label)}</span>` : "",
      showField("version") ? `<span class="cv-ver"><i class="fa ${ver.icon}"></i> ${escapeHtml(ver.label)}</span>` : "",
      showField("monitors") ? `<span class="cv-mons"><i class="fa fa-display"></i> ${client.monitors || 1}</span>` : "",
      nickname && client.host && nickname !== client.host ? `<span class="cv-host"><i class="fa-solid fa-laptop"></i> ${escapeHtml(client.host)}</span>` : "",
      showField("ip") && client.ip ? `<span class="cv-ip cv-mono"><i class="fa-solid fa-network-wired"></i> ${escapeHtml(client.ip)}</span>` : "",
      showField("hwid") && hwid ? `<span class="cv-hwid cv-mono" title="HWID ${escapeHtml(client.hwid || "")}"><i class="fa-solid fa-fingerprint"></i> ${escapeHtml(hwid)}</span>` : "",
      batteryIndicator,
    ].filter(Boolean);
    const meta = metaParts.join(metaSeparator());

    article.innerHTML = `
      <span class="cv-edge"></span>
      <label class="cv-checkbox">
        <input type="checkbox" class="client-checkbox" data-id="${escapeHtml(client.id)}" ${client.online ? "" : "disabled"}>
        <span class="cv-checkbox-box"><i class="fa-solid fa-check"></i></span>
      </label>
      <button class="bookmark-btn cv-star ${client.bookmarked ? "is-on" : ""}" data-id="${escapeHtml(client.id)}" title="${client.bookmarked ? "Remove bookmark" : "Bookmark"}">
        <i class="fa-${client.bookmarked ? "solid" : "regular"} fa-star"></i>
      </button>
      <div class="cv-thumb-wrap">${thumbHtml(client, { width: 168, height: 96, small: false })}</div>
      <div class="cv-primary">
        <div class="cv-name-line">
          ${statusDot(client)}
          <span class="cv-flag">${countryToFlag(client.country)}</span>
          <span class="cv-name">${escapeHtml(displayName)}</span>
          ${client.isAdmin ? `<span class="cv-mini-pill cv-pill-admin" title="Admin"><i class="fa-solid fa-shield-halved"></i></span>` : ""}
          ${client.elevation === "system" ? `<span class="cv-mini-pill cv-pill-system" title="SYSTEM"><i class="fa-solid fa-gear"></i></span>` : ""}
          ${client.elevation === "trustedinstaller" ? `<span class="cv-mini-pill cv-pill-ti" title="TrustedInstaller"><i class="fa-solid fa-lock"></i></span>` : ""}
          ${webcamBadgeHtml(client)}
          ${macPermissionBadgeHtml(client)}
          ${client.notificationsMuted ? `<span class="cv-mini-pill cv-pill-muted" title="Notifications muted"><i class="fa-solid fa-bell-slash"></i></span>` : ""}
          ${pluginBadges}
        </div>
        ${showField("user") ? `<div class="cv-user-line"><i class="fa-solid fa-user"></i> ${escapeHtml(userLine)}</div>` : ""}
        ${meta ? `<div class="cv-meta-line">${meta}</div>` : ""}
        ${customTag ? `<button type="button" class="client-tag-toggle cv-tag ${hasTagNote ? "has-note" : ""}" ${hasTagNote ? `aria-expanded="false"` : `disabled aria-disabled="true"`}><i class="fa-solid fa-tag"></i> ${escapeHtml(customTag)}${hasTagNote ? ` <i class="fa-solid fa-chevron-down"></i>` : ""}</button>` : ""}
        ${hasTagNote ? `<div class="client-tag-note hidden">${escapeHtml(customTagNote)}</div>` : ""}
      </div>
      <div class="cv-time">
        <span class="cv-time-line"><i class="fa-regular fa-clock"></i> ${formatAgo(client.lastSeen)}</span>
        <span class="cv-ping-line ${pingTone(client.pingMs)}"><i class="fa-solid fa-satellite-dish"></i> ${formatPing(client.pingMs)}</span>
      </div>
      ${showField("group") ? `<div class="cv-group-cell">${groupPillHtml(client) || `<span class="cv-group-empty">—</span>`}</div>` : ""}
      <div class="cv-spacer"></div>
      <div class="cv-actions">
        ${isViewer ? "" : `<button class="command-btn cv-btn-primary" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-terminal"></i><span>Commands</span></button>`}
        ${webcamButtonHtml(client)}
        <button class="cv-icon-btn cv-ping-btn" title="Ping" ${client.online ? "" : "disabled"}><i class="fa-solid fa-satellite-dish"></i></button>
        ${isViewer ? "" : `<button class="cv-icon-btn cv-icon-danger ban-btn" title="Ban IP" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-ban"></i></button>`}
        <button class="cv-icon-btn cv-expand-btn" title="More info" aria-expanded="false"><i class="fa-solid fa-chevron-down"></i></button>
      </div>
      <div class="cv-expand-panel hidden">
        <div class="cv-expand-grid">
          <div class="cv-field"><span class="cv-field-label">ID</span><span class="cv-field-value cv-mono copy-id-btn" data-copy="${escapeHtml(client.id)}" title="Copy full ID">${escapeHtml(deviceId)} <i class="fa-regular fa-copy copy-id-icon"></i></span></div>
          ${showField("hwid") ? `<div class="cv-field"><span class="cv-field-label">Hardware ID</span><span class="cv-field-value cv-mono">${escapeHtml(hwid || "—")}</span></div>` : ""}
          ${showField("ip") ? `<div class="cv-field"><span class="cv-field-label">IP</span><span class="cv-field-value cv-mono">${escapeHtml(client.ip || "—")}</span></div>` : ""}
          ${showField("system") ? `<div class="cv-field"><span class="cv-field-label">OS</span><span class="cv-field-value">${escapeHtml(client.os || "Unknown")} ${escapeHtml(arch.label)}</span></div>` : ""}
          ${showHardware ? `<div class="cv-field"><span class="cv-field-label">CPU</span><span class="cv-field-value">${cpuHtml}</span></div>` : ""}
          ${showHardware ? `<div class="cv-field"><span class="cv-field-label">RAM</span><span class="cv-field-value">${escapeHtml(client.ram || "—")}</span></div>` : ""}
          ${batteryIndicator ? `<div class="cv-field"><span class="cv-field-label">Battery</span><span class="cv-field-value">${batteryIndicator}</span></div>` : ""}
          ${macPermissionDetailHtml(client)}
          ${showHardware && client.gpu ? `<div class="cv-field cv-field-wide"><span class="cv-field-label">GPU</span><span class="cv-field-value">${escapeHtml(client.gpu)}</span></div>` : ""}
          ${showField("version") && !verLatest && client.version ? `<div class="cv-field"><span class="cv-field-label">Version</span><span class="cv-field-value cv-warn">v${escapeHtml(client.version)} (outdated)</span></div>` : ""}
        </div>
      </div>
    `;
    return article;
  }

  /* ── VARIANT B: Dense table ───────────────────────────────────── */

  function buildRowB(client, _options) {
    const tr = document.createElement("tr");
    tr.className = `cv-trow ${client.online ? "" : "cv-offline"} ${client.bookmarked ? "is-bookmarked" : ""}`;
    setSharedDataset(tr, client);

    const os = osBadge(client.os || "unknown");
    const arch = archBadge(client.arch || "");
    const deviceId = shortId(client.id);
    const nickname = String(client.nickname || "").trim();
    const displayName = nickname || client.host || deviceId;
    const userLine = client.user || client.host || deviceId;
    const pluginBadges = dashboardBadgesHtml(client);
    const userMeta = [
      showField("user") ? `<i class="fa-solid fa-user"></i> ${escapeHtml(userLine)}` : "",
      showField("ip") && client.ip ? `<span class="cv-mid">·</span><i class="fa-solid fa-network-wired"></i> ${escapeHtml(client.ip)}` : "",
      showField("hwid") && client.hwid ? `<span class="cv-mid">·</span><i class="fa-solid fa-fingerprint"></i> ${escapeHtml(shortId(client.hwid))}` : "",
    ].filter(Boolean).join("");

    tr.innerHTML = `
      <td class="cv-td-check">
        <label class="cv-checkbox">
          <input type="checkbox" class="client-checkbox" data-id="${escapeHtml(client.id)}" ${client.online ? "" : "disabled"}>
          <span class="cv-checkbox-box"><i class="fa-solid fa-check"></i></span>
        </label>
      </td>
      <td class="cv-td-star">
        <button class="bookmark-btn cv-star ${client.bookmarked ? "is-on" : ""}" data-id="${escapeHtml(client.id)}" title="${client.bookmarked ? "Remove bookmark" : "Bookmark"}">
          <i class="fa-${client.bookmarked ? "solid" : "regular"} fa-star"></i>
        </button>
      </td>
      <td class="cv-td-thumb">${thumbHtml(client, { width: 80, height: 50, small: true })}</td>
      <td class="cv-td-client">
        <div class="cv-tcell-client">
          <span class="cv-flag">${countryToFlag(client.country)}</span>
          <div class="cv-tcell-stack">
            <span class="cv-tcell-name-row">
              <span class="cv-name">${escapeHtml(displayName)}</span>
              ${client.isAdmin ? `<span class="cv-mini-pill cv-pill-admin" title="Admin"><i class="fa-solid fa-shield-halved"></i></span>` : ""}
              ${client.elevation === "system" ? `<span class="cv-mini-pill cv-pill-system" title="SYSTEM"><i class="fa-solid fa-gear"></i></span>` : ""}
              ${client.elevation === "trustedinstaller" ? `<span class="cv-mini-pill cv-pill-ti" title="TI"><i class="fa-solid fa-lock"></i></span>` : ""}
              ${webcamBadgeHtml(client)}
              ${macPermissionBadgeHtml(client)}
              ${client.notificationsMuted ? `<span class="cv-mini-pill cv-pill-muted" title="Notifications muted"><i class="fa-solid fa-bell-slash"></i></span>` : ""}
              ${pluginBadges}
            </span>
            ${userMeta ? `<span class="cv-user-line cv-mono">${userMeta}</span>` : ""}
          </div>
        </div>
      </td>
      <td class="cv-td-status">
        <span class="cv-status-cell">${statusDot(client)} ${client.online ? "Online" : "Offline"}</span>
      </td>
      <td class="cv-td-last cv-tab-num">${formatAgo(client.lastSeen)}</td>
      ${showField("system") ? `<td class="cv-td-system">
        <span class="cv-system-cell"><span class="cv-os cv-tone-${os.tone}"><i class="fa ${os.icon}"></i> ${escapeHtml(shortOsLabel(client.os))}</span> <span class="cv-arch-chip cv-tone-${arch.tone}">${escapeHtml(arch.label)}</span></span>
      </td>` : ""}
      <td class="cv-td-ping cv-tab-num cv-mono ${pingTone(client.pingMs)}">${formatPing(client.pingMs)}</td>
      ${showField("group") ? `<td class="cv-td-group">${groupPillHtml(client) || `<span class="cv-group-empty">—</span>`}</td>` : ""}
      <td class="cv-td-actions">
        <div class="cv-actions cv-actions-table">
          ${isViewer ? "" : `<button class="command-btn cv-btn-primary cv-btn-sm" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-terminal"></i><span>Commands</span></button>`}
          ${webcamButtonHtml(client, "cv-icon-sm")}
          ${isViewer ? "" : `<button class="cv-icon-btn cv-icon-sm kebab-btn" title="More" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-ellipsis-vertical"></i></button>`}
        </div>
      </td>
    `;
    return tr;
  }

  /* ── VARIANT C: Card wall ─────────────────────────────────────── */

  function buildCardC(client, _options) {
    const article = document.createElement("article");
    article.className = `cv-card ${client.online ? "" : "cv-offline"} ${client.bookmarked ? "is-bookmarked" : ""}`;
    setSharedDataset(article, client);

    const os = osBadge(client.os || "unknown");
    const arch = archBadge(client.arch || "");
    const ver = versionBadge(client.version || "");
    const deviceId = shortId(client.id);
    const hwidShort = shortId(client.hwid || "");
    const nickname = String(client.nickname || "").trim();
    const customTag = String(client.customTag || "").trim();
    const displayName = nickname || client.host || deviceId;
    const userLine = client.user || "unknown";
    const verLatest = isClientVersionCurrent(client.version, typeof getServerVersion === "function" ? getServerVersion() : "");
    const hasGroup = !!String(client.groupName || "").trim();
    const showHost = nickname && client.host && nickname !== client.host;
    const showHardware = showField("hardware");
    const cpuHtml = showHardware && client.cpu ? cpuBadgeHtml(client.cpu) : "";
    const batteryIndicator = showField("battery") ? batteryHtml(client, { compact: true }) : "";
    const macPermDetail = macPermissionDetailHtml(client);

    const metaParts = [
      showField("system") ? `<span class="cv-card-meta-bit cv-tone-${os.tone}"><i class="fa ${os.icon}"></i> ${escapeHtml(shortOsLabel(client.os))}</span>` : "",
      showField("system") ? `<span class="cv-card-meta-bit cv-tone-${arch.tone}">${escapeHtml(arch.label)}</span>` : "",
      showField("monitors") ? `<span class="cv-card-meta-bit"><i class="fa fa-display"></i> ${client.monitors || 1}</span>` : "",
      showField("version") && client.version ? `<span class="cv-card-meta-bit ${verLatest ? "" : "cv-warn"}"><i class="fa fa-tag"></i> v${escapeHtml(client.version)}</span>` : "",
    ].filter(Boolean).join("");

    const elevationBadges = [
      client.isAdmin ? `<span class="cv-mini-pill cv-pill-admin" title="Admin"><i class="fa-solid fa-shield-halved"></i></span>` : "",
      client.elevation === "system" ? `<span class="cv-mini-pill cv-pill-system" title="SYSTEM"><i class="fa-solid fa-gear"></i></span>` : "",
      client.elevation === "trustedinstaller" ? `<span class="cv-mini-pill cv-pill-ti" title="TrustedInstaller"><i class="fa-solid fa-lock"></i></span>` : "",
      webcamBadgeHtml(client),
      macPermissionBadgeHtml(client),
      client.notificationsMuted ? `<span class="cv-mini-pill cv-pill-muted" title="Notifications muted"><i class="fa-solid fa-bell-slash"></i></span>` : "",
      dashboardBadgesHtml(client),
    ].join("");

    article.innerHTML = `
      <header class="cv-card-header">
        ${thumbHtml(client, { width: 290, height: 130, small: false })}
        <label class="cv-checkbox cv-card-check">
          <input type="checkbox" class="client-checkbox" data-id="${escapeHtml(client.id)}" ${client.online ? "" : "disabled"}>
          <span class="cv-checkbox-box"><i class="fa-solid fa-check"></i></span>
        </label>
        <div class="cv-card-chips">
          <button class="bookmark-btn cv-chip-btn ${client.bookmarked ? "is-on" : ""}" data-id="${escapeHtml(client.id)}" title="${client.bookmarked ? "Remove bookmark" : "Bookmark"}">
            <i class="fa-${client.bookmarked ? "solid" : "regular"} fa-star"></i>
          </button>
          ${isViewer ? "" : `<button class="cv-chip-btn kebab-btn" title="More" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-ellipsis-vertical"></i></button>`}
        </div>
        <div class="cv-card-status">
          ${statusDot(client)} <span>${client.online ? "Online" : "Offline"}</span> <span class="cv-mid">·</span> <span class="cv-card-ago">${formatAgo(client.lastSeen)}</span>
        </div>
        <div class="cv-card-ping ${pingTone(client.pingMs)}">
          <i class="fa-solid fa-satellite-dish"></i> <span class="cv-mono">${formatPing(client.pingMs)}</span>
        </div>
      </header>
      <div class="cv-card-body">
        <div class="cv-name-line">
          <span class="cv-flag">${countryToFlag(client.country)}</span>
          <span class="cv-name">${escapeHtml(displayName)}</span>
          ${elevationBadges}
        </div>
        ${showField("user") ? `<div class="cv-user-line cv-mono"><i class="fa-solid fa-user"></i> ${escapeHtml(userLine)}${showHost ? ` <span class="cv-text-dim">@ ${escapeHtml(client.host)}</span>` : ""}</div>` : ""}
        ${customTag ? `<div class="cv-card-tag"><i class="fa-solid fa-tag"></i> ${escapeHtml(customTag)}</div>` : ""}
        <div class="cv-card-net">
          ${showField("ip") && client.ip ? `<span class="cv-card-net-bit"><i class="fa-solid fa-network-wired"></i> <span class="cv-mono">${escapeHtml(client.ip)}</span></span>` : ""}
          ${showField("hwid") && hwidShort ? `<span class="cv-card-net-bit"><i class="fa-solid fa-fingerprint"></i> <span class="cv-mono">${escapeHtml(hwidShort)}</span></span>` : ""}
        </div>
        ${metaParts || (showField("group") && hasGroup) ? `<div class="cv-card-meta">
          ${metaParts}
          ${showField("group") && hasGroup ? `<span class="cv-group-spacer">${groupPillHtml(client)}</span>` : ""}
        </div>` : ""}
        ${cpuHtml || (showHardware && client.ram) || batteryIndicator ? `<div class="cv-card-hw">
          ${cpuHtml}
          ${showHardware && client.ram ? `<span class="cv-card-hw-bit"><i class="fa-solid fa-memory"></i> ${escapeHtml(client.ram)}</span>` : ""}
          ${batteryIndicator}
        </div>` : ""}
        ${macPermDetail ? `<div class="cv-card-perms">${macPermDetail}</div>` : ""}
        <div class="cv-card-actions">
          ${isViewer ? "" : `<button class="command-btn cv-btn-primary cv-btn-flex" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-terminal"></i><span>Commands</span></button>`}
          ${webcamButtonHtml(client)}
          <button class="cv-icon-btn cv-ping-btn" title="Ping" ${client.online ? "" : "disabled"}><i class="fa-solid fa-satellite-dish"></i></button>
          ${isViewer ? "" : `<button class="cv-icon-btn cv-icon-danger ban-btn" title="Ban IP" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-ban"></i></button>`}
        </div>
      </div>
    `;
    return article;
  }
  setupGridDelegation();


  return { renderMerge, setLayout };
}
