// ── Client Panel Page ─────────────────────────────────────────────────────────
// Shows detailed system information for a single client.

const clientId = window.location.pathname.split("/")[1];
if (!clientId) {
  window.location.href = "/";
}

// ── Utility helpers ──────────────────────────────────────────────────────────
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function isMicrosoft(str) {
  if (!str) return false;
  str = str.toLowerCase();
  return str.includes('microsoft') || str.includes('windows\\system32') || str.includes('windows defender');
}

function countryToFlag(code) {
  if (!code || code === "ZZ") return '<span class="fi fi-xx"></span>';
  return `<span class="fi fi-${code.toLowerCase()}"></span>`;
}

function formatAgo(ts) {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatPing(ms) {
  if (ms == null || ms < 0) return "-- ms";
  return `${Math.round(ms)} ms`;
}

function shortId(id) {
  if (!id) return "????????";
  return id.length > 8 ? id.substring(0, 8) : id;
}

function infoSection(title, icon, items, suffixBadge = "") {
  return `
    <div class="info-section bg-slate-900 border border-white/5 rounded-xl overflow-hidden shadow-lg hover:border-slate-600/50 transition-colors h-full flex flex-col min-w-0">
      <div class="info-section-title flex items-center gap-2 px-4 py-3 bg-slate-800/80 border-b border-white/5 text-slate-200 font-semibold text-sm">
        <i class="${icon} text-blue-400 w-4 text-center"></i>
        <span>${escapeHtml(title)}</span> ${suffixBadge}
      </div>
      <div class="info-section-body flex-1 overflow-y-auto max-h-[300px] p-4 custom-scrollbar space-y-2">
        ${items.map(item => `
          <div class="info-row flex items-start justify-between px-3 py-2 gap-4 bg-slate-950/50 hover:bg-slate-800/80 border border-white/5 rounded transition-colors group min-w-0 ${item.classes || ''}" ${item.attrs || ''}>
            <span class="info-row-label text-xs text-slate-400 whitespace-nowrap min-w-[100px] flex-shrink-0 group-hover:text-slate-300 transition-colors truncate min-w-0" title="${escapeHtml(item.label.replace(/<[^>]*>?/gm, ''))}">${item.label}</span>
            <span class="info-row-value text-xs text-slate-200 text-right truncate min-w-0" title="${escapeHtml(item.value.replace(/<[^>]*>?/gm, ''))}">${item.value}</span>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function verboseInfoSection(title, icon, items, suffixBadge = "") {
  return `
    <div class="info-section bg-slate-900 border border-white/5 rounded-xl overflow-hidden shadow-lg hover:border-slate-600/50 transition-colors h-full flex flex-col min-w-0">
      <div class="info-section-title flex items-center gap-2 px-4 py-3 bg-slate-800/80 border-b border-white/5 text-slate-200 font-semibold text-sm">
        <i class="${icon} text-purple-400 w-4 text-center"></i>
        <span>${escapeHtml(title)}</span> ${suffixBadge}
      </div>
      <div class="info-section-body flex-1 overflow-y-auto max-h-[350px] p-4 custom-scrollbar space-y-3">
        ${items.map(item => `
          <div class="flex flex-col px-3 py-2 bg-slate-950/50 hover:bg-slate-800/80 border border-white/5 rounded transition-colors group min-w-0">
            <div class="text-xs font-bold text-slate-200 group-hover:text-white transition-colors truncate min-w-0" title="${escapeHtml(item.top)}">${escapeHtml(item.top)}</div>
            <div class="text-[10px] text-slate-400 font-mono mt-1.5 leading-relaxed whitespace-pre-wrap break-words">${item.bottom}</div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function tableSection(title, icon, headers, rows, suffixBadge = "") {
  return `
    <div class="info-section bg-slate-900 border border-white/5 rounded-xl overflow-hidden shadow-lg hover:border-slate-600/50 transition-colors h-full flex flex-col min-w-0">
      <div class="info-section-title flex items-center gap-2 px-4 py-3 bg-slate-800/80 border-b border-white/5 text-slate-200 font-semibold text-sm">
        <i class="${icon} text-emerald-400 w-4 text-center"></i>
        <span>${escapeHtml(title)}</span> ${suffixBadge}
      </div>
      <div class="info-section-body flex-1 overflow-x-auto p-4 custom-scrollbar">
        <table class="w-full text-left border-collapse min-w-0">
          <thead>
            <tr class="border-b border-white/5 text-slate-400 text-[10px] uppercase tracking-wider">
              ${headers.map(h => `<th class="px-2 py-2 font-bold">${escapeHtml(h)}</th>`).join('')}
            </tr>
          </thead>
          <tbody class="text-xs text-slate-200 divide-y divide-white/5">
            ${rows.map(row => `
              <tr class="hover:bg-slate-800/30 transition-colors">
                ${row.map(cell => `<td class="px-2 py-2 truncate max-w-[150px]" title="${escapeHtml(String(cell).replace(/<[^>]*>?/gm, ''))}">${cell}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ── Load client data ─────────────────────────────────────────────────────────
async function loadClientInfo() {
  try {
    const res = await fetch(`/api/clients/${clientId}/info`, { credentials: "include" });
    if (!res.ok) {
      document.getElementById("panel-title").textContent = "Client Not Found";
      document.getElementById("panel-subtitle").textContent = `Could not find client ${clientId}`;
      return;
    }
    const data = await res.json();
    window.__clientData = data;
    renderPanel(data);
  } catch (err) {
    console.error("Failed to load client info:", err);
    document.getElementById("panel-title").textContent = "Error";
    document.getElementById("panel-subtitle").textContent = "Failed to load client information";
  }
}

function renderPanel(client) {
  // Title & subtitle
  const nickname = client.nickname || client.host || shortId(client.id);
  document.getElementById("panel-title").textContent = nickname;
  document.getElementById("panel-subtitle").textContent = `${client.id} • ${client.user || "unknown"}@${client.host || "unknown"}`;

  // Country flag
  document.getElementById("panel-country-flag").innerHTML = countryToFlag(client.country);

  // Status pill
  const statusPill = document.getElementById("panel-status-pill");
  if (client.online) {
    statusPill.className = "pill pill-online";
    statusPill.innerHTML = '<i class="fa-solid fa-circle"></i> Online';
  } else {
    statusPill.className = "pill pill-offline";
    statusPill.innerHTML = '<i class="fa-solid fa-circle"></i> Offline';
  }

  // Ping pill
  document.getElementById("panel-ping-pill").innerHTML =
    `<i class="fa-solid fa-satellite-dish"></i> ${formatPing(client.pingMs)}`;

  // Quick info sidebar
  renderQuickInfo(client);

  // Preview thumbnail
  renderPreview(client);

  // Init charts
  initCharts();

  // Init modal logic
  initModalLogic();

  // Copy IP listener
  const copyBtn = document.getElementById("copy-ip-btn");
  if (copyBtn) {
    copyBtn.onclick = () => {
      const ip = client.publicIp || client.ip || "";
      navigator.clipboard.writeText(ip);
      const span = document.getElementById("copy-ip-text");
      if (span) {
        span.textContent = "Copied!";
        setTimeout(() => span.textContent = "Copy IP", 2000);
      }
    };
  }

  // Main info grid
  renderInfoGrid(client);

  // Start resource polling if online
  if (client.online) {
    startResourcePolling();
  } else {
    stopResourcePolling();
    resetGauges();
  }
}

function initModalLogic() {
  const modal = document.getElementById('forensic-modal');
  const modalBox = document.getElementById('forensic-modal-box');
  const closeBtn = document.getElementById('forensic-modal-close');
  
  if (!modal || !closeBtn) return;

  closeBtn.onclick = () => {
    modal.classList.add('opacity-0', 'pointer-events-none');
    modalBox.classList.add('scale-95');
    modalBox.classList.remove('scale-100');
  };

  // Close on backdrop click (optional but good UX)
  modal.onclick = (e) => {
    if (e.target === modal) {
      closeBtn.onclick();
    }
  };

  // Ensure window-level listener exists for dynamically inserted data-forensic items
  document.addEventListener('click', (e) => {
    const forensicRow = e.target.closest('[data-forensic]');
    if (forensicRow && modal) {
      const artifactType = forensicRow.getAttribute('data-forensic');
      openForensicModal(artifactType);
    }
  });
}

function openForensicModal(type) {
  const modal = document.getElementById('forensic-modal');
  const modalBox = document.getElementById('forensic-modal-box');
  const title = document.getElementById('forensic-modal-title');
  const content = document.getElementById('forensic-modal-content');

  const data = window.__forensicData || {};

  if (type === 'ps_history') {
    title.textContent = 'Console / Shell History Log';
    content.textContent = data.ps_history && data.ps_history.trim() !== "" ? data.ps_history : 'No shell history records discovered on host.';
  } else if (type === 'run_mru') {
    title.textContent = 'RunMRU Cached Commands';
    content.textContent = data.run_mru && data.run_mru.trim() !== "" ? data.run_mru : 'No RunMRU commands logged.';
  } else {
    title.textContent = 'Unknown Artifact';
    content.textContent = 'No data payload mapped.';
  }

  modal.classList.remove('opacity-0', 'pointer-events-none');
  modalBox.classList.remove('scale-95');
  modalBox.classList.add('scale-100');
}

function renderQuickInfo(client) {
  const container = document.getElementById("panel-quick-info");
  const os = client.os || "unknown";
  const osIcon = os.includes("windows") ? "fa-brands fa-windows" :
                 os.includes("linux") ? "fa-brands fa-linux" :
                 os.includes("darwin") ? "fa-brands fa-apple" : "fa-solid fa-desktop";

  container.innerHTML = `
    <div class="quick-info-item">
      <span class="quick-info-label">OS</span>
      <span class="quick-info-value"><i class="${osIcon}"></i> ${escapeHtml(os)}</span>
    </div>
    <div class="quick-info-item">
      <span class="quick-info-label">Arch</span>
      <span class="quick-info-value">${escapeHtml(client.arch || "unknown")}</span>
    </div>
    <div class="quick-info-item">
      <span class="quick-info-label">Version</span>
      <span class="quick-info-value">${escapeHtml(client.version || "unknown")}</span>
    </div>
    <div class="quick-info-item">
      <span class="quick-info-label">User</span>
      <span class="quick-info-value">${escapeHtml(client.user || "unknown")}</span>
    </div>
    <div class="quick-info-item">
      <span class="quick-info-label">Last Seen</span>
      <span class="quick-info-value">${formatAgo(client.lastSeen)}</span>
    </div>
    ${client.groupName ? `
    <div class="quick-info-item">
      <span class="quick-info-label">Group</span>
      <span class="quick-info-value" style="color:${escapeHtml(client.groupColor || '#94a3b8')}">${escapeHtml(client.groupName)}</span>
    </div>` : ""}
  `;
}

function renderPreview(client) {
  const preview = document.getElementById("panel-preview");
  if (client.thumbnail) {
    preview.innerHTML = `<img src="${escapeHtml(client.thumbnail)}" alt="preview" class="panel-preview-img" />`;
  } else {
    preview.innerHTML = `
      <div class="panel-preview-placeholder">
        <i class="fa-solid fa-desktop"></i>
      </div>
    `;
  }
}

function renderInfoGrid(client) {
  const grid = document.getElementById("panel-info-grid");
  const items = [];

  // ── Network ──────────────────────────────────────────────────────────────
  items.push(infoSection("Network", "fa-solid fa-network-wired", [
    { label: "Public IP", value: client.publicIp ? `<code>${escapeHtml(client.publicIp)}</code>` : '<span class="text-slate-500">Unknown</span>' },
    { label: "Local IP", value: client.ip ? `<code>${escapeHtml(client.ip)}</code>` : '<span class="text-slate-500">Unknown</span>' },
    { label: "Country", value: `${countryToFlag(client.country)} ${escapeHtml(client.country || "ZZ")}` },
    { label: "ASN", value: client.asn ? `<code>${escapeHtml(client.asn)}</code>` : '<span class="text-slate-500">Unknown</span>' },
    { label: "ISP", value: client.isp ? escapeHtml(client.isp) : '<span class="text-slate-500">Unknown</span>' },
  ]));

  // ── System ───────────────────────────────────────────────────────────────
  items.push(infoSection("System", "fa-solid fa-computer", [
    { label: "Hostname", value: `<code>${escapeHtml(client.host || "unknown")}</code>` },
    { label: "Username", value: `<code>${escapeHtml(client.user || "unknown")}</code>` },
    { label: "CPU", value: client.cpu ? escapeHtml(client.cpu) : '<span class="text-slate-500">Unknown</span>' },
    { label: "GPU", value: client.gpu ? escapeHtml(client.gpu) : '<span class="text-slate-500">Unknown</span>' },
    { label: "RAM", value: client.ram ? escapeHtml(client.ram) : '<span class="text-slate-500">Unknown</span>' },
    { label: "HWID", value: `<code class="text-xs">${escapeHtml(shortId(client.hwid || "unknown"))}</code>` },
    { label: "Admin", value: client.isAdmin ? '<span class="pill pill-admin"><i class="fa-solid fa-shield-halved"></i> Yes</span>' : '<span class="text-slate-500">No</span>' },
    { label: "Elevation", value: client.elevation ? `<span class="pill pill-ghost">${escapeHtml(client.elevation)}</span>` : '<span class="text-slate-500">Unknown</span>' },
  ]));

  // ── Antivirus Products ───────────────────────────────────────────────────
  const avItems = [];
  if (client.antivirus) {
    avItems.push({ label: "Primary AV", value: escapeHtml(client.antivirus) });
  } else if (window.__lastData && window.__lastData.antivirus_products && window.__lastData.antivirus_products.length > 0) {
    window.__lastData.antivirus_products.forEach((av, i) => {
       avItems.push({ label: `Detected Engine ${i+1}`, value: escapeHtml(av) });
    });
  } else {
    avItems.push({ label: "Status", value: '<span class="text-slate-500 italic">Scanning...</span>' });
  }
  items.push(`<div id="av-widget-container" class="h-full min-w-0">${infoSection("Antivirus Products", "fa-solid fa-shield-virus", avItems)}</div>`);

  // ── Security ─────────────────────────────────────────────────────────────
  const securityItems = [];
  if (client.firewall !== undefined) {
    securityItems.push({ label: "Firewall", value: client.firewall ? '<span class="text-emerald-400"><i class="fa-solid fa-shield-halved"></i> Enabled</span>' : '<span class="text-red-400"><i class="fa-solid fa-shield-halved"></i> Disabled</span>' });
  }
  if (client.defender !== undefined) {
    securityItems.push({ label: "Windows Defender", value: client.defender ? '<span class="text-emerald-400"><i class="fa-solid fa-shield-halved"></i> Enabled</span>' : '<span class="text-red-400"><i class="fa-solid fa-shield-halved"></i> Disabled</span>' });
  }
  if (client.uac !== undefined) {
    securityItems.push({ label: "UAC", value: client.uac ? '<span class="text-emerald-400">Enabled</span>' : '<span class="text-red-400">Disabled</span>' });
  }
  if (client.defaultBrowser) {
    securityItems.push({ label: "Default Browser", value: escapeHtml(client.defaultBrowser) });
  }
  if (securityItems.length > 0) {
    items.push(infoSection("Security", "fa-solid fa-shield-halved", securityItems));
  }


  // ── Local Users ──────────────────────────────────────────────────────────
  if (client.localUsers && client.localUsers.length > 0) {
    items.push(infoSection("Local Users", "fa-solid fa-users",
      client.localUsers.map(u => ({
        label: escapeHtml(u.name),
        value: `<span class="text-xs">${escapeHtml(u.admin ? "Admin" : "Standard")}${u.loggedIn ? ' • <span class="text-emerald-400">Logged In</span>' : ''}</span>`
      }))
    ));
  }

  // ── Startup Items ────────────────────────────────────────────────────────
  if (client.startupItems && client.startupItems.length > 0) {
    items.push(infoSection("Startup Items", "fa-solid fa-power-off",
      client.startupItems.map(s => ({
        label: escapeHtml(s.name),
        value: `<span class="text-xs">${escapeHtml(s.type)} • ${escapeHtml(s.path || "")}</span>`
      }))
    ));
  }

  grid.innerHTML = items.join("");
}

// ── Resource usage polling & Charts ─────────────────────────────────────────
let resourceInterval = null;
let resourceFetching = false;

let cpuChart = null;
let ramChart = null;
const chartDataLength = 60;

function initCharts() {
  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400, easing: 'linear' },
    scales: {
      x: { display: false },
      y: { min: 0, max: 100, display: true, beginAtZero: true, grid: { color: 'rgba(51, 65, 85, 0.3)' }, border: { dash: [4, 4] }, ticks: { color: '#64748b', stepSize: 25 } }
    },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    elements: { point: { radius: 0 }, line: { tension: 0.4, borderWidth: 2 } },
    interaction: { mode: 'index', intersect: false }
  };

  const cpuCtx = document.getElementById('cpu-chart');
  if (cpuCtx && !cpuChart) {
    cpuChart = new Chart(cpuCtx, {
      type: 'line',
      data: { labels: Array(chartDataLength).fill(''), datasets: [{ data: Array(chartDataLength).fill(0), borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.15)', fill: true }] },
      options: commonOptions
    });
  }

  const ramCtx = document.getElementById('ram-chart');
  if (ramCtx && !ramChart) {
    ramChart = new Chart(ramCtx, {
      type: 'line',
      data: { labels: Array(chartDataLength).fill(''), datasets: [{ data: Array(chartDataLength).fill(0), borderColor: '#a855f7', backgroundColor: 'rgba(168, 85, 247, 0.15)', fill: true }] },
      options: commonOptions
    });
  }
}

function startResourcePolling() {
  if (resourceInterval) return;
  fetchResourceUsage(); // immediate first call
  resourceInterval = setInterval(fetchResourceUsage, 7000);
}

function stopResourcePolling() {
  if (resourceInterval) {
    clearInterval(resourceInterval);
    resourceInterval = null;
  }
}

function resetGauges() {
  ["cpu", "ram", "disk"].forEach(key => {
    const valEl = document.getElementById(`gauge-${key}`);
    const barEl = document.getElementById(`gauge-${key}-bar`);
    if (valEl) valEl.textContent = "--%";
    if (barEl) {
      barEl.style.width = "0%";
      barEl.className = "gauge-bar-fill";
    }
  });
  const ramDetail = document.getElementById("gauge-ram-detail");
  const diskDetail = document.getElementById("gauge-disk-detail");
  if (ramDetail) ramDetail.textContent = "";
  if (diskDetail) diskDetail.textContent = "";
}

async function fetchResourceUsage() {
  if (resourceFetching) return;
  resourceFetching = true;
  try {
    // Save scroll positions using a more robust approach - map by section title text
    const scrollPositions = new Map();
    const regionContainers = document.querySelectorAll('.extended-region-grid');
    regionContainers.forEach(grid => {
      grid.querySelectorAll('.info-section-body').forEach(body => {
        const section = body.closest('.info-section');
        if (section) {
          const title = section.querySelector('.info-section-title span');
          if (title) {
            scrollPositions.set(title.textContent, body.scrollTop);
          }
        }
      });
    });

    const res = await fetch(`/api/clients/${clientId}/resource-usage`, {
      method: "GET",
      credentials: "include",
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data && !data.error) {
      updateGauges(data);
      // Restore scroll positions after DOM update
      setTimeout(() => {
        scrollPositions.forEach((scrollTop, titleText) => {
          // Find the section by title text
          const allSections = document.querySelectorAll('.extended-region-grid .info-section');
          allSections.forEach(section => {
            const title = section.querySelector('.info-section-title span');
            if (title && title.textContent === titleText) {
              const body = section.querySelector('.info-section-body');
              if (body) {
                body.scrollTop = scrollTop;
              }
            }
          });
        });
      }, 100);
    }
  } catch (err) {
    console.error("Failed to fetch resource usage:", err);
  } finally {
    resourceFetching = false;
  }
}

function updateGauges(data) {
  window.__clientData = { ...(window.__clientData || {}), ...data };
  const mergedData = window.__clientData;

  const cpu = mergedData.cpu_usage ?? 0;
  const ram = mergedData.ram_usage ?? 0;
  const disk = mergedData.disk_usage ?? 0;

  // CPU
  const cpuEl = document.getElementById("gauge-cpu");
  if(cpuEl) cpuEl.textContent = `${Math.round(cpu)}%`;
  if (cpuChart) {
    cpuChart.data.datasets[0].data.shift();
    cpuChart.data.datasets[0].data.push(cpu);
    cpuChart.update();
  }

  // RAM
  const ramEl = document.getElementById("gauge-ram");
  if(ramEl) ramEl.textContent = `${Math.round(ram)}%`;
  if (data.ram_used && data.ram_total) {
    const ramDet = document.getElementById("gauge-ram-detail");
    if(ramDet) ramDet.textContent = `${data.ram_used} / ${data.ram_total}`;
  }
  if (ramChart) {
    ramChart.data.datasets[0].data.shift();
    ramChart.data.datasets[0].data.push(ram);
    ramChart.update();
  }

  // Disk
  const diskEl = document.getElementById("gauge-disk");
  if(diskEl) diskEl.textContent = `${Math.round(disk)}%`;
  const diskBar = document.getElementById("gauge-disk-bar");
  if (diskBar) {
    diskBar.style.width = `${disk}%`;
    diskBar.className = `h-full rounded-full transition-all duration-500 ${disk >= 90 ? 'bg-red-500' : disk >= 75 ? 'bg-orange-500' : 'bg-amber-500'}`;
  }
  if (mergedData.disk_used && mergedData.disk_total) {
    const diskDet = document.getElementById("gauge-disk-detail");
    if(diskDet) diskDet.textContent = `${mergedData.disk_used} / ${mergedData.disk_total}`;
  }

  // Update AV Widget dynamically
  const avContainer = document.getElementById("av-widget-container");
  if (avContainer && mergedData.antivirus_products) {
    if (mergedData.antivirus_products.length > 0) {
      const avList = mergedData.antivirus_products.map(av => ({
        label: escapeHtml(av),
        value: '<span class="text-emerald-400 font-bold bg-emerald-900/40 px-2 py-0.5 rounded border border-emerald-800/50">Detected</span>'
      }));
      avContainer.innerHTML = infoSection("Antivirus Products", "fa-solid fa-shield-virus", avList);
    }
  }

  // Extended info sections
  renderExtendedInfo(mergedData);
}

function renderExtendedInfo(data) {
  window.__lastData = data;
  const container = document.getElementById("panel-extended-info");
  if (!container) return;

  // ── Persistence Region ─────────────────────────────────────────────────
  const persistenceSections = [];
  const msBadge = '<span class="bg-purple-900/50 text-purple-300 text-[9px] px-1.5 py-0.5 rounded ml-2 border border-purple-800/50 uppercase tracking-wider font-bold">MS Hidden</span>';

  if (data.scheduled_tasks && data.scheduled_tasks.length > 0) {
    const origCount = data.scheduled_tasks.length;
    let filtered = data.scheduled_tasks.filter(t => !isMicrosoft(t.name) && !isMicrosoft(t.command));
    let badge = origCount !== filtered.length ? msBadge : "";
    if (filtered.length > 0 || origCount > 0) {
      if (filtered.length === 0) filtered = [{name: "All filtered", command: "No non-Microsoft entries", state: "-", next_run: "-"}];
      persistenceSections.push(verboseInfoSection(
        `Scheduled Tasks (${filtered.length})`,
        "fa-solid fa-clock",
        filtered.slice(0, 20).map(t => ({
          top: t.name || "",
          bottom: t.command === "No non-Microsoft entries" ? `<span class="text-xs text-slate-500">None</span>` : `State: <span class="text-slate-300">${escapeHtml(t.state || "")}</span> | Next Run: <span class="text-slate-300">${escapeHtml(t.next_run || "—")}</span>\nCommand: <span class="text-emerald-300">${escapeHtml(t.command || "")}</span>`
        })),
        badge
      ));
    }
  }

  if (data.registry_persistence && data.registry_persistence.length > 0) {
    const origCount = data.registry_persistence.length;
    let filtered = data.registry_persistence.filter(r => !isMicrosoft(r.name) && !isMicrosoft(r.value));
    let badge = origCount !== filtered.length ? msBadge : "";
    if (filtered.length > 0 || origCount > 0) {
      if (filtered.length === 0) filtered = [{key: "All filtered", value: "No non-Microsoft entries", name: "-"}];
      persistenceSections.push(verboseInfoSection(
        `Registry Persistence (${filtered.length})`,
        "fa-solid fa-database",
        filtered.slice(0, 20).map(r => ({
          top: r.key || r.name || "",
          bottom: r.value === "No non-Microsoft entries" ? `<span class="text-xs text-slate-500">None</span>` : `Name: <span class="text-slate-300">${escapeHtml(r.name || "")}</span>\nTarget: <span class="text-emerald-300">${escapeHtml(r.value || "")}</span>`
        })),
        badge
      ));
    }
  }

  if (data.startup_programs && data.startup_programs.length > 0) {
    const origCount = data.startup_programs.length;
    let filtered = data.startup_programs.filter(s => !isMicrosoft(s.name) && !isMicrosoft(s.path));
    let badge = origCount !== filtered.length ? msBadge : "";
    if (filtered.length > 0 || origCount > 0) {
      if (filtered.length === 0) filtered = [{name: "All filtered", path: "No non-Microsoft entries", location: "-"}];
      persistenceSections.push(verboseInfoSection(
        `Startup Programs (${filtered.length})`,
        "fa-solid fa-power-off",
        filtered.slice(0, 20).map(s => ({
          top: s.name || "",
          bottom: s.path === "No non-Microsoft entries" ? `<span class="text-xs text-slate-500">None</span>` : `Location: <span class="text-slate-300">${escapeHtml(s.location || "")}</span>\nPath: <span class="text-emerald-300">${escapeHtml(s.path || "")}</span>`
        })),
        badge
      ));
    }
  }

  // ── System Region ──────────────────────────────────────────────────────
  const systemSections = [];

  if (data.running_services && data.running_services.length > 0) {
    systemSections.push(verboseInfoSection(
      `Running Services (${data.running_services.length})`,
      "fa-solid fa-gears",
      data.running_services.slice(0, 20).map(s => ({
        top: s.display_name || s.name || "",
        bottom: `State: <span class="text-slate-300">${escapeHtml(s.state || "")}</span> | Mode: <span class="text-slate-300">${escapeHtml(s.start_mode || "")}</span>\nPath: <span class="text-emerald-300">${escapeHtml(s.path || "Unknown")}</span>`
      }))
    ));
  }

  // Now handled dynamically during `renderInfoGrid` or we can skip duplicating
  // if (data.antivirus_products && data.antivirus_products.length > 0) { ... }

  if (data.logged_in_users && data.logged_in_users.length > 0) {
    systemSections.push(infoSection(
      "Logged In Users",
      "fa-solid fa-user-check",
      data.logged_in_users.map(u => ({
        label: escapeHtml(u),
        value: '<span class="text-emerald-400">Active</span>'
      }))
    ));
  }

  if (data.env_vars && Object.keys(data.env_vars).length > 0) {
    systemSections.push(infoSection(
      "Environment Variables",
      "fa-solid fa-terminal",
      Object.entries(data.env_vars).map(([k, v]) => ({
        label: escapeHtml(k),
        value: `<code class="text-xs">${escapeHtml(String(v))}</code>`
      }))
    ));
  }

  // ── Network Region ─────────────────────────────────────────────────────
  const networkSections = [];

  if (data.network_connections && data.network_connections.length > 0) {
    networkSections.push(infoSection(
      `Network Connections (${data.network_connections.length})`,
      "fa-solid fa-network-wired",
      data.network_connections.slice(0, 20).map(c => ({
        label: escapeHtml(c.local_addr || ""),
        value: `<span class="text-xs">${escapeHtml(c.remote_addr || "—")} • ${escapeHtml(c.state || "")} • PID ${c.pid || "?"}</span>`
      }))
    ));
  }

  // ── WiFi Credentials Region ────────────────────────────────────────────
  const wifiSections = [];

  if (data.wifi_profiles && data.wifi_profiles.length > 0) {
    wifiSections.push(infoSection(
      `Saved WiFi Networks (${data.wifi_profiles.length})`,
      "fa-solid fa-wifi",
      data.wifi_profiles.map(w => ({
        label: escapeHtml(w.ssid || ""),
        value: `<span class="text-xs">${w.password ? `<span class="text-emerald-400">${escapeHtml(w.password)}</span>` : '<span class="text-yellow-400">No password</span>'} • ${escapeHtml(w.security || "")}</span>`
      }))
    ));
  } else {
    wifiSections.push(`<div class="col-span-1 md:col-span-2 lg:col-span-3 text-slate-500 italic text-center p-4 border border-dashed border-white/10 rounded mt-4">No stored WiFi credentials found.</div>`);
  }

  // ── Linux/macOS Region ─────────────────────────────────────────────────
  const otherSections = [];

  if (data.cron_jobs && data.cron_jobs.length > 0) {
    otherSections.push(infoSection(
      `Cron Jobs (${data.cron_jobs.length})`,
      "fa-solid fa-clock",
      data.cron_jobs.slice(0, 20).map(c => ({
        label: escapeHtml(c.command || ""),
        value: `<span class="text-xs">${escapeHtml(c.user || "")} • ${escapeHtml(c.schedule || "")}</span>`
      }))
    ));
  }

  if (data.systemd_units && data.systemd_units.length > 0) {
    otherSections.push(infoSection(
      `Systemd Units (${data.systemd_units.length})`,
      "fa-solid fa-gears",
      data.systemd_units.slice(0, 20).map(u => ({
        label: escapeHtml(u.name || ""),
        value: `<span class="text-xs">${escapeHtml(u.active_state || "")} • ${escapeHtml(u.sub_state || "")}</span>`
      }))
    ));
  }

  if (data.launch_agents && data.launch_agents.length > 0) {
    otherSections.push(infoSection(
      `Launch Agents (${data.launch_agents.length})`,
      "fa-solid fa-rocket",
      data.launch_agents.slice(0, 20).map(l => ({
        label: escapeHtml(l.label || ""),
        value: `<span class="text-xs">${escapeHtml(l.program || "")} • ${l.run_at_load ? "RunAtLoad" : ""}</span>`
      }))
    ));
  }
  if (data.launch_daemons && data.launch_daemons.length > 0) {
    otherSections.push(verboseInfoSection(
      `Launch Daemons (${data.launch_daemons.length})`,
      "fa-solid fa-rocket",
      data.launch_daemons.slice(0, 20).map(l => ({
        top: l.label || "",
        bottom: `Path: <span class="text-emerald-300">${escapeHtml(l.program || "")}</span>\nFlags: <span class="text-slate-300">${l.run_at_load ? "RunAtLoad " : ""}${l.keep_alive ? "KeepAlive" : ""}</span>`
      }))
    ));
  }

  // Build the region layout using Tailwind wrappers
  let html = "";

  const regionWrapper = (title, icon, sections) => `
    <div class="extended-region bg-slate-900 border border-white/5 rounded-xl overflow-hidden shadow-lg mb-6 flex flex-col w-full min-w-0">
      <div class="extended-region-title flex items-center gap-2 px-6 py-4 bg-slate-950 border-b border-white/5 text-slate-200 font-bold uppercase tracking-wider text-sm shadow-sm min-w-0">
        <i class="${icon} text-blue-500 mr-1"></i> ${title}
      </div>
      <div class="extended-region-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 p-6 min-w-0 w-full">
        ${sections.join("")}
      </div>
    </div>
  `;

  if (persistenceSections.length > 0) {
    html += regionWrapper("Persistence", "fa-solid fa-lock", persistenceSections);
  }
  if (systemSections.length > 0) {
    html += regionWrapper("System", "fa-solid fa-computer", systemSections);
  }
  if (networkSections.length > 0) {
    html += regionWrapper("Network", "fa-solid fa-network-wired", networkSections);
  }
  if (wifiSections.length > 0) {
    html += regionWrapper("WiFi Credentials", "fa-solid fa-wifi", wifiSections);
  }
  if (otherSections.length > 0) {
    html += regionWrapper("Other", "fa-solid fa-globe", otherSections);
  }

  container.innerHTML = html;
}

function getGaugeColorClass(value) {
  if (value >= 90) return "gauge-bar-critical";
  if (value >= 70) return "gauge-bar-warning";
  if (value >= 40) return "gauge-bar-moderate";
  return "gauge-bar-ok";
}

// ── Nav actions (open viewer pages) ─────────────────────────────────────────
document.addEventListener("click", (e) => {
  const link = e.target.closest(".panel-nav-action");
  if (!link) return;
  e.preventDefault();
  const href = link.dataset.href;
  if (href) {
    // Pages that use ?clientId= query param (path-based pages use /:clientId/feature)
    if (link.dataset.query === "true") {
      window.location.href = `${href}?clientId=${clientId}`;
    } else {
      // Path-based pages like /:clientId/console
      window.location.href = `/${clientId}${href}`;
    }
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────
loadClientInfo();
