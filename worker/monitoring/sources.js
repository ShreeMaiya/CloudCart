// CloudCart Monitoring - Metric Source Classification & Demo Mode Controller

export const METRIC_SOURCES = {
  CLOUDFLARE_NATIVE: "CLOUDFLARE_NATIVE",
  APPLICATION_INSTRUMENTED: "APPLICATION_INSTRUMENTED",
  CALCULATED: "CALCULATED",
  UNAVAILABLE: "UNAVAILABLE",
  DEMO: "DEMO"
};

/**
 * Determine if DEMO mode is explicitly enabled via environment variable.
 * Default is FALSE in production. Never enabled automatically.
 */
export function isDemoMode(env) {
  if (!env) return false;
  return env.MONITORING_DEMO_MODE === "true" || env.MONITORING_DEMO_MODE === true;
}

/**
 * Format a metric with explicit source metadata
 * @param {any} value - The metric value, or null if unavailable
 * @param {string} source - One of METRIC_SOURCES
 * @param {object} options - Optional metadata (reason, calculation, timestamp, unit)
 */
export function formatMetric(value, source, options = {}) {
  const metric = {
    value: value !== undefined ? value : null,
    source: source || (value === null ? METRIC_SOURCES.UNAVAILABLE : METRIC_SOURCES.APPLICATION_INSTRUMENTED),
    timestamp: options.timestamp || new Date().toISOString()
  };

  if (options.reason) {
    metric.reason = options.reason;
  }
  if (options.calculation) {
    metric.calculation = options.calculation;
  }
  if (options.unit) {
    metric.unit = options.unit;
  }

  return metric;
}
