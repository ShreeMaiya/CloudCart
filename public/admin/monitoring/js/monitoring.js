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

// Metric Value and Source Extraction Helpers
function getVal(m, fallback = "--") {
  if (m === null || m === undefined) return fallback;
  if (typeof m === "object" && "value" in m) {
    if (m.value === null || m.value === undefined) return fallback;
    return m.value;
  }
  return m;
}

function formatNum(m, fallback = "--") {
  const val = getVal(m, null);
  if (val === null || val === undefined || isNaN(val)) return fallback;
  return Number(val).toLocaleString();
}

function renderSourceBadge(source) {
  return "";
}

// DOM Elements

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
    if (isDemoData) {
      demoBanner.style.display = "flex";
      demoBanner.innerHTML = "⚠️ <span>DEMO DATA — Not live Cloudflare telemetry. Local simulation mode.</span>";
    } else {
      demoBanner.style.display = "none";
    }
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
  if (countHealthy) countHealthy.textContent = systemHealth.healthyServices ?? 0;
  if (countDegraded) countDegraded.textContent = systemHealth.degradedServices ?? 0;
  if (countFailed) countFailed.textContent = systemHealth.failedServices ?? 0;
  if (countTotal) countTotal.textContent = systemHealth.totalServices ?? 0;

  // Main Metrics with safe extraction and honest formatting
  if (valTotalRequests) valTotalRequests.textContent = formatNum(mainMetrics.totalRequests, "0");
  if (valRequestRate) valRequestRate.textContent = `${getVal(mainMetrics.requestRatePerMin, 0)} req/min`;
  
  if (valErrorRate) {
    const errRate = getVal(mainMetrics.errorRatePercent, null);
    valErrorRate.textContent = errRate !== null ? `${errRate}%` : "N/A";
    valErrorRate.style.color = (errRate !== null && errRate > 1.0) ? "var(--danger)" : (errRate !== null && errRate > 0) ? "var(--warning)" : "var(--success)";
  }

  if (valAvgLatency) {
    const avgLat = getVal(mainMetrics.avgLatencyMs, null);
    valAvgLatency.textContent = avgLat !== null ? `${avgLat} ms` : "N/A";
  }

  if (valLatencySpread) {
    const p50 = getVal(mainMetrics.p50LatencyMs, null);
    const p95 = getVal(mainMetrics.p95LatencyMs, null);
    valLatencySpread.textContent = `P50: ${p50 !== null ? p50 + "ms" : "N/A"} | P95: ${p95 !== null ? p95 + "ms" : "N/A"}`;
  }



  if (valActiveWS) valActiveWS.textContent = formatNum(mainMetrics.activeWebSocketConnections, "0");
  if (valD1Activity) valD1Activity.textContent = mainMetrics.d1QueryActivity || "Active (Probe OK)";
  if (valKVActivity) valKVActivity.textContent = mainMetrics.kvOperationActivity || "Active (Probe OK)";

  // Render Services Overview Table
  renderServicesSummaryTable(services);
}

function renderServicesSummaryTable(services) {
  if (!overviewServicesTableBody || !services) return;

  overviewServicesTableBody.innerHTML = services.map(s => {
    const statusClass = s.status.toLowerCase();
    const timeStr = s.lastChecked ? new Date(s.lastChecked).toLocaleTimeString() : "--";
    const latencyDisplay = s.responseTimeMs !== null && s.responseTimeMs !== undefined ? `${s.responseTimeMs} ms` : "N/A";
    const sourceBadge = renderSourceBadge(s.source);

    return `
      <tr>
        <td style="font-weight: 700;">
          ${s.name}
          <div style="margin-top: 0.2rem;">${sourceBadge}</div>
        </td>
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
    const latencyDisplay = s.responseTimeMs !== null && s.responseTimeMs !== undefined ? `${s.responseTimeMs} ms` : "N/A";
    const diagnostic = s.error ? `<span style="color: var(--danger); font-weight: 600;">⚠️ ${s.error}</span>` : `<span style="color: var(--success);">Operational</span>`;
    const sourceBadge = renderSourceBadge(s.source);

    return `
      <tr>
        <td style="font-weight: 700;">
          ${s.name}
          <div style="margin-top: 0.25rem;">${sourceBadge}</div>
        </td>
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

  if (apiSummaryTotalRequests) apiSummaryTotalRequests.textContent = formatNum(summary.totalRequests, "0");
  if (apiSummaryErrorRate) {
    const errRate = getVal(summary.overallErrorRate, null);
    apiSummaryErrorRate.textContent = errRate !== null ? `${errRate}%` : "N/A";
    apiSummaryErrorRate.style.color = (errRate !== null && errRate > 1.0) ? "var(--danger)" : (errRate !== null && errRate > 0) ? "var(--warning)" : "var(--success)";
  }
  if (apiSummaryErrorsCount) apiSummaryErrorsCount.textContent = `${formatNum(summary.totalErrors, "0")} total error(s)`;
  
  if (apiSummaryAvgLatency) {
    const avg = getVal(summary.overallAvgLatency, null);
    apiSummaryAvgLatency.textContent = avg !== null ? `${avg} ms` : "N/A";
  }
  if (apiSummaryP95Latency) {
    const p95 = getVal(summary.overallP95, null);
    apiSummaryP95Latency.textContent = p95 !== null ? `${p95} ms` : "N/A";
  }
  if (apiSummaryP50P99) {
    const p50 = getVal(summary.overallP50, "N/A");
    const p99 = getVal(summary.overallP99, "N/A");
    apiSummaryP50P99.textContent = `P50: ${p50 !== "N/A" ? p50 + " ms" : "N/A"} | P99: ${p99 !== "N/A" ? p99 + " ms" : "N/A"}`;
  }
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
    const errRate = getVal(ep.errorRatePercent, 0);
    const errorRateClass = errRate > 2.0 ? 'style="color: var(--danger); font-weight: 700;"' : errRate > 0 ? 'style="color: var(--warning); font-weight: 700;"' : 'style="color: var(--success);"';
    const sourceBadge = renderSourceBadge(ep.source);
    const avg = getVal(ep.avgLatencyMs, null);
    const p50 = getVal(ep.p50Ms, null);
    const p95 = getVal(ep.p95Ms, null);
    const p99 = getVal(ep.p99Ms, null);

    return `
      <tr>
        <td style="font-family: var(--font-mono); font-weight: 700; color: var(--accent-blue);">
          ${ep.endpoint}
          <div style="margin-top: 0.15rem;">${sourceBadge}</div>
        </td>
        <td style="color: var(--text-muted); font-size: 0.82rem;">${ep.service}</td>
        <td class="mono" style="font-weight: 700;">${formatNum(ep.requestCount, "0")}</td>
        <td class="mono" style="color: var(--success);">${formatNum(ep.successCount, "0")}</td>
        <td class="mono" style="color: ${getVal(ep.errorCount, 0) > 0 ? 'var(--danger)' : 'var(--text-muted)'}; font-weight: 700;">${formatNum(ep.errorCount, "0")}</td>
        <td class="mono" ${errorRateClass}>${errRate}%</td>
        <td class="mono" style="color: var(--success); font-size: 0.82rem;">${formatNum(ep.count2xx, "0")}</td>
        <td class="mono" style="color: ${getVal(ep.count4xx, 0) > 0 ? 'var(--warning)' : 'var(--text-muted)'}; font-size: 0.82rem;">${formatNum(ep.count4xx, "0")}</td>
        <td class="mono" style="color: ${getVal(ep.count5xx, 0) > 0 ? 'var(--danger)' : 'var(--text-muted)'}; font-size: 0.82rem;">${formatNum(ep.count5xx, "0")}</td>
        <td class="mono" style="font-weight: 700;">${avg !== null ? avg + " ms" : "N/A"}</td>
        <td class="mono">${p50 !== null ? p50 + " ms" : "N/A"}</td>
        <td class="mono" style="color: ${(p95 !== null && p95 > 100) ? 'var(--warning)' : 'inherit'}; font-weight: 700;">${p95 !== null ? p95 + " ms" : "N/A"}</td>
        <td class="mono" style="color: ${(p99 !== null && p99 > 150) ? 'var(--danger)' : 'inherit'};">${p99 !== null ? p99 + " ms" : "N/A"}</td>
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



async function loadDatabaseMetrics() {
  try {
    const d1Res = await fetch(`${API_BASE}/d1`);

    if (d1Res.ok) {
      const d1Json = await d1Res.json();
      if (d1Json.success && d1Json.data) renderD1Metrics(d1Json.data);
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


  const appTel = data.applicationTelemetry || data.queryActivity || {};
  if (d1TotalQueries) {
    d1TotalQueries.textContent = formatNum(appTel.totalQueries, "0");
    const reads = formatNum(appTel.reads ?? appTel.readsCount, "0");
    const writes = formatNum(appTel.writes ?? appTel.writesCount, "0");
    d1ReadsWritesSub.textContent = `Reads: ${reads} | Writes: ${writes}`;
    
    const avg = getVal(appTel.avgQueryLatencyMs, getVal(data.probe?.probeLatencyMs, null));
    d1AvgQueryLatency.textContent = avg !== null ? `${avg} ms` : "N/A";
    
    const probe = getVal(data.probe?.probeLatencyMs, null);
    d1P95Latency.textContent = `Probe (SELECT 1): ${probe !== null ? probe + " ms" : "N/A"}`;
    d1SlowQueriesCount.textContent = data.slowQueriesCount ?? 0;
    d1QueryErrors.textContent = formatNum(appTel.errors ?? appTel.queryErrorsCount, "0");
  }


  // Render Tables
  if (d1TablesTableBody && data.tables) {
    d1TablesTableBody.innerHTML = data.tables.map(t => {
      const tableName = t.name || t.table;
      const rowCount = formatNum(t.rows, "0");
      const srcBadge = renderSourceBadge(t.source);

      return `
        <tr>
          <td class="mono" style="font-weight: 700; color: var(--accent-blue);">${tableName}</td>
          <td class="mono" style="font-weight: 700; color: var(--success);">${rowCount} rows</td>
          <td style="color: var(--text-muted); font-size: 0.82rem;">${t.role} <span style="margin-left: 0.35rem;">${srcBadge}</span></td>
        </tr>
      `;
    }).join("");
  }

  // Render Slow Queries Log
  const slowLogs = data.slowQueriesLog || data.recentSlowQueries || [];
  if (d1SlowQueriesTableBody) {
    if (slowLogs.length === 0) {
      d1SlowQueriesTableBody.innerHTML = `<tr><td colspan="4" class="empty-state">No slow queries recorded in current isolate.</td></tr>`;
    } else {
      d1SlowQueriesTableBody.innerHTML = slowLogs.map(q => {
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

// Event Listeners for DB Refresh Buttons
if (refreshDatabaseBtn) {
  refreshDatabaseBtn.addEventListener("click", loadDatabaseMetrics);
}

// Update switchTab to load Database and Logs tabs
const origSwitchTab = window.switchTab;
window.switchTab = function(tabName) {
  origSwitchTab(tabName);
  if (tabName === "database") loadDatabaseMetrics();
  else if (tabName === "logs") loadLogs();
};



// Initial boot loader
initMonitoring().then(() => {
  loadDatabaseMetrics();
  loadLogs();
});





