// CloudCart Monitoring - Cloudflare Native KV Analytics Integration
import { executeGraphQL } from "./graphql.js";
import { validateTimeRange, validateCredentials, validateDatasetQuery } from "./schema.js";
import { METRIC_SOURCES, isDemoMode, formatMetric } from "../sources.js";

/**
 * Fetch Cloudflare Native KV Analytics via GraphQL
 * Distinguishes native platform analytics from CloudCart in-isolate application instrumentation.
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
    const datasetValidation = validateDatasetQuery("kvOperationsAdaptive", {
      dimensions: ["datetimeFifteenMinutes", "action"],
      sums: ["requests"]
    });

    if (datasetValidation.isValid) {
      const query = `
        query GetKVAnalytics($accountTag: String!, $datetimeStart: String!, $datetimeEnd: String!, $namespaceId: String!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              kvOperationsAdaptive(
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

      if (result.ok && result.data?.viewer?.accounts?.[0]?.kvOperationsAdaptive) {
        const rows = result.data.viewer.accounts[0].kvOperationsAdaptive;
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

        return {
          source: METRIC_SOURCES.CLOUDFLARE_NATIVE,
          isDemoData: false,
          label: "Cloudflare KV Analytics (Platform Native)",
          metrics: {
            totalOperations: formatMetric(total, METRIC_SOURCES.CLOUDFLARE_NATIVE),
            reads: formatMetric(reads, METRIC_SOURCES.CLOUDFLARE_NATIVE),
            writes: formatMetric(writes, METRIC_SOURCES.CLOUDFLARE_NATIVE),
            deletes: formatMetric(deletes, METRIC_SOURCES.CLOUDFLARE_NATIVE),
            storage: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "KV storage byte volume requires Cloudflare Account REST API." })
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
      label: "Cloudflare KV Analytics (Demo Simulation)",
      note: "DEMO DATA — Simulated native metrics for local testing.",
      metrics: {
        totalOperations: formatMetric(1240, METRIC_SOURCES.DEMO),
        reads: formatMetric(890, METRIC_SOURCES.DEMO),
        writes: formatMetric(310, METRIC_SOURCES.DEMO),
        deletes: formatMetric(40, METRIC_SOURCES.DEMO),
        storage: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Storage byte volume requires Account REST API." })
      }
    };
  }

  // Unavailable in production when credentials or namespace ID not provided
  return {
    source: METRIC_SOURCES.UNAVAILABLE,
    isDemoData: false,
    label: "Cloudflare KV Analytics (Platform Native)",
    reason: !namespaceId
      ? "KV_NAMESPACE_ID secret not configured. Set KV_NAMESPACE_ID and CLOUDFLARE_API_TOKEN to stream native Cloudflare KV GraphQL metrics."
      : credCheck.reason,
    metrics: {
      totalOperations: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare KV Analytics API not configured" }),
      reads: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare KV Analytics API not configured" }),
      writes: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare KV Analytics API not configured" }),
      deletes: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "Cloudflare KV Analytics API not configured" }),
      storage: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: "KV storage byte volume requires Account REST API." })
    }
  };
}
