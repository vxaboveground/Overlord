// ── Context menu data ─────────────────────────────────────────────────────────
const MENU_GROUPS = [
  {
    id: "remote-access",
    label: "Remote Access",
    icon: "fa-solid fa-plug",
    color: "text-indigo-400",
    items: [
      { label: "Console",        icon: "fa-solid fa-terminal",        icolor: "text-emerald-400", open: "console" },
      { label: "Remote Desktop", icon: "fa-solid fa-desktop",         icolor: "text-purple-400",  open: "remotedesktop" },
      { label: "Backstage",      icon: "fa-solid fa-ghost",           icolor: "text-violet-400",  open: "Backstage" },
      { label: "Voice",          icon: "fa-solid fa-headset",         icolor: "text-teal-400",    open: "voice" },
    ],
  },
  {
    id: "monitoring",
    label: "Monitoring",
    icon: "fa-solid fa-eye",
    color: "text-cyan-400",
    items: [
      { label: "Webcam",          icon: "fa-solid fa-video",      icolor: "text-emerald-400", open: "webcam" },
      { label: "Keylogger",       icon: "fa-solid fa-keyboard",   icolor: "text-yellow-400",  open: "keylogger" },
      { label: "Process Manager", icon: "fa-solid fa-list-check", icolor: "text-orange-400",  open: "processes" },
    ],
  },
  {
    id: "system",
    label: "System",
    icon: "fa-solid fa-server",
    color: "text-blue-400",
    items: [
      { label: "File Browser", icon: "fa-solid fa-folder-tree",   icolor: "text-blue-400", open: "files" },
      { label: "Execution",    icon: "fa-solid fa-rocket",         icolor: "text-cyan-400", open: "silent-exec", id: "menu-silent-exec", hidden: true },
      { label: "WinRE Persist", icon: "fa-solid fa-shield-halved", icolor: "text-amber-400", open: "winre" },
    ],
  },
  {
    id: "agent",
    label: "Agent",
    icon: "fa-solid fa-robot",
    color: "text-slate-400",
    items: [
      { label: "Ping",                  icon: "fa-solid fa-satellite-dish",    icolor: "text-slate-300", action: "ping" },
      { label: "Reconnect",             icon: "fa-solid fa-rotate",            icolor: "text-slate-300", action: "reconnect" },
      { label: "Set Nickname",          icon: "fa-solid fa-signature",         icolor: "text-slate-300", action: "set-nickname" },
      { label: "Set Custom Tag",        icon: "fa-solid fa-tag",               icolor: "text-slate-300", action: "set-custom-tag" },
      { label: "Set Group",              icon: "fa-solid fa-layer-group",       icolor: "text-blue-300",  action: "set-group" },
      { divider: true },
      { label: "Elevate (macOS)",       icon: "fa-solid fa-arrow-up-right-dots", icolor: "text-green-400", action: "elevate" },
      { divider: true },
      { label: "Disconnect",            icon: "fa-solid fa-plug-circle-xmark", icolor: "text-red-400",   action: "disconnect" },
      { label: "Uninstall",             icon: "fa-solid fa-trash",             icolor: "text-red-300",   action: "uninstall" },
      { label: "Remove From Dashboard", icon: "fa-solid fa-user-xmark",        icolor: "text-rose-300",  action: "remove-dashboard" },
    ],
  },
];

// ── Styles ────────────────────────────────────────────────────────────────────
const menuStyle = document.createElement("style");
menuStyle.textContent = `
#command-menu {
  position: fixed;
  display: none;
  flex-direction: row;
  align-items: flex-start;
  z-index: 9999;
  filter: drop-shadow(0 8px 40px rgba(0,0,0,0.7));
}
#ctx-main {
  background: #141c2b;
  border: 1px solid rgba(148,163,184,0.14);
  border-radius: 8px;
  padding: 4px;
  min-width: 196px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  position: relative;
}
#ctx-sub {
  background: #141c2b;
  border: 1px solid rgba(148,163,184,0.14);
  border-radius: 8px;
  padding: 4px;
  min-width: 188px;
  position: absolute;
  left: calc(100% + 5px);
  top: 0;
  display: none;
  flex-direction: column;
  gap: 1px;
  z-index: 1;
}
.ctx-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 5px;
  font-size: 13px;
  font-weight: 500;
  color: #cbd5e1;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  user-select: none;
  -webkit-user-select: none;
  transition: background 0.1s, color 0.1s;
}
.ctx-row:hover:not([disabled]):not([aria-disabled="true"]),
.ctx-row.ctx-active:not([disabled]):not([aria-disabled="true"]) {
  background: rgba(71,85,105,0.55);
  color: #f1f5f9;
}
.ctx-row[disabled],
.ctx-row[aria-disabled="true"] {
  opacity: 0.38;
  cursor: not-allowed;
}
.ctx-row.ctx-active .ctx-chevron {
  opacity: 1;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 5px;
  font-size: 13px;
  font-weight: 500;
  color: #cbd5e1;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  user-select: none;
  -webkit-user-select: none;
  transition: background 0.1s, color 0.1s;
}
.ctx-item:hover:not([disabled]):not([aria-disabled="true"]) {
  background: rgba(71,85,105,0.55);
  color: #f1f5f9;
}
.ctx-item[disabled],
.ctx-item[aria-disabled="true"] {
  opacity: 0.38;
  cursor: not-allowed;
}
.ctx-divider {
  height: 1px;
  background: rgba(148,163,184,0.13);
  margin: 3px 4px;
}
.ctx-sub-panel {
  display: none;
  flex-direction: column;
  gap: 1px;
}
.ctx-icon {
  width: 16px;
  text-align: center;
  flex-shrink: 0;
  font-size: 13px;
}
.ctx-chevron {
  margin-left: auto;
  font-size: 10px;
  opacity: 0.4;
  transition: opacity 0.1s;
  flex-shrink: 0;
}
/* Allow classList.add/remove("hidden") to work on items inside the menu */
#command-menu .hidden { display: none !important; }
/* Mobile: stack submenu below the main column */
@media (max-width: 600px) {
  #command-menu { flex-direction: column; max-width: calc(100vw - 16px); }
  #ctx-sub { position: static; margin-top: 0; min-width: 0; width: 100%; border-radius: 0 0 8px 8px; border-top: 1px solid rgba(148,163,184,0.08); left: auto; right: auto; }
  #ctx-main { border-radius: 8px 8px 0 0; }
}
`;
document.head.appendChild(menuStyle);

// ── Build DOM ─────────────────────────────────────────────────────────────────
function buildItemHTML(item) {
  if (item.divider) return `<div class="ctx-divider"></div>`;
  const dataAttr   = item.open   ? `data-open="${item.open}"`   : `data-action="${item.action}"`;
  const idAttr     = item.id     ? `id="${item.id}"`             : "";
  const hiddenClass = item.hidden ? " hidden"                    : "";
  return `<button class="ctx-item${hiddenClass}" ${dataAttr} ${idAttr}><i class="${item.icon} ctx-icon ${item.icolor}"></i><span>${item.label}</span></button>`;
}

const mainRowsHTML =
  MENU_GROUPS.map(g =>
    `<button class="ctx-row" data-group-toggle="${g.id}"><i class="${g.icon} ctx-icon ${g.color}"></i><span style="flex:1">${g.label}</span><i class="fa-solid fa-chevron-right ctx-chevron"></i></button>`
  ).join("") +
  `<div class="ctx-divider"></div>` +
  `<button class="ctx-row hidden" id="plugin-section" data-group-toggle="plugins"><i class="fa-solid fa-puzzle-piece ctx-icon text-fuchsia-400"></i><span style="flex:1">Plugins</span><i class="fa-solid fa-chevron-right ctx-chevron"></i></button>`;

const subPanelsHTML =
  MENU_GROUPS.map(g =>
    `<div class="ctx-sub-panel" data-for="${g.id}">${g.items.map(buildItemHTML).join("")}</div>`
  ).join("") +
  `<div class="ctx-sub-panel" data-for="plugins"><div id="plugin-menu" style="display:flex;flex-direction:column;gap:1px"></div></div>`;

const menu = document.createElement("div");
menu.id = "command-menu";
menu.setAttribute("role", "menu");
menu.setAttribute("aria-hidden", "true");
menu.innerHTML = `<div id="ctx-main">${mainRowsHTML}</div><div id="ctx-sub">${subPanelsHTML}</div>`;
document.body.appendChild(menu);

const ctxMain = menu.querySelector("#ctx-main");
const ctxSub  = menu.querySelector("#ctx-sub");

// ── Submenu interaction ───────────────────────────────────────────────────────
let activeGroupId = null;
let _hideTimer = null;

function showSubmenu(groupId, rowEl) {
  if (activeGroupId === groupId) return;
  activeGroupId = groupId;

  ctxMain.querySelectorAll(".ctx-row").forEach(r => r.classList.remove("ctx-active"));
  rowEl.classList.add("ctx-active");

  ctxSub.querySelectorAll(".ctx-sub-panel").forEach(p => { p.style.display = "none"; });
  const panel = ctxSub.querySelector(`[data-for="${groupId}"]`);
  if (!panel) { ctxSub.style.display = "none"; return; }
  panel.style.display = "flex";
  ctxSub.style.display = "flex";

  // Align submenu vertically with the hovered row, then clamp to viewport
  requestAnimationFrame(() => {
    const rowRect  = rowEl.getBoundingClientRect();
    const mainRect = ctxMain.getBoundingClientRect();
    let offsetY = rowRect.top - mainRect.top;

    const subH   = ctxSub.offsetHeight;
    const menuTop = parseFloat(menu.style.top) || 0;
    if (menuTop + offsetY + subH > window.innerHeight - 8) {
      offsetY = Math.max(0, window.innerHeight - 8 - subH - menuTop);
    }
    ctxSub.style.top = offsetY + "px";

    // Flip to left if submenu overflows right edge
    const subW = ctxSub.offsetWidth;
    if (mainRect.right + 5 + subW > window.innerWidth - 8) {
      ctxSub.style.left  = "auto";
      ctxSub.style.right = "calc(100% + 5px)";
    } else {
      ctxSub.style.left  = "calc(100% + 5px)";
      ctxSub.style.right = "auto";
    }
  });
}

function hideSubmenu() {
  clearTimeout(_hideTimer);
  _hideTimer = null;
  activeGroupId = null;
  ctxSub.style.display = "none";
  ctxSub.querySelectorAll(".ctx-sub-panel").forEach(p => { p.style.display = "none"; });
  ctxMain.querySelectorAll(".ctx-row").forEach(r => r.classList.remove("ctx-active"));
}

function isMobileMenu() {
  return window.matchMedia("(max-width: 600px)").matches;
}

ctxMain.querySelectorAll(".ctx-row").forEach(rowEl => {
  rowEl.addEventListener("mouseenter", () => {
    if (isMobileMenu()) return;
    if (rowEl.disabled || rowEl.getAttribute("aria-disabled") === "true") return;
    const groupId = rowEl.dataset.groupToggle;
    if (groupId) showSubmenu(groupId, rowEl);
  });
});

// Debounced hide — prevents the 5px gap between panels from closing the submenu
function scheduleHide() { if (!isMobileMenu()) _hideTimer = setTimeout(hideSubmenu, 150); }
function cancelHide()   { clearTimeout(_hideTimer); _hideTimer = null; }

ctxMain.addEventListener("mouseleave", scheduleHide);
ctxMain.addEventListener("mouseenter", cancelHide);
ctxSub.addEventListener("mouseenter",  cancelHide);
ctxSub.addEventListener("mouseleave",  scheduleHide);

// Touch / mobile: tap to toggle group
ctxMain.querySelectorAll(".ctx-row").forEach(rowEl => {
  rowEl.addEventListener("click", (e) => {
    const groupId = rowEl.dataset.groupToggle;
    if (!groupId) return;
    if (rowEl.disabled || rowEl.getAttribute("aria-disabled") === "true") return;
    e.stopPropagation();
    if (activeGroupId === groupId) { hideSubmenu(); } else { showSubmenu(groupId, rowEl); }
  });
});

const modal = document.createElement("div");
modal.className =
  "modal fixed inset-0 z-40 hidden items-center justify-center bg-black/80 backdrop-blur";
modal.innerHTML = `<div class="max-w-5xl max-h-[90vh] p-4"><img class="max-h-[85vh] max-w-full rounded-xl shadow-2xl border border-slate-800 object-contain" id="modal-img" src="" alt="preview" /></div>`;
document.body.appendChild(modal);
const modalImg = modal.querySelector("#modal-img");

export function openMenu(clientId, x, y, setContext, options = {}) {
  if (setContext) setContext(clientId);

  // Toggle remove-dashboard visibility
  const removeBtn = menu.querySelector('[data-action="remove-dashboard"]');
  if (removeBtn) {
    removeBtn.style.display = options.isOnline === true ? "none" : "";
  }

  // Reset submenu state
  hideSubmenu();

  // Show menu off-screen first so we can measure, then reposition
  menu.style.left = "-9999px";
  menu.style.top  = "-9999px";
  menu.style.display = "flex";
  menu.setAttribute("aria-hidden", "false");

  requestAnimationFrame(() => {
    const mw = ctxMain.offsetWidth;
    const mh = ctxMain.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    menu.style.left = Math.max(8, Math.min(x, vw - mw - 8)) + "px";
    menu.style.top  = Math.max(8, Math.min(y, vh - mh - 8)) + "px";
  });
}

export function closeMenu(clearContext) {
  menu.style.display = "none";
  menu.setAttribute("aria-hidden", "true");
  hideSubmenu();
  if (clearContext) clearContext();
}

export function openModal(src) {
  if (!src) return;

  modalImg.src = "";

  setTimeout(() => {
    modalImg.src = src;
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }, 10);
}

export function closeModal() {
  modal.classList.remove("flex");
  modal.classList.add("hidden");
}

export function wireModalClose() {
  modal.addEventListener("click", closeModal);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModal();
      closeMenu();
    }
  });
}

export { menu, modal };
