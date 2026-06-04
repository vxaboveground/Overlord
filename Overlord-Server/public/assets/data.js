import { state } from "./state.js";
import { digestData } from "./utils.js";

const POLL_INTERVAL_MS = 5000;
const FALLBACK_POLL_MS = 30000;
const PREF_REFRESH_KEY = "overlord_refresh_interval_seconds";
let pollTimer = null;
let render = () => {};
let lastClientData = null;
const pageCache = new Map();
const PAGE_CACHE_LIMIT = 8;
let dashboardWs = null;
let dashboardWsConnected = false;
let wsReconnectTimer = null;
const manuallyDisconnecting = new Set();

function stopDashboardRealtime() {
  clearInterval(pollTimer);
  pollTimer = null;
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = null;
  if (dashboardWs) {
    try {
      dashboardWs.onopen = null;
      dashboardWs.onmessage = null;
      dashboardWs.onerror = null;
      dashboardWs.onclose = null;
      dashboardWs.close(1000, "page hidden");
    } catch {}
  }
  dashboardWs = null;
  dashboardWsConnected = false;
}

function bindDashboardPagehideCleanup() {
  window.removeEventListener("pagehide", stopDashboardRealtime);
  window.addEventListener("pagehide", stopDashboardRealtime);
}

function moveClientCardImmediately(msg) {
  const clientId = typeof msg?.clientId === "string" ? msg.clientId : "";
  if (!clientId) return;
  const selectorId =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(clientId)
      : clientId;
  const grid = document.getElementById("grid");
  const card = grid?.querySelector(`[data-client-row][data-id="${selectorId}"]`);
  if (!grid || !card) return;

  const parent = card.parentNode || grid;

  if (msg.event === "client_online") {
    card.dataset.online = "true";
    card.classList.remove("card-offline", "cv-offline");
    parent.prepend(card);
    return;
  }

  if (msg.event === "client_offline") {
    card.dataset.online = "false";
    card.classList.add("card-offline", "cv-offline");
    parent.appendChild(card);
  }
}

export function registerRenderer(fn) {
  render = fn;
}

function clientQueryParams(page = state.page) {
  return new URLSearchParams({
    page: String(page),
    pageSize: String(state.pageSize),
    q: state.searchTerm,
    sort: state.sort,
    status: state.filterStatus || "all",
    os: state.filterOs || "all",
    country: state.filterCountry || "all",
    group: state.filterGroup || "all",
  });
}

function rememberPage(key, data) {
  pageCache.set(key, data);
  while (pageCache.size > PAGE_CACHE_LIMIT) {
    pageCache.delete(pageCache.keys().next().value);
  }
}

async function prefetchClientPage(page) {
  if (page < 1) return;
  const params = clientQueryParams(page);
  const key = params.toString();
  if (pageCache.has(key)) return;
  try {
    const res = await fetch(`/api/clients?${key}`);
    if (!res.ok) return;
    rememberPage(key, await res.json());
  } catch {}
}

function prefetchAdjacentPages(data) {
  const totalPages = Math.max(1, Math.ceil((Number(data.total) || 0) / (Number(data.pageSize) || state.pageSize || 1)));
  const current = Number(data.page) || state.page;
  if (current < totalPages) prefetchClientPage(current + 1);
  if (current > 1) prefetchClientPage(current - 1);
}

export async function loadWithOptions(options = {}) {
  const { force = false, reorder = false } = options;
  if (state.isLoading) {
    state.pendingForce = state.pendingForce || force;
    state.pendingReorder = state.pendingReorder || reorder;
    return;
  }
  state.isLoading = true;
  try {
    const params = clientQueryParams();
    const cacheKey = params.toString();
    const cached = pageCache.get(cacheKey);
    if (force && cached) {
      lastClientData = cached;
      render(cached, { reorder, fromCache: true });
    }

    const res = await fetch(`/api/clients?${cacheKey}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    lastClientData = data;
    rememberPage(cacheKey, data);

    updateOsFilter(data.items);

    const digest = digestData(data, state);
    if (!force && digest === state.lastDigest) {
      return;
    }
    state.lastDigest = digest;
    render(data, { reorder });
    prefetchAdjacentPages(data);
    const pag = document.getElementById("pagination");
    if (pag) pag.style.visibility = "";
  } catch (err) {
    console.error("load clients", err);
  } finally {
    state.isLoading = false;
    if (state.pendingForce || state.pendingReorder) {
      const shouldForce = state.pendingForce;
      const shouldReorder = state.pendingReorder;
      state.pendingForce = false;
      state.pendingReorder = false;
      loadWithOptions({ force: shouldForce, reorder: shouldReorder });
    }
  }
}

export function renderCachedClients(options = {}) {
  if (!lastClientData) return false;
  render(lastClientData, { ...options, fromCache: true });
  return true;
}

function updateOsFilter(items) {
  const osSelect = document.getElementById("filter-os");
  if (!osSelect) return;

  const osList = new Set();
  items.forEach((item) => {
    if (item.os) osList.add(item.os);
  });

  const currentValue = osSelect.value;
  const osArray = Array.from(osList).sort();

  osSelect.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All OS";
  osSelect.appendChild(allOption);

  osArray.forEach((os) => {
    const option = document.createElement("option");
    option.value = os;
    option.textContent = os;
    osSelect.appendChild(option);
  });

  if (currentValue !== "all" && osList.has(currentValue)) {
    osSelect.value = currentValue;
  }
}

function getConfiguredPollIntervalMs(defaultMs) {
  const savedSeconds = Number(localStorage.getItem(PREF_REFRESH_KEY));
  if (!Number.isFinite(savedSeconds)) return defaultMs;
  const boundedSeconds = Math.min(120, Math.max(3, savedSeconds));
  return boundedSeconds * 1000;
}

function connectDashboardWs() {
  if (dashboardWs) return;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/api/dashboard/ws`;
  try {
    dashboardWs = new WebSocket(wsUrl);
  } catch {
    scheduleDashboardReconnect();
    return;
  }

  dashboardWs.onopen = () => {
    console.log("[dashboard] ws connected");
    dashboardWsConnected = true;
    adjustPollingForWs();
  };

  dashboardWs.onmessage = (event) => {
    try {
      const msg = typeof event.data === "string" ? JSON.parse(event.data) : null;
      if (msg && msg.type === "clients_changed") {
        loadWithOptions({ force: false, reorder: true });
        return;
      }
      if (msg && msg.type === "client_event") {
        if (msg.event === "client_offline" && manuallyDisconnecting.has(msg.clientId)) {
          manuallyDisconnecting.delete(msg.clientId);
          loadWithOptions({ force: true });
        } else {
          moveClientCardImmediately(msg);
          loadWithOptions({ force: false, reorder: true });
        }
      }
    } catch {}
  };

  dashboardWs.onclose = () => {
    console.warn("[dashboard] ws closed");
    dashboardWs = null;
    dashboardWsConnected = false;
    adjustPollingForWs();
    scheduleDashboardReconnect();
  };

  dashboardWs.onerror = () => {
    console.warn("[dashboard] ws error");
  };
}

function scheduleDashboardReconnect() {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectDashboardWs();
  }, 3000);
}

function adjustPollingForWs() {
  clearInterval(pollTimer);
  const interval = dashboardWsConnected
    ? FALLBACK_POLL_MS
    : getConfiguredPollIntervalMs(POLL_INTERVAL_MS);
  pollTimer = setInterval(() => {
    loadWithOptions({ force: false, reorder: true });
  }, interval);
}

export function startAutoRefresh(intervalMs = POLL_INTERVAL_MS) {
  bindDashboardPagehideCleanup();
  connectDashboardWs();
  const effectiveInterval = dashboardWsConnected
    ? FALLBACK_POLL_MS
    : getConfiguredPollIntervalMs(intervalMs);
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    loadWithOptions({ force: false, reorder: true });
  }, effectiveInterval);
}

export function markManualDisconnect(clientId) {
  manuallyDisconnecting.add(clientId);
  setTimeout(() => manuallyDisconnecting.delete(clientId), 10000);
}

export async function sendCommand(clientId, action) {
  try {
    const res = await fetch(`/api/clients/${clientId}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) throw new Error(`command failed ${res.status}`);
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

export async function fetchVoiceCapabilities(clientId) {
  try {
    const res = await fetch(`/api/clients/${clientId}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "voice_capabilities" }),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: Boolean(data?.ok),
      capabilities: data?.capabilities || null,
      error: data?.error || (res.ok ? "" : `voice capabilities failed ${res.status}`),
    };
  } catch (err) {
    console.error(err);
    return { ok: false, capabilities: null, error: "Voice capability probe failed" };
  }
}

export async function requestPreview(clientId) {
  const ok = await sendCommand(clientId, "screenshot");
  if (ok) {
    setTimeout(() => loadWithOptions({ force: true }), 250);
    setTimeout(() => loadWithOptions({ force: true }), 800);
  }
}

export async function requestThumbnail(clientId) {
  try {
    const res = await fetch(`/api/clients/${clientId}/thumbnail`, {
      method: "POST",
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok) {
        await loadWithOptions({ force: true });
        setTimeout(() => loadWithOptions({ force: true }), 250);
        setTimeout(() => loadWithOptions({ force: true }), 800);
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error("Failed to request thumbnail:", err);
    return false;
  }
}
