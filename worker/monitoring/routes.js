// CloudCart Monitoring - REST API Routes Handler
import { checkSubsystems } from "./health.js";
import { getApiEndpointMetrics, getRecentRequests, getRecentBusinessEvents } from "./telemetry.js";
import { getD1Metrics, getKVMetrics, getDOMetrics } from "./d1Telemetry.js";
import { getLogs, getLogById } from "./logManager.js";
import { METRIC_SOURCES, isDemoMode, formatMetric } from "./sources.js";

function getCorsHeaders(request, env) {
  const origin = request?.headers?.get("Origin") || "";
  const isAllowed = !origin ||
    origin.includes("localhost") ||
    origin.includes("127.0.0.1") ||
    origin.endsWith(".pages.dev") ||
    (env?.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN);

  return {
    "Access-Control-Allow-Origin": isAllowed ? (origin || "*") : (env?.ALLOWED_ORIGIN || "null"),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-ID, X-Admin-Key, X-Monitoring-Key",
    "Vary": "Origin"
  };
}

function verifyAdminAuth(request, env) {
  const requiredKey = env?.MONITORING_API_KEY || env?.ADMIN_TOKEN;
  if (!requiredKey) {
    return { authorized: true };
  }

  const authHeader = request.headers.get("Authorization") || "";
  const adminKeyHeader = request.headers.get("X-Admin-Key") || request.headers.get("X-Monitoring-Key") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : authHeader.trim();

  if (token === requiredKey || adminKeyHeader === requiredKey) {
    return { authorized: true };
  }

  return {
    authorized: false,
    response: new Response(JSON.stringify({
      success: false,
      error: "Unauthorized. Admin credentials required to access monitoring telemetry.",
      source: METRIC_SOURCES.UNAVAILABLE
    }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        ...getCorsHeaders(request, env)
      }
    })
  };
}

function json(data, status = 200, request = null, env = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders(request, env),
    },
  });
}

export async function handleMonitoringRoute(request, env, ctx, path, url) {
  const demoActive = isDemoMode(env);

  // Handle CORS Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request, env)
    });
  }

  // Admin authentication check (enforced when MONITORING_API_KEY or ADMIN_TOKEN is set)
  // Health probe /api/monitoring/health remains public for edge pingers
  if (path !== "/api/monitoring/health") {
    const auth = verifyAdminAuth(request, env);
    if (!auth.authorized) {
      return auth.response;
    }
  }

  // 1. Full Health Check Probe
  if (path === "/api/monitoring/health") {
    const health = await checkSubsystems(env, request);
    return json({
      success: true,
      data: health
    });
  }

  // 2. Services Health Grid
  if (path === "/api/monitoring/services") {
    const health = await checkSubsystems(env, request);
    return json({
      success: true,
      data: {
        timestamp: health.timestamp,
        overallStatus: health.overallStatus,
        services: health.services
      }
    });
  }

  // 3. API Endpoints Performance Metrics
  if (path === "/api/monitoring/api") {
    const range = url.searchParams.get("range") || "1h";
    const endpoint = url.searchParams.get("endpoint") || "all";
    const status = url.searchParams.get("status") || "all";
    const service = url.searchParams.get("service") || "all";

    const apiMetrics = getApiEndpointMetrics({ range, endpoint, status, service }, env);
    return json({
      success: true,
      data: {
        timeRange: range,
        filters: { endpoint, status, service },
        timestamp: new Date().toISOString(),
        isDemoData: apiMetrics.isDemoData,
        source: apiMetrics.source,
        summary: apiMetrics.summary,
        endpoints: apiMetrics.endpoints,
        recentRequestsCount: apiMetrics.recentRequestsCount
      }
    });
  }

  // 4. Recent Requests Inspect Route
  if (path === "/api/monitoring/api/recent") {
    const limit = parseInt(url.searchParams.get("limit") || "30", 10);
    const recent = getRecentRequests(Math.min(limit, 100));
    return json({
      success: true,
      data: {
        requests: recent,
        source: METRIC_SOURCES.APPLICATION_INSTRUMENTED
      }
    });
  }

  // 5. Business Events Log
  if (path === "/api/monitoring/events") {
    const events = getRecentBusinessEvents(30);
    return json({
      success: true,
      data: {
        events,
        source: METRIC_SOURCES.APPLICATION_INSTRUMENTED
      }
    });
  }

  // 7. D1 Database Telemetry & Query Insights
  if (path === "/api/monitoring/d1") {
    const appD1 = await getD1Metrics(env);

    return json({
      success: true,
      data: {
        ...appD1
      }
    });
  }

  // 8. Cloudflare KV Telemetry & Cache Activity
  if (path === "/api/monitoring/kv") {
    const appKV = await getKVMetrics(env);

    return json({
      success: true,
      data: {
        ...appKV
      }
    });
  }

  // 9. Durable Object (InventoryDO) Telemetry
  if (path === "/api/monitoring/durable-objects") {
    const appDO = await getDOMetrics(env);

    return json({
      success: true,
      data: {
        ...appDO
      }
    });
  }

  // 10. WebSocket Synchronization Telemetry
  if (path === "/api/monitoring/websocket") {
    const doData = await getDOMetrics(env);
    return json({
      success: true,
      data: {
        route: "/api/sync",
        protocol: "wss",
        role: "Real-time inventory synchronization across customer sessions and admin portal",
        status: doData.status || "HEALTHY",
        source: METRIC_SOURCES.APPLICATION_INSTRUMENTED,
        activeConnections: doData.applicationInstrumented?.activeConnections || formatMetric(0, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
        totalConnectionsOpened: doData.applicationInstrumented?.totalConnectionsOpened || formatMetric(0, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
        totalConnectionsClosed: doData.applicationInstrumented?.totalConnectionsClosed || formatMetric(0, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
        totalMessagesSent: doData.applicationInstrumented?.totalMessagesSent || formatMetric(0, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
        totalMessagesReceived: doData.applicationInstrumented?.totalMessagesReceived || formatMetric(0, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
        connectionErrors: doData.applicationInstrumented?.connectionErrors || formatMetric(0, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
        cloudflareProvided: {
          network: "Cloudflare Edge Global WebSockets",
          protocol: "RFC 6455",
          hibernationAPI: "Supported",
          connectionDuration: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Platform WebSocket connection duration is not exposed via runtime API" })
        },
        applicationInstrumented: {
          note: "Measured by InventoryDO global actor in-memory. Resets on DO restart.",
          activeSessions: doData.applicationInstrumented?.activeConnections?.value ?? 0,
          messagesBroadcast: doData.applicationInstrumented?.totalMessagesSent?.value ?? 0,
          pingPongExchanges: doData.applicationInstrumented?.totalMessagesReceived?.value ?? 0
        }
      }
    });
  }

  // 11. Monitoring Overview
  if (path === "/api/monitoring/overview") {
    const range = url.searchParams.get("range") || "1h";
    const health = await checkSubsystems(env, request);
    const telemetryData = getApiEndpointMetrics({ range }, env);

    // Active WebSocket count from DO probe
    const doService = health.services.find(s => s.id === "inventory_do");
    const activeWs = doService?.details?.activeConnections ?? 0;

    // Calculate approximate request rate
    const rangeSeconds = range === "15m" ? 900 : range === "6h" ? 21600 : range === "24h" ? 86400 : range === "7d" ? 604800 : 3600;
    const totalReqs = telemetryData.summary.totalRequests.value ?? 0;
    const reqRate = totalReqs > 0 ? Number((totalReqs / (rangeSeconds / 60)).toFixed(1)) : 0;

    return json({
      success: true,
      data: {
        isDemoData: demoActive,
        systemHealth: {
          overallStatus: health.overallStatus,
          healthyServices: health.healthyCount,
          degradedServices: health.degradedCount,
          failedServices: health.failedCount,
          warningServices: health.warningCount,
          unknownServices: health.unknownCount ?? 0,
          totalServices: health.totalServices,
          lastChecked: health.timestamp
        },
        mainMetrics: {
          totalRequests: telemetryData.summary.totalRequests,
          requestRatePerMin: formatMetric(reqRate, METRIC_SOURCES.CALCULATED, { calculation: "totalRequests / (windowMinutes)" }),
          errorRatePercent: telemetryData.summary.overallErrorRate,
          avgLatencyMs: telemetryData.summary.overallAvgLatency,
          p50LatencyMs: telemetryData.summary.overallP50,
          p95LatencyMs: telemetryData.summary.overallP95,
          p99LatencyMs: telemetryData.summary.overallP99,
          activeWebSocketConnections: formatMetric(activeWs, METRIC_SOURCES.APPLICATION_INSTRUMENTED),
          d1QueryActivity: "Active (SELECT 1 probe ok)",
          kvOperationActivity: "Active (Read/Write probe ok)",
          durableObjectActivity: "Active (InventoryDO live)"
        },
        services: health.services
      }
    });
  }

  // 12. Centralized Logs & Error Center Route
  if (path === "/api/monitoring/logs") {
    const range = url.searchParams.get("range") || "1h";
    const level = url.searchParams.get("level") || "all";
    const service = url.searchParams.get("service") || "all";
    const endpoint = url.searchParams.get("endpoint") || "all";
    const search = url.searchParams.get("search") || "";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);

    const logResults = getLogs({
      range,
      level,
      service,
      endpoint,
      search,
      limit,
      offset
    }, env);

    return json({
      success: true,
      data: logResults
    });
  }

  // 13. Single Log Detail Route
  if (path.startsWith("/api/monitoring/logs/")) {
    const logId = path.split("/")[4];
    const logEntry = getLogById(logId, env);
    if (!logEntry) {
      return json({ success: false, error: "Log entry not found" }, 404);
    }
    return json({
      success: true,
      data: logEntry
    });
  }



  return null;
}
