/**
 * CloudCart Observability Verification Suite
 * Validates the 3 pillars (Logs, Metrics, Traces), Health probes, and Admin routes.
 */

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8787";

async function verifyObservability() {
  console.log(`\n🔍 Verifying CloudCart Observability at ${BASE_URL}...\n`);
  let passed = 0;
  let failed = 0;

  async function check(name, fn) {
    process.stdout.write(`  Testing ${name}... `);
    try {
      await fn();
      console.log("✅ PASS");
      passed++;
    } catch (err) {
      console.log(`❌ FAIL (${err.message})`);
      failed++;
    }
  }

  // 1. Health Probe
  await check("Health Endpoint (/api/observability/health)", async () => {
    const res = await fetch(`${BASE_URL}/api/observability/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.status) throw new Error("Missing status property");
  });

  // 2. Overview Endpoint
  await check("Overview Endpoint (/api/observability/overview)", async () => {
    const res = await fetch(`${BASE_URL}/api/observability/overview`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error("Expected success: true");
  });

  // 3. Logs Pillar
  await check("Logs Pillar (/api/observability/logs)", async () => {
    const res = await fetch(`${BASE_URL}/api/observability/logs`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.logs)) throw new Error("logs is not an array");
  });

  // 4. Metrics Pillar
  await check("Metrics Pillar (/api/observability/metrics)", async () => {
    const res = await fetch(`${BASE_URL}/api/observability/metrics`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.requests || !data.business) throw new Error("Missing requests or business metrics");
  });

  // 5. Traces Pillar
  await check("Traces Pillar (/api/observability/traces)", async () => {
    const res = await fetch(`${BASE_URL}/api/observability/traces`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.traces)) throw new Error("traces is not an array");
  });

  // 6. Header propagation
  await check("Trace Header Propagation (/api/health)", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    const traceId = res.headers.get("x-trace-id");
    const requestId = res.headers.get("x-request-id");
    if (!traceId) throw new Error("Missing X-Trace-ID header");
    if (!requestId) throw new Error("Missing X-Request-ID header");
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

// Only execute directly when run as script
if (process.argv[1]?.endsWith("verify_observability.js")) {
  verifyObservability().catch(err => {
    console.error("Verification suite aborted:", err.message);
    process.exit(1);
  });
}

export { verifyObservability };
