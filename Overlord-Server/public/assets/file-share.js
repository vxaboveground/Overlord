import { escapeHtml, formatBytes, timeAgo } from "./format.js";

const fileList = document.getElementById("file-list");
const uploadSection = document.getElementById("upload-section");
const uploadForm = document.getElementById("upload-form");
const uploadInfinite = document.getElementById("upload-infinite");
const uploadMaxDownloads = document.getElementById("upload-max-downloads");

let currentUser = null;

function getDownloadUrl(fileId) {
  return `${window.location.origin}/api/file-share/${fileId}/download`;
}

uploadInfinite?.addEventListener("change", () => {
  if (uploadInfinite.checked) {
    uploadMaxDownloads.value = "";
    uploadMaxDownloads.disabled = true;
  } else {
    uploadMaxDownloads.disabled = false;
    uploadMaxDownloads.focus();
  }
});
if (uploadMaxDownloads) uploadMaxDownloads.disabled = true;

async function loadCurrentUser() {
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) {
      window.location.href = "/";
      return;
    }
    currentUser = await res.json();
    if (currentUser.role === "viewer") {
      window.location.href = "/";
      return;
    }
  } catch {
    window.location.href = "/";
  }
}

async function loadFiles() {
  try {
    const res = await fetch("/api/file-share");
    if (!res.ok) {
      fileList.innerHTML = `<tr><td colspan="7" class="px-6 py-12 text-center text-red-400">Failed to load files</td></tr>`;
      return;
    }
    const data = await res.json();

    if (data.canUpload && uploadSection) {
      uploadSection.classList.remove("hidden");
    }

    if (!data.files || data.files.length === 0) {
      fileList.innerHTML = `<tr><td colspan="7" class="px-6 py-12 text-center text-slate-500">
        <i class="fa-solid fa-folder-open text-2xl mb-2 block"></i>No files shared yet
      </td></tr>`;
      return;
    }

    fileList.innerHTML = data.files
      .map((f) => {
        const isOwner = currentUser && f.uploadedBy === currentUser.userId;
        const isAdmin = currentUser && currentUser.role === "admin";
        const canManage = isOwner || isAdmin;

        const expired = f.expiresAt && f.expiresAt < Date.now();
        const limitReached = f.maxDownloads !== null && f.downloadCount >= f.maxDownloads;

        let statusBadges = "";
        if (f.hasPassword) {
          statusBadges += `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-900/30 text-amber-300 border border-amber-800"><i class="fa-solid fa-lock mr-1"></i>Password</span> `;
        }
        if (expired) {
          statusBadges += `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-900/30 text-red-300 border border-red-800"><i class="fa-solid fa-clock mr-1"></i>Expired</span> `;
        } else if (limitReached) {
          statusBadges += `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-900/30 text-red-300 border border-red-800"><i class="fa-solid fa-ban mr-1"></i>Limit Reached</span> `;
        } else if (f.expiresAt) {
          statusBadges += `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-900/30 text-blue-300 border border-blue-800" title="Expires ${new Date(f.expiresAt).toLocaleString()}"><i class="fa-solid fa-hourglass-half mr-1"></i>Timed</span> `;
        }
        if (!statusBadges) {
          statusBadges = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/30 text-green-300 border border-green-800"><i class="fa-solid fa-check mr-1"></i>Active</span>`;
        }

        const downloadStr = f.maxDownloads !== null
          ? `${f.downloadCount} / ${f.maxDownloads}`
          : `${f.downloadCount} / ∞`;

        return `
        <tr class="hover:bg-slate-800/30 transition-colors">
          <td class="px-6 py-4">
            <div class="flex items-center gap-2">
              <i class="fa-solid fa-file text-slate-400"></i>
              <div>
                <span class="font-medium text-slate-200 block">${escapeHtml(f.filename)}</span>
                ${f.description ? `<span class="text-xs text-slate-500">${escapeHtml(f.description)}</span>` : ""}
              </div>
            </div>
          </td>
          <td class="px-6 py-4 text-slate-400">${formatBytes(f.size)}</td>
          <td class="px-6 py-4 text-slate-400">${escapeHtml(f.uploadedByUsername)}</td>
          <td class="px-6 py-4 text-slate-400">${downloadStr}</td>
          <td class="px-6 py-4">${statusBadges}</td>
          <td class="px-6 py-4 text-slate-400" title="${new Date(f.createdAt).toLocaleString()}">${timeAgo(f.createdAt)}</td>
          <td class="px-6 py-4">
            <div class="flex items-center justify-end gap-2">
              <button class="action-btn px-2.5 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 transition-colors"
                data-controller="clipboard" data-action="clipboard#copy"
                data-clipboard-text-value="${getDownloadUrl(f.id)}"
                data-clipboard-success-message-value="Download link copied to clipboard!" title="Copy download link">
                <i class="fa-solid fa-link"></i>
              </button>
              ${canManage ? `
                <button class="action-btn px-2.5 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 transition-colors"
                  data-file-action="edit" data-file-id="${f.id}"
                  data-has-password="${f.hasPassword ? 1 : 0}"
                  data-max-downloads="${f.maxDownloads !== null ? f.maxDownloads : ''}"
                  data-expires-at="${f.expiresAt || ''}"
                  data-description="${escapeHtml(f.description || '')}"
                  title="Edit settings">
                  <i class="fa-solid fa-pen-to-square"></i>
                </button>
                <button class="action-btn px-2.5 py-1.5 text-sm bg-red-900/40 hover:bg-red-800/60 text-red-200 rounded border border-red-700/60 transition-colors"
                  data-controller="confirm" data-action="confirm#confirm"
                  data-confirm-message-value="Delete this file? This cannot be undone."
                  data-file-action="delete" data-file-id="${f.id}" title="Delete file">
                  <i class="fa-solid fa-trash"></i>
                </button>
              ` : ""}
            </div>
          </td>
        </tr>`;
      })
      .join("");

  } catch (err) {
    console.error("Load files error:", err);
    fileList.innerHTML = `<tr><td colspan="7" class="px-6 py-12 text-center text-red-400">Failed to load files</td></tr>`;
  }
}

fileList?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-file-action]");
  if (!btn) return;

  if (btn.dataset.fileAction === "edit") openEditModal(btn);
  if (btn.dataset.fileAction === "delete") deleteFile(btn.dataset.fileId);
});

async function deleteFile(fileId) {
  try {
    const res = await fetch(`/api/file-share/${fileId}`, { method: "DELETE" });
    if (res.ok) {
      if (window.showToast) window.showToast("File deleted", "success");
      loadFiles();
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to delete file");
    }
  } catch (err) {
    console.error("Delete error:", err);
    alert("Network error. Please try again.");
  }
}

const editModal = document.getElementById("edit-modal");
const editFileId = document.getElementById("edit-file-id");
const editPassword = document.getElementById("edit-password");
const editMaxDownloads = document.getElementById("edit-max-downloads");
const editInfinite = document.getElementById("edit-infinite");
const editExpiry = document.getElementById("edit-expiry");
const editDescription = document.getElementById("edit-description");

function openEditModal(btn) {
  editFileId.value = btn.dataset.fileId;
  editPassword.value = "";
  editDescription.value = btn.dataset.description || "";

  const maxDl = btn.dataset.maxDownloads;
  if (maxDl === "" || maxDl === "null") {
    editInfinite.checked = true;
    editMaxDownloads.value = "";
    editMaxDownloads.disabled = true;
  } else {
    editInfinite.checked = false;
    editMaxDownloads.value = maxDl;
    editMaxDownloads.disabled = false;
  }

  const expiresAt = btn.dataset.expiresAt;
  if (expiresAt && expiresAt !== "null" && expiresAt !== "") {
    const d = new Date(parseInt(expiresAt));
    editExpiry.value = d.toISOString().slice(0, 16);
  } else {
    editExpiry.value = "";
  }

  editModal.classList.remove("hidden");
}

editInfinite?.addEventListener("change", () => {
  if (editInfinite.checked) {
    editMaxDownloads.value = "";
    editMaxDownloads.disabled = true;
  } else {
    editMaxDownloads.disabled = false;
    editMaxDownloads.focus();
  }
});

document.getElementById("edit-cancel")?.addEventListener("click", () => {
  editModal.classList.add("hidden");
});

editModal?.addEventListener("click", (e) => {
  if (e.target === editModal) editModal.classList.add("hidden");
});

document.getElementById("edit-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fileId = editFileId.value;
  const body = {};

  const pw = editPassword.value;
  if (pw !== "") {
    body.password = pw;
  }

  if (editInfinite.checked) {
    body.maxDownloads = null;
  } else {
    const val = parseInt(editMaxDownloads.value, 10);
    if (!isNaN(val) && val > 0) {
      body.maxDownloads = val;
    }
  }

  if (editExpiry.value) {
    body.expiresAt = new Date(editExpiry.value).getTime();
  } else {
    body.expiresAt = null;
  }

  body.description = editDescription.value || null;

  try {
    const res = await fetch(`/api/file-share/${fileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      editModal.classList.add("hidden");
      if (window.showToast) window.showToast("Settings updated", "success");
      loadFiles();
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to update");
    }
  } catch (err) {
    console.error("Edit error:", err);
    alert("Network error. Please try again.");
  }
});

uploadForm?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const fileInput = document.getElementById("upload-file");
  const file = fileInput.files[0];
  if (!file) return;

  const btn = document.getElementById("upload-btn");
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Uploading...';

  const formData = new FormData();
  formData.append("file", file);

  const password = document.getElementById("upload-password").value;
  if (password) formData.append("password", password);

  if (!uploadInfinite.checked) {
    const maxDl = uploadMaxDownloads.value;
    if (maxDl) formData.append("maxDownloads", maxDl);
  }

  const expiry = document.getElementById("upload-expiry").value;
  if (expiry) {
    formData.append("expiresAt", String(new Date(expiry).getTime()));
  }

  const description = document.getElementById("upload-description").value;
  if (description) formData.append("description", description);

  try {
    const res = await fetch("/api/file-share/upload", {
      method: "POST",
      body: formData,
    });

    const data = await res.json();

    if (res.ok) {
      if (window.showToast) window.showToast(`"${data.filename}" uploaded successfully!`, "success");
      uploadForm.reset();
      uploadInfinite.checked = true;
      uploadMaxDownloads.disabled = true;
      loadFiles();
    } else {
      alert(data.error || "Upload failed");
    }
  } catch (err) {
    console.error("Upload error:", err);
    alert("Network error. Please try again.");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-upload"></i> Upload';
  }
});

(async () => {
  await loadCurrentUser();
  await loadFiles();
})();
