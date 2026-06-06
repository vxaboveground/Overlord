let clientsChart = null;
let commandsChart = null;
let bandwidthChart = null;
let httpRequestsChart = null;
let httpChart = null;
let memoryChart = null;
let eventLoopChart = null;
let sessionsChart = null;
let osChart = null;
let countryMap = null;
let countriesLayer = null;
let countryCounts = {};
let maxCountryCount = 0;
let latestByCountry = {};

const GEOJSON_URL = "/vendor/geo-countries/countries.geojson";
const MAX_CHART_POINTS = 240;
const METRICS_POLL_INTERVAL_MS = 5000;
const SESSION_LABELS = ["Console", "Remote Desktop", "Files", "Processes"];
const SESSION_COLORS = ["#34d399", "#c084fc", "#60a5fa", "#fb923c"];
const SESSION_EMPTY_COLOR = "rgba(100, 116, 139, 0.35)";

if (typeof Chart !== "undefined") {
  Chart.defaults.color = "#cbd5e1";
  Chart.defaults.borderColor = "rgba(100, 116, 139, 0.25)";
  Chart.defaults.font.family = "Inter, system-ui, sans-serif";
}

function chartTooltip() {
  return {
    backgroundColor: "#0f172a",
    titleColor: "#e2e8f0",
    bodyColor: "#cbd5e1",
    borderColor: "#334155",
    borderWidth: 1,
  };
}

function lineChartOptions(extra = {}) {
  const extraPlugins = extra.plugins || {};
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      y: {
        beginAtZero: true,
        ticks: { color: "#94a3b8" },
        grid: { color: "rgba(100, 116, 139, 0.1)" },
      },
      x: {
        ticks: {
          color: "#94a3b8",
          maxTicksLimit: 6,
          autoSkip: true,
          maxRotation: 0,
        },
        grid: { color: "rgba(100, 116, 139, 0.1)" },
      },
      ...(extra.scales || {}),
    },
    ...extra,
    plugins: {
      legend:
        extraPlugins.legend ?? { display: true, labels: { boxWidth: 10, boxHeight: 10 } },
      tooltip: chartTooltip(),
      ...extraPlugins,
    },
  };
}

function makeLineChart(canvas, datasets, options = {}) {
  if (!canvas) return null;
  return new Chart(canvas, {
    type: "line",
    data: { labels: [], datasets },
    options: lineChartOptions(options),
  });
}

function getSessionValues(sessions = {}) {
  return [
    Number(sessions.console) || 0,
    Number(sessions.remoteDesktop) || 0,
    Number(sessions.fileBrowser) || 0,
    Number(sessions.process) || 0,
  ];
}

function updateSessionsChart(sessions = {}) {
  if (!sessionsChart) return;
  const values = getSessionValues(sessions);
  const total = values.reduce((sum, value) => sum + value, 0);
  const dataset = sessionsChart.data.datasets[0];
  if (total > 0) {
    sessionsChart.data.labels = SESSION_LABELS;
    dataset.data = values;
    dataset.backgroundColor = SESSION_COLORS;
    sessionsChart.options.plugins.legend.display = true;
  } else {
    sessionsChart.data.labels = ["No active sessions"];
    dataset.data = [1];
    dataset.backgroundColor = [SESSION_EMPTY_COLOR];
    sessionsChart.options.plugins.legend.display = false;
  }
  sessionsChart.update("none");
}

function initCharts() {
  const clientsCtx = document.getElementById("clients-chart");
  const commandsCtx = document.getElementById("commands-chart");
  const bandwidthCtx = document.getElementById("bandwidth-chart");
  const httpRequestsCtx = document.getElementById("http-requests-chart");
  const httpCtx = document.getElementById("http-chart");
  const memoryCtx = document.getElementById("memory-chart");
  const eventLoopCtx = document.getElementById("event-loop-chart");
  const sessionsCtx = document.getElementById("sessions-chart");
  const osCtx = document.getElementById("os-chart");

  clientsChart = new Chart(clientsCtx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Clients Online",
          data: [],
          borderColor: "rgb(96, 165, 250)",
          backgroundColor: "rgba(96, 165, 250, 0.1)",
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0f172a",
          titleColor: "#e2e8f0",
          bodyColor: "#cbd5e1",
          borderColor: "#334155",
          borderWidth: 1,
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { color: "#94a3b8", stepSize: 1 },
          grid: { color: "rgba(100, 116, 139, 0.1)" },
        },
        x: {
          ticks: {
            color: "#94a3b8",
            maxTicksLimit: 6,
            autoSkip: true,
            maxRotation: 0,
          },
          grid: { color: "rgba(100, 116, 139, 0.1)" },
        },
      },
    },
  });

  commandsChart = new Chart(commandsCtx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Commands/Min",
          data: [],
          borderColor: "rgb(192, 132, 252)",
          backgroundColor: "rgba(192, 132, 252, 0.1)",
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0f172a",
          titleColor: "#e2e8f0",
          bodyColor: "#cbd5e1",
          borderColor: "#334155",
          borderWidth: 1,
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { color: "#94a3b8" },
          grid: { color: "rgba(100, 116, 139, 0.1)" },
        },
        x: {
          ticks: {
            color: "#94a3b8",
            maxTicksLimit: 6,
            autoSkip: true,
            maxRotation: 0,
          },
          grid: { color: "rgba(100, 116, 139, 0.1)" },
        },
      },
    },
  });

  bandwidthChart = makeLineChart(
    bandwidthCtx,
    [
      {
        label: "Sent/s",
        data: [],
        borderColor: "rgb(251, 146, 60)",
        backgroundColor: "rgba(251, 146, 60, 0.12)",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
      },
      {
        label: "Received/s",
        data: [],
        borderColor: "rgb(56, 189, 248)",
        backgroundColor: "rgba(56, 189, 248, 0.1)",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
      },
    ],
    {
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            color: "#94a3b8",
            callback: (value) => formatBytes(Number(value)),
          },
          grid: { color: "rgba(100, 116, 139, 0.1)" },
        },
      },
    },
  );

  httpRequestsChart = makeLineChart(
    httpRequestsCtx,
    [
      {
        label: "requests/min",
        data: [],
        borderColor: "rgb(52, 211, 153)",
        backgroundColor: "rgba(52, 211, 153, 0.12)",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
      },
      {
        label: "errors/min",
        data: [],
        borderColor: "rgb(248, 113, 113)",
        backgroundColor: "rgba(248, 113, 113, 0.14)",
        fill: false,
        tension: 0.25,
        pointRadius: 0,
        borderDash: [5, 4],
        borderWidth: 2,
      },
    ],
    {
      scales: {
        y: {
          beginAtZero: true,
          ticks: { color: "#94a3b8", precision: 0 },
          grid: { color: "rgba(100, 116, 139, 0.1)" },
        },
      },
    },
  );

  httpChart = makeLineChart(
    httpCtx,
    [
      {
        label: "p99 ms",
        data: [],
        borderColor: "rgb(248, 113, 113)",
        backgroundColor: "rgba(248, 113, 113, 0.08)",
        fill: false,
        tension: 0.35,
        pointRadius: 0,
        borderDash: [4, 4],
        borderWidth: 2,
      },
      {
        label: "p95 ms",
        data: [],
        borderColor: "rgb(244, 63, 94)",
        backgroundColor: "rgba(244, 63, 94, 0.1)",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
      },
      {
        label: "avg ms",
        data: [],
        borderColor: "rgb(251, 191, 36)",
        backgroundColor: "rgba(251, 191, 36, 0.08)",
        fill: false,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
      },
    ],
    {
      scales: {
        y: {
          beginAtZero: true,
          ticks: { color: "#94a3b8", callback: (value) => `${Math.round(Number(value))} ms` },
          grid: { color: "rgba(100, 116, 139, 0.1)" },
        },
      },
    },
  );

  memoryChart = makeLineChart(
    memoryCtx,
    [
      {
        label: "Heap",
        data: [],
        borderColor: "rgb(34, 211, 238)",
        backgroundColor: "rgba(34, 211, 238, 0.1)",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        yAxisID: "y",
        borderWidth: 2,
      },
      {
        label: "RSS",
        data: [],
        borderColor: "rgb(129, 140, 248)",
        backgroundColor: "rgba(129, 140, 248, 0.08)",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        yAxisID: "y",
        borderWidth: 2,
      },
      {
        label: "System %",
        data: [],
        borderColor: "rgb(52, 211, 153)",
        backgroundColor: "rgba(52, 211, 153, 0.08)",
        fill: false,
        tension: 0.35,
        pointRadius: 0,
        yAxisID: "y1",
        borderWidth: 2,
      },
    ],
    {
      scales: {
        y: {
          beginAtZero: true,
          position: "left",
          ticks: { color: "#94a3b8", callback: (value) => formatBytes(Number(value)) },
          grid: { color: "rgba(100, 116, 139, 0.1)" },
        },
        y1: {
          beginAtZero: true,
          max: 100,
          position: "right",
          ticks: { color: "#86efac", callback: (value) => `${Math.round(Number(value))}%` },
          grid: { drawOnChartArea: false },
        },
      },
    },
  );

  eventLoopChart = makeLineChart(
    eventLoopCtx,
    [
      {
        label: "p95 lag",
        data: [],
        borderColor: "rgb(251, 191, 36)",
        backgroundColor: "rgba(251, 191, 36, 0.12)",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
      },
      {
        label: "avg lag",
        data: [],
        borderColor: "rgb(96, 165, 250)",
        backgroundColor: "rgba(96, 165, 250, 0.08)",
        fill: false,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
      },
    ],
    {
      scales: {
        y: {
          beginAtZero: true,
          ticks: { color: "#94a3b8", callback: (value) => `${Math.round(Number(value))} ms` },
          grid: { color: "rgba(100, 116, 139, 0.1)" },
        },
      },
    },
  );

  sessionsChart = sessionsCtx ? new Chart(sessionsCtx, {
    type: "doughnut",
    data: {
      labels: ["No active sessions"],
      datasets: [{
        data: [1],
        backgroundColor: [SESSION_EMPTY_COLOR],
        borderColor: "#0f172a",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      cutout: "64%",
      plugins: {
        legend: { display: false, position: "right", labels: { boxWidth: 10, boxHeight: 10 } },
        tooltip: {
          ...chartTooltip(),
          callbacks: {
            label: (ctx) => {
              if (ctx.chart.data.labels?.[ctx.dataIndex] === "No active sessions") return "No active sessions";
              const value = Number(ctx.parsed) || 0;
              return `${ctx.label}: ${value.toLocaleString()} session${value === 1 ? "" : "s"}`;
            },
          },
        },
      },
    },
  }) : null;

  osChart = osCtx ? new Chart(osCtx, {
    type: "bar",
    data: {
      labels: [],
      datasets: [{
        label: "Clients",
        data: [],
        backgroundColor: "rgba(56, 189, 248, 0.5)",
        borderColor: "rgb(56, 189, 248)",
        borderWidth: 1,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: chartTooltip(),
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { color: "#94a3b8", precision: 0 },
          grid: { color: "rgba(100, 116, 139, 0.1)" },
        },
        y: {
          ticks: { color: "#94a3b8" },
          grid: { display: false },
        },
      },
    },
  }) : null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1) return `${bytes.toFixed(2)} B`;
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatMs(value) {
  if (!Number.isFinite(value)) return "0 ms";
  return `${Math.round(value)} ms`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function animateCounter(element, newValue, duration = 800) {
  const oldValue = parseInt(element.textContent.replace(/,/g, "")) || 0;
  if (oldValue === newValue) return;

  const startTime = performance.now();
  const diff = newValue - oldValue;

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);

    const easeOutQuad = progress * (2 - progress);
    const current = Math.round(oldValue + diff * easeOutQuad);

    element.textContent = current.toLocaleString();
    element.classList.add("counter-animate");

    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      setTimeout(() => element.classList.remove("counter-animate"), 500);
    }
  }

  requestAnimationFrame(update);
}

function updateMetrics(data, debug) {
  animateCounter(
    document.getElementById("clients-online"),
    data.clients.online,
  );
  animateCounter(document.getElementById("clients-total"), data.clients.total);

  const totalSessions = getSessionValues(data.sessions).reduce((sum, value) => sum + value, 0);
  animateCounter(document.getElementById("active-sessions"), totalSessions);

  animateCounter(
    document.getElementById("commands-hour"),
    data.commands.lastHour,
  );
  animateCounter(
    document.getElementById("commands-minute"),
    data.commands.lastMinute,
  );
  animateCounter(
    document.getElementById("commands-total"),
    data.commands.total,
  );

  const totalRate =
    data.bandwidth.sentPerSecond + data.bandwidth.receivedPerSecond;
  document.getElementById("bandwidth-rate").textContent =
    formatBytes(totalRate) + "/s";
  document.getElementById("bandwidth-sent").textContent = formatBytes(
    data.bandwidth.sent,
  );
  document.getElementById("bandwidth-received").textContent = formatBytes(
    data.bandwidth.received,
  );

  document.getElementById("server-uptime").textContent = formatDuration(
    data.server.uptime,
  );
  document.getElementById("server-memory").textContent = formatBytes(
    data.server.memoryUsage.heapUsed,
  );
  const serverRssEl = document.getElementById("server-rss");
  if (serverRssEl) {
    serverRssEl.textContent = formatBytes(data.server.memoryUsage.rss);
  }
  const serverSystemMemEl = document.getElementById("server-system-memory");
  if (serverSystemMemEl && data.server.systemMemory) {
    const used = data.server.systemMemory.used || 0;
    const total = data.server.systemMemory.total || 0;
    const percent = data.server.systemMemory.usedPercent || 0;
    serverSystemMemEl.textContent = `${formatBytes(used)} / ${formatBytes(total)} (${Math.round(percent)}%)`;
  }
  const serverCpuEl = document.getElementById("server-cpu-load");
  if (serverCpuEl && data.server.cpu) {
    const [l1, l5, l15] = data.server.cpu.loadAvg || [0, 0, 0];
    const cores = data.server.cpu.cores || 0;
    serverCpuEl.textContent = `${Number(l1).toFixed(2)} / ${Number(l5).toFixed(2)} / ${Number(l15).toFixed(2)}${cores ? ` (${cores} cores)` : ""}`;
  }
  animateCounter(
    document.getElementById("total-connections"),
    data.connections.totalConnections,
  );

  const httpRequestsEl = document.getElementById("http-requests-minute");
  if (httpRequestsEl) {
    animateCounter(httpRequestsEl, data.http.lastMinute || 0);
  }
  const httpErrorsEl = document.getElementById("http-errors-minute");
  if (httpErrorsEl) {
    animateCounter(httpErrorsEl, data.http.lastMinuteErrors || 0);
  }
  const httpLatencyAvgEl = document.getElementById("http-latency-avg");
  if (httpLatencyAvgEl) {
    httpLatencyAvgEl.textContent = formatMs(data.http.latencyAvg || 0);
  }
  const httpLatencyP95El = document.getElementById("http-latency-p95");
  if (httpLatencyP95El) {
    httpLatencyP95El.textContent = formatMs(data.http.latencyP95 || 0);
  }
  const httpLatencyP99El = document.getElementById("http-latency-p99");
  if (httpLatencyP99El) {
    httpLatencyP99El.textContent = formatMs(data.http.latencyP99 || 0);
  }
  const eventLoopAvgEl = document.getElementById("event-loop-avg");
  if (eventLoopAvgEl) {
    eventLoopAvgEl.textContent = formatMs(data.eventLoop.avg || 0);
  }
  const eventLoopP95El = document.getElementById("event-loop-p95");
  if (eventLoopP95El) {
    eventLoopP95El.textContent = formatMs(data.eventLoop.p95 || 0);
  }
  const eventLoopMaxEl = document.getElementById("event-loop-max");
  if (eventLoopMaxEl) {
    eventLoopMaxEl.textContent = formatMs(data.eventLoop.max || 0);
  }

  if (data.ping.count > 0) {
    document.getElementById("ping-avg").textContent =
      Math.round(data.ping.avg) + " ms";
    document.getElementById("ping-min").textContent =
      Math.round(data.ping.min) + " ms";
    document.getElementById("ping-max").textContent =
      Math.round(data.ping.max) + " ms";
    animateCounter(document.getElementById("ping-count"), data.ping.count);
  } else {
    document.getElementById("ping-avg").textContent = "-";
    document.getElementById("ping-min").textContent = "-";
    document.getElementById("ping-max").textContent = "-";
    document.getElementById("ping-count").textContent = "0";
  }

  const osList = document.getElementById("clients-by-os");
  if (Object.keys(data.clients.byOS).length > 0) {
    osList.innerHTML = Object.entries(data.clients.byOS)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([os, count]) => `
        <div class="flex justify-between items-center">
          <span class="text-slate-400">${escapeHtml(os)}</span>
          <span class="font-semibold">${count}</span>
        </div>
      `,
      )
      .join("");
  } else {
    osList.innerHTML = '<div class="text-slate-500">No clients</div>';
  }

  updateSessionsChart(data.sessions);

  if (osChart) {
    const osEntries = Object.entries(data.clients.byOS || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    osChart.data.labels = osEntries.length ? osEntries.map(([label]) => label) : ["No clients"];
    osChart.data.datasets[0].data = osEntries.length ? osEntries.map(([, count]) => count) : [0];
    osChart.update("none");
  }

  const httpRoutesList = document.getElementById("http-routes");
  if (httpRoutesList) {
    const routes = Array.isArray(data.http.routes) ? data.http.routes : [];
    if (routes.length > 0) {
      httpRoutesList.innerHTML = routes
        .map((route) => {
          const errorClass = route.errorsLastMinute > 0 ? "text-red-300" : "text-slate-400";
          return `
            <div class="bg-slate-800/50 rounded p-3 min-w-0">
              <div class="text-xs text-slate-400 mb-2 truncate" title="${escapeHtml(route.route)}">
                ${escapeHtml(route.route)}
              </div>
              <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <span class="text-slate-500">p95</span>
                <span class="font-semibold text-right">${formatMs(route.latencyP95 || 0)}</span>
                <span class="text-slate-500">avg</span>
                <span class="font-semibold text-right">${formatMs(route.latencyAvg || 0)}</span>
                <span class="text-slate-500">req/min</span>
                <span class="font-semibold text-right">${Number(route.countLastMinute || 0).toLocaleString()}</span>
                <span class="text-slate-500">errors</span>
                <span class="font-semibold text-right ${errorClass}">${Number(route.errorsLastMinute || 0).toLocaleString()}</span>
              </div>
            </div>
          `;
        })
        .join("");
    } else {
      httpRoutesList.innerHTML =
        '<div class="text-slate-500 col-span-full text-center py-4">No HTTP route samples yet</div>';
    }
  }

  const commandTypesList = document.getElementById("command-types");
  if (Object.keys(data.commands.byType).length > 0) {
    const topCommands = Object.entries(data.commands.byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    commandTypesList.innerHTML = topCommands
      .map(
        ([type, count]) => `
      <div class="bg-slate-800/50 rounded p-3">
        <div class="text-xs text-slate-400 mb-1">${escapeHtml(type)}</div>
        <div class="text-xl font-bold">${count.toLocaleString()}</div>
      </div>
    `,
      )
      .join("");
  } else {
    commandTypesList.innerHTML =
      '<div class="text-slate-500 col-span-full text-center py-4">No commands executed yet</div>';
  }

  document.getElementById("last-update").textContent =
    new Date().toLocaleTimeString();

  updateCountryMap(data.clients.byCountry);
}

function normalizeCountry(code) {
  return (code || "").toString().trim().toUpperCase();
}

function getFeatureCode(feature) {
  const props = feature?.properties || {};
  return normalizeCountry(
    props["ISO3166-1-Alpha-2"] ||
      props.ISO_A2 ||
      props.iso_a2 ||
      props.ISO_A2_EH ||
      props.iso2 ||
      props.ISO2 ||
      props.country_code ||
      props.countryCode ||
      props.A2 ||
      props.abbrev ||
      props.abbreviation ||
      feature?.id ||
      "",
  );
}

function getFeatureName(feature) {
  const props = feature?.properties || {};
  return (
    props.NAME ||
    props.name ||
    props.ADMIN ||
    props.admin ||
    props.Country ||
    "Unknown"
  );
}

function countryFillOpacity(count) {
  if (maxCountryCount <= 0) return 0.1;
  const intensity = Math.min(count / maxCountryCount, 1);
  return 0.1 + intensity * 0.75;
}

function styleCountry(feature) {
  const code = getFeatureCode(feature);
  const count = code ? countryCounts[code] || 0 : 0;
  return {
    weight: 0.7,
    color: "#1e293b",
    fillColor: "#3b82f6",
    fillOpacity: countryFillOpacity(count),
  };
}

function updateCountryMap(byCountry) {
  latestByCountry = byCountry || {};
  countryCounts = {};
  for (const [code, count] of Object.entries(latestByCountry || {})) {
    const cc = normalizeCountry(code);
    if (!cc || cc === "ZZ") continue;
    countryCounts[cc] = Number(count) || 0;
  }
  maxCountryCount = Math.max(0, ...Object.values(countryCounts));

  if (!countriesLayer) return;

  countriesLayer.setStyle(styleCountry);
  countriesLayer.eachLayer((layer) => {
    const feature = layer.feature;
    const code = getFeatureCode(feature) || "--";
    const name = getFeatureName(feature);
    const count = code ? countryCounts[code] || 0 : 0;
    layer.bindTooltip(`${escapeHtml(name)} (${code}): ${count}`, {
      sticky: true,
      direction: "auto",
    });
  });
}

async function initCountryMap() {
  const mapEl = document.getElementById("country-map");
  if (!mapEl || typeof L === "undefined") return;

  countryMap = L.map(mapEl, {
    zoomControl: false,
    attributionControl: false,
    minZoom: 1,
    maxZoom: 5,
    worldCopyJump: true,
  }).setView([20, 0], 2);

  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 5,
      minZoom: 1,
    },
  ).addTo(countryMap);

  try {
    const res = await fetch(GEOJSON_URL);
    if (!res.ok) throw new Error("GeoJSON fetch failed");
    const geojson = await res.json();

    countriesLayer = L.geoJSON(geojson, {
      style: styleCountry,
    }).addTo(countryMap);

    updateCountryMap(latestByCountry);

    if (countriesLayer.getBounds) {
      countryMap.fitBounds(countriesLayer.getBounds(), {
        padding: [10, 10],
      });
    }
  } catch (err) {
    console.error("Failed to load country map:", err);
    mapEl.innerHTML =
      '<div class="text-slate-400 text-sm p-4">Failed to load map data.</div>';
  }
}

function updateCharts(history, snapshot) {
  const points = Array.isArray(history) && history.length > 0
    ? history.slice(-MAX_CHART_POINTS)
    : [];

  if (points.length === 0) {
    const now = new Date();
    const label = formatTime(now.getTime());

    clientsChart.data.labels = [label];
    clientsChart.data.datasets[0].data = [snapshot.clients.online];
    clientsChart.update("none");

    commandsChart.data.labels = [label];
    commandsChart.data.datasets[0].data = [snapshot.commands.lastMinute];
    commandsChart.update("none");

    if (bandwidthChart) {
      bandwidthChart.data.labels = [label];
      bandwidthChart.data.datasets[0].data = [snapshot.bandwidth.sentPerSecond || 0];
      bandwidthChart.data.datasets[1].data = [snapshot.bandwidth.receivedPerSecond || 0];
      bandwidthChart.update("none");
    }

    if (httpChart) {
      httpChart.data.labels = [label];
      httpChart.data.datasets[0].data = [snapshot.http.latencyP99 || 0];
      httpChart.data.datasets[1].data = [snapshot.http.latencyP95 || 0];
      httpChart.data.datasets[2].data = [snapshot.http.latencyAvg || 0];
      httpChart.update("none");
    }

    if (httpRequestsChart) {
      httpRequestsChart.data.labels = [label];
      httpRequestsChart.data.datasets[0].data = [snapshot.http.lastMinute || 0];
      httpRequestsChart.data.datasets[1].data = [snapshot.http.lastMinuteErrors || 0];
      httpRequestsChart.update("none");
    }

    if (memoryChart) {
      memoryChart.data.labels = [label];
      memoryChart.data.datasets[0].data = [snapshot.server.memoryUsage.heapUsed || 0];
      memoryChart.data.datasets[1].data = [snapshot.server.memoryUsage.rss || 0];
      memoryChart.data.datasets[2].data = [snapshot.server.systemMemory.usedPercent || 0];
      memoryChart.update("none");
    }

    if (eventLoopChart) {
      eventLoopChart.data.labels = [label];
      eventLoopChart.data.datasets[0].data = [snapshot.eventLoop.p95 || 0];
      eventLoopChart.data.datasets[1].data = [snapshot.eventLoop.avg || 0];
      eventLoopChart.update("none");
    }
    return;
  }

  const labels = points.map((h) => formatTime(h.timestamp));
  const clientsData = points.map((h) => h.clientsOnline || 0);

  clientsChart.data.labels = labels;
  clientsChart.data.datasets[0].data = clientsData;
  clientsChart.update("none");

  const commandsData = points.map((h) => h.commandsPerMinute || 0);

  commandsChart.data.labels = labels;
  commandsChart.data.datasets[0].data = commandsData;
  commandsChart.update("none");

  if (bandwidthChart) {
    bandwidthChart.data.labels = labels;
    bandwidthChart.data.datasets[0].data = points.map((h) => h.bandwidthSent || 0);
    bandwidthChart.data.datasets[1].data = points.map((h) => h.bandwidthReceived || 0);
    bandwidthChart.update("none");
  }

  if (httpChart) {
    httpChart.data.labels = labels;
    httpChart.data.datasets[0].data = points.map((h) => h.httpLatencyP99 || 0);
    httpChart.data.datasets[1].data = points.map((h) => h.httpLatencyP95 || 0);
    httpChart.data.datasets[2].data = points.map((h) => h.httpLatencyAvg || 0);
    httpChart.update("none");
  }

  if (httpRequestsChart) {
    httpRequestsChart.data.labels = labels;
    httpRequestsChart.data.datasets[0].data = points.map((h) => h.httpRequestsPerMinute || 0);
    httpRequestsChart.data.datasets[1].data = points.map((h) => h.httpErrorsPerMinute || 0);
    httpRequestsChart.update("none");
  }

  if (memoryChart) {
    memoryChart.data.labels = labels;
    memoryChart.data.datasets[0].data = points.map((h) => h.heapUsed || 0);
    memoryChart.data.datasets[1].data = points.map((h) => h.rss || 0);
    memoryChart.data.datasets[2].data = points.map((h) => h.systemMemoryUsedPercent || 0);
    memoryChart.update("none");
  }

  if (eventLoopChart) {
    eventLoopChart.data.labels = labels;
    eventLoopChart.data.datasets[0].data = points.map((h) => h.eventLoopP95 || 0);
    eventLoopChart.data.datasets[1].data = points.map((h) => h.eventLoopAvg || 0);
    eventLoopChart.update("none");
  }
}

async function fetchMetrics() {
  try {
    const response = await fetch(`/api/metrics?historyLimit=${MAX_CHART_POINTS}`, {
      credentials: "include",
    });

    if (response.status === 401) {
      window.location.href = "/";
      return;
    }

    if (!response.ok) {
      throw new Error("Failed to fetch metrics");
    }

    const data = await response.json();
    updateMetrics(data.snapshot, data.debug);
    updateCharts(data.history, data.snapshot);

    document.getElementById("status-text").textContent = "Live";
  } catch (err) {
    console.error("Error fetching metrics:", err);
    document.getElementById("status-text").textContent = "Error";
  }
}

async function checkAuth() {
  try {
    const res = await fetch("/api/auth/me", { credentials: "include" });
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
      document.getElementById("users-link")?.classList.remove("hidden");
      document.getElementById("build-link")?.classList.remove("hidden");
      document.getElementById("plugins-link")?.classList.remove("hidden");
      document.getElementById("deploy-link")?.classList.remove("hidden");
    } else if (data.role === "operator" || data.canBuild) {
      document.getElementById("build-link")?.classList.remove("hidden");
    }

    if (data.role !== "viewer") {
      document.getElementById("scripts-link")?.classList.remove("hidden");
    }
  } catch (err) {
    console.error("Auth check failed:", err);
    window.location.href = "/";
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await checkAuth();

  initCharts();

  await initCountryMap();

  await fetchMetrics();

  setInterval(fetchMetrics, METRICS_POLL_INTERVAL_MS);

  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn && !logoutBtn.dataset.boundLogout) {
    logoutBtn.dataset.boundLogout = "true";
    logoutBtn.addEventListener("click", async () => {
      if (!confirm("Are you sure you want to logout?")) return;

      try {
        const res = await fetch("/api/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        if (res.ok) {
          window.location.href = "/";
        } else {
          alert("Logout failed. Please try again.");
        }
      } catch (err) {
        console.error("Logout error:", err);
        alert("Logout failed. Please try again.");
      }
    });
  }
});
