// CloudCart Telemetry & Observability Engine
// Zero-dependency, edge-native telemetry buffer & metrics collector

const MAX_LOGS = 200;
const MAX_ERRORS = 50;
const MAX_LATENCIES = 150;
const MAX_INVENTORY_EVENTS = 50;
const START_TIME = Date.now();

class TelemetryStore {
  constructor() {
    this.reset();
  }

  reset() {
    this.totalRequests = 0;
    this.statusCodes = {};
    this.statusGroups = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    this.totalDurationMs = 0;
    this.latencies = []; // rolling recent latency numbers
    this.endpoints = {}; // path -> count
    this.methods = {};   // method -> count
    this.edgeColos = {}; // colo -> count
    this.logs = [];      // recent request logs ring-buffer
    this.errors = [];    // recent exceptions
    this.checkoutStats = {
      attempts: 0,
      success: 0,
      failed: 0,
      failureReasons: {}
    };
    this.inventoryEvents = [];
    this.timeBuckets = {}; // minute-by-minute request & error counters
  }

  recordRequest({
    requestId,
    method,
    path,
    status,
    durationMs,
    clientIp,
    colo,
    country,
    userAgent,
    cfRay,
    errorMessage = null,
    errorStack = null
  }) {
    this.totalRequests++;
    this.totalDurationMs += durationMs;

    // Rolling latency buffer
    this.latencies.push(durationMs);
    if (this.latencies.length > MAX_LATENCIES) {
      this.latencies.shift();
    }

    // Status code grouping
    this.statusCodes[status] = (this.statusCodes[status] || 0) + 1;
    const group = `${Math.floor(status / 100)}xx`;
    if (this.statusGroups[group] !== undefined) {
      this.statusGroups[group]++;
    }

    // Endpoints & methods
    // Normalize path to prevent query param explosion
    const cleanPath = path.split('?')[0];
    this.endpoints[cleanPath] = (this.endpoints[cleanPath] || 0) + 1;
    this.methods[method] = (this.methods[method] || 0) + 1;

    // Cloudflare Edge Colocation
    const resolvedColo = colo || 'LOCAL';
    this.edgeColos[resolvedColo] = (this.edgeColos[resolvedColo] || 0) + 1;

    // Time bucket for time-series charts (1-minute resolution)
    const minuteBucket = new Date().toISOString().substring(0, 16); // "YYYY-MM-DDTHH:mm"
    if (!this.timeBuckets[minuteBucket]) {
      this.timeBuckets[minuteBucket] = { requests: 0, errors: 0, totalDuration: 0 };
      // Keep only last 60 minutes
      const keys = Object.keys(this.timeBuckets);
      if (keys.length > 60) {
        delete this.timeBuckets[keys[0]];
      }
    }
    this.timeBuckets[minuteBucket].requests++;
    this.timeBuckets[minuteBucket].totalDuration += durationMs;
    if (status >= 400) {
      this.timeBuckets[minuteBucket].errors++;
    }

    // Determine log level
    let level = 'INFO';
    if (status >= 400 && status < 500) level = 'WARN';
    if (status >= 500 || errorStack) level = 'ERROR';

    const logEntry = {
      id: requestId,
      timestamp: new Date().toISOString(),
      method,
      path,
      status,
      durationMs: Math.round(durationMs * 10) / 10,
      level,
      clientIp: clientIp ? clientIp.replace(/(\.\d+)$/, '.xxx') : '127.0.0.1', // privacy mask
      colo: resolvedColo,
      country: country || 'XX',
      userAgent: userAgent ? userAgent.substring(0, 80) : '',
      cfRay: cfRay || `local-${requestId}`,
      errorMessage,
      errorStack
    };

    // Insert into logs ring-buffer (latest first)
    this.logs.unshift(logEntry);
    if (this.logs.length > MAX_LOGS) {
      this.logs.pop();
    }

    // Record error separately if applicable
    if (level === 'ERROR') {
      this.errors.unshift(logEntry);
      if (this.errors.length > MAX_ERRORS) {
        this.errors.pop();
      }
    }
  }

  recordCheckoutEvent(success, reason = null, metadata = {}) {
    this.checkoutStats.attempts++;
    if (success) {
      this.checkoutStats.success++;
    } else {
      this.checkoutStats.failed++;
      const r = reason || 'Unknown failure';
      this.checkoutStats.failureReasons[r] = (this.checkoutStats.failureReasons[r] || 0) + 1;
    }
  }

  recordInventoryEvent(event) {
    this.inventoryEvents.unshift({
      id: 'inv-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      timestamp: new Date().toISOString(),
      ...event
    });
    if (this.inventoryEvents.length > MAX_INVENTORY_EVENTS) {
      this.inventoryEvents.pop();
    }
  }

  getPercentiles() {
    if (this.latencies.length === 0) {
      return { p50: 0, p90: 0, p95: 0, p99: 0, avg: 0 };
    }
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const getP = (p) => {
      const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
      return Math.round(sorted[idx] * 10) / 10;
    };
    const avg = Math.round((this.totalDurationMs / Math.max(this.totalRequests, 1)) * 10) / 10;

    return {
      avg,
      p50: getP(50),
      p90: getP(90),
      p95: getP(95),
      p99: getP(99)
    };
  }

  getSummary(doActiveConnections = 0) {
    const uptimeSec = Math.floor((Date.now() - START_TIME) / 1000);
    const total4xx = this.statusGroups['4xx'] || 0;
    const total5xx = this.statusGroups['5xx'] || 0;
    const totalErrors = total4xx + total5xx;
    const errorRate = this.totalRequests > 0
      ? Math.round((totalErrors / this.totalRequests) * 10000) / 100
      : 0;

    // Format time series for chart (last 20 buckets)
    const timeSeries = Object.entries(this.timeBuckets).map(([minute, data]) => ({
      time: minute.substring(11), // "HH:mm"
      requests: data.requests,
      errors: data.errors,
      avgLatency: data.requests > 0 ? Math.round(data.totalDuration / data.requests) : 0
    }));

    return {
      uptimeSeconds: uptimeSec,
      startedAt: new Date(START_TIME).toISOString(),
      serverTimestamp: new Date().toISOString(),
      totalRequests: this.totalRequests,
      errorRate,
      statusGroups: this.statusGroups,
      statusCodes: this.statusCodes,
      latencies: this.getPercentiles(),
      topEndpoints: Object.entries(this.endpoints)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([path, count]) => ({ path, count })),
      edgeColos: this.edgeColos,
      checkoutStats: this.checkoutStats,
      activeDoConnections: doActiveConnections,
      recentErrorsCount: this.errors.length,
      timeSeries
    };
  }

  getLogs({ limit = 50, level = 'ALL', status = null, search = '' }) {
    let result = this.logs;

    if (level && level !== 'ALL') {
      result = result.filter(l => l.level === level.toUpperCase());
    }

    if (status) {
      if (status.endsWith('xx')) {
        const prefix = status.substring(0, 1);
        result = result.filter(l => String(l.status).startsWith(prefix));
      } else {
        result = result.filter(l => l.status === parseInt(status, 10));
      }
    }

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(l =>
        l.path.toLowerCase().includes(q) ||
        l.method.toLowerCase().includes(q) ||
        (l.errorMessage && l.errorMessage.toLowerCase().includes(q)) ||
        l.colo.toLowerCase().includes(q) ||
        l.cfRay.toLowerCase().includes(q)
      );
    }

    return result.slice(0, Math.min(limit, MAX_LOGS));
  }

  getInventoryEvents(limit = 20) {
    return this.inventoryEvents.slice(0, limit);
  }
}

// Global Singleton instance in Worker memory
export const telemetry = new TelemetryStore();

// Synthetic Health Probe Runner
export async function runSyntheticProbe(env) {
  const results = {
    timestamp: new Date().toISOString(),
    overall: "HEALTHY",
    checks: {}
  };

  // 1. Probe Worker Self-check
  const workerStart = performance.now();
  results.checks.worker = {
    status: "HEALTHY",
    latencyMs: Math.round(performance.now() - workerStart)
  };

  // 2. Probe D1 Database
  if (env.DB) {
    const d1Start = performance.now();
    try {
      const test = await env.DB.prepare("SELECT 1 as ping").first();
      results.checks.d1 = {
        status: test?.ping === 1 ? "HEALTHY" : "DEGRADED",
        latencyMs: Math.round((performance.now() - d1Start) * 10) / 10,
        message: "D1 SQLite query successful"
      };
    } catch (err) {
      results.checks.d1 = {
        status: "FAILED",
        latencyMs: Math.round((performance.now() - d1Start) * 10) / 10,
        error: err.message
      };
      results.overall = "DEGRADED";
    }
  } else {
    results.checks.d1 = { status: "UNAVAILABLE", message: "Binding not found" };
  }

  // 3. Probe Cloudflare KV
  if (env.CLOUDCART_KV) {
    const kvStart = performance.now();
    try {
      await env.CLOUDCART_KV.put("ops:ping", "pong", { expirationTtl: 60 });
      const readVal = await env.CLOUDCART_KV.get("ops:ping");
      results.checks.kv = {
        status: readVal === "pong" ? "HEALTHY" : "DEGRADED",
        latencyMs: Math.round((performance.now() - kvStart) * 10) / 10,
        message: "KV read & write verified"
      };
    } catch (err) {
      results.checks.kv = {
        status: "FAILED",
        latencyMs: Math.round((performance.now() - kvStart) * 10) / 10,
        error: err.message
      };
      results.overall = "DEGRADED";
    }
  } else {
    results.checks.kv = { status: "UNAVAILABLE", message: "Binding not found" };
  }

  // 4. Probe Durable Object
  if (env.INVENTORY_DO) {
    const doStart = performance.now();
    try {
      const doId = env.INVENTORY_DO.idFromName("cloudcart-inventory-global");
      const doStub = env.INVENTORY_DO.get(doId);
      const res = await doStub.fetch("http://do/health");
      const data = await res.json();
      results.checks.durableObject = {
        status: data.status === "OK" ? "HEALTHY" : "DEGRADED",
        latencyMs: Math.round((performance.now() - doStart) * 10) / 10,
        activeConnections: data.activeConnections || 0,
        message: "DO cluster responsive"
      };
    } catch (err) {
      results.checks.durableObject = {
        status: "FAILED",
        latencyMs: Math.round((performance.now() - doStart) * 10) / 10,
        error: err.message
      };
      results.overall = "DEGRADED";
    }
  } else {
    results.checks.durableObject = { status: "UNAVAILABLE", message: "Binding not found" };
  }

  return results;
}
