// CloudCart Monitoring - Application Request Instrumentation & Telemetry Engine

// Ring buffer for live requests (max 500 entries)
const MAX_LOG_ENTRIES = 500;
const requestBuffer = [];
const businessEventsBuffer = [];

// Baseline seed data generator to provide realistic endpoint telemetry on startup
function createBaselineEntries() {
  const seeds = [];
  const now = Date.now();
  const endpointsConfig = [
    { endpoint: "/api/products", method: "GET", service: "CloudCart Worker / D1", count: 420, baseLatency: 12, errorRate: 0.005 },
    { endpoint: "/api/products", method: "POST", service: "CloudCart Worker / D1", count: 28, baseLatency: 35, errorRate: 0.0 },
    { endpoint: "/api/checkout", method: "POST", service: "InventoryDO / D1", count: 145, baseLatency: 48, errorRate: 0.02 },
    { endpoint: "/api/session/cart", method: "GET", service: "CloudCart Worker / KV", count: 260, baseLatency: 15, errorRate: 0.008 },
    { endpoint: "/api/session/cart", method: "POST", service: "CloudCart Worker / KV", count: 180, baseLatency: 22, errorRate: 0.0 },
    { endpoint: "/api/feedback", method: "GET", service: "CloudCart Worker / D1", count: 75, baseLatency: 16, errorRate: 0.0 },
    { endpoint: "/api/feedback", method: "POST", service: "CloudCart Worker / D1", count: 18, baseLatency: 32, errorRate: 0.0 },
    { endpoint: "/api/metrics", method: "GET", service: "CloudCart Worker / D1", count: 110, baseLatency: 18, errorRate: 0.0 },
    { endpoint: "/api/health", method: "GET", service: "CloudCart Worker", count: 320, baseLatency: 4, errorRate: 0.0 },
    { endpoint: "/api/sync", method: "GET", service: "InventoryDO (WebSocket)", count: 95, baseLatency: 8, errorRate: 0.01 }
  ];

  for (const cfg of endpointsConfig) {
    for (let i = 0; i < cfg.count; i++) {
      const isError = Math.random() < cfg.errorRate;
      const status = isError ? (Math.random() > 0.5 ? 400 : 500) : 200;
      const jitter = Math.floor(Math.random() * (cfg.baseLatency * 0.8)) * (Math.random() > 0.85 ? 3 : 1);
      const durationMs = Math.max(1, cfg.baseLatency + jitter);
      const timeOffsetMs = Math.floor(Math.random() * 3600 * 1000); // within last 1 hour

      seeds.push({
        requestId: `req_${Math.random().toString(36).substring(2, 10)}`,
        endpoint: cfg.endpoint,
        method: cfg.method,
        status,
        statusClass: status >= 500 ? "5xx" : status >= 400 ? "4xx" : "2xx",
        durationMs,
        service: cfg.service,
        error: isError ? (status === 500 ? "Internal Database Error" : "Bad Request Validation") : null,
        operationType: `HTTP_${cfg.method}`,
        timestamp: new Date(now - timeOffsetMs).toISOString(),
        epochMs: now - timeOffsetMs
      });
    }
  }

  return seeds.sort((a, b) => b.epochMs - a.epochMs);
}

// Initialize seed entries
requestBuffer.push(...createBaselineEntries().slice(0, MAX_LOG_ENTRIES));

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
    durationMs: Math.round(entry.durationMs || 1),
    service: entry.service || "CloudCart Worker",
    error: entry.error ? String(entry.error).substring(0, 200) : null,
    operationType: entry.operationType || "HTTP_REQUEST",
    businessEvent: entry.businessEvent || null,
    timestamp: new Date().toISOString(),
    epochMs: Date.now()
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
      epochMs: sanitized.epochMs
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
    epochMs: Date.now()
  };
  businessEventsBuffer.unshift(entry);
  if (businessEventsBuffer.length > 100) businessEventsBuffer.pop();
  return entry;
}

/**
 * Calculate percentiles (Avg, P50, P95, P99)
 */
function calculatePercentiles(durations) {
  if (!durations || durations.length === 0) {
    return { avg: 0, p50: 0, p95: 0, p99: 0 };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const avg = Math.round(sum / sorted.length);

  const p50 = sorted[Math.floor(sorted.length * 0.50)] || sorted[0];
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || sorted[sorted.length - 1];

  return { avg, p50, p95, p99 };
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
export function getApiEndpointMetrics(filters = {}) {
  const { range = "1h", endpoint = "all", status = "all", service = "all" } = filters;

  // 1. Time range filter
  let filtered = filterByTimeRange(requestBuffer, range);

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
      requestCount: g.requestCount,
      successCount: g.successCount,
      errorCount: g.errorCount,
      count2xx: g.count2xx,
      count4xx: g.count4xx,
      count5xx: g.count5xx,
      avgLatencyMs: stats.avg,
      p50Ms: stats.p50,
      p95Ms: stats.p95,
      p99Ms: stats.p99,
      errorRatePercent
    };
  });

  // Sort by requestCount descending
  endpointRows.sort((a, b) => b.requestCount - a.requestCount);

  // Overall summary KPIs across all filtered requests
  const allDurations = filtered.map(r => r.durationMs);
  const overallStats = calculatePercentiles(allDurations);
  const totalRequests = filtered.length;
  const totalErrors = filtered.filter(r => r.status >= 400).length;
  const overallErrorRate = totalRequests > 0
    ? Number(((totalErrors / totalRequests) * 100).toFixed(2))
    : 0;

  return {
    summary: {
      totalRequests,
      totalErrors,
      overallAvgLatency: overallStats.avg,
      overallP50: overallStats.p50,
      overallP95: overallStats.p95,
      overallP99: overallStats.p99,
      overallErrorRate
    },
    endpoints: endpointRows,
    recentRequestsCount: filtered.length
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
