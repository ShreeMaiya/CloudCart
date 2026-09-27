// CloudCart Monitoring & Observability Frontend Controller

const API_BASE = "/api/monitoring";

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

// Update switchTab to load performance when selected
const origSwitchTab = window.switchTab;
window.switchTab = function(tabName) {
  origSwitchTab(tabName);
  if (tabName === "performance") {
    loadPerformanceMetrics();
  }
};

// Also load performance on initial boot
initMonitoring().then(() => {
  loadPerformanceMetrics();
});

