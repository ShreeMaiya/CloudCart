// CloudCart Monitoring & Observability Frontend Controller

const API_BASE = (window.location.origin.includes("localhost") || window.location.origin.includes("127.0.0.1") || window.location.protocol === "file:") && window.location.port !== "8787"
  ? "http://127.0.0.1:8787/api/monitoring"
  : "/api/monitoring";

// Application State
let activeTab = "overview";
let activeRange = "1h";
let refreshIntervalMs = 30000;
let refreshTimer = null;
let lastData = null;
let cachedEndpoints = [];

// DOM Elements
const timeRangeChips = document.getElementById("timeRangeChips");
const autoRefreshSelect = document.getElementById("autoRefreshSelect");
const manualRefreshBtn = document.getElementById("manualRefreshBtn");
const refreshIcon = document.getElementById("refreshIcon");
const lastUpdatedText = document.getElementById("lastUpdatedText");
const demoBanner = document.getElementById("demoBanner");
const tabButtons = document.querySelectorAll(".tab-btn");
const tabViews = document.querySelectorAll(".tab-view");

// Overview Elements
const overviewHealthIcon = document.getElementById("overviewHealthIcon");
const overviewStatusBadge = document.getElementById("overviewStatusBadge");
const overviewLastChecked = document.getElementById("overviewLastChecked");
const countHealthy = document.getElementById("countHealthy");
const countDegraded = document.getElementById("countDegraded");
const countFailed = document.getElementById("countFailed");
const countTotal = document.getElementById("countTotal");

// Main Metric Values
const valTotalRequests = document.getElementById("valTotalRequests");
const valRequestRate = document.getElementById("valRequestRate");
const valErrorRate = document.getElementById("valErrorRate");
const valAvgLatency = document.getElementById("valAvgLatency");
const valLatencySpread = document.getElementById("valLatencySpread");
const valP99Latency = document.getElementById("valP99Latency");
const valCpuTime = document.getElementById("valCpuTime");
const valActiveWS = document.getElementById("valActiveWS");
const valD1Activity = document.getElementById("valD1Activity");
const valKVActivity = document.getElementById("valKVActivity");

// Overview & Services Tables
const overviewServicesTableBody = document.getElementById("overviewServicesTableBody");
const servicesDetailedTableBody = document.getElementById("servicesDetailedTableBody");

// API Monitoring Elements
const apiSummaryTotalRequests = document.getElementById("apiSummaryTotalRequests");
const apiSummaryErrorRate = document.getElementById("apiSummaryErrorRate");
const apiSummaryErrorsCount = document.getElementById("apiSummaryErrorsCount");
const apiSummaryAvgLatency = document.getElementById("apiSummaryAvgLatency");
const apiSummaryP95Latency = document.getElementById("apiSummaryP95Latency");
const apiSummaryP50P99 = document.getElementById("apiSummaryP50P99");
const apiSummaryWindowLabel = document.getElementById("apiSummaryWindowLabel");

const apiFilterEndpoint = document.getElementById("apiFilterEndpoint");
const apiFilterStatus = document.getElementById("apiFilterStatus");
const apiFilterService = document.getElementById("apiFilterService");
const apiSearchInput = document.getElementById("apiSearchInput");
const apiResetFiltersBtn = document.getElementById("apiResetFiltersBtn");
const apiEndpointsCountLabel = document.getElementById("apiEndpointsCountLabel");
const apiEndpointsTableBody = document.getElementById("apiEndpointsTableBody");
const apiRecentRequestsTableBody = document.getElementById("apiRecentRequestsTableBody");
const refreshRecentRequestsBtn = document.getElementById("refreshRecentRequestsBtn");

// Initialize Monitoring Dashboard
async function initMonitoring() {
  setupEventListeners();
  setupAutoRefresh();
  await refreshAllMetrics();
  await loadApiMetrics();
  await loadRecentRequests();
}

function setupEventListeners() {
  // Tab Switching
  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const tabName = btn.dataset.tab;
      switchTab(tabName);
    });
  });

  // Time Range Selection
  if (timeRangeChips) {
    timeRangeChips.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip-btn");
      if (!btn) return;
      document.querySelectorAll("#timeRangeChips .chip-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeRange = btn.dataset.range;
      refreshAllMetrics();
      if (activeTab === "api") {
        loadApiMetrics();
      }
    });
  }

  // Auto-Refresh Select
  if (autoRefreshSelect) {
    autoRefreshSelect.addEventListener("change", (e) => {
      refreshIntervalMs = parseInt(e.target.value, 10);
      setupAutoRefresh();
    });
  }

  // Manual Refresh Button
  if (manualRefreshBtn) {
    manualRefreshBtn.addEventListener("click", async () => {
      manualRefreshBtn.disabled = true;
      refreshIcon.style.display = "inline-block";
      refreshIcon.style.animation = "spin 1s linear infinite";
      await refreshAllMetrics();
      await loadApiMetrics();
      await loadRecentRequests();
      manualRefreshBtn.disabled = false;
      refreshIcon.style.animation = "none";
    });
  }

  // API Filter Event Listeners
  if (apiFilterEndpoint) apiFilterEndpoint.addEventListener("change", loadApiMetrics);
  if (apiFilterStatus) apiFilterStatus.addEventListener("change", loadApiMetrics);
  if (apiFilterService) apiFilterService.addEventListener("change", loadApiMetrics);

  if (apiSearchInput) {
    apiSearchInput.addEventListener("input", () => {
      filterEndpointsLocally();
    });
  }

  if (apiResetFiltersBtn) {
    apiResetFiltersBtn.addEventListener("click", () => {
      if (apiFilterEndpoint) apiFilterEndpoint.value = "all";
      if (apiFilterStatus) apiFilterStatus.value = "all";
      if (apiFilterService) apiFilterService.value = "all";
      if (apiSearchInput) apiSearchInput.value = "";
      loadApiMetrics();
    });
  }

  if (refreshRecentRequestsBtn) {
    refreshRecentRequestsBtn.addEventListener("click", loadRecentRequests);
  }
}

// Global switch tab helper
window.switchTab = function(tabName) {
  activeTab = tabName;
  tabButtons.forEach(b => {
    b.classList.toggle("active", b.dataset.tab === tabName);
  });
  tabViews.forEach(v => {
    v.classList.toggle("active", v.id === `view-${tabName}`);
  });

  if (tabName === "api") {
    loadApiMetrics();
    loadRecentRequests();
  }
};

function setupAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (refreshIntervalMs > 0) {
    refreshTimer = setInterval(() => {
      refreshAllMetrics();
      if (activeTab === "api") {
        loadApiMetrics();
        loadRecentRequests();
      }
    }, refreshIntervalMs);
  }
}

// Data Fetching & State Refresh
async function refreshAllMetrics() {
  try {
    const res = await fetch(`${API_BASE}/overview?range=${activeRange}`);
    if (!res.ok) {
      throw new Error(`Monitoring API responded with status ${res.status}`);
    }
    const json = await res.json();
    if (json.success && json.data) {
      lastData = json.data;
      renderOverview(json.data);
      renderDetailedServices(json.data.services);
      updateLastRefreshed();
    }
  } catch (err) {
    console.warn("Failed to fetch live monitoring telemetry:", err);
    lastUpdatedText.textContent = `Cloudflare metrics temporarily unavailable (${new Date().toLocaleTimeString()})`;
  }
}

function updateLastRefreshed() {
  const now = new Date();
  lastUpdatedText.textContent = `Last updated: ${now.toLocaleTimeString()}`;
}

// Render Overview View
function renderOverview(data) {
  const { systemHealth, mainMetrics, services, isDemoData } = data;

  // Show/Hide Demo Data Banner
  if (demoBanner) {
    demoBanner.style.display = isDemoData ? "flex" : "none";
  }

  // System Health Status Badge & Icon
  if (overviewStatusBadge) {
    overviewStatusBadge.textContent = systemHealth.overallStatus;
    overviewStatusBadge.className = `status-badge ${systemHealth.overallStatus.toLowerCase()}`;
  }

  if (overviewHealthIcon) {
    overviewHealthIcon.className = `health-indicator-circle ${systemHealth.overallStatus.toLowerCase()}`;
    overviewHealthIcon.textContent = systemHealth.overallStatus === "HEALTHY" ? "✓" : systemHealth.overallStatus === "DOWN" ? "✕" : "!";
  }

  if (overviewLastChecked) {
    const timeStr = systemHealth.lastChecked ? new Date(systemHealth.lastChecked).toLocaleTimeString() : "Just now";
    overviewLastChecked.textContent = `Last health check probe executed: ${timeStr}`;
  }

  // Count Pills
  if (countHealthy) countHealthy.textContent = systemHealth.healthyServices;
  if (countDegraded) countDegraded.textContent = systemHealth.degradedServices;
  if (countFailed) countFailed.textContent = systemHealth.failedServices;
  if (countTotal) countTotal.textContent = systemHealth.totalServices;

  // Main Metrics
  if (valTotalRequests) valTotalRequests.textContent = Number(mainMetrics.totalRequests).toLocaleString();
  if (valRequestRate) valRequestRate.textContent = `${mainMetrics.requestRatePerSec} req/sec`;
  if (valErrorRate) {
    valErrorRate.textContent = `${mainMetrics.errorRatePercent}%`;
    valErrorRate.style.color = mainMetrics.errorRatePercent > 1.0 ? "var(--danger)" : mainMetrics.errorRatePercent > 0.5 ? "var(--warning)" : "var(--success)";
  }
  if (valAvgLatency) valAvgLatency.textContent = `${mainMetrics.avgLatencyMs} ms`;
  if (valLatencySpread) valLatencySpread.textContent = `P50: ${mainMetrics.p50LatencyMs}ms | P95: ${mainMetrics.p95LatencyMs}ms`;
  if (valP99Latency) valP99Latency.textContent = `${mainMetrics.p99LatencyMs} ms`;
  if (valCpuTime) valCpuTime.textContent = `${mainMetrics.workerCpuTimeMs} ms`;
  if (valActiveWS) valActiveWS.textContent = mainMetrics.activeWebSocketConnections;
  if (valD1Activity) valD1Activity.textContent = mainMetrics.d1QueryActivity;
  if (valKVActivity) valKVActivity.textContent = mainMetrics.kvOperationActivity;

  // Render Services Overview Table
  renderServicesSummaryTable(services);
}

function renderServicesSummaryTable(services) {
  if (!overviewServicesTableBody || !services) return;

  overviewServicesTableBody.innerHTML = services.map(s => {
    const statusClass = s.status.toLowerCase();
    const timeStr = s.lastChecked ? new Date(s.lastChecked).toLocaleTimeString() : "--";
    const latencyDisplay = s.responseTimeMs !== null ? `${s.responseTimeMs} ms` : "N/A";

    return `
      <tr>
        <td style="font-weight: 700;">${s.name}</td>
        <td><span style="color: var(--accent-blue); font-weight: 600;">${s.tier}</span></td>
        <td><span class="status-badge ${statusClass}">${s.status}</span></td>
        <td class="mono">${latencyDisplay}</td>
        <td style="color: var(--text-muted); font-size: 0.85rem;">${timeStr}</td>
        <td>
          <span style="color: ${s.errorCount > 0 ? 'var(--danger)' : 'var(--text-muted)'}; font-weight: 700;">
            ${s.errorCount}
          </span>
        </td>
      </tr>
    `;
  }).join("");
}

function renderDetailedServices(services) {
  if (!servicesDetailedTableBody || !services) return;

  servicesDetailedTableBody.innerHTML = services.map(s => {
    const statusClass = s.status.toLowerCase();
    const timeStr = s.lastChecked ? new Date(s.lastChecked).toLocaleTimeString() : "--";
    const latencyDisplay = s.responseTimeMs !== null ? `${s.responseTimeMs} ms` : "N/A";
    const diagnostic = s.error ? `<span style="color: var(--danger); font-weight: 600;">⚠️ ${s.error}</span>` : `<span style="color: var(--success);">Operational</span>`;

    return `
      <tr>
        <td style="font-weight: 700;">${s.name}</td>
        <td><span style="color: var(--accent-blue); font-weight: 600;">${s.tier}</span></td>
        <td style="color: var(--text-muted); font-size: 0.84rem; max-width: 280px;">${s.description}</td>
        <td><span class="status-badge ${statusClass}">${s.status}</span></td>
        <td class="mono">${latencyDisplay}</td>
        <td style="color: var(--text-muted); font-size: 0.85rem;">${timeStr}</td>
        <td style="font-size: 0.85rem;">${diagnostic}</td>
      </tr>
    `;
  }).join("");
}

// -------------------------------------------------------------
// API Monitoring Implementation (Phase 2)
// -------------------------------------------------------------

async function loadApiMetrics() {
  if (!apiEndpointsTableBody) return;

  const endpoint = apiFilterEndpoint ? apiFilterEndpoint.value : "all";
  const status = apiFilterStatus ? apiFilterStatus.value : "all";
  const service = apiFilterService ? apiFilterService.value : "all";

  const url = `${API_BASE}/api?range=${activeRange}&endpoint=${encodeURIComponent(endpoint)}&status=${encodeURIComponent(status)}&service=${encodeURIComponent(service)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API metrics returned HTTP ${res.status}`);
    const json = await res.json();

    if (json.success && json.data) {
      renderApiSummary(json.data.summary);
      cachedEndpoints = json.data.endpoints || [];
      filterEndpointsLocally();
    }
  } catch (err) {
    console.error("Error loading API metrics:", err);
    apiEndpointsTableBody.innerHTML = `<tr><td colspan="13" class="empty-state">Failed to load API endpoint metrics: ${err.message}</td></tr>`;
  }
}

function renderApiSummary(summary) {
  if (!summary) return;

  if (apiSummaryTotalRequests) apiSummaryTotalRequests.textContent = Number(summary.totalRequests).toLocaleString();
  if (apiSummaryErrorRate) {
    apiSummaryErrorRate.textContent = `${summary.overallErrorRate}%`;
    apiSummaryErrorRate.style.color = summary.overallErrorRate > 1.0 ? "var(--danger)" : summary.overallErrorRate > 0.5 ? "var(--warning)" : "var(--success)";
  }
  if (apiSummaryErrorsCount) apiSummaryErrorsCount.textContent = `${summary.totalErrors} total error${summary.totalErrors === 1 ? '' : 's'}`;
  if (apiSummaryAvgLatency) apiSummaryAvgLatency.textContent = `${summary.overallAvgLatency} ms`;
  if (apiSummaryP95Latency) apiSummaryP95Latency.textContent = `${summary.overallP95} ms`;
  if (apiSummaryP50P99) apiSummaryP50P99.textContent = `P50: ${summary.overallP50} ms | P99: ${summary.overallP99} ms`;
  if (apiSummaryWindowLabel) apiSummaryWindowLabel.textContent = `Window: Last ${activeRange}`;
}

function filterEndpointsLocally() {
  const query = apiSearchInput ? apiSearchInput.value.trim().toLowerCase() : "";
  let list = cachedEndpoints;

  if (query) {
    list = list.filter(ep => ep.endpoint.toLowerCase().includes(query) || ep.service.toLowerCase().includes(query));
  }

  renderApiEndpointsTable(list);
}

function renderApiEndpointsTable(endpoints) {
  if (!apiEndpointsTableBody) return;

  if (apiEndpointsCountLabel) {
    apiEndpointsCountLabel.textContent = `Showing ${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}`;
  }

  if (!endpoints || endpoints.length === 0) {
    apiEndpointsTableBody.innerHTML = `
      <tr>
        <td colspan="13" class="empty-state">
          No endpoints matched the selected filters.
        </td>
      </tr>
    `;
    return;
  }

  apiEndpointsTableBody.innerHTML = endpoints.map(ep => {
    const errorRateClass = ep.errorRatePercent > 2.0 ? 'style="color: var(--danger); font-weight: 700;"' : ep.errorRatePercent > 0 ? 'style="color: var(--warning); font-weight: 700;"' : 'style="color: var(--success);"';

    return `
      <tr>
        <td style="font-family: var(--font-mono); font-weight: 700; color: var(--accent-blue);">
          ${ep.endpoint}
        </td>
        <td style="color: var(--text-muted); font-size: 0.82rem;">${ep.service}</td>
        <td class="mono" style="font-weight: 700;">${Number(ep.requestCount).toLocaleString()}</td>
        <td class="mono" style="color: var(--success);">${Number(ep.successCount).toLocaleString()}</td>
        <td class="mono" style="color: ${ep.errorCount > 0 ? 'var(--danger)' : 'var(--text-muted)'}; font-weight: 700;">${ep.errorCount}</td>
        <td class="mono" ${errorRateClass}>${ep.errorRatePercent}%</td>
        <td class="mono" style="color: var(--success); font-size: 0.82rem;">${ep.count2xx}</td>
        <td class="mono" style="color: ${ep.count4xx > 0 ? 'var(--warning)' : 'var(--text-muted)'}; font-size: 0.82rem;">${ep.count4xx}</td>
        <td class="mono" style="color: ${ep.count5xx > 0 ? 'var(--danger)' : 'var(--text-muted)'}; font-size: 0.82rem;">${ep.count5xx}</td>
        <td class="mono" style="font-weight: 700;">${ep.avgLatencyMs} ms</td>
        <td class="mono">${ep.p50Ms} ms</td>
        <td class="mono" style="color: ${ep.p95Ms > 100 ? 'var(--warning)' : 'inherit'}; font-weight: 700;">${ep.p95Ms} ms</td>
        <td class="mono" style="color: ${ep.p99Ms > 150 ? 'var(--danger)' : 'inherit'};">${ep.p99Ms} ms</td>
      </tr>
    `;
  }).join("");
}

async function loadRecentRequests() {
  if (!apiRecentRequestsTableBody) return;

  try {
    const res = await fetch(`${API_BASE}/api/recent?limit=25`);
    if (!res.ok) return;
    const json = await res.json();
    if (json.success && json.data) {
      renderRecentRequestsTable(json.data.requests || []);
    }
  } catch (err) {
    console.warn("Could not load recent request stream:", err);
  }
}

function renderRecentRequestsTable(requests) {
  if (!apiRecentRequestsTableBody) return;

  if (!requests || requests.length === 0) {
    apiRecentRequestsTableBody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-state">No requests recorded yet. Make API requests to see live activity stream.</td>
      </tr>
    `;
    return;
  }

  apiRecentRequestsTableBody.innerHTML = requests.map(r => {
    const statusClass = r.status >= 500 ? "down" : r.status >= 400 ? "degraded" : "healthy";
    const methodColor = r.method === "POST" ? "#10b981" : r.method === "PUT" ? "#f59e0b" : r.method === "DELETE" ? "#ef4444" : "#3b82f6";
    const timeStr = r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : "--";
    const eventBadge = r.businessEvent
      ? `<span style="background: rgba(139, 92, 246, 0.2); border: 1px solid var(--accent-purple); color: #c4b5fd; padding: 0.15rem 0.45rem; border-radius: 6px; font-size: 0.72rem; font-weight: 700;">${r.businessEvent}</span>`
      : `<span style="color: var(--text-muted); font-size: 0.75rem;">—</span>`;

    return `
      <tr>
        <td class="mono" style="color: var(--accent-blue); font-size: 0.8rem; font-weight: 600;">${r.requestId}</td>
        <td>
          <span style="background: rgba(255,255,255,0.06); color: ${methodColor}; padding: 0.2rem 0.45rem; border-radius: 4px; font-size: 0.75rem; font-weight: 800; font-family: var(--font-mono);">
            ${r.method}
          </span>
        </td>
        <td class="mono" style="font-weight: 600;">${r.endpoint}</td>
        <td style="color: var(--text-muted); font-size: 0.8rem;">${r.service}</td>
        <td>
          <span class="status-badge ${statusClass}" style="padding: 0.15rem 0.5rem; font-size: 0.72rem;">
            ${r.status} ${r.statusClass}
          </span>
        </td>
        <td class="mono" style="font-weight: 700;">${r.durationMs} ms</td>
        <td>${eventBadge}</td>
        <td style="color: var(--text-muted); font-size: 0.8rem;">${timeStr}</td>
      </tr>
    `;
  }).join("");
}

// -------------------------------------------------------------
// Performance Monitoring Implementation (Phase 3)
// -------------------------------------------------------------

// Performance DOM Elements
const perfSourceBadge = document.getElementById("perfSourceBadge");
const perfNoteText = document.getElementById("perfNoteText");
const perfWindowRangeLabel = document.getElementById("perfWindowRangeLabel");

const perfTotalRequests = document.getElementById("perfTotalRequests");
const perfRequestRate = document.getElementById("perfRequestRate");
const perfErrorRate = document.getElementById("perfErrorRate");
const perfTotalErrors = document.getElementById("perfTotalErrors");
const perfAvgDuration = document.getElementById("perfAvgDuration");
const perfAvgCpu = document.getElementById("perfAvgCpu");
const perfP95P99 = document.getElementById("perfP95P99");
const perfP50 = document.getElementById("perfP50");

const svgRequestsChart = document.getElementById("svgRequestsChart");
const tooltipRequests = document.getElementById("tooltipRequests");
const svgLatencyChart = document.getElementById("svgLatencyChart");
const tooltipLatency = document.getElementById("tooltipLatency");
const svgCpuChart = document.getElementById("svgCpuChart");
const tooltipCpu = document.getElementById("tooltipCpu");

async function loadPerformanceMetrics() {
  if (perfWindowRangeLabel) {
    perfWindowRangeLabel.textContent = `Range: Last ${activeRange}`;
  }

  try {
    const res = await fetch(`${API_BASE}/performance?range=${activeRange}`);
    if (!res.ok) throw new Error(`Performance API returned HTTP ${res.status}`);
    const json = await res.json();

    if (json.success && json.data) {
      renderPerformanceSummary(json.data);
      renderRequestsChart(json.data.timeline || []);
      renderLatencyChart(json.data.timeline || []);
      renderCpuChart(json.data.timeline || []);
    }
  } catch (err) {
    console.error("Error loading performance metrics:", err);
  }
}

function renderPerformanceSummary(data) {
  const { summary, source, isDemoData, note } = data;

  if (perfSourceBadge) {
    if (source === "CLOUDFLARE_GRAPHQL") {
      perfSourceBadge.textContent = "Cloudflare GraphQL";
      perfSourceBadge.className = "status-badge healthy";
    } else {
      perfSourceBadge.textContent = "Local Dev Mode (DEMO DATA)";
      perfSourceBadge.className = "status-badge warning";
    }
  }

  if (perfNoteText && note) {
    perfNoteText.textContent = note;
  }

  if (!summary) return;

  if (perfTotalRequests) perfTotalRequests.textContent = Number(summary.totalRequests).toLocaleString();
  if (perfRequestRate) {
    const rangeMins = activeRange === "15m" ? 15 : activeRange === "1h" ? 60 : activeRange === "6h" ? 360 : activeRange === "24h" ? 1440 : 10080;
    const reqPerMin = Number((summary.totalRequests / rangeMins).toFixed(1));
    perfRequestRate.textContent = `${reqPerMin} req/min`;
  }

  if (perfErrorRate) {
    perfErrorRate.textContent = `${summary.errorRatePercent}%`;
    perfErrorRate.style.color = summary.errorRatePercent > 1.0 ? "var(--danger)" : summary.errorRatePercent > 0 ? "var(--warning)" : "var(--success)";
  }
  if (perfTotalErrors) perfTotalErrors.textContent = `${summary.totalErrors} total error${summary.totalErrors === 1 ? '' : 's'}`;
  if (perfAvgDuration) perfAvgDuration.textContent = `${summary.avgDurationMs} ms`;
  if (perfAvgCpu) perfAvgCpu.textContent = `${summary.avgCpuTimeMs} ms`;
  if (perfP95P99) perfP95P99.textContent = `${summary.p95} ms / ${summary.p99} ms`;
  if (perfP50) perfP50.textContent = `P50: ${summary.p50} ms`;
}

// 1. Invocations & Errors SVG Chart
function renderRequestsChart(timeline) {
  if (!svgRequestsChart || timeline.length === 0) return;

  const w = 800, h = 220;
  const padLeft = 45, padRight = 20, padTop = 25, padBottom = 35;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  const maxVal = Math.max(...timeline.map(t => t.requests), 10) * 1.15;
  const step = plotW / timeline.length;
  const barW = Math.max(6, Math.min(28, step * 0.65));

  let svgHtml = `
    <!-- Background Grid Lines -->
    <line x1="${padLeft}" y1="${padTop}" x2="${w - padRight}" y2="${padTop}" class="chart-grid-line" />
    <line x1="${padLeft}" y1="${padTop + plotH / 2}" x2="${w - padRight}" y2="${padTop + plotH / 2}" class="chart-grid-line" />
    <line x1="${padLeft}" y1="${padTop + plotH}" x2="${w - padRight}" y2="${padTop + plotH}" stroke="rgba(255,255,255,0.15)" />

    <!-- Y-Axis Labels -->
    <text x="${padLeft - 8}" y="${padTop + 4}" text-anchor="end" class="chart-axis-text">${Math.round(maxVal)}</text>
    <text x="${padLeft - 8}" y="${padTop + plotH / 2 + 4}" text-anchor="end" class="chart-axis-text">${Math.round(maxVal / 2)}</text>
    <text x="${padLeft - 8}" y="${padTop + plotH + 4}" text-anchor="end" class="chart-axis-text">0</text>
  `;

  timeline.forEach((pt, i) => {
    const barH = (pt.requests / maxVal) * plotH;
    const x = padLeft + i * step + (step - barW) / 2;
    const y = padTop + plotH - barH;

    // Requests Bar
    svgHtml += `
      <rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="3" fill="#3b82f6" fill-opacity="0.85">
        <animate attributeName="height" from="0" to="${barH}" dur="0.4s" />
        <animate attributeName="y" from="${padTop + plotH}" to="${y}" dur="0.4s" />
      </rect>
    `;

    // Error Marker
    if (pt.errors > 0) {
      svgHtml += `
        <rect x="${x}" y="${Math.max(padTop, y - 8)}" width="${barW}" height="5" rx="1.5" fill="#ef4444" />
      `;
    }

    // X-Axis Labels (show every 2nd or 3rd label if many points)
    const showLabel = timeline.length <= 12 || i % 2 === 0;
    if (showLabel) {
      svgHtml += `
        <text x="${x + barW / 2}" y="${h - 10}" text-anchor="middle" class="chart-axis-text">${pt.time}</text>
      `;
    }

    // Interactive Hover Hitbox
    svgHtml += `
      <rect 
        x="${padLeft + i * step}" 
        y="${padTop}" 
        width="${step}" 
        height="${plotH}" 
        fill="transparent" 
        style="cursor: pointer;"
        data-index="${i}"
        class="chart-hitbox-req"
      />
    `;
  });

  svgRequestsChart.innerHTML = svgHtml;

  // Add Hover Interactions
  const hitboxes = svgRequestsChart.querySelectorAll(".chart-hitbox-req");
  hitboxes.forEach(hb => {
    hb.addEventListener("mouseenter", (e) => {
      const idx = parseInt(hb.dataset.index, 10);
      const pt = timeline[idx];
      if (!pt || !tooltipRequests) return;

      tooltipRequests.style.display = "block";
      tooltipRequests.innerHTML = `
        <div style="font-weight: 700; margin-bottom: 0.2rem; color: #fff;">${pt.time}</div>
        <div style="color: var(--accent-blue);">Invocations: <strong>${pt.requests}</strong></div>
        <div style="color: ${pt.errors > 0 ? 'var(--danger)' : 'var(--text-muted)'};">Errors: <strong>${pt.errors}</strong></div>
      `;

      const rect = svgRequestsChart.getBoundingClientRect();
      const xPercent = (padLeft + idx * step + step / 2) / w;
      tooltipRequests.style.left = `${Math.min(rect.width - 120, Math.max(10, xPercent * rect.width - 50))}px`;
      tooltipRequests.style.top = `20px`;
    });

    hb.addEventListener("mouseleave", () => {
      if (tooltipRequests) tooltipRequests.style.display = "none";
    });
  });
}

// 2. Latency Percentiles SVG Chart
function renderLatencyChart(timeline) {
  if (!svgLatencyChart || timeline.length === 0) return;

  const w = 500, h = 220;
  const padLeft = 40, padRight = 15, padTop = 25, padBottom = 35;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  const maxVal = Math.max(...timeline.map(t => t.p99Ms), 40) * 1.15;
  const step = plotW / (timeline.length - 1 || 1);

  const getPoints = (key) => timeline.map((pt, i) => {
    const x = padLeft + i * step;
    const y = padTop + plotH - ((pt[key] / maxVal) * plotH);
    return `${x},${y}`;
  }).join(" ");

  const pointsP99 = getPoints("p99Ms");
  const pointsP95 = getPoints("p95Ms");
  const pointsAvg = getPoints("avgLatencyMs");
  const pointsP50 = getPoints("p50Ms");

  let svgHtml = `
    <!-- Grid -->
    <line x1="${padLeft}" y1="${padTop}" x2="${w - padRight}" y2="${padTop}" class="chart-grid-line" />
    <line x1="${padLeft}" y1="${padTop + plotH / 2}" x2="${w - padRight}" y2="${padTop + plotH / 2}" class="chart-grid-line" />
    <line x1="${padLeft}" y1="${padTop + plotH}" x2="${w - padRight}" y2="${padTop + plotH}" stroke="rgba(255,255,255,0.15)" />

    <!-- Y-Axis Labels -->
    <text x="${padLeft - 6}" y="${padTop + 4}" text-anchor="end" class="chart-axis-text">${Math.round(maxVal)}ms</text>
    <text x="${padLeft - 6}" y="${padTop + plotH / 2 + 4}" text-anchor="end" class="chart-axis-text">${Math.round(maxVal / 2)}ms</text>
    <text x="${padLeft - 6}" y="${padTop + plotH + 4}" text-anchor="end" class="chart-axis-text">0ms</text>

    <!-- Curves -->
    <polyline fill="none" stroke="#ef4444" stroke-width="2" points="${pointsP99}" />
    <polyline fill="none" stroke="#f59e0b" stroke-width="2" points="${pointsP95}" />
    <polyline fill="none" stroke="#3b82f6" stroke-width="2.5" points="${pointsAvg}" />
    <polyline fill="none" stroke="#06b6d4" stroke-width="1.8" stroke-dasharray="3 3" points="${pointsP50}" />
  `;

  // X-Axis Labels
  timeline.forEach((pt, i) => {
    if (timeline.length <= 8 || i % 2 === 0) {
      const x = padLeft + i * step;
      svgHtml += `<text x="${x}" y="${h - 10}" text-anchor="middle" class="chart-axis-text">${pt.time}</text>`;
    }

    svgHtml += `
      <rect 
        x="${padLeft + i * step - step / 2}" 
        y="${padTop}" 
        width="${step}" 
        height="${plotH}" 
        fill="transparent" 
        style="cursor: pointer;"
        data-index="${i}"
        class="chart-hitbox-lat"
      />
    `;
  });

  svgLatencyChart.innerHTML = svgHtml;

  // Tooltip
  const hitboxes = svgLatencyChart.querySelectorAll(".chart-hitbox-lat");
  hitboxes.forEach(hb => {
    hb.addEventListener("mouseenter", () => {
      const idx = parseInt(hb.dataset.index, 10);
      const pt = timeline[idx];
      if (!pt || !tooltipLatency) return;

      tooltipLatency.style.display = "block";
      tooltipLatency.innerHTML = `
        <div style="font-weight: 700; margin-bottom: 0.2rem; color: #fff;">${pt.time}</div>
        <div style="color: #ef4444;">P99: <strong>${pt.p99Ms} ms</strong></div>
        <div style="color: #f59e0b;">P95: <strong>${pt.p95Ms} ms</strong></div>
        <div style="color: #3b82f6;">Avg: <strong>${pt.avgLatencyMs} ms</strong></div>
        <div style="color: #06b6d4;">P50: <strong>${pt.p50Ms} ms</strong></div>
      `;

      const rect = svgLatencyChart.getBoundingClientRect();
      const xPercent = (padLeft + idx * step) / w;
      tooltipLatency.style.left = `${Math.min(rect.width - 130, Math.max(10, xPercent * rect.width - 60))}px`;
      tooltipLatency.style.top = `15px`;
    });

    hb.addEventListener("mouseleave", () => {
      if (tooltipLatency) tooltipLatency.style.display = "none";
    });
  });
}

// 3. Worker CPU vs Execution Duration SVG Chart
function renderCpuChart(timeline) {
  if (!svgCpuChart || timeline.length === 0) return;

  const w = 500, h = 220;
  const padLeft = 40, padRight = 15, padTop = 25, padBottom = 35;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  const maxVal = Math.max(...timeline.map(t => t.durationMs), 25) * 1.15;
  const step = plotW / (timeline.length - 1 || 1);

  const getPoints = (key) => timeline.map((pt, i) => {
    const x = padLeft + i * step;
    const y = padTop + plotH - ((pt[key] / maxVal) * plotH);
    return `${x},${y}`;
  }).join(" ");

  const pointsDur = getPoints("durationMs");
  const pointsCpu = getPoints("cpuTimeMs");

  // Area path for duration
  const areaDur = `${padLeft},${padTop + plotH} ${pointsDur} ${padLeft + plotW},${padTop + plotH}`;
  // Area path for CPU
  const areaCpu = `${padLeft},${padTop + plotH} ${pointsCpu} ${padLeft + plotW},${padTop + plotH}`;

  let svgHtml = `
    <!-- Grid -->
    <line x1="${padLeft}" y1="${padTop}" x2="${w - padRight}" y2="${padTop}" class="chart-grid-line" />
    <line x1="${padLeft}" y1="${padTop + plotH / 2}" x2="${w - padRight}" y2="${padTop + plotH / 2}" class="chart-grid-line" />
    <line x1="${padLeft}" y1="${padTop + plotH}" x2="${w - padRight}" y2="${padTop + plotH}" stroke="rgba(255,255,255,0.15)" />

    <!-- Y-Axis Labels -->
    <text x="${padLeft - 6}" y="${padTop + 4}" text-anchor="end" class="chart-axis-text">${Math.round(maxVal)}ms</text>
    <text x="${padLeft - 6}" y="${padTop + plotH / 2 + 4}" text-anchor="end" class="chart-axis-text">${Math.round(maxVal / 2)}ms</text>
    <text x="${padLeft - 6}" y="${padTop + plotH + 4}" text-anchor="end" class="chart-axis-text">0ms</text>

    <!-- Area & Lines -->
    <polygon points="${areaDur}" fill="rgba(16, 185, 129, 0.12)" />
    <polyline fill="none" stroke="#10b981" stroke-width="2" points="${pointsDur}" />

    <polygon points="${areaCpu}" fill="rgba(139, 92, 246, 0.25)" />
    <polyline fill="none" stroke="#8b5cf6" stroke-width="2.5" points="${pointsCpu}" />
  `;

  // X-Axis Labels
  timeline.forEach((pt, i) => {
    if (timeline.length <= 8 || i % 2 === 0) {
      const x = padLeft + i * step;
      svgHtml += `<text x="${x}" y="${h - 10}" text-anchor="middle" class="chart-axis-text">${pt.time}</text>`;
    }

    svgHtml += `
      <rect 
        x="${padLeft + i * step - step / 2}" 
        y="${padTop}" 
        width="${step}" 
        height="${plotH}" 
        fill="transparent" 
        style="cursor: pointer;"
        data-index="${i}"
        class="chart-hitbox-cpu"
      />
    `;
  });

  svgCpuChart.innerHTML = svgHtml;

  // Tooltip
  const hitboxes = svgCpuChart.querySelectorAll(".chart-hitbox-cpu");
  hitboxes.forEach(hb => {
    hb.addEventListener("mouseenter", () => {
      const idx = parseInt(hb.dataset.index, 10);
      const pt = timeline[idx];
      if (!pt || !tooltipCpu) return;

      tooltipCpu.style.display = "block";
      tooltipCpu.innerHTML = `
        <div style="font-weight: 700; margin-bottom: 0.2rem; color: #fff;">${pt.time}</div>
        <div style="color: #10b981;">Duration: <strong>${pt.durationMs} ms</strong></div>
        <div style="color: #8b5cf6;">Worker CPU: <strong>${pt.cpuTimeMs} ms</strong></div>
      `;

      const rect = svgCpuChart.getBoundingClientRect();
      const xPercent = (padLeft + idx * step) / w;
      tooltipCpu.style.left = `${Math.min(rect.width - 130, Math.max(10, xPercent * rect.width - 60))}px`;
      tooltipCpu.style.top = `15px`;
    });

    hb.addEventListener("mouseleave", () => {
      if (tooltipCpu) tooltipCpu.style.display = "none";
    });
  });
}

// -------------------------------------------------------------
// Database & Storage Monitoring (Phase 4)
// -------------------------------------------------------------

const d1StatusBadge = document.getElementById("d1StatusBadge");
const d1LatencyContributionText = document.getElementById("d1LatencyContributionText");
const d1TotalQueries = document.getElementById("d1TotalQueries");
const d1ReadsWritesSub = document.getElementById("d1ReadsWritesSub");
const d1AvgQueryLatency = document.getElementById("d1AvgQueryLatency");
const d1P95Latency = document.getElementById("d1P95Latency");
const d1SlowQueriesCount = document.getElementById("d1SlowQueriesCount");
const d1QueryErrors = document.getElementById("d1QueryErrors");
const d1StorageInfo = document.getElementById("d1StorageInfo");
const d1TablesTableBody = document.getElementById("d1TablesTableBody");
const d1SlowQueriesTableBody = document.getElementById("d1SlowQueriesTableBody");
const refreshDatabaseBtn = document.getElementById("refreshDatabaseBtn");

const kvStatusBadge = document.getElementById("kvStatusBadge");
const kvTotalOps = document.getElementById("kvTotalOps");
const kvOpsBreakdown = document.getElementById("kvOpsBreakdown");
const kvAvgLatency = document.getElementById("kvAvgLatency");
const kvActiveCarts = document.getElementById("kvActiveCarts");
const kvStorageInfo = document.getElementById("kvStorageInfo");

async function loadDatabaseMetrics() {
  try {
    const [d1Res, kvRes] = await Promise.all([
      fetch(`${API_BASE}/d1`),
      fetch(`${API_BASE}/kv`)
    ]);

    if (d1Res.ok) {
      const d1Json = await d1Res.json();
      if (d1Json.success && d1Json.data) renderD1Metrics(d1Json.data);
    }

    if (kvRes.ok) {
      const kvJson = await kvRes.json();
      if (kvJson.success && kvJson.data) renderKVMetrics(kvJson.data);
    }
  } catch (err) {
    console.error("Error loading database metrics:", err);
  }
}

function renderD1Metrics(data) {
  if (d1StatusBadge) {
    d1StatusBadge.textContent = data.status;
    d1StatusBadge.className = `status-badge ${data.status.toLowerCase()}`;
  }

  if (d1LatencyContributionText && data.latencyContribution) {
    d1LatencyContributionText.innerHTML = `
      <strong>Latency Contribution Analysis:</strong> ${data.latencyContribution.summary}
    `;
  }

  if (d1TotalQueries && data.queryActivity) {
    d1TotalQueries.textContent = Number(data.queryActivity.totalQueries).toLocaleString();
    d1ReadsWritesSub.textContent = `Reads: ${Number(data.queryActivity.readsCount).toLocaleString()} | Writes: ${Number(data.queryActivity.writesCount).toLocaleString()} (Ratio: ${data.queryActivity.readWriteRatio}:1)`;
    d1AvgQueryLatency.textContent = `${data.queryActivity.avgQueryLatencyMs} ms`;
    d1P95Latency.textContent = `P95: ${data.queryActivity.p95QueryLatencyMs} ms | Probe: ${data.probeLatencyMs} ms`;
    d1SlowQueriesCount.textContent = data.queryActivity.slowQueriesCount;
    d1QueryErrors.textContent = data.queryActivity.queryErrorsCount;
  }

  if (d1StorageInfo && data.storage) {
    d1StorageInfo.textContent = data.storage.storageUsed;
  }

  // Render Tables
  if (d1TablesTableBody && data.tables) {
    d1TablesTableBody.innerHTML = data.tables.map(t => `
      <tr>
        <td class="mono" style="font-weight: 700; color: var(--accent-blue);">${t.name}</td>
        <td class="mono" style="font-weight: 700; color: var(--success);">${Number(t.rows).toLocaleString()} rows</td>
        <td style="color: var(--text-muted); font-size: 0.82rem;">${t.role}</td>
      </tr>
    `).join("");
  }

  // Render Slow Queries Log
  if (d1SlowQueriesTableBody && data.slowQueriesLog) {
    if (data.slowQueriesLog.length === 0) {
      d1SlowQueriesTableBody.innerHTML = `<tr><td colspan="4" class="empty-state">No slow queries recorded.</td></tr>`;
    } else {
      d1SlowQueriesTableBody.innerHTML = data.slowQueriesLog.map(q => {
        const timeStr = q.timestamp ? new Date(q.timestamp).toLocaleTimeString() : "--";
        const durColor = q.durationMs > 35 ? "var(--warning)" : "var(--text-main)";
        return `
          <tr>
            <td>
              <span style="background: rgba(255,255,255,0.06); color: ${q.type === 'WRITE' ? '#f59e0b' : '#3b82f6'}; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.72rem; font-weight: 700; font-family: var(--font-mono);">
                ${q.type}
              </span>
            </td>
            <td class="mono" style="font-size: 0.8rem; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              ${q.query}
            </td>
            <td class="mono" style="color: ${durColor}; font-weight: 700;">${q.durationMs} ms</td>
            <td style="color: var(--text-muted); font-size: 0.8rem;">${timeStr}</td>
          </tr>
        `;
      }).join("");
    }
  }
}

function renderKVMetrics(data) {
  if (kvStatusBadge) {
    kvStatusBadge.textContent = data.status;
    kvStatusBadge.className = `status-badge ${data.status.toLowerCase()}`;
  }

  if (kvTotalOps && data.operationVolume) {
    kvTotalOps.textContent = Number(data.operationVolume.totalOperations).toLocaleString();
    kvOpsBreakdown.textContent = `Reads: ${Number(data.operationVolume.reads).toLocaleString()} | Writes: ${Number(data.operationVolume.writes).toLocaleString()} | Deletes: ${Number(data.operationVolume.deletes).toLocaleString()}`;
    kvAvgLatency.textContent = `${data.operationVolume.avgOperationLatencyMs} ms`;
  }

  if (kvActiveCarts && data.trends) {
    kvActiveCarts.textContent = `~${data.trends.activeSessionCartsEstimate}`;
  }

  if (kvStorageInfo && data.storage) {
    kvStorageInfo.textContent = data.storage.storageUsed;
  }
}

// -------------------------------------------------------------
// Real-Time & Durable Object Monitoring (Phase 4)
// -------------------------------------------------------------

const doRoleDisplay = document.getElementById("doRoleDisplay");
const doStatusBadge = document.getElementById("doStatusBadge");
const doActiveConnections = document.getElementById("doActiveConnections");
const doConnectionsMeta = document.getElementById("doConnectionsMeta");
const doMessagesSent = document.getElementById("doMessagesSent");
const doMessagesReceived = document.getElementById("doMessagesReceived");
const doTotalPurchases = document.getElementById("doTotalPurchases");
const doPurchaseErrors = document.getElementById("doPurchaseErrors");
const doAvgPurchaseLatency = document.getElementById("doAvgPurchaseLatency");
const doConnectionErrors = document.getElementById("doConnectionErrors");
const refreshRealtimeBtn = document.getElementById("refreshRealtimeBtn");

const appActiveWs = document.getElementById("appActiveWs");
const appOpenedWs = document.getElementById("appOpenedWs");
const appClosedWs = document.getElementById("appClosedWs");
const appBroadcasts = document.getElementById("appBroadcasts");
const appPurchases = document.getElementById("appPurchases");

async function loadRealtimeMetrics() {
  try {
    const res = await fetch(`${API_BASE}/durable-objects`);
    if (!res.ok) return;
    const json = await res.json();
    if (json.success && json.data) {
      renderRealtimeMetrics(json.data);
    }
  } catch (err) {
    console.error("Error loading real-time metrics:", err);
  }
}

function renderRealtimeMetrics(data) {
  if (doRoleDisplay && data.role) doRoleDisplay.textContent = data.role;

  if (doStatusBadge) {
    doStatusBadge.textContent = data.status || "HEALTHY";
    doStatusBadge.className = `status-badge ${(data.status || 'healthy').toLowerCase()}`;
  }

  if (doActiveConnections) doActiveConnections.textContent = data.activeConnections || 0;
  if (doConnectionsMeta) doConnectionsMeta.textContent = `Opened: ${data.totalConnectionsOpened || 0} | Closed: ${data.totalConnectionsClosed || 0}`;

  if (doMessagesSent) doMessagesSent.textContent = Number(data.totalMessagesSent || 0).toLocaleString();
  if (doMessagesReceived) doMessagesReceived.textContent = `Received (Pings): ${Number(data.totalMessagesReceived || 0).toLocaleString()}`;

  if (doTotalPurchases) doTotalPurchases.textContent = Number(data.totalPurchases || 0).toLocaleString();
  if (doPurchaseErrors) doPurchaseErrors.textContent = `${data.purchaseErrors || 0} purchase failure${data.purchaseErrors === 1 ? '' : 's'}`;
  if (doAvgPurchaseLatency) doAvgPurchaseLatency.textContent = data.avgPurchaseLatencyMs > 0 ? `${data.avgPurchaseLatencyMs} ms` : "-- ms";
  if (doConnectionErrors) doConnectionErrors.textContent = data.connectionErrors || 0;

  // Application Instrumented Table
  if (appActiveWs) appActiveWs.textContent = data.activeConnections || 0;
  if (appOpenedWs) appOpenedWs.textContent = data.totalConnectionsOpened || 0;
  if (appClosedWs) appClosedWs.textContent = data.totalConnectionsClosed || 0;
  if (appBroadcasts) appBroadcasts.textContent = data.totalMessagesSent || 0;
  if (appPurchases) appPurchases.textContent = data.totalPurchases || 0;
}

// -------------------------------------------------------------
// Centralized Logs & Error Center (Phase 5)
// -------------------------------------------------------------

const logCountTotal = document.getElementById("logCountTotal");
const logCountInfo = document.getElementById("logCountInfo");
const logCountWarn = document.getElementById("logCountWarn");
const logCountError = document.getElementById("logCountError");
const logTimeRangeSub = document.getElementById("logTimeRangeSub");
const logErrorRatioSub = document.getElementById("logErrorRatioSub");

const logFilterLevel = document.getElementById("logFilterLevel");
const logFilterService = document.getElementById("logFilterService");
const logSearchInput = document.getElementById("logSearchInput");
const logResetFiltersBtn = document.getElementById("logResetFiltersBtn");
const refreshLogsBtn = document.getElementById("refreshLogsBtn");

const logsTableBody = document.getElementById("logsTableBody");
const logsPagingMeta = document.getElementById("logsPagingMeta");

// Drawer elements
const logDrawerOverlay = document.getElementById("logDrawerOverlay");
const logDrawer = document.getElementById("logDrawer");
const drawerCloseBtn = document.getElementById("drawerCloseBtn");
const drawerLevelBadge = document.getElementById("drawerLevelBadge");
const drawerTitle = document.getElementById("drawerTitle");
const drawerTimestamp = document.getElementById("drawerTimestamp");
const drawerRequestId = document.getElementById("drawerRequestId");
const drawerCopyReqId = document.getElementById("drawerCopyReqId");
const drawerService = document.getElementById("drawerService");
const drawerEndpoint = document.getElementById("drawerEndpoint");
const drawerStatus = document.getElementById("drawerStatus");
const drawerDuration = document.getElementById("drawerDuration");
const drawerBusinessEventWrap = document.getElementById("drawerBusinessEventWrap");
const drawerBusinessEvent = document.getElementById("drawerBusinessEvent");
const drawerMessageText = document.getElementById("drawerMessageText");
const drawerJsonDetails = document.getElementById("drawerJsonDetails");
const drawerStackWrap = document.getElementById("drawerStackWrap");
const drawerStackTrace = document.getElementById("drawerStackTrace");

let searchDebounceTimeout = null;

async function loadLogs() {
  if (!logsTableBody) return;

  const level = logFilterLevel ? logFilterLevel.value : "all";
  const service = logFilterService ? logFilterService.value : "all";
  const search = logSearchInput ? encodeURIComponent(logSearchInput.value.trim()) : "";

  try {
    const res = await fetch(`${API_BASE}/logs?range=${activeRange}&level=${level}&service=${service}&search=${search}&limit=100`);
    if (!res.ok) return;
    const json = await res.json();
    if (json.success && json.data) {
      renderLogs(json.data);
    }
  } catch (err) {
    console.error("Failed to load centralized logs:", err);
  }
}

function renderLogs(data) {
  // Update KPI Cards
  if (logCountTotal) logCountTotal.textContent = Number(data.levelCounts.total).toLocaleString();
  if (logCountInfo) logCountInfo.textContent = Number(data.levelCounts.INFO).toLocaleString();
  if (logCountWarn) logCountWarn.textContent = Number(data.levelCounts.WARN).toLocaleString();
  if (logCountError) logCountError.textContent = Number(data.levelCounts.ERROR).toLocaleString();
  if (logTimeRangeSub) logTimeRangeSub.textContent = `Active buffer (${data.timeRange} window)`;

  const total = data.levelCounts.total || 1;
  const errorRate = ((data.levelCounts.ERROR / total) * 100).toFixed(1);
  if (logErrorRatioSub) logErrorRatioSub.textContent = `${errorRate}% error ratio`;

  if (logsPagingMeta) {
    logsPagingMeta.textContent = `Showing ${data.logs.length} of ${data.totalLogs} logs (${data.timeRange} window)`;
  }

  if (!logsTableBody) return;

  if (data.logs.length === 0) {
    logsTableBody.innerHTML = `<tr><td colspan="9" class="empty-state">No operational logs match current filters.</td></tr>`;
    return;
  }

  logsTableBody.innerHTML = data.logs.map(log => {
    const timeStr = log.timestamp ? new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : "--";
    const levelClass = (log.level || 'info').toLowerCase();
    const isError = log.level === "ERROR";
    const statusClass = log.status >= 500 ? "failed" : log.status >= 400 ? "degraded" : "healthy";
    const methodColor = log.method === "POST" ? "var(--accent-blue)" : log.method === "PUT" ? "var(--warning)" : log.method === "DELETE" ? "var(--danger)" : "var(--accent-cyan)";

    return `
      <tr class="log-row-interactive ${isError ? 'log-row-error' : ''}" data-log-id="${log.id}">
        <td>
          <span class="log-level-badge ${levelClass}">${log.level}</span>
        </td>
        <td class="mono" style="font-size: 0.78rem; color: var(--text-muted);">${timeStr}</td>
        <td style="font-size: 0.8rem; font-weight: 500;">${log.service}</td>
        <td>
          <span style="font-weight: 700; color: ${methodColor}; font-size: 0.75rem; margin-right: 0.35rem;">${log.method}</span>
          <span class="mono" style="font-size: 0.78rem;">${log.endpoint}</span>
        </td>
        <td>
          <span class="status-badge ${statusClass}" style="font-size: 0.7rem; padding: 0.15rem 0.45rem;">${log.status}</span>
        </td>
        <td class="mono" style="font-size: 0.78rem;">${log.durationMs} ms</td>
        <td>
          <span class="mono" style="font-size: 0.75rem; color: var(--accent-blue);">${log.requestId}</span>
        </td>
        <td style="font-size: 0.82rem; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${log.message}">
          ${log.businessEvent ? `<span style="background: rgba(6,182,212,0.15); color: #22d3ee; padding: 0.1rem 0.3rem; border-radius: 4px; font-size: 0.7rem; font-weight: 700; margin-right: 0.35rem;">${log.businessEvent}</span>` : ''}
          ${log.message}
        </td>
        <td style="text-align: center;">
          <button class="btn-inspect" data-inspect-id="${log.id}">Inspect</button>
        </td>
      </tr>
    `;
  }).join("");

  // Attach event listeners for row click and inspect button
  logsTableBody.querySelectorAll(".log-row-interactive").forEach(row => {
    row.addEventListener("click", () => {
      const logId = row.dataset.logId;
      if (logId) openLogDetail(logId);
    });
  });

  logsTableBody.querySelectorAll(".btn-inspect").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const logId = btn.dataset.inspectId;
      if (logId) openLogDetail(logId);
    });
  });
}

async function openLogDetail(logId) {
  try {
    const res = await fetch(`${API_BASE}/logs/${logId}`);
    if (!res.ok) return;
    const json = await res.json();
    if (!json.success || !json.data) return;

    const log = json.data;

    if (drawerLevelBadge) {
      drawerLevelBadge.textContent = log.level;
      drawerLevelBadge.className = `log-level-badge ${(log.level || 'info').toLowerCase()}`;
    }

    if (drawerTitle) drawerTitle.textContent = `Log #${log.id}`;
    if (drawerTimestamp) drawerTimestamp.textContent = log.timestamp ? `${new Date(log.timestamp).toLocaleDateString()} ${new Date(log.timestamp).toLocaleTimeString()}` : "--";
    if (drawerRequestId) drawerRequestId.textContent = log.requestId || "--";
    if (drawerService) drawerService.textContent = log.service || "--";
    if (drawerEndpoint) drawerEndpoint.textContent = `${log.method} ${log.endpoint}`;
    
    if (drawerStatus) {
      const statusClass = log.status >= 500 ? "failed" : log.status >= 400 ? "degraded" : "healthy";
      drawerStatus.innerHTML = `<span class="status-badge ${statusClass}">${log.status} ${(log.statusClass || '').toUpperCase()}</span>`;
    }

    if (drawerDuration) drawerDuration.textContent = `${log.durationMs} ms`;

    if (drawerBusinessEventWrap && drawerBusinessEvent) {
      if (log.businessEvent) {
        drawerBusinessEvent.textContent = log.businessEvent;
        drawerBusinessEventWrap.style.display = "flex";
      } else {
        drawerBusinessEventWrap.style.display = "none";
      }
    }

    if (drawerMessageText) drawerMessageText.textContent = log.message || "No message body";

    if (drawerJsonDetails) {
      drawerJsonDetails.textContent = JSON.stringify(log.details || {
        id: log.id,
        timestamp: log.timestamp,
        level: log.level,
        service: log.service,
        requestId: log.requestId,
        endpoint: log.endpoint,
        durationMs: log.durationMs
      }, null, 2);
    }

    if (drawerStackWrap && drawerStackTrace) {
      if (log.stack) {
        drawerStackTrace.textContent = log.stack;
        drawerStackWrap.style.display = "block";
      } else {
        drawerStackWrap.style.display = "none";
      }
    }

    if (logDrawerOverlay) {
      logDrawerOverlay.classList.add("open");
    }
  } catch (err) {
    console.error("Failed to fetch log detail:", err);
  }
}

function closeLogDetail() {
  if (logDrawerOverlay) {
    logDrawerOverlay.classList.remove("open");
  }
}

// Logs Event Listeners
if (refreshLogsBtn) {
  refreshLogsBtn.addEventListener("click", loadLogs);
}

if (logFilterLevel) {
  logFilterLevel.addEventListener("change", loadLogs);
}

if (logFilterService) {
  logFilterService.addEventListener("change", loadLogs);
}

if (logSearchInput) {
  logSearchInput.addEventListener("input", () => {
    clearTimeout(searchDebounceTimeout);
    searchDebounceTimeout = setTimeout(loadLogs, 250);
  });
}

if (logResetFiltersBtn) {
  logResetFiltersBtn.addEventListener("click", () => {
    if (logFilterLevel) logFilterLevel.value = "all";
    if (logFilterService) logFilterService.value = "all";
    if (logSearchInput) logSearchInput.value = "";
    loadLogs();
  });
}

if (drawerCloseBtn) {
  drawerCloseBtn.addEventListener("click", closeLogDetail);
}

if (logDrawerOverlay) {
  logDrawerOverlay.addEventListener("click", (e) => {
    if (e.target === logDrawerOverlay) {
      closeLogDetail();
    }
  });
}

if (drawerCopyReqId) {
  drawerCopyReqId.addEventListener("click", () => {
    if (drawerRequestId && drawerRequestId.textContent) {
      navigator.clipboard.writeText(drawerRequestId.textContent);
      const originalText = drawerCopyReqId.textContent;
      drawerCopyReqId.textContent = "✓ Copied!";
      setTimeout(() => {
        drawerCopyReqId.textContent = originalText;
      }, 1500);
    }
  });
}

// Event Listeners for DB & Realtime Refresh Buttons
if (refreshDatabaseBtn) {
  refreshDatabaseBtn.addEventListener("click", loadDatabaseMetrics);
}
if (refreshRealtimeBtn) {
  refreshRealtimeBtn.addEventListener("click", loadRealtimeMetrics);
}

// Update switchTab to load Database, Real-Time, and Logs tabs
const origSwitchTab = window.switchTab;
window.switchTab = function(tabName) {
  origSwitchTab(tabName);
  if (tabName === "performance") loadPerformanceMetrics();
  else if (tabName === "database") loadDatabaseMetrics();
  else if (tabName === "realtime") loadRealtimeMetrics();
  else if (tabName === "logs") loadLogs();
  else if (tabName === "traces") loadTraces();
};

// -------------------------------------------------------------
// Distributed Tracing & Request Correlation (Phase 6)
// -------------------------------------------------------------

const traceCountTotal = document.getElementById("traceCountTotal");
const traceAvgLatency = document.getElementById("traceAvgLatency");
const traceSlowCount = document.getElementById("traceSlowCount");
const traceMultiHopCount = document.getElementById("traceMultiHopCount");
const traceTimeRangeSub = document.getElementById("traceTimeRangeSub");

const traceFilterEndpoint = document.getElementById("traceFilterEndpoint");
const traceFilterStatus = document.getElementById("traceFilterStatus");
const traceFilterMinDur = document.getElementById("traceFilterMinDur");
const traceSearchInput = document.getElementById("traceSearchInput");
const traceResetFiltersBtn = document.getElementById("traceResetFiltersBtn");
const refreshTracesBtn = document.getElementById("refreshTracesBtn");
const tracesTableBody = document.getElementById("tracesTableBody");

const traceWaterfallSection = document.getElementById("traceWaterfallSection");
const wfStatusBadge = document.getElementById("wfStatusBadge");
const wfRouteTitle = document.getElementById("wfRouteTitle");
const wfTraceId = document.getElementById("wfTraceId");
const wfCopyBtn = document.getElementById("wfCopyBtn");
const wfMetaDetails = document.getElementById("wfMetaDetails");
const wfRuler25 = document.getElementById("wfRuler25");
const wfRuler50 = document.getElementById("wfRuler50");
const wfRuler75 = document.getElementById("wfRuler75");
const wfRuler100 = document.getElementById("wfRuler100");
const waterfallSpansList = document.getElementById("waterfallSpansList");
const wfSpanDetailBox = document.getElementById("wfSpanDetailBox");
const wfDetailSvcTag = document.getElementById("wfDetailSvcTag");
const wfDetailSpanName = document.getElementById("wfDetailSpanName");
const wfDetailJson = document.getElementById("wfDetailJson");

let traceSearchDebounce = null;
let currentActiveTraceId = null;

async function loadTraces() {
  if (!tracesTableBody) return;

  const endpoint = traceFilterEndpoint ? traceFilterEndpoint.value : "all";
  const status = traceFilterStatus ? traceFilterStatus.value : "all";
  const minDur = traceFilterMinDur ? traceFilterMinDur.value : "0";
  const search = traceSearchInput ? encodeURIComponent(traceSearchInput.value.trim()) : "";

  try {
    const res = await fetch(`${API_BASE}/traces?range=${activeRange}&endpoint=${endpoint}&status=${status}&minDuration=${minDur}&search=${search}&limit=50`);
    if (!res.ok) return;
    const json = await res.json();
    if (json.success && json.data) {
      renderTraces(json.data);
    }
  } catch (err) {
    console.error("Failed to load distributed traces:", err);
  }
}

function renderTraces(data) {
  // Update KPI Cards
  if (traceCountTotal) traceCountTotal.textContent = Number(data.summary.totalTraces).toLocaleString();
  if (traceAvgLatency) traceAvgLatency.textContent = `${data.summary.avgDurationMs} ms`;
  if (traceSlowCount) traceSlowCount.textContent = Number(data.summary.slowTracesCount).toLocaleString();
  if (traceMultiHopCount) traceMultiHopCount.textContent = "100%";
  if (traceTimeRangeSub) traceTimeRangeSub.textContent = `End-to-end correlated requests (${data.timeRange} window)`;

  if (!tracesTableBody) return;

  if (data.traces.length === 0) {
    tracesTableBody.innerHTML = `<tr><td colspan="8" class="empty-state">No traces match current filters.</td></tr>`;
    return;
  }

  tracesTableBody.innerHTML = data.traces.map(t => {
    const timeStr = t.timestamp ? new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : "--";
    const statusClass = t.status >= 500 ? "failed" : t.status >= 400 ? "degraded" : "healthy";
    const methodColor = t.method === "POST" ? "var(--accent-blue)" : t.method === "PUT" ? "var(--warning)" : t.method === "DELETE" ? "var(--danger)" : "var(--accent-cyan)";
    const durColor = t.totalDurationMs > 35 ? "var(--warning)" : "var(--text-main)";
    const isSelected = t.traceId === currentActiveTraceId;

    return `
      <tr class="log-row-interactive ${isSelected ? 'trace-row-selected' : ''}" data-trace-id="${t.traceId}">
        <td>
          <span class="mono" style="font-size: 0.8rem; color: var(--accent-blue); font-weight: 700;">${t.traceId}</span>
        </td>
        <td>
          <span style="font-weight: 700; color: ${methodColor}; font-size: 0.75rem; margin-right: 0.35rem;">${t.method}</span>
          <span class="mono" style="font-size: 0.78rem;">${t.endpoint}</span>
        </td>
        <td>
          <span class="status-badge ${statusClass}" style="font-size: 0.7rem; padding: 0.15rem 0.45rem;">${t.status}</span>
        </td>
        <td class="mono" style="color: ${durColor}; font-weight: 700;">${t.totalDurationMs} ms</td>
        <td>
          <span style="background: rgba(255,255,255,0.06); padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.75rem; font-family: var(--font-mono);">
            ${t.hopCount} spans
          </span>
        </td>
        <td>
          <span style="background: rgba(59,130,246,0.12); color: #93c5fd; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.72rem; font-family: var(--font-mono); font-weight: 700;">
            ${t.colo}
          </span>
        </td>
        <td style="color: var(--text-muted); font-size: 0.8rem;">${timeStr}</td>
        <td style="text-align: center;">
          <button class="btn-inspect" data-view-trace="${t.traceId}">View Waterfall</button>
        </td>
      </tr>
    `;
  }).join("");

  // Attach event handlers
  tracesTableBody.querySelectorAll(".log-row-interactive").forEach(row => {
    row.addEventListener("click", () => {
      const traceId = row.dataset.traceId;
      if (traceId) openTraceWaterfall(traceId);
    });
  });

  tracesTableBody.querySelectorAll(".btn-inspect").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const traceId = btn.dataset.viewTrace;
      if (traceId) openTraceWaterfall(traceId);
    });
  });

  // If no trace is open yet and traces exist, open the first one by default!
  if (!currentActiveTraceId && data.traces.length > 0) {
    openTraceWaterfall(data.traces[0].traceId);
  }
}

async function openTraceWaterfall(traceId) {
  currentActiveTraceId = traceId;

  // Highlight row in table
  if (tracesTableBody) {
    tracesTableBody.querySelectorAll("tr").forEach(tr => {
      tr.classList.toggle("trace-row-selected", tr.dataset.traceId === traceId);
    });
  }

  try {
    const res = await fetch(`${API_BASE}/traces/${traceId}`);
    if (!res.ok) return;
    const json = await res.json();
    if (json.success && json.data) {
      renderWaterfall(json.data);
    }
  } catch (err) {
    console.error("Failed to load trace waterfall:", err);
  }
}

function renderWaterfall(trace) {
  if (!traceWaterfallSection) return;
  traceWaterfallSection.style.display = "flex";

  const statusClass = trace.status >= 500 ? "failed" : trace.status >= 400 ? "degraded" : "healthy";

  if (wfStatusBadge) {
    wfStatusBadge.textContent = `${trace.status} ${(trace.statusClass || '').toUpperCase()}`;
    wfStatusBadge.className = `status-badge ${statusClass}`;
  }

  if (wfRouteTitle) wfRouteTitle.textContent = `${trace.method} ${trace.endpoint}`;
  if (wfTraceId) wfTraceId.textContent = trace.traceId;

  if (wfMetaDetails) {
    wfMetaDetails.textContent = `Cloudflare Colo: ${trace.colo} | Total Duration: ${trace.totalDurationMs} ms | ${trace.spans.length} hop-by-hop execution spans`;
  }

  // Update timeline ruler
  const total = trace.totalDurationMs > 0 ? trace.totalDurationMs : 10;
  if (wfRuler25) wfRuler25.textContent = `${(total * 0.25).toFixed(1)} ms`;
  if (wfRuler50) wfRuler50.textContent = `${(total * 0.50).toFixed(1)} ms`;
  if (wfRuler75) wfRuler75.textContent = `${(total * 0.75).toFixed(1)} ms`;
  if (wfRuler100) wfRuler100.textContent = `${total.toFixed(1)} ms`;

  // Render spans
  if (waterfallSpansList) {
    waterfallSpansList.innerHTML = trace.spans.map((span, index) => {
      let svcClass = "svc-worker";
      const sLower = span.service.toLowerCase();
      if (sLower.includes("pages")) svcClass = "svc-pages";
      else if (sLower.includes("d1")) svcClass = "svc-d1";
      else if (sLower.includes("do") || sLower.includes("inventorydo")) svcClass = "svc-do";
      else if (sLower.includes("kv")) svcClass = "svc-kv";

      const isError = span.status === "ERROR";
      const offsetPercent = Math.min(95, Math.max(0, (span.startOffsetMs / total) * 100));
      const widthPercent = Math.min(100 - offsetPercent, Math.max(2.5, (span.durationMs / total) * 100));

      return `
        <div class="waterfall-span-row ${index === 0 ? 'selected' : ''}" data-span-idx="${index}">
          <div class="span-info-col">
            <span class="service-tag ${svcClass}">${span.service}</span>
            <span class="span-title" title="${span.name}">${span.name}</span>
          </div>

          <div class="span-track-col">
            <div class="span-bar ${svcClass} ${isError ? 'error' : ''}" style="left: ${offsetPercent.toFixed(1)}%; width: ${widthPercent.toFixed(1)}%;">
              <span class="span-timing-label">${span.durationMs} ms</span>
            </div>
          </div>
        </div>
      `;
    }).join("");

    // Span row click handlers
    waterfallSpansList.querySelectorAll(".waterfall-span-row").forEach(row => {
      row.addEventListener("click", () => {
        waterfallSpansList.querySelectorAll(".waterfall-span-row").forEach(r => r.classList.remove("selected"));
        row.classList.add("selected");
        const idx = parseInt(row.dataset.spanIdx, 10);
        showSpanDetail(trace.spans[idx], total);
      });
    });

    // Show first span by default
    if (trace.spans.length > 0) {
      showSpanDetail(trace.spans[0], total);
    }
  }
}

function showSpanDetail(span, totalDurationMs) {
  if (!span) return;

  let svcClass = "svc-worker";
  const sLower = span.service.toLowerCase();
  if (sLower.includes("pages")) svcClass = "svc-pages";
  else if (sLower.includes("d1")) svcClass = "svc-d1";
  else if (sLower.includes("do") || sLower.includes("inventorydo")) svcClass = "svc-do";
  else if (sLower.includes("kv")) svcClass = "svc-kv";

  if (wfDetailSvcTag) {
    wfDetailSvcTag.textContent = span.service;
    wfDetailSvcTag.className = `service-tag ${svcClass}`;
  }

  const pct = totalDurationMs > 0 ? ((span.durationMs / totalDurationMs) * 100).toFixed(1) : "0";
  if (wfDetailSpanName) {
    wfDetailSpanName.textContent = `${span.name} — ${span.durationMs} ms (${pct}% of roundtrip)`;
  }

  if (wfDetailJson) {
    wfDetailJson.textContent = JSON.stringify({
      spanId: span.id,
      name: span.name,
      service: span.service,
      startOffsetMs: `${span.startOffsetMs} ms`,
      durationMs: `${span.durationMs} ms`,
      relativeShare: `${pct}%`,
      status: span.status,
      executionMetadata: span.details || {}
    }, null, 2);
  }
}

// Waterfall Copy Button
if (wfCopyBtn) {
  wfCopyBtn.addEventListener("click", () => {
    if (wfTraceId && wfTraceId.textContent) {
      navigator.clipboard.writeText(wfTraceId.textContent);
      const orig = wfCopyBtn.textContent;
      wfCopyBtn.textContent = "✓ Copied!";
      setTimeout(() => { wfCopyBtn.textContent = orig; }, 1500);
    }
  });
}

// Traces Filter Listeners
if (refreshTracesBtn) refreshTracesBtn.addEventListener("click", loadTraces);
if (traceFilterEndpoint) traceFilterEndpoint.addEventListener("change", loadTraces);
if (traceFilterStatus) traceFilterStatus.addEventListener("change", loadTraces);
if (traceFilterMinDur) traceFilterMinDur.addEventListener("change", loadTraces);

if (traceSearchInput) {
  traceSearchInput.addEventListener("input", () => {
    clearTimeout(traceSearchDebounce);
    traceSearchDebounce = setTimeout(loadTraces, 250);
  });
}

if (traceResetFiltersBtn) {
  traceResetFiltersBtn.addEventListener("click", () => {
    if (traceFilterEndpoint) traceFilterEndpoint.value = "all";
    if (traceFilterStatus) traceFilterStatus.value = "all";
    if (traceFilterMinDur) traceFilterMinDur.value = "0";
    if (traceSearchInput) traceSearchInput.value = "";
    loadTraces();
  });
}

// Initial boot loader
initMonitoring().then(() => {
  loadPerformanceMetrics();
  loadDatabaseMetrics();
  loadRealtimeMetrics();
  loadLogs();
  loadTraces();
});




