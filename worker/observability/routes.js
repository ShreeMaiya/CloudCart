// CloudCart Observability — REST API Route Handler
// All routes served under /api/observability/
// Three pillars: Logs (/logs), Metrics (/metrics/*), Traces (/traces)

import { checkSubsystems } from "./health.js";
import { getRequestMetrics, getBusinessMetrics } from "./metrics.js";
import { getInfraMetrics } from "./d1Telemetry.js";
import { getLogs, getLogById } from "./logManager.js";
import { getTraces, getTraceById } from "./tracing.js";

// ─── Auth & CORS ──────────────────────────────────────────────────

function corsHeaders(request, env) {
  const origin = request?.headers?.get("Origin") || "";
  const allowed = !origin
    || origin.includes("localhost")
    || origin.includes("127.0.0.1")
    || origin.endsWith(".pages.dev")
    || (env?.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN);

  return {
    "Access-Control-Allow-Origin": allowed ? (origin || "*") : (env?.ALLOWED_ORIGIN || "null"),
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-ID, X-Admin-Key",
    "Vary": "Origin"
  };
}

function verifyAuth(request, env) {
  const key = env?.OBSERVABILITY_API_KEY || env?.MONITORING_API_KEY || env?.ADMIN_TOKEN;
  if (!key) return { authorized: true }; // Open if no key configured

  const authHeader = request.headers.get("Authorization") || "";
  const adminKey = request.headers.get("X-Admin-Key") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();

  if (token === key || adminKey === key) return { authorized: true };
  return {
    authorized: false,
    response: json({ success: false, error: "Unauthorized. Admin credentials required." }, 401, request, env)
  };
}

function json(data, status = 200, request = null, env = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request, env) }
  });
}

function qp(url, key, fallback) {
  return url.searchParams.get(key) || fallback;
}

// ─── Main Route Handler ────────────────────────────────────────────

export async function handleObservabilityRoute(request, env, ctx, path, url) {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  // /health is public — used by uptime monitors and edge pingers
  if (path !== "/api/observability/health") {
    const auth = verifyAuth(request, env);
    if (!auth.authorized) return auth.response;
  }

  // ── Health ─────────────────────────────────────────────────────

  if (path === "/api/observability/health") {
    const health = await checkSubsystems(env);
    return json({ success: true, data: health }, 200, request, env);
  }

  if (path === "/api/observability/services") {
    const health = await checkSubsystems(env);
    return json({
      success: true,
      data: {
        timestamp: health.timestamp,
        overallStatus: health.overallStatus,
        services: health.services
      }
    }, 200, request, env);
  }

  // ── Overview (summary of all three pillars) ─────────────────────

  if (path === "/api/observability/overview") {
    const range = qp(url, "range", "1h");
    const [health, reqMetrics, bizMetrics] = await Promise.all([
      checkSubsystems(env),
      Promise.resolve(getRequestMetrics({ range })),
      Promise.resolve(getBusinessMetrics(range))
    ]);
    const doService = health.services.find(s => s.id === "inventory_do");

    return json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        timeRange: range,
        systemHealth: {
          overallStatus: health.overallStatus,
          healthyServices: health.healthyCount,
          degradedServices: health.degradedCount,
          failedServices: health.failedCount,
          totalServices: health.totalServices,
          lastChecked: health.timestamp
        },
        requestMetrics: {
          totalRequests: reqMetrics.summary.totalRequests,
          totalErrors: reqMetrics.summary.totalErrors,
          errorRate: reqMetrics.summary.errorRate,
          avgLatencyMs: reqMetrics.summary.latency.avg,
          p50Ms: reqMetrics.summary.latency.p50,
          p95Ms: reqMetrics.summary.latency.p95,
          p99Ms: reqMetrics.summary.latency.p99
        },
        businessMetrics: {
          checkoutsTotal: bizMetrics.counters.checkouts_total,
          checkoutsSucceeded: bizMetrics.counters.checkouts_succeeded,
          checkoutsFailed: bizMetrics.counters.checkouts_failed,
          revenueTotalCents: bizMetrics.counters.revenue_total_cents,
          revenueTotal: bizMetrics.counters.revenue_total,
          productsCreated: bizMetrics.counters.products_created,
          productsUpdated: bizMetrics.counters.products_updated,
          productsDeleted: bizMetrics.counters.products_deleted,
          feedbackSubmitted: bizMetrics.counters.feedback_submitted
        },
        activeWebSocketConnections: doService?.details?.activeConnections ?? 0
      }
    }, 200, request, env);
  }

  // ── PILLAR 1: Logs ─────────────────────────────────────────────

  if (path === "/api/observability/logs") {
    const result = getLogs({
      range:    qp(url, "range",    "1h"),
      level:    qp(url, "level",    "all"),
      service:  qp(url, "service",  "all"),
      endpoint: qp(url, "endpoint", "all"),
      search:   qp(url, "search",   ""),
      limit:    Math.min(parseInt(qp(url, "limit",  "50"), 10), 200),
      offset:   parseInt(qp(url, "offset", "0"), 10)
    });
    return json({ success: true, data: result }, 200, request, env);
  }

  if (path.startsWith("/api/observability/logs/")) {
    const logId = path.split("/")[4];
    const log = getLogById(logId);
    if (!log) return json({ success: false, error: "Log entry not found" }, 404, request, env);
    return json({ success: true, data: log }, 200, request, env);
  }

  // ── PILLAR 2: Metrics ──────────────────────────────────────────

  if (path === "/api/observability/metrics") {
    const range = qp(url, "range", "1h");
    const reqM = getRequestMetrics({ range });
    const bizM = getBusinessMetrics(range);
    return json({ success: true, data: { timeRange: range, requests: reqM, business: bizM } }, 200, request, env);
  }

  if (path === "/api/observability/metrics/requests") {
    const result = getRequestMetrics({
      range:    qp(url, "range",    "1h"),
      endpoint: qp(url, "endpoint", "all"),
      status:   qp(url, "status",   "all")
    });
    return json({ success: true, data: result }, 200, request, env);
  }

  if (path === "/api/observability/metrics/business") {
    const result = getBusinessMetrics(qp(url, "range", "1h"));
    return json({ success: true, data: result }, 200, request, env);
  }

  if (path === "/api/observability/metrics/infra") {
    const result = await getInfraMetrics(env);
    return json({ success: true, data: result }, 200, request, env);
  }

  // ── PILLAR 3: Traces ───────────────────────────────────────────

  if (path === "/api/observability/traces") {
    const result = getTraces({
      range:         qp(url, "range",         "1h"),
      endpoint:      qp(url, "endpoint",      "all"),
      status:        qp(url, "status",        "all"),
      businessEvent: qp(url, "businessEvent", "all"),
      limit:         Math.min(parseInt(qp(url, "limit",  "50"), 10), 200),
      offset:        parseInt(qp(url, "offset", "0"), 10)
    });
    return json({ success: true, data: result }, 200, request, env);
  }

  if (path.startsWith("/api/observability/traces/")) {
    const traceId = path.split("/")[4];
    const trace = getTraceById(traceId);
    if (!trace) return json({ success: false, error: "Trace not found" }, 404, request, env);
    return json({ success: true, data: trace }, 200, request, env);
  }

  return null; // not a route we handle — let caller return 404
}
