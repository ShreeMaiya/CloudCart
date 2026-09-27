// CloudCart Monitoring & Observability Frontend Controller

const API_BASE = "/api/monitoring";

// Application State
let activeTab = "overview";
let activeRange = "1h";
let refreshIntervalMs = 30000;
let refreshTimer = null;
let lastData = null;

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

// Tables
const overviewServicesTableBody = document.getElementById("overviewServicesTableBody");
const servicesDetailedTableBody = document.getElementById("servicesDetailedTableBody");

// Initialize Monitoring Dashboard
async function initMonitoring() {
  setupEventListeners();
  setupAutoRefresh();
  await refreshAllMetrics();
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
      manualRefreshBtn.disabled = false;
      refreshIcon.style.animation = "none";
    });
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
};

function setupAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (refreshIntervalMs > 0) {
    refreshTimer = setInterval(() => {
      refreshAllMetrics();
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

// Auto-run on DOM Ready
document.addEventListener("DOMContentLoaded", initMonitoring);
