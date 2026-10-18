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
  document.getElementById("logSearch").addEventListener("keydown", event => {
    if (event.key === "Enter") loadLogs();
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
  const services = data?.services || [];
  const healthy = services.filter(item => item.status === "HEALTHY").length;
  const degraded = services.filter(item => item.status === "DEGRADED").length;
  const down = services.filter(item => item.status === "DOWN").length;
  const unknown = services.filter(item => ["UNKNOWN", "NOT_CONFIGURED"].includes(item.status)).length;
  const status = down ? "DOWN" : degraded ? "DEGRADED" : unknown ? "UNKNOWN" : healthy ? "HEALTHY" : "UNKNOWN";
  updateStatus(status);
  document.getElementById("healthSub").textContent = `${data?.probe ? "Active probes plus current Worker status" : "Verified status; no dependency calls"} · ${formatTime(data?.timestamp)}`;
  document.getElementById("hHealthy").textContent = healthy;
  document.getElementById("hDegraded").textContent = degraded;
  document.getElementById("hFailed").textContent = down;
  document.getElementById("hUnknown").textContent = unknown;
  document.getElementById("hTotal").textContent = services.length;
  document.getElementById("serviceCards").innerHTML = services.map(service => {
  const cssStatus = ["UNKNOWN", "NOT_CONFIGURED"].includes(service.status) ? "unknown" : service.status.toLowerCase();
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
  }).sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
  const level = document.getElementById("logLevel").value;
  const service = document.getElementById("logService").value;
  const search = document.getElementById("logSearch").value.trim().toLowerCase();
  const filtered = invocations.filter(invocation => {
    const normalizedService = String(invocation.service).toLowerCase().replace(/[^a-z0-9]/g, "");
    return (level === "all" || invocation.level === level) && (service === "all" || normalizedService.includes(service.replace(/[^a-z0-9]/g, ""))) && (!search || invocation.searchText.includes(search));
  });
  document.getElementById("logCountPills").innerHTML = `<span class="log-count-pill">${filtered.length} invocations returned · maximum 100 · logs configured at 100% sampling</span>`;
  if (!filtered.length) return setEmpty("logsContainer", "No recent Worker invocations returned for this range and filter.");
  document.getElementById("logsContainer").innerHTML = `<table class="obs-table"><thead><tr><th>Time</th><th>Request</th><th>Status</th><th>Wall time</th><th>CPU</th><th>Service</th><th></th></tr></thead><tbody>${filtered.map((invocation, index) => `<tr><td>${formatTime(invocation.timestamp)}</td><td class="mono">${escapeHtml(invocation.requestLine)}</td><td>${invocation.statusCode == null ? "—" : `<span class="badge badge-${badgeClass(`${Math.floor(invocation.statusCode / 100)}xx`)}">${escapeHtml(invocation.statusCode)}</span>`}</td><td>${invocation.wallTimeMs == null ? "—" : `${Number(invocation.wallTimeMs).toFixed(1)} ms`}</td><td>${invocation.cpuTimeMs == null ? "—" : `${Number(invocation.cpuTimeMs).toFixed(1)} ms`}</td><td>${escapeHtml(invocation.service)}</td><td><button class="btn btn-ghost" onclick="toggleDetail('invocation-${index}')">All details (${invocation.events.length})</button></td></tr><tr><td colspan="7"><pre id="invocation-${index}" class="log-detail">${escapeHtml(JSON.stringify({ requestId: invocation.requestId, service: invocation.service, request: invocation.requestLine, statusCode: invocation.statusCode, wallTimeMs: invocation.wallTimeMs, cpuTimeMs: invocation.cpuTimeMs, events: invocation.events }, null, 2))}</pre></td></tr>`).join("")}</tbody></table>`;
}

async function loadMetrics() {
  const data = await fetchApi(`${API}/metrics?range=${encodeURIComponent(range())}`);
  if (data?.error) return showError("metricsRequestTable", data.error);
  const result = data || {};
  const account = result.accountMetrics || {};
  const groups = account.data || {};
  if (account.error) {
    document.getElementById("metricsRequestTable").innerHTML = `<div class="empty-state">${escapeHtml(account.error)}</div>`;
  } else {
    const workerRows = groups.workersInvocationsAdaptive || [];
    const d1Rows = groups.d1AnalyticsAdaptiveGroups || [];
    const d1StorageRows = groups.d1StorageAdaptiveGroups || [];
    const kvRows = groups.kvOperationsAdaptiveGroups || [];
    const kvStorageRows = groups.kvStorageAdaptiveGroups || [];
    const doRows = groups.durableObjectsInvocationsAdaptiveGroups || [];
    const doPeriodicRows = groups.durableObjectsPeriodicGroups || [];
    const doStorageRows = groups.durableObjectsStorageGroups || [];
    const total = (rows, field) => rows.reduce((sum, row) => sum + (Number(row?.sum?.[field]) || 0), 0);
    const rowsExist = rows => rows.length > 0;
    const sortedByDate = rows => [...rows].sort((a, b) => String(a?.dimensions?.datetime || a?.dimensions?.date || "").localeCompare(String(b?.dimensions?.datetime || b?.dimensions?.date || "")));
    const mostRecent = rows => sortedByDate(rows).at(-1) || null;
    const sumBy = (rows, field, value) => rows.filter(row => String(row?.dimensions?.[field] || "").toLowerCase() === value).reduce((sum, row) => sum + (Number(row?.sum?.requests) || 0), 0);
    const quantileFrom = (row, field) => row?.quantiles?.[field] == null ? null : Number(row.quantiles[field]);
    const formatNumber = value => value == null ? "No data" : new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
    const formatMs = value => value == null ? "No data" : `${Number(value).toFixed(value < 10 ? 1 : 0)} ms`;
    const formatBytes = value => {
      if (value == null) return "No data";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let amount = Number(value), unit = 0;
      while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
      return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`;
    };
    const card = (label, value, detail = "") => `<article class="card metric-card"><div class="card-label">${escapeHtml(label)}</div><div class="card-value">${escapeHtml(value)}</div><div class="card-sub">${escapeHtml(detail)}</div></article>`;
    const section = (title, id, content, hint = "") => `<section class="metric-section"><h2 class="section-title">${escapeHtml(title)}</h2>${hint ? `<p class="metrics-note">${escapeHtml(hint)}</p>` : ""}<div id="${id}">${content}</div></section>`;
    const chart = (rows, metric, label, { quantile, suffix = "", color = "#6366f1" } = {}) => {
      const points = sortedByDate(rows).map(row => ({
        x: row?.dimensions?.datetime || row?.dimensions?.date,
        y: quantile ? quantileFrom(row, quantile) : Number(row?.sum?.[metric])
      })).filter(point => point.x && Number.isFinite(point.y));
      if (!points.length) return `<div class="card empty-state">No ${escapeHtml(label.toLowerCase())} data returned for this range.</div>`;
      const width = 760, height = 150, pad = 22;
      const max = Math.max(1, ...points.map(point => point.y));
      const coords = points.map((point, index) => `${pad + (points.length === 1 ? (width - pad * 2) / 2 : index * (width - pad * 2) / (points.length - 1))},${height - pad - (point.y / max) * (height - pad * 2)}`);
      const firstLabel = points[0].x.includes("T") ? formatTime(points[0].x) : points[0].x;
      const lastLabel = points.at(-1).x.includes("T") ? formatTime(points.at(-1).x) : points.at(-1).x;
      const latest = points.at(-1);
      return `<div class="card metric-chart"><div class="chart-heading"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(formatNumber(latest.y))}${escapeHtml(suffix)} latest bucket</span></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)} over time"><line x1="${pad}" y1="${pad}" x2="${width-pad}" y2="${pad}"/><line x1="${pad}" y1="${height/2}" x2="${width-pad}" y2="${height/2}"/><line x1="${pad}" y1="${height-pad}" x2="${width-pad}" y2="${height-pad}"/><polyline points="${coords.join(" ")}" style="stroke:${color}"/>${coords.map((point, index) => `<circle cx="${point.split(",")[0]}" cy="${point.split(",")[1]}" r="3"><title>${escapeHtml(points[index].x)}: ${escapeHtml(formatNumber(points[index].y))}${escapeHtml(suffix)}</title></circle>`).join("")}</svg><div class="chart-axis"><span>${escapeHtml(firstLabel)}</span><span>${escapeHtml(lastLabel)}</span></div></div>`;
    };
    const workerLatest = mostRecent(workerRows);
    const d1Latest = mostRecent(d1Rows);
    const kvReadRows = kvRows.filter(row => String(row?.dimensions?.actionType || "").toLowerCase() === "read");
    const kvLatest = mostRecent(kvReadRows);
    const doLatestPeriodic = mostRecent(doPeriodicRows);
    const d1LatestStorage = mostRecent(d1StorageRows);
    const kvLatestStorage = mostRecent(kvStorageRows);
    const doLatestStorage = mostRecent(doStorageRows);
    const workerErrorRate = total(workerRows, "requests") ? `${(total(workerRows, "errors") / total(workerRows, "requests") * 100).toFixed(2)}% of invocations` : "No request groups";
    const kvCounts = ["read", "write", "delete", "list"].map(action => `${action}: ${formatNumber(sumBy(kvRows, "actionType", action))}`).join(" · ");
    const d1StorageBytes = d1LatestStorage?.max?.databaseSizeBytes;
    const kvBytes = kvLatestStorage?.max?.byteCount;
    const kvKeys = kvLatestStorage?.max?.keyCount;
    const doBytes = doLatestStorage?.max?.storedBytes;
    const doCpu = total(doPeriodicRows, "cpuTime");
    const missing = [!rowsExist(workerRows) && "Worker", !rowsExist(d1Rows) && "D1", !rowsExist(kvRows) && "KV", !rowsExist(doRows) && "Durable Objects"].filter(Boolean);
    const coverage = account.dateCoverage || "Cloudflare account analytics can be delayed or sampled.";

    document.getElementById("metricsRequestTable").innerHTML = [
      section("Worker runtime", "workerMetrics", `<div class="grid-3">
        ${card("Incoming requests", formatNumber(total(workerRows, "requests")), "Selected range; includes dashboard API requests")}
        ${card("Runtime errors", formatNumber(total(workerRows, "errors")), workerErrorRate)}
        ${card("Fetch subrequests", formatNumber(total(workerRows, "subrequests")), "Worker initiated fetch calls; binding operations are separate")}
        ${card("CPU P50", formatMs(quantileFrom(workerLatest, "cpuTimeP50")), "Most recent Cloudflare time bucket")}
        ${card("CPU P99", formatMs(quantileFrom(workerLatest, "cpuTimeP99")), "Most recent Cloudflare time bucket")}
        ${card("Wall time P50", formatMs(quantileFrom(workerLatest, "wallTimeP50")), "Elapsed Worker execution time; most recent bucket")}
        ${card("Wall time P99", formatMs(quantileFrom(workerLatest, "wallTimeP99")), "Elapsed Worker execution time; most recent bucket")}
      </div>${chart(workerRows, "requests", "Worker requests", { color: "#10b981" })}${chart(workerRows, "errors", "Worker runtime errors", { color: "#ef4444" })}${chart(workerRows, null, "Worker CPU P99", { quantile: "cpuTimeP99", suffix: " ms", color: "#6366f1" })}${chart(workerRows, null, "Worker wall time P99", { quantile: "wallTimeP99", suffix: " ms", color: "#06b6d4" })}`),
      section("D1 database", "d1Metrics", `<div class="grid-3">
        ${card("Queries", rowsExist(d1Rows) ? formatNumber(total(d1Rows, "readQueries") + total(d1Rows, "writeQueries")) : "No data", `${formatNumber(total(d1Rows, "readQueries"))} reads · ${formatNumber(total(d1Rows, "writeQueries"))} writes`)}
        ${card("Rows scanned", rowsExist(d1Rows) ? formatNumber(total(d1Rows, "rowsRead")) : "No data", `${formatNumber(total(d1Rows, "rowsWritten"))} rows written`)}
        ${card("Query latency P90", formatMs(quantileFrom(d1Latest, "queryBatchTimeMsP90")), "Most recent UTC day; includes server response serialization")}
        ${card("Query response", rowsExist(d1Rows) ? formatBytes(total(d1Rows, "queryBatchResponseBytes")) : "No data", "Serialized D1 query response bytes")}
        ${card("Database size", formatBytes(d1StorageBytes == null ? null : Number(d1StorageBytes)), "Latest available daily storage sample")}
      </div>${chart(d1Rows, "readQueries", "D1 reads per day", { color: "#3b82f6" })}${chart(d1Rows, "writeQueries", "D1 writes per day", { color: "#f59e0b" })}`),
      section("KV namespace", "kvMetrics", `<div class="grid-3">
        ${card("Operations", rowsExist(kvRows) ? formatNumber(total(kvRows, "requests")) : "No data", kvCounts)}
        ${card("Read latency P50", formatMs(quantileFrom(kvLatest, "latencyMsP50")), "Most recent daily read sample")}
        ${card("Read latency P90", formatMs(quantileFrom(kvLatest, "latencyMsP90")), "Most recent daily read sample")}
        ${card("Stored data", formatBytes(kvBytes == null ? null : Number(kvBytes)), "Latest available daily namespace sample")}
        ${card("Stored keys", formatNumber(kvKeys == null ? null : Number(kvKeys)), "Latest available daily namespace sample")}
      </div>${chart(kvRows.filter(row => String(row?.dimensions?.actionType || "").toLowerCase() === "read"), "requests", "KV reads per day", { color: "#8b5cf6" })}${chart(kvRows.filter(row => String(row?.dimensions?.actionType || "").toLowerCase() === "write"), "requests", "KV writes per day", { color: "#f59e0b" })}`),
      section("Inventory Durable Object", "doMetrics", `<div class="grid-3">
        ${card("Requests", rowsExist(doRows) ? formatNumber(total(doRows, "requests")) : "No data", "Durable Object invocation analytics")}
        ${card("CPU time", rowsExist(doPeriodicRows) ? formatMs(doCpu) : "No data", "Total reported periodic CPU time")}
        ${card("Memory P90", formatBytes(quantileFrom(doLatestPeriodic, "memoryUsageBytesP90")), "Isolate memory; sampled daily")}
        ${card("Response bytes", rowsExist(doRows) ? formatBytes(total(doRows, "responseBodySize")) : "No data", "Durable Object response bodies")}
        ${card("Stored bytes", formatBytes(doBytes == null ? null : Number(doBytes)), "Latest available daily storage sample")}
      </div>${chart(doRows, "requests", "Durable Object requests per day", { color: "#06b6d4" })}`),
      `<div class="card metrics-note">${escapeHtml(coverage)}${missing.length ? ` Missing data groups: ${escapeHtml(missing.join(", "))}. Missing means unavailable, not zero.` : ""}${account.kvNamespaceConfigured === false ? " KV analytics are omitted because the deployed KV namespace ID is not configured." : ""} This page reads Cloudflare analytics only; it makes no D1 or KV binding calls.</div>`
    ].join("");
  }
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
