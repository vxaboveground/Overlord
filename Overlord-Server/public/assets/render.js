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

function cardDigest(c) {
  return `${c.id}|${!!c.online}|${c.lastSeen}|${c.pingMs}|${c.host}|${c.user}|${c.os}|${c.arch}|${c.version}|${c.monitors}|${c.thumbnail}|${c.country}|${c.nickname}|${c.customTag}|${c.customTagNote}|${!!c.bookmarked}|${!!c.isAdmin}|${c.elevation}|${c.cpu}|${c.gpu}|${c.ram}|${c.hwid}|${c.disconnectReason}|${c.disconnectDetail}|${JSON.stringify(c.permissions)}|${c.groupId}|${c.groupName}|${c.groupColor}`;
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

  /* ── Event delegation ─────────────────────────────────────────── */

  function setupGridDelegation() {
    if (gridDelegated) return;
    gridDelegated = true;

    grid.addEventListener("click", (e) => {
      const card = e.target.closest("article[data-id]");
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

      if (e.target.closest(".panel-btn")) {
        e.stopPropagation();
        window.location.href = `/${clientId}/panel`;
        return;
      }

      if (e.target.closest(".ban-btn")) {
        e.stopPropagation();
        if (window.banClient) window.banClient(clientId);
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
      const card = e.target.closest("article[data-id]");
      if (!card || isViewer) return;
      e.preventDefault();
      openMenu(card.dataset.id, e.clientX, e.clientY);
    });

    grid.addEventListener("pointerdown", (e) => {
      if (isViewer || e.pointerType !== "touch") return;
      if (e.target.closest("button") || e.target.closest(".client-checkbox")) return;
      const card = e.target.closest("article[data-id]");
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
      const card = e.target.closest("article[data-id]");
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
      const card = e.target.closest("article[data-id]");
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
        if (!isBookmarked) {
          btn.classList.remove("border-slate-700", "bg-slate-800/50", "text-slate-500");
          btn.classList.add("border-yellow-600", "bg-yellow-900/50", "text-yellow-300");
          card.classList.remove("border-slate-800");
          card.classList.add("border-yellow-600/60");
          if (icon) { icon.classList.remove("fa-regular"); icon.classList.add("fa-solid"); }
          btn.title = "Remove bookmark";
        } else {
          btn.classList.remove("border-yellow-600", "bg-yellow-900/50", "text-yellow-300");
          btn.classList.add("border-slate-700", "bg-slate-800/50", "text-slate-500");
          card.classList.remove("border-yellow-600/60");
          card.classList.add("border-slate-800");
          if (icon) { icon.classList.remove("fa-solid"); icon.classList.add("fa-regular"); }
          btn.title = "Bookmark";
        }
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


  function reorderCards(items) {
    const cards = grid.querySelectorAll("article[data-id]");
    let needsReorder = cards.length !== items.length;
    if (!needsReorder) {
      for (let i = 0; i < items.length; i++) {
        if (cards[i]?.dataset?.id !== items[i].id) { needsReorder = true; break; }
      }
    }
    if (!needsReorder) return;
    items.forEach((client) => {
      const card = grid.querySelector(`article[data-id="${client.id}"]`);
      if (card) grid.appendChild(card);
    });
  }


  function renderMerge(data, options = {}) {
    setupGridDelegation();
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

    const hadCards = grid.querySelectorAll("article[data-id]").length > 0;

    items.forEach((client) => {
      seen.add(client.id);
      const existing = grid.querySelector(`article[data-id="${client.id}"]`);
      if (existing) {
        const digest = cardDigest(client);
        if (existing._cardDigest === digest) return;
        existing._cardDigest = digest;
        updateCard(existing, client);
        return;
      }
      newClients.push(client);
    });

    Array.from(grid.querySelectorAll("article[data-id]"))
      .filter((el) => !seen.has(el.dataset.id))
      .forEach((el) => el.remove());

    if (reorder) {
      reorderCards(items);
    }

    if (newClients.length === 0) {
      return;
    }

    const allowAnimation = !hadCards && !prefersReducedMotion && items.length <= 1000;
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
      grid.appendChild(fragment);
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

  function buildCard(client, options = {}) {
    const card = document.createElement("article");
    card.dataset.id = client.id;
    card.dataset.hwid = client.hwid || "";

    updateCard(card, client);
    card._cardDigest = cardDigest(client);

    if (options.animate) {
      card.classList.add("card-animate");
      card.style.animationDelay = `${(options.delayIndex || 0) * 0.05}s`;
      card.style.opacity = "0";
      card.style.transform = "translateY(10px)";
      if (typeof anime !== "undefined") {
        requestAnimationFrame(() => {
          anime({
            targets: card,
            opacity: [0, 1],
            translateY: [10, 0],
            duration: 400,
            easing: "easeOutQuad",
          });
        });
      }
    }

    return card;
  }

  function updateCard(card, client) {
    const oldCheckbox = card.querySelector(".client-checkbox");
    const wasChecked = oldCheckbox?.checked || false;
    const wasTagNoteExpanded = card.dataset.tagNoteExpanded === "true";
    const wasHwExpanded = card.dataset.hwExpanded === "true";

    card.dataset.online = String(!!client.online);
    card.dataset.os = String(client.os || "").toLowerCase();
    card.dataset.nickname = String(client.nickname || "");
    card.dataset.customTag = String(client.customTag || "");
    card.dataset.bookmarked = String(!!client.bookmarked);
    card.dataset.admin = String(!!client.isAdmin);
    card.dataset.groupId = String(client.groupId || "");
    card.dataset.groupName = String(client.groupName || "");
    card.dataset.groupColor = String(client.groupColor || "");
    card._customTagNote = String(client.customTagNote || "");
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
    const hasTagNote = customTag.length > 0 && customTagNote.length > 0;
    const isTagNoteExpanded = hasTagNote && wasTagNoteExpanded;
    card.dataset.tagNoteExpanded = isTagNoteExpanded ? "true" : "false";
    const groupName = String(client.groupName || "").trim();
    const groupColor = String(client.groupColor || "").trim();
    const hasHwInfo = !!(client.cpu || client.gpu || client.ram);
    const isHwExpanded = hasHwInfo && wasHwExpanded;
    card.dataset.hwExpanded = isHwExpanded ? "true" : "false";
    const dedupeGpu = (raw) => {
      if (!raw) return null;
      const counts = new Map();
      raw.split(",").map(s => s.trim()).filter(Boolean).forEach(g => counts.set(g, (counts.get(g) || 0) + 1));
      return [...counts.entries()].map(([name, n]) => n > 1 ? `${name} <span class="hw-gpu-count">&times;${n}</span>` : escapeHtml(name)).join(", ");
    };
    const gpuHtml = dedupeGpu(client.gpu);
    const borderClass = client.bookmarked ? "border-yellow-600/60" : "border-slate-800";
    card.className = `card rounded-xl border ${borderClass} p-4 ${client.online ? "" : "card-offline"}`;
    if (!client.bookmarked && groupColor) {
      card.style.setProperty("--group-color", groupColor);
    } else {
      card.style.removeProperty("--group-color");
    }
    const cardThumb = client.thumbnail
      ? (() => {
          const wrapper = document.createElement("div");
          wrapper.className = "flex-shrink-0";
          const img = document.createElement("img");
          img.className =
            "w-40 h-24 rounded-lg object-contain cursor-pointer thumb-img";
          img.alt = "preview";
          img.src = client.thumbnail;
          wrapper.appendChild(img);
          return wrapper;
        })()
      : (() => {
          const wrapper = document.createElement("div");
          wrapper.className = "flex-shrink-0";
          wrapper.innerHTML = `<div class="w-40 h-24 rounded-lg border border-dashed border-slate-700 bg-slate-800/40 flex items-center justify-center text-slate-500"><i class="fa-regular fa-image"></i></div>`;
          return wrapper;
        })();

    card.innerHTML = `
      <div class="flex items-center gap-4 flex-wrap">
        <div class="flex-shrink-0 flex items-center">
          <input type="checkbox" class="client-checkbox w-5 h-5 rounded border-slate-600 bg-slate-800 checked:bg-blue-600" data-id="${escapeHtml(client.id)}" ${client.online ? "" : "disabled"}>
        </div>
        <div class="flex-shrink-0"></div>
        <div class="flex-1 min-w-[240px] flex flex-col gap-2">
          <div class="flex items-center gap-3 flex-wrap text-lg font-semibold">
            <span class="text-2xl">${countryToFlag(client.country)}</span>
            <span>${escapeHtml(displayName)}</span>
            ${nickname && client.host ? `<span class="pill pill-ghost text-xs"><i class="fa-solid fa-laptop"></i> ${escapeHtml(client.host)}</span>` : ""}
            ${customTag ? `<button type="button" class="client-tag-toggle pill text-xs border border-amber-700/80 bg-amber-900/30 text-amber-200 ${hasTagNote ? "cursor-pointer hover:bg-amber-800/40" : "cursor-default opacity-90"}" ${hasTagNote ? `aria-expanded="${isTagNoteExpanded ? "true" : "false"}"` : `disabled aria-disabled="true"`}><i class="fa-solid fa-tag"></i> ${escapeHtml(customTag)} ${customTagNote ? `<i class="fa-regular fa-note-sticky"></i><i class="fa-solid ${isTagNoteExpanded ? "fa-chevron-up" : "fa-chevron-down"}"></i>` : ""}</button>` : ""}
            ${groupName ? `<span class="pill text-xs border" style="border-color:${escapeHtml(groupColor)};background:${escapeHtml(groupColor)}22;color:${escapeHtml(groupColor)}"><i class="fa-solid fa-layer-group"></i> ${escapeHtml(groupName)}</span>` : ""}
            <span class="text-slate-300 text-lg font-semibold flex items-center gap-1"><i class="fa-solid fa-user"></i> ${escapeHtml(client.user || "unknown")}</span>
            <span class="pill ${client.online ? "pill-online" : "pill-offline"}">
              <i class="fa-solid fa-circle"></i>
              ${client.online ? "Online" : "Offline"}
            </span>
            ${client.isAdmin ? `<span class="pill pill-admin"><i class="fa-solid fa-shield-halved"></i> Admin</span>` : ""}
            ${client.elevation === "system" ? `<span class="pill pill-system"><i class="fa-solid fa-gear"></i> SYSTEM</span>` : ""}
            ${client.elevation === "trustedinstaller" ? `<span class="pill pill-ti"><i class="fa-solid fa-lock"></i> TrustedInstaller</span>` : ""}
            ${client.os === "darwin" && client.permissions ? (() => {
              const p = client.permissions;
              const pills = [];
              if (p.screenRecording === true) pills.push('<span class="pill pill-perm-ok"><i class="fa-solid fa-video"></i> Screen</span>');
              else pills.push('<span class="pill pill-perm-no"><i class="fa-solid fa-video-slash"></i> No Screen</span>');
              if (p.accessibility === true) pills.push('<span class="pill pill-perm-ok"><i class="fa-solid fa-universal-access"></i> Accessibility</span>');
              else pills.push('<span class="pill pill-perm-no"><i class="fa-solid fa-ban"></i> No Accessibility</span>');
              if (p.fullDiskAccess === true) pills.push('<span class="pill pill-perm-ok"><i class="fa-solid fa-hard-drive"></i> FDA</span>');
              else pills.push('<span class="pill pill-perm-no"><i class="fa-solid fa-lock"></i> No FDA</span>');
              return pills.join("");
            })() : ""}
            ${!client.online && client.disconnectReason && client.disconnectReason !== "normal" ? (() => {
              const iconMap = { panic: "fa-skull-crossbones", crash: "fa-skull", timeout: "fa-clock", network: "fa-plug-circle-xmark" };
              const colorMap = { panic: "text-red-400", crash: "text-red-400", timeout: "text-amber-400", network: "text-slate-400" };
              const icon = iconMap[client.disconnectReason] || "fa-circle-exclamation";
              const color = colorMap[client.disconnectReason] || "text-slate-400";
              const detail = client.disconnectDetail ? escapeHtml(client.disconnectDetail) : "";
              return `<span class="pill pill-ghost text-xs ${color}" ${detail ? `title="${detail}"` : ""}><i class="fa-solid ${icon}"></i> ${escapeHtml(client.disconnectReason)}</span>`;
            })() : ""}
          </div>
          ${hasTagNote ? `<div class="client-tag-note rounded-lg border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-sm text-amber-100 whitespace-pre-wrap break-words max-h-48 overflow-auto ${isTagNoteExpanded ? "" : "hidden"}">${escapeHtml(customTagNote)}</div>` : ""}
          <div class="flex items-center gap-2 flex-wrap text-sm text-slate-300">
            <span class="pill pill-ghost"><i class="fa-regular fa-clock"></i> ${formatAgo(client.lastSeen)}</span>
            ${hasHwInfo ? `<button type="button" class="hw-toggle pill pill-hw cursor-pointer" aria-expanded="${isHwExpanded ? "true" : "false"}"><i class="fa-solid fa-microchip"></i> Hardware <i class="fa-solid ${isHwExpanded ? "fa-chevron-up" : "fa-chevron-down"}"></i></button>` : ""}
            <span class="pill ${os.tone}"><i class="fa ${os.icon}"></i> ${os.label}</span>
            <span class="pill ${arch.tone}"><i class="fa ${arch.icon}"></i> ${arch.label}</span>
            <span class="pill ${ver.tone}"><i class="fa ${ver.icon}"></i> ${ver.label}</span>
            <span class="pill ${mons.tone}"><i class="fa ${mons.icon}"></i> ${mons.label}</span>
          </div>
          ${hasHwInfo ? `<div class="hw-panel rounded-lg border border-indigo-900/50 bg-indigo-950/20 px-3 py-2 text-sm text-slate-200 ${isHwExpanded ? "" : "hidden"}">
            <div class="hw-panel-grid">
              ${client.cpu ? `<div class="hw-row"><span class="hw-label hw-label-cpu"><i class="fa-solid fa-microchip"></i> CPU</span><span class="hw-value">${escapeHtml(client.cpu)}</span></div>` : ""}
              ${gpuHtml ? `<div class="hw-row"><span class="hw-label hw-label-gpu"><i class="fa-solid fa-display"></i> GPU</span><span class="hw-value">${gpuHtml}</span></div>` : ""}
              ${client.ram ? `<div class="hw-row"><span class="hw-label hw-label-ram"><i class="fa-solid fa-memory"></i> RAM</span><span class="hw-value">${escapeHtml(client.ram)}</span></div>` : ""}
            </div>
          </div>` : ""}
          <div class="flex items-center gap-2 flex-wrap text-xs text-slate-400 font-mono">
            <span class="pill pill-ghost copy-id-btn cursor-pointer hover:bg-slate-700 transition-colors" data-copy="${escapeHtml(client.id)}" title="Copy full ID">ID ${deviceId} <i class="fa-regular fa-copy copy-id-icon"></i></span>
            ${client.hwid ? `<span class="pill pill-ghost">HW ${hwid}</span>` : ""}
            ${client.ip ? `<span class="pill pill-ghost"><i class="fa-solid fa-network-wired"></i> ${escapeHtml(client.ip)}</span>` : ""}
          </div>
        </div>
        <div class="flex items-center gap-3">
          <button class="bookmark-btn inline-flex items-center justify-center w-9 h-9 rounded-lg border ${client.bookmarked ? "border-yellow-600 bg-yellow-900/50 text-yellow-300" : "border-slate-700 bg-slate-800/50 text-slate-500 hover:text-yellow-300 hover:border-yellow-700"} transition-colors" data-id="${escapeHtml(client.id)}" title="${client.bookmarked ? "Remove bookmark" : "Bookmark"}"><i class="fa-${client.bookmarked ? "solid" : "regular"} fa-star"></i></button>
          <span class="text-emerald-300 font-mono text-sm inline-flex items-center gap-2"><i class="fa-solid fa-satellite-dish"></i> ${formatPing(client.pingMs)}</span>
          ${isViewer ? "" : `<button class="panel-btn inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-indigo-800 bg-indigo-900/60 hover:bg-indigo-800 text-indigo-100" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-gauge-high"></i> Panel</button>`}
          ${isViewer ? "" : `<button class="command-btn inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-800 bg-slate-800/70 hover:bg-slate-700" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-bars"></i> Commands</button>`}
          ${isViewer ? "" : `<button class="ban-btn inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-red-800 bg-red-900/60 hover:bg-red-800 text-red-100" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-ban"></i> Ban</button>`}
        </div>
      </div>
    `;

    const thumbSlots = card.querySelectorAll(".flex-shrink-0");
    if (thumbSlots.length >= 2) {
      thumbSlots[1].replaceWith(cardThumb);
    }

    const checkbox = card.querySelector(".client-checkbox");
    if (checkbox) {
      const isSelected =
        typeof window.isClientSelected === "function"
          ? window.isClientSelected(client.id)
          : false;

      if ((wasChecked || isSelected) && client.online) {
        checkbox.checked = true;
      }
    }
  }

  return { renderMerge };
}
