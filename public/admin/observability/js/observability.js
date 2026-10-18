// Live Cloudflare-native observability dashboard. Telemetry is queried on demand;
// nothing is written to this project's D1 or KV for observability.
const API = "/api/observability";
let currentTab = "health";
let refreshTimer = null;

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".tab-btn").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(item => item.classList.toggle("active", item === button));
    document.querySelectorAll(".tab-view").forEach(item => item.classList.toggle("active", item.id === `view-${button.dataset.tab}`));
    currentTab = button.dataset.tab;
    loadTab(currentTab);
  }));
  document.getElementById("refreshBtn").addEventListener("click", () => loadTab(currentTab));
  document.getElementById("probeBtn").addEventListener("click", runHealthCheck);
  document.getElementById("rangeSelect").addEventListener("change", () => loadTab(currentTab));
  document.getElementById("autoRefreshSelect").addEventListener("change", event => {
    clearInterval(refreshTimer);
    const interval = Number(event.target.value);
    if (interval > 0) refreshTimer = setInterval(() => loadTab(currentTab), interval);
  });
  loadTab(currentTab);
});

function loadTab(tab) {
  if (tab === "health") return loadHealth(false);
  if (tab === "logs") return loadLogs();
  if (tab === "metrics") return loadMetrics();
}

function range() { return document.getElementById("rangeSelect").value; }

async function fetchApi(path, options = {}) {
  const headers = new Headers(options.headers || {});
  try {
    const res = await fetch(path, { ...options, headers, cache: "no-store" });
    const body = await res.json().catch(() => ({}));
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
  const data = await fetchApi(`${API}/health?probe=1`);
  button.disabled = false;
  button.textContent = "Run health check";
  if (data?.error) return showError("serviceCards", data.error);
  renderHealth(data);
}

function renderHealth(data) {
  const services = (data?.services || []).filter(item => !["UNKNOWN", "NOT_CONFIGURED"].includes(item.status));
  const healthy = services.filter(item => item.status === "HEALTHY").length;
  const degraded = services.filter(item => item.status === "DEGRADED").length;
  const down = services.filter(item => item.status === "DOWN").length;
  const status = down ? "DOWN" : degraded ? "DEGRADED" : healthy ? "HEALTHY" : "UNKNOWN";
  updateStatus(status);
  document.getElementById("healthSub").textContent = `${data?.probe ? "Active probes plus current Worker status" : "Verified status; no dependency calls"} · ${formatTime(data?.timestamp)}`;
  document.getElementById("hHealthy").textContent = healthy;
  document.getElementById("hDegraded").textContent = degraded;
  document.getElementById("hFailed").textContent = down;
  document.getElementById("hTotal").textContent = services.length;
  document.getElementById("serviceCards").innerHTML = services.map(service => {
    const cssStatus = service.status.toLowerCase();
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
  const statusLabel = status === "HEALTHY" ? "All verified services healthy" : status === "DEGRADED" ? "Some services degraded" : status === "DOWN" ? "Service failure detected" : "Some services not checked";
  document.getElementById("overallStatusText").textContent = statusLabel;
  document.getElementById("healthOrb").className = `health-orb ${status.toLowerCase()}`;
  document.getElementById("healthOrb").textContent = status === "HEALTHY" ? "✓" : status === "DEGRADED" ? "!" : status === "DOWN" ? "×" : "?";
  document.getElementById("healthTitle").textContent = statusLabel;
}

async function loadLogs() {
  const query = new URLSearchParams({ range: range(), limit: "100" });
  const data = await fetchApi(`${API}/logs?${query}`);
  if (data?.error) return showError("logsContainer", data.error);
  const result = data?.data || {};
  const invocationMap = result?.invocations || {};
  const invocations = Object.entries(invocationMap).map(([id, rawEvents]) => {
    const events = Array.isArray(rawEvents) ? rawEvents : [rawEvents];
    const root = events.find(event => event?.$metadata?.type === "cf-worker-event" || event?.$workers?.eventType === "fetch") || events[0] || {};
    const metadata = root.$metadata || {};
    const workers = root.$workers || {};
    const source = parseSource(root.source);
    const redactQuery = value => String(value ?? "").replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, "$1").replace(/\?[^\s]*/g, "");
    const trigger = metadata.trigger || root.trigger || source.trigger || "";
    const url = metadata.url || root.url || source.url || workers.event?.request?.url || "";
    const requestLine = redactQuery(trigger || `${workers.event?.request?.method || source.method || "INVOCATION"} ${url}`.trim());
    const statusCode = metadata.statusCode ?? root.statusCode ?? source.statusCode ?? null;
    return {
      id, events, root,
      timestamp: root.timestamp || metadata.timestamp || source.timestamp,
      service: metadata.service || workers.scriptName || workers.entrypoint || source.service || "worker",
      requestLine: requestLine || "Worker invocation",
      statusCode,
      wallTimeMs: workers.wallTimeMs ?? metadata.duration ?? source.wallTimeMs ?? null,
      cpuTimeMs: workers.cpuTimeMs ?? source.cpuTimeMs ?? null,
      requestId: metadata.requestId || workers.requestId || id,
      level: String(metadata.level || source.level || (statusCode >= 500 ? "ERROR" : statusCode >= 400 ? "WARN" : "INFO")).toUpperCase(),
      searchText: JSON.stringify(events).toLowerCase()
    };
  invocations.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
  if (!invocations.length) return setEmpty("logsContainer", "No recent Worker invocations returned for this range.");
  document.getElementById("logsContainer").innerHTML = `<table class="obs-table"><thead><tr><th>Time</th><th>Request</th><th>Status</th><th>Wall time</th><th>CPU</th><th>Service</th><th></th></tr></thead><tbody>${invocations.map((invocation, index) => `<tr><td>${formatTime(invocation.timestamp)}</td><td class="mono">${escapeHtml(invocation.requestLine)}</td><td>${invocation.statusCode == null ? "—" : `<span class="badge badge-${badgeClass(`${Math.floor(invocation.statusCode / 100)}xx`)}">${escapeHtml(invocation.statusCode)}</span>`}</td><td>${invocation.wallTimeMs == null ? "—" : `${Number(invocation.wallTimeMs).toFixed(1)} ms`}</td><td>${invocation.cpuTimeMs == null ? "—" : `${Number(invocation.cpuTimeMs).toFixed(1)} ms`}</td><td>${escapeHtml(invocation.service)}</td><td><button class="btn btn-ghost" onclick="toggleDetail('invocation-${index}')">Details</button></td></tr><tr><td colspan="7"><pre id="invocation-${index}" class="log-detail">${escapeHtml(JSON.stringify({ requestId: invocation.requestId, service: invocation.service, request: invocation.requestLine, statusCode: invocation.statusCode, wallTimeMs: invocation.wallTimeMs, cpuTimeMs: invocation.cpuTimeMs, events: invocation.events }, null, 2))}</pre></td></tr>`).join("")}</tbody></table>`;
}

async function loadMetrics() {
  const container = document.getElementById("metricsRequestTable");
  container.innerHTML = '<div class="empty-state">Loading CloudCart resource metrics…</div>';
  const data = await fetchApi(`${API}/metrics?range=${encodeURIComponent(range())}`);
  if (data?.error) return showError("metricsRequestTable", data.error);

  const result = data?.projectMetrics || {};
  const groups = result.data || {};
  const workerRows = groups.workersInvocationsAdaptive || [];
  const d1Rows = groups.d1AnalyticsAdaptiveGroups || [];
  const d1StorageRows = groups.d1StorageAdaptiveGroups || [];
  const kvRows = groups.kvOperationsAdaptiveGroups || [];
  const doRows = groups.durableObjectsInvocationsAdaptiveGroups || [];
  const sum = (rows, key) => rows.reduce((total, row) => total + (Number(row?.sum?.[key]) || 0), 0);
  const latest = rows => [...rows].sort((a, b) => String(b?.dimensions?.date || b?.dimensions?.datetime || "").localeCompare(String(a?.dimensions?.date || a?.dimensions?.datetime || "")))[0];
  const number = value => Number(value || 0).toLocaleString();
  const bytes = value => {
    if (value == null || !Number.isFinite(Number(value))) return "No data";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = Number(value), unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
  };
  const metricSection = (title, cards) => `<section class="metric-section"><h2 class="section-title">${escapeHtml(title)}</h2><div class="grid-3">${cards.map(([label, value, detail]) => metricCard(label, value, detail)).join("")}</div></section>`;
  const d1 = latest(d1Rows);
  const d1Storage = latest(d1StorageRows);
  const kvCounts = ["read", "write", "delete", "list"].map(action => `${action}: ${number(kvRows.filter(row => String(row?.dimensions?.actionType || "").toLowerCase() === action).reduce((total, row) => total + (Number(row?.sum?.requests) || 0), 0))}`).join(" · ");
  const sections = [
    metricSection("CloudCart Worker", [
      ["Requests", workerRows.length ? number(sum(workerRows, "requests")) : "No data", "Filtered by CloudCart Worker script"],
      ["Runtime errors", workerRows.length ? number(sum(workerRows, "errors")) : "No data", "Worker invocation errors"],
      ["CPU P99", latest(workerRows)?.quantiles?.cpuTimeP99 == null ? "No data" : `${Number(latest(workerRows).quantiles.cpuTimeP99).toFixed(1)} ms`, "Latest available Worker time bucket"]
    ]),
    metricSection("CloudCart D1 database", [
      ["Read queries", d1Rows.length ? number(sum(d1Rows, "readQueries")) : "No data", "UTC-day D1 analytics"],
      ["Write queries", d1Rows.length ? number(sum(d1Rows, "writeQueries")) : "No data", "UTC-day D1 analytics"],
      ["Rows read", d1Rows.length ? number(sum(d1Rows, "rowsRead")) : "No data", `${number(sum(d1Rows, "rowsWritten"))} rows written`],
      ["Query response", d1Rows.length ? bytes(sum(d1Rows, "queryBatchResponseBytes")) : "No data", "Serialized response bytes"],
      ["Latest query latency P90", d1?.quantiles?.queryBatchTimeMsP90 == null ? "No data" : `${Number(d1.quantiles.queryBatchTimeMsP90).toFixed(1)} ms`, d1?.dimensions?.date ? `UTC day ${d1.dimensions.date}` : "Latest available daily bucket"],
      ["Database size", d1StorageRows.length ? bytes(d1Storage?.max?.databaseSizeBytes) : "No data", d1Storage?.dimensions?.date ? `Latest sample · ${d1Storage.dimensions.date}` : "Latest available daily sample"]
    ]),
    metricSection("CloudCart KV namespace", [
      ["Operations", kvRows.length ? number(sum(kvRows, "requests")) : "No data", kvCounts],
      ["KV reads", kvRows.length ? number(kvRows.filter(row => String(row?.dimensions?.actionType || "").toLowerCase() === "read").reduce((total, row) => total + (Number(row?.sum?.requests) || 0), 0)) : "No data", "Filtered by CloudCart KV namespace ID"]
    ]),
    metricSection("CloudCart Durable Objects", [
      ["Requests", doRows.length ? number(sum(doRows, "requests")) : "No data", "Filtered by CloudCart Worker script"],
      ["Response bytes", doRows.length ? bytes(sum(doRows, "responseBodySize")) : "No data", "Durable Object invocation responses"]
    ])
  ];
  container.innerHTML = sections.join("");
  document.getElementById("lastUpdated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function metricCard(label, value, detail) {
  return `<div class="card"><div class="card-label">${escapeHtml(label)}</div><div class="card-value">${escapeHtml(value)}</div><div class="card-sub">${escapeHtml(detail)}</div></div>`;
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
