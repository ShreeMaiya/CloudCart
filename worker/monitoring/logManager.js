// CloudCart Monitoring - Centralized Log Manager & Error Center Service

const MAX_LOGS = 600;
const logsBuffer = [];

// Seed realistic operational logs across INFO, WARN, and ERROR
function generateSeedLogs() {
  const seeds = [];
  const now = Date.now();

  const sampleEvents = [
    { level: "INFO", service: "CloudCart Worker / D1", endpoint: "/api/products", method: "GET", status: 200, durationMs: 14, message: "Catalog products queried successfully (category: 'all')", details: { category: "all", returnedItems: 6 } },
    { level: "INFO", service: "CloudCart Worker / D1", endpoint: "/api/metrics", method: "GET", status: 200, durationMs: 22, message: "Admin business metrics computed from D1 SQLite", details: { totalProducts: 6, totalOrders: 4 } },
    { level: "INFO", service: "CloudCart Worker / KV", endpoint: "/api/session/cart", method: "GET", status: 200, durationMs: 16, message: "Cart retrieved from Cloudflare KV session storage", details: { sessionId: "sess-849204" } },
    { level: "INFO", service: "CloudCart Worker / KV", endpoint: "/api/session/cart", method: "POST", status: 200, durationMs: 24, message: "Cart saved to Cloudflare KV with 7-day TTL", details: { sessionId: "sess-849204", itemCount: 2 } },
    { level: "INFO", service: "InventoryDO / D1", endpoint: "/api/checkout", method: "POST", status: 200, durationMs: 58, message: "Atomic stock deduction and order creation succeeded", details: { orderId: "ord-1790513348527-365", itemsCount: 1, totalAmount: 32999 }, businessEvent: "CHECKOUT_SUCCEEDED" },
    { level: "INFO", service: "InventoryDO (WebSocket)", endpoint: "/api/sync", method: "GET", status: 101, durationMs: 4, message: "WebSocket client connected to InventoryDO live broadcast engine", details: { protocol: "RFC 6455" } },
    { level: "WARN", service: "CloudCart Worker / D1", endpoint: "/api/products", method: "POST", status: 400, durationMs: 12, message: "Product creation rejected: missing required fields", details: { validationError: "Missing required product fields: name or price" } },
    { level: "WARN", service: "CloudCart Worker / KV", endpoint: "/api/session/cart", method: "GET", status: 400, durationMs: 6, message: "Cart lookup failed: missing sessionId query parameter", details: { queryParam: "sessionId" } },
    { level: "WARN", service: "InventoryDO / D1", endpoint: "/api/checkout", method: "POST", status: 400, durationMs: 45, message: "Checkout failed: Insufficient stock for requested item", details: { product: "CloudCart Watch Horizon 2", requested: 10, available: 4 }, businessEvent: "CHECKOUT_FAILED" },
    { level: "ERROR", service: "CloudCart Worker / D1", endpoint: "/api/products/prod-999", method: "PUT", status: 404, durationMs: 18, message: "Product update failed: item ID 'prod-999' not found in D1", details: { prodId: "prod-999" } },
    { level: "ERROR", service: "InventoryDO", endpoint: "/api/sync", method: "GET", status: 500, durationMs: 82, message: "Transient WebSocket handshake error during high concurrency burst", details: { socketState: "CLOSING", cause: "Client disconnected prematurely" } },
    { level: "ERROR", service: "CloudCart Worker / D1", endpoint: "/api/checkout", method: "POST", status: 500, durationMs: 110, message: "D1 database transaction retry exhausted during concurrent checkout", details: { sqliteError: "SQLITE_BUSY: database is locked", retryAttempts: 3 } }
  ];

  for (let i = 0; i < 40; i++) {
    const template = sampleEvents[i % sampleEvents.length];
    const offsetMs = (i * 90000) + Math.floor(Math.random() * 30000);
    const logTime = new Date(now - offsetMs);
    const randId = Math.random().toString(36).substring(2, 8);

    seeds.push({
      id: `log_${logTime.getTime()}_${randId}`,
      timestamp: logTime.toISOString(),
      epochMs: logTime.getTime(),
      level: template.level,
      service: template.service,
      requestId: `req_${Math.random().toString(36).substring(2, 10)}`,
      endpoint: template.endpoint,
      method: template.method,
      status: template.status,
      statusClass: template.status >= 500 ? "5xx" : template.status >= 400 ? "4xx" : "2xx",
      durationMs: template.durationMs + Math.floor(Math.random() * 8),
      message: template.message,
      details: template.details,
      businessEvent: template.businessEvent || null
    });
  }

  return seeds.sort((a, b) => b.epochMs - a.epochMs);
}

// Initialize seed logs
logsBuffer.push(...generateSeedLogs());

/**
 * Record a structured log entry into the centralized buffer
 */
export function recordLog(entry) {
  const timestamp = new Date();
  const randId = Math.random().toString(36).substring(2, 8);

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
    durationMs: Math.round(entry.durationMs || 1),
    message: String(entry.message || "").substring(0, 300),
    details: entry.details ? JSON.parse(JSON.stringify(entry.details)) : null,
    businessEvent: entry.businessEvent || null,
    stack: entry.stack ? String(entry.stack).substring(0, 500) : null
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
export function getLogs(filters = {}) {
  const {
    range = "1h",
    level = "all",
    service = "all",
    endpoint = "all",
    search = "",
    limit = 50,
    offset = 0
  } = filters;

  const now = Date.now();
  const rangesMs = {
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000
  };

  const windowMs = rangesMs[range] || rangesMs["1h"];
  const cutoff = now - windowMs;

  // 1. Time range filter
  let result = logsBuffer.filter(l => l.epochMs >= cutoff);

  // Compute counts for the active window before severity filtering
  const levelCounts = {
    total: result.length,
    INFO: result.filter(l => l.level === "INFO").length,
    WARN: result.filter(l => l.level === "WARN").length,
    ERROR: result.filter(l => l.level === "ERROR").length
  };

  // 2. Level filter
  if (level && level !== "all") {
    if (level === "errors_only") {
      result = result.filter(l => l.level === "ERROR" || l.level === "WARN");
    } else {
      result = result.filter(l => l.level === level.toUpperCase());
    }
  }

  // 3. Service filter
  if (service && service !== "all") {
    result = result.filter(l => l.service.toLowerCase().includes(service.toLowerCase()));
  }

  // 4. Endpoint filter
  if (endpoint && endpoint !== "all") {
    result = result.filter(l => l.endpoint === endpoint);
  }

  // 5. Search query filter (matches message, requestId, endpoint, or details string)
  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    result = result.filter(l => {
      const msgMatch = l.message && l.message.toLowerCase().includes(q);
      const reqMatch = l.requestId && l.requestId.toLowerCase().includes(q);
      const epMatch = l.endpoint && l.endpoint.toLowerCase().includes(q);
      const detailsMatch = l.details && JSON.stringify(l.details).toLowerCase().includes(q);
      return msgMatch || reqMatch || epMatch || detailsMatch;
    });
  }

  const filteredCount = result.length;
  const pagedLogs = result.slice(offset, offset + limit);

  return {
    timeRange: range,
    levelCounts,
    totalLogs: filteredCount,
    limit,
    offset,
    logs: pagedLogs
  };
}

/**
 * Retrieve a specific log by ID for the detailed inspector
 */
export function getLogById(logId) {
  return logsBuffer.find(l => l.id === logId) || null;
}
