import { encodeMsgpack, decodeMsgpack } from "./msgpack-helpers.js";
import { checkFeatureAccess } from "./feature-gate.js";

const clientId = window.location.pathname.split("/")[1];
let ws = null;
let processes = [];
let processMap = new Map();
let processTree = [];
let collapsedPids = new Set();
let selectedPid = null;
let rowsByPid = new Map();
let sortField = "cpu";
let sortDirection = "desc";
let searchTerm = "";

const statusEl = document.getElementById("status-indicator");
const processCountEl = document.getElementById("process-count");
const processListEl = document.getElementById("process-list");
const refreshBtn = document.getElementById("refresh-btn");
const killBtn = document.getElementById("kill-btn");
const searchInput = document.getElementById("search-input");
const clientIdHeader = document.getElementById("client-id-header");

if (clientIdHeader) {
  clientIdHeader.textContent = `${clientId} - Process Manager`;
}

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/api/clients/${clientId}/processes/ws`;

  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("Process manager connected");
    updateStatus("connected", "Connected");
    enableControls(true);
    requestProcessList();
  };

  ws.onmessage = (event) => {
    const msg = decodeMsgpack(event.data);
    if (!msg) {
      console.error("Failed to decode message");
      return;
    }
    handleMessage(msg);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    updateStatus("error", "Connection Error");
  };

  ws.onclose = () => {
    console.log("Process manager disconnected");
    updateStatus("disconnected", "Disconnected");
    enableControls(false);
    setTimeout(() => connect(), 3000);
  };
}

function updateStatus(state, text) {
  const icons = {
    connecting: '<i class="fa-solid fa-circle-notch fa-spin"></i>',
    connected: '<i class="fa-solid fa-circle text-green-400"></i>',
    error: '<i class="fa-solid fa-circle-exclamation text-red-400"></i>',
    disconnected: '<i class="fa-solid fa-circle text-slate-500"></i>',
  };

  statusEl.innerHTML = `${icons[state] || icons.disconnected} ${text}`;
  statusEl.className =
    state === "connected"
      ? "inline-flex items-center gap-2 px-3 py-2 rounded-full bg-green-900/40 text-green-100 border border-green-700/60"
      : "inline-flex items-center gap-2 px-3 py-2 rounded-full bg-slate-800 text-slate-300";
}

function enableControls(enabled) {
  refreshBtn.disabled = !enabled;
  updateKillButton();
}

function updateKillButton() {
  killBtn.disabled = !selectedPid || !ws || ws.readyState !== WebSocket.OPEN;
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(encodeMsgpack(msg));
  }
}

function handleMessage(msg) {
  console.log("Received:", msg.type);

  switch (msg.type) {
    case "ready":
      console.log("Session ready:", msg.sessionId);
      break;
    case "status":
      if (msg.status === "offline") {
        updateStatus("error", "Client Offline");
        enableControls(false);
      }
      break;
    case "process_list_result":
      handleProcessList(msg);
      break;
    case "command_result":
      handleCommandResult(msg);
      break;
    default:
      console.log("Unknown message type:", msg.type);
  }
}

function requestProcessList() {
  send({ type: "process_list" });
  updateStatus("connected", "Loading processes...");
}

function handleProcessList(msg) {
  if (msg.error) {
    processListEl.innerHTML = `<div class="px-4 py-6 text-center text-red-400"><i class="fa-solid fa-exclamation-triangle mr-2"></i>${escapeHtml(msg.error)}</div>`;
    updateStatus("error", "Error loading processes");
    return;
  }

  processes = (msg.processes || []).map((proc) => {
    const normalizeId = (value) => {
      if (typeof value === "bigint") {
        return Number(value);
      }
      if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
      }
      return Number.isFinite(value) ? value : 0;
    };
    return {
      ...proc,
      pid: normalizeId(proc.pid),
      ppid: normalizeId(proc.ppid),
    };
  });
  processCountEl.innerHTML = `<i class="fa-solid fa-list"></i> ${processes.length} processes`;
  updateStatus("connected", "Connected");
  buildProcessTree();
  renderProcesses();
}

function buildProcessTree() {
  processMap.clear();
  processes.forEach((proc) => {
    processMap.set(proc.pid, { ...proc, children: [] });
  });

  const isShellParent = (proc) =>
    proc && typeof proc.name === "string" && proc.name.toLowerCase() === "explorer.exe";

  const roots = [];
  processMap.forEach((proc) => {
    const parent = proc.ppid ? processMap.get(proc.ppid) : null;
    if (parent && proc.ppid !== proc.pid && !isShellParent(parent)) {
      parent.children.push(proc);
    } else {
      roots.push(proc);
    }
  });

  function computeAggregates(proc) {
    let cpuTotal = proc.cpu || 0;
    let memTotal = Number(proc.memory || 0);
    for (const child of proc.children) {
      const [childCpu, childMem] = computeAggregates(child);
      cpuTotal += childCpu;
      memTotal += childMem;
    }
    proc.aggregatedCpu = Math.min(cpuTotal, 100);
    proc.aggregatedMemory = memTotal;
    return [cpuTotal, memTotal];
  }
  roots.forEach(computeAggregates);

  const sortValue = (proc) => {
    if (sortField === "cpu") return proc.aggregatedCpu;
    if (sortField === "memory") return proc.aggregatedMemory;
    if (sortField === "name") return proc.name.toLowerCase();
    return proc[sortField];
  };
  const cmp = (a, b) => {
    const aVal = sortValue(a);
    const bVal = sortValue(b);
    if (sortDirection === "asc") return aVal > bVal ? 1 : -1;
    return aVal < bVal ? 1 : -1;
  };

  function sortChildren(proc) {
    if (proc.children.length > 0) {
      proc.children.sort(cmp);
      proc.children.forEach(sortChildren);
    }
  }
  roots.forEach(sortChildren);
  roots.sort(cmp);

  processTree = roots;
}

function renderProcesses() {
  const filtered = [];

  function collectMatches(proc, depth = 0) {
    const matches =
      !searchTerm ||
      proc.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      proc.pid.toString().includes(searchTerm) ||
      (proc.username &&
        proc.username.toLowerCase().includes(searchTerm.toLowerCase()));

    if (matches) {
      filtered.push({ ...proc, depth });
    }

    if (
      proc.children &&
      proc.children.length > 0 &&
      !collapsedPids.has(proc.pid)
    ) {
      proc.children.forEach((child) => collectMatches(child, depth + 1));
    }
  }

  processTree.forEach((proc) => collectMatches(proc, 0));

  if (filtered.length === 0) {
    processListEl.innerHTML =
      '<div class="px-4 py-6 text-center text-slate-400"><i class="fa-solid fa-inbox mr-2"></i>No processes found</div>';
    rowsByPid.clear();
    return;
  }

  for (const child of [...processListEl.children]) {
    if (!child.classList.contains("process-row")) child.remove();
  }

  const seen = new Set();
  filtered.forEach((proc, index) => {
    seen.add(proc.pid);
    let row = rowsByPid.get(proc.pid);
    if (!row) {
      row = createProcessRow(proc, proc.depth);
      rowsByPid.set(proc.pid, row);
    } else {
      updateProcessRow(row, proc, proc.depth);
    }
    if (processListEl.children[index] !== row) {
      processListEl.insertBefore(row, processListEl.children[index] || null);
    }
  });

  for (const [pid, row] of rowsByPid) {
    if (!seen.has(pid)) {
      row.remove();
      rowsByPid.delete(pid);
    }
  }
}

function rowClassName(proc) {
  let cls =
    "process-row grid grid-cols-12 gap-3 px-4 py-3 border border-transparent cursor-pointer transition-colors";
  if (selectedPid === proc.pid) cls += " selected";
  if (proc.self) cls += " self-process";
  return cls;
}

function rowInnerHtml(proc, depth) {
  const displayCpu = proc.aggregatedCpu ?? proc.cpu;
  const displayMemory = proc.aggregatedMemory ?? Number(proc.memory || 0);
  const cpuColor =
    displayCpu > 50
      ? "text-red-400"
      : displayCpu > 25
        ? "text-orange-400"
        : displayCpu > 10
          ? "text-yellow-400"
          : displayCpu > 1
            ? "text-slate-200"
            : "text-slate-500";
  const MB = 1024 * 1024;
  const memColor =
    displayMemory > 2048 * MB
      ? "text-red-400"
      : displayMemory > 1024 * MB
        ? "text-orange-400"
        : displayMemory > 256 * MB
          ? "text-yellow-400"
          : displayMemory > 32 * MB
            ? "text-slate-200"
            : "text-slate-500";
  const memoryStr = formatBytes(displayMemory);

  const hasChildren = proc.children && proc.children.length > 0;
  const isCollapsed = collapsedPids.has(proc.pid);
  const indent = '<span class="tree-indent-guide"></span>'.repeat(depth);

  let treeIcon;
  if (hasChildren) {
    treeIcon = `<span class="tree-icon${isCollapsed ? " collapsed" : ""}" data-pid="${escapeHtml(String(proc.pid))}"><i class="fa-solid fa-chevron-down text-[10px]"></i></span>`;
  } else {
    treeIcon = '<span class="tree-indent"></span>';
  }

  let nameColor = "text-slate-200";
  let iconClass = "fa-microchip";
  let iconColor = "text-blue-400";
  if (proc.type === "system") {
    nameColor = "text-purple-400";
    iconColor = "text-purple-400";
  } else if (proc.type === "service") {
    nameColor = "text-cyan-400";
    iconColor = "text-cyan-400";
  } else if (proc.type === "own") {
    nameColor = "text-green-300";
    iconColor = "text-green-400";
  }
  if (proc.self) {
    nameColor = "text-yellow-300 font-semibold";
    iconClass = "fa-crosshairs";
    iconColor = "text-yellow-400";
  }

  const selfBadge = proc.self
    ? ' <span class="ml-1 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300 border border-yellow-500/40">agent</span>'
    : "";

  return `
    <div class="col-span-1 text-sm font-mono text-slate-400">${proc.pid}</div>
    <div class="col-span-4 flex items-center gap-1 truncate">
      ${indent}${treeIcon}<i class="fa-solid ${iconClass} ${iconColor}"></i>
      <span class="truncate ${nameColor}">${escapeHtml(proc.name)}</span>${selfBadge}
    </div>
    <div class="col-span-2 text-sm ${cpuColor} font-semibold">${displayCpu.toFixed(1)}%</div>
    <div class="col-span-2 text-sm ${memColor}">${memoryStr}</div>
    <div class="col-span-3 text-sm text-slate-500 truncate">${escapeHtml(proc.username || "-")}</div>
  `;
}

function updateProcessRow(row, proc, depth) {
  const nextClass = rowClassName(proc);
  if (row.className !== nextClass) row.className = nextClass;
  row.innerHTML = rowInnerHtml(proc, depth);
}

function createProcessRow(proc, depth = 0) {
  const row = document.createElement("div");
  row.dataset.pid = proc.pid;
  row.className = rowClassName(proc);
  row.innerHTML = rowInnerHtml(proc, depth);

  row.onclick = (e) => {
    const pid = Number(row.dataset.pid);
    if (e.target.closest(".tree-icon")) {
      toggleCollapse(pid);
      return;
    }
    selectProcess(pid);
  };

  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const pid = Number(row.dataset.pid);
    selectProcess(pid);
    showContextMenu(e.clientX, e.clientY, pid);
  };

  return row;
}

function toggleCollapse(pid) {
  if (collapsedPids.has(pid)) {
    collapsedPids.delete(pid);
  } else {
    collapsedPids.add(pid);
  }
  renderProcesses();
}

function selectProcess(pid) {
  selectedPid = pid;
  updateKillButton();
  renderProcesses();
}

function killProcess() {
  if (!selectedPid) return;

  const proc = processes.find((p) => p.pid === selectedPid);
  if (!proc) return;

  if (!confirm(`Kill process "${proc.name}" (PID: ${proc.pid})?`)) return;

  const pid = Number(selectedPid);
  if (!Number.isFinite(pid) || pid <= 0) {
    alert("Invalid PID selected.");
    return;
  }
  console.log("Killing process:", pid);
  send({ type: "process_kill", pid });
  updateStatus("connected", "Killing process...");
}

function handleCommandResult(msg) {
  if (!msg.ok) {
    alert(`Operation failed: ${msg.message || "Unknown error"}`);
    updateStatus("connected", "Connected");
  } else {
    setTimeout(() => requestProcessList(), 500);
  }
}
function setSortField(field) {
  if (sortField === field) {
    sortDirection = sortDirection === "asc" ? "desc" : "asc";
  } else {
    sortField = field;
    sortDirection = field === "name" ? "asc" : "desc";
  }
  buildProcessTree();
  renderProcesses();
  updateSortIndicators();
}

function updateSortIndicators() {
  document.querySelectorAll('[id^="sort-"]').forEach((el) => {
    const field = el.id.replace("sort-", "");
    const icon = el.querySelector("i");
    if (field === sortField) {
      icon.className =
        sortDirection === "asc"
          ? "fa-solid fa-sort-up"
          : "fa-solid fa-sort-down";
    } else {
      icon.className = "fa-solid fa-sort";
    }
  });
}

function formatBytes(bytes) {
  if (bytes === 0 || bytes === 0n) return "0 B";
  const sizes = ["B", "KB", "MB", "GB"];
  if (typeof bytes === "bigint") {
    const k = 1024n;
    let i = 0;
    let value = bytes;
    while (value >= k && i < sizes.length - 1) {
      value /= k;
      i += 1;
    }
    return `${value.toString()} ${sizes[i]}`;
  }
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Context menu
let contextMenuEl = null;

function createContextMenu() {
  const menu = document.createElement("div");
  menu.id = "process-context-menu";
  menu.className = "fixed z-50 hidden min-w-[180px] bg-slate-800 border border-slate-700 rounded-lg shadow-xl shadow-black/40 py-1 text-sm";
  menu.innerHTML = `
    <button data-action="suspend" class="ctx-item w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-slate-700 text-slate-200">
      <i class="fa-solid fa-pause w-4 text-center text-yellow-400"></i> Suspend Process
    </button>
    <button data-action="resume" class="ctx-item w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-slate-700 text-slate-200">
      <i class="fa-solid fa-play w-4 text-center text-green-400"></i> Resume Process
    </button>
    <div class="border-t border-slate-700 my-1"></div>
    <button data-action="kill" class="ctx-item w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-slate-700 text-slate-200">
      <i class="fa-solid fa-skull-crossbones w-4 text-center text-red-400"></i> Kill Process
    </button>
    <button data-action="kill-tree" class="ctx-item w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-slate-700 text-slate-200">
      <i class="fa-solid fa-diagram-project w-4 text-center text-red-400"></i> Kill Process Tree
    </button>
    <div class="border-t border-slate-700 my-1"></div>
    <button data-action="copy-pid" class="ctx-item w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-slate-700 text-slate-200">
      <i class="fa-solid fa-copy w-4 text-center text-blue-400"></i> Copy PID
    </button>
    <button data-action="copy-name" class="ctx-item w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-slate-700 text-slate-200">
      <i class="fa-solid fa-tag w-4 text-center text-blue-400"></i> Copy Name
    </button>
    <div class="border-t border-slate-700 my-1"></div>
    <button data-action="refresh" class="ctx-item w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-slate-700 text-slate-200">
      <i class="fa-solid fa-refresh w-4 text-center text-slate-400"></i> Refresh List
    </button>
  `;
  document.body.appendChild(menu);
  return menu;
}

function showContextMenu(x, y, pid) {
  if (!contextMenuEl) contextMenuEl = createContextMenu();
  contextMenuEl.dataset.pid = pid;
  contextMenuEl.classList.remove("hidden");

  const rect = contextMenuEl.getBoundingClientRect();
  const menuW = rect.width || 180;
  const menuH = rect.height || 300;
  const posX = x + menuW > window.innerWidth ? window.innerWidth - menuW - 8 : x;
  const posY = y + menuH > window.innerHeight ? window.innerHeight - menuH - 8 : y;

  contextMenuEl.style.left = posX + "px";
  contextMenuEl.style.top = posY + "px";
}

function hideContextMenu() {
  if (contextMenuEl) contextMenuEl.classList.add("hidden");
}

document.addEventListener("click", hideContextMenu);
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest(".process-row") && !e.target.closest("#process-context-menu")) {
    hideContextMenu();
  }
});

document.addEventListener("click", (e) => {
  const item = e.target.closest(".ctx-item");
  if (!item || !contextMenuEl) return;
  const action = item.dataset.action;
  const pid = Number(contextMenuEl.dataset.pid);
  const proc = processes.find((p) => p.pid === pid);
  hideContextMenu();

  switch (action) {
    case "suspend":
      if (!proc) break;
      if (!confirm(`Suspend process "${proc.name}" (PID: ${pid})?`)) break;
      send({ type: "process_suspend", pid });
      updateStatus("connected", "Suspending process...");
      break;
    case "resume":
      if (!proc) break;
      send({ type: "process_resume", pid });
      updateStatus("connected", "Resuming process...");
      break;
    case "kill":
      if (!proc) break;
      if (!confirm(`Kill process "${proc.name}" (PID: ${pid})?`)) break;
      send({ type: "process_kill", pid });
      updateStatus("connected", "Killing process...");
      break;
    case "kill-tree":
      if (!proc) break;
      if (!confirm(`Kill process "${proc.name}" (PID: ${pid}) and all child processes?`)) break;
      killProcessTree(pid);
      break;
    case "copy-pid":
      navigator.clipboard.writeText(String(pid));
      break;
    case "copy-name":
      if (proc) navigator.clipboard.writeText(proc.name);
      break;
    case "refresh":
      requestProcessList();
      break;
  }
});

function killProcessTree(pid) {
  const toKill = [];
  function collectChildren(parentPid) {
    for (const proc of processes) {
      if (proc.ppid === parentPid && proc.pid !== parentPid) {
        collectChildren(proc.pid);
        toKill.push(proc.pid);
      }
    }
  }
  collectChildren(pid);
  toKill.push(pid);
  for (const p of toKill) {
    send({ type: "process_kill", pid: p });
  }
  updateStatus("connected", `Killing ${toKill.length} processes...`);
}

refreshBtn.onclick = () => requestProcessList();
killBtn.onclick = () => killProcess();

searchInput.oninput = (e) => {
  searchTerm = e.target.value;
  renderProcesses();
};

document.getElementById("sort-pid").onclick = () => setSortField("pid");
document.getElementById("sort-name").onclick = () => setSortField("name");
document.getElementById("sort-cpu").onclick = () => setSortField("cpu");
document.getElementById("sort-memory").onclick = () => setSortField("memory");

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    requestProcessList();
  }
}, 3000);

updateStatus("connecting", "Connecting...");
checkFeatureAccess("processes", clientId).then(ok => ok && connect());
updateSortIndicators();
