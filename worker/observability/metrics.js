// CloudCart Observability — Metrics Engine (Pillar 2)
// Tracks HTTP request telemetry, business event counters, and infra stats.
// All counters are in-memory and reset on isolate eviction (expected for edge workers).

// ─── HTTP Request Ring Buffer ─────────────────────────────────────
const MAX_REQUESTS = 500;
const requestBuffer = [];

// ─── Business Event Counters ──────────────────────────────────────
const businessCounters = {
  checkouts_total: 0,
  checkouts_succeeded: 0,
  checkouts_failed: 0,
  products_created: 0,
  products_updated: 0,
  products_deleted: 0,
  feedback_submitted: 0,
  revenue_total_cents: 0
};

const businessEventHistory = [];
const MAX_EVENTS = 100;

/**
 * Record a completed HTTP request.
 */
export function recordRequest({ traceId, requestId, endpoint, method, status, durationMs, businessEvent = null, error = null }) {
  const entry = {
    traceId: traceId || null,
    requestId: requestId || `req_${Math.random().toString(36).slice(2, 10)}`,
    endpoint: endpoint || "/",
    method: method || "GET",
    status: status || 200,
    statusClass: status >= 500 ? "5xx" : status >= 400 ? "4xx" : "2xx",
    durationMs: Math.round(durationMs ?? 0),
    businessEvent: businessEvent || null,
    error: error ? String(error).substring(0, 200) : null,
    timestamp: new Date().toISOString(),
    epochMs: Date.now()
  };

  requestBuffer.unshift(entry);
  if (requestBuffer.length > MAX_REQUESTS) requestBuffer.pop();

  return entry;
}

/**
 * Increment a business event counter and add to event history.
 */
export function recordBusinessEvent(event, { amount = 0, traceId = null, metadata = {} } = {}) {
  switch (event) {
    case "CHECKOUT_SUCCEEDED":
      businessCounters.checkouts_total++;
      businessCounters.checkouts_succeeded++;
      if (amount > 0) businessCounters.revenue_total_cents += Math.round(amount * 100);
      break;
    case "CHECKOUT_FAILED":
      businessCounters.checkouts_total++;
      businessCounters.checkouts_failed++;
      break;
    case "PRODUCT_CREATED":  businessCounters.products_created++;  break;
    case "PRODUCT_UPDATED":  businessCounters.products_updated++;  break;
    case "PRODUCT_DELETED":  businessCounters.products_deleted++;  break;
    case "FEEDBACK_SUBMITTED": businessCounters.feedback_submitted++; break;
  }

  businessEventHistory.unshift({
    event, traceId, metadata,
    timestamp: new Date().toISOString(),
    epochMs: Date.now()
  });
  if (businessEventHistory.length > MAX_EVENTS) businessEventHistory.pop();
}

/**
 * Get HTTP request metrics aggregated by endpoint.
 */
export function getRequestMetrics(filters = {}) {
  const { range = "1h", endpoint = "all", status = "all" } = filters;

  const cutoff = Date.now() - parseRange(range);
  let filtered = requestBuffer.filter(r => r.epochMs >= cutoff);

  if (endpoint && endpoint !== "all") filtered = filtered.filter(r => r.endpoint === endpoint);
  if (status === "errors") filtered = filtered.filter(r => r.status >= 400);
  else if (status && status !== "all") filtered = filtered.filter(r => r.statusClass === status);

  // Group by endpoint
  const groups = {};
  for (const req of filtered) {
    const key = req.endpoint;
    if (!groups[key]) groups[key] = { endpoint: key, durations: [], total: 0, errors: 0, s2xx: 0, s4xx: 0, s5xx: 0 };
    const g = groups[key];
    g.total++;
    g.durations.push(req.durationMs);
    if (req.statusClass === "2xx") g.s2xx++;
    else if (req.statusClass === "4xx") { g.s4xx++; g.errors++; }
    else if (req.statusClass === "5xx") { g.s5xx++; g.errors++; }
  }

  const endpoints = Object.values(groups).map(g => {
    const p = calcPercentiles(g.durations);
    return {
      endpoint: g.endpoint,
      requests: g.total,
      errors: g.errors,
      errorRate: g.total > 0 ? +((g.errors / g.total) * 100).toFixed(2) : 0,
      s2xx: g.s2xx, s4xx: g.s4xx, s5xx: g.s5xx,
      latency: { avg: p.avg, p50: p.p50, p95: p.p95, p99: p.p99, samples: p.count }
    };
  }).sort((a, b) => b.requests - a.requests);

  const allDurations = filtered.map(r => r.durationMs);
  const overall = calcPercentiles(allDurations);
  const totalErrors = filtered.filter(r => r.status >= 400).length;

  return {
    timeRange: range,
    summary: {
      totalRequests: filtered.length,
      totalErrors,
      errorRate: filtered.length > 0 ? +((totalErrors / filtered.length) * 100).toFixed(2) : 0,
      latency: overall
    },
    endpoints
  };
}

/**
 * Get business event counters and recent history.
 */
export function getBusinessMetrics(range = "1h") {
  const cutoff = Date.now() - parseRange(range);
  const recentEvents = businessEventHistory.filter(e => e.epochMs >= cutoff);

  return {
    counters: {
      ...businessCounters,
      revenue_total: +(businessCounters.revenue_total_cents / 100).toFixed(2)
    },
    recentEvents: recentEvents.slice(0, 50),
    timeRange: range
  };
}

/**
 * Get raw recent requests for drill-down.
 */
export function getRecentRequests(limit = 50) {
  return requestBuffer.slice(0, Math.min(limit, 100));
}

// ─── Helpers ──────────────────────────────────────────────────────

function calcPercentiles(arr) {
  if (!arr || arr.length === 0) return { avg: null, p50: null, p95: null, p99: null, count: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    avg: Math.round(sum / sorted.length),
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95: sorted.length >= 5  ? (sorted[Math.floor(sorted.length * 0.95)] ?? null) : null,
    p99: sorted.length >= 10 ? (sorted[Math.floor(sorted.length * 0.99)] ?? null) : null,
    count: sorted.length
  };
}

function parseRange(range) {
  const map = { "15m": 900000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000 };
  return map[range] || map["1h"];
}
