// CloudCart Monitoring - Distributed Tracing & Request Correlation Service
// Accurately tracks measured request spans without synthetic math or fabricated waterfalls
import { METRIC_SOURCES, isDemoMode, formatMetric } from "./sources.js";

const MAX_TRACES = 250;
const tracesBuffer = [];

/**
 * Generate demo traces strictly when MONITORING_DEMO_MODE=true is enabled
 */
function generateDemoTraces() {
  const seeds = [];
  const now = Date.now();
  const endpoints = [
    { endpoint: "/api/products", method: "GET", status: 200, service: "CloudCart Worker / D1", durationMs: 14.2 },
    { endpoint: "/api/checkout", method: "POST", status: 200, service: "InventoryDO / D1", durationMs: 52.8 },
    { endpoint: "/api/session/cart", method: "GET", status: 200, service: "CloudCart Worker / KV", durationMs: 16.5 },
    { endpoint: "/api/metrics", method: "GET", status: 200, service: "CloudCart Worker / D1", durationMs: 21.0 }
  ];

  for (let i = 0; i < 15; i++) {
    const tpl = endpoints[i % endpoints.length];
    const offsetMs = i * 180000;
    const time = new Date(now - offsetMs);
    const traceId = `demo_trace_${Math.random().toString(36).substring(2, 10)}`;

    seeds.push({
      traceId,
      timestamp: time.toISOString(),
      epochMs: time.getTime(),
      method: tpl.method,
      endpoint: tpl.endpoint,
      status: tpl.status,
      statusClass: "2xx",
      service: tpl.service,
      totalDurationMs: tpl.durationMs,
      colo: "DEMO_COLO",
      hopCount: 2,
      source: METRIC_SOURCES.DEMO,
      spans: [
        {
          id: `span_demo_${i}_1`,
          name: "Worker Request Router & Handler Execution",
          service: "CloudCart Worker",
          startOffsetMs: 0,
          durationMs: tpl.durationMs,
          status: "OK",
          source: METRIC_SOURCES.DEMO,
          details: { endpoint: tpl.endpoint, note: "Demo simulated span" }
        },
        {
          id: `span_demo_${i}_2`,
          name: "Pages Edge Ingress",
          service: "Cloudflare Pages",
          startOffsetMs: null,
          durationMs: null,
          status: "UNAVAILABLE",
          source: METRIC_SOURCES.UNAVAILABLE,
          details: { reason: "Edge ingress timing unavailable from Worker isolate" }
        }
      ]
    });
  }

  return seeds;
}

/**
 * Record a distributed trace into the trace buffer
 * Stores only real, measured execution spans
 */
export function recordTrace(traceData) {
  const timestamp = new Date();
  const traceId = traceData.traceId || traceData.requestId || `req_${crypto.randomUUID().slice(0, 8)}`;
  const totalDurationMs = Number((traceData.totalDurationMs ?? traceData.durationMs ?? 0).toFixed(1));

  let spans = traceData.spans;

  // If no granular sub-spans were provided, construct honest measured breakdown:
  // Show Worker execution span (measured), and explicitly list unmeasured layers as UNAVAILABLE.
  if (!spans || !Array.isArray(spans) || spans.length === 0) {
    spans = [
      {
        id: `span_${traceId}_worker`,
        name: `Worker Execution: ${traceData.method || "GET"} ${traceData.endpoint || "/"}`,
        service: traceData.service || "CloudCart Worker",
        startOffsetMs: 0,
        durationMs: totalDurationMs,
        status: (traceData.status >= 400) ? "ERROR" : "OK",
        source: METRIC_SOURCES.APPLICATION_INSTRUMENTED,
        details: {
          measuredDurationMs: totalDurationMs,
          endpoint: traceData.endpoint,
          method: traceData.method,
          status: traceData.status
        }
      },
      {
        id: `span_${traceId}_pages`,
        name: "Cloudflare Pages Edge Ingress & Routing",
        service: "Cloudflare Pages",
        startOffsetMs: null,
        durationMs: null,
        status: "UNAVAILABLE",
        source: METRIC_SOURCES.UNAVAILABLE,
        details: {
          reason: "Pages hop latency is not accessible from downstream Worker isolate."
        }
      }
    ];

    // If D1 was involved and query latency was measured, record it if present
    if (traceData.d1DurationMs !== undefined && traceData.d1DurationMs !== null) {
      spans.push({
        id: `span_${traceId}_d1`,
        name: "D1 Database Query Execution",
        service: "D1 Database",
        startOffsetMs: 0,
        durationMs: Number(traceData.d1DurationMs.toFixed(1)),
        status: "OK",
        source: METRIC_SOURCES.APPLICATION_INSTRUMENTED,
        details: {
          measuredDurationMs: traceData.d1DurationMs
        }
      });
    }
  }

  const sanitized = {
    traceId,
    timestamp: traceData.timestamp || timestamp.toISOString(),
    epochMs: timestamp.getTime(),
    method: traceData.method || "GET",
    endpoint: traceData.endpoint || "/",
    status: traceData.status || 200,
    statusClass: traceData.status >= 500 ? "5xx" : traceData.status >= 400 ? "4xx" : "2xx",
    service: traceData.service || "CloudCart Worker",
    totalDurationMs,
    colo: traceData.colo || "Edge Auto",
    hopCount: spans.filter(s => s.durationMs !== null).length,
    source: METRIC_SOURCES.APPLICATION_INSTRUMENTED,
    spans
  };

  tracesBuffer.unshift(sanitized);
  if (tracesBuffer.length > MAX_TRACES) {
    tracesBuffer.pop();
  }

  return sanitized;
}

/**
 * Filter traces by time window
 */
function filterTracesByTimeRange(items, range = "1h") {
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
  return items.filter(t => t.epochMs >= cutoff);
}

/**
 * Query and filter traces
 */
export function getTraces(filters = {}, env = null) {
  const {
    range = "1h",
    endpoint = "all",
    status = "all",
    service = "all",
    minDuration = 0,
    search = "",
    limit = 50,
    offset = 0
  } = filters;

  const demoActive = isDemoMode(env);
  let sourceBuffer = tracesBuffer;
  let dataSource = METRIC_SOURCES.APPLICATION_INSTRUMENTED;

  if (demoActive && tracesBuffer.length === 0) {
    sourceBuffer = generateDemoTraces();
    dataSource = METRIC_SOURCES.DEMO;
  } else if (tracesBuffer.length === 0) {
    dataSource = METRIC_SOURCES.UNAVAILABLE;
  }

  // 1. Time range filter
  let filtered = filterTracesByTimeRange(sourceBuffer, range);

  // 2. Endpoint filter
  if (endpoint && endpoint !== "all") {
    filtered = filtered.filter(t => t.endpoint === endpoint);
  }

  // 3. Status filter
  if (status && status !== "all") {
    if (status === "errors") {
      filtered = filtered.filter(t => t.status >= 400);
    } else {
      filtered = filtered.filter(t => t.statusClass === status);
    }
  }

  // 4. Service filter
  if (service && service !== "all") {
    filtered = filtered.filter(t => t.service.toLowerCase().includes(service.toLowerCase()));
  }

  // 5. Min Duration filter
  if (minDuration > 0) {
    filtered = filtered.filter(t => t.totalDurationMs >= minDuration);
  }

  // 6. Search query
  if (search && search.trim() !== "") {
    const q = search.toLowerCase().trim();
    filtered = filtered.filter(t =>
      t.traceId.toLowerCase().includes(q) ||
      t.endpoint.toLowerCase().includes(q) ||
      (t.colo && t.colo.toLowerCase().includes(q))
    );
  }

  const totalMatching = filtered.length;
  const paginated = filtered.slice(offset, offset + limit);

  // Compute summary metrics across matching traces
  const durations = filtered.map(t => t.totalDurationMs);
  const avgDuration = durations.length > 0
    ? Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1))
    : null;
  const maxDuration = durations.length > 0 ? Math.max(...durations) : null;
  const errorTracesCount = filtered.filter(t => t.status >= 400).length;

  return {
    source: dataSource,
    isDemoData: demoActive && tracesBuffer.length === 0,
    traceDataSourceNote: tracesBuffer.length > 0
      ? "Trace data source: CloudCart Application Instrumentation. Spans reflect verified in-isolate measurements."
      : "Trace data unavailable from configured Cloudflare native observability source. External distributed trace headers not present.",
    summary: {
      totalTraces: formatMetric(totalMatching, dataSource),
      avgDurationMs: avgDuration !== null
        ? formatMetric(avgDuration, METRIC_SOURCES.CALCULATED, { calculation: "mean of measured trace durations", unit: "ms" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "No traces recorded in time window" }),
      maxDurationMs: maxDuration !== null
        ? formatMetric(maxDuration, METRIC_SOURCES.CALCULATED, { unit: "ms" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "No traces recorded in time window" }),
      errorTracesCount: formatMetric(errorTracesCount, dataSource)
    },
    traces: paginated,
    pagination: {
      total: totalMatching,
      limit,
      offset,
      hasMore: offset + limit < totalMatching
    }
  };
}

/**
 * Retrieve a single trace by ID
 */
export function getTraceById(traceId, env = null) {
  let trace = tracesBuffer.find(t => t.traceId === traceId);
  if (!trace && isDemoMode(env)) {
    const demo = generateDemoTraces();
    trace = demo.find(t => t.traceId === traceId) || demo[0];
  }
  return trace || null;
}
