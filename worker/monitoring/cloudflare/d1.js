// CloudCart Monitoring - Cloudflare Native D1 Analytics Integration
import { executeGraphQL } from "./graphql.js";
import { validateTimeRange, validateCredentials, validateDatasetQuery, introspectAccountDatasets } from "./schema.js";
import { METRIC_SOURCES, isDemoMode, formatMetric } from "../sources.js";

/**
 * Fetch Cloudflare Native D1 Analytics via GraphQL
 * Uses canonical Cloudflare D1 analytics datasets (d1AnalyticsAdaptiveGroups, d1StorageAdaptiveGroups)
 * and distinguishes native platform analytics from CloudCart in-isolate application instrumentation.
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
    // 1. Verify available datasets on Account via GraphQL introspection
    const intro = await introspectAccountDatasets(env, executeGraphQL);
    
    // Choose confirmed dataset: d1AnalyticsAdaptiveGroups preferred
    const hasAnalyticsGroups = !intro.ok || intro.datasets.has("d1AnalyticsAdaptiveGroups");
    const hasStorageGroups = !intro.ok || intro.datasets.has("d1StorageAdaptiveGroups");

    if (hasAnalyticsGroups) {
      const datasetValidation = validateDatasetQuery("d1AnalyticsAdaptiveGroups", {
        dimensions: ["datetimeFifteenMinutes", "databaseId"],
        sums: ["readQueries", "writeQueries", "rowsRead", "rowsWritten"],
        quantiles: ["queryBatchTimeMsP50", "queryBatchTimeMsP95", "queryBatchTimeMsP99"]
      });

      if (datasetValidation.isValid) {
        // Build query including d1StorageAdaptiveGroups if supported
        const storageSubquery = hasStorageGroups ? `
          d1StorageAdaptiveGroups(
            filter: {
              datetime_geq: $datetimeStart,
              datetime_leq: $datetimeEnd,
              databaseId: $databaseId
            },
            limit: 10
          ) {
            max {
              databaseSizeBytes
            }
          }
        ` : "";

        const query = `
          query GetD1Analytics($accountTag: String!, $datetimeStart: String!, $datetimeEnd: String!, $databaseId: String!) {
            viewer {
              accounts(filter: { accountTag: $accountTag }) {
                d1AnalyticsAdaptiveGroups(
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
                  avg {
                    queryBatchTimeMs
                  }
                }
                ${storageSubquery}
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

        if (result.ok && result.data?.viewer?.accounts?.[0]) {
          const accountData = result.data.viewer.accounts[0];
          const rows = accountData.d1AnalyticsAdaptiveGroups || [];
          const storageRows = accountData.d1StorageAdaptiveGroups || [];

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

          // Process Storage metric from d1StorageAdaptiveGroups
          const sizeBytes = storageRows[0]?.max?.databaseSizeBytes ?? null;
          const storageMetric = sizeBytes !== null
            ? formatMetric(sizeBytes, METRIC_SOURCES.CLOUDFLARE_NATIVE, {
                unit: "bytes",
                formatted: `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`
              })
            : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, {
                reason: "d1StorageAdaptiveGroups returned no storage measurement for this database."
              });

          return {
            source: METRIC_SOURCES.CLOUDFLARE_NATIVE,
            isDemoData: false,
            label: "Cloudflare D1 Analytics (Platform Native)",
            datasetUsed: "d1AnalyticsAdaptiveGroups",
            storageDatasetUsed: hasStorageGroups ? "d1StorageAdaptiveGroups" : null,
            metrics: {
              readQueries: formatMetric(totalReads, METRIC_SOURCES.CLOUDFLARE_NATIVE),
              writeQueries: formatMetric(totalWrites, METRIC_SOURCES.CLOUDFLARE_NATIVE),
              rowsRead: formatMetric(totalRowsRead, METRIC_SOURCES.CLOUDFLARE_NATIVE),
              rowsWritten: formatMetric(totalRowsWritten, METRIC_SOURCES.CLOUDFLARE_NATIVE),
              batchLatencyP50: p50 !== null
                ? formatMetric(p50, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
                : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Quantile duration not returned" }),
              batchLatencyP95: p95 !== null
                ? formatMetric(p95, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
                : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Quantile duration not returned" }),
              batchLatencyP99: p99 !== null
                ? formatMetric(p99, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
                : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Quantile duration not returned" }),
              databaseSizeBytes: storageMetric
            }
          };
        }
      }
    }
  }

  // Demo mode check
  if (isDemoMode(env)) {
    return {
      source: METRIC_SOURCES.DEMO,
      isDemoData: true,
      label: "Cloudflare D1 Analytics (Demo Simulation)",
      datasetUsed: "d1AnalyticsAdaptiveGroups",
      note: "DEMO DATA — Simulated native metrics for local testing.",
      metrics: {
        readQueries: formatMetric(1420, METRIC_SOURCES.DEMO),
        writeQueries: formatMetric(180, METRIC_SOURCES.DEMO),
        rowsRead: formatMetric(8500, METRIC_SOURCES.DEMO),
        rowsWritten: formatMetric(390, METRIC_SOURCES.DEMO),
        batchLatencyP50: formatMetric(12, METRIC_SOURCES.DEMO, { unit: "ms" }),
        batchLatencyP95: formatMetric(28, METRIC_SOURCES.DEMO, { unit: "ms" }),
        batchLatencyP99: formatMetric(45, METRIC_SOURCES.DEMO, { unit: "ms" }),
        databaseSizeBytes: formatMetric(2457600, METRIC_SOURCES.DEMO, { unit: "bytes", formatted: "2.34 MB" })
      }
    };
  }

  // Unavailable in production when credentials or database ID not provided
  return {
    source: METRIC_SOURCES.UNAVAILABLE,
    isDemoData: false,
    label: "Cloudflare D1 Analytics (Platform Native)",
    datasetUsed: "d1AnalyticsAdaptiveGroups",
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
      batchLatencyP99: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare D1 Analytics API not configured" }),
      databaseSizeBytes: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare D1 Storage API not configured" })
    }
  };
}
