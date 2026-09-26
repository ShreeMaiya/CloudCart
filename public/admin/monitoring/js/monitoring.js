// CloudCart Operations, Monitoring & Observability Hub Controller
import { renderThroughputChart } from './charts.js';
import { fetchCloudflareStatus, updateCloudflareStatusUI } from './cf-status.js';

let refreshTimer = null;
let currentSummary = null;
let currentLogs = [];

// DOM Elements
const globalStatusPill = document.getElementById('globalStatusPill');
const globalStatusText = document.getElementById('globalStatusText');
const autoRefreshSelect = document.getElementById('autoRefreshSelect');
const manualRefreshBtn = document.getElementById('manualRefreshBtn');
const runProbeBtn = document.getElementById('runProbeBtn');
const resetTelemetryBtn = document.getElementById('resetTelemetryBtn');

// KPIs
const kpiTotalRequests = document.getElementById('kpiTotalRequests');
const kpiUptime = document.getElementById('kpiUptime');
const kpiErrorRate = document.getElementById('kpiErrorRate');
const kpiErrorBreakdown = document.getElementById('kpiErrorBreakdown');
const kpiP95Latency = document.getElementById('kpiP95Latency');
const kpiLatencyBreakdown = document.getElementById('kpiLatencyBreakdown');
const kpiActiveSockets = document.getElementById('kpiActiveSockets');
const kpiDoBroadcasts = document.getElementById('kpiDoBroadcasts');
const kpiCheckoutHealth = document.getElementById('kpiCheckoutHealth');
const kpiCheckoutCounts = document.getElementById('kpiCheckoutCounts');

// Service Matrix
const workerLatencyVal = document.getElementById('workerLatencyVal');
const d1LatencyVal = document.getElementById('d1LatencyVal');
const d1RecordsVal = document.getElementById('d1RecordsVal');
const kvLatencyVal = document.getElementById('kvLatencyVal');
const doLiveSocketsVal = document.getElementById('doLiveSocketsVal');
const doBroadcastsVal = document.getElementById('doBroadcastsVal');
const cfColoVal = document.getElementById('cfColoVal');

// Charts & Distribution
const throughputChartSvg = document.getElementById('throughputChartSvg');
const bar2xx = document.getElementById('bar2xx');
const val2xx = document.getElementById('val2xx');
const bar3xx = document.getElementById('bar3xx');
const val3xx = document.getElementById('val3xx');
const bar4xx = document.getElementById('bar4xx');
const val4xx = document.getElementById('val4xx');
const bar5xx = document.getElementById('bar5xx');
const val5xx = document.getElementById('val5xx');
const coloTagsContainer = document.getElementById('coloTagsContainer');

// E-Commerce Telemetry
const checkoutSuccessCount = document.getElementById('checkoutSuccessCount');
const checkoutFailedCount = document.getElementById('checkoutFailedCount');
const failureReasonsList = document.getElementById('failureReasonsList');
const inventoryEventsList = document.getElementById('inventoryEventsList');

// Logs Terminal
const logLevelSelect = document.getElementById('logLevelSelect');
const logStatusSelect = document.getElementById('logStatusSelect');
const logSearchInput = document.getElementById('logSearchInput');
const logsTableBody = document.getElementById('logsTableBody');

// Modals
const traceModal = document.getElementById('traceModal');
const traceModalTitle = document.getElementById('traceModalTitle');
const traceModalBody = document.getElementById('traceModalBody');
const closeTraceModalBtn = document.getElementById('closeTraceModalBtn');

const probeModal = document.getElementById('probeModal');
const probeModalBody = document.getElementById('probeModalBody');
const closeProbeModalBtn = document.getElementById('closeProbeModalBtn');

// Initialize Controller
async function initMonitoring() {
  setupEventListeners();
  await refreshAll();
  setupAutoRefresh();
  initWebSocketHeartbeat();
}

function setupEventListeners() {
  manualRefreshBtn.addEventListener('click', () => {
    manualRefreshBtn.style.transform = 'rotate(180deg)';
    setTimeout(() => { manualRefreshBtn.style.transform = 'none'; }, 300);
    refreshAll();
  });

  autoRefreshSelect.addEventListener('change', setupAutoRefresh);

  runProbeBtn.addEventListener('click', handleRunSyntheticProbe);
  closeProbeModalBtn.addEventListener('click', () => probeModal.classList.add('hidden'));

  resetTelemetryBtn.addEventListener('click', handleResetTelemetry);

  logLevelSelect.addEventListener('change', loadLogs);
  logStatusSelect.addEventListener('change', loadLogs);
  logSearchInput.addEventListener('input', debounce(loadLogs, 300));

  closeTraceModalBtn.addEventListener('click', () => traceModal.classList.add('hidden'));

  // Close modals on escape key or clicking backdrop
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      traceModal.classList.add('hidden');
      probeModal.classList.add('hidden');
    }
  });

  [traceModal, probeModal].forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  });
}

function setupAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  const interval = parseInt(autoRefreshSelect.value, 10);
  if (interval > 0) {
    refreshTimer = setInterval(refreshAll, interval);
  }
}

async function refreshAll() {
  await Promise.all([
    loadSummary(),
    loadLogs(),
    loadInventoryEvents(),
    loadCloudflareStatusFeed()
  ]);
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// 1. Load Telemetry Summary
async function loadSummary() {
  try {
    const res = await fetch('/api/ops/summary');
    const data = await res.json();
    if (!data.success || !data.summary) return;

    const s = data.summary;
    currentSummary = s;

    // Update Global Status Pill
    if (s.errorRate > 15) {
      globalStatusPill.className = 'status-pill incident';
      globalStatusText.textContent = 'Degraded Performance (High Errors)';
    } else if (s.errorRate > 5) {
      globalStatusPill.className = 'status-pill degraded';
      globalStatusText.textContent = 'Warning: Elevated Errors';
    } else {
      globalStatusPill.className = 'status-pill operational';
      globalStatusText.textContent = 'All Edge Systems Operational';
    }

    // KPIs
    kpiTotalRequests.textContent = Number(s.totalRequests).toLocaleString();
    kpiUptime.textContent = `Uptime: ${formatUptime(s.uptimeSeconds)}`;

    kpiErrorRate.textContent = `${s.errorRate.toFixed(2)}%`;
    if (s.errorRate > 5) {
      kpiErrorRate.className = 'kpi-value text-danger';
    } else {
      kpiErrorRate.className = 'kpi-value good';
    }
    const total4xx = s.statusGroups['4xx'] || 0;
    const total5xx = s.statusGroups['5xx'] || 0;
    kpiErrorBreakdown.textContent = `${total4xx} (4xx) • ${total5xx} (5xx)`;

    kpiP95Latency.textContent = `${s.latencies.p95}ms`;
    kpiLatencyBreakdown.textContent = `Avg: ${s.latencies.avg}ms • P50: ${s.latencies.p50}ms`;

    kpiActiveSockets.textContent = s.activeDoConnections || 0;
    kpiDoBroadcasts.textContent = `${s.doStats?.broadcastCount || 0} DO Sync Events Broadcasted`;

    // Checkout KPI
    const co = s.checkoutStats || { attempts: 0, success: 0, failed: 0 };
    const coHealth = co.attempts > 0 ? Math.round((co.success / co.attempts) * 100) : 100;
    kpiCheckoutHealth.textContent = `${coHealth}%`;
    kpiCheckoutCounts.textContent = `${co.success} successful • ${co.failed} failed`;

    // Service Matrix Card Updates
    workerLatencyVal.textContent = `${s.latencies.avg}ms`;
    if (d1LatencyVal && !d1LatencyVal.dataset.probed) {
      d1LatencyVal.textContent = "Operational (SQLite)";
    }
    const dbTotal = (s.dbStats?.products || 0) + (s.dbStats?.orders || 0) + (s.dbStats?.feedback || 0);
    d1RecordsVal.textContent = `${dbTotal} Total Records`;

    if (kvLatencyVal && !kvLatencyVal.dataset.probed) {
      kvLatencyVal.textContent = "Bound (Active)";
    }

    doLiveSocketsVal.textContent = `${s.activeDoConnections || 0} Active Sockets`;
    doBroadcastsVal.textContent = `${s.doStats?.broadcastCount || 0} Broadcasts`;

    // Detect and show edge colos
    const colos = Object.keys(s.edgeColos || {});
    if (colos.length > 0) {
      cfColoVal.textContent = colos.join(', ');
      renderColoTags(s.edgeColos);
    } else {
      cfColoVal.textContent = 'LOCAL';
    }

    // Render Time-series Chart
    renderThroughputChart(throughputChartSvg, s.timeSeries);

    // Render Status Codes
    renderStatusDistribution(s.statusGroups, s.totalRequests);

    // Render Checkout diagnostics
    checkoutSuccessCount.textContent = co.success;
    checkoutFailedCount.textContent = co.failed;
    renderFailureReasons(co.failureReasons);

  } catch (err) {
    console.error("Error loading telemetry summary:", err);
  }
}

function renderStatusDistribution(groups, total) {
  const t = Math.max(total, 1);
  const c2xx = groups['2xx'] || 0;
  const c3xx = groups['3xx'] || 0;
  const c4xx = groups['4xx'] || 0;
  const c5xx = groups['5xx'] || 0;

  const p2xx = Math.round((c2xx / t) * 100);
  const p3xx = Math.round((c3xx / t) * 100);
  const p4xx = Math.round((c4xx / t) * 100);
  const p5xx = Math.round((c5xx / t) * 100);

  bar2xx.style.width = `${p2xx}%`;
  val2xx.textContent = `${c2xx} (${p2xx}%)`;

  bar3xx.style.width = `${p3xx}%`;
  val3xx.textContent = `${c3xx} (${p3xx}%)`;

  bar4xx.style.width = `${p4xx}%`;
  val4xx.textContent = `${c4xx} (${p4xx}%)`;

  bar5xx.style.width = `${p5xx}%`;
  val5xx.textContent = `${c5xx} (${p5xx}%)`;
}

function renderColoTags(colosMap) {
  const entries = Object.entries(colosMap);
  if (entries.length === 0) {
    coloTagsContainer.innerHTML = '<span class="colo-badge">LOCAL • Local Dev / Direct</span>';
    return;
  }
  coloTagsContainer.innerHTML = entries.map(([colo, count]) => `
    <span class="colo-badge">${colo} • ${count} reqs</span>
  `).join('');
}

function renderFailureReasons(reasonsMap) {
  const entries = Object.entries(reasonsMap || {});
  if (entries.length === 0) {
    failureReasonsList.innerHTML = '<li class="empty-state">No failed checkout attempts recorded.</li>';
    return;
  }
  failureReasonsList.innerHTML = entries.map(([reason, count]) => `
    <li>
      <span>${escapeHtml(reason)}</span>
      <strong>${count}x</strong>
    </li>
  `).join('');
}

// 2. Load Logs
async function loadLogs() {
  try {
    const level = logLevelSelect.value;
    const status = logStatusSelect.value;
    const search = logSearchInput.value.trim();

    const params = new URLSearchParams();
    params.append('limit', '50');
    if (level !== 'ALL') params.append('level', level);
    if (status) params.append('status', status);
    if (search) params.append('search', search);

    const res = await fetch(`/api/ops/logs?${params.toString()}`);
    const data = await res.json();
    if (!data.success || !data.logs) return;

    currentLogs = data.logs;
    renderLogsTable(data.logs);
  } catch (err) {
    console.error("Error loading logs:", err);
  }
}

function renderLogsTable(logs) {
  if (logs.length === 0) {
    logsTableBody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align: center; color: var(--text-dim); padding: 2rem;">
          No requests matching the selected filter criteria.
        </td>
      </tr>
    `;
    return;
  }

  logsTableBody.innerHTML = logs.map(l => {
    const time = l.timestamp.substring(11, 19);
    const statusGroup = `s${Math.floor(l.status / 100)}xx`;
    return `
      <tr>
        <td style="color: var(--text-muted);">${time}</td>
        <td><span class="level-badge ${l.level}">${l.level}</span></td>
        <td><span class="method-tag method-${l.method}">${l.method}</span></td>
        <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(l.path)}">
          ${escapeHtml(l.path)}
        </td>
        <td><span class="status-badge ${statusGroup}">${l.status}</span></td>
        <td style="color: var(--accent-purple);">${l.durationMs}ms</td>
        <td><span style="color: var(--accent-blue);">${l.colo}</span></td>
        <td style="color: var(--text-muted);">${l.clientIp}</td>
        <td>
          <button class="btn-trace" data-log-id="${l.id}">View</button>
        </td>
      </tr>
    `;
  }).join('');

  // Attach click handlers to trace buttons
  document.querySelectorAll('.btn-trace').forEach(btn => {
    btn.addEventListener('click', () => {
      const logId = btn.getAttribute('data-log-id');
      const logItem = currentLogs.find(x => x.id === logId);
      if (logItem) openTraceModal(logItem);
    });
  });
}

function openTraceModal(log) {
  traceModalTitle.textContent = `${log.method} ${log.path}`;
  traceModalBody.innerHTML = `
    <div class="trace-info-grid">
      <span class="trace-lbl">Request ID / CF-Ray:</span>
      <span class="trace-val" style="color: var(--accent-blue); font-weight: 700;">${log.cfRay}</span>

      <span class="trace-lbl">Timestamp:</span>
      <span class="trace-val">${log.timestamp}</span>

      <span class="trace-lbl">HTTP Status:</span>
      <span class="trace-val">
        <span class="status-badge s${Math.floor(log.status / 100)}xx">${log.status}</span>
      </span>

      <span class="trace-lbl">Edge Latency:</span>
      <span class="trace-val" style="color: var(--accent-purple); font-weight: 700;">${log.durationMs} ms</span>

      <span class="trace-lbl">Edge Colocation:</span>
      <span class="trace-val">${log.colo} (${log.country || 'Global'})</span>

      <span class="trace-lbl">Client IP (Masked):</span>
      <span class="trace-val">${log.clientIp}</span>

      <span class="trace-lbl">User Agent:</span>
      <span class="trace-val" style="font-size: 0.78rem; color: var(--text-muted);">${escapeHtml(log.userAgent || 'Not provided')}</span>
    </div>

    ${log.errorMessage ? `
      <h4 style="color: #f43f5e; margin-top: 1rem; font-size: 0.85rem;">⚠️ Exception Error Details</h4>
      <div class="trace-stack-box">${escapeHtml(log.errorMessage)}\n${escapeHtml(log.errorStack || '')}</div>
    ` : `
      <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.2); padding: 0.75rem 1rem; border-radius: 6px; color: #34d399; font-size: 0.82rem;">
        ✓ Request executed successfully without edge runtime exceptions.
      </div>
    `}
  `;
  traceModal.classList.remove('hidden');
}

// 3. Load Real-Time Inventory Events
async function loadInventoryEvents() {
  try {
    const res = await fetch('/api/ops/inventory-events?limit=20');
    const data = await res.json();
    if (!data.success || !data.events) return;

    if (data.events.length === 0) {
      inventoryEventsList.innerHTML = '<li class="empty-state">No inventory mutations recorded yet.</li>';
      return;
    }

    inventoryEventsList.innerHTML = data.events.map(ev => {
      const time = ev.timestamp.substring(11, 19);
      let badgeClass = 'update';
      let title = ev.type;

      if (ev.type === 'PRODUCT_CREATED') {
        badgeClass = 'add';
        title = `Added: ${ev.productName || ev.productId} (Stock: ${ev.newStock})`;
      } else if (ev.type === 'STOCK_UPDATED') {
        badgeClass = 'update';
        title = `Stock change for ${ev.productName || ev.productId}: ${ev.oldStock} → ${ev.newStock}`;
      } else if (ev.type === 'CHECKOUT_PURCHASE') {
        badgeClass = 'purchase';
        title = `Purchase: Order ${ev.orderId} (${ev.itemsCount} items deducted)`;
      } else if (ev.type === 'PRODUCT_DELETED') {
        badgeClass = 'delete';
        title = `Deleted Product: ${ev.productId}`;
      }

      return `
        <li class="event-item">
          <div class="event-item-left">
            <span class="event-badge ${badgeClass}">${ev.source || 'SYS'}</span>
            <span>${escapeHtml(title)}</span>
          </div>
          <span class="event-time">${time}</span>
        </li>
      `;
    }).join('');
  } catch (err) {
    console.error("Error loading inventory events:", err);
  }
}

// 4. Load Cloudflare Platform Status Feed
async function loadCloudflareStatusFeed() {
  const cfData = await fetchCloudflareStatus();
  updateCloudflareStatusUI(cfData);
}

// 5. Run Synthetic Health Probe
async function handleRunSyntheticProbe() {
  probeModal.classList.remove('hidden');
  probeModalBody.innerHTML = `
    <div style="text-align: center; padding: 2rem; color: var(--text-muted);">
      <div class="pulse-dot" style="margin: 0 auto 1rem; width: 14px; height: 14px; background: var(--accent-blue);"></div>
      Running active round-trip ping across Cloudflare Worker, D1, KV, and Durable Objects...
    </div>
  `;

  try {
    const res = await fetch('/api/ops/probe', { method: 'POST' });
    const data = await res.json();
    if (!data.success || !data.probe) {
      probeModalBody.innerHTML = `<div class="text-danger">Probe failed to execute.</div>`;
      return;
    }

    const p = data.probe;
    const checks = p.checks;

    // Update Service Matrix Cards with actual probed latencies!
    if (checks.d1?.latencyMs !== undefined) {
      d1LatencyVal.textContent = `${checks.d1.latencyMs}ms round-trip`;
      d1LatencyVal.dataset.probed = "true";
    }
    if (checks.kv?.latencyMs !== undefined) {
      kvLatencyVal.textContent = `${checks.kv.latencyMs}ms read/write`;
      kvLatencyVal.dataset.probed = "true";
    }

    probeModalBody.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem;">
        <div>
          <span style="font-size: 0.75rem; color: var(--text-dim); text-transform: uppercase;">Overall Health</span>
          <h4 style="font-size: 1.1rem; color: ${p.overall === 'HEALTHY' ? '#34d399' : '#fbbf24'};">
            ${p.overall === 'HEALTHY' ? '🟢 ALL PROBES PASSED (Optimal)' : '🟡 DEGRADED COMPONENTS'}
          </h4>
        </div>
        <span style="font-size: 0.75rem; color: var(--text-muted);">${p.timestamp.substring(11, 19)} UTC</span>
      </div>

      <div class="probe-results-list">
        <div class="probe-item">
          <div>
            <div class="probe-item-name">⚡ Cloudflare Worker Microservice</div>
            <div class="probe-item-desc">Edge JavaScript V8 isolate execution</div>
          </div>
          <div class="probe-item-right">
            <div class="probe-latency text-success">${checks.worker?.latencyMs || 0} ms</div>
            <span class="status-badge s2xx">${checks.worker?.status || 'OK'}</span>
          </div>
        </div>

        <div class="probe-item">
          <div>
            <div class="probe-item-name">🗄️ Cloudflare D1 SQL Database</div>
            <div class="probe-item-desc">${checks.d1?.message || 'Serverless SQLite query'}</div>
          </div>
          <div class="probe-item-right">
            <div class="probe-latency ${checks.d1?.status === 'HEALTHY' ? 'text-success' : 'text-danger'}">
              ${checks.d1?.latencyMs ?? '-'} ms
            </div>
            <span class="status-badge ${checks.d1?.status === 'HEALTHY' ? 's2xx' : 's5xx'}">${checks.d1?.status}</span>
          </div>
        </div>

        <div class="probe-item">
          <div>
            <div class="probe-item-name">🔑 Cloudflare KV Namespace</div>
            <div class="probe-item-desc">${checks.kv?.message || 'Key-value read/write session check'}</div>
          </div>
          <div class="probe-item-right">
            <div class="probe-latency ${checks.kv?.status === 'HEALTHY' ? 'text-success' : 'text-danger'}">
              ${checks.kv?.latencyMs ?? '-'} ms
            </div>
            <span class="status-badge ${checks.kv?.status === 'HEALTHY' ? 's2xx' : 's5xx'}">${checks.kv?.status}</span>
          </div>
        </div>

        <div class="probe-item">
          <div>
            <div class="probe-item-name">🔄 Cloudflare Durable Objects</div>
            <div class="probe-item-desc">${checks.durableObject?.message || 'InventoryDO in-memory singleton cluster'}</div>
          </div>
          <div class="probe-item-right">
            <div class="probe-latency ${checks.durableObject?.status === 'HEALTHY' ? 'text-success' : 'text-danger'}">
              ${checks.durableObject?.latencyMs ?? '-'} ms
            </div>
            <span class="status-badge ${checks.durableObject?.status === 'HEALTHY' ? 's2xx' : 's5xx'}">${checks.durableObject?.status}</span>
          </div>
        </div>
      </div>
    `;

    // Refresh summary after probe
    await loadSummary();
  } catch (err) {
    probeModalBody.innerHTML = `<div class="text-danger">Probe network error: ${escapeHtml(err.message)}</div>`;
  }
}

// 6. Reset Telemetry
async function handleResetTelemetry() {
  if (!confirm("Are you sure you want to reset the in-memory telemetry buffer and counters?")) return;
  try {
    const res = await fetch('/api/ops/reset', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      await refreshAll();
    }
  } catch (err) {
    console.error("Failed to reset telemetry:", err);
  }
}

// 7. WebSocket Live Heartbeat to DO
function initWebSocketHeartbeat() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/api/sync`;

  try {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      console.log("⚡ Observability hooked into live Durable Object WebSocket");
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'ACTIVE_USERS_COUNT') {
          kpiActiveSockets.textContent = msg.activeConnections;
          doLiveSocketsVal.textContent = `${msg.activeConnections} Active Sockets`;
        }
        if (msg.type === 'PRODUCT_STOCK_UPDATED' || msg.type === 'PRODUCT_ADDED' || msg.type === 'PRODUCT_UPDATED') {
          loadInventoryEvents();
        }
      } catch (e) {
        // ignore parse errors
      }
    };
  } catch (e) {
    console.warn("WebSocket not available for observability live hook:", e);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Run on load
document.addEventListener('DOMContentLoaded', initMonitoring);
