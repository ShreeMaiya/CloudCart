// CloudCart Monitoring - D1 Database & KV Telemetry Provider
import { METRIC_SOURCES, isDemoMode, formatMetric } from "./sources.js";

// In-memory query tracking for D1 & KV — starts strictly at 0 in production!
const d1QueryLog = [];
let totalD1Reads = 0;
let totalD1Writes = 0;
let totalD1Errors = 0;

let totalKVReads = 0;
let totalKVWrites = 0;
let totalKVDeletes = 0;
let totalKVErrors = 0;

/**
 * Record a D1 query execution
 */
export function recordD1Query(query, durationMs, isWrite = false, error = null) {
  if (isWrite) totalD1Writes++;
  else totalD1Reads++;
  if (error) totalD1Errors++;

  d1QueryLog.unshift({
    query: String(query).substring(0, 150),
    durationMs: Math.round(durationMs),
    type: isWrite ? "WRITE" : "READ",
    error: error ? String(error) : null,
    isSlow: durationMs > 35,
    timestamp: new Date().toISOString(),
    source: METRIC_SOURCES.APPLICATION_INSTRUMENTED
  });

  if (d1QueryLog.length > 50) d1QueryLog.pop();
}

/**
 * Record a KV operation
 */
export function recordKVOperation(operation, durationMs, error = null) {
  if (operation === "get") totalKVReads++;
  else if (operation === "put") totalKVWrites++;
  else if (operation === "delete") totalKVDeletes++;
  if (error) totalKVErrors++;
}

/**
 * Retrieve comprehensive D1 Database Telemetry
 */
export async function getD1Metrics(env) {
  const demo = isDemoMode(env);
  const probeStart = performance.now();
  let probeOk = false;
  let probeLatency = null;
  let probeError = null;

  let productsCount = 0;
  let ordersCount = 0;
  let feedbackCount = 0;

  if (env && env.DB) {
    try {
      const probe = await env.DB.prepare("SELECT 1 as ping").first();
      probeLatency = Math.round(performance.now() - probeStart);
      probeOk = probe?.ping === 1;

      // Table counts
      const p = await env.DB.prepare("SELECT COUNT(*) as count FROM products WHERE is_active = 1").first();
      const o = await env.DB.prepare("SELECT COUNT(*) as count FROM orders").first();
      const f = await env.DB.prepare("SELECT COUNT(*) as count FROM feedback").first();

      productsCount = p?.count ?? 0;
      ordersCount = o?.count ?? 0;
      feedbackCount = f?.count ?? 0;
    } catch (err) {
      probeError = err.message;
      probeLatency = Math.round(performance.now() - probeStart);
    }
  } else {
    probeError = "D1 database binding 'DB' not configured";
  }

  const slowQueries = d1QueryLog.filter(q => q.isSlow);
  const allDurations = d1QueryLog.map(q => q.durationMs);
  const avgQueryLatency = allDurations.length > 0
    ? Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length)
    : probeLatency;

  const totalQueries = totalD1Reads + totalD1Writes;

  return {
    databaseName: "cloudcart-db",
    binding: "DB",
    engine: "Cloudflare D1 (Serverless SQLite)",
    source: demo ? METRIC_SOURCES.DEMO : METRIC_SOURCES.APPLICATION_INSTRUMENTED,
    status: probeOk ? "HEALTHY" : "DOWN",
    probe: {
      probeOk: formatMetric(probeOk, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
      probeLatencyMs: probeLatency !== null
        ? formatMetric(probeLatency, METRIC_SOURCES.APPLICATION_INSTRUMENTED, { unit: "ms" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: probeError || "Probe did not complete" }),
      probeQuery: "SELECT 1 as ping",
      error: probeError
    },
    applicationTelemetry: {
      label: "CloudCart Application D1 Instrumentation",
      note: "Measured in-isolate by CloudCart runtime code; resets on Worker isolate eviction.",
      totalQueries: formatMetric(totalQueries, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
      reads: formatMetric(totalD1Reads, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
      writes: formatMetric(totalD1Writes, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
      errors: formatMetric(totalD1Errors, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
      avgQueryLatencyMs: avgQueryLatency !== null
        ? formatMetric(avgQueryLatency, METRIC_SOURCES.CALCULATED, { calculation: "mean of measured in-isolate D1 query times", unit: "ms" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "No query samples recorded" })
    },
    tables: [
      {
        table: "products",
        role: "Product Catalog (Active SKUs)",
        rows: formatMetric(productsCount, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
        indexes: ["idx_products_category", "idx_products_active"],
        source: METRIC_SOURCES.APPLICATION_INSTRUMENTED
      },
      {
        table: "orders",
        role: "Completed Customer Orders & Transactions",
        rows: formatMetric(ordersCount, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
        indexes: ["PRIMARY KEY (id)", "idx_orders_created"],
        source: METRIC_SOURCES.APPLICATION_INSTRUMENTED
      },
      {
        table: "feedback",
        role: "Customer Reviews & Star Ratings",
        rows: formatMetric(feedbackCount, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
        indexes: ["PRIMARY KEY (id)", "idx_feedback_created"],
        source: METRIC_SOURCES.APPLICATION_INSTRUMENTED
      }
    ],
    storage: {
      storageUsed: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "D1 storage metrics are not exposed by the Worker runtime binding." }),
      engineArchitecture: "SQLite via Cloudflare Serverless D1",
      replication: "Automated read replication & edge distribution"
    },
    slowQueriesCount: slowQueries.length,
    recentSlowQueries: slowQueries.slice(0, 10),
    recentQueries: d1QueryLog.slice(0, 20)
  };
}

/**
 * Retrieve comprehensive Cloudflare KV Telemetry
 */
export async function getKVMetrics(env) {
  const demo = isDemoMode(env);
  const probeStart = performance.now();
  let probeOk = false;
  let probeLatency = null;
  let probeError = null;

  if (env && env.CLOUDCART_KV) {
    try {
      const probeKey = "__monitoring_kv_probe__";
      await env.CLOUDCART_KV.put(probeKey, "ok", { expirationTtl: 60 });
      const res = await env.CLOUDCART_KV.get(probeKey);
      await env.CLOUDCART_KV.delete(probeKey);
      probeLatency = Math.round(performance.now() - probeStart);
      probeOk = res === "ok";
    } catch (err) {
      probeError = err.message;
      probeLatency = Math.round(performance.now() - probeStart);
    }
  } else {
    probeError = "KV binding 'CLOUDCART_KV' not configured";
  }

  const totalOps = totalKVReads + totalKVWrites + totalKVDeletes;

  return {
    namespace: "cloudcart-kv",
    binding: "CLOUDCART_KV",
    role: "Persistent multi-device shopping cart sessions",
    keyPattern: "cart:<sessionId> (7-day expiration TTL)",
    source: demo ? METRIC_SOURCES.DEMO : METRIC_SOURCES.APPLICATION_INSTRUMENTED,
    status: probeOk ? "HEALTHY" : "DOWN",
    probe: {
      probeOk: formatMetric(probeOk, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
      probeLatencyMs: probeLatency !== null
        ? formatMetric(probeLatency, METRIC_SOURCES.APPLICATION_INSTRUMENTED, { unit: "ms" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: probeError || "Probe did not complete" }),
      probeKey: "__monitoring_kv_probe__",
      error: probeError
    },
    applicationTelemetry: {
      label: "CloudCart Application KV Instrumentation",
      note: "Measured in-isolate by CloudCart runtime code; resets on Worker isolate eviction.",
      totalOperations: formatMetric(totalOps, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
      reads: formatMetric(totalKVReads, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
      writes: formatMetric(totalKVWrites, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
      deletes: formatMetric(totalKVDeletes, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
      errors: formatMetric(totalKVErrors, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
      avgOperationLatencyMs: probeLatency !== null
        ? formatMetric(probeLatency, METRIC_SOURCES.APPLICATION_INSTRUMENTED, { unit: "ms" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Probe not completed" })
    },
    storage: {
      storageUsed: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "KV storage metrics require Cloudflare Account GraphQL or REST API." }),
      maxKeySize: "512 Bytes (Key) / 25 MB (Value Limit)",
      consistencyModel: "Eventual consistency (Global edge caching)"
    },
    trends: {
      readWriteRatio: totalKVWrites > 0
        ? formatMetric(Number((totalKVReads / totalKVWrites).toFixed(1)), METRIC_SOURCES.CALCULATED, { calculation: "reads / writes" })
        : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "No KV writes recorded" }),
      activeSessionCartsNote: "Session carts are maintained with 7-day TTL expiration."
    }
  };
}

/**
 * Retrieve Durable Object (InventoryDO) & WebSocket Telemetry
 */
export async function getDOMetrics(env) {
  if (!env || !env.INVENTORY_DO) {
    return {
      className: "InventoryDO",
      role: "Real-time inventory synchronization and atomic inventory coordination.",
      status: "DOWN",
      source: METRIC_SOURCES.UNAVAILABLE,
      error: "INVENTORY_DO binding not configured"
    };
  }

  try {
    const doId = env.INVENTORY_DO.idFromName("cloudcart-inventory-global");
    const doStub = env.INVENTORY_DO.get(doId);
    const res = await doStub.fetch("http://do/metrics");
    
    if (res.ok) {
      const data = await res.json();
      return {
        className: "InventoryDO",
        role: "Real-time inventory synchronization and atomic inventory coordination.",
        status: "HEALTHY",
        source: METRIC_SOURCES.APPLICATION_INSTRUMENTED,
        cloudflareProvided: {
          runtime: "Cloudflare Durable Objects",
          architecture: "Single-threaded globally unique actor",
          location: "Colocated nearest to primary user / edge storage",
          cpuTimeLimit: "30s max wall time per request",
          memoryMetrics: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Durable Object memory utilization is not exposed to the runtime API." })
        },
        applicationInstrumented: {
          label: "CloudCart Application Durable Object Instrumentation",
          note: "In-memory runtime counters for this Durable Object instance (global actor). Resets on DO isolate eviction. Not Cloudflare historical platform analytics.",
          activeConnections: formatMetric(data.activeConnections ?? 0, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
          totalConnectionsOpened: formatMetric(data.totalConnectionsOpened ?? 0, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
          totalConnectionsClosed: formatMetric(data.totalConnectionsClosed ?? 0, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
          totalMessagesSent: formatMetric(data.totalMessagesSent ?? 0, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
          totalMessagesReceived: formatMetric(data.totalMessagesReceived ?? 0, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
          connectionErrors: formatMetric(data.connectionErrors ?? 0, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
          totalPurchases: formatMetric(data.totalPurchases ?? 0, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
          purchaseErrors: formatMetric(data.purchaseErrors ?? 0, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
          avgPurchaseLatencyMs: data.avgPurchaseLatencyMs !== undefined && data.avgPurchaseLatencyMs !== null
            ? formatMetric(data.avgPurchaseLatencyMs, METRIC_SOURCES.APPLICATION_INSTRUMENTED, { unit: "ms" })
            : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "No purchases executed in this DO instance" })
        }
      };
    } else {
      return {
        className: "InventoryDO",
        role: "Real-time inventory synchronization and atomic inventory coordination.",
        status: "DEGRADED",
        source: METRIC_SOURCES.APPLICATION_INSTRUMENTED,
        error: `DO responded with HTTP ${res.status}`
      };
    }
  } catch (err) {
    return {
      className: "InventoryDO",
      role: "Real-time inventory synchronization and atomic inventory coordination.",
      status: "DOWN",
      source: METRIC_SOURCES.APPLICATION_INSTRUMENTED,
      error: err.message
    };
  }
}
