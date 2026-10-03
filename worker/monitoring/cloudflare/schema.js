// CloudCart Monitoring - Cloudflare GraphQL Schema, Query Validator & Schema Discovery Engine
// Performs dynamic introspection against Cloudflare GraphQL API to verify datasets and fields before querying.

export const SUPPORTED_DATASETS = {
  // Workers Analytics
  workersInvocationsAdaptive: {
    description: "Cloudflare Workers execution metrics (requests, errors, CPU, latency quantiles)",
    dimensions: ["datetimeFifteenMinutes", "datetimeHour", "scriptName", "status"],
    sums: ["requests", "errors", "subrequests"],
    quantiles: ["cpuTimeP50", "cpuTimeP95", "cpuTimeP99", "durationP50", "durationP95", "durationP99"],
    requiredFilter: ["accountTag", "datetime_geq", "datetime_leq", "scriptName"]
  },
  workersInvocationsAdaptiveGroups: {
    description: "Cloudflare Workers execution grouped metrics",
    dimensions: ["datetimeFifteenMinutes", "datetimeHour", "scriptName", "status"],
    sum: ["requests", "errors", "subrequests"],
    quantiles: ["cpuTimeP50", "cpuTimeP95", "cpuTimeP99", "durationP50", "durationP95", "durationP99"],
    requiredFilter: ["accountTag", "datetime_geq", "datetime_leq", "scriptName"]
  },

  // D1 Analytics & Storage (Cloudflare Supported Group Datasets)
  d1AnalyticsAdaptiveGroups: {
    description: "Cloudflare D1 SQL query execution, rows read/written, and batch latency quantiles",
    dimensions: ["datetimeFifteenMinutes", "datetimeHour", "databaseId"],
    sum: ["readQueries", "writeQueries", "rowsRead", "rowsWritten"],
    quantiles: ["queryBatchTimeMsP50", "queryBatchTimeMsP95", "queryBatchTimeMsP99"],
    avg: ["queryBatchTimeMs"],
    requiredFilter: ["accountTag", "datetime_geq", "datetime_leq", "databaseId"]
  },
  d1StorageAdaptiveGroups: {
    description: "Cloudflare D1 database storage metrics (databaseSizeBytes)",
    dimensions: ["datetimeFifteenMinutes", "datetimeHour", "databaseId"],
    max: ["databaseSizeBytes"],
    requiredFilter: ["accountTag", "datetime_geq", "datetime_leq", "databaseId"]
  },
  d1QueriesAdaptiveGroups: {
    description: "Cloudflare D1 slow queries and query pattern analysis",
    dimensions: ["query", "databaseId"],
    sum: ["queryBatchTimeMs", "rowsRead", "rowsWritten"],
    requiredFilter: ["accountTag", "datetime_geq", "datetime_leq", "databaseId"]
  },

  // KV Analytics & Storage (Cloudflare Supported Group Datasets)
  kvOperationsAdaptiveGroups: {
    description: "Cloudflare KV namespace operations by action (read, write, delete)",
    dimensions: ["datetimeFifteenMinutes", "datetimeHour", "action", "namespaceId"],
    sum: ["requests"],
    requiredFilter: ["accountTag", "datetime_geq", "datetime_leq", "namespaceId"]
  },
  kvStorageAdaptiveGroups: {
    description: "Cloudflare KV namespace storage byte consumption",
    dimensions: ["namespaceId"],
    sum: ["byteCount"],
    requiredFilter: ["accountTag", "namespaceId"]
  },

  // Durable Objects Analytics & Storage (Cloudflare Supported Group Datasets)
  durableObjectsInvocationsAdaptiveGroups: {
    description: "Cloudflare Durable Objects actor execution and resource consumption",
    dimensions: ["datetimeFifteenMinutes", "datetimeHour", "namespaceId"],
    sum: ["requests", "errors"],
    quantiles: ["cpuTimeP50", "cpuTimeP95", "durationP50", "durationP95"],
    requiredFilter: ["accountTag", "datetime_geq", "datetime_leq"]
  },
  durableObjectsStorageGroups: {
    description: "Cloudflare Durable Objects storage consumption",
    dimensions: ["namespaceId"],
    sum: ["storedBytes"],
    requiredFilter: ["accountTag"]
  },
  durableObjectsPeriodicGroups: {
    description: "Cloudflare Durable Objects periodic usage intervals",
    dimensions: ["datetimeHour"],
    sum: ["activeWebSockets", "cpuTimeMs"],
    requiredFilter: ["accountTag", "datetime_geq", "datetime_leq"]
  },
  durableObjectsSubrequestsAdaptiveGroups: {
    description: "Cloudflare Durable Objects outgoing subrequests",
    dimensions: ["namespaceId"],
    sum: ["subrequests"],
    requiredFilter: ["accountTag", "datetime_geq", "datetime_leq"]
  }
};

export const SUPPORTED_TIME_RANGES = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000
};

// In-isolate Cache for GraphQL Introspection Discovery
const INTROSPECTION_CACHE = {
  timestamp: 0,
  ttlMs: 15 * 60 * 1000, // 15 minute cache
  accountDatasets: null,
  types: new Map()
};

/**
 * Validate and calculate start/end ISO timestamps for the given time range
 */
export function validateTimeRange(range = "1h") {
  const windowMs = SUPPORTED_TIME_RANGES[range];
  if (!windowMs) {
    return {
      isValid: false,
      error: `Unsupported time range '${range}'. Supported ranges: ${Object.keys(SUPPORTED_TIME_RANGES).join(", ")}`,
      start: null,
      end: null,
      windowMs: 0
    };
  }

  const end = new Date();
  const start = new Date(end.getTime() - windowMs);
  return {
    isValid: true,
    error: null,
    start,
    end,
    windowMs
  };
}

/**
 * Validate Cloudflare API credentials in environment
 */
export function validateCredentials(env) {
  if (!env) {
    return { isValid: false, reason: "Worker environment is not available." };
  }

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    return {
      isValid: false,
      reason: "Cloudflare credentials (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN) are not configured."
    };
  }

  if (accountId.startsWith("00000000") || apiToken === "dry-run-token" || apiToken.includes("placeholder")) {
    return {
      isValid: false,
      reason: "Configured Cloudflare credentials are mock or dry-run placeholders."
    };
  }

  return { isValid: true, accountId, apiToken };
}

/**
 * Introspect Cloudflare GraphQL schema to discover available datasets on the Account type
 * Avoids assuming datasets exist without verification.
 */
export async function introspectAccountDatasets(env, executeGraphQLFn) {
  const credCheck = validateCredentials(env);
  if (!credCheck.isValid) {
    return {
      ok: false,
      isConfigured: false,
      datasets: new Set(),
      reason: credCheck.reason
    };
  }

  const now = Date.now();
  if (INTROSPECTION_CACHE.accountDatasets && (now - INTROSPECTION_CACHE.timestamp < INTROSPECTION_CACHE.ttlMs)) {
    return {
      ok: true,
      isConfigured: true,
      datasets: INTROSPECTION_CACHE.accountDatasets,
      cached: true
    };
  }

  const introspectionQuery = `
    query IntrospectAccountFields {
      __type(name: "Account") {
        fields {
          name
        }
      }
    }
  `;

  try {
    const res = await executeGraphQLFn(env, introspectionQuery);
    if (res.ok && res.data?.__type?.fields) {
      const discovered = new Set(res.data.__type.fields.map(f => f.name));
      INTROSPECTION_CACHE.accountDatasets = discovered;
      INTROSPECTION_CACHE.timestamp = now;
      return {
        ok: true,
        isConfigured: true,
        datasets: discovered,
        cached: false
      };
    }
    return {
      ok: false,
      isConfigured: true,
      datasets: new Set(),
      reason: res.error || "GraphQL introspection returned no fields."
    };
  } catch (err) {
    return {
      ok: false,
      isConfigured: true,
      datasets: new Set(),
      reason: `Introspection error: ${err.message}`
    };
  }
}

// Initialize unified metrics array on each dataset
for (const key of Object.keys(SUPPORTED_DATASETS)) {
  const ds = SUPPORTED_DATASETS[key];
  ds.metrics = [
    ...(ds.sum || ds.sums || []),
    ...(ds.quantiles || []),
    ...(ds.max || []),
    ...(ds.avg || [])
  ];
}

export const CLOUDFLARE_ANALYTICS_DATASETS = SUPPORTED_DATASETS;

/**
 * Validate that a query against a dataset uses only supported fields and exists in schema
 */
export function validateDatasetQuery(datasetName, requestedFields = {}) {
  const dataset = SUPPORTED_DATASETS[datasetName];
  if (!dataset) {
    return {
      isValid: false,
      valid: false,
      error: `Dataset '${datasetName}' is not recognized or supported by CloudCart monitoring schema.`
    };
  }

  // Support array format for quick field validation
  if (Array.isArray(requestedFields)) {
    for (const f of requestedFields) {
      if (!dataset.metrics.includes(f) && !dataset.dimensions?.includes(f)) {
        return { isValid: false, valid: false, error: `Field '${f}' is not supported in dataset '${datasetName}'.` };
      }
    }
    return { isValid: true, valid: true, error: null };
  }

  if (requestedFields.dimensions) {
    for (const dim of requestedFields.dimensions) {
      if (!dataset.dimensions?.includes(dim)) {
        return { isValid: false, valid: false, error: `Dimension '${dim}' is not supported in dataset '${datasetName}'.` };
      }
    }
  }

  if (requestedFields.sums || requestedFields.sum) {
    const requested = requestedFields.sums || requestedFields.sum;
    const supportedSums = dataset.sums || dataset.sum || [];
    for (const sum of requested) {
      if (!supportedSums.includes(sum)) {
        return { isValid: false, valid: false, error: `Sum metric '${sum}' is not supported in dataset '${datasetName}'.` };
      }
    }
  }

  if (requestedFields.quantiles) {
    for (const q of requestedFields.quantiles) {
      if (!dataset.quantiles?.includes(q)) {
        return { isValid: false, valid: false, error: `Quantile '${q}' is not supported in dataset '${datasetName}'.` };
      }
    }
  }

  if (requestedFields.max) {
    for (const m of requestedFields.max) {
      if (!dataset.max?.includes(m)) {
        return { isValid: false, valid: false, error: `Max metric '${m}' is not supported in dataset '${datasetName}'.` };
      }
    }
  }

  return { isValid: true, valid: true, error: null };
}
