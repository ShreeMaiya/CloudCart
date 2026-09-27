// CloudCart Monitoring - Cloudflare GraphQL Schema & Query Validator
// Validates datasets, dimensions, quantiles, and time filters prior to execution

export const SUPPORTED_DATASETS = {
  workersInvocationsAdaptive: {
    description: "Cloudflare Workers execution metrics (requests, errors, CPU, latency quantiles)",
    dimensions: ["datetimeFifteenMinutes", "datetimeHour", "scriptName", "status"],
    sums: ["requests", "errors", "subrequests"],
    quantiles: ["cpuTimeP50", "cpuTimeP95", "cpuTimeP99", "durationP50", "durationP95", "durationP99"],
    requiredFilter: ["accountTag", "datetime_geq", "datetime_leq", "scriptName"]
  },
  d1AnalyticsAdaptive: {
    description: "Cloudflare D1 SQL query execution, rows read/written, and query duration",
    dimensions: ["datetimeFifteenMinutes", "datetimeHour", "databaseId"],
    sums: ["readQueries", "writeQueries", "rowsRead", "rowsWritten"],
    quantiles: ["queryBatchTimeMsP50", "queryBatchTimeMsP95", "queryBatchTimeMsP99"],
    requiredFilter: ["accountTag", "datetime_geq", "datetime_leq", "databaseId"]
  },
  kvOperationsAdaptive: {
    description: "Cloudflare KV namespace operations by action (read, write, delete)",
    dimensions: ["datetimeFifteenMinutes", "datetimeHour", "action"],
    sums: ["requests"],
    quantiles: [],
    requiredFilter: ["accountTag", "datetime_geq", "datetime_leq", "namespaceId"]
  },
  durableObjectsInvocationsAdaptive: {
    description: "Cloudflare Durable Objects actor execution and resource consumption",
    dimensions: ["datetimeFifteenMinutes", "datetimeHour", "namespaceId"],
    sums: ["requests", "errors"],
    quantiles: ["cpuTimeP50", "cpuTimeP95", "durationP50", "durationP95"],
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
 * Validate that a query against a dataset uses only supported fields
 */
export function validateDatasetQuery(datasetName, requestedFields = {}) {
  const dataset = SUPPORTED_DATASETS[datasetName];
  if (!dataset) {
    return {
      isValid: false,
      error: `Dataset '${datasetName}' is not recognized or supported by CloudCart monitoring schema.`
    };
  }

  if (requestedFields.dimensions) {
    for (const dim of requestedFields.dimensions) {
      if (!dataset.dimensions.includes(dim)) {
        return { isValid: false, error: `Dimension '${dim}' is not supported in dataset '${datasetName}'.` };
      }
    }
  }

  if (requestedFields.sums) {
    for (const sum of requestedFields.sums) {
      if (!dataset.sums.includes(sum)) {
        return { isValid: false, error: `Sum metric '${sum}' is not supported in dataset '${datasetName}'.` };
      }
    }
  }

  if (requestedFields.quantiles) {
    for (const q of requestedFields.quantiles) {
      if (!dataset.quantiles.includes(q)) {
        return { isValid: false, error: `Quantile '${q}' is not supported in dataset '${datasetName}'.` };
      }
    }
  }

  return { isValid: true, error: null };
}
