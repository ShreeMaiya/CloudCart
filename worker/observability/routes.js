// Admin API for Cloudflare-native health, metrics, and short-retention logs.
// No observability data is written to D1/KV by this module.

const QUERY_CACHE_MS = 15_000;
const ACCOUNT_METRICS_CACHE_MS = 60_000;
const QUERY_TIMEOUT_MS = 8_000;
const queryCache = new Map();
const probeCache = { at: 0, services: null };

const RANGES = { "15m": 15, "1h": 60, "6h": 360, "24h": 1440, "7d": 10080 };

function response(data, status = 200, request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = env?.ALLOWED_ORIGIN || new URL(request.url).origin;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
  if (!origin || origin === allowedOrigin) headers["Access-Control-Allow-Origin"] = origin || allowedOrigin;
  return new Response(status === 204 ? null : JSON.stringify(data), { status, headers });
}

function rangeWindow(range, bucketMs = QUERY_CACHE_MS) {
  const minutes = RANGES[range] || RANGES["1h"];
  const to = Math.floor(Date.now() / bucketMs) * bucketMs;
  return { from: to - minutes * 60_000, to };
}

function cached(key, ttl = QUERY_CACHE_MS) {
  const item = queryCache.get(key);
  if (item && Date.now() - item.at < ttl) return item.value;
  if (item) queryCache.delete(key);
  return null;
}

function saveCache(key, value) {
  if (queryCache.size > 30) queryCache.delete(queryCache.keys().next().value);
  queryCache.set(key, { at: Date.now(), value });
  return value;
}

function cloudflareApiError(service, response, body) {
  if (response.status === 401 || response.status === 403) {
    return `Cloudflare rejected the API token for ${service} (HTTP ${response.status}). Add the required Workers Observability Write and Account Analytics Read permissions to the existing CLOUDFLARE_API_TOKEN, then rerun deployment.`;
  }
  return body?.errors?.map(e => e.message).join("; ") || `Cloudflare ${service} returned HTTP ${response.status}.`;
}

async function cloudflareQuery(env, { view, range, limit, parameters = {} }) {
  if (!env.CF_ACCOUNT_ID || !env.CF_OBSERVABILITY_API_TOKEN) {
    return { configured: false, error: "Set CF_ACCOUNT_ID and CF_OBSERVABILITY_API_TOKEN Worker secrets to enable Cloudflare telemetry." };
  }
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
  const key = JSON.stringify({ view, range, safeLimit, parameters });
  const hit = cached(key);
  if (hit) return hit;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/workers/observability/telemetry/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.CF_OBSERVABILITY_API_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        queryId: `cloudcart-live-${view}`,
        timeframe: rangeWindow(range),
        view,
        limit: safeLimit,
        ignoreSeries: true,
        parameters: { datasets: ["cloudflare-workers"], ...parameters }
      }),
      signal: controller.signal
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.success === false || body?.errors?.length) {
      return { configured: true, error: cloudflareApiError("Observability API", res, body), status: res.status };
    }
    return saveCache(key, { configured: true, data: body?.result || body?.data || null, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return { configured: true, error: err.name === "AbortError" ? "Cloudflare telemetry query timed out." : "Cloudflare telemetry API is unavailable." };
  } finally {
    clearTimeout(timer);
  }
}

async function cloudflareProjectMetrics(env, range) {
  if (!env.CF_ACCOUNT_ID || !env.CF_OBSERVABILITY_API_TOKEN) return { configured: false, error: "Cloudflare project metrics are not configured." };
  const window = rangeWindow(range, ACCOUNT_METRICS_CACHE_MS);
  const start = new Date(window.from);
  const end = new Date(window.to);
  const variables = {
    accountTag: env.CF_ACCOUNT_ID,
    datetimeStart: start.toISOString(),
    datetimeEnd: end.toISOString(),
    dateStart: start.toISOString().slice(0, 10),
    dateEnd: end.toISOString().slice(0, 10),
    scriptName: env.CF_WORKER_NAME || "cloudcart-worker",
    databaseId: env.CF_D1_DATABASE_ID || "",
    kvNamespaceId: env.CF_KV_NAMESPACE_ID || ""
  };
  const cacheKey = `graphql:${JSON.stringify(variables)}`;
  const hit = cached(cacheKey, ACCOUNT_METRICS_CACHE_MS);
  if (hit) return hit;
  const kvFields = variables.kvNamespaceId ? `kvOperationsAdaptiveGroups(limit: 1000, filter: { date_geq: $dateStart, date_leq: $dateEnd, namespaceId: $kvNamespaceId }) { sum { requests } quantiles { latencyMsP50 latencyMsP90 latencyMsP99 } dimensions { date actionType } } kvStorageAdaptiveGroups(limit: 100, filter: { date_geq: $dateStart, date_leq: $dateEnd, namespaceId: $kvNamespaceId }) { max { keyCount byteCount } dimensions { date } }` : "";
  const query = `query CloudCartOperationalMetrics($accountTag: string!, $datetimeStart: string, $datetimeEnd: string, $dateStart: Date, $dateEnd: Date, $scriptName: string, $databaseId: string, $kvNamespaceId: string) { viewer { accounts(filter: { accountTag: $accountTag }) { workersInvocationsAdaptive(limit: 1000, filter: { scriptName: $scriptName, datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd }) { sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 } dimensions { datetime } } d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: $dateStart, date_leq: $dateEnd, databaseId: $databaseId }) { sum { readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes } quantiles { queryBatchTimeMsP90 } dimensions { date } } d1StorageAdaptiveGroups(limit: 100, filter: { date_geq: $dateStart, date_leq: $dateEnd, databaseId: $databaseId }) { max { databaseSizeBytes } dimensions { date } } ${kvFields} durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { date_geq: $dateStart, date_leq: $dateEnd, scriptName: $scriptName }) { sum { requests responseBodySize } dimensions { date } } } } }`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.CF_OBSERVABILITY_API_TOKEN}`, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.errors?.length) return { configured: true, error: cloudflareApiError("GraphQL Analytics API", res, body), status: res.status };
    return saveCache(cacheKey, {
      configured: true,
      data: body?.data?.viewer?.accounts?.[0] || null,
      d1DatabaseConfigured: Boolean(variables.databaseId && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(variables.databaseId)),
      kvNamespaceConfigured: Boolean(variables.kvNamespaceId),
      dateCoverage: `D1, KV, and Durable Object analytics are UTC-day aggregates (${variables.dateStart} through ${variables.dateEnd}); a short time-range selection still includes the full UTC day. Cloudflare may delay analytics updates.`,
      fetchedAt: new Date().toISOString()
    });
  } catch {
    return { configured: true, error: "Cloudflare GraphQL Analytics API is unavailable." };
  } finally {
    clearTimeout(timer);
  }
}

// Returns the result object when it contains an error, null otherwise.
function getTelemetryError(result) {
  return result?.error ? result : null;
}

function healthSnapshot(env, request) {
  const configured = Boolean(env?.CF_ACCOUNT_ID && env?.CF_OBSERVABILITY_API_TOKEN);
  const requestUrl = new URL(request.url);
  let allowedUrl = null;
  try { if (env?.ALLOWED_ORIGIN) allowedUrl = new URL(env.ALLOWED_ORIGIN); } catch { /* Invalid optional origin does not break health reporting. */ }
  const pagesPathObserved = requestUrl.hostname.endsWith(".pages.dev") || Boolean(allowedUrl && requestUrl.origin === allowedUrl.origin);
  const services = [
    { id: "pages", name: "Cloudflare Pages", tier: "Frontend", status: pagesPathObserved ? "HEALTHY" : "UNKNOWN", signal: pagesPathObserved ? "Current Pages-hosted request" : "No Pages-hosted request observed", detail: pagesPathObserved ? "The static dashboard loaded and its API request reached this Worker." : "A direct Worker request cannot verify Pages availability." },
    { id: "pages_functions", name: "Pages Functions / Service Binding", tier: "Proxy", status: pagesPathObserved ? "HEALTHY" : "UNKNOWN", signal: pagesPathObserved ? "Current proxied API request" : "No Pages-hosted request observed", detail: pagesPathObserved ? "The observability API request passed through the Pages Function and service binding." : "A direct Worker request cannot verify the Pages proxy." },
    { id: "worker", name: "CloudCart Worker", tier: "API", status: "HEALTHY", signal: "Current request", detail: "The Worker is serving this health response." },
    { id: "d1", name: "Cloudflare D1", tier: "Database", status: "UNKNOWN", signal: "Not actively probed", detail: "Use Run health check to issue one SELECT 1 probe." },
    { id: "kv", name: "Cloudflare KV", tier: "Storage", status: "UNKNOWN", signal: "Not actively probed", detail: "Use Run health check to issue one KV read." },
    { id: "inventory_do", name: "Inventory Durable Object", tier: "Durable Object", status: "UNKNOWN", signal: "Not actively probed", detail: "Use Run health check to invoke the InventoryDO health endpoint." },
    { id: "cloudflare_telemetry", name: "Cloudflare Observability API", tier: "Telemetry", status: configured ? "UNKNOWN" : "NOT_CONFIGURED", signal: configured ? "Not queried yet" : "Missing secrets", detail: configured ? "Native logs are queried on demand." : "Configure CF_ACCOUNT_ID and CF_OBSERVABILITY_API_TOKEN." }
  ];
  if (probeCache.services && Date.now() - probeCache.at < 30_000) {
    for (const probed of probeCache.services) {
      const index = services.findIndex(service => service.id === probed.id);
      if (index >= 0) services[index] = { ...probed, cached: true, signal: "Recent active probe", checkedAt: new Date(probeCache.at).toISOString() };
    }
  }
  return services;
}

async function probeDependencies(env) {
  if (probeCache.services && Date.now() - probeCache.at < 30_000) {
    return probeCache.services.map(s => ({ ...s, cached: true, checkedAt: new Date(probeCache.at).toISOString() }));
  }
  const checks = [
    (async () => {
      if (!env?.DB) return { id: "d1", name: "Cloudflare D1", tier: "Database", status: "NOT_CONFIGURED", detail: "DB binding is missing." };
      const start = performance.now();
      try {
        const result = await env.DB.prepare("SELECT 1 AS ok").first();
        return { id: "d1", name: "Cloudflare D1", tier: "Database", status: result?.ok === 1 ? "HEALTHY" : "DEGRADED", latencyMs: Math.round(performance.now() - start), checkedAt: new Date().toISOString(), detail: "One explicit SELECT 1 probe." };
      } catch { return { id: "d1", name: "Cloudflare D1", tier: "Database", status: "DOWN", latencyMs: Math.round(performance.now() - start), checkedAt: new Date().toISOString(), detail: "D1 probe failed." }; }
    })(),
    (async () => {
      if (!env?.CLOUDCART_KV) return { id: "kv", name: "Cloudflare KV", tier: "Storage", status: "NOT_CONFIGURED", detail: "CLOUDCART_KV binding is missing." };
      const start = performance.now();
      try {
        await env.CLOUDCART_KV.get("__cloudcart_health_probe_v1");
        return { id: "kv", name: "Cloudflare KV", tier: "Storage", status: "HEALTHY", latencyMs: Math.round(performance.now() - start), checkedAt: new Date().toISOString(), detail: "One explicit KV read probe (counts toward KV read quota)." };
      } catch { return { id: "kv", name: "Cloudflare KV", tier: "Storage", status: "DOWN", latencyMs: Math.round(performance.now() - start), checkedAt: new Date().toISOString(), detail: "KV probe failed." }; }
    })(),
    (async () => {
      if (!env?.INVENTORY_DO) return { id: "inventory_do", name: "Inventory Durable Object", tier: "Durable Object", status: "NOT_CONFIGURED", detail: "INVENTORY_DO binding is missing." };
      const start = performance.now();
      try {
        const stub = env.INVENTORY_DO.get(env.INVENTORY_DO.idFromName("cloudcart-inventory-global"));
        const res = await stub.fetch("http://do/health-ping");
        return { id: "inventory_do", name: "Inventory Durable Object", tier: "Durable Object", status: res.ok ? "HEALTHY" : "DEGRADED", latencyMs: Math.round(performance.now() - start), checkedAt: new Date().toISOString(), detail: `Explicit health invocation returned HTTP ${res.status}.` };
      } catch { return { id: "inventory_do", name: "Inventory Durable Object", tier: "Durable Object", status: "DOWN", latencyMs: Math.round(performance.now() - start), checkedAt: new Date().toISOString(), detail: "Durable Object health invocation failed." }; }
    })()
  ];
  const results = await Promise.all(checks);
  probeCache.at = Date.now();
  probeCache.services = results;
  return results;
}

// Aggregate raw Cloudflare GraphQL group arrays into a single summary object.
// Only fields that genuinely come from the API are included; absent data is null.
function aggregateMetrics(groups) {
  const workerRows = groups?.workersInvocationsAdaptive || [];
  const d1Rows = groups?.d1AnalyticsAdaptiveGroups || [];
  const d1StorageRows = groups?.d1StorageAdaptiveGroups || [];
  const kvRows = groups?.kvOperationsAdaptiveGroups || [];
  const doRows = groups?.durableObjectsInvocationsAdaptiveGroups || [];

  const sumField = (rows, key) =>
    rows.length ? rows.reduce((total, row) => total + (Number(row?.sum?.[key]) || 0), 0) : null;
  const latestRow = rows =>
    rows.length
      ? [...rows].sort((a, b) =>
          String(b?.dimensions?.date || b?.dimensions?.datetime || "").localeCompare(
            String(a?.dimensions?.date || a?.dimensions?.datetime || "")
          )
        )[0]
      : null;

  // Workers — real-time invocation analytics from Cloudflare Workers Observability
  const workerLatest = latestRow(workerRows);
  const worker = workerRows.length
    ? {
        requests:        sumField(workerRows, "requests"),
        errors:          sumField(workerRows, "errors"),
        subrequests:     sumField(workerRows, "subrequests"),
        cpuTimeP50Ms:    workerLatest?.quantiles?.cpuTimeP50 ?? null,
        cpuTimeP99Ms:    workerLatest?.quantiles?.cpuTimeP99 ?? null,
        wallTimeP50Ms:   workerLatest?.quantiles?.wallTimeP50 ?? null,
        wallTimeP99Ms:   workerLatest?.quantiles?.wallTimeP99 ?? null
      }
    : null;

  // D1 — UTC-day aggregate analytics from Cloudflare D1 Analytics API
  const d1Latest = latestRow(d1Rows);
  const d1StorageLatest = latestRow(d1StorageRows);
  const d1 = d1Rows.length
    ? {
        readQueries:             sumField(d1Rows, "readQueries"),
        writeQueries:            sumField(d1Rows, "writeQueries"),
        rowsRead:                sumField(d1Rows, "rowsRead"),
        rowsWritten:             sumField(d1Rows, "rowsWritten"),
        queryBatchResponseBytes: sumField(d1Rows, "queryBatchResponseBytes"),
        queryBatchTimeMsP90:     d1Latest?.quantiles?.queryBatchTimeMsP90 ?? null,
        latestDate:              d1Latest?.dimensions?.date ?? null,
        databaseSizeBytes:       d1StorageLatest?.max?.databaseSizeBytes ?? null,
        storageSampleDate:       d1StorageLatest?.dimensions?.date ?? null
      }
    : null;

  // KV — UTC-day aggregate analytics filtered by KV namespace ID
  const kvByAction = actionType =>
    kvRows
      .filter(row => String(row?.dimensions?.actionType || "").toLowerCase() === actionType)
      .reduce((total, row) => total + (Number(row?.sum?.requests) || 0), 0);
  const kv = kvRows.length
    ? {
        totalRequests: sumField(kvRows, "requests"),
        reads:         kvByAction("read"),
        writes:        kvByAction("write"),
        deletes:       kvByAction("delete"),
        lists:         kvByAction("list"),
        latencyP50Ms:  latestRow(kvRows)?.quantiles?.latencyMsP50 ?? null,
        latencyP90Ms:  latestRow(kvRows)?.quantiles?.latencyMsP90 ?? null,
        latencyP99Ms:  latestRow(kvRows)?.quantiles?.latencyMsP99 ?? null
      }
    : null;

  // Durable Objects — UTC-day aggregate analytics filtered by Worker script name
  const durableObjects = doRows.length
    ? {
        requests:          sumField(doRows, "requests"),
        responseBodyBytes: sumField(doRows, "responseBodySize")
      }
    : null;

  return { worker, d1, kv, durableObjects };
}

export async function handleObservabilityRoute(request, env, _ctx, path, url) {
  if (!path.startsWith("/api/observability")) return null;
  if (request.method === "OPTIONS") return response(null, 204, request, env);

  if (path === "/api/observability/health" && request.method === "GET") {
    const shouldProbe = url.searchParams.get("probe") === "1";
    const snapshot = healthSnapshot(env, request);
    // Await fresh probe results FIRST so the final services array is always up-to-date.
    let services = snapshot;
    if (shouldProbe) {
      const activeResults = await probeDependencies(env);
      services = snapshot.map(s => {
        const probed = activeResults.find(r => r.id === s.id);
        return probed ?? s;
      });
    }
    const statuses = services.map(s => s.status);
    const overallStatus = statuses.includes("DOWN") ? "DOWN" : statuses.includes("DEGRADED") ? "DEGRADED" : statuses.includes("UNKNOWN") || statuses.includes("NOT_CONFIGURED") ? "UNKNOWN" : "HEALTHY";
    return response({ success: true, data: { overallStatus, timestamp: new Date().toISOString(), probe: shouldProbe, services } }, 200, request, env);
  }

  if (path === "/api/observability/logs" && request.method === "GET") {
    // Returns Worker invocations grouped by request ID. Each invocation includes
    // its trace/span IDs (requires observability.traces = true in wrangler.toml).
    const result = await cloudflareQuery(env, { view: "invocations", range: url.searchParams.get("range"), limit: url.searchParams.get("limit"), parameters: { datasets: ["cloudflare-workers"] } });
    if (getTelemetryError(result)) return response({ success: false, error: result.error, configured: result.configured }, result.configured ? 502 : 503, request, env);
    return response({ success: true, data: result }, 200, request, env);
  }

  if (path === "/api/observability/metrics" && request.method === "GET") {
    const selectedRange = url.searchParams.get("range");
    const projectMetrics = await cloudflareProjectMetrics(env, selectedRange);
    if (getTelemetryError(projectMetrics)) {
      return response({ success: false, error: projectMetrics.error, configured: projectMetrics.configured }, projectMetrics.configured ? 502 : 503, request, env);
    }
    // summary contains only fields that are genuinely populated from Cloudflare APIs.
    // Absent data (unconfigured service, no rows for range) is explicitly null — never fabricated.
    const summary = aggregateMetrics(projectMetrics.data);
    return response({
      success: true,
      data: {
        projectMetrics,
        summary
      },
      fetchedAt: new Date().toISOString()
    }, 200, request, env);
  }

  if (path === "/api/observability/probe" && request.method === "POST") {
    return response({ success: true, data: { services: await probeDependencies(env), cachedForSeconds: 30 } }, 200, request, env);
  }

  return response({ success: false, error: "Observability route not found." }, 404, request, env);
}
