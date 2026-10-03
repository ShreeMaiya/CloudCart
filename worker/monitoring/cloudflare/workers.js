import { executeGraphQL } from "./graphql.js";
import { validateTimeRange, validateCredentials, validateDatasetQuery, introspectAccountDatasets } from "./schema.js";
import { METRIC_SOURCES, isDemoMode, formatMetric } from "../sources.js";

const SCRIPT_NAME = "cloudcart-worker";

/**
 * Generate simulated timeline strictly for development demonstration when MONITORING_DEMO_MODE=true
 */
function generateDemoTimeline(range = "1h", windowMs) {
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
    let label = bucketTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (range === "7d") {
      label = bucketTime.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
    }

    const hourFactor = Math.sin((bucketTime.getHours() / 24) * Math.PI) * 0.4 + 0.8;
    const baseReqs = Math.max(8, Math.round(45 * hourFactor + (Math.random() * 20 - 10)));
    const errors = Math.random() < 0.25 ? Math.floor(Math.random() * 2) + 1 : 0;
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
      durationMs,
      source: METRIC_SOURCES.DEMO
    });
  }

  const avgDuration = Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length);
  const avgCpu = Number((allCpu.reduce((a, b) => a + b, 0) / allCpu.length).toFixed(2));

  return {
    source: METRIC_SOURCES.DEMO,
    isDemoData: true,
    note: "DEMO DATA — Not live Cloudflare telemetry. Simulated for demonstration while MONITORING_DEMO_MODE=true.",
    summary: {
      totalRequests: formatMetric(totalRequests, METRIC_SOURCES.DEMO),
      totalErrors: formatMetric(totalErrors, METRIC_SOURCES.DEMO),
      errorRatePercent: formatMetric(
        totalRequests > 0 ? Number(((totalErrors / totalRequests) * 100).toFixed(2)) : 0,
        METRIC_SOURCES.DEMO,
        { calculation: "(totalErrors / totalRequests) * 100", unit: "%" }
      ),
      avgDurationMs: formatMetric(avgDuration, METRIC_SOURCES.DEMO, { unit: "ms" }),
      avgCpuTimeMs: formatMetric(avgCpu, METRIC_SOURCES.DEMO, { unit: "ms" }),
      p50: formatMetric(Math.round(avgDuration * 0.8), METRIC_SOURCES.DEMO, { unit: "ms" }),
      p95: formatMetric(Math.round(avgDuration * 2.1), METRIC_SOURCES.DEMO, { unit: "ms" }),
      p99: formatMetric(Math.round(avgDuration * 3.0), METRIC_SOURCES.DEMO, { unit: "ms" })
    },
    timeline
  };
}

/**
 * Fetch performance metrics from Cloudflare GraphQL or report explicit UNAVAILABLE / DEMO
 */
export async function getPerformanceMetrics(env, range = "1h") {
  const timeValidation = validateTimeRange(range);
  if (!timeValidation.isValid) {
    return {
      source: METRIC_SOURCES.UNAVAILABLE,
      isDemoData: false,
      error: timeValidation.error,
      summary: null,
      timeline: []
    };
  }

  const { start, end, windowMs } = timeValidation;
  const credCheck = validateCredentials(env);

  // If credentials are valid, execute real Cloudflare GraphQL query
  if (credCheck.isValid) {
    const intro = await introspectAccountDatasets(env, executeGraphQL);
    const hasAdaptive = !intro.ok || intro.datasets.has("workersInvocationsAdaptive");

    if (!hasAdaptive) {
      return {
        source: METRIC_SOURCES.UNAVAILABLE,
        isDemoData: false,
        reason: "Dataset 'workersInvocationsAdaptive' is not exposed on this Cloudflare account.",
        summary: null,
        timeline: []
      };
    }

    const datasetValidation = validateDatasetQuery("workersInvocationsAdaptive", {
      dimensions: ["datetimeFifteenMinutes", "datetimeHour", "status"],
      sums: ["requests", "errors", "subrequests"],
      quantiles: ["cpuTimeP50", "cpuTimeP95", "cpuTimeP99", "durationP50", "durationP95", "durationP99"]
    });

    if (!datasetValidation.isValid) {
      return {
        source: METRIC_SOURCES.UNAVAILABLE,
        isDemoData: false,
        error: datasetValidation.error,
        summary: null,
        timeline: []
      };
    }

    const query = `
      query GetWorkersAnalytics($accountTag: String!, $datetimeStart: String!, $datetimeEnd: String!, $scriptName: String!) {
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
      accountTag: credCheck.accountId,
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
        const validDurations = [];
        const validCpus = [];

        for (const row of rows) {
          const reqs = row.sum?.requests ?? 0;
          const errs = row.sum?.errors ?? 0;
          totalRequests += reqs;
          totalErrors += errs;

          const timeDim = row.dimensions?.datetimeFifteenMinutes || row.dimensions?.datetimeHour;
          const timeLabel = timeDim ? new Date(timeDim).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "--";

          // Strictly use real quantile values or null; no hardcoded defaults!
          const p50Val = row.quantiles?.durationP50 ?? null;
          const p95Val = row.quantiles?.durationP95 ?? null;
          const p99Val = row.quantiles?.durationP99 ?? null;
          const cpuVal = row.quantiles?.cpuTimeP50 ?? null;

          if (p50Val !== null) validDurations.push(p50Val);
          if (cpuVal !== null) validCpus.push(cpuVal);

          timeline.push({
            time: timeLabel,
            isoTimestamp: timeDim || new Date().toISOString(),
            requests: reqs,
            errors: errs,
            avgLatencyMs: p50Val,
            p50Ms: p50Val,
            p95Ms: p95Val,
            p99Ms: p99Val,
            cpuTimeMs: cpuVal,
            durationMs: p50Val,
            source: METRIC_SOURCES.CLOUDFLARE_NATIVE
          });
        }

        const avgDuration = validDurations.length > 0
          ? Math.round(validDurations.reduce((s, i) => s + i, 0) / validDurations.length)
          : null;
        const avgCpu = validCpus.length > 0
          ? Number((validCpus.reduce((s, i) => s + i, 0) / validCpus.length).toFixed(2))
          : null;

        const firstP50 = timeline.find(t => t.p50Ms !== null)?.p50Ms ?? null;
        const firstP95 = timeline.find(t => t.p95Ms !== null)?.p95Ms ?? null;
        const firstP99 = timeline.find(t => t.p99Ms !== null)?.p99Ms ?? null;

        return {
          source: METRIC_SOURCES.CLOUDFLARE_NATIVE,
          isDemoData: false,
          summary: {
            totalRequests: formatMetric(totalRequests, METRIC_SOURCES.CLOUDFLARE_NATIVE),
            totalErrors: formatMetric(totalErrors, METRIC_SOURCES.CLOUDFLARE_NATIVE),
            errorRatePercent: formatMetric(
              totalRequests > 0 ? Number(((totalErrors / totalRequests) * 100).toFixed(2)) : 0,
              METRIC_SOURCES.CALCULATED,
              { calculation: "(totalErrors / totalRequests) * 100", unit: "%" }
            ),
            avgDurationMs: avgDuration !== null
              ? formatMetric(avgDuration, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
              : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Duration quantiles not provided in query result" }),
            avgCpuTimeMs: avgCpu !== null
              ? formatMetric(avgCpu, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
              : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "CPU quantiles not provided in query result" }),
            p50: firstP50 !== null
              ? formatMetric(firstP50, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
              : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "P50 duration quantile not provided" }),
            p95: firstP95 !== null
              ? formatMetric(firstP95, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
              : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "P95 duration quantile not provided" }),
            p99: firstP99 !== null
              ? formatMetric(firstP99, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
              : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "P99 duration quantile not provided" })
          },
          timeline
        };
      }
    }
  }

  // Check if Demo Mode is explicitly enabled
  if (isDemoMode(env)) {
    return generateDemoTimeline(range, windowMs);
  }

  // In production / non-demo mode when credentials are missing or return empty:
  return {
    source: METRIC_SOURCES.UNAVAILABLE,
    isDemoData: false,
    reason: credCheck.reason || "Cloudflare GraphQL API returned no telemetry records for the selected time window.",
    summary: {
      totalRequests: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: credCheck.reason }),
      totalErrors: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: credCheck.reason }),
      errorRatePercent: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: credCheck.reason }),
      avgDurationMs: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: credCheck.reason }),
      avgCpuTimeMs: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: credCheck.reason }),
      p50: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: credCheck.reason }),
      p95: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: credCheck.reason }),
      p99: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: credCheck.reason })
    },
    timeline: []
  };
}
