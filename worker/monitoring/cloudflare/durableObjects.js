// CloudCart Monitoring - Cloudflare Native Durable Objects Analytics Integration
import { executeGraphQL } from "./graphql.js";
import { validateTimeRange, validateCredentials, validateDatasetQuery } from "./schema.js";
import { METRIC_SOURCES, isDemoMode, formatMetric } from "../sources.js";

/**
 * Fetch Cloudflare Native Durable Objects Analytics via GraphQL
 * Distinguishes native platform analytics from CloudCart in-memory DO actor instrumentation.
 */
export async function getNativeDOAnalytics(env, range = "1h") {
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

  if (credCheck.isValid) {
    const datasetValidation = validateDatasetQuery("durableObjectsInvocationsAdaptive", {
      dimensions: ["datetimeFifteenMinutes"],
      sums: ["requests", "errors"],
      quantiles: ["cpuTimeP50", "cpuTimeP95", "durationP50", "durationP95"]
    });

    if (datasetValidation.isValid) {
      const query = `
        query GetDOAnalytics($accountTag: String!, $datetimeStart: String!, $datetimeEnd: String!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              durableObjectsInvocationsAdaptive(
                filter: {
                  datetime_geq: $datetimeStart,
                  datetime_leq: $datetimeEnd
                },
                limit: 500
              ) {
                dimensions {
                  datetimeFifteenMinutes
                }
                sum {
                  requests
                  errors
                }
                quantiles {
                  cpuTimeP50
                  cpuTimeP95
                  durationP50
                  durationP95
                }
              }
            }
          }
        }
      `;

      const variables = {
        accountTag: credCheck.accountId,
        datetimeStart: start.toISOString(),
        datetimeEnd: end.toISOString()
      };

      const result = await executeGraphQL(env, query, variables);

      if (result.ok && result.data?.viewer?.accounts?.[0]?.durableObjectsInvocationsAdaptive) {
        const rows = result.data.viewer.accounts[0].durableObjectsInvocationsAdaptive;
        let invocations = 0;
        let errors = 0;

        for (const r of rows) {
          invocations += r.sum?.requests ?? 0;
          errors += r.sum?.errors ?? 0;
        }

        const cpuP50 = rows[0]?.quantiles?.cpuTimeP50 ?? null;
        const cpuP95 = rows[0]?.quantiles?.cpuTimeP95 ?? null;
        const durP50 = rows[0]?.quantiles?.durationP50 ?? null;
        const durP95 = rows[0]?.quantiles?.durationP95 ?? null;

        return {
          source: METRIC_SOURCES.CLOUDFLARE_NATIVE,
          isDemoData: false,
          label: "Cloudflare Durable Objects Analytics (Platform Native)",
          metrics: {
            invocations: formatMetric(invocations, METRIC_SOURCES.CLOUDFLARE_NATIVE),
            errors: formatMetric(errors, METRIC_SOURCES.CLOUDFLARE_NATIVE),
            cpuTimeP50: cpuP50 !== null
              ? formatMetric(cpuP50, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
              : formatMetric(null, METRIC_SOURCES.UNAVAILABLE),
            cpuTimeP95: cpuP95 !== null
              ? formatMetric(cpuP95, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
              : formatMetric(null, METRIC_SOURCES.UNAVAILABLE),
            durationP50: durP50 !== null
              ? formatMetric(durP50, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
              : formatMetric(null, METRIC_SOURCES.UNAVAILABLE),
            durationP95: durP95 !== null
              ? formatMetric(durP95, METRIC_SOURCES.CLOUDFLARE_NATIVE, { unit: "ms" })
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
      label: "Cloudflare Durable Objects Analytics (Demo Simulation)",
      note: "DEMO DATA — Simulated native metrics for local testing.",
      metrics: {
        invocations: formatMetric(240, METRIC_SOURCES.DEMO),
        errors: formatMetric(0, METRIC_SOURCES.DEMO),
        cpuTimeP50: formatMetric(1.4, METRIC_SOURCES.DEMO, { unit: "ms" }),
        cpuTimeP95: formatMetric(3.8, METRIC_SOURCES.DEMO, { unit: "ms" }),
        durationP50: formatMetric(6.2, METRIC_SOURCES.DEMO, { unit: "ms" }),
        durationP95: formatMetric(14.5, METRIC_SOURCES.DEMO, { unit: "ms" })
      }
    };
  }

  // Unavailable in production when credentials not provided
  return {
    source: METRIC_SOURCES.UNAVAILABLE,
    isDemoData: false,
    label: "Cloudflare Durable Objects Analytics (Platform Native)",
    reason: credCheck.reason || "Cloudflare GraphQL credentials not configured.",
    metrics: {
      invocations: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: credCheck.reason }),
      errors: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: credCheck.reason }),
      cpuTimeP50: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: credCheck.reason }),
      cpuTimeP95: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: credCheck.reason }),
      durationP50: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: credCheck.reason }),
      durationP95: formatMetric(null, METRIC_SOURCES.UNAVAILABLE, { reason: credCheck.reason })
    }
  };
}
