const logsContainer = document.getElementById("logs-container");
const logsEmpty = document.getElementById("logs-empty");
const lastUpdate = document.getElementById("last-update");
const clientFilter = document.getElementById("client-filter");
const startDateInput = document.getElementById("start-date");
const endDateInput = document.getElementById("end-date");
const refreshBtn = document.getElementById("refresh-btn");
const prevPageBtn = document.getElementById("prev-page");
const nextPageBtn = document.getElementById("next-page");
const pageInfo = document.getElementById("page-info");
const logsCount = document.getElementById("logs-count");
const clearFiltersBtn = document.getElementById("clear-filters-btn");

const actionLabels = {
  client_first_connect: {
    label: "First Connect",
    className: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    icon: "fa-plug-circle-bolt",
  },
  client_reconnect: {
    label: "Reconnect",
    className: "bg-blue-500/10 text-blue-300 border-blue-500/30",
    icon: "fa-rotate",
  },
  client_disconnect: {
    label: "Disconnect",
    className: "bg-orange-500/10 text-orange-300 border-orange-500/30",
    icon: "fa-plug-circle-xmark",
  },
  uninstall: {
    label: "Uninstall",
    className: "bg-rose-500/10 text-rose-300 border-rose-500/30",
    icon: "fa-trash",
  },
};

let page = 1;
const pageSize = 50;
let total = 0;

function formatTimestamp(ts) {
  if (!ts) return "-";
  const date = new Date(ts);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

function parseDetails(details) {
  if (!details) return "";
  try {
    const parsed = JSON.parse(details);
    return escapeHtml(JSON.stringify(parsed));
  } catch {
    return escapeHtml(details);
  }
}

function getSelectedActions() {
  return Array.from(document.querySelectorAll(".action-checkbox"))
    .filter((el) => el.checked)
    .map((el) => el.value);
}

function buildQuery() {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));

  const actions = getSelectedActions();
  if (actions.length > 0) {
    params.set("actions", actions.join(","));
  }

  const clientId = clientFilter?.value?.trim();
  if (clientId) {
    params.set("clientId", clientId);
  }

  if (startDateInput?.value) {
    const ts = new Date(startDateInput.value).getTime();
    if (!Number.isNaN(ts)) params.set("startDate", String(ts));
  }

  if (endDateInput?.value) {
    const ts = new Date(endDateInput.value).getTime();
    if (!Number.isNaN(ts)) params.set("endDate", String(ts));
  }

  return params;
}

function renderLogs(logs) {
  if (!logsContainer || !logsEmpty) return;

  logsContainer.innerHTML = "";
  if (!logs || logs.length === 0) {
    logsEmpty.classList.remove("hidden");
    if (logsCount) logsCount.textContent = "0 matching events";
    return;
  }
  logsEmpty.classList.add("hidden");
  if (logsCount) {
    const first = (page - 1) * pageSize + 1;
    const last = Math.min(first + logs.length - 1, total);
    logsCount.textContent = `${total.toLocaleString()} events · showing ${first}–${last}`;
  }

  logsContainer.innerHTML = logs
    .map((log) => {
      const meta = actionLabels[log.action] || {
        label: log.action,
        className: "bg-slate-800 text-slate-300 border-slate-700",
        icon: "fa-circle-info",
      };
      const clientId = log.targetClientId || "-";
      const shortId = clientId.length > 8 ? `${clientId.slice(0, 8)}...` : clientId;
      const detailText = parseDetails(log.details);

      return `
        <article class="px-4 sm:px-5 py-4 flex gap-3 sm:gap-4 hover:bg-slate-800/20 transition-colors">
          <div class="inline-flex items-center justify-center w-9 h-9 shrink-0 rounded-lg border ${meta.className}">
            <i class="fa-solid ${meta.icon}"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-sm font-semibold text-slate-200">${escapeHtml(meta.label || "Event")}</span>
                <span class="text-xs text-slate-500">Client</span>
                <span class="font-mono text-xs text-sky-300 truncate" title="${escapeHtml(clientId)}">${escapeHtml(shortId)}</span>
              </div>
              <time class="text-xs text-slate-500 shrink-0">${formatTimestamp(log.timestamp)}</time>
            </div>
            <div class="mt-1.5 text-xs text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
              <span><i class="fa-solid fa-globe mr-1 text-slate-600"></i>${escapeHtml(log.ip || "-")}</span>
              <span><i class="fa-solid fa-user mr-1 text-slate-600"></i>${escapeHtml(log.username || "-")}</span>
            </div>
            ${detailText ? `<div class="mt-2 rounded-md bg-slate-950/60 border border-slate-800 px-2.5 py-2 text-xs font-mono text-slate-400 break-all">${detailText}</div>` : ""}
          </div>
        </article>
      `;
    })
    .join("");
}

async function loadLogs() {
  try {
    if (refreshBtn) refreshBtn.disabled = true;
    if (logsCount) logsCount.textContent = "Loading events…";
    if (getSelectedActions().length === 0) {
      total = 0;
      page = 1;
      renderLogs([]);
      pageInfo.textContent = "Page 1 of 1";
      prevPageBtn.disabled = true;
      nextPageBtn.disabled = true;
      lastUpdate.textContent = new Date().toLocaleTimeString();
      return;
    }
    const params = buildQuery();
    const res = await fetch(`/api/audit-logs?${params.toString()}`);
    if (!res.ok) {
      throw new Error("Failed to load logs");
    }
    const data = await res.json();
    total = data.total || 0;
    renderLogs(data.logs || []);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (pageInfo) pageInfo.textContent = `Page ${page} of ${totalPages}`;

    if (prevPageBtn) prevPageBtn.disabled = page <= 1;
    if (nextPageBtn) nextPageBtn.disabled = page >= totalPages;

    if (lastUpdate) lastUpdate.textContent = new Date().toLocaleTimeString();
  } catch (err) {
    console.error("Failed to load logs", err);
    if (logsContainer) {
      logsContainer.innerHTML = `
        <div class="px-5 py-12 text-center text-rose-300 text-sm"><i class="fa-solid fa-circle-exclamation mr-2"></i>Failed to load logs. Please try again.</div>
      `;
    }
    if (logsCount) logsCount.textContent = "Unable to load events";
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function resetAndLoad() {
  page = 1;
  loadLogs();
}

let debounceTimer = null;
function debounceLoad() {
  if (debounceTimer) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => resetAndLoad(), 300);
}

clientFilter?.addEventListener("input", debounceLoad);
startDateInput?.addEventListener("change", resetAndLoad);
endDateInput?.addEventListener("change", resetAndLoad);
refreshBtn?.addEventListener("click", resetAndLoad);
clearFiltersBtn?.addEventListener("click", () => {
  if (clientFilter) clientFilter.value = "";
  if (startDateInput) startDateInput.value = "";
  if (endDateInput) endDateInput.value = "";
  document.querySelectorAll(".action-checkbox").forEach((checkbox) => {
    checkbox.checked = true;
  });
  resetAndLoad();
});

Array.from(document.querySelectorAll(".action-checkbox")).forEach((cb) => {
  cb.addEventListener("change", resetAndLoad);
});

prevPageBtn?.addEventListener("click", () => {
  if (page > 1) {
    page -= 1;
    loadLogs();
  }
});

nextPageBtn?.addEventListener("click", () => {
  page += 1;
  loadLogs();
});

loadLogs();
