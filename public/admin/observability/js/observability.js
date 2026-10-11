// CloudCart Observability — Admin UI Controller
// Fetches from /api/observability/* and renders Logs, Metrics, Traces, Health tabs.

const API = "/api/observability";
let autoRefreshTimer = null;
let currentTab = "overview";

// ─── Init ─────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  setupControls();
  refreshAll();
});

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-view").forEach(v => v.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`view-${tab}`).classList.add("active");
      currentTab = tab;
      loadTab(tab);
    });
  });
}

function setupControls() {
  document.getElementById("refreshBtn").addEventListener("click", () => refreshAll());

  document.getElementById("rangeSelect").addEventListener("change", () => refreshAll());

  document.getElementById("autoRefreshSelect").addEventListener("change", e => {
    clearInterval(autoRefreshTimer);
    const ms = parseInt(e.target.value, 10);
    if (ms > 0) autoRefreshTimer = setInterval(() => refreshAll(), ms);
  });
  // Start default auto-refresh (30s)
  autoRefreshTimer = setInterval(() => refreshAll(), 30000);

  document.getElementById("logSearch").addEventListener("keydown", e => {
    if (e.key === "Enter") loadLogs();
  });
}

function getRange() {
  return document.getElementById("rangeSelect").value;
}

function refreshAll() {
  loadTab(currentTab);
  loadOverviewHeader(); // header health dot always updates
  document.getElementById("lastUpdated").textContent = "Updated " + new Date().toLocaleTimeString();
}

function loadTab(tab) {
  switch (tab) {
    case "overview": loadOverview(); break;
    case "logs":     loadLogs();    break;
    case "metrics":  loadMetrics(); break;
    case "traces":   loadTraces();  break;
    case "health":   loadHealth();  break;
  }
}

// ─── Overview ────────────────────────────────────────────────────

async function loadOverview() {
  const range = getRange();
  const data = await apiFetch(`${API}/overview?range=${range}`);
  if (!data) return;

  const d = data.data;

  // Health banner
  const st = d.systemHealth.overallStatus;
  const orb = document.getElementById("overviewOrb");
  orb.className = "health-orb " + st.toLowerCase();
  orb.textContent = st === "HEALTHY" ? "✓" : st === "DEGRADED" ? "!" : "✕";
  document.getElementById("overviewTitle").textContent = `System ${capitalize(st.toLowerCase())}`;
  document.getElementById("overviewSub").textContent = `Last health check: ${fmtTime(d.systemHealth.lastChecked)}`;
  document.getElementById("ovHealthy").textContent   = d.systemHealth.healthyServices;
  document.getElementById("ovDegraded").textContent  = d.systemHealth.degradedServices;
  document.getElementById("ovFailed").textContent    = d.systemHealth.failedServices;
  document.getElementById("ovTotal").textContent     = d.systemHealth.totalServices;

  // Header dot
  updateHeaderDot(st);
  document.getElementById("overallStatusText").textContent = `All services: ${st}`;

  // Request metrics
  document.getElementById("ovReqTotal").textContent = d.requestMetrics.totalRequests ?? "—";
  document.getElementById("ovErrRate").textContent  = d.requestMetrics.errorRate != null ? d.requestMetrics.errorRate + "%" : "—";
  document.getElementById("ovAvgLat").textContent   = d.requestMetrics.avgLatencyMs != null ? d.requestMetrics.avgLatencyMs + "ms" : "—";
  document.getElementById("ovP95Lat").textContent   = d.requestMetrics.p95Ms != null ? d.requestMetrics.p95Ms + "ms" : "—";

  // Business
  document.getElementById("ovCheckouts").textContent  = d.businessMetrics.checkoutsTotal;
  document.getElementById("ovCheckoutOk").textContent = d.businessMetrics.checkoutsSucceeded;
  document.getElementById("ovRevenue").textContent    = "₹" + (d.businessMetrics.revenueTotal || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 });
  document.getElementById("ovWS").textContent         = d.activeWebSocketConnections;
}

async function loadOverviewHeader() {
  const data = await apiFetch(`${API}/health`);
  if (!data) return;
  updateHeaderDot(data.data.overallStatus);
  document.getElementById("overallStatusText").textContent = `All services: ${data.data.overallStatus}`;
}

function updateHeaderDot(status) {
  const dot = document.getElementById("healthDot");
  dot.style.background = status === "HEALTHY" ? "var(--success)" : status === "DEGRADED" ? "var(--warn)" : "var(--error)";
  dot.style.boxShadow = status === "HEALTHY" ? "0 0 8px var(--success)" : status === "DEGRADED" ? "0 0 8px var(--warn)" : "0 0 8px var(--error)";
}

// ─── Logs ─────────────────────────────────────────────────────────

window.loadLogs = async function() {
  const range   = getRange();
  const level   = document.getElementById("logLevel").value;
  const service = document.getElementById("logService").value;
  const search  = document.getElementById("logSearch").value;
  const url     = `${API}/logs?range=${range}&level=${level}&service=${service}&search=${encodeURIComponent(search)}&limit=100`;

  const data = await apiFetch(url);
  const container = document.getElementById("logsContainer");
  const pillsEl = document.getElementById("logCountPills");

  if (!data) { container.innerHTML = `<div class="empty-state">Failed to load logs.</div>`; return; }

  const { logs, total, levelCounts } = data.data;

  // Level count pills
  pillsEl.innerHTML = [
    pill(`${total} total`, "var(--text-muted)", "rgba(100,116,139,0.15)"),
    pill(`${levelCounts.INFO || 0} INFO`, "var(--info)", "var(--info-bg)"),
    pill(`${levelCounts.WARN || 0} WARN`, "var(--warn)", "var(--warn-bg)"),
    pill(`${levelCounts.ERROR || 0} ERROR`, "var(--error)", "var(--error-bg)"),
    pill(`${levelCounts.DEBUG || 0} DEBUG`, "var(--debug)", "rgba(139,92,246,0.12)")
  ].join("");

  if (!logs || logs.length === 0) {
    container.innerHTML = `<div class="empty-state">🔍 No logs in selected range<p>Try a wider time range or send some requests first.</p></div>`;
    return;
  }

  container.innerHTML = logs.map((l, i) => `
    <div class="log-row" onclick="toggleLog(${i})" id="logrow-${i}">
      <span class="log-time">${fmtTime(l.timestamp)}</span>
      <span class="log-level-badge"><span class="badge badge-${l.level.toLowerCase()}">${l.level}</span></span>
      <span class="log-service">${l.service}</span>
      <span class="log-msg">${escHtml(l.message)}</span>
      ${l.traceId ? `<a class="log-trace-link" href="#" onclick="jumpToTrace('${l.traceId}');return false;" title="View trace">[trace]</a>` : ""}
    </div>
    <div class="log-detail" id="logdetail-${i}">${JSON.stringify({ traceId: l.traceId, requestId: l.requestId, context: l.context, error: l.error }, null, 2)}</div>
  `).join("");
};

window.toggleLog = function(i) {
  const row = document.getElementById(`logrow-${i}`);
  row.classList.toggle("expanded");
};

function pill(text, color, bg) {
  return `<span class="log-count-pill" style="color:${color};background:${bg}">${text}</span>`;
}

// ─── Metrics ──────────────────────────────────────────────────────

async function loadMetrics() {
  const range = getRange();
  const [metricsData, infraData] = await Promise.all([
    apiFetch(`${API}/metrics?range=${range}`),
    apiFetch(`${API}/metrics/infra`)
  ]);

  if (metricsData) {
    const { requests, business } = metricsData.data;

    // Request table
    const reqTable = document.getElementById("metricsRequestTable");
    if (!requests.endpoints || requests.endpoints.length === 0) {
      reqTable.innerHTML = `<div class="empty-state">No request data yet — make some API calls first.</div>`;
    } else {
      const maxP95 = Math.max(...requests.endpoints.map(e => e.latency.p95 || 0), 1);
      reqTable.innerHTML = `<table class="obs-table">
        <thead><tr>
          <th>Endpoint</th><th>Requests</th><th>Errors</th><th>Error Rate</th>
          <th>Avg</th><th>P50</th><th>P95</th><th>P99</th>
        </tr></thead>
        <tbody>${requests.endpoints.map(e => `<tr>
          <td class="mono" style="color:var(--text-dim)">${e.endpoint}</td>
          <td>${e.requests}</td>
          <td style="color:${e.errors > 0 ? 'var(--error)' : 'var(--text-muted)'}">${e.errors}</td>
          <td><span class="badge badge-${e.errorRate > 5 ? 'error' : e.errorRate > 0 ? 'warn' : 'healthy'}">${e.errorRate}%</span></td>
          <td class="mono">${fmtMs(e.latency.avg)}</td>
          <td class="mono">${fmtMs(e.latency.p50)}</td>
          <td class="mono">${renderLatencyBar(e.latency.p95, maxP95)}</td>
          <td class="mono">${fmtMs(e.latency.p99)}</td>
        </tr>`).join("")}</tbody>
      </table>`;
    }

    // Business counters
    const c = business.counters;
    document.getElementById("mProdCreated").textContent = c.products_created;
    document.getElementById("mProdUpdated").textContent = c.products_updated;
    document.getElementById("mChkOk").textContent       = c.checkouts_succeeded;
    document.getElementById("mChkFail").textContent     = c.checkouts_failed;
  }

  if (infraData) {
    const { d1, kv, do: doM } = infraData.data;
    document.getElementById("mD1R").textContent    = d1.reads;
    document.getElementById("mD1W").textContent    = d1.writes;
    document.getElementById("mD1Slow").textContent = d1.slowQueriesCount;
    document.getElementById("mD1Err").textContent  = d1.errors;
    document.getElementById("mKVGet").textContent  = kv.gets;
    document.getElementById("mKVPut").textContent  = kv.puts;
    document.getElementById("mKVErr").textContent  = kv.errors;
    document.getElementById("mDOConn").textContent  = doM.activeConnections ?? "—";
    document.getElementById("mDOPurch").textContent = doM.totalPurchases ?? "—";
    document.getElementById("mDOErr").textContent   = doM.purchaseErrors ?? "—";

    // D1 table rows
    const d1Table = document.getElementById("d1TablesTable");
    if (d1.tables && d1.tables.length > 0) {
      d1Table.innerHTML = `<table class="obs-table">
        <thead><tr><th>Table</th><th>Rows</th><th>Status</th></tr></thead>
        <tbody>${d1.tables.map(t => `<tr>
          <td class="mono">${t.table}</td>
          <td>${t.rows ?? "—"}</td>
          <td><span class="badge badge-healthy">accessible</span></td>
        </tr>`).join("")}</tbody>
      </table>`;
    }
  }
}

function renderLatencyBar(val, max) {
  if (val == null) return `<span style="color:var(--text-muted)">—</span>`;
  const pct = Math.min(100, Math.round((val / max) * 100));
  const color = val > 200 ? "var(--error)" : val > 100 ? "var(--warn)" : "var(--accent)";
  return `<div style="display:flex;align-items:center;gap:0.4rem">
    <div style="width:60px;background:var(--bg);border-radius:3px;height:6px;overflow:hidden">
      <div style="width:${pct}%;background:${color};height:100%;border-radius:3px"></div>
    </div>
    <span>${val}ms</span>
  </div>`;
}

// ─── Traces ───────────────────────────────────────────────────────

window.loadTraces = async function() {
  const range  = getRange();
  const status = document.getElementById("traceStatus").value;
  const event  = document.getElementById("traceEvent").value;
  const url    = `${API}/traces?range=${range}&status=${status}&businessEvent=${event}&limit=80`;

  const data = await apiFetch(url);
  const container = document.getElementById("tracesContainer");
  if (!data) { container.innerHTML = `<div class="empty-state">Failed to load traces.</div>`; return; }

  const { traces, total } = data.data;
  if (!traces || traces.length === 0) {
    container.innerHTML = `<div class="empty-state">🔍 No traces yet<p>Traces are collected as requests hit /api/* endpoints.</p></div>`;
    return;
  }

  container.innerHTML = `
    <table class="obs-table trace-row">
      <thead><tr>
        <th>Trace ID</th><th>Endpoint</th><th>Method</th><th>Status</th>
        <th>Duration</th><th>Spans</th><th>Business Event</th><th>Time</th>
      </tr></thead>
      <tbody>${traces.map(t => `<tr onclick="openWaterfall('${t.traceId}')" title="Click to view waterfall">
        <td class="mono" style="color:var(--accent);font-size:0.7rem">${t.traceId.substring(0, 12)}…</td>
        <td class="mono truncate">${t.endpoint}</td>
        <td>${t.method}</td>
        <td><span class="badge badge-${statusClass(t.httpStatus)}">${t.httpStatus}</span></td>
        <td class="mono">${t.durationMs}ms</td>
        <td style="color:var(--text-muted)">${t.spanCount}</td>
        <td>${t.businessEvent ? `<span class="badge badge-info" style="font-size:0.68rem">${t.businessEvent}</span>` : ""}</td>
        <td style="color:var(--text-muted)">${fmtTime(t.timestamp)}</td>
      </tr>`).join("")}</tbody>
    </table>`;
};

window.openWaterfall = async function(traceId) {
  const data = await apiFetch(`${API}/traces/${traceId}`);
  if (!data) return;

  const trace = data.data;
  const panel = document.getElementById("waterfallPanel");
  const content = document.getElementById("waterfallContent");
  const title = document.getElementById("waterfallTitle");

  title.innerHTML = `<span style="color:var(--accent);font-family:var(--mono)">${trace.traceId.substring(0, 16)}…</span> — ${trace.method} ${trace.endpoint} <span class="badge badge-${statusClass(trace.httpStatus)}">${trace.httpStatus}</span> <span style="color:var(--text-muted);font-size:0.8rem">${trace.durationMs}ms · ${trace.spanCount} spans</span>`;

  const totalDuration = trace.durationMs || 1;
  const spans = trace.spans || [];

  content.innerHTML = spans.map(s => {
    const left = ((s.startOffsetMs / totalDuration) * 100).toFixed(1);
    const width = Math.max(0.5, ((s.durationMs || 1) / totalDuration) * 100).toFixed(1);
    const indent = s.parentSpanId ? "  " : "";
    const isError = s.status === "error";
    return `<div class="span-row">
      <span class="span-indent">${indent ? "└─" : "├─"}</span>
      <span class="span-name"><span class="service">${s.service}</span>.${s.operation}</span>
      <div class="span-track">
        <div class="span-bar ${isError ? "error" : s.service}" style="left:${left}%;width:${width}%" title="${s.durationMs}ms"></div>
      </div>
      <span class="span-dur">${s.durationMs != null ? s.durationMs + "ms" : "—"}</span>
    </div>`;
  }).join("");

  panel.style.display = "block";
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
};

window.closeWaterfall = function() {
  document.getElementById("waterfallPanel").style.display = "none";
};

window.jumpToTrace = function(traceId) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-view").forEach(v => v.classList.remove("active"));
  document.querySelector('[data-tab="traces"]').classList.add("active");
  document.getElementById("view-traces").classList.add("active");
  currentTab = "traces";
  loadTraces().then(() => openWaterfall(traceId));
};

// ─── Health ───────────────────────────────────────────────────────

async function loadHealth() {
  const [healthData, infraData] = await Promise.all([
    apiFetch(`${API}/health`),
    apiFetch(`${API}/metrics/infra`)
  ]);

  if (healthData) {
    const services = healthData.data.services || [];
    document.getElementById("serviceCards").innerHTML = services.map(s => `
      <div class="service-card ${s.status.toLowerCase()}">
        <div class="svc-header">
          <div>
            <div class="svc-name">${s.name}</div>
            <div class="svc-tier">${s.tier}</div>
          </div>
          <span class="badge badge-${s.status.toLowerCase()}">${s.status}</span>
        </div>
        <div style="font-size:0.78rem;color:var(--text-muted);margin-top:0.25rem">${s.description}</div>
        <div class="svc-meta">
          ${s.responseTimeMs != null ? `<span>⏱ ${s.responseTimeMs}ms</span>` : ""}
          <span>🕐 ${fmtTime(s.lastChecked)}</span>
          ${s.details?.activeConnections != null ? `<span>🔗 ${s.details.activeConnections} WS</span>` : ""}
        </div>
        ${s.error ? `<div class="svc-error">Error: ${escHtml(s.error)}</div>` : ""}
      </div>
    `).join("");
  }

  // D1 recent queries
  if (infraData) {
    const queries = infraData.data.d1.recentQueries || [];
    const el = document.getElementById("d1RecentQueries");
    if (queries.length === 0) {
      el.innerHTML = `<div class="empty-state">No D1 queries recorded yet.</div>`;
    } else {
      el.innerHTML = `<table class="obs-table">
        <thead><tr><th>Type</th><th>Query</th><th>Duration</th><th>Slow</th><th>Time</th></tr></thead>
        <tbody>${queries.map(q => `<tr>
          <td><span class="badge badge-${q.type === "WRITE" ? "warn" : "info"}">${q.type}</span></td>
          <td class="mono truncate" title="${escHtml(q.query)}">${escHtml(q.query.substring(0, 80))}</td>
          <td class="mono">${q.durationMs}ms</td>
          <td>${q.isSlow ? '<span class="badge badge-warn">SLOW</span>' : ""}</td>
          <td style="color:var(--text-muted)">${fmtTime(q.timestamp)}</td>
        </tr>`).join("")}</tbody>
      </table>`;
    }
  }
}

// ─── Shared utilities ─────────────────────────────────────────────

async function apiFetch(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn("apiFetch failed:", url, e.message);
    return null;
  }
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-IN", { hour12: false });
}

function fmtMs(val) {
  return val != null ? `${val}ms` : "—";
}

function statusClass(code) {
  if (code >= 500) return "5xx";
  if (code >= 400) return "4xx";
  return "2xx";
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
