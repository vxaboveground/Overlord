import { escapeHtml, formatBytes, getHighlightLanguage } from "./filebrowser-utils.js";

const KNOWN_HASHES_SHA256 = {
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855": "Empty file (0 bytes)",
};

function decodeTextHead(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

export function createFileHexHashManager({
  send,
  notifyToast,
  getCurrentPreviewEntry,
  beforeFileRead,
}) {
  const previewTextHeadHost = document.getElementById("preview-text-head-host");
  const previewTextHead = document.getElementById("preview-text-head");
  const previewHexBtn = document.getElementById("preview-hex-btn");
  const previewHashBtn = document.getElementById("preview-hash-btn");
  const previewHashResult = document.getElementById("preview-hash-result");
  const previewHashValue = document.getElementById("preview-hash-value");
  const previewHashKnown = document.getElementById("preview-hash-known");

  const hexViewerModal = document.getElementById("hex-viewer-modal");
  const hexViewerFile = document.getElementById("hex-viewer-file");
  const hexViewerBody = document.getElementById("hex-viewer-body");
  const hexViewerInfo = document.getElementById("hex-viewer-info");
  const hexViewerCloseBtn = document.getElementById("hex-viewer-close-btn");
  const hexViewerCopyBtn = document.getElementById("hex-viewer-copy-btn");

  const peekRequests = new Map();
  const hashRequests = new Map();
  let lastHexBytes = null;

  function resetPreviewTextHead() {
    previewTextHeadHost?.classList.add("hidden");
    if (previewTextHead) {
      previewTextHead.textContent = "";
      previewTextHead.className = "";
      delete previewTextHead.dataset.highlighted;
    }
  }

  function renderPreviewTextHead(text, fileName) {
    if (!previewTextHead) return;
    const requestedLanguage = getHighlightLanguage(fileName);
    const language = window.hljs?.getLanguage(requestedLanguage) ? requestedLanguage : "plaintext";
    previewTextHead.className = language === "plaintext" ? "hljs" : `language-${language}`;
    previewTextHead.textContent = text;
    delete previewTextHead.dataset.highlighted;
    if (window.hljs && language !== "plaintext") {
      window.hljs.highlightElement(previewTextHead);
    }
  }

  function resetPreviewHash() {
    previewHashResult?.classList.add("hidden");
    if (previewHashValue) previewHashValue.textContent = "";
    if (previewHashKnown) {
      previewHashKnown.classList.add("hidden");
      previewHashKnown.textContent = "";
    }
  }

  async function requestFilePeek(path, kind) {
    if (beforeFileRead && !(await beforeFileRead(path, kind === "hex" ? "read file bytes" : "preview file"))) {
      return false;
    }
    const commandId = `peek-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fileName = path.split(/[\/\\]/).pop() || "";
    peekRequests.set(commandId, { kind, path, fileName });
    send({
      type: "command",
      commandType: "file_peek",
      id: commandId,
      payload: { path, bytes: 4096 },
    });
    return true;
  }

  async function openHexViewer(path) {
    if (!hexViewerModal) return;
    if (beforeFileRead && !(await beforeFileRead(path, "read file bytes"))) {
      return;
    }
    const fileName = path.split(/[\/\\]/).pop() || "";
    if (hexViewerFile) hexViewerFile.textContent = fileName;
    if (hexViewerBody) hexViewerBody.innerHTML = '<div class="text-slate-400"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Loading...</div>';
    if (hexViewerInfo) hexViewerInfo.textContent = "";
    hexViewerModal.classList.add("show");
    requestFilePeek(path, "hex");
  }

  function closeHexViewer() {
    hexViewerModal?.classList.remove("show");
  }

  function renderHexDump(bytes, totalSize) {
    if (!hexViewerBody) return;
    const len = bytes.length;
    const rows = [];
    for (let off = 0; off < len; off += 16) {
      const chunk = bytes.slice(off, Math.min(off + 16, len));
      const hexParts = [];
      const asciiParts = [];
      for (let i = 0; i < 16; i++) {
        if (i < chunk.length) {
          hexParts.push(chunk[i].toString(16).padStart(2, "0"));
          const b = chunk[i];
          if (b >= 0x20 && b <= 0x7e) {
            asciiParts.push(`<span>${escapeHtml(String.fromCharCode(b))}</span>`);
          } else {
            asciiParts.push('<span class="np">.</span>');
          }
        } else {
          hexParts.push("  ");
          asciiParts.push(" ");
        }
        if (i === 7) hexParts.push("");
      }
      rows.push(
        `<div class="hex-row">` +
          `<span class="hex-off">${off.toString(16).padStart(8, "0")}</span>` +
          `<span class="hex-bytes">${hexParts.join(" ")}</span>` +
          `<span class="hex-ascii">${asciiParts.join("")}</span>` +
        `</div>`,
      );
    }
    hexViewerBody.innerHTML = rows.join("");
    if (hexViewerInfo) {
      const peekStr = `${formatBytes(len)} peek`;
      const totalStr = totalSize > 0 ? ` of ${formatBytes(totalSize)}` : "";
      hexViewerInfo.textContent = peekStr + totalStr;
    }
    lastHexBytes = bytes;
  }

  function handleFilePeekResult(msg) {
    const req = msg.commandId ? peekRequests.get(msg.commandId) : null;
    if (!req) return;
    peekRequests.delete(msg.commandId);

    const currentPreviewEntry = getCurrentPreviewEntry();
    if (msg.error) {
      if (req.kind === "hex") {
        if (hexViewerBody) hexViewerBody.innerHTML = `<div class="text-red-400 p-3"><i class="fa-solid fa-exclamation-triangle mr-2"></i>${escapeHtml(msg.error)}</div>`;
      }
      if (req.kind === "preview" && currentPreviewEntry && currentPreviewEntry.path === req.path) {
        previewTextHeadHost?.classList.add("hidden");
      }
      return;
    }

    let data = msg.data;
    if (!data) data = new Uint8Array(0);
    if (!(data instanceof Uint8Array)) {
      try { data = new Uint8Array(data); } catch { data = new Uint8Array(0); }
    }

    if (req.kind === "hex") {
      renderHexDump(data, Number(msg.size || 0));
      return;
    }

    if (!currentPreviewEntry || currentPreviewEntry.path !== req.path) return;
    if (!msg.isText || data.length === 0) {
      previewTextHeadHost?.classList.add("hidden");
      return;
    }
    const text = decodeTextHead(data);
    renderPreviewTextHead(text, req.fileName);
    previewTextHeadHost?.classList.remove("hidden");
  }

  async function requestFileHash(path, source) {
    if (beforeFileRead && !(await beforeFileRead(path, "read file"))) {
      return false;
    }
    const commandId = `hash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fileName = path.split(/[\/\\]/).pop() || "";
    hashRequests.set(commandId, { path, fileName, source });
    send({
      type: "command",
      commandType: "file_hash",
      id: commandId,
      payload: { path, algorithm: "sha256" },
    });
    notifyToast(`Hashing ${fileName}...`, "info", 2500);
    return true;
  }

  function handleFileHashResult(msg) {
    const req = msg.commandId ? hashRequests.get(msg.commandId) : null;
    if (!req) return;
    hashRequests.delete(msg.commandId);

    if (msg.error) {
      notifyToast(`Hash failed: ${msg.error}`, "error", 5000);
      return;
    }
    const digest = (msg.digest || "").toLowerCase();
    const known = KNOWN_HASHES_SHA256[digest];
    const currentPreviewEntry = getCurrentPreviewEntry();

    if (currentPreviewEntry && currentPreviewEntry.path === req.path && previewHashValue) {
      previewHashValue.textContent = digest;
      previewHashResult?.classList.remove("hidden");
      if (previewHashKnown) {
        if (known) {
          previewHashKnown.textContent = `Known: ${known}`;
          previewHashKnown.classList.remove("hidden");
        } else {
          previewHashKnown.classList.add("hidden");
        }
      }
    }

    const msgSuffix = known ? ` - matches known: ${known}` : "";
    notifyToast(`SHA-256: ${digest.slice(0, 16)}...${msgSuffix}`, "success", 6000);
    navigator.clipboard?.writeText(digest).catch(() => {});
  }

  function bindControls() {
    hexViewerCloseBtn?.addEventListener("click", closeHexViewer);
    hexViewerModal?.addEventListener("click", (e) => {
      if (e.target === hexViewerModal) closeHexViewer();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && hexViewerModal?.classList.contains("show")) {
        closeHexViewer();
      }
    });
    hexViewerCopyBtn?.addEventListener("click", async () => {
      if (!lastHexBytes) return;
      const hex = Array.from(lastHexBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
      try {
        await navigator.clipboard.writeText(hex);
        notifyToast("Hex copied to clipboard", "success", 2000);
      } catch {
        notifyToast("Clipboard copy failed", "error", 2500);
      }
    });

    previewHexBtn?.addEventListener("click", () => {
      const currentPreviewEntry = getCurrentPreviewEntry();
      if (currentPreviewEntry && !currentPreviewEntry.isDir) {
        openHexViewer(currentPreviewEntry.path);
      }
    });
    previewHashBtn?.addEventListener("click", () => {
      const currentPreviewEntry = getCurrentPreviewEntry();
      if (currentPreviewEntry && !currentPreviewEntry.isDir) {
        requestFileHash(currentPreviewEntry.path, "preview");
      }
    });
    previewHashValue?.addEventListener("click", async () => {
      const v = previewHashValue.textContent || "";
      if (!v) return;
      try {
        await navigator.clipboard.writeText(v);
        notifyToast("SHA-256 copied", "success", 1500);
      } catch {}
    });
  }

  return {
    bindControls,
    handleFileHashResult,
    handleFilePeekResult,
    openHexViewer,
    requestFileHash,
    requestFilePeek,
    resetPreviewHash,
    resetPreviewTextHead,
  };
}
