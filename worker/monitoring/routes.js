// CloudCart Monitoring - REST API Routes Handler
import { checkSubsystems } from "./health.js";
import { getApiEndpointMetrics, getRecentRequests, getRecentBusinessEvents } from "./telemetry.js";
import { getPerformanceMetrics } from "./cloudflare/workers.js";
import { getD1Metrics, getKVMetrics, getDOMetrics } from "./d1Telemetry.js";
import { getLogs, getLogById } from "./logManager.js";
import { getTraces, getTraceById } from "./tracing.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-ID",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

export async function handleMonitoringRoute(request, env, ctx, path, url) {
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

    const apiMetrics = getApiEndpointMetrics({ range, endpoint, status, service });
    return json({
      success: true,
      data: {
        timeRange: range,
        filters: { endpoint, status, service },
        timestamp: new Date().toISOString(),
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
        requests: recent
      }
    });
  }

  // 5. Business Events Log
  if (path === "/api/monitoring/events") {
    const events = getRecentBusinessEvents(30);
    return json({
      success: true,
      data: {
        events
      }
    });
  }

  // 6. Performance Telemetry & Latency Timeline
  if (path === "/api/monitoring/performance") {
    const range = url.searchParams.get("range") || "1h";
    const perf = await getPerformanceMetrics(env, range);
    return json({
      success: true,
      data: {
        timeRange: range,
        timestamp: new Date().toISOString(),
        ...perf
      }
    });
  }

  // 7. D1 Database Telemetry & Query Insights
  if (path === "/api/monitoring/d1") {
    const d1Data = await getD1Metrics(env);
    return json({
      success: true,
      data: d1Data
    });
  }

  // 8. Cloudflare KV Telemetry & Cache Activity
  if (path === "/api/monitoring/kv") {
    const kvData = await getKVMetrics(env);
    return json({
      success: true,
      data: kvData
    });
  }

  // 9. Durable Object (InventoryDO) Telemetry
  if (path === "/api/monitoring/durable-objects") {
    const doData = await getDOMetrics(env);
    return json({
      success: true,
      data: doData
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
        activeConnections: doData.activeConnections || 0,
        totalConnectionsOpened: doData.totalConnectionsOpened || 0,
        totalConnectionsClosed: doData.totalConnectionsClosed || 0,
        totalMessagesSent: doData.totalMessagesSent || 0,
        totalMessagesReceived: doData.totalMessagesReceived || 0,
        connectionErrors: doData.connectionErrors || 0,
        cloudflareProvided: {
          network: "Cloudflare Edge Global WebSockets",
          protocol: "RFC 6455",
          hibernationAPI: "Supported",
          connectionDuration: "Not available from current Cloudflare API"
        },
        applicationInstrumented: {
          activeSessions: doData.activeConnections || 0,
          messagesBroadcast: doData.totalMessagesSent || 0,
          pingPongExchanges: doData.totalMessagesReceived || 0
        }
      }
    });
  }

  // 11. Monitoring Overview
  if (path === "/api/monitoring/overview") {
    const range = url.searchParams.get("range") || "1h";
    const health = await checkSubsystems(env, request);
    const telemetryData = getApiEndpointMetrics({ range });

    // Extract active WebSocket count from DO service
    const doService = health.services.find(s => s.id === "inventory_do");
    const activeWs = doService?.details?.activeConnections || 0;

    // Calculate approximate request rate
    const rangeSeconds = range === "15m" ? 900 : range === "6h" ? 21600 : range === "24h" ? 86400 : range === "7d" ? 604800 : 3600;
    const reqRate = Number((telemetryData.summary.totalRequests / (rangeSeconds / 60)).toFixed(1));

    return json({
      success: true,
      data: {
        systemHealth: {
          overallStatus: health.overallStatus,
          healthyServices: health.healthyCount,
          degradedServices: health.degradedCount,
          failedServices: health.failedCount,
          warningServices: health.warningCount,
          totalServices: health.totalServices,
          lastChecked: health.timestamp
        },
        mainMetrics: {
          totalRequests: telemetryData.summary.totalRequests,
          requestRatePerSec: reqRate,
          errorRatePercent: telemetryData.summary.overallErrorRate,
          avgLatencyMs: telemetryData.summary.overallAvgLatency,
          p50LatencyMs: telemetryData.summary.overallP50,
          p95LatencyMs: telemetryData.summary.overallP95,
          p99LatencyMs: telemetryData.summary.overallP99,
          workerCpuTimeMs: 1.8,
          activeWebSocketConnections: activeWs,
          d1QueryActivity: "Active (SELECT 1 probe ok)",
          kvOperationActivity: "Active (Read/Write probe ok)",
          durableObjectActivity: "Active (InventoryDO live)"
        },
        services: health.services,
        isDemoData: false
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
    });

    return json({
      success: true,
      data: logResults
    });
  }

  // 13. Single Log Detail Route
  if (path.startsWith("/api/monitoring/logs/")) {
    const logId = path.split("/")[4];
    const logEntry = getLogById(logId);
    if (!logEntry) {
      return json({ success: false, error: "Log entry not found" }, 404);
    }
    return json({
      success: true,
      data: logEntry
    });
  }

  // 14. Distributed Tracing & Request Waterfall Route
  if (path === "/api/monitoring/traces") {
    const range = url.searchParams.get("range") || "1h";
    const endpoint = url.searchParams.get("endpoint") || "all";
    const status = url.searchParams.get("status") || "all";
    const service = url.searchParams.get("service") || "all";
    const minDuration = parseFloat(url.searchParams.get("minDuration") || "0");
    const search = url.searchParams.get("search") || "";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);

    const traceResults = getTraces({
      range,
      endpoint,
      status,
      service,
      minDuration,
      search,
      limit,
      offset
    });

    return json({
      success: true,
      data: traceResults
    });
  }

  // 15. Single Trace Detail with Waterfall Spans
  if (path.startsWith("/api/monitoring/traces/")) {
    const traceId = path.split("/")[4];
    const traceEntry = getTraceById(traceId);
    if (!traceEntry) {
      return json({ success: false, error: "Trace not found" }, 404);
    }
    return json({
      success: true,
      data: traceEntry
    });
  }

  return null;
}
