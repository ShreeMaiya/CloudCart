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
  document.getElementById("includeObservabilityTraces").addEventListener("change", () => {
    if (currentTab === "traces") loadTraces();
  });
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
  // Show only services with a current health signal; unverified services are
  // omitted instead of making the overall system appear unknown.
  const services = (data?.services || []).filter(item => ["HEALTHY", "DEGRADED", "DOWN"].includes(item.status));
  const known = services;
  const healthy = known.filter(item => item.status === "HEALTHY").length;
  const degraded = known.filter(item => item.status === "DEGRADED").length;
  const down = known.filter(item => item.status === "DOWN").length;
  const status = down ? "DOWN" : degraded ? "DEGRADED" : known.length ? "HEALTHY" : "UNKNOWN";
  updateStatus(status);
  document.getElementById("healthSub").textContent = `${data?.probe ? "Active probes plus current Worker status" : "Verified status; no dependency calls"} · ${formatTime(data?.timestamp)}`;
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
  document.getElementById("overallStatusText").textContent = `Verified services ${status.toLowerCase()}`;
  document.getElementById("healthOrb").className = `health-orb ${status.toLowerCase()}`;
  document.getElementById("healthOrb").textContent = status === "HEALTHY" ? "✓" : status === "DEGRADED" ? "!" : status === "DOWN" ? "×" : "?";
  document.getElementById("healthTitle").textContent = `Verified services ${status.toLowerCase()}`;
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
      traceId: metadata.traceId || workers.traceId || null,
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
  document.getElementById("logsContainer").innerHTML = `<table class="obs-table"><thead><tr><th>Time</th><th>Request</th><th>Status</th><th>Wall time</th><th>CPU</th><th>Service</th><th>Trace</th><th></th></tr></thead><tbody>${filtered.map((invocation, index) => `<tr><td>${formatTime(invocation.timestamp)}</td><td class="mono">${escapeHtml(invocation.requestLine)}</td><td>${invocation.statusCode == null ? "—" : `<span class="badge badge-${badgeClass(`${Math.floor(invocation.statusCode / 100)}xx`)}">${escapeHtml(invocation.statusCode)}</span>`}</td><td>${invocation.wallTimeMs == null ? "—" : `${Number(invocation.wallTimeMs).toFixed(1)} ms`}</td><td>${invocation.cpuTimeMs == null ? "—" : `${Number(invocation.cpuTimeMs).toFixed(1)} ms`}</td><td>${escapeHtml(invocation.service)}</td><td>${invocation.traceId ? `<button class="btn btn-ghost" onclick="openRelatedTrace('${escapeHtml(invocation.traceId)}')">View trace</button>` : "—"}</td><td><button class="btn btn-ghost" onclick="toggleDetail('invocation-${index}')">Details (${invocation.events.length})</button></td></tr><tr><td colspan="8"><pre id="invocation-${index}" class="log-detail">${escapeHtml(JSON.stringify({ requestId: invocation.requestId, traceId: invocation.traceId, events: invocation.events }, null, 2))}</pre></td></tr>`).join("")}</tbody></table>`;
}

async function loadMetrics() {
  const data = await fetchApi(`${API}/metrics?range=${encodeURIComponent(range())}`);
  if (data?.error) return showError("metricsRequestTable", data.error);
  const result = data?.data || {};
  const account = result.accountMetrics || {};
  const groups = account.data || {};
  if (account.error) {
    document.getElementById("metricsRequestTable").innerHTML = `<div class="empty-state">${escapeHtml(account.error)}</div>`;
  } else {
  const workerRows = groups.workersInvocationsAdaptive || [];
  const d1Rows = groups.d1AnalyticsAdaptiveGroups || [];
  const doRows = groups.durableObjectsInvocationsAdaptiveGroups || [];
  const total = (rows, field) => rows.reduce((sum, row) => sum + (Number(row?.sum?.[field]) || 0), 0);
  // Empty analytics results mean unavailable data, not confirmed zero usage.
  const noRows = rows => rows.length === 0;
  const noData = "No data";
  const explainRows = (rows, detail) => noRows(rows) ? "No analytics groups returned for this range" : detail;
  const worker = {
    requests: total(workerRows, "requests"), errors: total(workerRows, "errors"), subrequests: total(workerRows, "subrequests"),
    cpuP50Ms: workerRows.find(row => row?.quantiles?.cpuTimeP50 != null)?.quantiles?.cpuTimeP50 ?? null,
    cpuP99Ms: workerRows.find(row => row?.quantiles?.cpuTimeP99 != null)?.quantiles?.cpuTimeP99 ?? null
  };
  const d1 = { readQueries: total(d1Rows, "readQueries"), writeQueries: total(d1Rows, "writeQueries"), rowsRead: total(d1Rows, "rowsRead"), rowsWritten: total(d1Rows, "rowsWritten") };
  const durableObjects = { requests: total(doRows, "requests") };
  const missingSources = [noRows(workerRows) && "Worker", noRows(doRows) && "Durable Objects", noRows(d1Rows) && "D1"].filter(Boolean);
  document.getElementById("metricsRequestTable").innerHTML = `<div class="grid-3">
    ${metricCard("Worker requests", noRows(workerRows) ? noData : worker.requests, explainRows(workerRows, `${worker.errors} errors · ${worker.subrequests} subrequests`))}
    ${metricCard("Worker CPU", noRows(workerRows) || worker.cpuP50Ms == null ? "—" : `${worker.cpuP50Ms} ms`, noRows(workerRows) ? explainRows(workerRows) : `P99 ${worker.cpuP99Ms == null ? "—" : `${worker.cpuP99Ms} ms`}`)}
    ${metricCard("Durable Object requests", noRows(doRows) ? noData : durableObjects.requests, explainRows(doRows, "Cloudflare account analytics"))}
    ${metricCard("D1 queries", noRows(d1Rows) ? noData : d1.readQueries + d1.writeQueries, explainRows(d1Rows, `${d1.readQueries} reads · ${d1.writeQueries} writes`))}
    ${metricCard("D1 rows read", noRows(d1Rows) ? noData : d1.rowsRead, explainRows(d1Rows, `${d1.rowsWritten} rows written`))}
  </div>${missingSources.length ? `<div class="card-sub metrics-note">Cloudflare returned no analytics groups for: ${escapeHtml(missingSources.join(", "))}. This is unavailable data, not a confirmed zero; analytics can be delayed or the configured account/resource identifiers may not match.</div>` : ""}<div class="card-sub metrics-note">Cloudflare account analytics. D1 and Durable Object totals are grouped by UTC date, so a sub-day selection can include a full UTC day. Worker request totals include requests made by this observability dashboard. Sampled telemetry counts may be estimates. This panel makes no D1 or KV calls.</div>`;
  }
}

function metricCard(label, value, detail) {
  return `<div class="card"><div class="card-label">${escapeHtml(label)}</div><div class="card-value">${escapeHtml(value)}</div><div class="card-sub">${escapeHtml(detail)}</div></div>`;
}

async function loadTraces(focusTraceId = null) {
  const data = await fetchApi(`${API}/traces?range=${encodeURIComponent(range())}&limit=80`);
  if (data?.error) return showError("tracesContainer", data.error);
  const allTraces = data?.data?.traces || [];
  const includeInternal = document.getElementById("includeObservabilityTraces")?.checked;
  const appTraces = allTraces.filter(trace => !isObservabilityRequest(trace));
  const visibleTraces = includeInternal ? allTraces : appTraces;
  const traces = focusTraceId ? allTraces.filter(trace => trace.traceId === focusTraceId) : visibleTraces;
  if (focusTraceId && !traces.length) return setEmpty("tracesContainer", "No matching sampled trace was returned for this request. Traces are sampled, so this request may have no trace record.");
  if (!traces.length) return setEmpty("tracesContainer", allTraces.length ? "Only dashboard observability requests were returned in this time range. Try a wider range or enable “Include dashboard telemetry requests”." : "No recent traces were returned. Confirm tracing is enabled and check the selected time range or Cloudflare’s daily ingestion limit.");
  document.getElementById("tracesContainer").innerHTML = `<table class="obs-table trace-row"><thead><tr><th>Trace ID</th><th>Transaction</th><th>Services</th><th>Duration</th><th>Started</th><th></th></tr></thead><tbody>${traces.map((trace, index) => `<tr><td class="mono">${escapeHtml(trace.traceId || "—")}</td><td>${escapeHtml(trace.rootTransactionName || trace.rootSpanName || "—")}</td><td>${escapeHtml(Array.isArray(trace.service) ? trace.service.join(", ") : trace.service || "—")}</td><td>${trace.traceDurationMs == null ? "—" : `${Number(trace.traceDurationMs).toFixed(1)} ms`}</td><td>${formatTime(trace.traceStartMs)}</td><td><button class="btn btn-ghost" onclick="openTraceDetails(${index}, '${escapeHtml(trace.traceId || "")}')">Waterfall</button></td></tr><tr><td colspan="6"><div class="log-detail trace-detail" id="trace-${index}"></div></td></tr>`).join("")}</tbody></table>`;
}

function isObservabilityRequest(trace) {
  const transaction = String(trace?.rootTransactionName || trace?.rootSpanName || "").toLowerCase();
  return transaction.includes("/api/observability/");
}

async function openTraceDetails(index, traceId) {
  const panel = document.getElementById(`trace-${index}`);
  if (!panel) return;
  if (panel.classList.contains("visible")) { panel.classList.remove("visible"); return; }
  panel.classList.add("visible");
  if (panel.dataset.loaded === "true" || panel.dataset.loading === "true") return;
  panel.dataset.loading = "true";
  panel.innerHTML = '<div class="empty-state">Loading sampled span timings…</div>';
  const data = await fetchApi(`${API}/trace-spans?traceId=${encodeURIComponent(traceId)}&range=${encodeURIComponent(range())}`);
  panel.dataset.loading = "false";
  panel.dataset.loaded = "true";
  if (data?.error) {
    panel.innerHTML = `<div class="empty-state">Could not load span timings: ${escapeHtml(data.error)}</div>`;
    return;
  }
  panel.innerHTML = renderTraceWaterfall(data?.data || {}, data?.data?.spans || []);
}

function renderTraceWaterfall(trace, events) {
  const spans = events.map(event => {
    const metadata = event?.$metadata || {};
    const workers = event?.$workers || {};
    const source = parseSource(event?.source);
    const get = (...values) => values.find(value => value !== undefined && value !== null && value !== "");
    const rawStart = get(metadata.startTime, event.startTime, metadata.timestamp, event.timestamp, source.startTime, source.timestamp);
    const start = rawStart == null ? null : (typeof rawStart === "number" ? rawStart : Date.parse(rawStart));
    const rawDuration = get(metadata.duration, event.duration, workers.wallTimeMs, source.duration, source.wallTimeMs);
    const duration = rawDuration == null || !Number.isFinite(Number(rawDuration)) ? null : Number(rawDuration);
    const name = get(metadata.spanName, event.spanName, source.spanName, metadata.trigger, source.message, event.message, workers.eventType, "Worker span");
    const service = get(metadata.service, workers.scriptName, workers.entrypoint, source.service, "Cloudflare Worker");
    return { name: String(name), service: String(service), start: Number.isFinite(start) ? start : null, duration, status: get(metadata.statusCode, event.statusCode, source.statusCode), error: get(metadata.error, event.error, source.error), spanId: get(metadata.spanId, workers.spanId, event.spanId) };
  }).sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
  if (!spans.length) return '<div class="empty-state">Cloudflare returned the trace summary, but no span timing records for this trace. Per-service timing is unavailable for this sampled request.</div>';

  const timed = spans.filter(span => span.start != null && span.duration != null && span.duration >= 0);
  if (!timed.length) return `<div class="empty-state">Cloudflare returned ${spans.length} span record${spans.length === 1 ? "" : "s"}, but did not include start times and durations needed for a waterfall.</div>${renderSpanList(spans)}`;
  const minStart = Math.min(...timed.map(span => span.start));
  const maxEnd = Math.max(...timed.map(span => span.start + span.duration));
  const total = Math.max(maxEnd - minStart, 1);
  const ticks = [0, 0.5, 1].map(fraction => `<span>${fraction === 0 ? "0 ms" : `${(total * fraction).toFixed(1)} ms`}</span>`).join("");
  const rows = spans.map(span => {
    const offset = span.start == null ? null : Math.max(0, (span.start - minStart) / total * 100);
    const width = span.duration == null ? null : Math.max(0.5, span.duration / total * 100);
    const tone = serviceTone(`${span.service} ${span.name}`);
    const timing = span.duration == null ? "Timing unavailable" : `${span.duration.toFixed(2)} ms`;
    const bar = offset == null || width == null ? '<span class="span-unavailable">Timing unavailable</span>' : `<div class="span-track"><div class="span-bar ${tone}" style="left:${offset}%;width:${Math.min(width, 100 - offset)}%" title="${escapeHtml(span.service)} · ${escapeHtml(timing)}"></div></div>`;
    return `<div class="span-row"><div class="span-label"><span class="span-service ${tone}">${escapeHtml(span.service)}</span><span class="span-name-text">${escapeHtml(span.name)}</span></div>${bar}<span class="span-dur">${escapeHtml(timing)}</span></div>`;
  }).join("");
  return `<div class="waterfall-wrap"><div class="waterfall-title">Request timeline <span>${timed.length} of ${spans.length} spans have timing</span></div><div class="waterfall-axis"><span>Relative to first recorded span</span><div>${ticks}</div><span>Duration ${total.toFixed(2)} ms</span></div><div class="waterfall-rows">${rows}</div><div class="waterfall-footnote">Cloudflare returns sampled spans. Missing D1, KV, or Durable Object bars mean no corresponding timed span was returned; timings are not inferred.</div></div>`;
}

function renderSpanList(spans) {
  return `<div class="waterfall-rows">${spans.map(span => `<div class="span-row"><div class="span-label"><span class="span-service">${escapeHtml(span.service)}</span><span class="span-name-text">${escapeHtml(span.name)}</span></div><span class="span-unavailable">${span.start == null ? "Start unavailable" : ""}${span.duration == null ? " · Duration unavailable" : ` · ${span.duration.toFixed(2)} ms`}</span></div>`).join("")}</div>`;
}

function serviceTone(value) {
  const text = value.toLowerCase();
  if (text.includes("d1")) return "d1";
  if (text.includes("kv")) return "kv";
  if (text.includes("durable") || text.includes("inventorydo")) return "inventory_do";
  return "worker";
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
window.openTraceDetails = openTraceDetails;
window.openRelatedTrace = traceId => {
  document.querySelectorAll(".tab-btn").forEach(button => button.classList.toggle("active", button.dataset.tab === "traces"));
  document.querySelectorAll(".tab-view").forEach(view => view.classList.toggle("active", view.id === "view-traces"));
  currentTab = "traces";
  loadTraces(traceId);
};
