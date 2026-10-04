// CloudCart Monitoring - Centralized Log Manager & Error Center Service
import { METRIC_SOURCES, isDemoMode, formatMetric } from "./sources.js";

const MAX_LOGS = 600;
const logsBuffer = [];

// Sensitive field patterns to sanitize before logs reach the Admin UI
const SENSITIVE_PATTERNS = [
  /bearer\s+[a-zA-Z0-9_\-\.]+/gi,
  /cf_[a-zA-Z0-9_\-]{20,}/gi,
  /"password"\s*:\s*"[^"]*"/gi,
  /"token"\s*:\s*"[^"]*"/gi,
  /"secret"\s*:\s*"[^"]*"/gi,
  /"cardNumber"\s*:\s*"[^"]*"/gi,
  /"cvv"\s*:\s*"[^"]*"/gi,
  /"cookie"\s*:\s*"[^"]*"/gi
];

/**
 * Sanitize strings and objects to prevent credential or PII leaks
 */
function sanitizeLogData(data) {
  if (!data) return data;
  if (typeof data === "string") {
    let sanitized = data;
    for (const pattern of SENSITIVE_PATTERNS) {
      sanitized = sanitized.replace(pattern, "[REDACTED]");
    }
    return sanitized;
  }
  if (typeof data === "object") {
    try {
      const str = JSON.stringify(data);
      let sanitizedStr = str;
      for (const pattern of SENSITIVE_PATTERNS) {
        sanitizedStr = sanitizedStr.replace(pattern, '"[REDACTED]"');
      }
      return JSON.parse(sanitizedStr);
    } catch (_) {
      return "[UNSERIALIZABLE_LOG_DATA]";
    }
  }
  return data;
}

/**
 * Generate demo operational logs strictly when MONITORING_DEMO_MODE=true is enabled
 */
function generateDemoLogs() {
  const seeds = [];
  const now = Date.now();
  const sampleEvents = [
    { level: "INFO", service: "CloudCart Worker / D1", endpoint: "/api/products", method: "GET", status: 200, durationMs: 14, message: "Catalog products queried successfully (category: 'all')", details: { category: "all", returnedItems: 6 } },
    { level: "INFO", service: "CloudCart Worker / D1", endpoint: "/api/metrics", method: "GET", status: 200, durationMs: 22, message: "Admin business metrics computed from D1 SQLite", details: { totalProducts: 6, totalOrders: 4 } },
    { level: "INFO", service: "CloudCart Worker / KV", endpoint: "/api/session/cart", method: "GET", status: 200, durationMs: 16, message: "Cart retrieved from Cloudflare KV session storage", details: { sessionId: "sess-849204" } },
    { level: "INFO", service: "InventoryDO / D1", endpoint: "/api/checkout", method: "POST", status: 200, durationMs: 58, message: "Atomic stock deduction and order creation succeeded", details: { orderId: "ord-1790513348527-365", itemsCount: 1, totalAmount: 32999 }, businessEvent: "CHECKOUT_SUCCEEDED" },
    { level: "WARN", service: "CloudCart Worker / D1", endpoint: "/api/products", method: "POST", status: 400, durationMs: 12, message: "Product creation rejected: missing required fields", details: { validationError: "Missing required product fields: name or price" } },
    { level: "WARN", service: "InventoryDO / D1", endpoint: "/api/checkout", method: "POST", status: 400, durationMs: 45, message: "Checkout failed: Insufficient stock for requested item", details: { product: "CloudCart Watch Horizon 2", requested: 10, available: 4 }, businessEvent: "CHECKOUT_FAILED" }
  ];

  for (let i = 0; i < 20; i++) {
    const template = sampleEvents[i % sampleEvents.length];
    const offsetMs = i * 90000;
    const logTime = new Date(now - offsetMs);
    const randId = Math.random().toString(36).substring(2, 8);

    seeds.push({
      id: `demo_log_${logTime.getTime()}_${randId}`,
      timestamp: logTime.toISOString(),
      epochMs: logTime.getTime(),
      level: template.level,
      service: template.service,
      requestId: `demo_req_${Math.random().toString(36).substring(2, 10)}`,
      endpoint: template.endpoint,
      method: template.method,
      status: template.status,
      statusClass: template.status >= 500 ? "5xx" : template.status >= 400 ? "4xx" : "2xx",
      durationMs: template.durationMs,
      message: `[DEMO] ${template.message}`,
      details: template.details,
      businessEvent: template.businessEvent || null,
      source: METRIC_SOURCES.DEMO
    });
  }

  return seeds;
}

/**
 * Record a structured log entry into the centralized buffer
 * Enforces sanitization of tokens, credentials, and sensitive headers.
 */
export function recordLog(entry) {
  const timestamp = new Date();
  const randId = Math.random().toString(36).substring(2, 8);

  const rawMessage = String(entry.message || "").substring(0, 300);
  const sanitizedMessage = sanitizeLogData(rawMessage);
  const sanitizedDetails = entry.details ? sanitizeLogData(entry.details) : null;

  const sanitized = {
    id: entry.id || `log_${timestamp.getTime()}_${randId}`,
    timestamp: timestamp.toISOString(),
    epochMs: timestamp.getTime(),
    level: entry.level || (entry.status >= 500 ? "ERROR" : entry.status >= 400 ? "WARN" : "INFO"),
    service: entry.service || "CloudCart Worker",
    requestId: entry.requestId || `req_${randId}`,
    endpoint: entry.endpoint || "/",
    method: entry.method || "GET",
    status: entry.status || 200,
    statusClass: entry.status >= 500 ? "5xx" : entry.status >= 400 ? "4xx" : "2xx",
    durationMs: Math.round(entry.durationMs ?? 1),
    message: sanitizedMessage,
    details: sanitizedDetails,
    businessEvent: entry.businessEvent || null,
    stack: entry.stack ? sanitizeLogData(String(entry.stack).substring(0, 500)) : null,
    source: METRIC_SOURCES.APPLICATION_INSTRUMENTED
  };

  logsBuffer.unshift(sanitized);
  if (logsBuffer.length > MAX_LOGS) {
    logsBuffer.pop();
  }

  return sanitized;
}

/**
 * Query and filter logs with search, level, service, endpoint, and time range
 */
export function getLogs(filters = {}, env = null) {
  const {
    range = "1h",
    level = "all",
    service = "all",
    endpoint = "all",
    search = "",
    limit = 50,
    offset = 0
  } = filters;

  const demoActive = isDemoMode(env);
  let sourceBuffer = logsBuffer;
  let dataSource = METRIC_SOURCES.APPLICATION_INSTRUMENTED;

  if (demoActive && logsBuffer.length === 0) {
    sourceBuffer = generateDemoLogs();
    dataSource = METRIC_SOURCES.DEMO;
  }

  // 1. Time range filter
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

  let filtered = sourceBuffer.filter(l => l.epochMs >= cutoff);

  // 2. Level filter
  if (level && level !== "all") {
    filtered = filtered.filter(l => l.level === level.toUpperCase());
  }

  // 3. Service filter
  if (service && service !== "all") {
    filtered = filtered.filter(l => l.service.toLowerCase().includes(service.toLowerCase()));
  }

  // 4. Endpoint filter
  if (endpoint && endpoint !== "all") {
    filtered = filtered.filter(l => l.endpoint === endpoint);
  }

  // 5. Search query
  if (search && search.trim() !== "") {
    const q = search.toLowerCase().trim();
    filtered = filtered.filter(l =>
      l.message.toLowerCase().includes(q) ||
      l.requestId.toLowerCase().includes(q) ||
      l.endpoint.toLowerCase().includes(q)
    );
  }

  // Counts by level
  const levelCounts = {
    INFO: filtered.filter(l => l.level === "INFO").length,
    WARN: filtered.filter(l => l.level === "WARN").length,
    ERROR: filtered.filter(l => l.level === "ERROR").length
  };

  const totalMatching = filtered.length;
  const paginated = filtered.slice(offset, offset + limit);

  return {
    source: dataSource,
    isDemoData: demoActive && logsBuffer.length === 0,
    logProvider: "CloudCart Application Logs (In-Memory Buffer)",
    note: "Cloudflare Native Workers Logs require Cloudflare Tail Workers or Logpush; current logs are captured by CloudCart runtime.",
    totalMatching,
    timeRange: range,
    totalLogs: totalMatching,
    levelCounts: {
      total: totalMatching,
      INFO: levelCounts.INFO,
      WARN: levelCounts.WARN,
      ERROR: levelCounts.ERROR
    },
    logs: paginated,
    pagination: {
      total: totalMatching,
      limit,
      offset,
      hasMore: offset + limit < totalMatching
    }
  };
}

/**
 * Retrieve a single log by ID
 */
export function getLogById(logId, env = null) {
  let log = logsBuffer.find(l => l.id === logId);
  if (!log && isDemoMode(env)) {
    const demo = generateDemoLogs();
    log = demo.find(l => l.id === logId) || demo[0];
  }
  return log || null;
}
