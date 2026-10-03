// CloudCart Monitoring & Observability — Accuracy, Integrity & Regression Test Suite
import http from "node:http";

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";

console.log(`\n======================================================`);
console.log(`⚡ CloudCart Monitoring & Observability Verification Suite`);
console.log(`   Target: ${BASE_URL}`);
console.log(`   Verification: Zero fake metrics & honest source classification`);
console.log(`======================================================\n`);

async function fetchJson(path, options = {}) {
  const start = performance.now();
  const res = await fetch(`${BASE_URL}${path}`, options);
  const durationMs = performance.now() - start;
  const requestId = res.headers.get("X-Request-ID");
  let json = null;
  try {
    json = await res.json();
  } catch (_) {}
  return { status: res.status, headers: res.headers, requestId, json, durationMs };
}

let passed = 0;
let failed = 0;

function assert(condition, testName, details = "") {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${testName}: ${details}`);
    failed++;
  }
}

const VALID_SOURCES = [
  "CLOUDFLARE_NATIVE",
  "APPLICATION_INSTRUMENTED",
  "APPLICATION_PROBE",
  "CALCULATED",
  "UNAVAILABLE",
  "DEMO",
  "GITHUB_ACTIONS"
];

function isValidSource(source) {
  return VALID_SOURCES.includes(source);
}

async function runTests() {
  console.log(`--- [Group 1: Health Probes & Metric Honesty] ---`);
  {
    const r = await fetchJson("/api/health");
    assert(r.status === 200 && r.json?.status === "OK", "GET /api/health returns 200 OK");
    assert(!!r.requestId, "Response carries X-Request-ID header", `Received: ${r.requestId}`);
  }

  {
    const r = await fetchJson("/api/monitoring/health");
    assert(r.status === 200 && r.json?.success === true, "GET /api/monitoring/health returns success: true");
    assert(Array.isArray(r.json?.data?.services), "Subsystem services array is present", `Count: ${r.json?.data?.services?.length}`);
    
    // Check D1 SQLite probe
    const d1Svc = r.json?.data?.services?.find(s => s.id === "d1");
    assert(d1Svc && d1Svc.status === "HEALTHY", "D1 SQLite active probe succeeds (SELECT 1 as alive)");
    assert(d1Svc && d1Svc.source === "APPLICATION_PROBE", "D1 probe source classified as APPLICATION_PROBE");
    assert(typeof d1Svc.responseTimeMs === "number", `D1 probe response time is measured (${d1Svc.responseTimeMs}ms)`);

    // Check Pages probe honesty
    const pagesSvc = r.json?.data?.services?.find(s => s.id === "pages");
    assert(pagesSvc && pagesSvc.status === "UNKNOWN", "Pages status honestly classified as UNKNOWN (not fake HEALTHY)");
    assert(pagesSvc && pagesSvc.responseTimeMs === null, "Pages response time is null (not hardcoded 8ms)");
    assert(pagesSvc && pagesSvc.source === "UNAVAILABLE", "Pages source classified as UNAVAILABLE");

    // Check Pages Functions probe honesty
    const pfSvc = r.json?.data?.services?.find(s => s.id === "pages_functions");
    assert(pfSvc && pfSvc.status === "UNKNOWN", "Pages Functions status honestly classified as UNKNOWN");
    assert(pfSvc && pfSvc.responseTimeMs === null, "Pages Functions response time is null (not hardcoded 2ms)");
  }

  {
    const r = await fetchJson("/api/monitoring/services");
    assert(r.status === 200 && r.json?.data?.services?.length >= 5, "GET /api/monitoring/services returns all architectural tiers");
    const hasZeroLatency = r.json?.data?.services?.some(s => JSON.stringify(s).toLowerCase().includes("zero-latency"));
    assert(!hasZeroLatency, "Zero-latency IPC claims removed from service descriptions (Section 12)");
  }

  {
    const r = await fetchJson("/api/monitoring/overview?range=1h");
    assert(r.status === 200, "GET /api/monitoring/overview returns 200 OK");
    const main = r.json?.data?.mainMetrics;
    assert(main && isValidSource(main.totalRequests?.source), `totalRequests source is classified (${main?.totalRequests?.source})`);
    assert(main && isValidSource(main.workerCpuTimeMs?.source), `workerCpuTimeMs source is classified (${main?.workerCpuTimeMs?.source})`);
  }

  console.log(`\n--- [Group 2: API Telemetry & Source Classification] ---`);
  {
    const r = await fetchJson("/api/monitoring/api?range=1h");
    assert(r.status === 200 && r.json?.data?.summary?.totalRequests !== undefined, "GET /api/monitoring/api returns summary");
    assert(isValidSource(r.json?.data?.source), `API telemetry data source is classified (${r.json?.data?.source})`);
    
    // Check that percentiles return null or valid numbers, not hardcoded defaults
    const summary = r.json?.data?.summary;
    assert(summary?.overallP95?.value === null || typeof summary?.overallP95?.value === "number", "Overall P95 is number or null (no fake fallback 35)");
  }

  {
    const r = await fetchJson("/api/monitoring/performance?range=1h");
    assert(r.status === 200, "GET /api/monitoring/performance returns 200 OK");
    assert(isValidSource(r.json?.data?.source), `Performance source is classified (${r.json?.data?.source})`);
    if (r.json?.data?.source === "UNAVAILABLE") {
      assert(r.json?.data?.reason !== undefined, "Reason provided when Cloudflare GraphQL is unavailable");
    }
  }

  console.log(`\n--- [Group 3: D1, KV, Durable Objects & WebSocket Telemetry] ---`);
  {
    const r = await fetchJson("/api/monitoring/d1");
    assert(r.status === 200 && r.json?.data?.tables?.length >= 3, "GET /api/monitoring/d1 returns live table rows (products, orders, feedback)");
    assert(r.json?.data?.applicationTelemetry?.totalQueries?.source === "APPLICATION_INSTRUMENTED", "D1 query counters labeled APPLICATION_INSTRUMENTED");
    
    // Section 10: Validate no fake indexes reported
    const prodTable = r.json?.data?.tables?.find(t => t.table === "products");
    const hasFakeIndex = prodTable?.indexes?.some(idx => idx.includes("idx_products_category") || idx.includes("idx_products_active"));
    assert(!hasFakeIndex, "No fabricated indexes (idx_products_category/active) reported for products table (Section 10)");
    assert(prodTable?.indexes?.length > 0, `Products table indexes confirmed from schema: ${prodTable?.indexes?.join(', ')}`);
  }

  {
    const r = await fetchJson("/api/monitoring/kv");
    assert(r.status === 200 && r.json?.data?.status === "HEALTHY", "GET /api/monitoring/kv reports operational cache");
    assert(r.json?.data?.applicationTelemetry?.totalOperations?.source === "APPLICATION_INSTRUMENTED", "KV operations labeled APPLICATION_INSTRUMENTED");
    assert(r.json?.data?.trends?.activeSessionCartsEstimate === undefined, "Fabricated activeSessionCartsEstimate removed");
  }

  {
    const r = await fetchJson("/api/monitoring/durable-objects");
    assert(r.status === 200 && r.json?.data?.applicationInstrumented?.activeConnections !== undefined, "GET /api/monitoring/durable-objects returns live actor state");
    assert(r.json?.data?.applicationInstrumented?.activeConnections?.source === "APPLICATION_INSTRUMENTED", "DO active connections classified as APPLICATION_INSTRUMENTED");
  }

  {
    const r = await fetchJson("/api/monitoring/websocket");
    assert(r.status === 200 && r.json?.data?.protocol === "wss", "GET /api/monitoring/websocket returns synchronization telemetry");
  }

  console.log(`\n--- [Group 4: Centralized Logs & Security Sanitization] ---`);
  {
    const r = await fetchJson("/api/monitoring/logs?limit=10");
    assert(r.status === 200 && Array.isArray(r.json?.data?.logs), "GET /api/monitoring/logs returns structured log entries");
    assert(isValidSource(r.json?.data?.source), `Logs source is classified (${r.json?.data?.source})`);
  }

  console.log(`\n--- [Group 5: Distributed Tracing & Waterfall Integrity] ---`);
  {
    const r = await fetchJson("/api/monitoring/traces?limit=10");
    assert(r.status === 200 && Array.isArray(r.json?.data?.traces), "GET /api/monitoring/traces returns trace list");
    assert(isValidSource(r.json?.data?.source), `Traces source is classified (${r.json?.data?.source})`);

    if (r.json?.data?.traces?.length > 0) {
      const firstTrace = r.json.data.traces[0];
      const single = await fetchJson(`/api/monitoring/traces/${firstTrace.traceId}`);
      assert(single.status === 200 && single.json?.data?.spans?.length > 0, `GET /api/monitoring/traces/${firstTrace.traceId} returns honest spans`);
      
      // Verify unmeasured spans have duration null
      const pagesSpan = single.json?.data?.spans?.find(s => s.service.includes("Pages"));
      if (pagesSpan) {
        assert(pagesSpan.durationMs === null, "Unmeasured Pages edge hop duration is null (no fake percentage)");
        assert(pagesSpan.source === "UNAVAILABLE", "Unmeasured Pages hop marked UNAVAILABLE");
      }
    }
  }

  console.log(`\n--- [Group 6: CI/CD Deployments & Business Correlation] ---`);
  {
    const r = await fetchJson("/api/monitoring/deployments");
    assert(r.status === 200, "GET /api/monitoring/deployments returns 200 OK");
    assert(isValidSource(r.json?.data?.source), `Deployment source is classified (${r.json?.data?.source})`);
    
    // In production without GitHub credentials, version is null or GITHUB_ACTIONS
    const rel = r.json?.data?.currentRelease;
    assert(rel?.version !== "v1.2.0", "Hardcoded release v1.2.0 removed from production response");
    assert(isValidSource(r.json?.data?.businessCorrelation?.source), "Business correlation source is classified");
  }

  console.log(`\n--- [Group 7: Core E-Commerce Routes Functional Verification] ---`);
  {
    const r1 = await fetchJson("/api/products");
    assert(r1.status === 200 && Array.isArray(r1.json?.products), "GET /api/products returns catalog from D1");

    const r2 = await fetchJson("/api/orders");
    assert(r2.status === 200 && Array.isArray(r2.json?.orders), "GET /api/orders returns orders from D1");

    const r3 = await fetchJson("/api/feedback");
    assert(r3.status === 200 && Array.isArray(r3.json?.feedback), "GET /api/feedback returns customer reviews from D1");

    const r4 = await fetchJson("/api/metrics");
    assert(r4.status === 200 && r4.json?.metrics?.totalProducts !== undefined, "GET /api/metrics returns business counts");

    const r5 = await fetchJson("/api/session/cart?sessionId=verify-test-session");
    assert(r5.status === 200 && Array.isArray(r5.json?.cart), "GET /api/session/cart reads persistent cart from Cloudflare KV");

    // Test session cart write
    const r6 = await fetchJson("/api/session/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "verify-test-session", cart: [{ id: "test-item", qty: 1 }] })
    });
    assert(r6.status === 200 && r6.json?.success === true, "POST /api/session/cart saves cart to Cloudflare KV");
  }

  console.log(`\n--- [Group 8: Security, Restricted CORS & Preflight] ---`);
  {
    const res = await fetch(`${BASE_URL}/api/monitoring/overview`, {
      method: "OPTIONS",
      headers: {
        "Origin": "http://localhost:8080",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "X-Request-ID, Content-Type"
      }
    });
    assert(res.status === 204, "OPTIONS preflight returns 204 No Content");
    assert(res.headers.get("access-control-allow-origin") === "http://localhost:8080", "CORS securely reflects permitted origin (no unconditional *)");
    assert(res.headers.get("access-control-allow-methods")?.includes("GET"), "CORS allows GET method");
    assert(res.headers.get("access-control-allow-headers")?.includes("X-Request-ID"), "CORS allows X-Request-ID header");
  }

  console.log(`\n--- [Group 9: Canonical GraphQL Schemas & Introspection Unit Tests] ---`);
  {
    const {
      CLOUDFLARE_ANALYTICS_DATASETS,
      validateDatasetQuery,
      introspectAccountDatasets
    } = await import("../worker/monitoring/cloudflare/schema.js");

    // D1 Canonical Datasets
    assert(!!CLOUDFLARE_ANALYTICS_DATASETS.d1AnalyticsAdaptiveGroups, "Schema defines canonical d1AnalyticsAdaptiveGroups dataset");
    assert(CLOUDFLARE_ANALYTICS_DATASETS.d1AnalyticsAdaptiveGroups.metrics.includes("readQueries"), "d1AnalyticsAdaptiveGroups includes readQueries");
    assert(CLOUDFLARE_ANALYTICS_DATASETS.d1AnalyticsAdaptiveGroups.metrics.includes("rowsRead"), "d1AnalyticsAdaptiveGroups includes rowsRead");
    assert(!!CLOUDFLARE_ANALYTICS_DATASETS.d1StorageAdaptiveGroups, "Schema defines canonical d1StorageAdaptiveGroups dataset");
    assert(CLOUDFLARE_ANALYTICS_DATASETS.d1StorageAdaptiveGroups.metrics.includes("databaseSizeBytes"), "d1StorageAdaptiveGroups includes databaseSizeBytes");

    // KV Canonical Datasets
    assert(!!CLOUDFLARE_ANALYTICS_DATASETS.kvOperationsAdaptiveGroups, "Schema defines canonical kvOperationsAdaptiveGroups dataset");
    assert(CLOUDFLARE_ANALYTICS_DATASETS.kvOperationsAdaptiveGroups.metrics.includes("requests"), "kvOperationsAdaptiveGroups includes requests");
    assert(CLOUDFLARE_ANALYTICS_DATASETS.kvOperationsAdaptiveGroups.dimensions.includes("action"), "kvOperationsAdaptiveGroups includes action dimension for reads/writes/deletes");

    // Durable Objects Canonical Datasets
    assert(!!CLOUDFLARE_ANALYTICS_DATASETS.durableObjectsInvocationsAdaptiveGroups, "Schema defines canonical durableObjectsInvocationsAdaptiveGroups dataset");
    assert(CLOUDFLARE_ANALYTICS_DATASETS.durableObjectsInvocationsAdaptiveGroups.metrics.includes("requests"), "durableObjectsInvocationsAdaptiveGroups includes requests");
    assert(CLOUDFLARE_ANALYTICS_DATASETS.durableObjectsInvocationsAdaptiveGroups.metrics.includes("cpuTimeP50"), "durableObjectsInvocationsAdaptiveGroups includes cpuTimeP50");

    // Introspection function
    assert(typeof introspectAccountDatasets === "function", "Dynamic GraphQL introspection function is exported");

    // Strict validation rejection test
    const fakeTest = validateDatasetQuery("nonExistentDataset", ["fakeMetric"]);
    assert(fakeTest.valid === false, "validateDatasetQuery correctly rejects non-existent dataset");
  }

  console.log(`\n======================================================`);
  console.log(`Test Execution Summary:`);
  console.log(`  Total Tests Passed: ${passed}`);
  console.log(`  Total Tests Failed: ${failed}`);
  console.log(`  Success Rate:       ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
  console.log(`======================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test suite runner error:", err);
  process.exit(1);
});
