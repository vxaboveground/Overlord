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
  let viewMode = localStorage.getItem("overlord_view_mode") || "cards";
  let lastData = null;

  function renderMerge(data) {
    lastData = data;
    if (viewMode === "table") {
      renderTable(data);
      return;
    }
    renderCards(data);
  }

  function renderTable(data) {
    totalPill.textContent = `${data.online ?? data.total} online / ${data.total} total`;
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    pageLabel.textContent = `Page ${data.page} of ${totalPages}`;
    prevBtnState(data.page, totalPages);

    const items = data.items || [];
    grid.innerHTML = "";
    grid.className = "flex flex-col gap-0";

    const table = document.createElement("div");
    table.className = "w-full rounded-xl border border-slate-800 bg-slate-900/70 overflow-hidden";

    const header = document.createElement("div");
    header.className = "grid grid-cols-[2.5rem_2rem_1fr_8rem_5rem_5rem_6rem_5rem_7rem] gap-2 px-3 py-2 bg-slate-800/80 text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-700";
    header.innerHTML = `<span></span><span></span><span>Client</span><span>User</span><span>OS</span><span>Arch</span><span>Ping</span><span>Seen</span><span class="text-right">Actions</span>`;
    table.appendChild(header);

    const onlineItems = items.filter(c => c.online);
    const offlineItems = items.filter(c => !c.online);
    const sorted = [...onlineItems, ...offlineItems];

    sorted.forEach((client) => {
      const os = osBadge(client.os || "unknown");
      const arch = archBadge(client.arch || "");
      const deviceId = shortId(client.id);
      const nickname = String(client.nickname || "").trim();
      const displayName = nickname || client.host || deviceId;
      const isSelected = typeof window.isClientSelected === "function" ? window.isClientSelected(client.id) : false;

      const row = document.createElement("div");
      row.dataset.id = client.id;
      row.dataset.online = String(!!client.online);
      row.dataset.os = String(client.os || "").toLowerCase();
      row.dataset.nickname = String(client.nickname || "");
      row.dataset.customTag = String(client.customTag || "");
      row.className = `grid grid-cols-[2.5rem_2rem_1fr_8rem_5rem_5rem_6rem_5rem_7rem] gap-2 px-3 py-2 items-center border-b border-slate-800/60 text-sm hover:bg-slate-800/40 transition-colors ${client.online ? "" : "opacity-50"}`;

      row.innerHTML = `
        <span class="flex items-center justify-center"><input type="checkbox" class="client-checkbox w-4 h-4 rounded border-slate-600 bg-slate-800 checked:bg-blue-600" data-id="${escapeHtml(client.id)}" ${client.online ? "" : "disabled"} ${isSelected && client.online ? "checked" : ""}></span>
        <span class="flex items-center justify-center"><i class="fa-solid fa-circle text-[8px] ${client.online ? "text-emerald-400" : "text-slate-600"}"></i></span>
        <span class="flex items-center gap-2 min-w-0 truncate"><span>${countryToFlag(client.country)}</span><span class="font-medium text-slate-100 truncate">${escapeHtml(displayName)}</span>${client.customTag ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800/60">${escapeHtml(client.customTag)}</span>` : ""}</span>
        <span class="text-slate-300 truncate">${escapeHtml(client.user || "—")}</span>
        <span class="pill text-xs ${os.tone} !px-1.5 !py-0.5">${os.label}</span>
        <span class="text-slate-400 text-xs">${escapeHtml(arch.label)}</span>
        <span class="text-emerald-300 font-mono text-xs">${formatPing(client.pingMs)}</span>
        <span class="text-slate-500 text-xs">${formatAgo(client.lastSeen)}</span>
        <span class="flex items-center justify-end gap-1">${isViewer ? "" : `<button class="command-btn px-2 py-1 rounded border border-slate-700 bg-slate-800/70 hover:bg-slate-700 text-xs text-slate-200" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-bars"></i></button><button class="ban-btn px-2 py-1 rounded border border-red-800/60 bg-red-900/40 hover:bg-red-800 text-xs text-red-200" data-id="${escapeHtml(client.id)}"><i class="fa-solid fa-ban"></i></button>`}</span>
      `;

      row.querySelector(".client-checkbox")?.addEventListener("change", (e) => {
        e.stopPropagation();
        if (window.toggleClientSelection) window.toggleClientSelection(client.id);
      });

      if (!isViewer) {
        row.querySelector(".command-btn")?.addEventListener("click", (e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          openMenu(client.id, rect.left, rect.bottom);
        });
        row.querySelector(".ban-btn")?.addEventListener("click", (e) => {
          e.stopPropagation();
          if (window.banClient) window.banClient(client.id);
        });
      }

      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (isViewer) return;
        openMenu(client.id, e.clientX, e.clientY);
      });

      row.addEventListener("click", (e) => {
        if (e.target.closest("button") || e.target.closest(".client-checkbox")) return;
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          const cb = row.querySelector(".client-checkbox");
          if (cb && !cb.disabled) {
            cb.checked = !cb.checked;
            if (window.toggleClientSelection) window.toggleClientSelection(client.id);
          }
          return;
        }
        if (!client.online) return;
        if (pingClient) pingClient(client.id);
      });

      table.appendChild(row);
    });

    grid.appendChild(table);
  }

  function renderCards(data) {
    totalPill.textContent = `${data.online ?? data.total} online / ${data.total} total`;
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    pageLabel.textContent = `Page ${data.page} of ${totalPages}`;
    prevBtnState(data.page, totalPages);

    if (grid.className !== "flex flex-col gap-3") {
      grid.className = "flex flex-col gap-3";
      grid.innerHTML = "";
    }

    const items = data.items || [];
    const seen = new Set();
    const newClients = [];
    const renderId = ++renderToken;
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animateLimit = Math.min(items.length, MAX_ANIMATED_CARDS);
    const allowAnimation = !prefersReducedMotion && items.length <= 1000;

    items.forEach((client) => {
      seen.add(client.id);
      const existing = grid.querySelector(`article[data-id="${client.id}"]`);
      if (existing) {
        updateCard(existing, client);
        return;
      }
      newClients.push(client);
    });

    Array.from(grid.querySelectorAll("article[data-id]"))
      .filter((el) => !seen.has(el.dataset.id))
      .forEach((el) => el.remove());

    if (newClients.length === 0) {
      moveOfflineToBottom();
      return;
    }

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

      moveOfflineToBottom();
    };

    insertBatch();
  }

  function moveOfflineToBottom() {
    const cards = Array.from(grid.querySelectorAll("article[data-id]"));
    if (cards.length === 0) return;

    const online = [];
    const offline = [];
    cards.forEach((card) => {
      if (card.dataset.online === "true") {
        online.push(card);
        return;
      }
      offline.push(card);
    });

    if (offline.length === 0) return;

    const fragment = document.createDocumentFragment();
    online.forEach((card) => fragment.appendChild(card));
    offline.forEach((card) => fragment.appendChild(card));
    grid.appendChild(fragment);
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
    let longPressTimer = null;
    card._longPressTriggered = false;
    let pointerStartX = 0;
    let pointerStartY = 0;

    const clearLongPress = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    updateCard(card, client);
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (isViewer) return;
      const clientId = card.dataset.id;
      if (!clientId) return;
      const { clientX, clientY } = e;
      openMenu(clientId, clientX, clientY);
    });

    card.addEventListener("pointerdown", (e) => {
      if (isViewer || e.pointerType !== "touch") return;
      if (e.target.closest("button") || e.target.closest(".client-checkbox")) return;
      const clientId = card.dataset.id;
      if (!clientId) return;

      card._longPressTriggered = false;
      pointerStartX = e.clientX;
      pointerStartY = e.clientY;
      clearLongPress();
      longPressTimer = setTimeout(() => {
        card._longPressTriggered = true;
        openMenu(clientId, e.clientX, e.clientY);
      }, TOUCH_LONG_PRESS_MS);
    });

    card.addEventListener("pointermove", (e) => {
      if (!longPressTimer || e.pointerType !== "touch") return;
      const movedX = Math.abs(e.clientX - pointerStartX);
      const movedY = Math.abs(e.clientY - pointerStartY);
      if (movedX > TOUCH_MOVE_CANCEL_PX || movedY > TOUCH_MOVE_CANCEL_PX) {
        clearLongPress();
      }
    });

    card.addEventListener("pointerup", clearLongPress);
    card.addEventListener("pointercancel", clearLongPress);
    card.addEventListener("pointerleave", clearLongPress);

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

    card.dataset.online = String(!!client.online);
    card.dataset.os = String(client.os || "").toLowerCase();
    card.dataset.nickname = String(client.nickname || "");
    card.dataset.customTag = String(client.customTag || "");
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
    card.className = `card rounded-xl border border-slate-800 bg-slate-900/70 p-4 shadow-lg ${client.online ? "" : "card-offline"} tone-${os.tone}`;
    const cardThumb = client.thumbnail
      ? (() => {
          const wrapper = document.createElement("div");
          wrapper.className = "flex-shrink-0";
          const img = document.createElement("img");
          img.className =
            "w-40 h-24 rounded-lg border border-slate-800 object-cover cursor-pointer thumb-img";
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
            <span class="text-slate-300 text-lg font-semibold flex items-center gap-1"><i class="fa-solid fa-user"></i> ${escapeHtml(client.user || "unknown")}</span>
            <span class="pill ${client.online ? "pill-online" : "pill-offline"}">
              <i class="fa-solid fa-circle"></i>
              ${client.online ? "Online" : "Offline"}
            </span>
          </div>
          ${hasTagNote ? `<div class="client-tag-note rounded-lg border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-sm text-amber-100 whitespace-pre-wrap break-words max-h-48 overflow-auto ${isTagNoteExpanded ? "" : "hidden"}">${escapeHtml(customTagNote)}</div>` : ""}
          <div class="flex items-center gap-2 flex-wrap text-sm text-slate-300">
            <span class="pill pill-ghost"><i class="fa-regular fa-clock"></i> ${formatAgo(client.lastSeen)}</span>
            <span class="pill ${os.tone}"><i class="fa ${os.icon}"></i> ${os.label}</span>
            <span class="pill ${arch.tone}"><i class="fa ${arch.icon}"></i> ${arch.label}</span>
            <span class="pill ${ver.tone}"><i class="fa ${ver.icon}"></i> ${ver.label}</span>
            <span class="pill ${mons.tone}"><i class="fa ${mons.icon}"></i> ${mons.label}</span>
          </div>
          <div class="flex items-center gap-2 flex-wrap text-xs text-slate-400 font-mono">
            <span class="pill pill-ghost">ID ${deviceId}</span>
            ${client.hwid ? `<span class="pill pill-ghost">HW ${hwid}</span>` : ""}
          </div>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-emerald-300 font-mono text-sm inline-flex items-center gap-2"><i class="fa-solid fa-satellite-dish"></i> ${formatPing(client.pingMs)}</span>
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

      checkbox.addEventListener("change", (e) => {
        e.stopPropagation();
        if (window.toggleClientSelection) {
          window.toggleClientSelection(client.id);
        }
      });
    }

    if (!isViewer) {
      card.querySelector(".command-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        openMenu(client.id, rect.right, rect.bottom);
      });
      card.querySelector(".ban-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (window.banClient) {
          window.banClient(client.id);
        }
      });
    }

    card.querySelector(".client-tag-toggle")?.addEventListener("click", (e) => {
      e.stopPropagation();
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
    });

    card
      .querySelector(".thumb-img")
      ?.addEventListener("click", () => openModal(client.thumbnail));

    card.onclick = (e) => {
      if (card._longPressTriggered) {
        card._longPressTriggered = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.target.closest(".command-btn") || e.target.closest("button"))
        return;
      if (e.target.closest(".client-checkbox")) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        if (checkbox && !checkbox.disabled) {
          checkbox.checked = !checkbox.checked;
          if (window.toggleClientSelection) {
            window.toggleClientSelection(client.id);
          }
        }
        return;
      }
      if (!client.online) return;
      if (pingClient) pingClient(client.id);
      requestThumbnail(client.id);
    };
  }

  function setViewMode(mode) {
    viewMode = mode;
    localStorage.setItem("overlord_view_mode", mode);
    if (lastData) renderMerge(lastData);
  }

  function getViewMode() {
    return viewMode;
  }

  return { renderMerge, setViewMode, getViewMode };
}
