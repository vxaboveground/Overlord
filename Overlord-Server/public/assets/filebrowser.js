import { encodeMsgpack, decodeMsgpack } from "./msgpack-helpers.js";
import { checkFeatureAccess } from "./feature-gate.js";
import { createFileHexHashManager } from "./filebrowser-hex-hash.js";
import { createFilePreviewModal } from "./filebrowser-preview-modal.js";
import { createTransferPanel } from "./filebrowser-transfer-panel.js";
import {
  KNOWN_BINARY_EXTS,
  PREVIEW_IMAGE_EXTS,
  escapeHtml,
  formatBytes,
  getFileExt,
  getParentPath,
  isPreviewable,
  shouldShowParentDirectory,
} from "./filebrowser-utils.js";

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
const MAC_PERMISSION_STORAGE_KEY = `filebrowser.macPermissionAllowed.${clientId}.v2`;
const macPermissionAllowedPaths = new Set(loadMacPermissionAllowedPaths());

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
  clientIdHeader.innerHTML = `<i class="fa-solid fa-computer mr-1.5 text-sky-400"></i>${escapeHtml(clientId)}`;
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
  const stateClasses = {
    connected: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    error: "bg-red-500/10 text-red-300 border-red-500/30",
    disconnected: "bg-slate-800 text-slate-300 border-slate-700",
    connecting: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  };
  statusEl.className = `inline-flex self-start sm:self-auto items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium ${stateClasses[state] || stateClasses.disconnected}`;
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
      if (msg.clientUser && msg.clientOs) {
        applyClientInfo(msg.clientOs, msg.clientUser);
      }
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
    case "file_icon_result":
      handleFileIconResult(msg);
      break;
    case "file_thumb_result":
      handleFileThumbResult(msg);
      break;
    case "file_dirsize_result":
      handleFileDirsizeResult(msg);
      break;
    case "file_peek_result":
      handleFilePeekResult(msg);
      break;
    case "file_hash_result":
      handleFileHashResult(msg);
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

async function listFiles(path, socket = ws, options = {}) {
  const { resetHistory = false, skipHistory = false } = options;
  if (!(await confirmMacPermissionRisk(path, "open folder"))) {
    return false;
  }
  if (resetHistory) {
    pathHistory = [];
  } else if (!skipHistory && currentPath && currentPath !== path) {
    pathHistory.push(currentPath);
  }
  currentPath = path;
  send({ type: "file_list", path }, socket);
  updateBreadcrumb(path);
  updatePathInput(path);
  updateBackButton();
  return true;
}

function updatePathInput(path) {
  pathInput.value = path || ".";
}

function updateBackButton() {
  backBtn.disabled = pathHistory.length === 0;
  backBtn.classList.toggle("opacity-50", pathHistory.length === 0);
  backBtn.classList.toggle("cursor-not-allowed", pathHistory.length === 0);
}

async function goBack() {
  if (pathHistory.length > 0) {
    const previousPath = pathHistory[pathHistory.length - 1];
    const ok = await listFiles(previousPath, ws, { skipHistory: true });
    if (ok) {
      pathHistory.pop();
    }
    updateBackButton();
  }
}

function loadMacPermissionAllowedPaths() {
  try {
    const raw = sessionStorage.getItem(MAC_PERMISSION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => typeof p === "string" && p.trim());
  } catch {
    return [];
  }
}

function persistMacPermissionAllowedPaths() {
  try {
    sessionStorage.setItem(
      MAC_PERMISSION_STORAGE_KEY,
      JSON.stringify(Array.from(macPermissionAllowedPaths)),
    );
  } catch {}
}

function normalizeMacPath(path) {
  const raw = String(path || "").trim();
  if (!raw || raw === ".") return raw;
  let normalized = raw.replace(/\\/g, "/");
  if (normalized === "~" && detectedHomePath) normalized = detectedHomePath;
  if (normalized.startsWith("~/") && detectedHomePath) {
    normalized = detectedHomePath + normalized.slice(1);
  }
  normalized = normalized.replace(/\/+/g, "/");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

function isSameOrChildPath(path, root) {
  if (!path || !root) return false;
  return path === root || path.startsWith(root + "/");
}

function markMacPermissionAllowed(path) {
  const risk = macProtectedLocationForPath(path);
  if (!risk) return;
  macPermissionAllowedPaths.add(risk.cachePath || risk.root || risk.path);
  persistMacPermissionAllowedPaths();
}

function hasMacPermissionAllowedAncestor(path) {
  const normalized = normalizeMacPath(path);
  for (const allowed of macPermissionAllowedPaths) {
    if (isSameOrChildPath(normalized, allowed)) return true;
  }
  return false;
}

function macProtectedLocationForPath(path) {
  const normalized = normalizeMacPath(path);
  if (!normalized || normalized === ".") {
    return null;
  }

  const maybeMac = detectedOS === "mac" || (!detectedOS && normalized.startsWith("/Users/"));
  if (!maybeMac) return null;

  let home = normalizeMacPath(detectedHomePath);
  if (!home) {
    const homeMatch = normalized.match(/^(\/Users\/[^/]+)/);
    if (homeMatch) home = homeMatch[1];
  }
  const protectedRoots = [];
  if (home) {
    for (const name of ["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music"]) {
      protectedRoots.push({ root: `${home}/${name}`, label: name });
    }
    protectedRoots.push(
      { root: `${home}/Library/Mobile Documents`, label: "iCloud Drive" },
      { root: `${home}/Library/Mail`, label: "Mail data" },
      { root: `${home}/Library/Messages`, label: "Messages data" },
      { root: `${home}/Library/Safari`, label: "Safari data" },
      { root: `${home}/Library/Calendars`, label: "Calendar data" },
      { root: `${home}/Library/Application Support/AddressBook`, label: "Contacts data" },
    );
  }
  protectedRoots.push(
    { root: "/Volumes", label: "removable or network volume" },
    { root: "/Network", label: "network location" },
  );

  const match = protectedRoots.find((item) => isSameOrChildPath(normalized, item.root));
  if (!match) return null;
  const cachePath = match.root === "/Volumes" || match.root === "/Network"
    ? normalized
    : match.root;
  return { ...match, path: normalized, cachePath };
}

function macPermissionRiskForPath(path) {
  const risk = macProtectedLocationForPath(path);
  if (!risk) return null;
  if (hasMacPermissionAllowedAncestor(risk.path)) return null;
  return risk;
}

function showMacPermissionWarning(risk, operation) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    let onKeyDown = null;
    let settled = false;
    modal.className = "fixed inset-0 z-[2400] flex items-center justify-center bg-black/70 px-4";
    modal.innerHTML = `
      <div class="w-full max-w-md rounded-lg border border-amber-500/40 bg-slate-900 shadow-2xl">
        <div class="px-4 py-3 border-b border-slate-700 flex items-center gap-2">
          <i class="fa-solid fa-triangle-exclamation text-amber-300"></i>
          <div class="font-semibold text-slate-100">Confirm macOS Access Request</div>
        </div>
        <div class="px-4 py-4 text-sm text-slate-300 space-y-3">
          <p>${escapeHtml(operation)} <span class="font-mono text-slate-100 break-all">${escapeHtml(risk.path)}</span> may ask the person using this Mac to allow access to ${escapeHtml(risk.label)} for this app.</p>
          <p class="text-xs text-slate-400">After you confirm here, the agent will try to open the folder on the Mac so macOS can show its permission prompt there.</p>
        </div>
        <div class="px-4 py-3 border-t border-slate-700 flex justify-end gap-2">
          <button type="button" data-mac-permission-cancel class="px-3 py-2 rounded bg-slate-700 hover:bg-slate-600 text-sm text-slate-100">Cancel</button>
          <button type="button" data-mac-permission-continue class="px-3 py-2 rounded bg-amber-500 hover:bg-amber-400 text-sm font-semibold text-slate-950">Try Access</button>
        </div>
      </div>
    `;
    const cleanup = (answer) => {
      if (settled) return;
      settled = true;
      if (onKeyDown) document.removeEventListener("keydown", onKeyDown);
      modal.remove();
      resolve(answer);
    };
    modal.querySelector("[data-mac-permission-cancel]")?.addEventListener("click", () => cleanup(false));
    modal.querySelector("[data-mac-permission-continue]")?.addEventListener("click", () => cleanup(true));
    modal.addEventListener("click", (e) => {
      if (e.target === modal) cleanup(false);
    });
    onKeyDown = (e) => {
      if (e.key !== "Escape") return;
      cleanup(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.appendChild(modal);
    modal.querySelector("[data-mac-permission-continue]")?.focus();
  });
}

async function confirmMacPermissionRisk(path, operation = "access") {
  const risk = macPermissionRiskForPath(path);
  if (!risk) return true;
  const ok = await showMacPermissionWarning(risk, operation);
  if (!ok) {
    notifyToast("Operation cancelled before macOS permission prompt", "info", 2500);
    return false;
  }
  return true;
}

function macPermissionLockedDirectory(entry) {
  if (!entry || !entry.isDir) return null;
  return macPermissionRiskForPath(entry.path);
}

function renderMacPermissionBadge(risk) {
  if (!risk) return "";
  return `<span class="inline-flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-[10px] leading-none text-amber-200 flex-shrink-0" title="macOS may ask for permission to access ${escapeHtml(risk.label)}"><i class="fa-solid fa-lock text-[9px]"></i> Needs permission</span>`;
}

function renderMacPermissionFolderIcon(risk) {
  if (!risk) return null;
  return '<span class="relative inline-flex w-4 h-4 items-center justify-center flex-shrink-0"><i class="fa-solid fa-folder text-slate-500"></i><i class="fa-solid fa-lock absolute -right-1 -bottom-1 text-[8px] text-amber-300"></i></span>';
}

function goHome() {
  listFiles(".", ws, { resetHistory: true });
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

const filePreviewModalManager = createFilePreviewModal({
  clientId,
  notifyToast,
  onDownload: (path) => downloadFile(path),
  beforeFileRead: (path, operation) => confirmMacPermissionRisk(path, operation),
});
let openFilePreview = filePreviewModalManager.openFilePreview;
const transferPanelManager = createTransferPanel({
  onCancel: (transferId) => cancelTransfer(transferId),
});
const {
  addTransferToUI,
  updateTransferProgress,
} = transferPanelManager;

const FILE_ICON_MAP = {
  // Images
  jpg: "fa-file-image text-purple-400", jpeg: "fa-file-image text-purple-400",
  png: "fa-file-image text-purple-400", gif: "fa-file-image text-purple-400",
  webp: "fa-file-image text-purple-400", bmp: "fa-file-image text-purple-400",
  svg: "fa-file-image text-purple-400", ico: "fa-file-image text-purple-400",
  tiff: "fa-file-image text-purple-400", tif: "fa-file-image text-purple-400",
  // Video
  mp4: "fa-file-video text-pink-400", avi: "fa-file-video text-pink-400",
  mkv: "fa-file-video text-pink-400", mov: "fa-file-video text-pink-400",
  wmv: "fa-file-video text-pink-400", flv: "fa-file-video text-pink-400",
  webm: "fa-file-video text-pink-400", m4v: "fa-file-video text-pink-400",
  // Audio
  mp3: "fa-file-audio text-orange-400", wav: "fa-file-audio text-orange-400",
  flac: "fa-file-audio text-orange-400", ogg: "fa-file-audio text-orange-400",
  aac: "fa-file-audio text-orange-400", wma: "fa-file-audio text-orange-400",
  m4a: "fa-file-audio text-orange-400",
  // PDF
  pdf: "fa-file-pdf text-red-400",
  // Word
  doc: "fa-file-word text-blue-400", docx: "fa-file-word text-blue-400",
  odt: "fa-file-word text-blue-400", rtf: "fa-file-word text-blue-400",
  // Excel
  xls: "fa-file-excel text-green-400", xlsx: "fa-file-excel text-green-400",
  ods: "fa-file-excel text-green-400", csv: "fa-file-excel text-green-400",
  // PowerPoint
  ppt: "fa-file-powerpoint text-orange-500", pptx: "fa-file-powerpoint text-orange-500",
  odp: "fa-file-powerpoint text-orange-500",
  // Archives
  zip: "fa-file-zipper text-yellow-500", rar: "fa-file-zipper text-yellow-500",
  "7z": "fa-file-zipper text-yellow-500", tar: "fa-file-zipper text-yellow-500",
  gz: "fa-file-zipper text-yellow-500", bz2: "fa-file-zipper text-yellow-500",
  xz: "fa-file-zipper text-yellow-500", tgz: "fa-file-zipper text-yellow-500",
  // Code
  js: "fa-file-code text-yellow-300", ts: "fa-file-code text-blue-300",
  jsx: "fa-file-code text-cyan-300", tsx: "fa-file-code text-cyan-300",
  py: "fa-file-code text-yellow-300", go: "fa-file-code text-cyan-400",
  rs: "fa-file-code text-orange-300", c: "fa-file-code text-blue-300",
  cpp: "fa-file-code text-blue-300", h: "fa-file-code text-blue-300",
  java: "fa-file-code text-red-300", cs: "fa-file-code text-green-300",
  rb: "fa-file-code text-red-400", php: "fa-file-code text-indigo-300",
  swift: "fa-file-code text-orange-400", kt: "fa-file-code text-purple-300",
  // Web
  html: "fa-code text-orange-300", htm: "fa-code text-orange-300",
  css: "fa-code text-blue-300", scss: "fa-code text-pink-300",
  sass: "fa-code text-pink-300", less: "fa-code text-blue-300",
  // Config / Data
  json: "fa-file-code text-emerald-400", yaml: "fa-file-code text-emerald-400",
  yml: "fa-file-code text-emerald-400", xml: "fa-file-code text-emerald-400",
  toml: "fa-file-code text-emerald-400", ini: "fa-file-code text-emerald-400",
  cfg: "fa-file-code text-emerald-400", conf: "fa-file-code text-emerald-400",
  env: "fa-file-code text-emerald-400",
  // Text / Docs
  txt: "fa-file-lines text-slate-300", md: "fa-file-lines text-slate-300",
  log: "fa-file-lines text-slate-400", readme: "fa-file-lines text-slate-300",
  // Executables
  exe: "fa-gear text-green-400", msi: "fa-gear text-green-400",
  com: "fa-gear text-green-400", app: "fa-gear text-green-400",
  appimage: "fa-gear text-green-400",
  // Scripts
  bat: "fa-terminal text-green-300", cmd: "fa-terminal text-green-300",
  ps1: "fa-terminal text-blue-300", sh: "fa-terminal text-green-300",
  bash: "fa-terminal text-green-300", zsh: "fa-terminal text-green-300",
  // Libraries
  dll: "fa-puzzle-piece text-indigo-400", so: "fa-puzzle-piece text-indigo-400",
  dylib: "fa-puzzle-piece text-indigo-400", lib: "fa-puzzle-piece text-indigo-400",
  a: "fa-puzzle-piece text-indigo-400",
  // Databases
  db: "fa-database text-amber-400", sqlite: "fa-database text-amber-400",
  sqlite3: "fa-database text-amber-400", mdb: "fa-database text-amber-400",
  sql: "fa-database text-amber-400",
  // Fonts
  ttf: "fa-font text-teal-400", otf: "fa-font text-teal-400",
  woff: "fa-font text-teal-400", woff2: "fa-font text-teal-400",
  eot: "fa-font text-teal-400",
  // Keys/certs
  pem: "fa-key text-yellow-300", crt: "fa-key text-yellow-300",
  cer: "fa-key text-yellow-300", key: "fa-key text-yellow-300",
  pfx: "fa-key text-yellow-300", p12: "fa-key text-yellow-300",
  // Disk images
  iso: "fa-compact-disc text-slate-300", img: "fa-compact-disc text-slate-300",
  vhd: "fa-compact-disc text-slate-300", vmdk: "fa-compact-disc text-slate-300",
};

// Extensions whose icon depends on the actual file (embedded resources),
// not just the registered shell association.
const SELF_ICONNING_EXTS = new Set(["exe", "ico", "lnk", "dll", "msi", "cpl", "scr"]);
// Extensions we'll request a Windows shell thumbnail for. Skip everything else.
const THUMBNAIL_EXTS = new Set([
  "jpg", "jpeg", "png", "gif", "bmp", "webp", "tif", "tiff", "heic", "heif",
  "mp4", "mkv", "mov", "avi", "webm", "m4v",
  "pdf",
  "docx", "xlsx", "pptx",
]);

// key → { blobUrl?: string, failed?: boolean, pending?: boolean }
const iconCache = new Map();
const thumbCache = new Map();

// Queues + batching
const iconQueue = []; // {key, path?, ext?}
const thumbQueue = []; // {key, path, size}
const iconCommandsInFlight = new Set();
const thumbCommandsInFlight = new Set();
let iconFlushScheduled = false;
let thumbFlushScheduled = false;
const ICON_BATCH_SIZE = 32;
const ICON_BATCH_DELAY_MS = 60;
const THUMB_BATCH_SIZE = 8;
const THUMB_BATCH_DELAY_MS = 80;
const THUMB_EDGE = 96;
const MAX_THUMB_INFLIGHT_COMMANDS = 2;

function iconCacheKey(entry) {
  if (entry.isDir) return null;
  const ext = getFileExt(entry.name);
  if (!ext) return `ext:_noext`;
  if (SELF_ICONNING_EXTS.has(ext)) {
    return `path:${entry.path}|${entry.size}|${entry.modTime}`;
  }
  return `ext:${ext}`;
}

function thumbCacheKey(entry) {
  if (entry.isDir) return null;
  const ext = getFileExt(entry.name);
  if (!THUMBNAIL_EXTS.has(ext)) return null;
  // Skip absurdly large files — Windows providers may bog down. 256MB cap.
  if (entry.size > 256 * 1024 * 1024) return null;
  return `thumb:${entry.path}|${entry.size}|${entry.modTime}|${THUMB_EDGE}`;
}

function scheduleIconFlush() {
  if (iconFlushScheduled) return;
  iconFlushScheduled = true;
  setTimeout(flushIconQueue, ICON_BATCH_DELAY_MS);
}

function flushIconQueue() {
  iconFlushScheduled = false;
  if (iconQueue.length === 0) return;
  const batch = iconQueue.splice(0, ICON_BATCH_SIZE);
  const commandId = `icon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  iconCommandsInFlight.add(commandId);
  send({
    type: "command",
    commandType: "file_icon",
    id: commandId,
    payload: { items: batch },
  });
  if (iconQueue.length > 0) scheduleIconFlush();
}

function scheduleThumbFlush() {
  if (thumbFlushScheduled) return;
  if (thumbCommandsInFlight.size >= MAX_THUMB_INFLIGHT_COMMANDS) return;
  thumbFlushScheduled = true;
  setTimeout(flushThumbQueue, THUMB_BATCH_DELAY_MS);
}

function flushThumbQueue() {
  thumbFlushScheduled = false;
  if (thumbQueue.length === 0) return;
  if (thumbCommandsInFlight.size >= MAX_THUMB_INFLIGHT_COMMANDS) return;
  const batch = thumbQueue.splice(0, THUMB_BATCH_SIZE);
  const commandId = `thumb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  thumbCommandsInFlight.add(commandId);
  send({
    type: "command",
    commandType: "file_thumb",
    id: commandId,
    payload: { items: batch },
  });
  if (thumbQueue.length > 0) scheduleThumbFlush();
}

function requestIconFor(entry) {
  const key = iconCacheKey(entry);
  if (!key) return null;
  if (iconCache.has(key)) return key;
  iconCache.set(key, { pending: true });
  const item = { key };
  if (key.startsWith("path:")) {
    item.path = entry.path;
  } else {
    const ext = getFileExt(entry.name);
    if (ext) item.ext = ext;
    else item.ext = "";
  }
  iconQueue.push(item);
  scheduleIconFlush();
  return key;
}

function requestThumbFor(entry) {
  const key = thumbCacheKey(entry);
  if (!key) return null;
  if (thumbCache.has(key)) return key;
  thumbCache.set(key, { pending: true });
  thumbQueue.push({ key, path: entry.path, size: THUMB_EDGE });
  scheduleThumbFlush();
  return key;
}

function handleFileIconResult(msg) {
  if (msg.commandId) iconCommandsInFlight.delete(msg.commandId);
  const items = Array.isArray(msg.icons) ? msg.icons : [];
  for (const item of items) {
    if (!item || !item.key) continue;
    const entry = iconCache.get(item.key) || {};
    entry.pending = false;
    if (item.png && item.png.length > 0) {
      const blob = new Blob([item.png], { type: "image/png" });
      entry.blobUrl = URL.createObjectURL(blob);
    } else {
      entry.failed = true;
    }
    iconCache.set(item.key, entry);
    applyIconToDom(item.key, entry);
  }
}

function handleFileThumbResult(msg) {
  if (msg.commandId) thumbCommandsInFlight.delete(msg.commandId);
  // Pump the next thumbnail batch now that there's capacity.
  if (thumbQueue.length > 0) scheduleThumbFlush();
  const items = Array.isArray(msg.thumbs) ? msg.thumbs : [];
  for (const item of items) {
    if (!item || !item.key) continue;
    const entry = thumbCache.get(item.key) || {};
    entry.pending = false;
    if (item.jpeg && item.jpeg.length > 0) {
      const blob = new Blob([item.jpeg], { type: "image/jpeg" });
      entry.blobUrl = URL.createObjectURL(blob);
      entry.w = item.w || 0;
      entry.h = item.h || 0;
    } else {
      entry.failed = true;
    }
    thumbCache.set(item.key, entry);
    applyThumbToDom(item.key, entry);
  }
}

function applyIconToDom(key, entry) {
  if (!entry || !entry.blobUrl) return;
  const escaped = (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(key) : key.replace(/"/g, '\\"');
  document.querySelectorAll(`[data-icon-key="${escaped}"]`).forEach((el) => {
    el.innerHTML = `<img src="${entry.blobUrl}" class="w-4 h-4 object-contain pointer-events-none" alt="" draggable="false">`;
  });
}

function applyThumbToDom(key, entry) {
  if (!entry || !entry.blobUrl) return;
  const escaped = (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(key) : key.replace(/"/g, '\\"');
  // Thumbs are used by hover-preview popover; just update the popover if it's currently showing this key.
  if (currentPopoverKey === key) {
    renderQuickLookPopover(currentPopoverEntry, entry.blobUrl, entry.w, entry.h);
  }
}

// Windows FILE_ATTRIBUTE_* flags surfaced as compact badges next to the filename.
const ATTR_READONLY      = 0x00000001;
const ATTR_HIDDEN        = 0x00000002;
const ATTR_SYSTEM        = 0x00000004;
const ATTR_REPARSE_POINT = 0x00000400;
const ATTR_COMPRESSED    = 0x00000800;
const ATTR_ENCRYPTED     = 0x00004000;

function renderAttrBadges(attrs) {
  if (!attrs || typeof attrs !== "number") return "";
  const pills = [];
  const pill = (label, title, cls) =>
    `<span class="text-[10px] leading-none px-1 py-0.5 rounded ${cls}" title="${title}">${label}</span>`;
  if (attrs & ATTR_HIDDEN) pills.push(pill("H", "Hidden", "bg-slate-700 text-slate-300"));
  if (attrs & ATTR_SYSTEM) pills.push(pill("S", "System", "bg-red-900/60 text-red-200"));
  if (attrs & ATTR_REPARSE_POINT) pills.push(pill("L", "Reparse point / symlink", "bg-indigo-900/60 text-indigo-200"));
  if (attrs & ATTR_COMPRESSED) pills.push(pill("C", "NTFS compressed", "bg-blue-900/60 text-blue-200"));
  if (attrs & ATTR_ENCRYPTED) pills.push(pill("E", "NTFS encrypted (EFS)", "bg-emerald-900/60 text-emerald-200"));
  if (attrs & ATTR_READONLY) pills.push(pill("R", "Read-only", "bg-slate-700 text-slate-300"));
  if (pills.length === 0) return "";
  return `<span class="inline-flex items-center gap-1 ml-1 flex-shrink-0">${pills.join("")}</span>`;
}

// ---- Hover-preview / spacebar quicklook popover --------------------------------
let currentPopoverKey = null;
let currentPopoverEntry = null;
let hoverPreviewTimer = null;
let popoverEl = null;
let lastHoveredRow = null;
let lastHoveredEntry = null;
const HOVER_DELAY_MS = 350;

function ensurePopover() {
  if (popoverEl) return popoverEl;
  popoverEl = document.createElement("div");
  popoverEl.id = "file-quicklook-popover";
  popoverEl.style.cssText = "position:fixed;z-index:1500;display:none;pointer-events:none;background:#0f172a;border:1px solid #334155;border-radius:0.5rem;box-shadow:0 10px 25px rgba(0,0,0,.5);padding:0.5rem;max-width:280px;";
  document.body.appendChild(popoverEl);
  return popoverEl;
}

function hideQuickLookPopover() {
  if (hoverPreviewTimer) {
    clearTimeout(hoverPreviewTimer);
    hoverPreviewTimer = null;
  }
  currentPopoverKey = null;
  currentPopoverEntry = null;
  if (popoverEl) popoverEl.style.display = "none";
}

function renderQuickLookPopover(entry, thumbUrl, w, h) {
  if (!entry) return;
  const el = ensurePopover();
  const ext = getFileExt(entry.name);
  const sizeStr = entry.isDir ? "" : formatBytes(entry.size);
  const modStr = new Date(entry.modTime * 1000).toLocaleString();
  let imgHtml = "";
  if (thumbUrl) {
    imgHtml = `<img src="${thumbUrl}" style="max-width:256px;max-height:256px;display:block;margin:0 auto;border-radius:0.25rem;" alt="">`;
  } else {
    const iconKey = iconCacheKey(entry);
    const iconEntry = iconKey ? iconCache.get(iconKey) : null;
    if (iconEntry && iconEntry.blobUrl) {
      imgHtml = `<img src="${iconEntry.blobUrl}" style="width:64px;height:64px;display:block;margin:0 auto;image-rendering:auto;" alt="">`;
    } else {
      imgHtml = `<div style="font-size:48px;text-align:center;color:#94a3b8;">${getFileIcon(entry)}</div>`;
    }
  }
  el.innerHTML = `
    ${imgHtml}
    <div style="margin-top:0.5rem;font-size:11px;color:#e2e8f0;text-align:center;word-break:break-word;">${escapeHtml(entry.name)}</div>
    <div style="margin-top:0.25rem;font-size:10px;color:#94a3b8;text-align:center;">
      ${entry.isDir ? "Folder" : (ext ? ext.toUpperCase() + " · " : "") + sizeStr}
    </div>
    <div style="font-size:10px;color:#64748b;text-align:center;">${modStr}</div>
  `;
  el.style.display = "block";
  positionPopover(el);
}

function positionPopover(el) {
  if (!lastHoveredRow) return;
  const rect = lastHoveredRow.getBoundingClientRect();
  const popoverWidth = el.offsetWidth || 280;
  const popoverHeight = el.offsetHeight || 320;
  let left = rect.right + 12;
  let top = rect.top;
  if (left + popoverWidth > window.innerWidth - 8) {
    left = rect.left - popoverWidth - 12;
  }
  if (left < 8) left = 8;
  if (top + popoverHeight > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - popoverHeight - 8);
  }
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function showQuickLookFor(row, entry, immediate) {
  if (!entry) return;
  lastHoveredRow = row;
  lastHoveredEntry = entry;
  const tKey = thumbCacheKey(entry);
  currentPopoverKey = tKey;
  currentPopoverEntry = entry;
  const cached = tKey ? thumbCache.get(tKey) : null;
  if (cached && cached.blobUrl) {
    renderQuickLookPopover(entry, cached.blobUrl, cached.w, cached.h);
    return;
  }
  // No thumb yet — still show the popover with icon + metadata.
  renderQuickLookPopover(entry, null, 0, 0);
  // Ensure thumb is queued (createFileRow already did this; no-op if so).
  if (tKey) requestThumbFor(entry);
}

function attachRowQuicklookEvents(row, entry) {
  if (entry.isDir) return; // folders: skip hover popover (would just be the icon)
  row.addEventListener("mouseenter", () => {
    lastHoveredRow = row;
    lastHoveredEntry = entry;
    if (hoverPreviewTimer) clearTimeout(hoverPreviewTimer);
    hoverPreviewTimer = setTimeout(() => showQuickLookFor(row, entry, false), HOVER_DELAY_MS);
  });
  row.addEventListener("mouseleave", () => {
    hideQuickLookPopover();
  });
}

// Spacebar = open quicklook for last-hovered/focused row (Finder style).
window.addEventListener("keydown", (e) => {
  if (e.key !== " ") return;
  const target = e.target;
  // Don't hijack space in inputs/textareas/editor.
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
  if (document.querySelector(".file-editor-modal.show")) return;
  if (document.querySelector(".file-preview-modal.show")) return;
  if (!lastHoveredRow || !lastHoveredEntry) return;
  e.preventDefault();
  showQuickLookFor(lastHoveredRow, lastHoveredEntry, true);
});
window.addEventListener("keyup", (e) => {
  if (e.key !== " ") return;
  hideQuickLookPopover();
});
window.addEventListener("scroll", () => hideQuickLookPopover(), { passive: true });

// ---- Folder size --------------------------------------------------------------
// commandId -> { path, toastId? }
const folderSizeInFlight = new Map();

function requestFolderSize(entry) {
  if (!entry.isDir) return;
  const commandId = `dirsize-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  folderSizeInFlight.set(commandId, { path: entry.path, name: entry.name });
  send({
    type: "command",
    commandType: "file_dirsize",
    id: commandId,
    payload: { path: entry.path },
  });
  notifyToast(`Calculating size of ${entry.name}…`, "info", 2000);
}

function handleFileDirsizeResult(msg) {
  const tracked = msg.commandId ? folderSizeInFlight.get(msg.commandId) : null;
  if (!tracked) return;
  if (!msg.done) {
    // Progress tick — update status bar only (avoid toast spam).
    if (statusEl) {
      const label = `${tracked.name || msg.path}: ${formatBytes(msg.bytes || 0)} (${msg.files || 0} files)`;
      statusEl.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${escapeHtml(label)}`;
    }
    return;
  }
  folderSizeInFlight.delete(msg.commandId);
  updateStatus("connected", "Connected");
  if (msg.error) {
    notifyToast(`Size of ${tracked.name}: error — ${msg.error}`, "error", 5000);
    return;
  }
  notifyToast(
    `${tracked.name}: ${formatBytes(msg.bytes || 0)} (${msg.files || 0} files, ${msg.dirs || 0} folders)`,
    "success",
    8000,
  );
}

function getFileIcon(entry) {
  if (entry.isDir) {
    return '<i class="fa-solid fa-folder text-yellow-400"></i>';
  }
  const ext = getFileExt(entry.name);
  const cls = FILE_ICON_MAP[ext];
  const fallback = cls
    ? `<i class="fa-solid ${cls}"></i>`
    : '<i class="fa-solid fa-file text-slate-400"></i>';

  const key = iconCacheKey(entry);
  if (!key) return fallback;
  const cached = iconCache.get(key);
  if (cached && cached.blobUrl) {
    return `<span class="inline-flex w-4 h-4 items-center justify-center" data-icon-key="${escapeHtml(key)}"><img src="${cached.blobUrl}" class="w-4 h-4 object-contain pointer-events-none" alt="" draggable="false"></span>`;
  }
  return `<span class="inline-flex w-4 h-4 items-center justify-center" data-icon-key="${escapeHtml(key)}">${fallback}</span>`;
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
    currentPath = msg.path || currentPath;
    renderFileListError(msg);
    updateDirectorySummaryAndPaging(0, 0);
    return;
  }

  lastSuccessfulResponse = Date.now();
  updateStatus("connected", "Connected");
  enableControls(true);

  currentPath = msg.path;
  directoryEntries = Array.isArray(msg.entries) ? msg.entries : [];

  // Sidebar: detect OS/home on first successful listing
  if (!detectedOS) {
    detectOSAndHome(currentPath);
    // If root listing with drive letters, detect as Windows
    if (!detectedOS && (!currentPath || currentPath === ".") && directoryEntries.some((e) => e.isDir && e.name.match(/^[A-Za-z]:$/))) {
      detectedOS = "windows";
      updateSidebar();
    }
  } else if (!detectedHomePath) {
    // Keep trying to detect home path on subsequent navigations
    detectOSAndHome(currentPath);
  }
  // Populate drives panel when at root
  if (!msg.path || msg.path === ".") {
    lastDriveEntries = directoryEntries;
    updateSidebarDrives(directoryEntries);
  } else if (lastDriveEntries.length === 0) {
    updateSidebarDrives([]);
  }
  highlightSidebarActive();
  updatePinnedSidebar();

  // If the previewed item was from another directory, clear it.
  if (currentPreviewEntry && !directoryEntries.some((e) => e.path === currentPreviewEntry.path)) {
    clearPreviewPane();
  }

  markMacPermissionAllowed(currentPath);
  selectedFiles.clear();
  updateSelectionUI();
  renderCurrentDirectory();
}

function isMacFolderAccessError(msg) {
  if (!msg || !msg.error) return false;
  if (msg.canRequestAccess || msg.accessDenied) return true;
  if (detectedOS !== "mac") return false;
  return /permission denied|operation not permitted|not permitted|access denied/i.test(msg.error);
}

function renderFileListError(msg) {
  const canRequestAccess = isMacFolderAccessError(msg);
  const helpText = msg.accessHelp || "macOS blocked this folder. Confirm the retry, approve the prompt on the Mac, then refresh if needed.";
  const actionHtml = canRequestAccess
    ? `<div class="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button id="request-folder-access-btn" class="button primary text-sm px-4 py-2">
          <i class="fa-solid fa-unlock-keyhole"></i> Try Access Again
        </button>
        <button id="retry-folder-access-btn" class="button ghost text-sm px-4 py-2">
          <i class="fa-solid fa-rotate-right"></i> Retry
        </button>
      </div>
      <div class="mt-3 text-xs text-amber-200/80 max-w-xl mx-auto">${escapeHtml(helpText)}</div>`
    : "";

  fileListEl.innerHTML = `
    <div class="px-4 py-6 text-center ${canRequestAccess ? "text-amber-200" : "text-red-400"}">
      <i class="fa-solid fa-exclamation-triangle mr-2"></i>${escapeHtml(msg.error)}
      ${actionHtml}
    </div>`;

  const requestBtn = document.getElementById("request-folder-access-btn");
  if (requestBtn) {
    requestBtn.addEventListener("click", () => requestFolderAccess(msg.path || currentPath || "."));
  }

  const retryBtn = document.getElementById("retry-folder-access-btn");
  if (retryBtn) {
    retryBtn.addEventListener("click", () => listFiles(msg.path || currentPath || "."));
  }
}

async function requestFolderAccess(path) {
  const targetPath = path || currentPath || ".";
  notifyToast("Trying to open the folder on the Mac...", "info", 3500);
  await listFiles(targetPath, ws, { skipHistory: true });
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
  const macPermissionRisk = macPermissionLockedDirectory(entry);
  row.className =
    "file-item grid grid-cols-12 gap-3 px-4 py-3 border border-transparent cursor-pointer transition-colors" +
    (macPermissionRisk ? " opacity-60 bg-slate-950/30 hover:bg-amber-900/10" : " hover:bg-slate-800/50");
  row.dataset.path = entry.path;
  row.dataset.isDir = entry.isDir;
  if (macPermissionRisk) {
    row.dataset.macPermission = "required";
    row.title = `macOS may ask the user to allow access to ${macPermissionRisk.label}.`;
  }

  // Kick off lazy fetches for the row's real icon and (if applicable) its thumbnail.
  // Both are throttled + batched; the DOM gets updated when results arrive.
  requestIconFor(entry);
  if (!entry.isDir) requestThumbFor(entry);

  const icon = renderMacPermissionFolderIcon(macPermissionRisk) || getFileIcon(entry);
  const badges = renderAttrBadges(entry.attrs);
  const macPermissionBadge = renderMacPermissionBadge(macPermissionRisk);

  const size = entry.isDir ? "-" : formatBytes(entry.size);
  const modTime = new Date(entry.modTime * 1000).toLocaleString();

  const pinnedNow = entry.isDir && isPinned(entry.path);
  const pinTitle = pinnedNow ? "Unpin from sidebar" : "Pin to sidebar";
  const pinIcon = pinnedNow ? "fa-star" : "fa-star";
  const pinClass = pinnedNow ? "pin-star-btn pinned" : "pin-star-btn";
  const pinBtn = entry.isDir
    ? `<button class="${pinClass}" data-pin-toggle="${escapeHtml(entry.path)}" title="${pinTitle}" type="button"><i class="fa-solid ${pinIcon}"></i></button>`
    : "";

  row.innerHTML = `
    <input type="checkbox" class="file-checkbox" data-path="${escapeHtml(entry.path)}">
    <div class="col-span-6 flex items-center gap-2 truncate pl-8">
      ${icon}
      <span class="truncate">${escapeHtml(entry.name)}</span>
      ${pinBtn}
      ${badges}
      ${macPermissionBadge}
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
  mobileMetaDiv.innerHTML = `<span>${size}</span><span class="opacity-30 select-none mx-1">·</span><span>${modTime}</span>`;
  nameDiv.appendChild(mobileMetaDiv);

  row.onclick = (e) => {
    if (e.target.closest(".file-checkbox") || e.target.closest(".action-btn") || e.target.closest(".pin-star-btn")) {
      return;
    }

    // Single-click always updates the preview pane.
    showPreviewForEntry(entry);

    if (entry.isDir) {
      listFiles(entry.path);
    }
  };

  row.ondblclick = async (e) => {
    if (e.target.closest(".file-checkbox") || e.target.closest(".action-btn") || e.target.closest(".pin-star-btn")) {
      return;
    }
    if (entry.isDir) {
      listFiles(entry.path);
    } else if (isPreviewable(entry.name)) {
      await openFilePreview(entry.path, entry.size);
    } else if (KNOWN_BINARY_EXTS.has(getFileExt(entry.name))) {
      await openHexViewer(entry.path);
    } else {
      await openFileInEditor(entry.path);
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

  const pinToggleBtn = row.querySelector("[data-pin-toggle]");
  if (pinToggleBtn) {
    pinToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = pinToggleBtn.dataset.pinToggle;
      if (isPinned(target)) {
        unpinPath(target);
        pinToggleBtn.classList.remove("pinned");
        pinToggleBtn.title = "Pin to sidebar";
      } else {
        pinPath(target, entry.name);
        pinToggleBtn.classList.add("pinned");
        pinToggleBtn.title = "Unpin from sidebar";
      }
    });
  }

  row.oncontextmenu = (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, entry);
  };

  attachRowQuicklookEvents(row, entry);

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
    case "execute":
      executeFile(entry.path, false);
      break;
    case "silent_execute":
      executeFile(entry.path, true);
      break;
    case "delete":
      deleteFile(entry.path);
      break;
    case "dirsize":
      requestFolderSize(entry);
      break;
    case "pin":
      pinPath(entry.path, entry.name);
      notifyToast("Pinned", "success", 1800);
      break;
    case "unpin":
      unpinPath(entry.path);
      notifyToast("Unpinned", "info", 1800);
      break;
    case "hex_peek":
      if (!entry.isDir) openHexViewer(entry.path);
      break;
    case "hash":
      if (!entry.isDir) requestFileHash(entry.path, "context");
      break;
  }
}

async function downloadFile(path) {
  if (!(await confirmMacPermissionRisk(path, "download file"))) return;
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

      let received = 0;
      let lastLoggedBytes = 0;
      const trackChunk = (size) => {
        received += size;
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
      };

      const canStreamToDisk = typeof window.showSaveFilePicker === "function" && !!res.body;
      let usedStreamToDisk = false;

      if (canStreamToDisk) {
        let saveHandle = null;
        try {
          saveHandle = await window.showSaveFilePicker({ suggestedName: fileName });
        } catch (pickerErr) {
          if (pickerErr && pickerErr.name === "AbortError") {
            transfer.cancelled = true;
            try { abortController.abort(); } catch {}
            removeTransfer(transferId);
            fileDownloads.delete(path);
            updateStatus("connected", "Connected");
            return;
          }
          console.warn("[filebrowser] save picker failed, falling back to blob", pickerErr);
          saveHandle = null;
        }
        if (saveHandle) {
          const writable = await saveHandle.createWritable();
          const progressTransform = new TransformStream({
            transform(chunk, controller) {
              trackChunk(chunk.byteLength);
              controller.enqueue(chunk);
            },
          });
          try {
            await res.body.pipeThrough(progressTransform).pipeTo(writable, {
              signal: abortController.signal,
            });
          } catch (pipeErr) {
            try { await writable.abort(pipeErr); } catch {}
            throw pipeErr;
          }
          usedStreamToDisk = true;
        }
      }

      if (!usedStreamToDisk) {
        const chunks = [];
        if (res.body) {
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              trackChunk(value.length);
            }
            if (transfer.cancelled) {
              try { await reader.cancel(); } catch {}
              break;
            }
          }
        } else {
          console.warn("[filebrowser] download response missing body", { path });
          const blob = await res.blob();
          const buf = new Uint8Array(await blob.arrayBuffer());
          chunks.push(buf);
          trackChunk(buf.length);
        }

        if (transfer.cancelled) {
          removeTransfer(transferId);
          fileDownloads.delete(path);
          updateStatus("connected", "Connected");
          return;
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

      console.log("Download complete:", path, `${received} bytes`);
      console.debug("[filebrowser] download complete", {
        path,
        received,
        total: transfer.total,
        streamedToDisk: usedStreamToDisk,
      });
      markMacPermissionAllowed(path);
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
    markMacPermissionAllowed(msg.path);
    removeTransfer(download.id);
    fileDownloads.delete(msg.path);
    updateStatus("connected", "Connected");
  }
}

async function zipAndDownload(path) {
  if (!(await confirmMacPermissionRisk(path, "read folder"))) return;
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

function executeFile(path, silent) {
  if (silent) {
    const commandId = `silent-exec-${Date.now()}`;
    send({
      type: "command",
      commandType: "silent_exec",
      id: commandId,
      payload: { command: path, args: [], hideWindow: true },
    });
    trackCommandResult(commandId, {
      successMessage: "Silent execution started",
      errorPrefix: "Silent execution failed",
    });
  } else {
    const commandId = `exec-${Date.now()}`;
    send({
      type: "command",
      commandType: "file_execute",
      id: commandId,
      payload: { path },
    });
    trackCommandResult(commandId, {
      successMessage: "Execution started",
      errorPrefix: "Execution failed",
    });
  }
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
      transfer.sent = Math.max(transfer.sent || 0, transfer.receivedBytes);
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
  const executeItem = contextMenu.querySelector('[data-action="execute"]');
  const silentExecuteItem = contextMenu.querySelector('[data-action="silent_execute"]');
  const dirsizeItem = contextMenu.querySelector('[data-action="dirsize"]');
  const pinItem = contextMenu.querySelector('[data-action="pin"]');
  const unpinItem = contextMenu.querySelector('[data-action="unpin"]');
  const hexItem = contextMenu.querySelector('[data-action="hex_peek"]');
  const hashItem = contextMenu.querySelector('[data-action="hash"]');

  if (editItem) editItem.style.display = entry.isDir ? "none" : "block";
  if (zipItem) zipItem.style.display = entry.isDir ? "block" : "none";
  if (chmodItem) chmodItem.style.display = entry.mode ? "block" : "none";
  if (executeItem) executeItem.style.display = entry.isDir ? "none" : "block";
  if (silentExecuteItem) silentExecuteItem.style.display = entry.isDir ? "none" : "block";
  if (dirsizeItem) dirsizeItem.style.display = entry.isDir ? "block" : "none";

  const pinned = isPinned(entry.path);
  if (pinItem) pinItem.style.display = pinned ? "none" : "block";
  if (unpinItem) unpinItem.style.display = pinned ? "block" : "none";
  if (hexItem) hexItem.style.display = entry.isDir ? "none" : "block";
  if (hashItem) hashItem.style.display = entry.isDir ? "none" : "block";
}

function hideContextMenu() {
  contextMenu.classList.remove("show");
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

let dropOverlayEl = null;

function ensureDropOverlay() {
  if (dropOverlayEl || !fileListPanel) return dropOverlayEl;
  if (!fileListPanel.classList.contains("relative")) {
    fileListPanel.classList.add("relative");
  }
  const overlay = document.createElement("div");
  overlay.id = "file-drop-overlay";
  overlay.className =
    "hidden absolute inset-0 z-30 pointer-events-none flex items-center justify-center bg-blue-500/15 border-2 border-dashed border-blue-400 rounded-lg backdrop-blur-sm";
  overlay.innerHTML = `
    <div class="text-center px-6">
      <i class="fa-solid fa-cloud-arrow-up text-5xl text-blue-300 mb-3"></i>
      <div class="text-base font-semibold text-blue-100 drop-target-label">Drop files to upload</div>
      <div class="text-xs text-blue-200/80 mt-1 drop-target-path"></div>
    </div>
  `;
  fileListPanel.appendChild(overlay);
  dropOverlayEl = overlay;
  return overlay;
}

function setDropTargetActive(active) {
  if (!fileListPanel) return;
  const overlay = ensureDropOverlay();
  if (overlay) {
    overlay.classList.toggle("hidden", !active);
    if (active) {
      const pathEl = overlay.querySelector(".drop-target-path");
      if (pathEl) {
        pathEl.textContent = currentPath ? `into ${currentPath}` : "";
      }
    }
  }
  fileListPanel.classList.toggle("ring-2", active);
  fileListPanel.classList.toggle("ring-blue-500", active);
  fileListPanel.classList.toggle("ring-offset-2", active);
  fileListPanel.classList.toggle("ring-offset-slate-950", active);
}

function setupDragAndDropUpload() {
  if (!fileListPanel) return;
  ensureDropOverlay();

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

  const uploadData = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    transfer.uploadXhr = xhr;

    // Keep request-level timeout high for large WAN uploads.
    xhr.timeout = 30 * 60 * 1000;
    xhr.open("POST", uploadUrl, true);
    xhr.withCredentials = true;
    xhr.responseType = "text";
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    const onAbort = () => {
      try {
        xhr.abort();
      } catch {}
    };

    if (transfer.abortController?.signal) {
      transfer.abortController.signal.addEventListener("abort", onAbort, { once: true });
    }

    xhr.upload.onprogress = (event) => {
      const total = event.total || file.size || transfer.total || 0;
      if (!total) return;
      const loaded = Math.min(event.loaded, total);
      // First 50% is browser -> server staging upload.
      const stageRatio = loaded / total;
      transfer.receivedBytes = loaded;
      transfer.sent = loaded;
      transfer.progress = Math.max(0, Math.min(50, Math.round(stageRatio * 50)));
      updateTransferProgress(transfer.id, transfer.progress, transfer.sent, transfer.total);
    };

    xhr.onerror = () => {
      reject(new Error("upload staging failed"));
    };

    xhr.ontimeout = () => {
      reject(new Error("upload staging timed out"));
    };

    xhr.onabort = () => {
      reject(new Error("Upload cancelled"));
    };

    xhr.onload = () => {
      const text = xhr.responseText || "";
      if (xhr.status < 200 || xhr.status >= 300) {
        console.debug("[filebrowser] upload stage failed", {
          status: xhr.status,
          body: text,
        });
        reject(new Error(text || "upload staging failed"));
        return;
      }

      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("upload staging failed"));
      }
    };

    try {
      xhr.send(file);
    } catch (err) {
      reject(err instanceof Error ? err : new Error("upload staging failed"));
    }
  });

  if (!uploadData?.pullUrl) {
    throw new Error("upload staging failed");
  }

  console.debug("[filebrowser] upload staged", {
    pullUrl: uploadData.pullUrl,
    size: uploadData.size,
    agentNotified: !!uploadData.agentNotified,
  });

  let commandId;
  let waitResult;
  if (uploadData.agentNotified && typeof uploadData.agentCommandId === "string") {
    commandId = uploadData.agentCommandId;
    waitResult = waitForCommandResult(commandId, HTTP_UPLOAD_AGENT_TIMEOUT_MS);
  } else {
    commandId = `upload-http-${Date.now()}-${Math.random()}`;
    waitResult = waitForCommandResult(commandId, HTTP_UPLOAD_AGENT_TIMEOUT_MS);
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
  }

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
  transfer.uploadXhr = null;
}

const WS_UPLOAD_MAX_TOTAL = 8 * 1024 * 1024;
const WS_UPLOAD_CHUNK_SIZE = 512 * 1024;
const WS_UPLOAD_CONCURRENCY = 4;
const WS_UPLOAD_ACK_TIMEOUT_MS = 90 * 1000;
const HTTP_UPLOAD_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const PREFER_HTTP_UPLOAD_PULL = true;

async function uploadFileViaWsChunks(file, path, transfer) {
  const total = file.size;
  transfer.total = total;

  const pumpChunk = (offset, data) => {
    const ackPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        transfer.pendingAcks.delete(offset);
        reject(new Error(`upload chunk timeout (offset ${offset})`));
      }, WS_UPLOAD_ACK_TIMEOUT_MS);
      transfer.pendingAcks.set(offset, { resolve, reject, timeoutId });
    });
    send({
      type: "file_upload",
      path,
      data,
      offset,
      total,
      transferId: transfer.transferId,
    });
    transfer.sent = Math.min((transfer.sent || 0) + data.length, total);
    if (total > 0) {
      transfer.progress = Math.round((transfer.sent / total) * 100);
      updateTransferProgress(transfer.id, transfer.progress, transfer.sent, total);
    }
    return ackPromise;
  };

  if (total === 0) {
    transfer.expectedChunks = 1;
    await pumpChunk(0, new Uint8Array(0));
    transfer.completed = true;
    transfer.progress = 100;
    updateTransferProgress(transfer.id, 100, 0, 0);
    return;
  }

  const expectedChunks = Math.ceil(total / WS_UPLOAD_CHUNK_SIZE);
  transfer.expectedChunks = expectedChunks;

  const inFlight = new Map();
  let nextOffset = 0;

  try {
    while (nextOffset < total || inFlight.size > 0) {
      while (inFlight.size < WS_UPLOAD_CONCURRENCY && nextOffset < total) {
        if (transfer.cancelled) throw new Error("Upload cancelled");
        const start = nextOffset;
        const end = Math.min(start + WS_UPLOAD_CHUNK_SIZE, total);
        const buf = new Uint8Array(await file.slice(start, end).arrayBuffer());
        nextOffset = end;
        const tracked = pumpChunk(start, buf).then(() => inFlight.delete(start));
        inFlight.set(start, tracked);
      }
      if (inFlight.size > 0) {
        await Promise.race(inFlight.values());
      }
    }
    transfer.completed = true;
  } catch (err) {
    transfer.pendingAcks.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      try { pending.reject(err); } catch {}
    });
    transfer.pendingAcks.clear();
    throw err;
  }
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
    uploadXhr: null,
  };

  fileUploads.set(path, transfer);
  fileUploadsById.set(transferId, transfer);
  activeTransfers.set(transferId, transfer);
  addTransferToUI(transfer);

  try {
    if (PREFER_HTTP_UPLOAD_PULL) {
      await uploadFileViaHttpPull(file, path, transfer);
    } else if (file.size <= WS_UPLOAD_MAX_TOTAL) {
      await uploadFileViaWsChunks(file, path, transfer);
    } else {
      await uploadFileViaHttpPull(file, path, transfer);
    }
    finishUpload(transfer);
  } catch (err) {
    const canFallbackToWs = PREFER_HTTP_UPLOAD_PULL && file.size <= WS_UPLOAD_MAX_TOTAL && !transfer.cancelled;
    if (canFallbackToWs) {
      console.warn("[filebrowser] http upload failed, falling back to ws chunks", err);
      notifyToast("HTTP upload failed; retrying through WebSocket...", "warning", 3500);
      transfer.sent = 0;
      transfer.receivedBytes = 0;
      transfer.receivedChunks = 0;
      transfer.expectedChunks = 0;
      transfer.completed = false;
      transfer.ackedOffsets.clear();
      transfer.pendingAcks.forEach((pending) => {
        clearTimeout(pending.timeoutId);
        try { pending.reject(new Error("switching upload method")); } catch {}
      });
      transfer.pendingAcks.clear();
      transfer.progress = 0;
      updateTransferProgress(transfer.id, 0, 0, transfer.total);
      try {
        await uploadFileViaWsChunks(file, path, transfer);
        finishUpload(transfer);
        return;
      } catch (fallbackErr) {
        err = fallbackErr;
      }
    }
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
    listFiles(path, ws, { resetHistory: true });
  }
};

pathInput.onkeydown = (e) => {
  if (e.key === "Enter") {
    const path = pathInput.value.trim();
    if (path) {
      listFiles(path, ws, { resetHistory: true });
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

// ── Pinned paths (operator-scoped, localStorage) ────────────────────────────
const PINNED_STORAGE_KEY = "filebrowser.pinnedPaths.v1";
const sidebarPinned = document.getElementById("sidebar-pinned");
const sidebarPinCurrentBtn = document.getElementById("sidebar-pin-current-btn");

function loadPinnedPaths() {
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => p && typeof p.path === "string");
  } catch {
    return [];
  }
}

function savePinnedPaths(list) {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("Failed to persist pinned paths:", err);
  }
}

function isPinned(path) {
  return loadPinnedPaths().some((p) => p.path === path);
}

function pinPath(path, name) {
  if (!path) return;
  const list = loadPinnedPaths();
  if (list.some((p) => p.path === path)) return;
  const fallback = path.split(/[\/\\]/).filter(Boolean).pop() || path;
  list.push({ path, name: name || fallback, addedAt: Date.now() });
  savePinnedPaths(list);
  updatePinnedSidebar();
}

function unpinPath(path) {
  if (!path) return;
  const list = loadPinnedPaths().filter((p) => p.path !== path);
  savePinnedPaths(list);
  updatePinnedSidebar();
}

function updatePinnedSidebar() {
  if (!sidebarPinned) return;
  const list = loadPinnedPaths();
  if (list.length === 0) {
    sidebarPinned.innerHTML =
      '<div class="text-xs text-slate-500 text-center py-3">No pinned paths.<br><span class="text-slate-600">Right-click any folder.</span></div>';
    return;
  }
  let html = "";
  list.forEach((p) => {
    const active = currentPath && (currentPath === p.path || currentPath.startsWith(p.path + "/") || currentPath.startsWith(p.path + "\\"));
    html += `
      <div class="sidebar-item w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-slate-300 hover:text-white transition-colors text-left${active ? " active" : ""}" data-path="${escapeHtml(p.path)}">
        <i class="fa-solid fa-star text-yellow-400 w-3 text-center text-[10px]"></i>
        <span class="truncate flex-1" title="${escapeHtml(p.path)}">${escapeHtml(p.name)}</span>
        <button class="text-[10px] text-slate-600 hover:text-red-400 pin-remove-btn" title="Unpin" data-path="${escapeHtml(p.path)}" type="button">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>`;
  });
  sidebarPinned.innerHTML = html;
  sidebarPinned.querySelectorAll(".sidebar-item").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".pin-remove-btn")) return;
      listFiles(row.dataset.path);
    });
  });
  sidebarPinned.querySelectorAll(".pin-remove-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      unpinPath(btn.dataset.path);
    });
  });
}

if (sidebarPinCurrentBtn) {
  sidebarPinCurrentBtn.addEventListener("click", () => {
    if (!currentPath || currentPath === ".") {
      notifyToast("Navigate into a folder first", "info", 2500);
      return;
    }
    if (isPinned(currentPath)) {
      unpinPath(currentPath);
      notifyToast("Unpinned", "info", 1800);
    } else {
      pinPath(currentPath);
      notifyToast("Pinned", "success", 1800);
    }
  });
}

// ── Preview pane ────────────────────────────────────────────────────────────
const PREVIEW_PANE_STATE_KEY = "filebrowser.previewPaneVisible.v1";
const previewPaneHost = document.getElementById("preview-pane-host");
const previewPaneEl = document.getElementById("preview-pane");
const previewPaneToggle = document.getElementById("preview-pane-toggle");
const previewPaneShowBtnHost = document.getElementById("preview-pane-show-btn-host");
const previewPaneShowBtn = document.getElementById("preview-pane-show-btn");
const previewActiveEl = document.getElementById("preview-active");
const previewEmptyEl = previewPaneEl?.querySelector(".preview-empty");
const previewThumbBox = document.getElementById("preview-thumb-box");
const previewNameEl = document.getElementById("preview-name");
const previewPathEl = document.getElementById("preview-path");
const previewMetaList = document.getElementById("preview-meta-list");

let currentPreviewEntry = null;
const fileHexHashManager = createFileHexHashManager({
  send,
  notifyToast,
  getCurrentPreviewEntry: () => currentPreviewEntry,
  beforeFileRead: (path, operation) => confirmMacPermissionRisk(path, operation),
});
const {
  handleFileHashResult,
  handleFilePeekResult,
  openHexViewer,
  requestFileHash,
  requestFilePeek,
} = fileHexHashManager;

function setPreviewPaneVisible(visible) {
  if (!previewPaneHost) return;
  if (visible) {
    previewPaneHost.classList.remove("hidden");
    previewPaneShowBtnHost?.classList.add("hidden");
  } else {
    previewPaneHost.classList.add("hidden");
    previewPaneShowBtnHost?.classList.remove("hidden");
  }
  try { localStorage.setItem(PREVIEW_PANE_STATE_KEY, visible ? "1" : "0"); } catch {}
}

previewPaneToggle?.addEventListener("click", () => setPreviewPaneVisible(false));
previewPaneShowBtn?.addEventListener("click", () => setPreviewPaneVisible(true));
(function initPreviewPaneVisibility() {
  let saved = "1";
  try { saved = localStorage.getItem(PREVIEW_PANE_STATE_KEY) || "1"; } catch {}
  setPreviewPaneVisible(saved !== "0");
})();

function clearPreviewPane() {
  currentPreviewEntry = null;
  if (!previewPaneEl) return;
  previewPaneEl.classList.add("empty");
  previewActiveEl?.classList.add("hidden");
  if (previewThumbBox) previewThumbBox.innerHTML = "";
  if (previewMetaList) previewMetaList.innerHTML = "";
  fileHexHashManager.resetPreviewTextHead();
  fileHexHashManager.resetPreviewHash();
}

function renderPreviewMeta(entry) {
  if (!previewMetaList) return "";
  const ext = getFileExt(entry.name);
  const fields = [];
  fields.push(["Type", entry.isDir ? "Folder" : (ext ? ext.toUpperCase() : "File")]);
  if (!entry.isDir) fields.push(["Size", formatBytes(entry.size)]);
  fields.push(["Modified", new Date(entry.modTime * 1000).toLocaleString()]);
  if (entry.mode) fields.push(["Mode", entry.mode]);
  if (entry.owner) fields.push(["Owner", entry.owner]);
  previewMetaList.innerHTML = fields.map(([k, v]) =>
    `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`
  ).join("");
}

function showPreviewForEntry(entry) {
  if (!entry || !previewPaneEl || previewPaneHost?.classList.contains("hidden")) return;
  currentPreviewEntry = entry;
  previewPaneEl.classList.remove("empty");
  previewActiveEl?.classList.remove("hidden");
  if (previewNameEl) previewNameEl.textContent = entry.name || "";
  if (previewPathEl) previewPathEl.textContent = entry.path || "";
  renderPreviewMeta(entry);

  // Thumbnail / icon
  if (previewThumbBox) {
    previewThumbBox.innerHTML = "";
    const tKey = thumbCacheKey(entry);
    const cached = tKey ? thumbCache.get(tKey) : null;
    if (cached && cached.blobUrl) {
      const img = document.createElement("img");
      img.src = cached.blobUrl;
      previewThumbBox.appendChild(img);
    } else {
      const iconKey = iconCacheKey(entry);
      const iconEntry = iconKey ? iconCache.get(iconKey) : null;
      if (iconEntry && iconEntry.blobUrl) {
        const img = document.createElement("img");
        img.src = iconEntry.blobUrl;
        img.style.width = "64px";
        img.style.height = "64px";
        previewThumbBox.appendChild(img);
      } else {
        previewThumbBox.innerHTML = `<div class="text-4xl text-slate-500">${getFileIcon(entry)}</div>`;
      }
      if (tKey) requestThumbFor(entry);
    }
  }

  // Text head — only for likely-text files under 4KB peek window
  fileHexHashManager.resetPreviewTextHead();
  if (!entry.isDir) {
    const ext = getFileExt(entry.name);
    if (!KNOWN_BINARY_EXTS.has(ext) && !PREVIEW_IMAGE_EXTS.has(ext) && !PREVIEW_PDF_EXTS.has(ext)) {
      requestFilePeek(entry.path, "preview");
    }
  }

  fileHexHashManager.resetPreviewHash();
}

// ── Sidebar Quick Access ──
let detectedHomePath = "";
let detectedOS = "";
const sidebarContent = document.getElementById("sidebar-content");
const sidebarDrives = document.getElementById("sidebar-drives");
let lastDriveEntries = [];

function detectOSAndHome(path) {
  if (!path || path === ".") return;
  const winMatch = path.match(/^([A-Za-z]:\\Users\\[^\\]+)/i);
  if (winMatch) { detectedOS = "windows"; detectedHomePath = winMatch[1]; updateSidebar(); return; }
  if (path.match(/^[A-Za-z]:\\/)) { detectedOS = "windows"; updateSidebar(); return; }
  const macMatch = path.match(/^(\/Users\/[^\/]+)/);
  if (macMatch) { detectedOS = "mac"; detectedHomePath = macMatch[1]; updateSidebar(); return; }
  const linuxMatch = path.match(/^(\/home\/[^\/]+)/);
  if (linuxMatch) { detectedOS = "linux"; detectedHomePath = linuxMatch[1]; updateSidebar(); return; }
  if (path.startsWith("/root")) { detectedOS = "linux"; detectedHomePath = "/root"; updateSidebar(); return; }
  if (path.startsWith("/")) { detectedOS = "linux"; updateSidebar(); }
}

function applyClientInfo(osStr, userName) {
  if (detectedOS && detectedHomePath) return;
  const os = (osStr || "").toLowerCase();
  const user = (userName || "").trim();
  if (!user) return;
  if (os.includes("windows")) {
    detectedOS = "windows";
    detectedHomePath = "C:\\Users\\" + user;
  } else if (os.includes("darwin") || os.includes("mac")) {
    detectedOS = "mac";
    detectedHomePath = "/Users/" + user;
  } else {
    detectedOS = "linux";
    detectedHomePath = user === "root" ? "/root" : "/home/" + user;
  }
  updateSidebar();
  updateSidebarDrives(lastDriveEntries);
}

function sidebarItem(icon, label, path, color) {
  const active = currentPath && (currentPath === path || currentPath.startsWith(path + "/") || currentPath.startsWith(path + "\\"));
  const macPermissionRisk = macPermissionRiskForPath(path);
  const lockHtml = macPermissionRisk
    ? '<i class="fa-solid fa-lock text-amber-300 text-[10px] flex-shrink-0"></i>'
    : "";
  const titleAttr = macPermissionRisk
    ? ` title="macOS may ask the user to allow access to ${escapeHtml(macPermissionRisk.label)}"`
    : "";
  return `<button class="sidebar-item w-full flex items-center gap-3 px-3 py-1.5 rounded-md text-sm text-slate-300 hover:text-white transition-colors text-left${active ? " active" : ""}${macPermissionRisk ? " opacity-60" : ""}" data-path="${escapeHtml(path)}"${titleAttr}>
    <i class="fa-solid ${icon} ${color} w-4 text-center text-xs"></i>
    <span class="truncate">${label}</span>
    ${lockHtml}
  </button>`;
}

function updateSidebar() {
  if (!sidebarContent) return;
  let html = "";
  if (detectedOS === "windows" && detectedHomePath) {
    const h = detectedHomePath;
    html += sidebarItem("fa-desktop", "Desktop", h + "\\Desktop", "text-blue-400");
    html += sidebarItem("fa-download", "Downloads", h + "\\Downloads", "text-green-400");
    html += sidebarItem("fa-file-lines", "Documents", h + "\\Documents", "text-yellow-400");
    html += sidebarItem("fa-images", "Pictures", h + "\\Pictures", "text-purple-400");
    html += sidebarItem("fa-music", "Music", h + "\\Music", "text-pink-400");
    html += sidebarItem("fa-video", "Videos", h + "\\Videos", "text-red-400");
    html += '<div class="border-t border-slate-700/50 my-1.5"></div>';
    html += sidebarItem("fa-gear", "AppData", h + "\\AppData", "text-slate-400");
    html += sidebarItem("fa-temperature-high", "Temp", h + "\\AppData\\Local\\Temp", "text-orange-400");
    html += sidebarItem("fa-folder-open", "Program Files", "C:\\Program Files", "text-amber-400");
    html += sidebarItem("fa-window-maximize", "Windows", "C:\\Windows", "text-blue-300");
  } else if (detectedOS === "linux" || detectedOS === "mac") {
    if (detectedHomePath) {
      html += sidebarItem("fa-home", "Home", detectedHomePath, "text-blue-400");
      html += sidebarItem("fa-desktop", "Desktop", detectedHomePath + "/Desktop", "text-blue-300");
      html += sidebarItem("fa-download", "Downloads", detectedHomePath + "/Downloads", "text-green-400");
      html += sidebarItem("fa-file-lines", "Documents", detectedHomePath + "/Documents", "text-yellow-400");
      html += '<div class="border-t border-slate-700/50 my-1.5"></div>';
    }
    html += sidebarItem("fa-gears", "/etc", "/etc", "text-slate-400");
    html += sidebarItem("fa-database", "/var", "/var", "text-amber-400");
    html += sidebarItem("fa-temperature-high", "/tmp", "/tmp", "text-orange-400");
    html += sidebarItem("fa-cube", "/opt", "/opt", "text-teal-400");
    html += sidebarItem("fa-user", "/usr", "/usr", "text-indigo-400");
  } else {
    html = '<div class="text-xs text-slate-500 text-center py-3">Navigate to detect paths</div>';
  }
  sidebarContent.innerHTML = html;
  bindSidebarClicks(sidebarContent);
}

function driveItemHtml(e) {
  const label = e.name.match(/^[A-Za-z]:$/) ? e.name + "\\" : (e.name || e.path);
  const path = e.name.match(/^[A-Za-z]:$/) ? e.name + "\\" : e.path;
  const total = Number(e.totalBytes || 0);
  const free = Number(e.freeBytes || 0);
  let usageHtml = "";
  let titleAttr = "";
  if (total > 0) {
    const used = Math.max(0, total - free);
    const pct = Math.min(100, Math.round((used / total) * 100));
    const cls = pct >= 90 ? "crit" : pct >= 75 ? "warn" : "";
    usageHtml = `
      <div class="drive-usage-bar"><div class="drive-usage-fill ${cls}" style="width:${pct}%"></div></div>
      <div class="flex justify-between text-[10px] text-slate-500 mt-0.5">
        <span>${formatBytes(free)} free</span>
        <span>${formatBytes(total)}</span>
      </div>`;
    titleAttr = ` title="${escapeHtml(e.fsType || "")}${e.fsType ? " · " : ""}${formatBytes(free)} free of ${formatBytes(total)}"`;
  }
  return `
    <div class="sidebar-item w-full flex flex-col gap-0 px-3 py-1.5 rounded-md text-sm text-slate-300 hover:text-white transition-colors text-left" data-path="${escapeHtml(path)}"${titleAttr}>
      <div class="flex items-center gap-2 min-w-0">
        <i class="fa-solid fa-hard-drive text-slate-400 w-4 text-center text-xs"></i>
        <span class="truncate flex-1">${escapeHtml(label)}</span>
        ${e.fsType ? `<span class="text-[9px] text-slate-500 uppercase">${escapeHtml(e.fsType)}</span>` : ""}
      </div>
      ${usageHtml}
    </div>`;
}

function updateSidebarDrives(entries) {
  if (!sidebarDrives) return;
  if (!entries || entries.length === 0) {
    if (detectedOS === "windows") {
      sidebarDrives.innerHTML = sidebarItem("fa-hard-drive", "This PC", ".", "text-slate-300");
    } else {
      sidebarDrives.innerHTML = sidebarItem("fa-hard-drive", "Root /", "/", "text-slate-300");
    }
    bindSidebarClicks(sidebarDrives);
    return;
  }
  let html = "";
  entries.forEach((e) => {
    if (e.isDir && e.name.match(/^[A-Za-z]:$/)) {
      html += driveItemHtml(e);
    }
  });
  if (!html) {
    html = sidebarItem("fa-hard-drive", detectedOS === "windows" ? "This PC" : "Root /", detectedOS === "windows" ? "." : "/", "text-slate-300");
  }
  sidebarDrives.innerHTML = html;
  bindSidebarClicks(sidebarDrives);
}

function bindSidebarClicks(container) {
  container.querySelectorAll(".sidebar-item").forEach((btn) => {
    btn.onclick = () => listFiles(btn.dataset.path);
  });
}

function highlightSidebarActive() {
  document.querySelectorAll(".sidebar-item").forEach((btn) => {
    const p = btn.dataset.path;
    const active = currentPath && (currentPath === p || currentPath.startsWith(p + "/") || currentPath.startsWith(p + "\\"));
    btn.classList.toggle("active", active);
  });
}

updatePinnedSidebar();
checkFeatureAccess("file_browser", clientId).then(ok => ok && connect());

function removeTransfer(transferId) {
  transferPanelManager.removeTransfer(transferId);
  activeTransfers.delete(transferId);
}

function cancelTransfer(transferId) {
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
}
window.cancelTransfer = cancelTransfer;

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

    const searchIcon = getFileIcon({ isDir: false, name: fileName });

    row.innerHTML = `
      <div class="flex items-center gap-2">
        ${searchIcon}
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

    row.onclick = async () => {
      const resultName = result.path.split(/[\/\\]/).pop() || "";
      if (isPreviewable(resultName)) {
        await openFilePreview(result.path);
      } else {
        await openFileInEditor(result.path);
      }
    };

    fileListEl.appendChild(row);
  });
}

async function openFileInEditor(path) {
  if (!(await confirmMacPermissionRisk(path, "read file"))) return;
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

  markMacPermissionAllowed(msg.path);

  if (msg.isBinary) {
    notifyToast("Binary file — use Download to save it", "info", 3000);
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

filePreviewModalManager.bindControls();
fileHexHashManager.bindControls();

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

