// CloudCart Observability — Infrastructure Telemetry (D1, KV, InventoryDO)
// Simple counters + query log. No demo data. No formatMetric wrappers.

// ─── D1 Counters ──────────────────────────────────────────────────
let d1Reads = 0;
let d1Writes = 0;
let d1Errors = 0;
const d1QueryLog = [];
const MAX_QUERY_LOG = 50;

// ─── KV Counters ──────────────────────────────────────────────────
let kvGets = 0;
let kvPuts = 0;
let kvDeletes = 0;
let kvErrors = 0;

/**
 * Record a D1 query execution. Called by the DB wrapper in index.js.
 *
 * @param {string} query      - SQL query string
 * @param {number} durationMs - measured execution time
 * @param {boolean} isWrite   - INSERT/UPDATE/DELETE/CREATE etc.
 * @param {string|null} error - error message if query failed
 */
export function recordD1Query(query, durationMs, isWrite = false, error = null) {
  if (isWrite) d1Writes++; else d1Reads++;
  if (error) d1Errors++;

  const entry = {
    query: String(query).substring(0, 200),
    durationMs: Math.round(durationMs),
    type: isWrite ? "WRITE" : "READ",
    isSlow: durationMs > 500, // Edge-to-D1 cross-region latency baseline is ~150-350ms; >500ms indicates heavy scan/lock
    error: error ? String(error).substring(0, 200) : null,
    timestamp: new Date().toISOString()
  };

  d1QueryLog.unshift(entry);
  if (d1QueryLog.length > MAX_QUERY_LOG) d1QueryLog.pop();

  return entry;
}

/**
 * Record a KV operation. Called by the KV wrapper in index.js.
 *
 * @param {"get"|"put"|"delete"} operation
 * @param {number} durationMs
 * @param {string|null} error
 */
export function recordKVOperation(operation, durationMs, error = null) {
  if (operation === "get") kvGets++;
  else if (operation === "put") kvPuts++;
  else if (operation === "delete") kvDeletes++;
  if (error) kvErrors++;
}

/**
 * Get a full infrastructure metrics snapshot.
 * Runs live health probes against D1, KV, and InventoryDO.
 */
export async function getInfraMetrics(env) {
  const [d1Probe, kvProbe, doMetrics] = await Promise.all([
    probeD1(env),
    probeKV(env),
    getDOMetrics(env)
  ]);

  const slowQueries = d1QueryLog.filter(q => q.isSlow);
  const allD1Durations = d1QueryLog.map(q => q.durationMs);
  const avgD1Latency = allD1Durations.length > 0
    ? Math.round(allD1Durations.reduce((a, b) => a + b, 0) / allD1Durations.length)
    : null;

  return {
    d1: {
      status: d1Probe.status,
      probeLatencyMs: d1Probe.latencyMs,
      probeError: d1Probe.error,
      reads: d1Reads,
      writes: d1Writes,
      errors: d1Errors,
      total: d1Reads + d1Writes,
      avgQueryLatencyMs: avgD1Latency,
      slowQueriesCount: slowQueries.length,
      recentSlowQueries: slowQueries.slice(0, 5),
      recentQueries: d1QueryLog.slice(0, 10),
      tables: d1Probe.tables || []
    },
    kv: {
      status: kvProbe.status,
      probeLatencyMs: kvProbe.latencyMs,
      probeError: kvProbe.error,
      gets: kvGets,
      puts: kvPuts,
      deletes: kvDeletes,
      errors: kvErrors,
      total: kvGets + kvPuts + kvDeletes
    },
    do: doMetrics
  };
}

// ─── Internal probe helpers ───────────────────────────────────────

async function probeD1(env) {
  if (!env?.DB) {
    return { status: "DOWN", latencyMs: null, error: "DB binding not configured", tables: [] };
  }
  const t0 = performance.now();
  try {
    const res = await env.DB.prepare("SELECT 1 as ping").first();
    const latencyMs = Math.round(performance.now() - t0);
    if (res?.ping !== 1) {
      return { status: "DEGRADED", latencyMs, error: "Unexpected probe result", tables: [] };
    }

    // Fetch table row counts in parallel
    const tables = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) as count FROM products WHERE is_active = 1").first()
        .then(r => ({ table: "products", rows: r?.count ?? 0 })).catch(() => ({ table: "products", rows: null })),
      env.DB.prepare("SELECT COUNT(*) as count FROM orders").first()
        .then(r => ({ table: "orders", rows: r?.count ?? 0 })).catch(() => ({ table: "orders", rows: null })),
      env.DB.prepare("SELECT COUNT(*) as count FROM feedback").first()
        .then(r => ({ table: "feedback", rows: r?.count ?? 0 })).catch(() => ({ table: "feedback", rows: null }))
    ]);

    return {
      status: latencyMs > 350 ? "DEGRADED" : "HEALTHY",
      latencyMs,
      error: null,
      tables
    };
  } catch (err) {
    return { status: "DOWN", latencyMs: Math.round(performance.now() - t0), error: err.message, tables: [] };
  }
}

async function probeKV(env) {
  if (!env?.CLOUDCART_KV) {
    return { status: "DOWN", latencyMs: null, error: "CLOUDCART_KV binding not configured" };
  }
  const t0 = performance.now();
  try {
    const key = "__obs_kv_probe__";
    await env.CLOUDCART_KV.get(key);
    const latencyMs = Math.round(performance.now() - t0);
    return { status: latencyMs > 800 ? "DEGRADED" : "HEALTHY", latencyMs, error: null };
  } catch (err) {
    return { status: "DOWN", latencyMs: Math.round(performance.now() - t0), error: err.message };
  }
}

async function getDOMetrics(env) {
  if (!env?.INVENTORY_DO) {
    return { status: "DOWN", error: "INVENTORY_DO binding not configured" };
  }
  try {
    const doId = env.INVENTORY_DO.idFromName("cloudcart-inventory-global");
    const stub = env.INVENTORY_DO.get(doId);
    const res = await stub.fetch("http://do/metrics");
    if (!res.ok) return { status: "DEGRADED", error: `DO responded with HTTP ${res.status}` };
    const data = await res.json();
    return {
      status: "HEALTHY",
      activeConnections: data.activeConnections ?? 0,
      totalConnectionsOpened: data.totalConnectionsOpened ?? 0,
      totalConnectionsClosed: data.totalConnectionsClosed ?? 0,
      totalMessagesSent: data.totalMessagesSent ?? 0,
      totalMessagesReceived: data.totalMessagesReceived ?? 0,
      connectionErrors: data.connectionErrors ?? 0,
      totalPurchases: data.totalPurchases ?? 0,
      purchaseErrors: data.purchaseErrors ?? 0,
      avgPurchaseLatencyMs: data.avgPurchaseLatencyMs ?? null
    };
  } catch (err) {
    return { status: "DOWN", error: err.message };
  }
}
