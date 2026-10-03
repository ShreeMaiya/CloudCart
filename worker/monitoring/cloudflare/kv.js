// CloudCart Monitoring - Cloudflare Native KV Analytics Integration
import { executeGraphQL } from "./graphql.js";
import { validateTimeRange, validateCredentials, validateDatasetQuery, introspectAccountDatasets } from "./schema.js";
import { METRIC_SOURCES, isDemoMode, formatMetric } from "../sources.js";

/**
 * Fetch Cloudflare Native KV Analytics via GraphQL
 * Uses canonical Cloudflare KV analytics datasets (kvOperationsAdaptiveGroups, kvStorageAdaptiveGroups)
 * and distinguishes native platform analytics from CloudCart in-isolate application instrumentation.
 */
export async function getNativeKVAnalytics(env, range = "1h") {
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
  const namespaceId = env?.KV_NAMESPACE_ID;

  if (credCheck.isValid && namespaceId) {
    // 1. Verify available datasets on Account via GraphQL introspection
    const intro = await introspectAccountDatasets(env, executeGraphQL);
    const hasOpsGroups = !intro.ok || intro.datasets.has("kvOperationsAdaptiveGroups");
    const hasStorageGroups = !intro.ok || intro.datasets.has("kvStorageAdaptiveGroups");

    if (hasOpsGroups) {
      const datasetValidation = validateDatasetQuery("kvOperationsAdaptiveGroups", {
        dimensions: ["datetimeFifteenMinutes", "action", "namespaceId"],
        sums: ["requests"]
      });

      if (datasetValidation.isValid) {
        const storageSubquery = hasStorageGroups ? `
          kvStorageAdaptiveGroups(
            filter: {
              namespaceId: $namespaceId
            },
            limit: 10
          ) {
            sum {
              byteCount
            }
          }
        ` : "";

        const query = `
          query GetKVAnalytics($accountTag: String!, $datetimeStart: String!, $datetimeEnd: String!, $namespaceId: String!) {
            viewer {
              accounts(filter: { accountTag: $accountTag }) {
                kvOperationsAdaptiveGroups(
                  filter: {
                    datetime_geq: $datetimeStart,
                    datetime_leq: $datetimeEnd,
                    namespaceId: $namespaceId
                  },
                  limit: 500
                ) {
                  dimensions {
                    datetimeFifteenMinutes
                    action
                  }
                  sum {
                    requests
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
          namespaceId
        };

        const result = await executeGraphQL(env, query, variables);

        if (result.ok && result.data?.viewer?.accounts?.[0]) {
          const accountData = result.data.viewer.accounts[0];
          const rows = accountData.kvOperationsAdaptiveGroups || [];
          const storageRows = accountData.kvStorageAdaptiveGroups || [];

          let reads = 0;
          let writes = 0;
          let deletes = 0;

          for (const r of rows) {
            const count = r.sum?.requests ?? 0;
            const action = (r.dimensions?.action || "").toLowerCase();
            if (action.includes("read") || action.includes("get")) reads += count;
            else if (action.includes("write") || action.includes("put")) writes += count;
            else if (action.includes("delete")) deletes += count;
          }

          const total = reads + writes + deletes;

          // KV storage bytes
          const storageBytes = storageRows[0]?.sum?.byteCount ?? null;
          const storageMetric = storageBytes !== null
            ? formatMetric(storageBytes, METRIC_SOURCES.CLOUDFLARE_NATIVE, {
                unit: "bytes",
                formatted: `${(storageBytes / 1024).toFixed(1)} KB`
              })
            : formatMetric(null, METRIC_SOURCES.UNAVAILABLE, {
                reason: "kvStorageAdaptiveGroups returned no storage data."
              });

          return {
            source: METRIC_SOURCES.CLOUDFLARE_NATIVE,
            isDemoData: false,
            label: "Cloudflare KV Analytics (Platform Native)",
            datasetUsed: "kvOperationsAdaptiveGroups",
            storageDatasetUsed: hasStorageGroups ? "kvStorageAdaptiveGroups" : null,
            metrics: {
              totalOperations: formatMetric(total, METRIC_SOURCES.CLOUDFLARE_NATIVE),
              reads: formatMetric(reads, METRIC_SOURCES.CLOUDFLARE_NATIVE),
              writes: formatMetric(writes, METRIC_SOURCES.CLOUDFLARE_NATIVE),
              deletes: formatMetric(deletes, METRIC_SOURCES.CLOUDFLARE_NATIVE),
              storage: storageMetric
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
      label: "Cloudflare KV Analytics (Demo Simulation)",
      datasetUsed: "kvOperationsAdaptiveGroups",
      note: "DEMO DATA — Simulated native metrics for local testing.",
      metrics: {
        totalOperations: formatMetric(1240, METRIC_SOURCES.DEMO),
        reads: formatMetric(890, METRIC_SOURCES.DEMO),
        writes: formatMetric(310, METRIC_SOURCES.DEMO),
        deletes: formatMetric(40, METRIC_SOURCES.DEMO),
        storage: formatMetric(450560, METRIC_SOURCES.DEMO, { unit: "bytes", formatted: "440 KB" })
      }
    };
  }

  // Unavailable in production when credentials or namespace ID not provided
  return {
    source: METRIC_SOURCES.UNAVAILABLE,
    isDemoData: false,
    label: "Cloudflare KV Analytics (Platform Native)",
    datasetUsed: "kvOperationsAdaptiveGroups",
    reason: !namespaceId
      ? "KV_NAMESPACE_ID secret not configured. Set KV_NAMESPACE_ID and CLOUDFLARE_API_TOKEN to stream native Cloudflare KV GraphQL metrics."
      : credCheck.reason,
    metrics: {
      totalOperations: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare KV Analytics API not configured" }),
      reads: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare KV Analytics API not configured" }),
      writes: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare KV Analytics API not configured" }),
      deletes: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare KV Analytics API not configured" }),
      storage: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "KV storage byte volume requires Cloudflare Account GraphQL credentials." })
    }
  };
}
