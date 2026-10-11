// CloudCart Observability — Structured Log Manager (Pillar 1)
// Dual-write: console.* (native Cloudflare Tail Workers / Logpush) + in-memory ring buffer (Admin UI).
// Every log carries traceId + spanId for cross-pillar correlation.

const MAX_LOGS = 600;
const logsBuffer = [];

const SENSITIVE_PATTERNS = [
  /bearer\s+[a-zA-Z0-9_\-.]+/gi,
  /"password"\s*:\s*"[^"]*"/gi,
  /"token"\s*:\s*"[^"]*"/gi,
  /"secret"\s*:\s*"[^"]*"/gi,
  /"cardNumber"\s*:\s*"[^"]*"/gi,
  /"cvv"\s*:\s*"[^"]*"/gi,
  /"cookie"\s*:\s*"[^"]*"/gi
];

function sanitize(str) {
  if (typeof str !== "string") return str;
  let s = str;
  for (const p of SENSITIVE_PATTERNS) s = s.replace(p, "[REDACTED]");
  return s;
}

function sanitizeContext(ctx) {
  if (!ctx || typeof ctx !== "object") return ctx;
  const clean = {};
  for (const [k, v] of Object.entries(ctx)) {
    clean[k] = typeof v === "string" ? sanitize(v) : v;
  }
  return clean;
}

/**
 * Record a structured log entry.
 * Dual-writes to console.* (Cloudflare Tail Workers) + in-memory buffer (Admin UI).
 *
 * @param {object} entry
 * @param {"INFO"|"WARN"|"ERROR"|"DEBUG"} entry.level
 * @param {"worker"|"d1"|"kv"|"inventory_do"} entry.service
 * @param {string} entry.message
 * @param {string}  [entry.traceId]    - links to Traces pillar
 * @param {string}  [entry.spanId]     - links to specific span
 * @param {string}  [entry.requestId]
 * @param {object}  [entry.context]    - endpoint, method, httpStatus, durationMs, businessEvent, ...
 * @param {object}  [entry.error]      - { message, stack }
 */
export function recordLog(entry) {
  const now = Date.now();
  const randId = Math.random().toString(36).slice(2, 8);

  const log = {
    id: `log_${now}_${randId}`,
    timestamp: new Date(now).toISOString(),
    epochMs: now,
    level: entry.level || "INFO",
    service: entry.service || "worker",
    traceId: entry.traceId || null,
    spanId: entry.spanId || null,
    requestId: entry.requestId || null,
    message: sanitize(String(entry.message || "").substring(0, 400)),
    context: entry.context ? sanitizeContext(entry.context) : null,
    error: entry.error ? {
      message: sanitize(String(entry.error.message || "").substring(0, 300)),
      stack: entry.error.stack ? sanitize(String(entry.error.stack).substring(0, 800)) : null
    } : null
  };

  // 1. Native Cloudflare channel — visible in `wrangler tail` and Logpush pipelines
  //    Emit as JSON so log aggregators (Datadog, Grafana, etc.) can parse structured fields
  const consoleFn = log.level === "ERROR" ? console.error
                  : log.level === "WARN"  ? console.warn
                  : log.level === "DEBUG" ? console.debug
                  : console.log;
  consoleFn(JSON.stringify(log));

  // 2. In-memory ring buffer — powers Admin UI /api/observability/logs
  logsBuffer.unshift(log);
  if (logsBuffer.length > MAX_LOGS) logsBuffer.pop();

  return log;
}

/**
 * Convenience log helpers
 */
export function logInfo(message, context = {}, traceCtx = {}) {
  return recordLog({ level: "INFO", service: context.service || "worker", message, context, ...traceCtx });
}

export function logWarn(message, context = {}, traceCtx = {}) {
  return recordLog({ level: "WARN", service: context.service || "worker", message, context, ...traceCtx });
}

export function logError(message, error = null, context = {}, traceCtx = {}) {
  return recordLog({ level: "ERROR", service: context.service || "worker", message, context, error, ...traceCtx });
}

export function logDebug(message, context = {}, traceCtx = {}) {
  return recordLog({ level: "DEBUG", service: context.service || "worker", message, context, ...traceCtx });
}

/**
 * Query and filter the log buffer.
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

  const cutoff = Date.now() - parseRange(range);
  let filtered = logsBuffer.filter(l => l.epochMs >= cutoff);

  if (level && level !== "all") {
    filtered = filtered.filter(l => l.level === level.toUpperCase());
  }
  if (service && service !== "all") {
    filtered = filtered.filter(l => l.service === service);
  }
  if (endpoint && endpoint !== "all") {
    filtered = filtered.filter(l => l.context?.endpoint === endpoint);
  }
  if (search && search.trim()) {
    const q = search.toLowerCase().trim();
    filtered = filtered.filter(l =>
      l.message.toLowerCase().includes(q) ||
      l.traceId?.toLowerCase().includes(q) ||
      l.requestId?.toLowerCase().includes(q) ||
      l.context?.endpoint?.toLowerCase().includes(q)
    );
  }

  const levelCounts = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
  for (const l of filtered) {
    if (levelCounts[l.level] !== undefined) levelCounts[l.level]++;
  }

  const total = filtered.length;
  return {
    total,
    levelCounts,
    timeRange: range,
    logs: filtered.slice(offset, offset + limit),
    pagination: { total, limit, offset, hasMore: offset + limit < total }
  };
}

/**
 * Get a single log entry by ID.
 */
export function getLogById(logId) {
  return logsBuffer.find(l => l.id === logId) || null;
}

// ─── Helpers ──────────────────────────────────────────────────────

function parseRange(range) {
  const map = { "15m": 900000, "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000 };
  return map[range] || map["1h"];
}
