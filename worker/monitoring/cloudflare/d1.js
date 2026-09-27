// CloudCart Monitoring - Cloudflare Native D1 Analytics Integration
import { executeGraphQL } from "./graphql.js";
import { validateTimeRange, validateCredentials, validateDatasetQuery } from "./schema.js";
import { METRIC_SOURCES, isDemoMode, formatMetric } from "../sources.js";

/**
 * Fetch Cloudflare Native D1 Analytics via GraphQL
 * Distinguishes native platform analytics from CloudCart in-isolate application instrumentation.
 */
export async function getNativeD1Analytics(env, range = "1h") {
  const timeValidation = validateTimeRange(range);
  if (!timeValidation.isValid) {
    return {
      source: METRIC_SOURCES.UNAVAILABLE,
      isDemoData: false,
      error: timeValidation.error,
      analytics: null
    };
  }

  const { start, end } = timeValidation;
  const credCheck = validateCredentials(env);
  const databaseId = env?.D1_DATABASE_ID;

  if (credCheck.isValid && databaseId) {
    const datasetValidation = validateDatasetQuery("d1AnalyticsAdaptive", {
      dimensions: ["datetimeFifteenMinutes", "databaseId"],
      sums: ["readQueries", "writeQueries", "rowsRead", "rowsWritten"],
      quantiles: ["queryBatchTimeMsP50", "queryBatchTimeMsP95", "queryBatchTimeMsP99"]
    });

    if (datasetValidation.isValid) {
      const query = `
        query GetD1Analytics($accountTag: String!, $datetimeStart: String!, $datetimeEnd: String!, $databaseId: String!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              d1AnalyticsAdaptive(
                filter: {
                  datetime_geq: $datetimeStart,
                  datetime_leq: $datetimeEnd,
                  databaseId: $databaseId
                },
                limit: 500
              ) {
                dimensions {
                  datetimeFifteenMinutes
                  databaseId
                }
                sum {
                  readQueries
                  writeQueries
                  rowsRead
                  rowsWritten
                }
                quantiles {
                  queryBatchTimeMsP50
                  queryBatchTimeMsP95
                  queryBatchTimeMsP99
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
        databaseId
      };

      const result = await executeGraphQL(env, query, variables);

      if (result.ok && result.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptive) {
        const rows = result.data.viewer.accounts[0].d1AnalyticsAdaptive;
        let totalReads = 0;
        let totalWrites = 0;
        let totalRowsRead = 0;
        let totalRowsWritten = 0;

        for (const r of rows) {
          totalReads += r.sum?.readQueries ?? 0;
          totalWrites += r.sum?.writeQueries ?? 0;
          totalRowsRead += r.sum?.rowsRead ?? 0;
          totalRowsWritten += r.sum?.rowsWritten ?? 0;
        }

        const p50 = rows[0]?.quantiles?.queryBatchTimeMsP50 ?? null;
        const p95 = rows[0]?.quantiles?.queryBatchTimeMsP95 ?? null;
        const p99 = rows[0]?.quantiles?.queryBatchTimeMsP99 ?? null;

        return {
          source: METRIC_SOURCES.CLOUDFLARE_NATIVE,
          isDemoData: false,
          label: "Cloudflare D1 Analytics (Platform Native)",
          metrics: {
            readQueries: formatMetric(totalReads, METRIC_SOURCES.CLOUDFLARE_NATIVE),
            writeQueries: formatMetric(totalWrites, METRIC_SOURCES.CLOUDFLARE_NATIVE),
            rowsRead: formatMetric(totalRowsRead, METRIC_SOURCES.CLOUDFLARE_NATIVE),
            rowsWritten: formatMetric(totalRowsWritten, METRIC_SOURCES.CLOUDFLARE_NATIVE),
            batchLatencyP50: p50 !== null
              ? formatMetric(p50, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
              : formatMetric(null, METRIC_SOURCES.UNAVAILABLE),
            batchLatencyP95: p95 !== null
              ? formatMetric(p95, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
              : formatMetric(null, METRIC_SOURCES.UNAVAILABLE),
            batchLatencyP99: p99 !== null
              ? formatMetric(p99, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
              : formatMetric(null, METRIC_SOURCES.UNAVAILABLE)
          }
        };
      }
    }
  }

  // Demo mode check
  if (isDemoMode(env)) {
    return {
      source: METRIC_SOURCES.DEMO,
      isDemoData: true,
      label: "Cloudflare D1 Analytics (Demo Simulation)",
      note: "DEMO DATA — Simulated native metrics for local testing.",
      metrics: {
        readQueries: formatMetric(1420, METRIC_SOURCES.DEMO),
        writeQueries: formatMetric(180, METRIC_SOURCES.DEMO),
        rowsRead: formatMetric(8500, METRIC_SOURCES.DEMO),
        rowsWritten: formatMetric(390, METRIC_SOURCES.DEMO),
        batchLatencyP50: formatMetric(12, METRIC_SOURCES.DEMO, { unit: "ms" }),
        batchLatencyP95: formatMetric(28, METRIC_SOURCES.DEMO, { unit: "ms" }),
        batchLatencyP99: formatMetric(45, METRIC_SOURCES.DEMO, { unit: "ms" })
      }
    };
  }

  // Unavailable in production when credentials or database ID not provided
  return {
    source: METRIC_SOURCES.UNAVAILABLE,
    isDemoData: false,
    label: "Cloudflare D1 Analytics (Platform Native)",
    reason: !databaseId
      ? "D1_DATABASE_ID secret not configured. Set D1_DATABASE_ID and CLOUDFLARE_API_TOKEN to stream native Cloudflare D1 GraphQL metrics."
      : credCheck.reason,
    metrics: {
      readQueries: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare D1 Analytics API not configured" }),
      writeQueries: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare D1 Analytics API not configured" }),
      rowsRead: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare D1 Analytics API not configured" }),
      rowsWritten: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare D1 Analytics API not configured" }),
      batchLatencyP50: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare D1 Analytics API not configured" }),
      batchLatencyP95: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare D1 Analytics API not configured" }),
      batchLatencyP99: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare D1 Analytics API not configured" })
    }
  };
}
