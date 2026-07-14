import Chart from "/vendor/chart.js/chart.esm.js";

let clientsChart = null;
let commandsChart = null;
let bandwidthChart = null;
let httpRequestsChart = null;
let httpChart = null;
let memoryChart = null;
let eventLoopChart = null;
let sessionsChart = null;
let osChart = null;
let countryGlobeCanvas = null;
let countryGlobeCtx = null;
let countryGlobeFrame = null;
let countryGlobeResizeObserver = null;
let countryGlobePhi = 0;
let countryGlobeTheta = -0.18;
let countryGlobeBaseScale = 1;
let countryGlobeZoom = 1;
let countryGlobeFeatures = [];
let countryCounts = {};
let countryUnknownCount = 0;
let maxCountryCount = 0;
let totalCountryCount = 0;
let latestByCountry = {};
let countryGlobeIsDragging = false;
let countryGlobeLastPointer = null;
let countryGlobeAutoSpinPausedUntil = 0;
let countryGlobeLastHoverPointer = null;
let countryGlobeHoverEntry = null;
let countryGlobeSortedFeatures = [];
let countryGlobeLastSpinFrameAt = 0;
let countryGlobeLastHoverFrameAt = 0;
let metricsPollTimer = null;
let metricsPageActive = true;

const GEOJSON_URL = "/vendor/geo-countries/countries.geojson";
const MAX_CHART_POINTS = 240;
const METRICS_POLL_INTERVAL_MS = 5000;
const SESSION_LABELS = ["Console", "Remote Desktop", "Files", "Processes"];
const SESSION_COLORS = ["#34d399", "#c084fc", "#60a5fa", "#fb923c"];
const SESSION_EMPTY_COLOR = "rgba(100, 116, 139, 0.35)";
const UNKNOWN_COUNTRY_CODE = "ZZ";
const SOMALIA_LOCATION = [5.152149, 46.199616];
const UNKNOWN_COUNTRY_LOCATION = {
  location: SOMALIA_LOCATION,
  name: "Unknown location (shown over Somalia)",
};
const GLOBE_MIN_THETA = -1.15;
const GLOBE_MAX_THETA = 1.15;
const GLOBE_DRAG_SENSITIVITY = 0.006;
const GLOBE_AUTOSPIN_SPEED = 0.0035;
const GLOBE_AUTOSPIN_RESUME_DELAY_MS = 2500;
const GLOBE_ZOOM_MIN = 0.72;
const GLOBE_ZOOM_MAX = 2.2;
const GLOBE_ZOOM_STEP = 1.18;
const GLOBE_BORDER_COLOR = "rgba(148, 163, 184, 0.42)";
const GLOBE_HOVER_BORDER_COLOR = "rgba(248, 250, 252, 0.92)";
const GLOBE_EMPTY_COUNTRY_FILL = "rgba(30, 41, 59, 0.58)";
const GLOBE_SPHERE_FILL = "#07111f";
const GLOBE_HORIZON_VISIBLE_Z = 0.025;
const GLOBE_SIMPLIFY_TOLERANCE_DEGREES = 0.18;
const GLOBE_MIN_RING_POINTS = 3;
const GLOBE_AUTOSPIN_FRAME_MS = 50;
const GLOBE_HOVER_FRAME_MS = 80;

let countryLocations = {
  [UNKNOWN_COUNTRY_CODE]: UNKNOWN_COUNTRY_LOCATION,
};

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
            <div class="bg-slate-950/40 border border-slate-800 rounded-lg p-3 min-w-0">
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

  const internalTasksList = document.getElementById("internal-tasks");
  if (internalTasksList) {
    const tasks = Array.isArray(data.internal?.tasks) ? data.internal.tasks : [];
    if (tasks.length > 0) {
      internalTasksList.innerHTML = tasks
        .map((task) => `
          <div class="bg-slate-950/40 border border-slate-800 rounded-lg p-3 min-w-0">
            <div class="text-xs text-slate-400 mb-2 truncate" title="${escapeHtml(task.task)}">
              ${escapeHtml(task.task)}
            </div>
            <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <span class="text-slate-500">p95</span>
              <span class="font-semibold text-right">${formatMs(task.durationP95 || 0)}</span>
              <span class="text-slate-500">avg</span>
              <span class="font-semibold text-right">${formatMs(task.durationAvg || 0)}</span>
              <span class="text-slate-500">max</span>
              <span class="font-semibold text-right">${formatMs(task.durationMax || 0)}</span>
              <span class="text-slate-500">runs/min</span>
              <span class="font-semibold text-right">${Number(task.countLastMinute || 0).toLocaleString()}</span>
            </div>
          </div>
        `)
        .join("");
    } else {
      internalTasksList.innerHTML =
        '<div class="text-slate-500 col-span-full text-center py-4">No internal job samples yet</div>';
    }
  }

  const retainedStateList = document.getElementById("retained-state");
  if (retainedStateList) {
    const retained = data.diagnostics?.retained || {};
    const entries = Object.entries(retained)
      .filter(([, value]) => typeof value === "number" || typeof value === "boolean")
      .sort(([a], [b]) => a.localeCompare(b));
    if (entries.length > 0) {
      retainedStateList.innerHTML = entries
        .map(([key, value]) => {
          const displayValue = key.toLowerCase().includes("bytes")
            ? formatBytes(Number(value || 0))
            : typeof value === "boolean"
              ? value ? "yes" : "no"
              : Number(value || 0).toLocaleString();
          return `
            <div class="bg-slate-950/40 border border-slate-800 rounded-lg p-3 min-w-0">
              <div class="text-xs text-slate-500 mb-1 truncate" title="${escapeHtml(key)}">
                ${escapeHtml(key)}
              </div>
              <div class="text-sm font-semibold truncate" title="${escapeHtml(displayValue)}">
                ${escapeHtml(displayValue)}
              </div>
            </div>
          `;
        })
        .join("");
    } else {
      retainedStateList.innerHTML =
        '<div class="text-slate-500 col-span-full text-center py-4">No retained state counters yet</div>';
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
      <div class="bg-slate-950/40 border border-slate-800 rounded-lg p-3">
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

function normalizeLongitude(lon) {
  let value = Number(lon);
  if (!Number.isFinite(value)) return 0;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let area = 0;
  let lonSum = 0;
  let latSum = 0;
  let pointCount = 0;
  let centroidLon = 0;
  let centroidLat = 0;

  for (let i = 0; i < ring.length; i++) {
    const current = ring[i];
    const next = ring[(i + 1) % ring.length];
    if (!Array.isArray(current) || !Array.isArray(next)) continue;
    const x0 = normalizeLongitude(current[0]);
    const y0 = Number(current[1]);
    const x1 = normalizeLongitude(next[0]);
    const y1 = Number(next[1]);
    if (![x0, y0, x1, y1].every(Number.isFinite)) continue;

    const cross = x0 * y1 - x1 * y0;
    area += cross;
    centroidLon += (x0 + x1) * cross;
    centroidLat += (y0 + y1) * cross;
    lonSum += x0;
    latSum += y0;
    pointCount += 1;
  }

  area /= 2;
  if (Math.abs(area) > 0.000001) {
    return {
      area: Math.abs(area),
      location: [centroidLat / (6 * area), normalizeLongitude(centroidLon / (6 * area))],
    };
  }

  if (pointCount === 0) return null;
  return {
    area: 0,
    location: [latSum / pointCount, normalizeLongitude(lonSum / pointCount)],
  };
}

function getFeatureLocation(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return null;

  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];

  let best = null;
  for (const polygon of polygons) {
    const outerRing = Array.isArray(polygon) ? polygon[0] : null;
    const centroid = ringCentroid(outerRing);
    if (centroid && (!best || centroid.area > best.area)) {
      best = centroid;
    }
  }

  return best?.location || null;
}

function squaredDistanceToSegment(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) {
    const sx = point[0] - start[0];
    const sy = point[1] - start[1];
    return sx * sx + sy * sy;
  }
  const t = clamp(((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy), 0, 1);
  const x = start[0] + t * dx;
  const y = start[1] + t * dy;
  const px = point[0] - x;
  const py = point[1] - y;
  return px * px + py * py;
}

function simplifyRing(points, tolerance = GLOBE_SIMPLIFY_TOLERANCE_DEGREES) {
  if (!Array.isArray(points) || points.length <= 8) return points || [];
  const clean = points
    .map((point) => [normalizeLongitude(point?.[0]), Number(point?.[1])])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (clean.length <= 8) return clean;

  const closed = clean[0][0] === clean[clean.length - 1][0] && clean[0][1] === clean[clean.length - 1][1];
  const working = closed ? clean.slice(0, -1) : clean;
  if (working.length <= 8) return clean;

  const keep = new Uint8Array(working.length);
  const toleranceSquared = tolerance * tolerance;
  keep[0] = 1;
  keep[working.length - 1] = 1;
  const stack = [[0, working.length - 1]];

  while (stack.length > 0) {
    const [startIndex, endIndex] = stack.pop();
    let maxDistance = 0;
    let maxIndex = -1;
    for (let i = startIndex + 1; i < endIndex; i++) {
      const distance = squaredDistanceToSegment(working[i], working[startIndex], working[endIndex]);
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = i;
      }
    }
    if (maxDistance > toleranceSquared && maxIndex > -1) {
      keep[maxIndex] = 1;
      stack.push([startIndex, maxIndex], [maxIndex, endIndex]);
    }
  }

  const simplified = working.filter((_, index) => keep[index]);
  if (closed && simplified.length > 0) simplified.push(simplified[0]);
  return simplified.length >= GLOBE_MIN_RING_POINTS ? simplified : clean;
}

function vectorFromLonLat(lon, lat) {
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180 - Math.PI;
  const cosLat = Math.cos(latRad);
  return {
    lon,
    lat,
    x: -cosLat * Math.cos(lonRad),
    y: Math.sin(latRad),
    z: cosLat * Math.sin(lonRad),
  };
}

function buildRenderableRings(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return [];
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];

  const renderPolygons = [];
  for (const polygon of polygons) {
    const rings = [];
    for (const ring of polygon) {
      const simplified = simplifyRing(ring);
      if (simplified.length < GLOBE_MIN_RING_POINTS) continue;
      rings.push(simplified.map(([lon, lat]) => vectorFromLonLat(lon, lat)));
    }
    if (rings.length > 0) renderPolygons.push(rings);
  }
  return renderPolygons;
}

function interpolateColor(a, b, t) {
  return a.map((value, index) => value + (b[index] - value) * t);
}

function heatColor(intensity) {
  const cool = [0.22, 0.82, 1];
  const warm = [0.28, 0.95, 0.62];
  const amber = [1, 0.72, 0.18];
  const hot = [1, 0.08, 0.08];
  if (intensity < 0.45) {
    return interpolateColor(cool, warm, intensity / 0.45);
  }
  if (intensity < 0.8) {
    return interpolateColor(warm, amber, (intensity - 0.45) / 0.35);
  }
  return interpolateColor(amber, hot, (intensity - 0.8) / 0.2);
}

function colorString(color, alpha = 1) {
  return `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, ${alpha})`;
}

function countryHeatIntensity(count) {
  if (totalCountryCount <= 0) return 0;
  const share = Math.min(Math.max(count / totalCountryCount, 0), 1);
  return Math.sqrt(share);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function updateCountryGlobeTooltip() {
  const globeEl = document.getElementById("country-globe");
  if (!globeEl) return;
  const topCountries = Object.entries(countryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, count]) => {
      const name = countryLocations[code]?.name || code;
      return `${name} (${code}): ${count}`;
    });

  globeEl.title = topCountries.length
    ? topCountries.join("\n")
    : "No client geography data yet";
}

function updateCountryMap(byCountry) {
  latestByCountry = byCountry || {};
  countryCounts = {};
  countryUnknownCount = 0;
  for (const [code, count] of Object.entries(latestByCountry || {})) {
    const cc = normalizeCountry(code);
    if (!cc) continue;
    const value = Math.max(0, Number(count) || 0);
    const targetCode = cc === UNKNOWN_COUNTRY_CODE ? "SO" : cc;
    if (cc === UNKNOWN_COUNTRY_CODE) countryUnknownCount += value;
    countryCounts[targetCode] = (countryCounts[targetCode] || 0) + value;
  }
  maxCountryCount = Math.max(0, ...Object.values(countryCounts));
  totalCountryCount = Object.values(countryCounts).reduce((sum, count) => sum + count, 0);
  countryGlobeSortedFeatures = [...countryGlobeFeatures].sort((a, b) => {
    const aCount = countryCounts[a.code] || 0;
    const bCount = countryCounts[b.code] || 0;
    return aCount - bCount;
  });

  updateCountryGlobeTooltip();
  drawCountryGlobe();
  updateCountryGlobeHoverTooltip();
}

async function loadCountryLocations() {
  try {
    const res = await fetch(GEOJSON_URL);
    if (!res.ok) throw new Error("GeoJSON fetch failed");
    const geojson = await res.json();
    const features = Array.isArray(geojson.features) ? geojson.features : [];
    const locations = {};

    for (const feature of features) {
      const code = getFeatureCode(feature);
      const location = getFeatureLocation(feature);
      if (!code || !location) continue;
      locations[code] = {
        location,
        name: getFeatureName(feature),
      };
    }

    countryGlobeFeatures = features
      .map((feature) => {
        const code = getFeatureCode(feature);
        if (!code) return null;
        const renderPolygons = buildRenderableRings(feature);
        if (renderPolygons.length === 0) return null;
        return {
          feature,
          code,
          name: getFeatureName(feature),
          location: locations[code]?.location || getFeatureLocation(feature),
          renderPolygons,
        };
      })
      .filter((entry) => entry && entry.location);
    countryGlobeSortedFeatures = [...countryGlobeFeatures];

    const somaliaLocation = locations.SO?.location || SOMALIA_LOCATION;
    countryLocations = {
      ...locations,
      [UNKNOWN_COUNTRY_CODE]: {
        ...UNKNOWN_COUNTRY_LOCATION,
        location: somaliaLocation,
      },
    };
    updateCountryMap(latestByCountry);
  } catch (err) {
    console.error("Failed to load country geography:", err);
  }
}

function getGlobeSize() {
  const rect = countryGlobeCanvas?.getBoundingClientRect();
  const width = Math.max(320, Math.round(rect?.width || 720));
  const height = Math.max(320, Math.round(rect?.height || 384));
  return { width, height };
}

function getBaseGlobeScale(width, height) {
  return Math.min(1.08, width / Math.max(height, 1) > 1.6 ? 1.04 : 0.96);
}

function getGlobeScale() {
  return countryGlobeBaseScale * countryGlobeZoom;
}

function updateGlobeScale() {
  drawCountryGlobe();
}

function updateGlobeSize() {
  if (!countryGlobeCtx || !countryGlobeCanvas) return;
  const { width, height } = getGlobeSize();
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  countryGlobeCanvas.width = Math.round(width * devicePixelRatio);
  countryGlobeCanvas.height = Math.round(height * devicePixelRatio);
  countryGlobeCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  countryGlobeBaseScale = getBaseGlobeScale(width, height);
  drawCountryGlobe();
  updateCountryGlobeHoverTooltip();
}

function updateGlobeRotation() {
  drawCountryGlobe();
}

function pauseCountryGlobeAutoSpin() {
  countryGlobeAutoSpinPausedUntil = performance.now() + GLOBE_AUTOSPIN_RESUME_DELAY_MS;
}

function setCountryGlobeZoom(nextZoom) {
  countryGlobeZoom = clamp(nextZoom, GLOBE_ZOOM_MIN, GLOBE_ZOOM_MAX);
  updateGlobeScale();
  pauseCountryGlobeAutoSpin();
  updateCountryGlobeHoverTooltip();
}

function globeVector(location) {
  const lat = location[0] * Math.PI / 180;
  const lon = location[1] * Math.PI / 180 - Math.PI;
  const cosLat = Math.cos(lat);
  return [
    -cosLat * Math.cos(lon),
    Math.sin(lat),
    cosLat * Math.sin(lon),
  ];
}

function rotateGlobeVector(vector) {
  const [x, y, z] = vector;
  const cosTheta = Math.cos(countryGlobeTheta);
  const sinTheta = Math.sin(countryGlobeTheta);
  const cosPhi = Math.cos(countryGlobePhi);
  const sinPhi = Math.sin(countryGlobePhi);
  return {
    x: cosPhi * x + sinPhi * z,
    y: sinPhi * sinTheta * x + cosTheta * y - cosPhi * sinTheta * z,
    z: -sinPhi * cosTheta * x + sinTheta * y + cosPhi * cosTheta * z,
  };
}

function inverseRotateGlobeVector(vector) {
  const { x, y, z } = vector;
  const cosTheta = Math.cos(countryGlobeTheta);
  const sinTheta = Math.sin(countryGlobeTheta);
  const cosPhi = Math.cos(countryGlobePhi);
  const sinPhi = Math.sin(countryGlobePhi);
  return {
    x: cosPhi * x + sinPhi * sinTheta * y - sinPhi * cosTheta * z,
    y: cosTheta * y + sinTheta * z,
    z: sinPhi * x - cosPhi * sinTheta * y + cosPhi * cosTheta * z,
  };
}

function getGlobeFrame() {
  const { width, height } = getGlobeSize();
  return {
    width,
    height,
    centerX: width / 2,
    centerY: height / 2,
    radius: Math.min(width, height) * 0.43 * getGlobeScale(),
  };
}

function getGlobeRenderState() {
  return {
    frame: getGlobeFrame(),
    cosTheta: Math.cos(countryGlobeTheta),
    sinTheta: Math.sin(countryGlobeTheta),
    cosPhi: Math.cos(countryGlobePhi),
    sinPhi: Math.sin(countryGlobePhi),
  };
}

function projectGlobeLocation(location) {
  if (!countryGlobeCanvas) return null;
  const frame = getGlobeFrame();
  const projected = rotateGlobeVector(globeVector(location));

  return {
    visible: projected.z >= GLOBE_HORIZON_VISIBLE_Z,
    x: frame.centerX + projected.x * frame.radius,
    y: frame.centerY - projected.y * frame.radius,
    z: projected.z,
  };
}

function projectRenderablePoint(point, state) {
  const projectedX = state.cosPhi * point.x + state.sinPhi * point.z;
  const projectedY = state.sinPhi * state.sinTheta * point.x +
    state.cosTheta * point.y -
    state.cosPhi * state.sinTheta * point.z;
  const projectedZ = -state.sinPhi * state.cosTheta * point.x +
    state.sinTheta * point.y +
    state.cosPhi * state.cosTheta * point.z;
  return {
    visible: projectedZ >= GLOBE_HORIZON_VISIBLE_Z,
    x: state.frame.centerX + projectedX * state.frame.radius,
    y: state.frame.centerY - projectedY * state.frame.radius,
    z: projectedZ,
  };
}

function interpolateProjectedPoint(a, b, threshold = GLOBE_HORIZON_VISIBLE_Z) {
  const denominator = b.z - a.z;
  const t = denominator === 0 ? 0 : clamp((threshold - a.z) / denominator, 0, 1);
  return {
    visible: true,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: threshold,
  };
}

function clipProjectedRingToHorizon(projectedRing) {
  if (projectedRing.length < GLOBE_MIN_RING_POINTS) return [];
  const clipped = [];

  for (let i = 0; i < projectedRing.length; i++) {
    const current = projectedRing[i];
    const next = projectedRing[(i + 1) % projectedRing.length];
    const currentVisible = current.z >= GLOBE_HORIZON_VISIBLE_Z;
    const nextVisible = next.z >= GLOBE_HORIZON_VISIBLE_Z;

    if (currentVisible) clipped.push(current);
    if (currentVisible !== nextVisible) {
      clipped.push(interpolateProjectedPoint(current, next));
    }
  }

  return clipped;
}

function drawCountryGeometry(entry, fillStyle, strokeStyle, lineWidth, state) {
  const ctx = countryGlobeCtx;
  if (!ctx || !entry.renderPolygons?.length) return false;
  let drewFill = false;
  let drewStroke = false;

  ctx.fillStyle = fillStyle;
  ctx.beginPath();
  for (const polygon of entry.renderPolygons) {
    for (const ring of polygon) {
      const projectedRing = ring.map((point) => projectRenderablePoint(point, state));
      const clippedRing = clipProjectedRingToHorizon(projectedRing);
      if (clippedRing.length < GLOBE_MIN_RING_POINTS) continue;
      ctx.moveTo(clippedRing[0].x, clippedRing[0].y);
      for (let i = 1; i < clippedRing.length; i++) {
        ctx.lineTo(clippedRing[i].x, clippedRing[i].y);
      }
      ctx.closePath();
      drewFill = true;
    }
  }
  if (drewFill) {
    ctx.fill("evenodd");
  }

  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  for (const polygon of entry.renderPolygons) {
    for (const ring of polygon) {
      let started = false;
      let visiblePoints = 0;
      let allVisible = true;
      for (const point of ring) {
        const projected = projectRenderablePoint(point, state);
        if (!projected.visible) {
          allVisible = false;
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(projected.x, projected.y);
          started = true;
        } else {
          ctx.lineTo(projected.x, projected.y);
        }
        visiblePoints += 1;
      }
      if (started && allVisible) ctx.closePath();
      if (visiblePoints >= 2) drewStroke = true;
    }
  }
  if (drewStroke) {
    ctx.stroke();
  }

  return drewFill || drewStroke;
}

function getCountryFill(code, isHover = false) {
  const count = countryCounts[code] || 0;
  if (count <= 0) return isHover ? "rgba(51, 65, 85, 0.78)" : GLOBE_EMPTY_COUNTRY_FILL;
  const intensity = countryHeatIntensity(count);
  return colorString(heatColor(intensity), isHover ? 0.98 : 0.82);
}

function drawCountryGlobe() {
  const ctx = countryGlobeCtx;
  if (!ctx || !countryGlobeCanvas) return;

  const state = getGlobeRenderState();
  const { frame } = state;
  ctx.clearRect(0, 0, frame.width, frame.height);

  const glow = ctx.createRadialGradient(
    frame.centerX,
    frame.centerY,
    frame.radius * 0.2,
    frame.centerX,
    frame.centerY,
    frame.radius * 1.22,
  );
  glow.addColorStop(0, "rgba(14, 165, 233, 0.16)");
  glow.addColorStop(0.72, "rgba(20, 184, 166, 0.08)");
  glow.addColorStop(1, "rgba(15, 23, 42, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(frame.centerX, frame.centerY, frame.radius * 1.2, 0, Math.PI * 2);
  ctx.fill();

  const ocean = ctx.createRadialGradient(
    frame.centerX - frame.radius * 0.28,
    frame.centerY - frame.radius * 0.32,
    frame.radius * 0.12,
    frame.centerX,
    frame.centerY,
    frame.radius,
  );
  ocean.addColorStop(0, "rgba(15, 118, 148, 0.35)");
  ocean.addColorStop(0.5, GLOBE_SPHERE_FILL);
  ocean.addColorStop(1, "#020617");

  ctx.save();
  ctx.beginPath();
  ctx.arc(frame.centerX, frame.centerY, frame.radius, 0, Math.PI * 2);
  ctx.fillStyle = ocean;
  ctx.fill();
  ctx.clip();

  for (const entry of countryGlobeSortedFeatures) {
    const isHover = countryGlobeHoverEntry === entry;
    drawCountryGeometry(
      entry,
      getCountryFill(entry.code, isHover),
      isHover ? GLOBE_HOVER_BORDER_COLOR : GLOBE_BORDER_COLOR,
      isHover ? 1.5 : 0.65,
      state,
    );
  }

  ctx.restore();
  ctx.beginPath();
  ctx.arc(frame.centerX, frame.centerY, frame.radius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(125, 211, 252, 0.34)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function unprojectGlobePointer(pointer) {
  if (!countryGlobeCanvas || !pointer) return null;
  const frame = getGlobeFrame();
  const rect = countryGlobeCanvas.getBoundingClientRect();
  const x = (pointer.clientX - rect.left - frame.centerX) / frame.radius;
  const y = -(pointer.clientY - rect.top - frame.centerY) / frame.radius;
  const distanceSquared = x * x + y * y;
  if (distanceSquared > 1) return null;
  const z = Math.sqrt(1 - distanceSquared);
  const world = inverseRotateGlobeVector({ x, y, z });
  const lat = Math.asin(clamp(world.y, -1, 1)) * 180 / Math.PI;
  const lon = normalizeLongitude((Math.atan2(world.z, -world.x) + Math.PI) * 180 / Math.PI);
  return { lat, lon };
}

function ringContainsLonLat(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = normalizeLongitude(ring[i].lon ?? ring[i][0]);
    const yi = Number(ring[i].lat ?? ring[i][1]);
    const xj = normalizeLongitude(ring[j].lon ?? ring[j][0]);
    const yj = Number(ring[j].lat ?? ring[j][1]);
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
    const intersects = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function featureContainsLonLat(entry, lon, lat) {
  for (const polygon of entry.renderPolygons || []) {
    if (!Array.isArray(polygon) || polygon.length === 0) continue;
    if (!ringContainsLonLat(polygon[0], lon, lat)) continue;
    const inHole = polygon.slice(1).some((ring) => ringContainsLonLat(ring, lon, lat));
    if (!inHole) return true;
  }
  return false;
}

function findCountryAtPointer(pointer) {
  const location = unprojectGlobePointer(pointer);
  if (!location) return null;
  for (const entry of countryGlobeFeatures) {
    if (featureContainsLonLat(entry, location.lon, location.lat)) {
      return entry;
    }
  }
  return null;
}

function formatPercent(value) {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  if (value < 0.001) return "<0.1%";
  return `${(value * 100).toFixed(value < 0.01 ? 1 : 0)}%`;
}

function hideCountryGlobeTooltip() {
  const tooltip = document.getElementById("country-globe-tooltip");
  if (!tooltip) return;
  tooltip.classList.add("hidden");
}

function updateCountryGlobeHoverTooltip(pointer = countryGlobeLastHoverPointer) {
  const globeEl = document.getElementById("country-globe");
  const tooltip = document.getElementById("country-globe-tooltip");
  if (!globeEl || !tooltip || !countryGlobeCanvas || !pointer || countryGlobeIsDragging) {
    countryGlobeHoverEntry = null;
    hideCountryGlobeTooltip();
    return;
  }

  const globeRect = globeEl.getBoundingClientRect();
  const canvasRect = countryGlobeCanvas.getBoundingClientRect();
  const entry = findCountryAtPointer(pointer);
  if (!entry) {
    const hadHover = Boolean(countryGlobeHoverEntry);
    countryGlobeHoverEntry = null;
    hideCountryGlobeTooltip();
    if (hadHover) drawCountryGlobe();
    return;
  }
  const hoverChanged = countryGlobeHoverEntry !== entry;
  countryGlobeHoverEntry = entry;

  const count = countryCounts[entry.code] || 0;
  const share = totalCountryCount > 0 ? count / totalCountryCount : 0;
  const unknownLine = entry.code === "SO" && countryUnknownCount > 0
    ? `<div class="text-slate-500">${countryUnknownCount.toLocaleString()} unknown-location client${countryUnknownCount === 1 ? "" : "s"} included</div>`
    : "";
  tooltip.innerHTML = `
    <div class="font-semibold">${escapeHtml(entry.name)}</div>
    <div class="text-slate-400">${escapeHtml(entry.code)} · ${count.toLocaleString()} client${count === 1 ? "" : "s"}</div>
    <div class="text-slate-500">${formatPercent(share)} of plotted clients</div>
    ${unknownLine}
  `;
  const projected = projectGlobeLocation(entry.location);
  tooltip.style.left = `${canvasRect.left - globeRect.left + (projected?.x || 0)}px`;
  tooltip.style.top = `${canvasRect.top - globeRect.top + (projected?.y || 0)}px`;
  tooltip.classList.remove("hidden");
  if (hoverChanged) drawCountryGlobe();
}

function bindCountryGlobeControls() {
  document.getElementById("country-globe-zoom-in")?.addEventListener("click", () => {
    setCountryGlobeZoom(countryGlobeZoom * GLOBE_ZOOM_STEP);
  });
  document.getElementById("country-globe-zoom-out")?.addEventListener("click", () => {
    setCountryGlobeZoom(countryGlobeZoom / GLOBE_ZOOM_STEP);
  });
  document.getElementById("country-globe-zoom-reset")?.addEventListener("click", () => {
    setCountryGlobeZoom(1);
  });
}

function bindCountryGlobeDrag() {
  if (!countryGlobeCanvas) return;

  countryGlobeCanvas.addEventListener("pointerdown", (event) => {
    countryGlobeIsDragging = true;
    countryGlobeLastPointer = { x: event.clientX, y: event.clientY };
    countryGlobeAutoSpinPausedUntil = Number.POSITIVE_INFINITY;
    countryGlobeCanvas.classList.add("is-dragging");
    countryGlobeHoverEntry = null;
    hideCountryGlobeTooltip();
    countryGlobeCanvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  countryGlobeCanvas.addEventListener("pointermove", (event) => {
    countryGlobeLastHoverPointer = event;
    if (!countryGlobeIsDragging || !countryGlobeLastPointer) {
      const now = performance.now();
      if (now - countryGlobeLastHoverFrameAt >= GLOBE_HOVER_FRAME_MS) {
        countryGlobeLastHoverFrameAt = now;
        updateCountryGlobeHoverTooltip(event);
      }
      return;
    }
    const dx = event.clientX - countryGlobeLastPointer.x;
    const dy = event.clientY - countryGlobeLastPointer.y;
    countryGlobeLastPointer = { x: event.clientX, y: event.clientY };
    countryGlobePhi += dx * GLOBE_DRAG_SENSITIVITY;
    countryGlobeTheta = clamp(
      countryGlobeTheta + dy * GLOBE_DRAG_SENSITIVITY,
      GLOBE_MIN_THETA,
      GLOBE_MAX_THETA,
    );
    updateGlobeRotation();
    event.preventDefault();
  });

  const endDrag = (event) => {
    if (!countryGlobeIsDragging) return;
    countryGlobeIsDragging = false;
    countryGlobeLastPointer = null;
    countryGlobeAutoSpinPausedUntil = performance.now() + GLOBE_AUTOSPIN_RESUME_DELAY_MS;
    countryGlobeCanvas.classList.remove("is-dragging");
    if (countryGlobeCanvas.hasPointerCapture?.(event.pointerId)) {
      countryGlobeCanvas.releasePointerCapture(event.pointerId);
    }
  };

  countryGlobeCanvas.addEventListener("pointerup", endDrag);
  countryGlobeCanvas.addEventListener("pointercancel", endDrag);
  countryGlobeCanvas.addEventListener("lostpointercapture", endDrag);
  countryGlobeCanvas.addEventListener("pointerleave", () => {
    countryGlobeLastHoverPointer = null;
    countryGlobeHoverEntry = null;
    hideCountryGlobeTooltip();
    drawCountryGlobe();
  });
  countryGlobeCanvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const direction = event.deltaY < 0 ? GLOBE_ZOOM_STEP : 1 / GLOBE_ZOOM_STEP;
      setCountryGlobeZoom(countryGlobeZoom * direction);
    },
    { passive: false },
  );
}

function animateCountryGlobe(timestamp = performance.now()) {
  if (!countryGlobeCtx) return;
  if (document.hidden) {
    countryGlobeFrame = requestAnimationFrame(animateCountryGlobe);
    return;
  }
  const shouldSpin = !countryGlobeIsDragging && timestamp >= countryGlobeAutoSpinPausedUntil;
  if (shouldSpin && timestamp - countryGlobeLastSpinFrameAt >= GLOBE_AUTOSPIN_FRAME_MS) {
    countryGlobePhi += GLOBE_AUTOSPIN_SPEED;
    countryGlobeLastSpinFrameAt = timestamp;
    updateGlobeRotation();
  }
  if (countryGlobeLastHoverPointer && timestamp - countryGlobeLastHoverFrameAt >= GLOBE_HOVER_FRAME_MS) {
    countryGlobeLastHoverFrameAt = timestamp;
    updateCountryGlobeHoverTooltip();
  }
  countryGlobeFrame = requestAnimationFrame(animateCountryGlobe);
}

async function initCountryMap() {
  countryGlobeCanvas = document.getElementById("country-globe-canvas");
  if (!countryGlobeCanvas) return;
  countryGlobeCtx = countryGlobeCanvas.getContext("2d");
  updateGlobeSize();

  countryGlobeResizeObserver = new ResizeObserver(updateGlobeSize);
  countryGlobeResizeObserver.observe(countryGlobeCanvas);
  bindCountryGlobeControls();
  bindCountryGlobeDrag();
  countryGlobeFrame = requestAnimationFrame(animateCountryGlobe);

  await loadCountryLocations();
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
  if (!metricsPageActive) return;
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
    if (!metricsPageActive) return;
    updateMetrics(data.snapshot, data.debug);
    updateCharts(data.history, data.snapshot);

    document.getElementById("status-text").textContent = "Live";
    const status = document.getElementById("metrics-status");
    status?.classList.remove("bg-red-500/10", "text-red-300", "border-red-500/30");
    status?.classList.add("bg-emerald-500/10", "text-emerald-300", "border-emerald-500/30");
  } catch (err) {
    if (!metricsPageActive) return;
    console.error("Error fetching metrics:", err);
    document.getElementById("status-text").textContent = "Unavailable";
    const status = document.getElementById("metrics-status");
    status?.classList.remove("bg-emerald-500/10", "text-emerald-300", "border-emerald-500/30");
    status?.classList.add("bg-red-500/10", "text-red-300", "border-red-500/30");
  }
}

async function checkAuth() {
  try {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    if (!metricsPageActive) return;
    if (!res.ok) {
      window.location.href = "/";
      return;
    }

    const data = await res.json();
    if (!metricsPageActive) return;
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

async function initMetricsPage() {
  await checkAuth();
  if (!metricsPageActive) return;

  initCharts();

  await initCountryMap();
  if (!metricsPageActive) return;

  await fetchMetrics();

  metricsPollTimer = setInterval(fetchMetrics, METRICS_POLL_INTERVAL_MS);

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
}

function teardownMetricsPage() {
  metricsPageActive = false;
  if (metricsPollTimer !== null) clearInterval(metricsPollTimer);
  metricsPollTimer = null;
  if (countryGlobeFrame !== null) cancelAnimationFrame(countryGlobeFrame);
  countryGlobeFrame = null;
  countryGlobeResizeObserver?.disconnect();
  countryGlobeResizeObserver = null;
  countryGlobeCtx = null;
  countryGlobeCanvas = null;
  for (const chart of [
    clientsChart,
    commandsChart,
    bandwidthChart,
    httpRequestsChart,
    httpChart,
    memoryChart,
    eventLoopChart,
    sessionsChart,
    osChart,
  ]) {
    chart?.destroy();
  }
}

window.addEventListener("pagehide", teardownMetricsPage, { once: true });

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initMetricsPage, { once: true });
} else {
  void initMetricsPage();
}
