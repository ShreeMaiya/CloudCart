// CloudCart Observability — Distributed Tracing Engine (Pillar 3)
// Generates trace/span context, threads through request lifecycle,
// stores completed traces in a ring buffer for /api/observability/traces

const MAX_TRACES = 200;
const traceBuffer = [];

/**
 * Start a new trace for an incoming request.
 * Respects W3C traceparent header for upstream propagation.
 */
export function startTrace(request) {
  const traceId = extractOrGenerateTraceId(request);
  const spanId = generateSpanId();
  const startMs = performance.now();
  const startTime = Date.now();
  const path = new URL(request.url).pathname;

  return {
    traceId,
    rootSpanId: spanId,
    requestId: request.headers.get("X-Request-ID") || `req_${crypto.randomUUID().slice(0, 8)}`,
    endpoint: path,
    method: request.method,
    startMs,
    startTime,
    spans: [{
      spanId,
      parentSpanId: null,
      service: "worker",
      operation: "http.request",
      startOffsetMs: 0,
      durationMs: null,
      status: "ok",
      attributes: { endpoint: path, method: request.method }
    }],
    _openSpans: []
  };
}

/**
 * Open a child span on the active trace.
 * Returns the span object — pass to closeSpan() when the operation completes.
 */
export function addSpan(trace, { service, operation, parentSpanId, attributes = {} }) {
  if (!trace) return null;

  const spanId = generateSpanId();
  const startOffsetMs = parseFloat((performance.now() - trace.startMs).toFixed(2));

  const span = {
    spanId,
    parentSpanId: parentSpanId || trace.rootSpanId,
    service,
    operation,
    startOffsetMs,
    durationMs: null,
    status: "ok",
    attributes,
    _startPerf: performance.now()
  };

  trace._openSpans.push(span);
  return span;
}

/**
 * Close a span — records its duration and outcome.
 */
export function closeSpan(span, { status = "ok", error = null, attributes = {} } = {}) {
  if (!span || span.durationMs !== null) return;

  span.durationMs = Math.round(performance.now() - span._startPerf);
  span.status = error ? "error" : status;
  if (error) span.error = String(error).substring(0, 200);
  if (Object.keys(attributes).length > 0) {
    span.attributes = { ...span.attributes, ...attributes };
  }
  delete span._startPerf;
}

/**
 * Close the root span, finalize trace, push to ring buffer.
 */
export function closeTrace(trace, response, { businessEvent = null } = {}) {
  if (!trace) return null;

  const totalDuration = Math.round(performance.now() - trace.startMs);
  const httpStatus = response?.status || 0;

  const rootSpan = trace.spans[0];
  rootSpan.durationMs = totalDuration;
  rootSpan.status = httpStatus >= 500 ? "error"
                  : httpStatus >= 400 ? "client_error"
                  : "ok";
  rootSpan.attributes.httpStatus = httpStatus;

  for (const s of trace._openSpans) {
    if (s.durationMs === null) closeSpan(s);
  }

  const allSpans = [rootSpan, ...trace._openSpans];

  const completed = {
    traceId: trace.traceId,
    requestId: trace.requestId,
    endpoint: trace.endpoint,
    method: trace.method,
    httpStatus,
    durationMs: totalDuration,
    timestamp: new Date(trace.startTime).toISOString(),
    epochMs: trace.startTime,
    businessEvent: businessEvent || null,
    hasError: httpStatus >= 500,
    spanCount: allSpans.length,
    spans: allSpans
  };

  traceBuffer.unshift(completed);
  if (traceBuffer.length > MAX_TRACES) traceBuffer.pop();

  return completed;
}

/**
 * Query the trace ring buffer with filters.
 */
export function getTraces(filters = {}) {
  const { range = "1h", endpoint = "all", status = "all", businessEvent = "all", limit = 50, offset = 0 } = filters;

  const cutoff = Date.now() - parseRange(range);
  let filtered = traceBuffer.filter(t => t.epochMs >= cutoff);

  if (endpoint && endpoint !== "all") filtered = filtered.filter(t => t.endpoint === endpoint);
  if (status === "error") filtered = filtered.filter(t => t.hasError);
  else if (status === "ok") filtered = filtered.filter(t => !t.hasError);
  if (businessEvent && businessEvent !== "all") filtered = filtered.filter(t => t.businessEvent === businessEvent);

  const total = filtered.length;
  const listed = filtered.slice(offset, offset + limit).map(t => ({
    traceId: t.traceId, requestId: t.requestId, endpoint: t.endpoint,
    method: t.method, httpStatus: t.httpStatus, durationMs: t.durationMs,
    spanCount: t.spanCount, timestamp: t.timestamp, businessEvent: t.businessEvent, hasError: t.hasError
  }));

  return { total, timeRange: range, traces: listed, pagination: { total, limit, offset, hasMore: offset + limit < total } };
}

/**
 * Get a single trace by traceId (includes full spans for waterfall view).
 */
export function getTraceById(traceId) {
  return traceBuffer.find(t => t.traceId === traceId) || null;
}

// ─── Helpers ─────────────────────────────────────────────────────

function extractOrGenerateTraceId(request) {
  const tp = request?.headers?.get("traceparent");
  if (tp) {
    const parts = tp.split("-");
    if (parts.length === 4 && parts[1]?.length === 32) return parts[1];
  }
  return crypto.randomUUID().replace(/-/g, "");
}

function generateSpanId() {
  return `span_${crypto.randomUUID().slice(0, 8)}`;
}

function parseRange(range) {
  const map = { "15m": 900000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000 };
  return map[range] || map["1h"];
}
