// CloudCart Monitoring - Application Request Instrumentation & Telemetry Engine
import { METRIC_SOURCES, isDemoMode, formatMetric } from "./sources.js";

// Ring buffer for live requests (max 500 entries) — starts empty in production!
const MAX_LOG_ENTRIES = 500;
const requestBuffer = [];
const businessEventsBuffer = [];

/**
 * Generate demo entries strictly for local simulation when MONITORING_DEMO_MODE=true
 */
function createDemoEntries() {
  const seeds = [];
  const now = Date.now();
  const endpointsConfig = [
    { endpoint: "/api/products", method: "GET", service: "CloudCart Worker / D1", count: 42, baseLatency: 12, errorRate: 0.0 },
    { endpoint: "/api/products", method: "POST", service: "CloudCart Worker / D1", count: 6, baseLatency: 35, errorRate: 0.0 },
    { endpoint: "/api/checkout", method: "POST", service: "InventoryDO / D1", count: 18, baseLatency: 48, errorRate: 0.05 },
    { endpoint: "/api/session/cart", method: "GET", service: "CloudCart Worker / KV", count: 32, baseLatency: 15, errorRate: 0.0 },
    { endpoint: "/api/session/cart", method: "POST", service: "CloudCart Worker / KV", count: 24, baseLatency: 22, errorRate: 0.0 },
    { endpoint: "/api/feedback", method: "GET", service: "CloudCart Worker / D1", count: 12, baseLatency: 16, errorRate: 0.0 },
    { endpoint: "/api/feedback", method: "POST", service: "CloudCart Worker / D1", count: 4, baseLatency: 32, errorRate: 0.0 },
    { endpoint: "/api/metrics", method: "GET", service: "CloudCart Worker / D1", count: 15, baseLatency: 18, errorRate: 0.0 },
    { endpoint: "/api/health", method: "GET", service: "CloudCart Worker", count: 35, baseLatency: 4, errorRate: 0.0 },
    { endpoint: "/api/sync", method: "GET", service: "InventoryDO (WebSocket)", count: 14, baseLatency: 8, errorRate: 0.0 }
  ];

  for (const cfg of endpointsConfig) {
    for (let i = 0; i < cfg.count; i++) {
      const isError = Math.random() < cfg.errorRate;
      const status = isError ? (Math.random() > 0.5 ? 400 : 500) : 200;
      const jitter = Math.floor(Math.random() * (cfg.baseLatency * 0.8));
      const durationMs = Math.max(1, cfg.baseLatency + jitter);
      const timeOffsetMs = Math.floor(Math.random() * 3600 * 1000);

      seeds.push({
        requestId: `demo_req_${Math.random().toString(36).substring(2, 10)}`,
        endpoint: cfg.endpoint,
        method: cfg.method,
        status,
        statusClass: status >= 500 ? "5xx" : status >= 400 ? "4xx" : "2xx",
        durationMs,
        service: cfg.service,
        error: isError ? (status === 500 ? "Internal Database Error (Demo)" : "Bad Request Validation (Demo)") : null,
        operationType: `HTTP_${cfg.method}`,
        timestamp: new Date(now - timeOffsetMs).toISOString(),
        epochMs: now - timeOffsetMs,
        source: METRIC_SOURCES.DEMO
      });
    }
  }

  return seeds.sort((a, b) => b.epochMs - a.epochMs);
}

/**
 * Record a live HTTP request into the telemetry ring buffer
 */
export function recordRequest(entry) {
  // Enforce security: redact sensitive properties if accidentally present
  const sanitized = {
    requestId: entry.requestId || `req_${Math.random().toString(36).substring(2, 10)}`,
    endpoint: entry.endpoint || "/",
    method: entry.method || "GET",
    status: entry.status || 200,
    statusClass: entry.status >= 500 ? "5xx" : entry.status >= 400 ? "4xx" : "2xx",
    durationMs: Math.round(entry.durationMs ?? 1),
    service: entry.service || "CloudCart Worker",
    error: entry.error ? String(entry.error).substring(0, 200) : null,
    operationType: entry.operationType || "HTTP_REQUEST",
    businessEvent: entry.businessEvent || null,
    timestamp: new Date().toISOString(),
    epochMs: Date.now(),
    source: METRIC_SOURCES.APPLICATION_INSTRUMENTED
  };

  requestBuffer.unshift(sanitized);
  if (requestBuffer.length > MAX_LOG_ENTRIES) {
    requestBuffer.pop();
  }

  if (sanitized.businessEvent) {
    businessEventsBuffer.unshift({
      event: sanitized.businessEvent,
      requestId: sanitized.requestId,
      endpoint: sanitized.endpoint,
      timestamp: sanitized.timestamp,
      epochMs: sanitized.epochMs,
      source: METRIC_SOURCES.APPLICATION_INSTRUMENTED
    });
    if (businessEventsBuffer.length > 100) businessEventsBuffer.pop();
  }

  return sanitized;
}

/**
 * Record standalone business events (e.g. Stock Updated, Checkout Succeeded)
 */
export function recordBusinessEvent(event, metadata = {}) {
  const entry = {
    event,
    metadata,
    timestamp: new Date().toISOString(),
    epochMs: Date.now(),
    source: METRIC_SOURCES.APPLICATION_INSTRUMENTED
  };
  businessEventsBuffer.unshift(entry);
  if (businessEventsBuffer.length > 100) businessEventsBuffer.pop();
  return entry;
}

/**
 * Calculate percentiles (Avg, P50, P95, P99)
 * Returns null for percentiles when insufficient real data exists.
 */
function calculatePercentiles(durations) {
  if (!durations || durations.length === 0) {
    return { avg: null, p50: null, p95: null, p99: null, sampleCount: 0 };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const avg = Math.round(sum / sorted.length);

  // Return percentiles only if we have at least 1 sample for p50,
  // and require at least 5 samples for p95/p99 to be statistically honest.
  const p50 = sorted[Math.floor(sorted.length * 0.50)] ?? null;
  const p95 = sorted.length >= 5 ? (sorted[Math.floor(sorted.length * 0.95)] ?? null) : null;
  const p99 = sorted.length >= 10 ? (sorted[Math.floor(sorted.length * 0.99)] ?? null) : null;

  return { avg, p50, p95, p99, sampleCount: sorted.length };
}

/**
 * Filter requests by time window
 */
function filterByTimeRange(items, range = "1h") {
  const now = Date.now();
  const rangesInMs = {
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000
  };

  const windowMs = rangesInMs[range] || rangesInMs["1h"];
  const cutoff = now - windowMs;
  return items.filter(i => i.epochMs >= cutoff);
}

/**
 * Get aggregated API Endpoint Performance Metrics
 */
export function getApiEndpointMetrics(filters = {}, env = null) {
  const { range = "1h", endpoint = "all", status = "all", service = "all" } = filters;
  const demoActive = isDemoMode(env);

  // Use live buffer; if demo mode is enabled and buffer is empty, load demo items
  let sourceBuffer = requestBuffer;
  let dataSource = METRIC_SOURCES.APPLICATION_INSTRUMENTED;

  if (demoActive && requestBuffer.length === 0) {
    sourceBuffer = createDemoEntries();
    dataSource = METRIC_SOURCES.DEMO;
  }

  // 1. Time range filter
  let filtered = filterByTimeRange(sourceBuffer, range);

  // 2. Endpoint filter
  if (endpoint && endpoint !== "all") {
    filtered = filtered.filter(r => r.endpoint === endpoint);
  }

  // 3. Status filter
  if (status && status !== "all") {
    if (status === "errors") {
      filtered = filtered.filter(r => r.status >= 400);
    } else {
      filtered = filtered.filter(r => r.statusClass === status);
    }
  }

  // 4. Service filter
  if (service && service !== "all") {
    filtered = filtered.filter(r => r.service.toLowerCase().includes(service.toLowerCase()));
  }

  // Group by normalized endpoint
  const groups = {};
  for (const req of filtered) {
    if (!groups[req.endpoint]) {
      groups[req.endpoint] = {
        endpoint: req.endpoint,
        service: req.service,
        durations: [],
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        count2xx: 0,
        count4xx: 0,
        count5xx: 0
      };
    }

    const g = groups[req.endpoint];
    g.requestCount++;
    g.durations.push(req.durationMs);

    if (req.statusClass === "2xx") {
      g.count2xx++;
      g.successCount++;
    } else if (req.statusClass === "4xx") {
      g.count4xx++;
      g.errorCount++;
    } else if (req.statusClass === "5xx") {
      g.count5xx++;
      g.errorCount++;
    }
  }

  // Calculate stats for each endpoint
  const endpointRows = Object.values(groups).map(g => {
    const stats = calculatePercentiles(g.durations);
    const errorRatePercent = g.requestCount > 0
      ? Number(((g.errorCount / g.requestCount) * 100).toFixed(2))
      : 0;

    return {
      endpoint: g.endpoint,
      service: g.service,
      requestCount: formatMetric(g.requestCount, dataSource),
      successCount: formatMetric(g.successCount, dataSource),
      errorCount: formatMetric(g.errorCount, dataSource),
      count2xx: formatMetric(g.count2xx, dataSource),
      count4xx: formatMetric(g.count4xx, dataSource),
      count5xx: formatMetric(g.count5xx, dataSource),
      avgLatencyMs: stats.avg !== null
        ? formatMetric(stats.avg, METRIC_SOURCES.CALCULATED, { calculation: "mean of measured request durations", unit: "ms" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "No request duration samples recorded" }),
      p50Ms: stats.p50 !== null
        ? formatMetric(stats.p50, METRIC_SOURCES.CALCULATED, { calculation: "50th percentile of measured durations", unit: "ms" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "No request duration samples recorded" }),
      p95Ms: stats.p95 !== null
        ? formatMetric(stats.p95, METRIC_SOURCES.CALCULATED, { calculation: "95th percentile of measured durations (min 5 samples)", unit: "ms" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Insufficient request samples (< 5) for P95" }),
      p99Ms: stats.p99 !== null
        ? formatMetric(stats.p99, METRIC_SOURCES.CALCULATED, { calculation: "99th percentile of measured durations (min 10 samples)", unit: "ms" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Insufficient request samples (< 10) for P99" }),
      errorRatePercent: formatMetric(errorRatePercent, METRIC_SOURCES.CALCULATED, { calculation: "(errorCount / requestCount) * 100", unit: "%" }),
      source: dataSource
    };
  });

  // Sort by requestCount descending
  endpointRows.sort((a, b) => (b.requestCount.value || 0) - (a.requestCount.value || 0));

  // Overall summary KPIs across all filtered requests
  const allDurations = filtered.map(r => r.durationMs);
  const overallStats = calculatePercentiles(allDurations);
  const totalRequests = filtered.length;
  const totalErrors = filtered.filter(r => r.status >= 400).length;
  const overallErrorRate = totalRequests > 0
    ? Number(((totalErrors / totalRequests) * 100).toFixed(2))
    : 0;

  return {
    source: dataSource,
    isDemoData: demoActive,
    summary: {
      totalRequests: formatMetric(totalRequests, dataSource),
      totalErrors: formatMetric(totalErrors, dataSource),
      overallAvgLatency: overallStats.avg !== null
        ? formatMetric(overallStats.avg, METRIC_SOURCES.CALCULATED, { calculation: "mean across all requests", unit: "ms" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "No request samples recorded" }),
      overallP50: overallStats.p50 !== null
        ? formatMetric(overallStats.p50, METRIC_SOURCES.CALCULATED, { calculation: "50th percentile across all requests", unit: "ms" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "No request samples recorded" }),
      overallP95: overallStats.p95 !== null
        ? formatMetric(overallStats.p95, METRIC_SOURCES.CALCULATED, { calculation: "95th percentile across all requests (min 5 samples)", unit: "ms" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Insufficient request samples (< 5) for P95" }),
      overallP99: overallStats.p99 !== null
        ? formatMetric(overallStats.p99, METRIC_SOURCES.CALCULATED, { calculation: "99th percentile across all requests (min 10 samples)", unit: "ms" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Insufficient request samples (< 10) for P99" }),
      overallErrorRate: formatMetric(overallErrorRate, METRIC_SOURCES.CALCULATED, { calculation: "(totalErrors / totalRequests) * 100", unit: "%" })
    },
    endpoints: endpointRows,
    recentRequestsCount: totalRequests
  };
}

/**
 * Retrieve raw requests for detailed drill-down
 */
export function getRecentRequests(limit = 50) {
  return requestBuffer.slice(0, limit);
}

/**
 * Retrieve recent business events
 */
export function getRecentBusinessEvents(limit = 20) {
  return businessEventsBuffer.slice(0, limit);
}
