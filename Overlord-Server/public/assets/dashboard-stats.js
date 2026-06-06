let initialized = false;
let metricsTimer = null;
let onlineChart = null;
let osChart = null;
const STATS_COLLAPSED_KEY = "overlord_dashboard_stats_collapsed";
const STATS_HEIGHT_KEY = "overlord_dashboard_stats_height";
const STATS_ORDER_KEY = "overlord_dashboard_stats_order";
const STATS_LAYOUT_KEY = "overlord_dashboard_stats_gridstack_layout";
const STATS_HIDDEN_KEY = "overlord_dashboard_stats_hidden";
const PULSE_ORDER_KEY = "overlord_dashboard_pulse_order";
const DEFAULT_STATS_HEIGHT = 142;
const MIN_STATS_HEIGHT = 112;
const MAX_STATS_HEIGHT = 280;
const DEFAULT_CARD_ORDER = ["online", "sessions", "trend", "fleet", "pulse"];
const DEFAULT_PULSE_ORDER = ["api", "memory", "ping"];
const DEFAULT_GRID_LAYOUT = {
  online: { x: 0, y: 0, w: 2, h: 2 },
  sessions: { x: 2, y: 0, w: 2, h: 2 },
  trend: { x: 4, y: 0, w: 3, h: 2 },
  fleet: { x: 7, y: 0, w: 3, h: 2 },
  pulse: { x: 10, y: 0, w: 2, h: 2 },
};
let statsGrid = null;

function teardownDashboardStats() {
  if (metricsTimer) clearInterval(metricsTimer);
  metricsTimer = null;
  onlineChart?.destroy?.();
  osChart?.destroy?.();
  onlineChart = null;
  osChart = null;
  statsGrid?.destroy?.(false);
  statsGrid = null;
  initialized = false;
}

const palette = {
  text: "#cbd5e1",
  muted: "#94a3b8",
  border: "rgba(100, 116, 139, 0.18)",
  panel: "rgba(15, 23, 42, 0.96)",
  cyan: "#22d3ee",
  emerald: "#22c55e",
  sky: "#38bdf8",
  indigo: "#818cf8",
  amber: "#fbbf24",
  rose: "#fb7185",
  violet: "#a78bfa",
  slate: "#64748b",
};

const osColors = [
  palette.sky,
  palette.emerald,
  palette.violet,
  palette.amber,
  palette.rose,
  palette.cyan,
  palette.indigo,
  palette.slate,
];

function $(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function formatNumber(value) {
  const n = Number(value) || 0;
  return n.toLocaleString();
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, idx)).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatTime(timestamp) {
  return new Date(timestamp || Date.now()).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatWeekLabel(timestamp) {
  const date = new Date(timestamp || Date.now());
  return date.toLocaleDateString([], {
    weekday: "short",
    hour: "2-digit",
  });
}

function compactRepeatedTickLabel(value, index, ticks) {
  const labelFor = (tickValue) => {
    const labels = this?.chart?.data?.labels || [];
    return labels[Number(tickValue)] ?? this?.getLabelForValue?.(tickValue) ?? "";
  };
  const labels = (ticks || []).map((tick) => labelFor(tick.value));
  const current = labels[index] || labelFor(value);
  if (!current) return "";
  const isRunStart = index === 0 || labels[index - 1] !== current;
  const isRunEnd = index === labels.length - 1 || labels[index + 1] !== current;
  return isRunStart || isRunEnd ? current : "";
}

function aggregateOnlineHistory(history, snapshot) {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const source = Array.isArray(history)
    ? history.filter((row) => Number(row?.timestamp) >= weekAgo)
    : [];
  const rows = source.length
    ? source
    : [{ timestamp: now, clientsOnline: snapshot?.clients?.online || 0 }];
  const maxPoints = 84;
  if (rows.length <= maxPoints) return rows;

  const bucketMs = Math.max(
    60 * 60 * 1000,
    Math.ceil((now - weekAgo) / maxPoints),
  );
  const buckets = new Map();
  for (const row of rows) {
    const ts = Number(row.timestamp) || now;
    const key = Math.floor(ts / bucketMs) * bucketMs;
    const bucket = buckets.get(key) || { timestamp: key, total: 0, count: 0, peak: 0 };
    const online = Number(row.clientsOnline) || 0;
    bucket.total += online;
    bucket.count += 1;
    bucket.peak = Math.max(bucket.peak, online);
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((bucket) => ({
      timestamp: bucket.timestamp,
      clientsOnline: Math.round(bucket.total / Math.max(1, bucket.count)),
      clientsPeak: bucket.peak,
    }));
}

function setDotTone(id, tone) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle("is-live", tone === "live");
  el.classList.toggle("is-warn", tone === "warn");
  el.classList.toggle("is-bad", tone === "bad");
  el.classList.toggle("is-muted", tone === "muted");
}

function topEntries(record, limit = 6) {
  return Object.entries(record || {})
    .map(([key, value]) => [key || "Unknown", Number(value) || 0])
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function compactOsLabel(os) {
  const text = String(os || "Unknown");
  const lower = text.toLowerCase();
  if (lower.includes("windows 11")) return "Win 11";
  if (lower.includes("windows 10")) return "Win 10";
  if (lower.includes("windows")) return "Windows";
  if (lower.includes("darwin") || lower.includes("mac")) return "macOS";
  if (lower.includes("ubuntu")) return "Ubuntu";
  if (lower.includes("debian")) return "Debian";
  if (lower.includes("kali")) return "Kali";
  if (lower.includes("fedora")) return "Fedora";
  if (lower.includes("linux")) return "Linux";
  return text.length > 16 ? `${text.slice(0, 15)}...` : text;
}

function configureChartDefaults() {
  if (typeof Chart === "undefined") return false;
  Chart.defaults.color = palette.text;
  Chart.defaults.borderColor = palette.border;
  Chart.defaults.font.family = "Inter, Segoe UI, system-ui, sans-serif";
  return true;
}

function createGradient(ctx, color) {
  const gradient = ctx.createLinearGradient(0, 0, 0, 150);
  gradient.addColorStop(0, `${color}55`);
  gradient.addColorStop(0.72, `${color}12`);
  gradient.addColorStop(1, `${color}00`);
  return gradient;
}

function makeCharts() {
  if (!configureChartDefaults()) return false;
  const onlineCanvas = $("dash-online-chart");
  const osCanvas = $("dash-os-chart");
  if (!onlineCanvas || !osCanvas) return false;

  const onlineCtx = onlineCanvas.getContext("2d");
  onlineChart = new Chart(onlineCtx, {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: "Online",
        data: [],
        borderColor: palette.emerald,
        backgroundColor: createGradient(onlineCtx, palette.emerald),
        borderWidth: 2,
        fill: true,
        tension: 0.38,
        pointRadius: 0,
        pointHoverRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 260 },
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: palette.panel,
          borderColor: "rgba(34, 197, 94, 0.34)",
          borderWidth: 1,
          titleColor: "#e2e8f0",
          bodyColor: palette.text,
          displayColors: false,
          callbacks: {
            label: (ctx) => `Avg online: ${ctx.parsed.y}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: palette.muted,
            maxRotation: 0,
            maxTicksLimit: 5,
            callback: compactRepeatedTickLabel,
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(100, 116, 139, 0.1)" },
          ticks: { color: palette.muted, precision: 0, maxTicksLimit: 4 },
        },
      },
    },
  });

  osChart = new Chart(osCanvas, {
    type: "doughnut",
    data: {
      labels: [],
      datasets: [{
        data: [],
        backgroundColor: osColors,
        borderColor: "rgba(2, 6, 23, 0.9)",
        borderWidth: 3,
        hoverOffset: 5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 260 },
      cutout: "66%",
      layout: {
        padding: { top: 2, right: 4, bottom: 10, left: 4 },
      },
      plugins: {
        legend: {
          position: "right",
          labels: {
            boxWidth: 9,
            boxHeight: 9,
            color: palette.text,
            padding: 10,
            font: { size: 11 },
          },
        },
        tooltip: {
          backgroundColor: palette.panel,
          borderColor: "rgba(129, 140, 248, 0.32)",
          borderWidth: 1,
          titleColor: "#e2e8f0",
          bodyColor: palette.text,
        },
      },
    },
  });
  return true;
}

function getSavedHeight() {
  return normalizeHeight(localStorage.getItem(STATS_HEIGHT_KEY) || DEFAULT_STATS_HEIGHT);
}

function normalizeHeight(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_STATS_HEIGHT;
  return Math.min(MAX_STATS_HEIGHT, Math.max(MIN_STATS_HEIGHT, n));
}

function applyHeightMode(height) {
  const shell = $("dashboard-stats");
  if (!shell) return;
  shell.classList.toggle("is-compact", height < 142);
  shell.classList.toggle("is-tiny", height < 122);

  const healthRows = Array.from(shell.querySelectorAll(".dashboard-health-row"));
  const visibleCount = height < 122 ? 1 : height < 146 ? 2 : healthRows.length;
  healthRows.forEach((row, index) => {
    row.classList.toggle("is-hidden", index >= visibleCount);
  });

  if (osChart) {
    const nextDisplay = height >= 172;
    if (osChart.options.plugins.legend.display !== nextDisplay) {
      osChart.options.plugins.legend.display = nextDisplay;
      osChart.update("none");
    }
  }
}

function getStatsCellHeight() {
  return Math.max(48, Math.round(getSavedHeight() / 2));
}

function resizeCharts() {
  requestAnimationFrame(() => {
    onlineChart?.resize();
    osChart?.resize();
  });
}

function syncStatsWidgetHeights() {
  if (!statsGrid?.engine?.nodes) return;
  const cellHeight = Number(statsGrid.opts?.cellHeight) || getStatsCellHeight();
  for (const node of statsGrid.engine.nodes) {
    const content = node.el?.querySelector?.(".grid-stack-item-content");
    if (!content) continue;
    const estimated = Math.max(64, (Number(node.h) || 2) * cellHeight - 12);
    content.style.setProperty("--dashboard-stats-height", `${estimated}px`);
  }
}

function readSavedGridLayout() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STATS_LAYOUT_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => DEFAULT_CARD_ORDER.includes(item?.id))
      .map((item) => ({
        id: item.id,
        x: Math.max(0, Number(item.x) || 0),
        y: Math.max(0, Number(item.y) || 0),
        w: Math.max(1, Number(item.w) || DEFAULT_GRID_LAYOUT[item.id]?.w || 2),
        h: Math.max(1, Number(item.h) || DEFAULT_GRID_LAYOUT[item.id]?.h || 2),
      }));
  } catch {
    return [];
  }
}

function readHiddenStatsCards() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STATS_HIDDEN_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => DEFAULT_CARD_ORDER.includes(id));
  } catch {
    return [];
  }
}

function saveHiddenStatsCards(hidden) {
  const cleaned = Array.from(hidden).filter((id) => DEFAULT_CARD_ORDER.includes(id));
  localStorage.setItem(STATS_HIDDEN_KEY, JSON.stringify(cleaned));
}

function isStatsGridManaged(el) {
  return !!statsGrid?.engine?.nodes?.some((node) => node.el === el);
}

function saveStatsGridLayout() {
  if (!statsGrid?.engine?.nodes) return;
  const layoutMap = new Map(
    DEFAULT_CARD_ORDER.map((id) => [id, { id, ...DEFAULT_GRID_LAYOUT[id] }]),
  );

  for (const item of readSavedGridLayout()) {
    layoutMap.set(item.id, item);
  }

  for (const node of statsGrid.engine.nodes) {
    const id = node.el?.dataset?.dashboardCard || node.id;
    if (!DEFAULT_CARD_ORDER.includes(id)) continue;
    layoutMap.set(id, { id, x: node.x, y: node.y, w: node.w, h: node.h });
  }

  const layout = DEFAULT_CARD_ORDER.map((id) => layoutMap.get(id));
  localStorage.setItem(STATS_LAYOUT_KEY, JSON.stringify(layout));
}

function applyGridLayout(layout) {
  if (!statsGrid) return;
  statsGrid.batchUpdate();
  for (const item of layout) {
    const el = document.querySelector(`[data-dashboard-card="${item.id}"]`);
    if (el) statsGrid.update(el, { x: item.x, y: item.y, w: item.w, h: item.h });
  }
  statsGrid.batchUpdate(false);
  syncStatsWidgetHeights();
  resizeCharts();
}

function setStatsCardHidden(id, hidden, persist = true) {
  if (!DEFAULT_CARD_ORDER.includes(id)) return;
  const el = document.querySelector(`[data-dashboard-card="${id}"]`);
  if (!el) return;

  if (hidden) {
    if (statsGrid && isStatsGridManaged(el)) statsGrid.removeWidget(el, false);
    el.classList.add("dashboard-card-hidden");
  } else {
    el.classList.remove("dashboard-card-hidden");
    if (statsGrid && !isStatsGridManaged(el)) {
      statsGrid.makeWidget(el);
      const layout = readSavedGridLayout().find((item) => item.id === id);
      statsGrid.update(el, { ...(layout || DEFAULT_GRID_LAYOUT[id]) });
    }
  }

  if (persist) {
    const nextHidden = new Set(readHiddenStatsCards());
    if (hidden) nextHidden.add(id);
    else nextHidden.delete(id);
    saveHiddenStatsCards(nextHidden);
    saveStatsGridLayout();
  }

  syncStatsWidgetHeights();
  resizeCharts();
}

function applyHiddenStatsCards() {
  const hidden = new Set(readHiddenStatsCards());
  for (const id of DEFAULT_CARD_ORDER) {
    setStatsCardHidden(id, hidden.has(id), false);
  }
}

function syncStatsCardMenu() {
  const panel = $("dashboard-card-menu-panel");
  if (!panel) return;
  const hidden = new Set(readHiddenStatsCards());
  panel.querySelectorAll("[data-dashboard-card-toggle]").forEach((input) => {
    const id = input.dataset.dashboardCardToggle;
    input.checked = !hidden.has(id);
  });
}

function initStatsCardMenu() {
  const menu = $("dashboard-card-menu");
  const panel = $("dashboard-card-menu-panel");
  if (!panel || panel.dataset.bound === "true") return;

  panel.dataset.bound = "true";
  syncStatsCardMenu();
  panel.querySelectorAll("[data-dashboard-card-toggle]").forEach((input) => {
    input.addEventListener("change", () => {
      setStatsCardHidden(input.dataset.dashboardCardToggle, !input.checked);
    });
  });

  menu?.addEventListener("toggle", () => {
    if (menu.open) syncStatsCardMenu();
  });
}

function applySavedGridLayout() {
  const saved = readSavedGridLayout();
  if (saved.length) {
    applyGridLayout(saved);
    return;
  }

  // Preserve older drag-only ordering by converting it into default-size widgets.
  const order = readSavedOrder();
  if (!order.length || order.join("|") === DEFAULT_CARD_ORDER.join("|")) return;
  const migrated = order.map((id, index) => ({
    id,
    ...(DEFAULT_GRID_LAYOUT[id] || { w: 2, h: 2 }),
    x: index === 0 ? 0 : undefined,
    y: index === 0 ? 0 : undefined,
  }));
  let x = 0;
  for (const item of migrated) {
    const width = item.w || 2;
    if (x + width > 12) x = 0;
    item.x = x;
    item.y = 0;
    x += width;
  }
  applyGridLayout(migrated);
}

function resetStatsGridLayout() {
  localStorage.removeItem(STATS_LAYOUT_KEY);
  localStorage.removeItem(STATS_HIDDEN_KEY);
  for (const id of DEFAULT_CARD_ORDER) {
    setStatsCardHidden(id, false, false);
  }
  syncStatsCardMenu();
  if (!statsGrid) {
    const content = $("dashboard-stats-content");
    if (content) applySavedOrder(content);
    return;
  }
  applyGridLayout(DEFAULT_CARD_ORDER.map((id) => ({ id, ...DEFAULT_GRID_LAYOUT[id] })));
}

function initStatsGrid(content) {
  if (!content || content.dataset.gridstackBound === "true") return;
  const api = window.GridStack?.GridStack || window.GridStack;
  if (typeof api?.init !== "function") {
    applySavedOrder(content);
    applyHiddenStatsCards();
    return;
  }

  content.dataset.gridstackBound = "true";
  statsGrid = api.init({
    column: 12,
    cellHeight: getStatsCellHeight(),
    margin: 6,
    animate: true,
    float: false,
    handle: ".grid-stack-item-content",
    draggable: {
      handle: ".grid-stack-item-content",
      appendTo: "body",
      scroll: true,
    },
    resizable: { handles: "se" },
  }, content);

  applySavedGridLayout();
  applyHiddenStatsCards();
  statsGrid.on("change dragstop resizestop", () => {
    syncStatsWidgetHeights();
    saveStatsGridLayout();
    resizeCharts();
  });
  syncStatsWidgetHeights();
  resizeCharts();
}

function updateOnlineChart(history, snapshot) {
  if (!onlineChart) return;
  const rows = aggregateOnlineHistory(history, snapshot);

  onlineChart.data.labels = rows.map((row) => formatWeekLabel(row.timestamp));
  onlineChart.data.datasets[0].data = rows.map((row) => Number(row.clientsOnline) || 0);
  onlineChart.update("none");
}

function updateOsChart(byOS) {
  if (!osChart) return;
  const entries = topEntries(byOS, 7);
  if (!entries.length) {
    osChart.data.labels = ["No clients"];
    osChart.data.datasets[0].data = [1];
    osChart.data.datasets[0].backgroundColor = ["rgba(100, 116, 139, 0.35)"];
    setText("dash-os-leader", "None");
    osChart.update("none");
    return;
  }

  osChart.data.labels = entries.map(([label]) => compactOsLabel(label));
  osChart.data.datasets[0].data = entries.map(([, count]) => count);
  osChart.data.datasets[0].backgroundColor = entries.map((_, index) => osColors[index % osColors.length]);
  setText("dash-os-leader", `${compactOsLabel(entries[0][0])} ${entries[0][1]}`);
  osChart.update("none");
}

function updateSummary(snapshot) {
  const clients = snapshot?.clients || {};
  const online = Number(clients.online) || 0;
  const total = Number(clients.total) || 0;
  const ratio = total > 0 ? Math.round((online / total) * 100) : 0;
  const sessions = snapshot?.sessions || {};
  const activeSessions =
    (Number(sessions.console) || 0) +
    (Number(sessions.remoteDesktop) || 0) +
    (Number(sessions.fileBrowser) || 0) +
    (Number(sessions.process) || 0);

  setText("dash-online-count", formatNumber(online));
  setText("dash-total-count", `${formatNumber(total)} total`);
  setText("dash-online-ratio", `${ratio}%`);
  setText("dash-session-count", formatNumber(activeSessions));
  setText("dash-command-minute", `${formatNumber(snapshot?.commands?.lastMinute)} cmd/min`);
  setText("dash-http-errors", `${formatNumber(snapshot?.http?.lastMinuteErrors)} errors`);

  const mem = Number(snapshot?.server?.systemMemory?.usedPercent) || 0;
  setText("dash-memory-status", `${Math.round(mem)}%`);
  setDotTone("dash-memory-dot", mem >= 90 ? "bad" : mem >= 75 ? "warn" : "live");

  const avgPing = snapshot?.ping?.avg;
  if (Number.isFinite(avgPing)) {
    const rounded = Math.round(avgPing);
    setText("dash-ping-status", `${rounded} ms`);
    setDotTone("dash-ping-dot", rounded >= 150 ? "bad" : rounded >= 80 ? "warn" : "live");
  } else {
    setText("dash-ping-status", "-");
    setDotTone("dash-ping-dot", "muted");
  }

  setText("dash-trend-status", `${formatBytes(snapshot?.bandwidth?.sentPerSecond || 0)}/s out`);
  setText("dash-last-refresh", formatTime(Date.now()));
}

export function updateDashboardStatsFromClients(data) {
  if (!data) return;
  const online = Number(data.online) || 0;
  const total = Number(data.total) || 0;
  const ratio = total > 0 ? Math.round((online / total) * 100) : 0;
  setText("dash-online-count", formatNumber(online));
  setText("dash-total-count", `${formatNumber(total)} total`);
  setText("dash-online-ratio", `${ratio}%`);
}

async function fetchDashboardMetrics() {
  try {
    const res = await fetch("/api/metrics", { credentials: "include" });
    if (!res.ok) throw new Error(`metrics ${res.status}`);
    const data = await res.json();
    const snapshot = data?.snapshot || {};
    updateSummary(snapshot);
    updateOnlineChart(data?.history || [], snapshot);
    updateOsChart(snapshot?.clients?.byOS || {});
    setText("dash-api-status", "Live");
  } catch (err) {
    console.warn("dashboard stats failed", err);
    setText("dash-api-status", "Error");
    setText("dash-last-refresh", "Error");
  }
}

export function initDashboardStats() {
  if (initialized) return;
  initialized = true;
  window.removeEventListener("pagehide", teardownDashboardStats);
  window.addEventListener("pagehide", teardownDashboardStats);
  if (!makeCharts()) {
    setTimeout(() => {
      if (makeCharts()) applyHeightMode(getSavedHeight());
    }, 150);
  }
  initStatsToggle();
  fetchDashboardMetrics();
  metricsTimer = setInterval(fetchDashboardMetrics, 5000);
}

function initStatsToggle() {
  const shell = $("dashboard-stats");
  const button = $("dashboard-stats-toggle");
  const resetButton = $("dashboard-stats-reset");
  const resizer = $("dashboard-stats-resizer");
  if (!shell || !button) return;

  const setHeight = (value, persist = true) => {
    const height = normalizeHeight(value);
    shell.style.setProperty("--dashboard-stats-height", `${height}px`);
    resizer?.setAttribute("aria-valuenow", String(height));
    if (persist) localStorage.setItem(STATS_HEIGHT_KEY, String(height));
    if (statsGrid) {
      statsGrid.cellHeight(getStatsCellHeight());
      syncStatsWidgetHeights();
    }
    applyHeightMode(height);
    resizeCharts();
  };

  const setCollapsed = (collapsed) => {
    shell.classList.toggle("is-collapsed", collapsed);
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    button.title = collapsed ? "Show status overview" : "Hide status overview";
    button.innerHTML = collapsed
      ? '<i class="fa-solid fa-eye"></i>'
      : '<i class="fa-solid fa-eye-slash"></i>';
    localStorage.setItem(STATS_COLLAPSED_KEY, collapsed ? "true" : "false");
  };

  initStatsGrid($("dashboard-stats-content"));
  initStatsCardMenu();
  initPulseReorder();
  setHeight(getSavedHeight(), false);
  setCollapsed(localStorage.getItem(STATS_COLLAPSED_KEY) === "true");

  let dragStartY = 0;
  let dragStartHeight = DEFAULT_STATS_HEIGHT;

  const stopResize = () => {
    shell.classList.remove("is-resizing");
    resizer?.releasePointerCapture?.(resizer._activePointerId);
    resizer._activePointerId = null;
  };

  resizer?.setAttribute("aria-valuemin", String(MIN_STATS_HEIGHT));
  resizer?.setAttribute("aria-valuemax", String(MAX_STATS_HEIGHT));
  resizer?.addEventListener("pointerdown", (e) => {
    if (shell.classList.contains("is-collapsed")) return;
    dragStartY = e.clientY;
    dragStartHeight = getSavedHeight();
    resizer._activePointerId = e.pointerId;
    resizer.setPointerCapture?.(e.pointerId);
    shell.classList.add("is-resizing");
    e.preventDefault();
  });

  resizer?.addEventListener("pointermove", (e) => {
    if (!shell.classList.contains("is-resizing")) return;
    setHeight(dragStartHeight + (e.clientY - dragStartY));
  });

  resizer?.addEventListener("pointerup", stopResize);
  resizer?.addEventListener("pointercancel", stopResize);
  resizer?.addEventListener("keydown", (e) => {
    if (shell.classList.contains("is-collapsed")) return;
    const current = getSavedHeight();
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHeight(current - 10);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHeight(current + 10);
    } else if (e.key === "Home") {
      e.preventDefault();
      setHeight(MIN_STATS_HEIGHT);
    } else if (e.key === "End") {
      e.preventDefault();
      setHeight(MAX_STATS_HEIGHT);
    }
  });

  resetButton?.addEventListener("click", () => {
    setHeight(DEFAULT_STATS_HEIGHT);
    setCollapsed(false);
    resetStatsGridLayout();
    localStorage.removeItem(STATS_ORDER_KEY);
    localStorage.removeItem(PULSE_ORDER_KEY);
    const pulseList = document.querySelector(".dashboard-health-list");
    if (pulseList) applyPulseOrder(pulseList);
  });

  button.addEventListener("click", () => {
    const nextCollapsed = !shell.classList.contains("is-collapsed");
    setCollapsed(nextCollapsed);
    if (!nextCollapsed) resizeCharts();
  });
}

function readSavedPulseOrder() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PULSE_ORDER_KEY) || "[]");
    if (!Array.isArray(parsed)) return DEFAULT_PULSE_ORDER;
    const cleaned = parsed.filter((id) => DEFAULT_PULSE_ORDER.includes(id));
    return [...cleaned, ...DEFAULT_PULSE_ORDER.filter((id) => !cleaned.includes(id))];
  } catch {
    return DEFAULT_PULSE_ORDER;
  }
}

function savePulseOrder(list) {
  const order = Array.from(list.querySelectorAll("[data-pulse-row]"))
    .map((row) => row.dataset.pulseRow)
    .filter(Boolean);
  localStorage.setItem(PULSE_ORDER_KEY, JSON.stringify(order));
}

function applyPulseOrder(list) {
  const byId = new Map();
  list.querySelectorAll("[data-pulse-row]").forEach((row) => {
    byId.set(row.dataset.pulseRow, row);
  });
  for (const id of readSavedPulseOrder()) {
    const row = byId.get(id);
    if (row) list.appendChild(row);
  }
  applyHeightMode(getSavedHeight());
}

function initPulseReorder() {
  const list = document.querySelector(".dashboard-health-list");
  if (!list || list.dataset.reorderBound === "true") return;
  list.dataset.reorderBound = "true";
  applyPulseOrder(list);

  let dragged = null;

  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest("[data-pulse-row]");
    if (!row) return;
    e.stopPropagation();
    dragged = row;
    row.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", row.dataset.pulseRow || "");
  });

  list.addEventListener("dragover", (e) => {
    if (!dragged) return;
    const target = e.target.closest("[data-pulse-row]");
    if (!target || target === dragged) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    list.insertBefore(dragged, after ? target.nextSibling : target);
    applyHeightMode(getSavedHeight());
  });

  list.addEventListener("drop", (e) => {
    if (!dragged) return;
    e.preventDefault();
    e.stopPropagation();
    savePulseOrder(list);
    applyHeightMode(getSavedHeight());
  });

  list.addEventListener("dragend", (e) => {
    e.stopPropagation();
    dragged?.classList.remove("is-dragging");
    dragged = null;
    savePulseOrder(list);
    applyHeightMode(getSavedHeight());
  });
}

function readSavedOrder() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STATS_ORDER_KEY) || "[]");
    if (!Array.isArray(parsed)) return DEFAULT_CARD_ORDER;
    const cleaned = parsed.filter((id) => DEFAULT_CARD_ORDER.includes(id));
    return [...cleaned, ...DEFAULT_CARD_ORDER.filter((id) => !cleaned.includes(id))];
  } catch {
    return DEFAULT_CARD_ORDER;
  }
}

function saveCurrentOrder(content) {
  const order = Array.from(content.querySelectorAll("[data-dashboard-card]"))
    .map((card) => card.dataset.dashboardCard)
    .filter(Boolean);
  localStorage.setItem(STATS_ORDER_KEY, JSON.stringify(order));
}

function applySavedOrder(content) {
  const byId = new Map();
  content.querySelectorAll("[data-dashboard-card]").forEach((card) => {
    byId.set(card.dataset.dashboardCard, card);
  });
  for (const id of readSavedOrder()) {
    const card = byId.get(id);
    if (card) content.appendChild(card);
  }
}

function initCardReorder() {
  const content = $("dashboard-stats-content");
  if (!content || content.dataset.reorderBound === "true") return;
  content.dataset.reorderBound = "true";
  applySavedOrder(content);

  let dragged = null;

  content.addEventListener("dragstart", (e) => {
    const card = e.target.closest("[data-dashboard-card]");
    if (!card) return;
    dragged = card;
    card.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.dataset.dashboardCard || "");
  });

  content.addEventListener("dragover", (e) => {
    if (!dragged) return;
    const target = e.target.closest("[data-dashboard-card]");
    if (!target || target === dragged) return;
    e.preventDefault();
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2 || e.clientX > rect.left + rect.width / 2;
    content.insertBefore(dragged, after ? target.nextSibling : target);
  });

  content.addEventListener("drop", (e) => {
    if (!dragged) return;
    e.preventDefault();
    saveCurrentOrder(content);
  });

  content.addEventListener("dragend", () => {
    dragged?.classList.remove("is-dragging");
    dragged = null;
    saveCurrentOrder(content);
    requestAnimationFrame(() => {
      onlineChart?.resize();
      osChart?.resize();
    });
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (metricsTimer) clearInterval(metricsTimer);
  });
}
