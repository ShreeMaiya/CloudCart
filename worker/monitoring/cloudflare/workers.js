// CloudCart Monitoring - Cloudflare Workers Analytics & Performance Integration
import { executeGraphQL } from "./graphql.js";

const SCRIPT_NAME = "cloudcart-worker";

/**
 * Convert range string into start and end Date objects
 */
function getTimeRangeWindow(range = "1h") {
  const now = new Date();
  const rangesMs = {
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000
  };

  const windowMs = rangesMs[range] || rangesMs["1h"];
  const start = new Date(now.getTime() - windowMs);
  return { start, end: now, windowMs };
}

/**
 * Generates development/fallback time-series timeline for performance monitoring
 */
function generateDevPerformanceTimeline(range = "1h", windowMs) {
  const now = Date.now();
  let bucketCount = 12;
  let bucketIntervalMs = windowMs / bucketCount;

  if (range === "15m") {
    bucketCount = 15;
    bucketIntervalMs = 60 * 1000;
  } else if (range === "1h") {
    bucketCount = 12;
    bucketIntervalMs = 5 * 60 * 1000;
  } else if (range === "6h") {
    bucketCount = 12;
    bucketIntervalMs = 30 * 60 * 1000;
  } else if (range === "24h") {
    bucketCount = 24;
    bucketIntervalMs = 60 * 60 * 1000;
  } else if (range === "7d") {
    bucketCount = 7;
    bucketIntervalMs = 24 * 60 * 60 * 1000;
  }

  const timeline = [];
  let totalRequests = 0;
  let totalErrors = 0;
  const allDurations = [];
  const allCpu = [];

  for (let i = bucketCount - 1; i >= 0; i--) {
    const bucketTime = new Date(now - (i * bucketIntervalMs));
    
    // Time label formatting
    let label = bucketTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (range === "7d") {
      label = bucketTime.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
    }

    // Realistic baseline volume with diurnal waves
    const hourFactor = Math.sin((bucketTime.getHours() / 24) * Math.PI) * 0.4 + 0.8;
    const baseReqs = Math.max(8, Math.round(45 * hourFactor + (Math.random() * 20 - 10)));
    const errors = Math.random() < 0.25 ? Math.floor(Math.random() * 2) + 1 : 0;
    
    // Latencies
    const avgLatencyMs = Math.round(18 + Math.random() * 8);
    const p50Ms = Math.round(avgLatencyMs * 0.8);
    const p95Ms = Math.round(avgLatencyMs * 2.2 + (errors > 0 ? 30 : 0));
    const p99Ms = Math.round(p95Ms * 1.5);
    const cpuTimeMs = Number((1.2 + Math.random() * 0.9).toFixed(2));
    const durationMs = Math.round(avgLatencyMs + Math.random() * 6);

    totalRequests += baseReqs;
    totalErrors += errors;
    allDurations.push(avgLatencyMs);
    allCpu.push(cpuTimeMs);

    timeline.push({
      time: label,
      isoTimestamp: bucketTime.toISOString(),
      requests: baseReqs,
      errors: errors,
      avgLatencyMs,
      p50Ms,
      p95Ms,
      p99Ms,
      cpuTimeMs,
      durationMs
    });
  }

  const avgDuration = Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length);
  const avgCpu = Number((allCpu.reduce((a, b) => a + b, 0) / allCpu.length).toFixed(2));

  return {
    source: "DEMO_DATA",
    isDemoData: true,
    note: "Running in local dev mode. Configure CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in Worker secrets to stream live edge GraphQL analytics.",
    summary: {
      totalRequests,
      totalErrors,
      errorRatePercent: totalRequests > 0 ? Number(((totalErrors / totalRequests) * 100).toFixed(2)) : 0,
      avgDurationMs: avgDuration,
      avgCpuTimeMs: avgCpu,
      p50: Math.round(avgDuration * 0.8),
      p95: Math.round(avgDuration * 2.1),
      p99: Math.round(avgDuration * 3.0)
    },
    timeline
  };
}

/**
 * Fetch performance metrics from Cloudflare GraphQL or dev fallback
 */
export async function getPerformanceMetrics(env, range = "1h") {
  const { start, end, windowMs } = getTimeRangeWindow(range);

  // If credentials are configured, execute real Cloudflare GraphQL query
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN && !env.CLOUDFLARE_ACCOUNT_ID.startsWith("00000000")) {
    const query = `
      query GetWorkersAnalytics($accountTag: string!, $datetimeStart: string!, $datetimeEnd: string!, $scriptName: string!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            workersInvocationsAdaptive(
              filter: {
                datetime_geq: $datetimeStart,
                datetime_leq: $datetimeEnd,
                scriptName: $scriptName
              },
              limit: 1000
            ) {
              dimensions {
                datetimeHour
                datetimeFifteenMinutes
                status
              }
              sum {
                requests
                errors
                subrequests
              }
              quantiles {
                cpuTimeP50
                cpuTimeP95
                cpuTimeP99
                durationP50
                durationP95
                durationP99
              }
            }
          }
        }
      }
    `;

    const variables = {
      accountTag: env.CLOUDFLARE_ACCOUNT_ID,
      datetimeStart: start.toISOString(),
      datetimeEnd: end.toISOString(),
      scriptName: SCRIPT_NAME
    };

    const result = await executeGraphQL(env, query, variables);

    if (result.ok && result.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive) {
      const rows = result.data.viewer.accounts[0].workersInvocationsAdaptive;
      
      if (rows.length > 0) {
        let totalRequests = 0;
        let totalErrors = 0;
        const timeline = [];

        for (const row of rows) {
          const reqs = row.sum?.requests || 0;
          const errs = row.sum?.errors || 0;
          totalRequests += reqs;
          totalErrors += errs;

          const timeDim = row.dimensions?.datetimeFifteenMinutes || row.dimensions?.datetimeHour;
          const timeLabel = timeDim ? new Date(timeDim).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "--";

          timeline.push({
            time: timeLabel,
            isoTimestamp: timeDim || new Date().toISOString(),
            requests: reqs,
            errors: errs,
            avgLatencyMs: Math.round(row.quantiles?.durationP50 || 15),
            p50Ms: Math.round(row.quantiles?.durationP50 || 12),
            p95Ms: Math.round(row.quantiles?.durationP95 || 35),
            p99Ms: Math.round(row.quantiles?.durationP99 || 70),
            cpuTimeMs: Number((row.quantiles?.cpuTimeP50 || 1.5).toFixed(2)),
            durationMs: Math.round(row.quantiles?.durationP50 || 15)
          });
        }

        return {
          source: "CLOUDFLARE_GRAPHQL",
          isDemoData: false,
          summary: {
            totalRequests,
            totalErrors,
            errorRatePercent: totalRequests > 0 ? Number(((totalErrors / totalRequests) * 100).toFixed(2)) : 0,
            avgDurationMs: Math.round(timeline.reduce((s, i) => s + i.durationMs, 0) / (timeline.length || 1)),
            avgCpuTimeMs: Number((timeline.reduce((s, i) => s + i.cpuTimeMs, 0) / (timeline.length || 1)).toFixed(2)),
            p50: Math.round(timeline[0]?.p50Ms || 15),
            p95: Math.round(timeline[0]?.p95Ms || 40),
            p99: Math.round(timeline[0]?.p99Ms || 80)
          },
          timeline
        };
      }
    }
  }

  // Fallback to Development / Simulator Timeline with clear demo data label
  return generateDevPerformanceTimeline(range, windowMs);
}
