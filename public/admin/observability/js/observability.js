// Live Cloudflare-native observability dashboard. Telemetry is queried on demand;
// nothing is written to this project's D1 or KV for observability.
const API = "/api/observability";
const KEY_NAME = "cloudcart-observability-key";
let currentTab = "health";
let refreshTimer = null;
let promptInProgress = false;

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".tab-btn").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(item => item.classList.toggle("active", item === button));
    document.querySelectorAll(".tab-view").forEach(item => item.classList.toggle("active", item.id === `view-${button.dataset.tab}`));
    currentTab = button.dataset.tab;
    loadTab(currentTab);
  }));
  document.getElementById("refreshBtn").addEventListener("click", () => loadTab(currentTab));
  document.getElementById("probeBtn").addEventListener("click", runHealthCheck);
  document.getElementById("signOutBtn").addEventListener("click", () => {
    sessionStorage.removeItem(KEY_NAME);
    location.reload();
  });
  document.getElementById("rangeSelect").addEventListener("change", () => loadTab(currentTab));
  document.getElementById("autoRefreshSelect").addEventListener("change", event => {
    clearInterval(refreshTimer);
    const interval = Number(event.target.value);
    if (interval > 0) refreshTimer = setInterval(() => loadTab(currentTab), interval);
  });
  document.getElementById("logSearch").addEventListener("keydown", event => {
    if (event.key === "Enter") loadLogs();
  });
  loadTab(currentTab);
});

function loadTab(tab) {
  if (tab === "health") return loadHealth(false);
  if (tab === "logs") return loadLogs();
  if (tab === "metrics") return loadMetrics();
  if (tab === "traces") return loadTraces();
}

function range() { return document.getElementById("rangeSelect").value; }

async function fetchApi(path, options = {}, retryAuth = true) {
  const headers = new Headers(options.headers || {});
  let key = sessionStorage.getItem(KEY_NAME);
  if (!key && retryAuth && !promptInProgress) {
    promptInProgress = true;
    key = window.prompt("Enter the observability dashboard key configured as OBSERVABILITY_API_KEY:") || "";
    promptInProgress = false;
    if (key) sessionStorage.setItem(KEY_NAME, key);
  }
  if (key) headers.set("X-Admin-Key", key);
  try {
    const res = await fetch(path, { ...options, headers, cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && retryAuth) {
      sessionStorage.removeItem(KEY_NAME);
      return fetchApi(path, options, false);
    }
    if (!res.ok || body.success === false) throw new Error(body.error || `Request failed (${res.status})`);
    return body.data;
  } catch (error) {
    return { error: error.message || "Request failed" };
  }
}

async function loadHealth(probe) {
  const data = await fetchApi(`${API}/health${probe ? "?probe=1" : ""}`);
  if (data?.error) return showError("serviceCards", data.error);
  renderHealth(data);
}

async function runHealthCheck() {
  const button = document.getElementById("probeBtn");
  button.disabled = true;
  button.textContent = "Checking…";
  const data = await fetchApi(`${API}/probe`, { method: "POST" });
  button.disabled = false;
  button.textContent = "Run health check";
  if (data?.error) return showError("serviceCards", data.error);
  renderHealth({ overallStatus: "UNKNOWN", timestamp: new Date().toISOString(), probe: true, services: data?.services || [] });
}

function renderHealth(data) {
  const services = data?.services || [];
  const known = services.filter(item => ["HEALTHY", "DEGRADED", "DOWN"].includes(item.status));
  const healthy = known.filter(item => item.status === "HEALTHY").length;
  const degraded = known.filter(item => item.status === "DEGRADED").length;
  const down = known.filter(item => item.status === "DOWN").length;
  let status = down ? "DOWN" : degraded ? "DEGRADED" : known.length === services.length && services.length ? "HEALTHY" : "UNKNOWN";
  if (data?.overallStatus === "UNKNOWN" && !data.probe) status = "UNKNOWN";
  updateStatus(status);
  document.getElementById("healthSub").textContent = `${data?.probe ? "Active probe results" : "Passive status; no dependency calls"} · ${formatTime(data?.timestamp)}`;
  document.getElementById("hHealthy").textContent = healthy;
  document.getElementById("hDegraded").textContent = degraded;
  document.getElementById("hFailed").textContent = down;
  document.getElementById("hTotal").textContent = services.length;
  document.getElementById("serviceCards").innerHTML = services.map(service => {
    const cssStatus = service.status === "NOT_CONFIGURED" ? "unknown" : service.status.toLowerCase();
    return `<article class="service-card ${cssStatus}">
      <div class="svc-header"><div><div class="svc-name">${escapeHtml(service.name)}</div><div class="svc-tier">${escapeHtml(service.tier)}</div></div><span class="badge badge-${badgeClass(service.status)}">${escapeHtml(service.status)}</span></div>
      <div class="svc-description">${escapeHtml(service.detail || "")}</div>
      <div class="svc-meta"><span>${escapeHtml(service.signal || (service.checkedAt ? "Active probe" : ""))}</span>${service.latencyMs != null ? `<span>${service.latencyMs} ms</span>` : ""}<span>${formatTime(service.checkedAt)}</span>${service.cached ? "<span>cached probe</span>" : ""}</div>
    </article>`;
  }).join("") || '<div class="empty-state">No service state is available.</div>';
  document.getElementById("lastUpdated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function updateStatus(status) {
  const dot = document.getElementById("healthDot");
  dot.className = `dot ${status.toLowerCase()}`;
  document.getElementById("overallStatusText").textContent = `System ${status.toLowerCase()}`;
  document.getElementById("healthOrb").className = `health-orb ${status.toLowerCase()}`;
  document.getElementById("healthOrb").textContent = status === "HEALTHY" ? "✓" : status === "DEGRADED" ? "!" : status === "DOWN" ? "×" : "?";
  document.getElementById("healthTitle").textContent = `System ${status.toLowerCase()}`;
}

async function loadLogs() {
  const query = new URLSearchParams({ range: range(), limit: "100" });
  const data = await fetchApi(`${API}/logs?${query}`);
  if (data?.error) return showError("logsContainer", data.error);
  const result = data?.data || {};
  const events = result?.events?.events || [];
  const level = document.getElementById("logLevel").value;
  const service = document.getElementById("logService").value;
  const search = document.getElementById("logSearch").value.trim().toLowerCase();
  const filtered = events.filter(event => {
    const source = parseSource(event.source);
    const eventLevel = String(source.level || source.severity || event?.$metadata?.level || "INFO").toUpperCase();
    const eventService = source.service || event?.$workers?.entrypoint || event?.$metadata?.service || event?.$workers?.scriptName || "worker";
    const haystack = JSON.stringify(event).toLowerCase();
    const normalizedService = String(eventService).toLowerCase().replace(/[^a-z0-9]/g, "");
    return (level === "all" || eventLevel === level) && (service === "all" || normalizedService.includes(service.replace(/[^a-z0-9]/g, ""))) && (!search || haystack.includes(search));
  });
  document.getElementById("logCountPills").innerHTML = `<span class="log-count-pill">${filtered.length} returned events · Cloudflare sampling may apply</span>`;
  if (!filtered.length) return setEmpty("logsContainer", result.error || "No recent log events returned. Check Workers Logs configuration, range, and sampling.");
  document.getElementById("logsContainer").innerHTML = filtered.map((event, index) => {
    const source = parseSource(event.source);
    const eventLevel = String(source.level || source.severity || event?.$metadata?.level || "INFO").toUpperCase();
    const eventService = source.service || event?.$workers?.entrypoint || event?.$metadata?.service || event?.$workers?.scriptName || "worker";
    const message = source.message || source.msg || event?.$metadata?.message || JSON.stringify(source);
    return `<div class="log-entry"><div class="log-row"><span class="log-time">${formatTime(event.timestamp || event?.$metadata?.timestamp)}</span><span class="badge badge-${badgeClass(eventLevel)}">${escapeHtml(eventLevel)}</span><span class="log-service">${escapeHtml(eventService)}</span><span class="log-msg">${escapeHtml(message)}</span><button class="btn btn-ghost" onclick="toggleDetail('log-${index}')">Details</button></div><pre id="log-${index}" class="log-detail">${escapeHtml(JSON.stringify(event, null, 2))}</pre></div>`;
  }).join("");
}

async function loadMetrics() {
  const data = await fetchApi(`${API}/metrics?range=${encodeURIComponent(range())}`);
  if (data?.error) return showError("metricsData", data.error);
  const result = data?.data || {};
  const account = result.accountMetrics || {};
  const groups = account.data || {};
  const workerRows = groups.workersInvocationsAdaptive || [];
  const d1Rows = groups.d1AnalyticsAdaptiveGroups || [];
  const doRows = groups.durableObjectsInvocationsAdaptiveGroups || [];
  const total = (rows, field) => rows.reduce((sum, row) => sum + (Number(row?.sum?.[field]) || 0), 0);
  const worker = {
    requests: total(workerRows, "requests"), errors: total(workerRows, "errors"), subrequests: total(workerRows, "subrequests"),
    cpuP50Ms: workerRows.find(row => row?.quantiles?.cpuTimeP50 != null)?.quantiles?.cpuTimeP50 ?? null,
    cpuP99Ms: workerRows.find(row => row?.quantiles?.cpuTimeP99 != null)?.quantiles?.cpuTimeP99 ?? null
  };
  const d1 = { readQueries: total(d1Rows, "readQueries"), writeQueries: total(d1Rows, "writeQueries"), rowsRead: total(d1Rows, "rowsRead"), rowsWritten: total(d1Rows, "rowsWritten") };
  const durableObjects = { requests: total(doRows, "requests") };
  document.getElementById("metricsRequestTable").innerHTML = `<div class="grid-3">
    ${metricCard("Worker requests", worker.requests, `${worker.errors} errors · ${worker.subrequests} subrequests`)}
    ${metricCard("Worker CPU", worker.cpuP50Ms == null ? "—" : `${worker.cpuP50Ms} ms`, `P99 ${worker.cpuP99Ms == null ? "—" : `${worker.cpuP99Ms} ms`}`)}
    ${metricCard("Durable Object requests", durableObjects.requests, "Cloudflare account analytics")}
    ${metricCard("D1 queries", d1.readQueries + d1.writeQueries, `${d1.readQueries} reads · ${d1.writeQueries} writes`)}
    ${metricCard("D1 rows read", d1.rowsRead, `${d1.rowsWritten} rows written`)}
  </div><div class="card-sub metrics-note">Cloudflare account analytics. D1 and Durable Object totals are grouped by UTC date, so a sub-day range can include a full UTC day. Worker request totals include requests made by this observability dashboard. Sampled telemetry counts may be estimates. This panel makes no D1 or KV calls.</div>`;
  const native = result.nativeBindingActivity?.data;
  const diagnostic = {
    nativeBindingActivity: native || result.nativeBindingActivity?.error || "Unavailable",
    accountAnalytics: groups,
    accountAnalyticsError: account.error || null,
    dateCoverage: account.dateCoverage || null,
    refreshedAt: data.fetchedAt || account.fetchedAt || null
  };
  document.getElementById("metricsData").innerHTML = `<pre class="telemetry-json">${escapeHtml(JSON.stringify(diagnostic, null, 2))}</pre>`;
}

function metricCard(label, value, detail) {
  return `<div class="card"><div class="card-label">${escapeHtml(label)}</div><div class="card-value">${escapeHtml(value)}</div><div class="card-sub">${escapeHtml(detail)}</div></div>`;
}

async function loadTraces() {
  const data = await fetchApi(`${API}/traces?range=${encodeURIComponent(range())}&limit=80`);
  if (data?.error) return showError("tracesContainer", data.error);
  const traces = data?.data?.traces || [];
  if (!traces.length) return setEmpty("tracesContainer", "No recent traces were returned. Confirm tracing is enabled and check the sampling rate.");
  document.getElementById("tracesContainer").innerHTML = `<table class="obs-table trace-row"><thead><tr><th>Trace ID</th><th>Transaction</th><th>Services</th><th>Duration</th><th>Spans</th><th>Started</th><th></th></tr></thead><tbody>${traces.map((trace, index) => `<tr><td class="mono">${escapeHtml(trace.traceId || "—")}</td><td>${escapeHtml(trace.rootTransactionName || trace.rootSpanName || "—")}</td><td>${escapeHtml((trace.service || []).join(", "))}</td><td>${trace.traceDurationMs == null ? "—" : `${Number(trace.traceDurationMs).toFixed(1)} ms`}</td><td>${trace.spans ?? "—"}</td><td>${formatTime(trace.traceStartMs)}</td><td><button class="btn btn-ghost" onclick="toggleDetail('trace-${index}')">Spans</button></td></tr><tr><td colspan="7"><pre class="log-detail" id="trace-${index}">${escapeHtml(JSON.stringify(trace, null, 2))}</pre></td></tr>`).join("")}</tbody></table>`;
}

function parseSource(source) {
  if (source && typeof source === "object") return source;
  if (typeof source === "string") { try { return JSON.parse(source); } catch { return { message: source }; } }
  return {};
}
function formatTime(value) { if (!value) return "—"; const date = typeof value === "number" ? new Date(value) : new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-IN", { hour12: false }); }
function badgeClass(value) { const v = String(value).toLowerCase(); if (["healthy", "info", "debug", "2xx"].includes(v)) return "healthy"; if (["degraded", "warn", "warning", "4xx"].includes(v)) return "warn"; if (["down", "error", "5xx"].includes(v)) return "error"; return "unknown"; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]); }
function setEmpty(id, message) { document.getElementById(id).innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`; }
function showError(id, message) { setEmpty(id, message); }
window.toggleDetail = id => { const element = document.getElementById(id); if (element) element.classList.toggle("visible"); };
window.loadLogs = loadLogs;
window.loadTraces = loadTraces;
