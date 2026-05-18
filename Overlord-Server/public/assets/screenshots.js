import { ThumbnailLoader, thumbnailUrl } from "./thumbnail-loader.js";

const grid = document.getElementById("wall-grid");
const emptyEl = document.getElementById("wall-empty");
const searchInput = document.getElementById("wall-search");
const intervalSelect = document.getElementById("wall-interval");
const sizeSelect = document.getElementById("wall-size");
const showOfflineInput = document.getElementById("wall-show-offline");
const refreshNowBtn = document.getElementById("wall-refresh-now");
const statsEl = document.getElementById("wall-stats");

const PREF_INTERVAL = "wall_interval_ms";
const PREF_SIZE = "wall_tile_w";
const PREF_SHOW_OFFLINE = "wall_show_offline";

const PAGE_SIZE = 60;
const LIST_POLL_MS = 15_000;
const SEARCH_DEBOUNCE_MS = 200;

let clients = [];
let totalOnline = 0;
let totalAll = 0;
let currentPage = 1;
let listPollTimer = null;
let searchDebounceTimer = null;
const tileEls = new Map();

const loader = new ThumbnailLoader({
  refreshIntervalMs: 3000,
  rootMargin: "300px",
  threshold: 0.05,
});

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (v == null || v === "") return fallback;
    return v;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch {}
}

function loadPrefs() {
  const interval = readPref(PREF_INTERVAL, "3000");
  if (intervalSelect && [...intervalSelect.options].some((o) => o.value === interval)) {
    intervalSelect.value = interval;
  }
  const size = readPref(PREF_SIZE, "320");
  if (sizeSelect && [...sizeSelect.options].some((o) => o.value === size)) {
    sizeSelect.value = size;
  }
  const showOffline = readPref(PREF_SHOW_OFFLINE, "false");
  if (showOfflineInput) showOfflineInput.checked = showOffline === "true";
  applyTileSize();
  applyIntervalToLoader();
}

function applyTileSize() {
  const w = Number(sizeSelect?.value) || 320;
  document.documentElement.style.setProperty("--wall-tile-w", `${w}px`);
}

function applyIntervalToLoader() {
  const ms = Number(intervalSelect?.value);
  if (!Number.isFinite(ms) || ms <= 0) {
    loader.setRefreshInterval(60 * 60 * 1000);
    return;
  }
  loader.setRefreshInterval(ms);
}

function buildTile(client) {
  const tile = document.createElement("a");
  tile.className = "wall-tile cv-thumb-host";
  tile.dataset.id = client.id;
  tile.dataset.thumbHost = "";
  tile.dataset.thumbClient = client.id;
  tile.dataset.thumbVersion = String(client.thumbnailVersion || 0);
  tile.dataset.thumbOnline = client.online ? "1" : "0";
  if (client.online) {
    tile.href = `/remotedesktop?clientId=${encodeURIComponent(client.id)}`;
    tile.target = "_blank";
    tile.rel = "noopener";
  } else {
    tile.classList.add("is-offline");
    tile.addEventListener("click", (e) => e.preventDefault());
  }

  const img = document.createElement("img");
  img.className = "wall-img";
  img.dataset.thumbImg = "";
  img.alt = "";
  img.decoding = "async";
  img.loading = "lazy";
  if (client.hasThumbnail) {
    const url = thumbnailUrl(client.id, client.thumbnailVersion || 0);
    img.src = url;
    img.dataset.thumbUrl = url;
  } else {
    img.style.display = "none";
  }
  img.addEventListener("load", () => {
    img.style.display = "block";
    const empty = tile.querySelector(".wall-empty");
    if (empty) empty.style.display = "none";
  });
  img.addEventListener("error", () => {
    img.style.display = "none";
    img.removeAttribute("src");
    const empty = tile.querySelector(".wall-empty");
    if (empty) empty.style.display = "";
  });
  tile.appendChild(img);

  const empty = document.createElement("div");
  empty.className = "wall-empty";
  empty.innerHTML = `<i class="fa-solid fa-camera"></i><span>${client.online ? "Waiting for screenshot…" : "Offline"}</span>`;
  if (client.hasThumbnail) empty.style.display = "none";
  tile.appendChild(empty);

  const loading = document.createElement("div");
  loading.className = "wall-loading";
  tile.appendChild(loading);

  const top = document.createElement("div");
  top.className = "wall-overlay-top";
  top.innerHTML = `
    <span class="wall-dot ${client.online ? "on" : "off"}"></span>
    <span class="wall-host"></span>
  `;
  tile.appendChild(top);

  const bottom = document.createElement("div");
  bottom.className = "wall-overlay-bottom";
  bottom.innerHTML = `
    <span class="wall-user-os"><span class="wall-user"></span> <span class="wall-os"></span></span>
    <span class="wall-age"></span>
  `;
  tile.appendChild(bottom);

  return tile;
}

function updateTile(tile, client) {
  const isOnline = !!client.online;
  tile.classList.toggle("is-offline", !isOnline);
  if (isOnline) {
    tile.href = `/remotedesktop?clientId=${encodeURIComponent(client.id)}`;
    tile.target = "_blank";
    tile.rel = "noopener";
  } else {
    tile.removeAttribute("href");
    tile.removeAttribute("target");
  }
  tile.dataset.thumbOnline = isOnline ? "1" : "0";
  tile.dataset.thumbVersion = String(client.thumbnailVersion || 0);

  const dot = tile.querySelector(".wall-dot");
  if (dot) {
    dot.classList.toggle("on", isOnline);
    dot.classList.toggle("off", !isOnline);
  }

  const hostEl = tile.querySelector(".wall-host");
  if (hostEl) {
    const label = client.nickname || client.host || client.id;
    hostEl.textContent = label;
    hostEl.title = `${label}\n${client.id}`;
  }

  const userEl = tile.querySelector(".wall-user");
  if (userEl) userEl.textContent = client.user || "—";
  const osEl = tile.querySelector(".wall-os");
  if (osEl) osEl.textContent = client.os ? `· ${client.os}` : "";

  if (!client.hasThumbnail) {
    const img = tile.querySelector("img[data-thumb-img]");
    if (img && !img.dataset.thumbUrl) {
      img.removeAttribute("src");
      img.style.display = "none";
    }
    const empty = tile.querySelector(".wall-empty");
    if (empty) empty.style.display = "";
  }
}

function pageClients() {
  const showOffline = !!showOfflineInput?.checked;
  return clients.filter((c) => showOffline || c.online);
}

function renderGrid() {
  const visible = pageClients();
  const seen = new Set();

  for (const client of visible) {
    seen.add(client.id);
    let tile = tileEls.get(client.id);
    if (!tile) {
      tile = buildTile(client);
      tileEls.set(client.id, tile);
      grid.appendChild(tile);
    } else if (tile.parentNode !== grid) {
      grid.appendChild(tile);
    }
    updateTile(tile, client);
    if (client.online) {
      loader.observe(tile, client.id, Number(client.thumbnailVersion) || 0);
    } else {
      loader.unobserve(tile);
    }
  }

  for (const [id, tile] of tileEls) {
    if (!seen.has(id)) {
      loader.unobserve(tile);
      tile.remove();
      tileEls.delete(id);
    }
  }

  if (statsEl) {
    const shownLabel = visible.length === clients.length
      ? `${visible.length} shown`
      : `${visible.length} on page · ${totalOnline} online · ${totalAll} total`;
    statsEl.textContent = shownLabel;
  }
  if (emptyEl) emptyEl.classList.toggle("hidden", visible.length > 0);

  renderPagination();
}

let paginationEl = null;
function renderPagination() {
  const totalForView = showOfflineInput?.checked ? totalAll : totalOnline;
  const totalPages = Math.max(1, Math.ceil(totalForView / PAGE_SIZE));
  if (totalForView <= PAGE_SIZE) {
    if (paginationEl) {
      paginationEl.remove();
      paginationEl = null;
    }
    return;
  }
  if (!paginationEl) {
    paginationEl = document.createElement("div");
    paginationEl.className = "flex items-center justify-center gap-3 py-4 text-slate-300";
    grid.parentNode.insertBefore(paginationEl, grid.nextSibling);
  }
  paginationEl.innerHTML = `
    <button class="wall-pill" data-act="prev" ${currentPage <= 1 ? "disabled" : ""}>
      <i class="fa-solid fa-chevron-left"></i><span>Prev</span>
    </button>
    <span class="text-slate-400 text-sm">Page ${currentPage} of ${totalPages}</span>
    <button class="wall-pill" data-act="next" ${currentPage >= totalPages ? "disabled" : ""}>
      <span>Next</span><i class="fa-solid fa-chevron-right"></i>
    </button>
  `;
  paginationEl.querySelector('[data-act="prev"]')?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage -= 1;
      fetchClients();
    }
  });
  paginationEl.querySelector('[data-act="next"]')?.addEventListener("click", () => {
    if (currentPage < totalPages) {
      currentPage += 1;
      fetchClients();
    }
  });
}

function getSearchTerm() {
  return (searchInput?.value || "").trim();
}

async function fetchClients() {
  const params = new URLSearchParams({
    page: String(currentPage),
    pageSize: String(PAGE_SIZE),
    sort: "host_asc",
    q: getSearchTerm(),
    status: showOfflineInput?.checked ? "all" : "online",
    os: "all",
    country: "all",
    group: "all",
  });
  try {
    const res = await fetch(`/api/clients?${params.toString()}`, { credentials: "include" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    clients = Array.isArray(data.items) ? data.items : [];
    totalOnline = Number(data.online) || 0;
    totalAll = Number(data.total) || 0;
    renderGrid();
    for (const c of clients) {
      if (typeof c.thumbnailVersion === "number") {
        loader.setVersion(c.id, c.thumbnailVersion);
      }
    }
  } catch (err) {
    console.error("[wall] fetchClients failed", err);
  }
}

function debouncedFetch() {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    currentPage = 1;
    fetchClients();
  }, SEARCH_DEBOUNCE_MS);
}

function startListPoll() {
  if (listPollTimer) return;
  listPollTimer = setInterval(() => {
    if (document.hidden) return;
    fetchClients();
  }, LIST_POLL_MS);
}

function setupEvents() {
  searchInput?.addEventListener("input", debouncedFetch);

  intervalSelect?.addEventListener("change", () => {
    writePref(PREF_INTERVAL, intervalSelect.value);
    applyIntervalToLoader();
  });

  sizeSelect?.addEventListener("change", () => {
    writePref(PREF_SIZE, sizeSelect.value);
    applyTileSize();
  });

  showOfflineInput?.addEventListener("change", () => {
    writePref(PREF_SHOW_OFFLINE, String(showOfflineInput.checked));
    currentPage = 1;
    fetchClients();
  });

  refreshNowBtn?.addEventListener("click", () => {
    loader.refreshNow();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) fetchClients();
  });
}

async function init() {
  loadPrefs();
  setupEvents();
  await fetchClients();
  startListPoll();
}

init();
