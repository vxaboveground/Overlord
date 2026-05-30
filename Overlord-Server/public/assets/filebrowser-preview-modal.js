import {
  PREVIEW_IMAGE_EXTS,
  PREVIEW_MAX_BYTES,
  escapeHtml,
  formatBytes,
  getFileExt,
  getPreviewMimeType,
} from "./filebrowser-utils.js";

export function createFilePreviewModal({
  clientId,
  notifyToast,
  onDownload,
}) {
  const filePreviewModal = document.getElementById("file-preview-modal");
  const previewFileNameEl = document.getElementById("preview-file-name");
  const previewContent = document.getElementById("preview-content");
  const previewCloseBtn = document.getElementById("preview-close-btn");
  const previewDownloadBtn = document.getElementById("preview-download-btn");
  const previewStatusEl = document.getElementById("preview-status");

  let currentPreviewBlobUrl = null;
  let currentPreviewPath = null;

  function closePreview() {
    if (filePreviewModal) filePreviewModal.classList.remove("show");
    if (currentPreviewBlobUrl) {
      URL.revokeObjectURL(currentPreviewBlobUrl);
      currentPreviewBlobUrl = null;
    }
    if (previewContent) previewContent.innerHTML = "";
    if (previewStatusEl) previewStatusEl.textContent = "";
    currentPreviewPath = null;
  }

  async function openFilePreview(path, knownSize) {
    const fileName = path.split(/[\/\\]/).pop() || "";
    const mimeType = getPreviewMimeType(fileName);
    if (!mimeType) return;

    if (typeof knownSize === "number" && knownSize > PREVIEW_MAX_BYTES) {
      notifyToast(`File too large to preview (${formatBytes(knownSize)})`, "info", 4000);
      return;
    }

    currentPreviewPath = path;
    if (previewFileNameEl) previewFileNameEl.textContent = fileName;
    if (previewContent) previewContent.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin text-slate-400 text-2xl"></i>';
    if (previewStatusEl) previewStatusEl.textContent = "Loading...";
    if (filePreviewModal) filePreviewModal.classList.add("show");

    try {
      const requestRes = await fetch("/api/file/download/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ clientId, path }),
      });

      if (!requestRes.ok) {
        const text = await requestRes.text();
        if (currentPreviewPath !== path) return;
        if (previewContent) previewContent.innerHTML = `<div class="text-red-400 text-sm text-center p-6"><i class="fa-solid fa-exclamation-triangle mr-2"></i>${escapeHtml(text || "Failed to load preview")}</div>`;
        if (previewStatusEl) previewStatusEl.textContent = "";
        return;
      }

      const requestData = await requestRes.json();
      const downloadUrl = typeof requestData?.downloadUrl === "string"
        ? requestData.downloadUrl
        : (requestData?.downloadId
          ? `/api/file/download/${encodeURIComponent(requestData.downloadId)}`
          : "");

      if (!downloadUrl) {
        if (currentPreviewPath !== path) return;
        if (previewContent) previewContent.innerHTML = `<div class="text-red-400 text-sm text-center p-6"><i class="fa-solid fa-exclamation-triangle mr-2"></i>Failed to load preview</div>`;
        if (previewStatusEl) previewStatusEl.textContent = "";
        return;
      }

      const res = await fetch(downloadUrl, {
        method: "GET",
        credentials: "include",
      });

      if (!res.ok) {
        const text = await res.text();
        if (currentPreviewPath !== path) return;
        if (previewContent) previewContent.innerHTML = `<div class="text-red-400 text-sm text-center p-6"><i class="fa-solid fa-exclamation-triangle mr-2"></i>${escapeHtml(text || "Failed to load preview")}</div>`;
        if (previewStatusEl) previewStatusEl.textContent = "";
        return;
      }

      const contentLength = Number(res.headers.get("Content-Length") || 0);
      if (contentLength > PREVIEW_MAX_BYTES) {
        if (currentPreviewPath !== path) return;
        if (previewContent) previewContent.innerHTML = `<div class="text-slate-400 text-sm text-center p-6"><i class="fa-solid fa-file mr-2"></i>File too large to preview (${escapeHtml(formatBytes(contentLength))})</div>`;
        if (previewStatusEl) previewStatusEl.textContent = "";
        return;
      }

      const arrayBuffer = await res.arrayBuffer();

      if (currentPreviewPath !== path) return;

      if (arrayBuffer.byteLength > PREVIEW_MAX_BYTES) {
        if (previewContent) previewContent.innerHTML = `<div class="text-slate-400 text-sm text-center p-6"><i class="fa-solid fa-file mr-2"></i>File too large to preview (${escapeHtml(formatBytes(arrayBuffer.byteLength))})</div>`;
        if (previewStatusEl) previewStatusEl.textContent = "";
        return;
      }

      if (currentPreviewBlobUrl) {
        URL.revokeObjectURL(currentPreviewBlobUrl);
        currentPreviewBlobUrl = null;
      }

      const blob = new Blob([arrayBuffer], { type: mimeType });
      currentPreviewBlobUrl = URL.createObjectURL(blob);

      if (previewContent) {
        previewContent.innerHTML = "";
        if (PREVIEW_IMAGE_EXTS.has(getFileExt(fileName))) {
          const img = document.createElement("img");
          img.src = currentPreviewBlobUrl;
          img.alt = "";
          previewContent.appendChild(img);
        } else {
          const obj = document.createElement("object");
          obj.data = currentPreviewBlobUrl;
          obj.type = "application/pdf";
          previewContent.appendChild(obj);
        }
      }

      if (previewStatusEl) previewStatusEl.textContent = "";
    } catch (err) {
      if (currentPreviewPath !== path) return;
      if (previewContent) previewContent.innerHTML = `<div class="text-red-400 text-sm text-center p-6"><i class="fa-solid fa-exclamation-triangle mr-2"></i>${escapeHtml(err.message || "Failed to load preview")}</div>`;
      if (previewStatusEl) previewStatusEl.textContent = "";
    }
  }

  function bindControls() {
    if (previewCloseBtn) previewCloseBtn.addEventListener("click", closePreview);
    if (previewDownloadBtn) previewDownloadBtn.addEventListener("click", () => {
      if (currentPreviewPath) onDownload(currentPreviewPath);
    });
    if (filePreviewModal) {
      filePreviewModal.addEventListener("click", (e) => {
        if (e.target === filePreviewModal) closePreview();
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && filePreviewModal && filePreviewModal.classList.contains("show")) {
        closePreview();
      }
    });
  }

  return {
    bindControls,
    closePreview,
    openFilePreview,
  };
}
