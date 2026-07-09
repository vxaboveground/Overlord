const body = document.getElementById("enrollment-body");
const loadingRow = document.getElementById("enrollment-loading");
const emptyEl = document.getElementById("enrollment-empty");
const selectAllEl = document.getElementById("select-all");
const bulkApproveBtn = document.getElementById("bulk-approve-btn");
const bulkDenyBtn = document.getElementById("bulk-deny-btn");
const statPending = document.getElementById("stat-pending");
const statApproved = document.getElementById("stat-approved");
const statDenied = document.getElementById("stat-denied");
const statBannedIps = document.getElementById("stat-banned-ips");
const searchInput = document.getElementById("search-input");
const bannedIpsSection = document.getElementById("banned-ips-section");
const bannedIpsBody = document.getElementById("banned-ips-body");
const bannedIpsEmpty = document.getElementById("banned-ips-empty");
const clientsTable = document.getElementById("clients-table-panel");
const addBanBtn = document.getElementById("add-ban-btn");
const manualBanForm = document.getElementById("manual-ban-form");
const banIpInput = document.getElementById("ban-ip-input");
const banReasonInput = document.getElementById("ban-reason-input");
const confirmBanBtn = document.getElementById("confirm-ban-btn");
const cancelBanBtn = document.getElementById("cancel-ban-btn");
const bulkBanBtn = document.getElementById("bulk-ban-btn");
const banModal = document.getElementById("ban-confirm-modal");
const banModalBody = document.getElementById("ban-modal-body");
const banModalConfirm = document.getElementById("ban-modal-confirm");
const banModalCancel = document.getElementById("ban-modal-cancel");
const banModalBackdrop = document.getElementById("ban-modal-backdrop");
const autoAcceptToggle = document.getElementById("auto-accept-toggle");
const autoAcceptModal = document.getElementById("auto-accept-modal");
const autoAcceptModalConfirm = document.getElementById("auto-accept-modal-confirm");
const autoAcceptModalCancel = document.getElementById("auto-accept-modal-cancel");
const autoAcceptModalBackdrop = document.getElementById("auto-accept-modal-backdrop");
const approveAllBtn = document.getElementById("approve-all-btn");
const denyAllBtn = document.getElementById("deny-all-btn");
const unlessSuspiciousToggle = document.getElementById("unless-suspicious-toggle");
const unlessSuspiciousRow = document.getElementById("unless-suspicious-row");
const statSuspicious = document.getElementById("stat-suspicious");
const denyReasonModal = document.getElementById("deny-reason-modal");
const denyReasonInput = document.getElementById("deny-reason-input");
const denyReasonModalConfirm = document.getElementById("deny-reason-modal-confirm");
const denyReasonModalCancel = document.getElementById("deny-reason-modal-cancel");
const denyReasonModalBackdrop = document.getElementById("deny-reason-modal-backdrop");
const paginationEl = document.getElementById("enrollment-pagination");
const pageSummaryEl = document.getElementById("enrollment-page-summary");
const pageSizeEl = document.getElementById("enrollment-page-size");
const prevPageBtn = document.getElementById("enrollment-prev-page");
const nextPageBtn = document.getElementById("enrollment-next-page");
const pageLabelEl = document.getElementById("enrollment-page-label");

let currentFilter = "pending";
let searchQuery = "";
let clients = [];
const expandedCells = new Set(); // tracks "clientId:field" keys
let lastEnrollmentDigest = "";
let currentPage = 1;
let rowsPerPage = 100;
try {
  rowsPerPage = Number(localStorage.getItem("purgatory_rows_per_page") || 100);
} catch {}
if (![50, 100, 200].includes(rowsPerPage)) rowsPerPage = 100;
if (pageSizeEl) pageSizeEl.value = String(rowsPerPage);

const SUSPICIOUS_FLAG_LABELS = {
  hwid_flood: "HWID Flood (40+ same hardware ID)",
  hw_flood: "Hardware Flood (40+ identical specs)",
  no_hostname: "No Hostname",
  no_user: "No Username",
  ip_flood: "IP Flood (40+ from same IP recently)",
  vm_hardware: "VM Detected (CPU/GPU indicates virtual machine)",
  vm_ram: "VM Likely (≤4 GB round RAM)",
  no_monitors: "No Monitors (headless/VM)",
};

// ── API helpers ────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "include", ...opts });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function loadSettings() {
  try {
    const s = await api("/api/enrollment/settings");
    autoAcceptToggle.checked = !s.requireApproval;
    unlessSuspiciousToggle.checked = !!s.autoApproveUnlessSuspicious;
    unlessSuspiciousRow.classList.toggle("hidden", !autoAcceptToggle.checked);
  } catch {}
}

async function loadStats() {
  try {
    const s = await api("/api/enrollment/stats");
    statPending.textContent = s.pending ?? 0;
    statApproved.textContent = s.approved ?? 0;
    statDenied.textContent = s.denied ?? 0;
    if (statSuspicious) statSuspicious.textContent = s.suspicious ?? 0;

    // Load banned IPs count
    try {
      const b = await api("/api/enrollment/banned-ips");
      statBannedIps.textContent = (b.items || []).length;
    } catch { statBannedIps.textContent = 0; }

    // Update nav badge
    const badge = document.getElementById("enrollment-badge");
    if (badge) {
      if (s.pending > 0) {
        badge.textContent = s.pending;
        badge.classList.remove("hidden");
      } else {
        badge.classList.add("hidden");
      }
    }
  } catch {}
}

async function loadClients() {
  const hasRows = body.querySelector("tr[data-id]");
  loadingRow.classList.toggle("hidden", !!hasRows);
  emptyEl.classList.add("hidden");
  if (!hasRows) paginationEl?.classList.add("hidden");

  const fetchFilter = currentFilter;
  try {
    const data = await api(`/api/clients?page=1&pageSize=1000&enrollmentFilter=${fetchFilter}`);
    clients = data.items || [];
  } catch {
    clients = [];
  }

  // Sort by newest first (highest lastSeen = most recent)
  clients.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

  const filtered = getFilteredClients();
  const q = searchQuery.toLowerCase().trim();

  loadingRow.classList.add("hidden");

  const showBulkActions = (currentFilter === "pending" || currentFilter === "suspicious") &&
    filtered.some((c) => (c.enrollmentStatus || "pending") === "pending");
  approveAllBtn.classList.toggle("hidden", !showBulkActions);
  denyAllBtn.classList.toggle("hidden", !showBulkActions);

  if (filtered.length === 0) {
    lastEnrollmentDigest = `empty:${currentFilter}:${q}`;
    body.querySelectorAll("tr:not(#enrollment-loading)").forEach((r) => r.remove());
    emptyEl.classList.remove("hidden");
    paginationEl?.classList.add("hidden");
    paginationEl?.classList.remove("flex");
    updateBulkButtons();
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / rowsPerPage));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const startIndex = (currentPage - 1) * rowsPerPage;
  const visible = filtered.slice(startIndex, startIndex + rowsPerPage);
  updatePagination(filtered.length, startIndex, visible.length, totalPages);

  const nextDigest = tableDigest(visible, [
    "id",
    "host",
    "user",
    "os",
    "cpu",
    "gpu",
    "ram",
    "ip",
    "country",
    "keyFingerprint",
    "lastSeen",
    "enrollmentStatus",
    "denyReason",
    "suspiciousFlags",
  ], { total: filtered.length, page: currentPage, rowsPerPage, filter: currentFilter, q });
  if (nextDigest === lastEnrollmentDigest) {
    updateBulkButtons();
    return;
  }
  lastEnrollmentDigest = nextDigest;

  const selectedBeforeRender = new Set(getSelectedIds());
  body.querySelectorAll("tr:not(#enrollment-loading)").forEach((r) => r.remove());

  const fragment = document.createDocumentFragment();
  for (const c of visible) {
    const tr = document.createElement("tr");
    tr.className = "group hover:bg-slate-800/45 transition-colors";
    tr.dataset.id = c.id;

    const statusPill = statusBadgeWithReason(c.enrollmentStatus || "pending", c.denyReason);
    const fp = c.keyFingerprint ? c.keyFingerprint.substring(0, 16) + "..." : "-";
    const lastSeen = c.lastSeen ? timeAgo(c.lastSeen) : "-";
    const riskBadges = suspiciousBadges(c.suspiciousFlags);

    tr.innerHTML = `
      <td class="px-4 py-3"><input type="checkbox" class="row-check h-4 w-4 rounded border-slate-600 bg-slate-950/60" data-id="${esc(c.id)}" ${selectedBeforeRender.has(c.id) ? "checked" : ""} /></td>
      <td class="px-4 py-3 text-sm font-medium text-slate-200">
        <div class="flex items-center gap-3 min-w-[190px]">
          <span class="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-slate-700 bg-slate-950/70 text-slate-400 group-hover:border-amber-400/40 group-hover:text-amber-300 transition-colors">
            <i class="fa-solid fa-desktop text-xs"></i>
          </span>
          <span class="min-w-0">
            <span class="block truncate">${esc(c.host || c.id)}</span>
            ${riskBadges ? `<span class="mt-1 flex flex-wrap gap-1">${riskBadges}</span>` : ""}
          </span>
        </div>
      </td>
      <td class="px-4 py-3 text-sm text-slate-400">${esc(c.user || "-")}</td>
      <td class="px-4 py-3 text-sm text-slate-400">${esc(c.os || "-")}</td>
      <td class="px-4 py-3 text-sm text-slate-400">${expandableCell(c.id, "cpu", c.cpu)}</td>
      <td class="px-4 py-3 text-sm text-slate-400">${c.gpu ? dedupeGpu(c.gpu) : esc("-")}</td>
      <td class="px-4 py-3 text-sm text-slate-400">${esc(c.ram || "-")}</td>
      <td class="px-4 py-3 text-sm text-slate-400">${esc(c.ip || "-")}</td>
      <td class="px-4 py-3 text-sm text-slate-400">${esc(c.country || "-")}</td>
      <td class="px-4 py-3 text-sm text-slate-500 font-mono">${esc(fp)}</td>
      <td class="px-4 py-3 text-sm text-slate-500">${lastSeen}</td>
      <td class="px-4 py-3">${statusPill}</td>
      <td class="px-4 py-3"><div class="flex items-center justify-end gap-2 flex-nowrap">${actionButtons(c)}</div></td>
    `;
    tr.classList.add("cursor-pointer");
    fragment.appendChild(tr);
  }
  body.appendChild(fragment);
  updateBulkButtons();
}

function getFilteredClients() {
  let base = clients;
  if (currentFilter === "suspicious") {
    base = clients.filter((c) => (c.suspiciousFlags || []).length > 0);
  }

  const q = searchQuery.toLowerCase().trim();
  if (!q) return base;

  return base.filter((c) => {
    const fields = [c.host, c.user, c.ip, c.id, c.os, c.country, c.keyFingerprint, c.cpu, c.gpu, c.ram];
    return fields.some((f) => f && String(f).toLowerCase().includes(q));
  });
}

function tableDigest(items, fields, meta = {}) {
  return JSON.stringify({ meta, rows: items.map((item) => {
    const row = {};
    for (const field of fields) row[field] = item[field] ?? null;
    return row;
  }) });
}

function updatePagination(total, startIndex, visibleCount, totalPages) {
  if (!paginationEl || !pageSummaryEl || !pageLabelEl || !prevPageBtn || !nextPageBtn) return;
  paginationEl.classList.toggle("hidden", total <= rowsPerPage);
  paginationEl.classList.toggle("flex", total > rowsPerPage);
  const from = total === 0 ? 0 : startIndex + 1;
  const to = startIndex + visibleCount;
  pageSummaryEl.textContent = `Showing ${from}-${to} of ${total}`;
  pageLabelEl.textContent = `Page ${currentPage} / ${totalPages}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= totalPages;
}

function statusBadge(status) {
  const map = {
    pending:
      '<span class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/35"><i class="fa-solid fa-clock"></i>Pending</span>',
    approved:
      '<span class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/35"><i class="fa-solid fa-check"></i>Approved</span>',
    denied:
      '<span class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-red-500/15 text-red-300 border border-red-500/35"><i class="fa-solid fa-ban"></i>Denied</span>',
  };
  return map[status] || map.pending;
}

function statusBadgeWithReason(status, denyReason) {
  const pill = statusBadge(status);
  if (status === "denied" && denyReason) {
    return `<div class="space-y-0.5">${pill}<div class="text-xs text-slate-500 italic max-w-[140px] truncate" title="${esc(denyReason)}">${esc(denyReason)}</div></div>`;
  }
  return pill;
}

function suspiciousBadges(flags) {
  if (!flags || flags.length === 0) return "";
  return flags.map((f) => {
    const label = SUSPICIOUS_FLAG_LABELS[f] || f;
    const isFlood = f.endsWith("_flood");
    const color = isFlood ? "bg-red-500/20 text-red-300 border-red-500/40" : "bg-amber-500/20 text-amber-300 border-amber-500/40";
    return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs ${color} border cursor-help" title="${esc(label)}"><i class="fa-solid fa-triangle-exclamation text-[9px]"></i>${esc(label.split(" ")[0])}</span>`;
  }).join(" ");
}

function actionButtons(c) {
  const status = c.enrollmentStatus || "pending";
  let html = "";
  if (status !== "approved") {
    html += `<button class="act-approve whitespace-nowrap px-2.5 py-1.5 rounded-md text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm shadow-emerald-950/30" data-id="${esc(c.id)}"><i class="fa-solid fa-check mr-1"></i>Approve</button>`;
  }
  if (status !== "denied") {
    html += `<button class="act-deny whitespace-nowrap px-2.5 py-1.5 rounded-md text-xs font-medium bg-red-600 hover:bg-red-700 text-white shadow-sm shadow-red-950/30" data-id="${esc(c.id)}"><i class="fa-solid fa-ban mr-1"></i>Deny</button>`;
  }
  if (status !== "pending") {
    html += `<button class="act-reset whitespace-nowrap px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-700 hover:bg-slate-600 text-white" data-id="${esc(c.id)}"><i class="fa-solid fa-rotate-left mr-1"></i>Reset</button>`;
  }
  if (c.ip) {
    html += `<button class="act-ban-ip whitespace-nowrap px-2.5 py-1.5 rounded-md text-xs font-medium bg-rose-700 hover:bg-rose-800 text-white" data-id="${esc(c.id)}" title="Ban IP ${esc(c.ip)}"><i class="fa-solid fa-shield-halved mr-1"></i>Ban IP</button>`;
  }
  return html;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}

function dedupeGpu(raw) {
  if (!raw) return null;
  const counts = new Map();
  raw.split(",").map(s => s.trim()).filter(Boolean).forEach(g => counts.set(g, (counts.get(g) || 0) + 1));
  return [...counts.entries()].map(([name, n]) => n > 1 ? `${esc(name)} <span class="hw-gpu-count">&times;${n}</span>` : esc(name)).join(", ");
}

function expandableCell(clientId, field, value) {
  const text = value || "-";
  if (text === "-" || text.length <= 24) {
    return `<span>${esc(text)}</span>`;
  }
  const key = `${clientId}:${field}`;
  const isOpen = expandedCells.has(key);
  const short = text.substring(0, 22) + "…";
  return `<span class="hw-expand cursor-pointer select-none" data-expand-key="${esc(key)}" data-expanded="${isOpen ? "1" : "0"}">` +
    `<span class="hw-short${isOpen ? " hidden" : ""}">${esc(short)}</span>` +
    `<span class="hw-full${isOpen ? "" : " hidden"}">${esc(text)}</span>` +
    `<i class="fa-solid fa-chevron-down text-[10px] ml-1 text-slate-500 transition-transform hw-chevron" style="${isOpen ? "transform:rotate(180deg)" : ""}"></i>` +
    `</span>`;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// ── Event handlers ─────────────────────────────────────────────────
async function setStatus(clientId, action) {
  try {
    await api(`/api/enrollment/${encodeURIComponent(clientId)}/${action}`, { method: "POST" });
    if (window.showToast) window.showToast(`Client ${action}`, "success");
  } catch (e) {
    if (window.showToast) window.showToast(`Failed: ${e.message}`, "error");
  }
  await Promise.all([loadClients(), loadStats()]);
}

async function denyClient(clientId, reason) {
  try {
    await api(`/api/enrollment/${encodeURIComponent(clientId)}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason || undefined }),
    });
    if (window.showToast) window.showToast("Client denied", "success");
  } catch (e) {
    if (window.showToast) window.showToast(`Failed: ${e.message}`, "error");
  }
  await Promise.all([loadClients(), loadStats()]);
}

async function bulkAction(action) {
  const ids = getSelectedIds();
  if (ids.length === 0) return;
  try {
    await api("/api/enrollment/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, action }),
    });
    if (window.showToast) window.showToast(`${ids.length} clients ${action}`, "success");
  } catch (e) {
    if (window.showToast) window.showToast(`Failed: ${e.message}`, "error");
  }
  selectAllEl.checked = false;
  await Promise.all([loadClients(), loadStats()]);
}

function getSelectedIds() {
  return [...document.querySelectorAll(".row-check:checked")].map(
    (el) => el.dataset.id,
  );
}

function updateBulkButtons() {
  const rowChecks = [...document.querySelectorAll(".row-check")];
  const selected = getSelectedIds();
  const count = selected.length;
  bulkApproveBtn.classList.toggle("hidden", count === 0);
  bulkDenyBtn.classList.toggle("hidden", count === 0);
  bulkBanBtn.classList.toggle("hidden", count === 0);
  if (selectAllEl) {
    selectAllEl.checked = rowChecks.length > 0 && rowChecks.every((cb) => cb.checked);
  }
}

// ── Tab switching ──────────────────────────────────────────────────
document.querySelectorAll(".enrollment-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    currentFilter = tab.dataset.filter;
    currentPage = 1;
    lastEnrollmentDigest = "";
    document.querySelectorAll(".enrollment-tab").forEach((t) => {
      t.className =
        "enrollment-tab px-4 py-2 rounded-md text-sm font-medium bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700";
    });
    const colorMap = {
      pending: "bg-amber-500/20 text-amber-300 border-amber-500/40",
      denied: "bg-red-500/20 text-red-300 border-red-500/40",
      approved: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
      "banned-ips": "bg-rose-500/20 text-rose-300 border-rose-500/40",
      suspicious: "bg-orange-500/20 text-orange-300 border-orange-500/40",
    };
    tab.className = `enrollment-tab px-4 py-2 rounded-md text-sm font-medium ${colorMap[currentFilter] || ""} border`;

    if (currentFilter === "banned-ips") {
      if (clientsTable) clientsTable.classList.add("hidden");
      emptyEl.classList.add("hidden");
      bannedIpsSection.classList.remove("hidden");
      approveAllBtn.classList.add("hidden");
      denyAllBtn.classList.add("hidden");
      loadBannedIps();
    } else {
      bannedIpsSection.classList.add("hidden");
      if (clientsTable) clientsTable.classList.remove("hidden");
      loadClients();
    }
  });
});

// ── Table delegation ───────────────────────────────────────────────
body.addEventListener("click", (e) => {
  // Expandable CPU/GPU cells
  const expander = e.target.closest(".hw-expand");
  if (expander) {
    const isOpen = expander.dataset.expanded === "1";
    const key = expander.dataset.expandKey;
    expander.dataset.expanded = isOpen ? "0" : "1";
    if (isOpen) expandedCells.delete(key); else expandedCells.add(key);
    expander.querySelector(".hw-short").classList.toggle("hidden", !isOpen);
    expander.querySelector(".hw-full").classList.toggle("hidden", isOpen);
    const chevron = expander.querySelector(".hw-chevron");
    if (chevron) chevron.style.transform = isOpen ? "" : "rotate(180deg)";
    return;
  }

  const row = e.target.closest("tr[data-id]");
  if (
    row &&
    !e.target.closest("button, input, a, select, textarea")
  ) {
    const checkbox = row.querySelector(".row-check");
    if (checkbox) {
      checkbox.checked = !checkbox.checked;
      updateBulkButtons();
    }
    return;
  }

  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.dataset.id;
  if (!id) return;
  if (btn.classList.contains("act-approve")) setStatus(id, "approve");
  else if (btn.classList.contains("act-deny")) showDenyReasonModal(id);
  else if (btn.classList.contains("act-reset")) setStatus(id, "reset");
  else if (btn.classList.contains("act-ban-ip")) banClientIp(id);
});

body.addEventListener("change", () => updateBulkButtons());
selectAllEl.addEventListener("change", () => {
  document.querySelectorAll(".row-check").forEach((cb) => {
    cb.checked = selectAllEl.checked;
  });
  updateBulkButtons();
});

bulkApproveBtn.addEventListener("click", () => bulkAction("approve"));
bulkDenyBtn.addEventListener("click", () => bulkAction("deny"));
bulkBanBtn.addEventListener("click", () => {
  const ids = getSelectedIds();
  if (ids.length === 0) return;
  // Find IP info for selected clients
  const selected = clients.filter((c) => ids.includes(c.id) && c.ip);
  const ips = [...new Set(selected.map((c) => c.ip))];
  showBanModal(
    `You are about to <strong>ban ${ips.length} IP address${ips.length !== 1 ? "es" : ""}</strong> affecting <strong>${ids.length} client${ids.length !== 1 ? "s" : ""}</strong>. Banned IPs will be blocked from all future connections.`,
    ips,
    async () => {
      await bulkAction("ban-ip");
    },
  );
});

// ── Search ─────────────────────────────────────────────────────────
let searchDebounce;
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchQuery = searchInput.value;
    currentPage = 1;
    lastEnrollmentDigest = "";
    loadClients();
  }, 250);
});

pageSizeEl?.addEventListener("change", () => {
  rowsPerPage = Number(pageSizeEl.value) || 100;
  if (![50, 100, 200].includes(rowsPerPage)) rowsPerPage = 100;
  try {
    localStorage.setItem("purgatory_rows_per_page", String(rowsPerPage));
  } catch {}
  currentPage = 1;
  lastEnrollmentDigest = "";
  loadClients();
});

prevPageBtn?.addEventListener("click", () => {
  if (currentPage <= 1) return;
  currentPage -= 1;
  lastEnrollmentDigest = "";
  loadClients();
});

nextPageBtn?.addEventListener("click", () => {
  currentPage += 1;
  lastEnrollmentDigest = "";
  loadClients();
});

// ── Ban confirmation modal ──────────────────────────────────────────
let banModalResolve = null;

function showBanModal(message, ips, onConfirm) {
  let html = `<p class="mb-3">${message}</p>`;
  if (ips && ips.length > 0 && ips.length <= 10) {
    html += `<div class="bg-slate-800/60 border border-slate-700 rounded-lg p-3 font-mono text-xs text-rose-300 space-y-1">`;
    for (const ip of ips) html += `<div>${esc(ip)}</div>`;
    html += `</div>`;
  }
  banModalBody.innerHTML = html;
  banModal.classList.remove("hidden");
  banModalResolve = onConfirm;
}

function closeBanModal() {
  banModal.classList.add("hidden");
  banModalResolve = null;
}

banModalConfirm.addEventListener("click", async () => {
  const fn = banModalResolve;
  closeBanModal();
  if (fn) await fn();
});
banModalCancel.addEventListener("click", closeBanModal);
banModalBackdrop.addEventListener("click", closeBanModal);

// ── Banned IPs ─────────────────────────────────────────────────────
async function banClientIp(clientId) {
  const client = clients.find((c) => c.id === clientId);
  const ipText = client?.ip ? ` (${client.ip})` : "";
  showBanModal(
    `You are about to <strong>ban the IP address</strong> of client <strong>${esc(client?.host || clientId)}</strong>${esc(ipText)}. This will block all connections from this IP.`,
    client?.ip ? [client.ip] : [],
    async () => {
      try {
        await api(`/api/enrollment/${encodeURIComponent(clientId)}/ban-ip`, { method: "POST" });
        if (window.showToast) window.showToast("IP banned", "success");
      } catch (e) {
        if (window.showToast) window.showToast(`Failed: ${e.message}`, "error");
      }
      await Promise.all([loadClients(), loadStats()]);
    },
  );
}

async function loadBannedIps() {
  bannedIpsBody.innerHTML = "";
  bannedIpsEmpty.classList.add("hidden");

  try {
    const data = await api("/api/enrollment/banned-ips");
    const items = data.items || [];

    if (items.length === 0) {
      bannedIpsEmpty.classList.remove("hidden");
      return;
    }

    for (const entry of items) {
      const tr = document.createElement("tr");
      tr.className = "hover:bg-slate-800/40 transition-colors";
      tr.innerHTML = `
        <td class="px-4 py-3 text-sm font-mono text-slate-200">${esc(entry.ip)}</td>
        <td class="px-4 py-3 text-sm text-slate-400">${esc(entry.reason || "-")}</td>
        <td class="px-4 py-3 text-sm text-slate-500">${entry.createdAt ? timeAgo(entry.createdAt) : "-"}</td>
        <td class="px-4 py-3 text-right">
          <button class="act-unban px-2 py-1 rounded text-xs font-medium bg-slate-600 hover:bg-slate-700 text-white" data-ip="${esc(entry.ip)}">
            <i class="fa-solid fa-unlock mr-1"></i>Unban
          </button>
        </td>
      `;
      bannedIpsBody.appendChild(tr);
    }
  } catch {
    bannedIpsEmpty.classList.remove("hidden");
  }
}

bannedIpsBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.classList.contains("act-unban")) {
    const ip = btn.dataset.ip;
    if (!ip) return;
    try {
      await api(`/api/enrollment/banned-ips?ip=${encodeURIComponent(ip)}`, { method: "DELETE" });
      if (window.showToast) window.showToast(`Unbanned ${ip}`, "success");
    } catch (e) {
      if (window.showToast) window.showToast(`Failed: ${e.message}`, "error");
    }
    await Promise.all([loadBannedIps(), loadStats()]);
  }
});

// ── Manual IP ban form ─────────────────────────────────────────────
addBanBtn.addEventListener("click", () => {
  manualBanForm.classList.toggle("hidden");
  banIpInput.value = "";
  banReasonInput.value = "";
  if (!manualBanForm.classList.contains("hidden")) banIpInput.focus();
});

cancelBanBtn.addEventListener("click", () => {
  manualBanForm.classList.add("hidden");
});

confirmBanBtn.addEventListener("click", async () => {
  const ip = banIpInput.value.trim();
  if (!ip) { banIpInput.focus(); return; }
  try {
    await api("/api/enrollment/ban-ip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip, reason: banReasonInput.value.trim() || undefined }),
    });
    if (window.showToast) window.showToast(`Banned ${ip}`, "success");
    manualBanForm.classList.add("hidden");
  } catch (e) {
    if (window.showToast) window.showToast(`Failed: ${e.message}`, "error");
  }
  await Promise.all([loadBannedIps(), loadStats()]);
});

// ── Always Allow toggle ────────────────────────────────────────────
autoAcceptToggle.addEventListener("change", async () => {
  const wantsAlwaysAllow = autoAcceptToggle.checked;
  if (wantsAlwaysAllow) {
    autoAcceptToggle.checked = false; // revert until confirmed
    autoAcceptModal.classList.remove("hidden");
  } else {
    try {
      await api("/api/enrollment/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireApproval: true }),
      });
      unlessSuspiciousRow.classList.add("hidden");
      if (window.showToast) window.showToast("Approval required — purgatory is active", "success");
    } catch (e) {
      autoAcceptToggle.checked = true; // revert on error
      if (window.showToast) window.showToast(`Failed: ${e.message}`, "error");
    }
  }
});

function closeAutoAcceptModal() {
  autoAcceptModal.classList.add("hidden");
}

autoAcceptModalCancel.addEventListener("click", closeAutoAcceptModal);
autoAcceptModalBackdrop.addEventListener("click", closeAutoAcceptModal);

autoAcceptModalConfirm.addEventListener("click", async () => {
  closeAutoAcceptModal();
  try {
    await api("/api/enrollment/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requireApproval: false }),
    });
    autoAcceptToggle.checked = true;
    unlessSuspiciousRow.classList.remove("hidden");
    if (window.showToast) window.showToast("Always Allow enabled — agents auto-approved on connect", "success");
  } catch (e) {
    if (window.showToast) window.showToast(`Failed: ${e.message}`, "error");
  }
});

// ── Unless Suspicious sub-toggle ──────────────────────────────────
unlessSuspiciousToggle.addEventListener("change", async () => {
  try {
    await api("/api/enrollment/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoApproveUnlessSuspicious: unlessSuspiciousToggle.checked }),
    });
    const msg = unlessSuspiciousToggle.checked
      ? "Suspicious agents will be held for review"
      : "All agents auto-approved regardless of flags";
    if (window.showToast) window.showToast(msg, "success");
  } catch (e) {
    unlessSuspiciousToggle.checked = !unlessSuspiciousToggle.checked; // revert
    if (window.showToast) window.showToast(`Failed: ${e.message}`, "error");
  }
});

// ── Approve All / Deny All ────────────────────────────────────────
function getActionablePendingIds() {
  return getFilteredClients()
    .filter((c) => (c.enrollmentStatus || "pending") === "pending")
    .map((c) => c.id);
}

approveAllBtn.addEventListener("click", async () => {
  const ids = getActionablePendingIds();
  if (ids.length === 0) return;
  try {
    await api("/api/enrollment/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, action: "approve" }),
    });
    if (window.showToast) window.showToast(`Approved ${ids.length} client${ids.length !== 1 ? "s" : ""}`, "success");
  } catch (e) {
    if (window.showToast) window.showToast(`Failed: ${e.message}`, "error");
  }
  await Promise.all([loadClients(), loadStats()]);
});

denyAllBtn.addEventListener("click", async () => {
  const ids = getActionablePendingIds();
  if (ids.length === 0) return;
  try {
    await api("/api/enrollment/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, action: "deny" }),
    });
    if (window.showToast) window.showToast(`Denied ${ids.length} client${ids.length !== 1 ? "s" : ""}`, "success");
  } catch (e) {
    if (window.showToast) window.showToast(`Failed: ${e.message}`, "error");
  }
  await Promise.all([loadClients(), loadStats()]);
});

// ── Deny Reason Modal ──────────────────────────────────────────────
let _denyTargetId = null;

function showDenyReasonModal(clientId) {
  _denyTargetId = clientId;
  denyReasonInput.value = "";
  denyReasonModal.classList.remove("hidden");
  setTimeout(() => denyReasonInput.focus(), 50);
}

function closeDenyReasonModal() {
  denyReasonModal.classList.add("hidden");
  _denyTargetId = null;
}

denyReasonModalCancel.addEventListener("click", closeDenyReasonModal);
denyReasonModalBackdrop.addEventListener("click", closeDenyReasonModal);

denyReasonInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") denyReasonModalConfirm.click();
  if (e.key === "Escape") closeDenyReasonModal();
});

denyReasonModalConfirm.addEventListener("click", async () => {
  const id = _denyTargetId;
  const reason = denyReasonInput.value.trim() || undefined;
  closeDenyReasonModal();
  if (!id) return;
  await denyClient(id, reason);
});

// ── Init ───────────────────────────────────────────────────────────
loadSettings();
loadStats();
loadClients();

// Auto-refresh every 15 seconds
setInterval(() => {
  loadStats();
  loadClients();
}, 15000);
