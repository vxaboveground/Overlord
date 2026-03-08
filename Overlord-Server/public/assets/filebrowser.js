import { encodeMsgpack, decodeMsgpack } from "./msgpack-helpers.js";

const clientId = window.location.pathname.split("/")[1];
let ws = null;
let currentPath = "";
let pathHistory = [];
let selectedFiles = new Set();
let fileDownloads = new Map();
let fileUploads = new Map();
let fileUploadsById = new Map();
let activeTransfers = new Map();
let currentEditingFile = null;
let lastSuccessfulResponse = 0;
let pendingToast = null;
const recentToasts = new Map();
const pendingCommandResults = new Map();
const pendingCommandWaiters = new Map();
const VIRTUALIZATION_THRESHOLD = 400;
const VIRTUAL_ROW_HEIGHT = 58;
const VIRTUAL_OVERSCAN = 8;

let directoryEntries = [];
let filteredDirectoryEntries = [];
let virtualScrollHandler = null;
let virtualResizeHandler = null;
let virtualRenderRaf = null;
let isVirtualizedList = false;

const statusEl = document.getElementById("status-indicator");
const breadcrumbEl = document.getElementById("breadcrumb");
const fileListEl = document.getElementById("file-list");
const refreshBtn = document.getElementById("refresh-btn");
const uploadBtn = document.getElementById("upload-btn");
const mkdirBtn = document.getElementById("mkdir-btn");
const searchBtn = document.getElementById("search-btn");
const fileInput = document.getElementById("file-input");
const contextMenu = document.getElementById("context-menu");
const clientIdHeader = document.getElementById("client-id-header");
const backBtn = document.getElementById("back-btn");
const homeBtn = document.getElementById("home-btn");
const pathInput = document.getElementById("path-input");
const pathGoBtn = document.getElementById("path-go-btn");
const transferPanel = document.getElementById("transfer-panel");
const transferList = document.getElementById("transfer-list");
const fileListPanel = document.getElementById("file-list-panel");
const sortFieldEl = document.getElementById("sort-field");
const sortOrderBtn = document.getElementById("sort-order-btn");
const filterTypeEl = document.getElementById("filter-type");
const fileCountSummaryEl = document.getElementById("file-count-summary");

const searchBar = document.getElementById("search-bar");
const searchInput = document.getElementById("search-input");
const searchContentCheckbox = document.getElementById(
  "search-content-checkbox",
);
const searchExecuteBtn = document.getElementById("search-execute-btn");
const searchCloseBtn = document.getElementById("search-close-btn");
const bulkActionsBar = document.getElementById("bulk-actions-bar");
const selectedCountEl = document.getElementById("selected-count");
const bulkDownloadBtn = document.getElementById("bulk-download-btn");
const bulkDeleteBtn = document.getElementById("bulk-delete-btn");
const bulkMoveBtn = document.getElementById("bulk-move-btn");
const bulkCopyBtn = document.getElementById("bulk-copy-btn");
const clearSelectionBtn = document.getElementById("clear-selection-btn");
const fileEditorModal = document.getElementById("file-editor-modal");
const editorTextarea = document.getElementById("editor-textarea");
const editorFileName = document.getElementById("editor-file-name");
const editorStatus = document.getElementById("editor-status");
const editorSaveBtn = document.getElementById("editor-save-btn");
const editorCancelBtn = document.getElementById("editor-cancel-btn");
const editorCloseBtn = document.getElementById("editor-close-btn");

if (clientIdHeader) {
  clientIdHeader.textContent = `${clientId} - File Browser`;
}

let sortField = localStorage.getItem("filebrowser.sortField") || "name";
let sortOrder = localStorage.getItem("filebrowser.sortOrder") || "asc";
let filterType = localStorage.getItem("filebrowser.filterType") || "all";
let dragDepth = 0;

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/api/clients/${clientId}/files/ws`;

  const socket = new WebSocket(wsUrl);
  socket.binaryType = "arraybuffer";
  ws = socket;

  socket.onopen = () => {
    console.log("File browser connected");
    updateStatus("connected", "Connected");
    enableControls(true);
    listFiles(currentPath || ".", socket);
  };

  socket.onmessage = (event) => {
    const msg = decodeMsgpack(event.data);
    if (!msg) {
      console.error("Failed to decode message");
      return;
    }
    handleMessage(msg);
  };

  socket.onerror = (err) => {
    console.error("WebSocket error:", err);
    updateStatus("error", "Connection Error");
  };

  socket.onclose = () => {
    console.log("File browser disconnected");
    updateStatus("disconnected", "Disconnected");
    enableControls(false);
    if (ws === socket) {
      setTimeout(() => connect(), 3000);
    }
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
  uploadBtn.disabled = !enabled;
  mkdirBtn.disabled = !enabled;
}

function send(msg, socket = ws) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    console.log(
      "[DEBUG] Sending message:",
      msg.type,
      msg.commandType || "",
      "to server",
    );
    socket.send(encodeMsgpack(msg));
  } else {
    console.error(
      "[DEBUG] Cannot send - WebSocket not open. State:",
      socket?.readyState,
    );
  }
}

function notifyToast(message, type = "info", duration = 4000) {
  if (typeof window.showToast !== "function") return;
  const key = `${type}:${message}`;
  const now = Date.now();
  const last = recentToasts.get(key) || 0;
  if (now - last < 1000) return;
  recentToasts.set(key, now);

  if (document.visibilityState === "hidden") {
    if (!pendingToast) {
      pendingToast = { message, type, duration, count: 1 };
    } else {
      pendingToast.message = message;
      pendingToast.type = type;
      pendingToast.duration = duration;
      pendingToast.count += 1;
    }
    return;
  }

  window.showToast(message, type, duration);
}

function trackCommandResult(commandId, options = {}) {
  if (!commandId) return;
  const {
    refreshOnSuccess = false,
    successMessage = null,
    errorPrefix = "Operation failed",
  } = options;
  pendingCommandResults.set(commandId, {
    refreshOnSuccess,
    successMessage,
    errorPrefix,
  });
}

function waitForCommandResult(commandId, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    if (!commandId) {
      reject(new Error("missing command id"));
      return;
    }
    const existing = pendingCommandWaiters.get(commandId);
    if (existing) {
      clearTimeout(existing.timeoutId);
      existing.reject(new Error("superseded command waiter"));
    }
    const timeoutId = setTimeout(() => {
      pendingCommandWaiters.delete(commandId);
      reject(new Error("command timed out"));
    }, timeoutMs);
    pendingCommandWaiters.set(commandId, { resolve, reject, timeoutId });
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!pendingToast || typeof window.showToast !== "function") return;
  const { message, type, duration, count } = pendingToast;
  pendingToast = null;
  const summary = count > 1 ? `${message} (+${count - 1} more)` : message;
  window.showToast(summary, type, duration);
});

function handleMessage(msg) {
  console.log("[DEBUG] Received message:", msg.type, msg);

  switch (msg.type) {
    case "ready":
      console.log("Session ready:", msg.sessionId);
      break;
    case "status":
      console.log("[DEBUG] Status message:", msg);
      if (msg.status === "offline") {
        const recentlyActive = Date.now() - lastSuccessfulResponse < 10_000;
        if (!recentlyActive) {
          updateStatus("error", "Client Offline");
          enableControls(false);
        }
      }
      break;
    case "file_list_result":
      handleFileList(msg);
      break;
    case "file_download":
      handleFileDownload(msg);
      break;
    case "file_upload_result":
      handleFileUploadResult(msg);
      break;
    case "file_read_result":
      console.log("[DEBUG] Routing to handleFileReadResult");
      handleFileReadResult(msg);
      break;
    case "file_search_result":
      handleFileSearchResult(msg);
      break;
    case "command_result":
      console.log("[DEBUG] Command result:", msg);
      handleCommandResult(msg);
      break;
    case "command_progress":
      console.log("[DEBUG] Command progress:", msg);
      handleCommandProgress(msg);
      break;
    default:
      console.log("[DEBUG] Unknown message type:", msg.type, msg);
  }
}

function listFiles(path, socket = ws) {
  if (currentPath && currentPath !== path) {
    pathHistory.push(currentPath);
  }
  currentPath = path;
  send({ type: "file_list", path }, socket);
  updateBreadcrumb(path);
  updatePathInput(path);
  updateBackButton();
}

function updatePathInput(path) {
  pathInput.value = path || ".";
}

function updateBackButton() {
  backBtn.disabled = pathHistory.length === 0;
  backBtn.classList.toggle("opacity-50", pathHistory.length === 0);
  backBtn.classList.toggle("cursor-not-allowed", pathHistory.length === 0);
}

function goBack() {
  if (pathHistory.length > 0) {
    const previousPath = pathHistory.pop();
    currentPath = previousPath;
    send({ type: "file_list", path: previousPath });
    updateBreadcrumb(previousPath);
    updatePathInput(previousPath);
    updateBackButton();
  }
}

function goHome() {
  pathHistory = [];
  listFiles(".");
}

function updateBreadcrumb(path) {
  const parts = path.split(/[\/\\]/).filter((p) => p && p !== ".");
  breadcrumbEl.innerHTML = "";

  const root = document.createElement("span");
  root.className = "breadcrumb-item hover:text-blue-400 transition-colors";
  root.innerHTML =
    '<i class="fa-solid fa-hard-drive"></i> <span class="text-xs">Drives</span>';
  root.onclick = () => listFiles(".");
  breadcrumbEl.appendChild(root);

  if (!path || path === ".") {
    return;
  }

  let accumulated = "";
  parts.forEach((part, idx) => {
    accumulated += (accumulated ? "/" : "") + part;
    const pathSegment = accumulated;

    const separator = document.createElement("span");
    separator.className = "text-slate-600 mx-1";
    separator.innerHTML = '<i class="fa-solid fa-chevron-right text-xs"></i>';
    breadcrumbEl.appendChild(separator);

    const crumb = document.createElement("span");
    crumb.className = "breadcrumb-item hover:text-blue-400 transition-colors";
    crumb.textContent = part;
    crumb.onclick = () => listFiles(pathSegment);
    breadcrumbEl.appendChild(crumb);
  });
}

function getFileExt(name = "") {
  const idx = name.lastIndexOf(".");
  if (idx < 0 || idx === name.length - 1) return "";
  return name.slice(idx + 1).toLowerCase();
}

function entryMatchesFilter(entry, mode) {
  if (mode === "all") return true;
  if (mode === "dirs") return !!entry.isDir;
  if (mode === "files") return !entry.isDir;
  if (entry.isDir) return false;

  const ext = getFileExt(entry.name);
  const imageExt = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico"]);
  const docExt = new Set(["txt", "md", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "json", "xml", "yaml", "yml"]);
  const archiveExt = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]);
  const execExt = new Set(["exe", "msi", "bat", "cmd", "ps1", "sh", "appimage", "bin", "com"]);

  if (mode === "images") return imageExt.has(ext);
  if (mode === "docs") return docExt.has(ext);
  if (mode === "archives") return archiveExt.has(ext);
  if (mode === "executables") return execExt.has(ext);
  return true;
}

function sortEntries(entries, field, order) {
  const dirRank = (entry) => (entry.isDir ? 0 : 1);
  const factor = order === "desc" ? -1 : 1;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  return [...entries].sort((a, b) => {
    const dirDiff = dirRank(a) - dirRank(b);
    if (dirDiff !== 0) return dirDiff;

    let valueA = a.name || "";
    let valueB = b.name || "";

    if (field === "size") {
      valueA = Number(a.size || 0);
      valueB = Number(b.size || 0);
    } else if (field === "modified") {
      valueA = Number(a.modTime || 0);
      valueB = Number(b.modTime || 0);
    } else if (field === "type") {
      valueA = a.isDir ? "" : getFileExt(a.name);
      valueB = b.isDir ? "" : getFileExt(b.name);
    }

    if (typeof valueA === "number" && typeof valueB === "number") {
      if (valueA === valueB) {
        return factor * collator.compare(a.name || "", b.name || "");
      }
      return factor * (valueA - valueB);
    }

    const diff = collator.compare(String(valueA), String(valueB));
    if (diff !== 0) return factor * diff;
    return factor * collator.compare(a.name || "", b.name || "");
  });
}

function applySortAndFilterEntries(entries) {
  const filtered = entries.filter((entry) => entryMatchesFilter(entry, filterType));
  return sortEntries(filtered, sortField, sortOrder);
}

function updateSortOrderButton() {
  if (!sortOrderBtn) return;
  sortOrderBtn.textContent = sortOrder === "asc" ? "Asc" : "Desc";
}

function updateDirectorySummaryAndPaging(totalCount, shownCount) {
  if (fileCountSummaryEl) {
    fileCountSummaryEl.textContent = `${totalCount} items`;
  }
}

function clearVirtualizedListMode() {
  if (virtualRenderRaf) {
    cancelAnimationFrame(virtualRenderRaf);
    virtualRenderRaf = null;
  }
  if (virtualScrollHandler) {
    window.removeEventListener("scroll", virtualScrollHandler);
    virtualScrollHandler = null;
  }
  if (virtualResizeHandler) {
    window.removeEventListener("resize", virtualResizeHandler);
    virtualResizeHandler = null;
  }
  isVirtualizedList = false;
  fileListEl.classList.add("divide-y", "divide-slate-800");
}

function renderDirectoryStandard(entries, canGoUp, parentPath, disableAnimations) {
  clearVirtualizedListMode();

  if (!disableAnimations) {
    fileListEl.style.opacity = "0";
    fileListEl.style.transform = "translateX(20px)";
  } else {
    fileListEl.style.transition = "none";
    fileListEl.style.opacity = "1";
    fileListEl.style.transform = "translateX(0)";
  }

  const renderList = () => {
    fileListEl.innerHTML = "";

    if (canGoUp) {
      fileListEl.appendChild(createParentRow(parentPath));
    }

    if (entries.length === 0 && !canGoUp) {
      fileListEl.innerHTML =
        '<div class="px-4 py-6 text-center text-slate-400"><i class="fa-solid fa-folder-open mr-2"></i>Empty directory</div>';
      fileListEl.style.opacity = "1";
      fileListEl.style.transform = "translateX(0)";
      return;
    }

    entries.forEach((entry, index) => {
      const row = createFileRow(entry);
      if (!disableAnimations) {
        row.style.animationDelay = `${index * 0.02}s`;
        row.classList.add("card-animate");
      }
      fileListEl.appendChild(row);
    });

    if (!disableAnimations) {
      fileListEl.style.transition =
        "opacity 0.3s ease-out, transform 0.3s ease-out";
      fileListEl.style.opacity = "1";
      fileListEl.style.transform = "translateX(0)";
    }
  };

  if (disableAnimations) {
    renderList();
  } else {
    setTimeout(renderList, 150);
  }
}

function renderDirectoryVirtualized(entries, canGoUp, parentPath) {
  clearVirtualizedListMode();
  isVirtualizedList = true;
  fileListEl.style.transition = "none";
  fileListEl.style.opacity = "1";
  fileListEl.style.transform = "translateX(0)";
  fileListEl.classList.remove("divide-y", "divide-slate-800");
  fileListEl.innerHTML = "";

  if (canGoUp) {
    fileListEl.appendChild(createParentRow(parentPath));
  }

  const host = document.createElement("div");
  const topSpacer = document.createElement("div");
  const rowsContainer = document.createElement("div");
  const bottomSpacer = document.createElement("div");

  host.className = "virtualized-list-host";
  host.appendChild(topSpacer);
  host.appendChild(rowsContainer);
  host.appendChild(bottomSpacer);
  fileListEl.appendChild(host);

  const renderWindow = () => {
    const hostTop = host.getBoundingClientRect().top + window.scrollY;
    const viewportTop = window.scrollY;
    const viewportBottom = viewportTop + window.innerHeight;
    const relativeTop = Math.max(0, viewportTop - hostTop);
    const relativeBottom = Math.max(0, viewportBottom - hostTop);

    let start = Math.floor(relativeTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN;
    let end = Math.ceil(relativeBottom / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN;

    start = Math.max(0, start);
    end = Math.min(entries.length, Math.max(start + 1, end));

    topSpacer.style.height = `${start * VIRTUAL_ROW_HEIGHT}px`;
    bottomSpacer.style.height = `${Math.max(0, (entries.length - end) * VIRTUAL_ROW_HEIGHT)}px`;

    rowsContainer.innerHTML = "";
    for (let i = start; i < end; i += 1) {
      rowsContainer.appendChild(createFileRow(entries[i]));
    }
  };

  const scheduleRender = () => {
    if (virtualRenderRaf) return;
    virtualRenderRaf = requestAnimationFrame(() => {
      virtualRenderRaf = null;
      renderWindow();
    });
  };

  virtualScrollHandler = () => scheduleRender();
  virtualResizeHandler = () => scheduleRender();
  window.addEventListener("scroll", virtualScrollHandler, { passive: true });
  window.addEventListener("resize", virtualResizeHandler);

  renderWindow();
}

function renderCurrentDirectory() {
  filteredDirectoryEntries = applySortAndFilterEntries(directoryEntries);
  const visibleEntries = filteredDirectoryEntries;
  updateDirectorySummaryAndPaging(visibleEntries.length, visibleEntries.length);

  const canGoUp = shouldShowParentDirectory(currentPath);
  const parentPath = canGoUp ? getParentPath(currentPath) : ".";

  if (visibleEntries.length > VIRTUALIZATION_THRESHOLD) {
    renderDirectoryVirtualized(visibleEntries, canGoUp, parentPath);
    return;
  }

  const disableAnimations = visibleEntries.length > 50;
  renderDirectoryStandard(visibleEntries, canGoUp, parentPath, disableAnimations);
}

function handleFileList(msg) {
  if (msg.error) {
    clearVirtualizedListMode();
    fileListEl.innerHTML = `<div class="px-4 py-6 text-center text-red-400"><i class="fa-solid fa-exclamation-triangle mr-2"></i>${escapeHtml(msg.error)}</div>`;
    updateDirectorySummaryAndPaging(0, 0);
    return;
  }

  lastSuccessfulResponse = Date.now();
  updateStatus("connected", "Connected");
  enableControls(true);

  currentPath = msg.path;
  directoryEntries = Array.isArray(msg.entries) ? msg.entries : [];

  selectedFiles.clear();
  updateSelectionUI();
  renderCurrentDirectory();
}

function shouldShowParentDirectory(path) {
  if (!path || path === ".") {
    return false;
  }

  return true;
}

function getParentPath(path) {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((p) => p);

  if (parts.length === 1 && parts[0].match(/^[A-Za-z]:$/)) {
    return ".";
  }

  if (parts.length <= 1) {
    return ".";
  }

  parts.pop();
  let parentPath = parts.join("/");

  if (parentPath.match(/^[A-Za-z]:?$/)) {
    return parentPath.replace(/^([A-Za-z]):?$/, "$1:\\");
  }

  return parentPath || ".";
}

function createParentRow(parentPath) {
  const row = document.createElement("div");
  row.className =
    "file-item grid grid-cols-12 gap-3 px-4 py-3 border border-transparent cursor-pointer transition-colors hover:bg-slate-800/50";
  row.dataset.path = parentPath;
  row.dataset.isDir = "true";

  row.innerHTML = `
    <div class="col-span-6 flex items-center gap-2">
      <i class="fa-solid fa-folder-arrow-up text-blue-400"></i>
      <span class="font-semibold text-blue-300">..</span>
      <span class="text-xs text-slate-500">(parent directory)</span>
    </div>
    <div class="col-span-2 text-sm text-slate-400">-</div>
    <div class="col-span-3 text-sm text-slate-400">-</div>
    <div class="col-span-1"></div>
  `;

  row.ondblclick = () => listFiles(parentPath);
  row.onclick = () => listFiles(parentPath);

  return row;
}

function createFileRow(entry) {
  const row = document.createElement("div");
  row.className =
    "file-item grid grid-cols-12 gap-3 px-4 py-3 border border-transparent cursor-pointer transition-colors";
  row.dataset.path = entry.path;
  row.dataset.isDir = entry.isDir;

  const icon = entry.isDir
    ? '<i class="fa-solid fa-folder text-yellow-400"></i>'
    : '<i class="fa-solid fa-file text-slate-400"></i>';

  const size = entry.isDir ? "-" : formatBytes(entry.size);
  const modTime = new Date(entry.modTime * 1000).toLocaleString();

  row.innerHTML = `
    <input type="checkbox" class="file-checkbox" data-path="${escapeHtml(entry.path)}">
    <div class="col-span-6 flex items-center gap-2 truncate pl-3">
      ${icon}
      <span class="truncate">${escapeHtml(entry.name)}</span>
    </div>
    <div class="col-span-2 text-sm text-slate-400 file-size-col">${size}</div>
    <div class="col-span-3 text-sm text-slate-400 file-modified-col">${modTime}</div>
    <div class="col-span-1 flex items-center justify-end gap-1 action-buttons">
      ${!entry.isDir ? '<button class="action-btn px-2 py-1 rounded hover:bg-slate-700" data-action="download" title="Download"><i class="fa-solid fa-download"></i></button>' : ""}
      ${entry.isDir ? '<button class="action-btn px-2 py-1 rounded hover:bg-slate-700" data-action="zip" title="Zip & Download"><i class="fa-solid fa-file-zipper"></i></button>' : ""}
      <button class="action-btn px-2 py-1 rounded hover:bg-slate-700 text-red-400" data-action="delete" title="Delete"><i class="fa-solid fa-trash"></i></button>
    </div>
  `;

  const nameDiv = row.querySelector(".col-span-6");
  const mobileMetaDiv = document.createElement("div");
  mobileMetaDiv.className = "file-meta";
  mobileMetaDiv.innerHTML = `<span>${size}</span><span>${modTime}</span>`;
  nameDiv.appendChild(mobileMetaDiv);

  row.onclick = (e) => {
    if (e.target.closest(".file-checkbox") || e.target.closest(".action-btn")) {
      return;
    }

    if (entry.isDir) {
      listFiles(entry.path);
    } else {
      openFileInEditor(entry.path);
    }
  };

  const checkbox = row.querySelector(".file-checkbox");
  checkbox.onclick = (e) => {
    e.stopPropagation();
  };

  checkbox.onchange = (e) => {
    if (e.target.checked) {
      selectedFiles.add(entry.path);
      row.classList.add("selected");
    } else {
      selectedFiles.delete(entry.path);
      row.classList.remove("selected");
    }
    updateSelectionUI();
  };

  row.querySelectorAll(".action-btn").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      handleFileAction(action, entry);
    };
  });

  row.oncontextmenu = (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, entry);
  };

  return row;
}

function toggleSelection(row, path) {
  const checkbox = row.querySelector(".file-checkbox");
  if (selectedFiles.has(path)) {
    selectedFiles.delete(path);
    row.classList.remove("selected");
    if (checkbox) checkbox.checked = false;
  } else {
    selectedFiles.add(path);
    row.classList.add("selected");
    if (checkbox) checkbox.checked = true;
  }
  updateSelectionUI();
}

function handleFileAction(action, entry) {
  switch (action) {
    case "edit":
      openFileInEditor(entry.path);
      break;
    case "download":
      downloadFile(entry.path);
      break;
    case "zip":
      zipAndDownload(entry.path);
      break;
    case "copy":
      const copyDest = prompt("Copy to:", entry.path + "_copy");
      if (copyDest) {
        const commandId = `copy-${Date.now()}`;
        send({
          type: "command",
          commandType: "file_copy",
          id: commandId,
          payload: { source: entry.path, dest: copyDest },
        });
        trackCommandResult(commandId, {
          refreshOnSuccess: true,
          successMessage: "Copy completed",
          errorPrefix: "Copy failed",
        });
      }
      break;
    case "move":
      const moveDest = prompt("Move to:", entry.path);
      if (moveDest) {
        const commandId = `move-${Date.now()}`;
        send({
          type: "command",
          commandType: "file_move",
          id: commandId,
          payload: { source: entry.path, dest: moveDest },
        });
        trackCommandResult(commandId, {
          refreshOnSuccess: true,
          successMessage: "Move completed",
          errorPrefix: "Move failed",
        });
      }
      break;
    case "chmod":
      const mode = prompt(
        "Enter permissions (octal, e.g., 0755):",
        entry.mode || "0644",
      );
      if (mode) {
        const commandId = `chmod-${Date.now()}`;
        send({
          type: "command",
          commandType: "file_chmod",
          id: commandId,
          payload: { path: entry.path, mode },
        });
        trackCommandResult(commandId, {
          refreshOnSuccess: true,
          successMessage: "Permissions updated",
          errorPrefix: "Permissions update failed",
        });
      }
      break;
    case "delete":
      deleteFile(entry.path);
      break;
  }
}

function downloadFile(path) {
  console.log("Requesting download:", path);
  const transferId = `download-${Date.now()}-${Math.random()}`;
  const fileName = path.split(/[\/\\]/).pop();
  const abortController = new AbortController();

  const transfer = {
    id: transferId,
    type: "download",
    path,
    fileName,
    progress: 0,
    total: 0,
    received: 0,
    receivedBytes: 0,
    receivedOffsets: new Map(),
    receivedChunks: new Set(),
    chunkSize: 0,
    expectedChunks: 0,
    buffer: null,
    chunks: [],
    cancelled: false,
    abortController,
    source: "http",
    expectedCommandId: null,
  };

  fileDownloads.set(path, transfer);
  activeTransfers.set(transferId, transfer);
  addTransferToUI(transfer);

  updateStatus("connected", `Downloading ${fileName}...`);

  (async () => {
    try {
      console.debug("[filebrowser] download request", { path, clientId });
      const requestRes = await fetch("/api/file/download/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: abortController.signal,
        body: JSON.stringify({ clientId, path }),
      });

      console.debug("[filebrowser] download request response", {
        ok: requestRes.ok,
        status: requestRes.status,
      });

      if (!requestRes.ok) {
        const text = await requestRes.text();
        notifyToast(text || "Download failed", "error", 5000);
        removeTransfer(transferId);
        fileDownloads.delete(path);
        updateStatus("connected", "Connected");
        return;
      }

      const requestData = await requestRes.json();
      const downloadUrl = typeof requestData?.downloadUrl === "string"
        ? requestData.downloadUrl
        : (requestData?.downloadId
          ? `/api/file/download/${encodeURIComponent(requestData.downloadId)}`
          : "");

      if (!downloadUrl) {
        notifyToast("Download failed", "error", 5000);
        removeTransfer(transferId);
        fileDownloads.delete(path);
        updateStatus("connected", "Connected");
        return;
      }

      console.debug("[filebrowser] download request accepted", {
        downloadUrl,
      });

      console.debug("[filebrowser] download stream start", {
        downloadUrl,
      });

      const res = await fetch(downloadUrl, {
        method: "GET",
        credentials: "include",
        signal: abortController.signal,
      });

      console.debug("[filebrowser] download response", {
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get("Content-Type"),
        contentLength: res.headers.get("Content-Length"),
      });

      if (!res.ok) {
        const text = await res.text();
        notifyToast(text || "Download failed", "error", 5000);
        removeTransfer(transferId);
        fileDownloads.delete(path);
        updateStatus("connected", "Connected");
        return;
      }

      const total = Number(res.headers.get("Content-Length") || 0);
      if (Number.isFinite(total) && total > 0) {
        transfer.total = total;
      }

      const chunks = [];
      let received = 0;
      let lastLoggedBytes = 0;
      if (res.body) {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.length;
            transfer.received = received;
            if (received - lastLoggedBytes >= 5 * 1024 * 1024) {
              lastLoggedBytes = received;
              console.debug("[filebrowser] download stream", {
                path,
                received,
                total: transfer.total,
              });
            }
            if (transfer.total > 0) {
              transfer.progress = Math.round((received / transfer.total) * 100);
              updateTransferProgress(transferId, transfer.progress, received, transfer.total);
            }
          }
          if (transfer.cancelled) {
            break;
          }
        }
      } else {
        console.warn("[filebrowser] download response missing body", { path });
        const blob = await res.blob();
        chunks.push(new Uint8Array(await blob.arrayBuffer()));
        received = chunks[0]?.length || 0;
        transfer.received = received;
      }

      if (transfer.cancelled) {
        removeTransfer(transferId);
        fileDownloads.delete(path);
        updateStatus("connected", "Connected");
        return;
      }

      if (transfer.total === 0 && received > 0) {
        transfer.progress = 100;
        updateTransferProgress(transferId, transfer.progress, received, transfer.total);
      }

      const blob = new Blob(chunks);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      console.log("Download complete:", path, `${received} bytes`);
      console.debug("[filebrowser] download complete", {
        path,
        received,
        total: transfer.total,
        chunks: chunks.length,
      });
      removeTransfer(transferId);
      fileDownloads.delete(path);
      updateStatus("connected", "Connected");
    } catch (err) {
      if (transfer.cancelled) return;
      console.error("Download error:", err);
      notifyToast(`Download failed: ${err.message || err}`, "error", 5000);
      removeTransfer(transferId);
      fileDownloads.delete(path);
      updateStatus("connected", "Connected");
    }
  })();
}

function handleFileDownload(msg) {
  const toNumber = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") {
      const asNumber = Number(value);
      if (Number.isSafeInteger(asNumber)) return asNumber;
    }
    return null;
  };

  console.debug("[filebrowser] file_download", {
    path: msg.path,
    hasData: !!msg.data,
    dataLen: msg.data?.length ?? null,
    totalType: typeof msg.total,
    total: msg.total,
    chunkIndex: msg.chunkIndex,
    chunksTotal: msg.chunksTotal,
    offset: msg.offset,
    error: msg.error || null,
  });

  if (msg.error) {
    alert(`Download failed: ${msg.error}`);
    const download = fileDownloads.get(msg.path);
    if (download) {
      removeTransfer(download.id);
      fileDownloads.delete(msg.path);
    }
    return;
  }

  let download = fileDownloads.get(msg.path);
  if (!download) {
    return;
  }

  if (download.source === "http") {
    return;
  }

  if (download.expectedCommandId) {
    if (!msg.commandId || msg.commandId !== download.expectedCommandId) {
      console.debug("[filebrowser] ignoring unsolicited download", {
        path: msg.path,
        commandId: msg.commandId || null,
      });
      return;
    }
  }

  if (download.cancelled) {
    fileDownloads.delete(msg.path);
    return;
  }

  const total = toNumber(msg.total);
  if (total && total > 0) {
    if (!download.total) {
      download.total = total;
      console.debug("[filebrowser] download total set", {
        path: msg.path,
        total: download.total,
      });
    }
    if (download.total > 0 && !download.buffer) {
      download.buffer = new Uint8Array(download.total);
      download.receivedBytes = 0;
      download.receivedOffsets = new Map();
      download.receivedChunks = new Set();
      download.chunkSize = 0;
      download.expectedChunks = 0;
      download.chunks = [];
    }
  }

  const chunkIndex = toNumber(msg.chunkIndex);
  const chunksTotal = toNumber(msg.chunksTotal);
  if (chunksTotal && !download.expectedChunks) {
    download.expectedChunks = chunksTotal;
    console.debug("[filebrowser] expected chunks set", {
      path: msg.path,
      expectedChunks: download.expectedChunks,
    });
  }

  if (msg.data && msg.data.length > 0) {
    let data = msg.data;
    if (data instanceof ArrayBuffer) {
      data = new Uint8Array(data);
    } else if (typeof data === "string") {
      data = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    }
    if (data instanceof Uint8Array) {
      const chunkOffset = toNumber(msg.offset);
      if (download.total > 0 && !download.chunkSize && data.length > 0) {
        download.chunkSize = data.length;
        if (!download.expectedChunks) {
          download.expectedChunks = Math.ceil(download.total / download.chunkSize);
          console.debug("[filebrowser] inferred expected chunks", {
            path: msg.path,
            expectedChunks: download.expectedChunks,
            chunkSize: download.chunkSize,
          });
        }
      }
      if (download.total > 0 && download.buffer && chunkOffset !== null) {
        const end = chunkOffset + data.length;
        if (chunkOffset >= 0 && end <= download.total) {
          const seen = chunkIndex !== null
            ? download.receivedChunks.has(chunkIndex)
            : download.receivedOffsets.has(chunkOffset);
          if (!seen) {
            download.buffer.set(data, chunkOffset);
            if (chunkIndex !== null) {
              download.receivedChunks.add(chunkIndex);
            } else {
              download.receivedOffsets.set(chunkOffset, data.length);
            }
            download.receivedBytes += data.length;
          }
        }
        download.received = Math.min(download.receivedBytes, download.total);
      } else {
        download.chunks.push(data);
        download.received += data.length;
      }
    }
  }

  if (download.total > 0) {
    download.progress = Math.round((download.received / download.total) * 100);
    updateTransferProgress(
      download.id,
      download.progress,
      download.received,
      download.total,
    );
    console.debug("[filebrowser] download progress", {
      path: msg.path,
      progress: download.progress,
      received: download.received,
      total: download.total,
    });
  } else if (download.expectedChunks > 0) {
    const chunkProgress = Math.round(
      (download.receivedChunks.size / download.expectedChunks) * 100,
    );
    download.progress = Math.min(100, Math.max(0, chunkProgress));
    updateTransferProgress(
      download.id,
      download.progress,
      download.received,
      download.total || 0,
    );
    console.debug("[filebrowser] download chunk progress", {
      path: msg.path,
      progress: download.progress,
      receivedChunks: download.receivedChunks.size,
      expectedChunks: download.expectedChunks,
      received: download.received,
    });
  }

  const receivedChunkCount =
    download.receivedChunks.size + download.receivedOffsets.size;
  const hasAllChunks =
    download.expectedChunks > 0
      ? receivedChunkCount >= download.expectedChunks
      : download.received >= download.total;

  if ((download.total > 0 ? download.received >= download.total : hasAllChunks) && hasAllChunks) {
    console.debug("[filebrowser] download complete", {
      path: msg.path,
      received: download.received,
      total: download.total,
      expectedChunks: download.expectedChunks,
      receivedChunks: download.receivedChunks.size,
    });
    let fullData = null;
    if (download.buffer) {
      fullData = download.buffer;
    } else {
      fullData = new Uint8Array(download.received);
      let offset = 0;
      download.chunks.forEach((chunk) => {
        fullData.set(chunk, offset);
        offset += chunk.length;
      });
    }

    const blob = new Blob([fullData]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = download.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log("Download complete:", msg.path, `${download.received} bytes`);
    removeTransfer(download.id);
    fileDownloads.delete(msg.path);
    updateStatus("connected", "Connected");
  }
}

function zipAndDownload(path) {
  console.log("Requesting zip:", path);

  const zipPath = path + ".zip";
  const transferId = `download-zip-${Date.now()}-${Math.random()}`;
  const fileName = zipPath.split(/[\/\\]/).pop();
  const transfer = {
    id: transferId,
    type: "download",
    path: zipPath,
    fileName,
    progress: 0,
    total: 0,
    received: 0,
    receivedBytes: 0,
    receivedOffsets: new Map(),
    receivedChunks: new Set(),
    chunkSize: 0,
    expectedChunks: 0,
    buffer: null,
    chunks: [],
    cancelled: false,
    source: "ws",
    expectedCommandId: null,
  };
  fileDownloads.set(zipPath, transfer);

  const commandId = "zip_" + Date.now();
  transfer.expectedCommandId = commandId;
  send({ type: "file_zip", path, commandId });
  trackCommandResult(commandId, {
    refreshOnSuccess: true,
    successMessage: "Zip completed",
    errorPrefix: "Zip failed",
  });

  showProgressNotification(commandId, "Starting zip operation...", path);
}

let activeProgressNotifications = new Map();

function showProgressNotification(commandId, message, path) {
  hideProgressNotification(commandId);

  const notification = document.createElement("div");
  notification.id = `progress-${commandId}`;
  notification.className =
    "fixed bottom-4 right-4 bg-slate-800 border border-slate-700 rounded-lg shadow-lg p-4 min-w-[320px] z-50";
  notification.innerHTML = `
    <div class="flex items-start justify-between gap-3 mb-2">
      <div class="flex items-center gap-2">
        <i class="fa-solid fa-file-zipper text-blue-400"></i>
        <span class="font-semibold text-slate-200">Zipping Directory</span>
      </div>
      <button class="text-slate-400 hover:text-red-400 transition-colors" data-command-id="${escapeHtml(commandId)}" onclick="cancelZipOperation(this.dataset.commandId)">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
    <div class="text-sm text-slate-400 mb-2" id="progress-message-${escapeHtml(commandId)}">${escapeHtml(message)}</div>
    <div class="text-xs text-slate-500 truncate" title="${escapeHtml(path)}">${escapeHtml(path)}</div>
  `;

  document.body.appendChild(notification);
  activeProgressNotifications.set(commandId, notification);
}

function updateProgressNotification(commandId, message) {
  const messageEl = document.getElementById(`progress-message-${commandId}`);
  if (messageEl) {
    messageEl.textContent = message;
  }
}

function hideProgressNotification(commandId) {
  const notification = activeProgressNotifications.get(commandId);
  if (notification) {
    notification.remove();
    activeProgressNotifications.delete(commandId);
  }
}

function cancelZipOperation(commandId) {
  if (confirm("Cancel this zip operation?")) {
    send({ type: "command_abort", commandId });
    hideProgressNotification(commandId);
    updateStatus("connected", "Zip operation cancelled");
  }
}

function handleCommandProgress(msg) {
  if (msg.commandId) {
    updateProgressNotification(msg.commandId, msg.message || "Processing...");
  }
}

function deleteFile(path) {
  if (!confirm(`Are you sure you want to delete ${path}?`)) return;
  console.log("Deleting:", path);
  const commandId = `delete-${Date.now()}`;
  send({ type: "file_delete", path, commandId });
  trackCommandResult(commandId, {
    refreshOnSuccess: true,
    successMessage: "Delete completed",
    errorPrefix: "Delete failed",
  });
}

function handleFileUploadResult(msg) {
  const toNumber = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") {
      const asNumber = Number(value);
      if (Number.isSafeInteger(asNumber)) return asNumber;
    }
    return null;
  };

  const transfer = msg.transferId
    ? fileUploadsById.get(msg.transferId)
    : (msg.path ? fileUploads.get(msg.path) : null);

  if (!msg.ok) {
    notifyToast(`Upload failed: ${msg.error}`, "error", 5000);
    updateStatus("connected", "Connected");
    if (transfer) {
      removeTransfer(transfer.id);
      fileUploads.delete(transfer.path);
      fileUploadsById.delete(transfer.transferId);
    }
    return;
  }

  if (!transfer) {
    console.log("Upload ack received (no active transfer):", msg.path || msg.transferId);
    return;
  }

  const offset = toNumber(msg.offset);
  if (offset !== null) {
    const firstAckForOffset = !transfer.ackedOffsets.has(offset);
    if (firstAckForOffset) {
      transfer.ackedOffsets.add(offset);
      transfer.receivedChunks += 1;
    }

    if (Number.isFinite(msg.received)) {
      transfer.receivedBytes = Math.min(Number(msg.received), transfer.total);
      transfer.sent = transfer.receivedBytes;
    }

    if (transfer.total > 0) {
      transfer.progress = Math.round((transfer.sent / transfer.total) * 100);
      updateTransferProgress(transfer.id, transfer.progress, transfer.sent, transfer.total);
    }
  }

  const pendingOffset = offset !== null
    ? offset
    : (transfer.pendingAcks.has(0) ? 0 : null);
  if (pendingOffset !== null) {
    const pending = transfer.pendingAcks.get(pendingOffset);
    if (pending) {
      clearTimeout(pending.timeoutId);
      transfer.pendingAcks.delete(pendingOffset);
      pending.resolve(msg);
    }
  }

  if (transfer.completed && transfer.receivedChunks >= transfer.expectedChunks) {
    finishUpload(transfer);
  }
}

function handleCommandResult(msg) {
  if (msg.commandId && activeProgressNotifications.has(msg.commandId)) {
    setTimeout(() => hideProgressNotification(msg.commandId), 2000);
  }

  if (currentEditingFile && editorStatus.textContent === "Saving...") {
    if (msg.ok) {
      editorStatus.textContent = "Saved successfully!";
      notifyToast("File saved successfully", "success", 5000);
      setTimeout(closeEditor, 1000);
    } else {
      editorStatus.textContent = `Error: ${msg.message || "Save failed"}`;
      notifyToast(
        `Save failed: ${msg.message || "Unknown error"}`,
        "error",
        5000,
      );
      editorSaveBtn.disabled = false;
    }
    if (msg.commandId) pendingCommandResults.delete(msg.commandId);
    return;
  }

  const tracked = msg.commandId
    ? pendingCommandResults.get(msg.commandId)
    : null;

  const waiter = msg.commandId
    ? pendingCommandWaiters.get(msg.commandId)
    : null;
  if (waiter) {
    clearTimeout(waiter.timeoutId);
    pendingCommandWaiters.delete(msg.commandId);
    if (msg.ok) {
      waiter.resolve(msg);
    } else {
      waiter.reject(new Error(msg.message || "operation failed"));
    }
  }

  if (!tracked) {
    return;
  }
  if (msg.commandId) pendingCommandResults.delete(msg.commandId);

  if (!msg.ok) {
    const errorText = msg.message
      ? `${tracked.errorPrefix}: ${msg.message}`
      : tracked.errorPrefix;
    notifyToast(
      errorText,
      "error",
      5000,
    );
  } else {
    notifyToast(
      tracked.successMessage || "Operation completed successfully",
      "success",
      5000,
    );

    if (tracked.refreshOnSuccess) {
      listFiles(currentPath);
    }
  }
}

function showContextMenu(x, y, entry) {
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
  contextMenu.classList.add("show");
  contextMenu.dataset.path = entry.path;
  contextMenu.dataset.isDir = entry.isDir;

  const editItem = contextMenu.querySelector('[data-action="edit"]');
  const zipItem = contextMenu.querySelector('[data-action="zip"]');
  const chmodItem = contextMenu.querySelector('[data-action="chmod"]');

  if (editItem) editItem.style.display = entry.isDir ? "none" : "block";
  if (zipItem) zipItem.style.display = entry.isDir ? "block" : "none";
  if (chmodItem) chmodItem.style.display = entry.mode ? "block" : "none";
}

function hideContextMenu() {
  contextMenu.classList.remove("show");
}

function formatBytes(bytes) {
  if (bytes === 0 || bytes === 0n) return "0 B";
  const sizes = ["B", "KB", "MB", "GB", "TB"];
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

refreshBtn.onclick = () => listFiles(currentPath);

uploadBtn.onclick = () => fileInput.click();

fileInput.onchange = async (e) => {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;

  for (const file of files) {
    await uploadFile(file);
  }

  fileInput.value = "";
  listFiles(currentPath);
};

async function uploadMultipleFiles(files) {
  for (const file of files) {
    await uploadFile(file);
  }
  listFiles(currentPath);
}

function hasFileDrag(event) {
  const types = Array.from(event.dataTransfer?.types || []);
  return types.includes("Files");
}

function setDropTargetActive(active) {
  if (!fileListPanel) return;
  fileListPanel.classList.toggle("ring-2", active);
  fileListPanel.classList.toggle("ring-blue-500", active);
  fileListPanel.classList.toggle("ring-offset-2", active);
  fileListPanel.classList.toggle("ring-offset-slate-950", active);
  fileListPanel.classList.toggle("bg-blue-500/5", active);
}

function setupDragAndDropUpload() {
  if (!fileListPanel) return;

  fileListPanel.addEventListener("dragenter", (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    dragDepth += 1;
    setDropTargetActive(true);
  });

  fileListPanel.addEventListener("dragover", (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropTargetActive(true);
  });

  fileListPanel.addEventListener("dragleave", (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      setDropTargetActive(false);
    }
  });

  fileListPanel.addEventListener("drop", async (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    setDropTargetActive(false);

    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;

    notifyToast(`Uploading ${files.length} file(s)...`, "info", 3000);
    await uploadMultipleFiles(files);
  });
}

if (sortFieldEl) {
  sortFieldEl.value = sortField;
  sortFieldEl.addEventListener("change", () => {
    sortField = sortFieldEl.value;
    localStorage.setItem("filebrowser.sortField", sortField);
    renderCurrentDirectory();
  });
}

if (filterTypeEl) {
  filterTypeEl.value = filterType;
  filterTypeEl.addEventListener("change", () => {
    filterType = filterTypeEl.value;
    localStorage.setItem("filebrowser.filterType", filterType);
    renderCurrentDirectory();
  });
}

if (sortOrderBtn) {
  updateSortOrderButton();
  sortOrderBtn.addEventListener("click", () => {
    sortOrder = sortOrder === "asc" ? "desc" : "asc";
    localStorage.setItem("filebrowser.sortOrder", sortOrder);
    updateSortOrderButton();
    renderCurrentDirectory();
  });
}

function finishUpload(transfer) {
  console.log("Upload complete:", transfer.path);
  updateStatus("connected", "Connected");
  notifyToast("File uploaded successfully", "success", 5000);
  removeTransfer(transfer.id);
  fileUploads.delete(transfer.path);
  fileUploadsById.delete(transfer.transferId);
  listFiles(currentPath);
}

async function uploadFileViaHttpPull(file, path, transfer) {
  console.debug("[filebrowser] upload request start", {
    clientId,
    path,
    fileName: file.name,
    size: file.size,
  });

  const requestRes = await fetch("/api/file/upload/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      clientId,
      path,
      fileName: file.name,
    }),
  });

  if (!requestRes.ok) {
    const text = await requestRes.text();
    throw new Error(text || "upload request failed");
  }

  const requestData = await requestRes.json();
  const uploadUrl = typeof requestData?.uploadUrl === "string"
    ? requestData.uploadUrl
    : (requestData?.uploadId
      ? `/api/file/upload/${encodeURIComponent(requestData.uploadId)}`
      : "");
  if (!uploadUrl) {
    throw new Error("upload request failed");
  }

  console.debug("[filebrowser] upload stage url", { uploadUrl });

  const uploadRequestOptions = {
    headers: { "Content-Type": "application/octet-stream" },
    credentials: "include",
    body: file,
    signal: transfer.abortController?.signal,
  };

  let uploadRes;
  try {
    uploadRes = await fetch(uploadUrl, {
      method: "POST",
      ...uploadRequestOptions,
    });
  } catch (err) {
    console.warn("[filebrowser] upload stage POST failed, retrying as PUT", err);
    uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      ...uploadRequestOptions,
    });
  }

  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    console.debug("[filebrowser] upload stage failed", {
      status: uploadRes.status,
      body: text,
    });
    throw new Error(text || "upload staging failed");
  }

  transfer.receivedBytes = Math.round(file.size * 0.5);
  transfer.sent = transfer.receivedBytes;
  transfer.progress = 50;
  updateTransferProgress(transfer.id, transfer.progress, transfer.sent, transfer.total);

  const uploadData = await uploadRes.json();
  if (!uploadData?.pullUrl) {
    throw new Error("upload staging failed");
  }

  console.debug("[filebrowser] upload staged", {
    pullUrl: uploadData.pullUrl,
    size: uploadData.size,
  });

  const commandId = `upload-http-${Date.now()}-${Math.random()}`;
  const waitResult = waitForCommandResult(commandId, 12 * 60 * 1000);
  send({
    type: "command",
    commandType: "file_upload_http",
    id: commandId,
    payload: {
      path,
      url: uploadData.pullUrl,
      total: file.size,
    },
  });

  await waitResult;

  console.debug("[filebrowser] upload command completed", {
    path,
    size: file.size,
  });

  transfer.receivedBytes = file.size;
  transfer.sent = file.size;
  transfer.progress = 100;
  transfer.receivedChunks = transfer.expectedChunks;
  updateTransferProgress(transfer.id, transfer.progress, transfer.sent, transfer.total);
}

async function uploadFile(file) {
  const path = currentPath ? `${currentPath}/${file.name}` : file.name;
  const transferId = `upload-${Date.now()}-${Math.random()}`;

  console.log("Uploading:", path);

  const transfer = {
    id: transferId,
    type: "upload",
    path,
    fileName: file.name,
    progress: 0,
    total: file.size,
    sent: 0,
    cancelled: false,
    expectedChunks: 0,
    receivedChunks: 0,
    receivedBytes: 0,
    pendingAcks: new Map(),
    ackedOffsets: new Set(),
    transferId,
    completed: false,
    abortController: new AbortController(),
  };

  fileUploads.set(path, transfer);
  fileUploadsById.set(transferId, transfer);
  activeTransfers.set(transferId, transfer);
  addTransferToUI(transfer);

  try {
    await uploadFileViaHttpPull(file, path, transfer);
    finishUpload(transfer);
  } catch (err) {
    console.error("Upload error:", err);
    removeTransfer(transferId);
    fileUploads.delete(path);
    fileUploadsById.delete(transferId);
    alert(`Upload failed: ${err.message}`);
  }
}

mkdirBtn.onclick = () => {
  const name = prompt("Enter folder name:");
  if (!name) return;
  const path = currentPath ? `${currentPath}/${name}` : name;
  console.log("Creating directory:", path);
  const commandId = `mkdir-${Date.now()}`;
  send({ type: "file_mkdir", path, commandId });
  trackCommandResult(commandId, {
    refreshOnSuccess: true,
    successMessage: "Folder created",
    errorPrefix: "Create folder failed",
  });
};

backBtn.onclick = () => goBack();

homeBtn.onclick = () => goHome();

pathGoBtn.onclick = () => {
  const path = pathInput.value.trim();
  if (path) {
    pathHistory = [];
    listFiles(path);
  }
};

pathInput.onkeydown = (e) => {
  if (e.key === "Enter") {
    const path = pathInput.value.trim();
    if (path) {
      pathHistory = [];
      listFiles(path);
    }
  }
};

document.addEventListener("click", (e) => {
  if (!e.target.closest("#context-menu")) {
    hideContextMenu();
  }
});

setupDragAndDropUpload();
updateStatus("connecting", "Connecting...");
updateBackButton();
connect();

function addTransferToUI(transfer) {
  const transferItem = document.createElement("div");
  transferItem.id = `transfer-${transfer.id}`;
  transferItem.className =
    "transfer-item bg-slate-800/50 border border-slate-700 rounded-lg p-3";

  const icon = transfer.type === "upload" ? "fa-upload" : "fa-download";
  const color = transfer.type === "upload" ? "text-blue-400" : "text-green-400";

  transferItem.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <div class="flex items-center gap-2 flex-1 min-w-0">
        <i class="fa-solid ${icon} ${color}"></i>
        <span class="text-sm truncate transfer-name"></span>
      </div>
      <button class="cancel-btn text-red-400 hover:text-red-300 px-2" type="button">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
    <div class="progress-bar-container w-full bg-slate-700 rounded-full h-2 mb-1">
      <div class="progress-bar bg-blue-500 h-2 rounded-full transition-all duration-300" style="width: ${transfer.progress}%"></div>
    </div>
    <div class="flex justify-between text-xs text-slate-400">
      <span class="progress-text">${transfer.progress}%</span>
      <span class="size-text">${formatBytes(transfer.sent || transfer.received || 0)} / ${formatBytes(transfer.total)}</span>
    </div>
  `;

  const nameEl = transferItem.querySelector(".transfer-name");
  if (nameEl) {
    nameEl.textContent = transfer.fileName;
  }
  const cancelBtn = transferItem.querySelector(".cancel-btn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => cancelTransfer(transfer.id));
  }

  transferList.appendChild(transferItem);
  transferPanel.classList.remove("hidden");
}

function updateTransferProgress(transferId, progress, current, total) {
  const transferItem = document.getElementById(`transfer-${transferId}`);
  if (!transferItem) return;

  const progressBar = transferItem.querySelector(".progress-bar");
  const progressText = transferItem.querySelector(".progress-text");
  const sizeText = transferItem.querySelector(".size-text");

  if (progressBar) progressBar.style.width = `${progress}%`;
  if (progressText) progressText.textContent = `${progress}%`;
  if (sizeText)
    sizeText.textContent = `${formatBytes(current)} / ${formatBytes(total)}`;
}

function removeTransfer(transferId) {
  const transferItem = document.getElementById(`transfer-${transferId}`);
  if (transferItem) {
    transferItem.remove();
  }

  activeTransfers.delete(transferId);

  if (transferList.children.length === 0) {
    transferPanel.classList.add("hidden");
  }
}

window.cancelTransfer = function (transferId) {
  const transfer = activeTransfers.get(transferId);
  if (transfer) {
    transfer.cancelled = true;
    if (transfer.abortController) {
      transfer.abortController.abort();
    }
    if (transfer.pendingAcks) {
      transfer.pendingAcks.forEach((pending) => {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error("Upload cancelled"));
      });
      transfer.pendingAcks.clear();
    }
    removeTransfer(transferId);

    if (transfer.type === "upload") {
      fileUploads.delete(transfer.path);
      fileUploadsById.delete(transfer.transferId);
    } else {
      fileDownloads.delete(transfer.path);
    }

    console.log("Transfer cancelled:", transferId);
  }
};

function updateSelectionUI() {
  const count = selectedFiles.size;
  selectedCountEl.textContent = count;

  if (count > 0) {
    bulkActionsBar.classList.remove("hidden");
  } else {
    bulkActionsBar.classList.add("hidden");
  }

  document.querySelectorAll(".file-item").forEach((row) => {
    const path = row.dataset.path;
    if (selectedFiles.has(path)) {
      row.classList.add("selected");
    } else {
      row.classList.remove("selected");
    }
  });
}

function clearSelection() {
  selectedFiles.clear();
  updateSelectionUI();
}

searchBtn.addEventListener("click", () => {
  searchBar.classList.toggle("hidden");
  if (!searchBar.classList.contains("hidden")) {
    searchInput.focus();
  }
});

searchCloseBtn.addEventListener("click", () => {
  searchBar.classList.add("hidden");
  searchInput.value = "";
  listFiles(currentPath);
});

searchExecuteBtn.addEventListener("click", () => {
  const query = searchInput.value.trim();
  if (!query) return;

  const searchContent = searchContentCheckbox.checked;
  performSearch(query, searchContent);
});

searchInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    searchExecuteBtn.click();
  }
});

function performSearch(pattern, searchContent) {
  clearVirtualizedListMode();
  updateDirectorySummaryAndPaging(0, 0);
  const searchId = `search-${Date.now()}`;
  const cmdId = `search-cmd-${Date.now()}`;
  const msg = {
    type: "command",
    commandType: "file_search",
    id: cmdId,
    payload: {
      searchId,
      path: currentPath || ".",
      pattern,
      searchContent,
      maxResults: 500,
    },
  };

  send(msg);

  fileListEl.innerHTML =
    '<div class="px-4 py-6 text-center text-blue-400"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Searching...</div>';
}

function handleFileSearchResult(msg) {
  clearVirtualizedListMode();
  updateDirectorySummaryAndPaging(0, 0);
  if (msg.error) {
    fileListEl.innerHTML = `<div class="px-4 py-6 text-center text-red-400"><i class="fa-solid fa-exclamation-triangle mr-2"></i>${escapeHtml(msg.error)}</div>`;
    return;
  }

  const results = msg.results || [];

  if (results.length === 0) {
    fileListEl.innerHTML =
      '<div class="px-4 py-6 text-center text-slate-400"><i class="fa-solid fa-search mr-2"></i>No results found</div>';
    return;
  }

  fileListEl.innerHTML = "";

  results.forEach((result) => {
    const row = document.createElement("div");
    row.className =
      "file-item px-4 py-3 border border-slate-700 rounded cursor-pointer hover:bg-slate-800/50 mb-2";

    const fileName = result.path.split(/[\/\\]/).pop();
    const lineInfo = result.line ? ` (line ${result.line})` : "";
    const matchPreview = result.match
      ? `<div class="text-xs text-slate-500 mt-1 font-mono">${escapeHtml(result.match.substring(0, 100))}</div>`
      : "";

    row.innerHTML = `
      <div class="flex items-center gap-2">
        <i class="fa-solid fa-file text-slate-400"></i>
        <div class="flex-1">
          <div class="font-medium">${escapeHtml(fileName)}<span class="text-slate-500">${lineInfo}</span></div>
          <div class="text-xs text-slate-400">${escapeHtml(result.path)}</div>
          ${matchPreview}
        </div>
        <button class="px-2 py-1 rounded hover:bg-slate-700" onclick="event.stopPropagation(); downloadFile('${escapeHtml(result.path)}')">
          <i class="fa-solid fa-download"></i>
        </button>
      </div>
    `;

    row.onclick = () => {
      openFileInEditor(result.path);
    };

    fileListEl.appendChild(row);
  });
}

function openFileInEditor(path) {
  const cmdId = `file-read-${Date.now()}`;
  const msg = {
    type: "command",
    commandType: "file_read",
    id: cmdId,
    payload: {
      path,
      maxSize: 10 * 1024 * 1024,
    },
  };

  console.log("[DEBUG] Opening file in editor:", path);
  console.log(
    "[DEBUG] Sending file_read command:",
    JSON.stringify(msg, null, 2),
  );
  console.log(
    "[DEBUG] WebSocket state:",
    ws?.readyState,
    "OPEN=",
    WebSocket.OPEN,
  );

  send(msg);
  currentEditingFile = path;
  editorFileName.textContent = path.split(/[/\\\\]/).pop();
  editorStatus.textContent = "Loading...";
  fileEditorModal.classList.add("show");
}

function handleFileReadResult(msg) {
  console.log("[DEBUG] handleFileReadResult called:", {
    path: msg.path,
    hasError: !!msg.error,
    isBinary: msg.isBinary,
    contentLength: msg.content?.length,
  });

  if (msg.error) {
    alert(`Error reading file: ${escapeHtml(msg.error)}`);
    closeEditor();
    return;
  }

  if (msg.isBinary) {
    alert("Cannot edit binary file");
    closeEditor();
    return;
  }

  console.log("[DEBUG] Setting editor content, length:", msg.content?.length);

  editorTextarea.value = msg.content || "";
  editorStatus.textContent = "Ready";

  applySyntaxHighlighting();
  editorTextarea.classList.add("hidden");
  editorPreview.classList.remove("hidden");
  editorPreviewTab.classList.add("bg-blue-600");
  editorPreviewTab.classList.remove("bg-slate-700", "hover:bg-slate-600");
  editorEditTab.classList.remove("bg-blue-600");
  editorEditTab.classList.add("bg-slate-700", "hover:bg-slate-600");
}

function saveFileFromEditor() {
  if (!currentEditingFile) return;

  const content = editorTextarea.value;
  const cmdId = `file-write-${Date.now()}`;
  const msg = {
    type: "command",
    commandType: "file_write",
    id: cmdId,
    payload: {
      path: currentEditingFile,
      content,
    },
  };

  send(msg);
  editorStatus.textContent = "Saving...";
  editorSaveBtn.disabled = true;
}

function closeEditor() {
  fileEditorModal.classList.remove("show");
  editorTextarea.value = "";
  currentEditingFile = null;
  editorStatus.textContent = "Ready";
  editorSaveBtn.disabled = false;
}

function applySyntaxHighlighting() {
  const code = editorTextarea.value;
  const codeElement = document.getElementById("editor-code");
  const fileName = currentEditingFile?.split(/[/\\\\]/).pop() || "";

  const ext = fileName.split(".").pop()?.toLowerCase();
  const languageMap = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    rb: "ruby",
    java: "java",
    cpp: "cpp",
    c: "c",
    cs: "csharp",
    php: "php",
    go: "go",
    rs: "rust",
    sh: "bash",
    bash: "bash",
    bat: "powershell",
    cmd: "powershell",
    ps1: "powershell",
    json: "json",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    txt: "plaintext",
  };

  const language = languageMap[ext] || "plaintext";
  codeElement.className = `language-${language}`;
  codeElement.textContent = code;

  delete codeElement.dataset.highlighted;

  if (window.hljs) {
    hljs.highlightElement(codeElement);
  }
}

const editorEditTab = document.getElementById("editor-edit-tab");
const editorPreviewTab = document.getElementById("editor-preview-tab");
const editorPreview = document.getElementById("editor-preview");

editorEditTab.addEventListener("click", () => {
  editorTextarea.classList.remove("hidden");
  editorPreview.classList.add("hidden");
  editorEditTab.classList.add("bg-blue-600");
  editorEditTab.classList.remove("bg-slate-700", "hover:bg-slate-600");
  editorPreviewTab.classList.remove("bg-blue-600");
  editorPreviewTab.classList.add("bg-slate-700", "hover:bg-slate-600");
});

editorPreviewTab.addEventListener("click", () => {
  applySyntaxHighlighting();
  editorTextarea.classList.add("hidden");
  editorPreview.classList.remove("hidden");
  editorPreviewTab.classList.add("bg-blue-600");
  editorPreviewTab.classList.remove("bg-slate-700", "hover:bg-slate-600");
  editorEditTab.classList.remove("bg-blue-600");
  editorEditTab.classList.add("bg-slate-700", "hover:bg-slate-600");
});

editorSaveBtn.addEventListener("click", saveFileFromEditor);
editorCancelBtn.addEventListener("click", closeEditor);
editorCloseBtn.addEventListener("click", closeEditor);

const editorRunBtn = document.getElementById("editor-run-btn");
editorRunBtn.addEventListener("click", () => {
  if (!currentEditingFile) return;

  const ext = currentEditingFile.split(".").pop()?.toLowerCase();
  let command = "";

  const isWindows = currentPath.includes(":\\");

  if (isWindows) {
    switch (ext) {
      case "bat":
      case "cmd":
        command = currentEditingFile;
        break;
      case "ps1":
        command = `powershell.exe -ExecutionPolicy Bypass -File "${currentEditingFile}"`;
        break;
      case "exe":
      case "com":
        command = `"${currentEditingFile}"`;
        break;
      case "py":
        command = `python "${currentEditingFile}"`;
        break;
      case "js":
        command = `node "${currentEditingFile}"`;
        break;
      default:
        command = `"${currentEditingFile}"`;
    }
  } else {
    switch (ext) {
      case "sh":
      case "bash":
        command = `bash "${currentEditingFile}"`;
        break;
      case "py":
        command = `python3 "${currentEditingFile}"`;
        break;
      case "rb":
        command = `ruby "${currentEditingFile}"`;
        break;
      case "js":
        command = `node "${currentEditingFile}"`;
        break;
      case "pl":
        command = `perl "${currentEditingFile}"`;
        break;
      default:
        command = `"${currentEditingFile}"`;
    }
  }

  window.open(
    `/${clientId}/console?cmd=${encodeURIComponent(command)}`,
    "_blank",
  );
});

bulkDownloadBtn.addEventListener("click", () => {
  selectedFiles.forEach((path) => downloadFile(path));
});

bulkDeleteBtn.addEventListener("click", () => {
  if (!confirm(`Delete ${selectedFiles.size} selected items?`)) return;

  selectedFiles.forEach((path) => {
    send({ type: "file_delete", path });
  });

  clearSelection();
  setTimeout(() => listFiles(currentPath), 500);
});

bulkMoveBtn.addEventListener("click", () => {
  const dest = prompt("Enter destination path:");
  if (!dest) return;

  selectedFiles.forEach((path) => {
    const fileName = path.split(/[\/\\]/).pop();
    const destPath = `${dest}/${fileName}`;
    send({ type: "file_move", source: path, dest: destPath });
  });

  clearSelection();
  setTimeout(() => listFiles(currentPath), 500);
});

bulkCopyBtn.addEventListener("click", () => {
  const dest = prompt("Enter destination path:");
  if (!dest) return;

  selectedFiles.forEach((path) => {
    const fileName = path.split(/[\/\\]/).pop();
    const destPath = `${dest}/${fileName}`;
    send({ type: "file_copy", source: path, dest: destPath });
  });

  clearSelection();
  setTimeout(() => listFiles(currentPath), 500);
});

clearSelectionBtn.addEventListener("click", clearSelection);

contextMenu.querySelectorAll(".context-menu-item").forEach((item) => {
  item.addEventListener("click", () => {
    const action = item.dataset.action;
    const path = contextMenu.dataset.path;
    const isDir = contextMenu.dataset.isDir === "true";
    const entry = { path, isDir };

    contextMenu.classList.remove("show");
    handleFileAction(action, entry);
  });
});

