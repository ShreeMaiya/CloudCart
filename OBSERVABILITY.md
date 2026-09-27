# CloudCart Monitoring & Observability Architecture Guide

## 1. Overview & Observability Principles

CloudCart's monitoring and observability architecture provides real-time visibility into the performance, health, data layer operations, and real-time actor state across Cloudflare's serverless edge ecosystem.

### Core Defensibility Rule
> **Zero fake metrics.** The CloudCart monitoring platform does not fabricate production telemetry. If a metric cannot be queried or measured through Cloudflare native APIs or application probes, it is represented honestly as `UNAVAILABLE` with `value: null`. No fallback defaults (e.g. `durationP95 || 35`) or synthetic span breakdowns are permitted in production.

```
                                  CLOUDCART EDGE ARCHITECTURE & OBSERVABILITY
                                  
  [ Customer Browser ]
          │  (X-Request-ID propagation)
          ▼
  [ Cloudflare Pages ] ─── (Observability Limited: UNKNOWN / null)
          │  (Service Binding / Edge Routing)
          ▼
  [ CloudCart Worker ] ─── (Measured Span: Ingress -> Route Dispatch)
          │
          ├───► [ D1 Database: cloudcart-db ] ─────── (Active Probe: SELECT 1 / App Instrumented)
          ├───► [ KV Cache: cloudcart-kv ] ───────── (Active Probe: ephemeral roundtrip / App Instrumented)
          └───► [ Durable Object: InventoryDO ] ──── (Active Probe: /health-ping / Live WS Tracker)
                    │
                    └─── (Single-threaded Actor / Real-time WebSocket Mesh)
```

---

## 2. Standard Metric Classification System

Every metric served by CloudCart's monitoring subsystem adheres to an explicit classification metadata envelope:

```typescript
interface MonitoringMetric<T = number | string | boolean | null> {
  value: T;
  source: "CLOUDFLARE_NATIVE" | "APPLICATION_INSTRUMENTED" | "CALCULATED" | "UNAVAILABLE" | "DEMO";
  timestamp: string; // ISO 8601 UTC
  reason?: string;   // Required when source === "UNAVAILABLE"
  calculation?: string; // Required when source === "CALCULATED"
}
```

### Classification Taxonomy

| Source | Description | Example Metric |
| :--- | :--- | :--- |
| `CLOUDFLARE_NATIVE` | Query retrieved directly from Cloudflare GraphQL Analytics API. | `workersInvocationsAdaptive.quantiles.durationP95` |
| `APPLICATION_INSTRUMENTED` | Measured directly within the CloudCart Worker runtime, SQLite query wrapper, or Durable Object instance. | `totalRequests`, `d1TotalQueries`, `activeWsConnections` |
| `CALCULATED` | Derived strictly by formula from verified underlying measurements. | `errorRate = (errors / requests) * 100` |
| `UNAVAILABLE` | Metric not exposed by Cloudflare APIs or unmeasurable from Worker isolate. Value is strictly `null`. | `d1StorageVolume`, `pagesResponseTime` |
| `DEMO` | Synthetic simulation data gated exclusively behind `MONITORING_DEMO_MODE=true`. | Seeded demonstration requests for offline testing |

---

## 3. Monitoring API Reference

All monitoring endpoints are served under `/api/monitoring/*` and require no client-side Cloudflare credentials.

### Endpoints Inventory

| Endpoint | Method | Query Parameters | Description |
| :--- | :--- | :--- | :--- |
| `/api/monitoring/overview` | `GET` | `range=15m\|1h\|6h\|24h\|7d` | System health summary, invocation counts, error rate, latency percentiles, and subsystem activity. |
| `/api/monitoring/services` | `GET` | — | Deep health probes for Worker, D1, KV, Durable Object, Pages, and Pages Functions. |
| `/api/monitoring/health` | `GET` | — | Lightweight probe endpoint returning overall system status and component health array. |
| `/api/monitoring/api` | `GET` | `range=...`, `endpoint=...`, `status=...` | Per-endpoint throughput, error rates (2xx, 4xx, 5xx), and latency percentiles (Avg, P50, P95, P99). |
| `/api/monitoring/performance` | `GET` | `range=...` | Cloudflare GraphQL Worker invocation curves, CPU execution times, and time-series histograms. |
| `/api/monitoring/database` | `GET` | `range=...` | D1 query volumes, read/write split, live row counts, slow query log, and KV operation telemetry. |
| `/api/monitoring/realtime` | `GET` | — | Durable Object live WebSocket client count, connection lifecycle, and purchase transaction metrics. |
| `/api/monitoring/logs` | `GET` | `level=...`, `service=...`, `search=...`, `limit=...` | Centralized structured log buffer with automatic credential/PII sanitization. |
| `/api/monitoring/traces` | `GET` | `traceId=...`, `minDuration=...` | Distributed trace waterfall with real measured spans and universal `X-Request-ID` correlation. |
| `/api/monitoring/deployments` | `GET` | — | GitHub Actions pipeline status, commit metadata, and e-commerce business correlation metrics. |

---

## 4. Cloudflare GraphQL Analytics Integration

When valid credentials (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`) are configured, CloudCart queries Cloudflare's GraphQL Analytics API (`https://api.cloudflare.com/client/v4/graphql`).

### Schema Validation & Supported Datasets

Before issuing queries, requests are validated against known Cloudflare GraphQL schema rules (`worker/monitoring/cloudflare/schema.js`):

1. **Worker Invocations Adaptive**: `workersInvocationsAdaptive`
   - Supported Dimensions: `datetime`, `scriptName`, `status`
   - Supported Metrics: `requests`, `errors`, `subrequests`, `wallTime`, `cpuTimeMs`
   - Supported Quantiles: `quantiles { durationP50, durationP95, durationP99 }`
2. **D1 Analytics Adaptive**: `d1AnalyticsAdaptive`
   - Supported Dimensions: `datetime`, `databaseId`
   - Supported Metrics: `readQueries`, `writeQueries`, `rowsRead`, `rowsWritten`, `queryBatchTimeMs`
3. **KV Operations Adaptive**: `kvOperationsAdaptive`
   - Supported Dimensions: `datetime`, `namespaceId`, `action`
   - Supported Metrics: `requests`
4. **Durable Objects Adaptive**: `durableObjectsInvocationsAdaptive`
   - Supported Dimensions: `datetime`, `namespaceId`, `className`
   - Supported Metrics: `requests`, `errors`, `cpuTimeMs`

### Absence & Error Handling
If Cloudflare GraphQL credentials are missing or the GraphQL API returns an error or empty result:
- The system returns `source: "UNAVAILABLE"` with an explicit reason string (e.g. `"Cloudflare GraphQL API token not configured"`).
- The platform does **not** fall back to fabricated numbers like `35ms` or `70ms`.
- The dashboard displays `N/A` with an `UNAVAILABLE` badge.

---

## 5. Application Instrumentation

CloudCart supplements native edge analytics with lightweight in-isolate application instrumentation:

### 1. In-Isolate Request Telemetry (`worker/monitoring/telemetry.js`)
- Maintains a high-speed ring buffer of recent requests in Worker memory.
- Captures `requestId`, `endpoint`, `method`, `status`, `durationMs`, and `colo`.
- Computes actual mathematical percentiles (`P50`, `P95`, `P99`) only when sufficient data exists (minimum 3 samples). Returns `null` if fewer samples are available.

### 2. D1 Query Telemetry (`worker/monitoring/d1Telemetry.js`)
- Wraps every D1 SQL statement (`prepare(...).all()`, `.run()`, `.batch()`).
- Tracks read queries, write queries, query execution time, and syntax/lock errors.
- Logs slow queries exceeding 35ms threshold with sanitized statement texts.
- All counters start at `0` upon isolate startup (no seeded values like `1450` reads).

### 3. Durable Object Telemetry (`worker/durableObjects/InventoryDO.js`)
- Tracks active WebSocket client connections in-memory using `this.sessions.size`.
- Records connection lifecycle (`opened`, `closed`, `errors`) and broadcast counts.
- Measures single-threaded atomic purchase transaction latency.
- Clearly labeled in the API as instance-level runtime instrumentation, not global historical platform totals.

---

## 6. Health-Check Methodology

Health status is derived strictly through active probe executions:

```
Active Probe Execution Flow:
  Probe Start (hrtime/Date.now())
         │
         ▼
  Execute Minimal Functional Operation
    - Worker: In-isolate ping
    - D1: SELECT 1 as alive
    - KV: Put temporary probe key -> Get probe key -> Delete probe key
    - DO: Fetch /health-ping on DO stub
         │
         ▼
  Probe End
         │
         ▼
  Duration = (End - Start) ms
  Status: HEALTHY (<100ms), DEGRADED (>100ms), DOWN (exception thrown)
```

### Pages & Pages Functions Health Distinction
- Cloudflare Pages static edge hosting cannot be probed from within an isolated Worker backend.
- Attempting to declare Pages as `HEALTHY (8ms)` based solely on Worker execution is technically false.
- Therefore, Pages and Pages Functions report:
  ```json
  {
    "service": "Cloudflare Pages",
    "tier": "Static Frontend CDN",
    "status": "UNKNOWN",
    "responseTimeMs": null,
    "source": "UNAVAILABLE",
    "diagnostic": "Observability limited: External CDN layer cannot be probed from backend Worker isolate."
  }
  ```

---

## 7. Distributed Tracing & Correlation Architecture

Every request passing through CloudCart receives a universal correlation identifier: `X-Request-ID`.

### Propagation
```
Customer Browser (generates or receives X-Request-ID)
      │
      ▼
Cloudflare Pages Function (preserves X-Request-ID)
      │
      ▼
CloudCart Worker (instruments ingress span, extracts/generates X-Request-ID)
      │
      ├───► D1 Database Client (tags query context with X-Request-ID)
      ├───► KV Storage Client (tags key operation with X-Request-ID)
      └───► Durable Object (forwards X-Request-ID in internal RPC headers)
```

### Real Spans vs Synthetic Waterfalls
- The tracing engine (`worker/monitoring/tracing.js`) only records spans that were **actually measured** via high-resolution timing.
- No synthetic percentage math (e.g. splitting total request time into artificial 15% Pages, 30% Worker, 40% D1).
- External unmeasured hops (such as edge ingress routing) are reported with `durationMs: null` and `source: "UNAVAILABLE"`.

---

## 8. Structured Logging & PII Sanitization

Application logs are buffered in memory and surfaced via `/api/monitoring/logs`.

### Security & Redaction Safeguards
Before any log entry enters the buffer or is returned to the Admin UI, it is sanitized against sensitive patterns (`worker/monitoring/logManager.js`):
- `Authorization: Bearer <token>` ──► `Bearer [REDACTED_AUTH_TOKEN]`
- Cloudflare API tokens ──► `[REDACTED_API_TOKEN]`
- Passwords (`password: "..."`) ──► `"password": "[REDACTED_PASSWORD]"`
- Payment card data (`card_number`, `cvv`) ──► `[REDACTED_CVV]` / `[REDACTED_CARD]`
- Session secrets and cookie values ──► `[REDACTED_SECRET]`

---

## 9. Demo Mode Architecture

When running local demonstrations, presentations, or testing UI states without active traffic, Demo Mode can be explicitly enabled:

```text
# wrangler.toml or .dev.vars
MONITORING_DEMO_MODE=true
```

### Safety Guarantees
1. **Never enabled by default in production**: `MONITORING_DEMO_MODE` defaults to `false`.
2. **Explicit payload marking**: Every metric emitted in demo mode contains `"source": "DEMO"`.
3. **Prominent UI Warning**: When active, the dashboard header displays a mandatory banner:
   ```
   ⚠️ DEMO DATA — Not live Cloudflare telemetry
   ```

---

## 10. Required Cloudflare Credentials & Permissions

For live platform-level analytics via Cloudflare GraphQL:

| Variable | Scope | Purpose |
| :--- | :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | Read-only | Query GraphQL Analytics (`Account.Analytics:Read`, `Account.Worker Scripts:Read`) |
| `CLOUDFLARE_ACCOUNT_ID` | Read-only | Target Cloudflare account identifier |

> **Security Rule**: Cloudflare API credentials are kept exclusively on the serverless backend. Browser JavaScript calls only `/api/monitoring/*` endpoints and never receives the raw token.

---

## 11. Known Cloudflare API Limitations

The following limitations exist within Cloudflare's public GraphQL and observability APIs as of this implementation:

1. **Storage Sizing**: D1 database byte allocation and KV namespace storage volumes are not currently exposed in real-time via the GraphQL Adaptive Analytics datasets.
2. **Per-Key KV Frequencies**: KV Adaptive Analytics aggregates requests at the namespace and action level, not per individual cache key.
3. **Memory Consumption**: Durable Object memory utilization (RAM heap) is not exposed via GraphQL analytics.
4. **Pages Edge Hit-Ratio**: Cache hit ratios for static Pages assets are managed on the Pages CDN layer and not accessible via Worker service bindings.

In each of these cases, CloudCart displays `N/A` with an honest source tag (`UNAVAILABLE`) rather than manufacturing synthetic estimates.

---

## 12. Verification & Testing Suite

CloudCart includes a comprehensive verification suite (`scripts/verify_monitoring.js`) covering 48 discrete assertions:

```bash
# Run verification suite against local or deployed worker
node scripts/verify_monitoring.js
```

### Key Test Categories
1. **Source Integrity**: Ensures all metrics include `{ value, source, timestamp }`.
2. **Zero Fake Metrics**: Validates that unconfigured GraphQL metrics return `UNAVAILABLE` and `null` without hardcoded fallback numbers.
3. **Real Active Probes**: Confirms that D1, KV, and DO health probes measure genuine latency.
4. **Observability Distinction**: Confirms Pages and Pages Functions return `UNKNOWN` / `UNAVAILABLE`.
5. **PII Sanitization**: Verifies that auth tokens and credentials in logs are redacted.
6. **E-Commerce Preservations**: Confirms product catalog CRUD, shopping cart, checkout, and inventory synchronization remain 100% operational.

---

## 13. Comprehensive Metric Mapping Table

| Monitoring Area | Metric Name | Metric Source | Production Type | Behavior when Cloudflare Unconfigured |
| :--- | :--- | :--- | :--- | :--- |
| **Worker Requests** | `totalRequests` | `CLOUDFLARE_NATIVE` / `APPLICATION_INSTRUMENTED` | Live / Measured | Reports instrumented isolate total; GraphQL shows `UNAVAILABLE` |
| **Worker Errors** | `totalErrors` | `CLOUDFLARE_NATIVE` / `APPLICATION_INSTRUMENTED` | Live / Measured | Reports instrumented error count; GraphQL shows `UNAVAILABLE` |
| **Worker Latency** | `avgDuration`, `p50`, `p95`, `p99` | `CLOUDFLARE_NATIVE` / `APPLICATION_INSTRUMENTED` | Live / Measured | Computed from measured buffer; returns `null` if < 3 samples |
| **Worker CPU Time** | `cpuTimeMs` | `CLOUDFLARE_NATIVE` | Live | Returns `null` with `source: UNAVAILABLE` |
| **D1 Query Volume** | `d1TotalQueries` | `APPLICATION_INSTRUMENTED` | Instrumented | Live SQLite query interception counter (starts at 0) |
| **D1 Native Analytics**| `readQueries`, `writeQueries` | `CLOUDFLARE_NATIVE` | Live | Returns `null` with `source: UNAVAILABLE` |
| **D1 Storage** | `databaseStorageBytes` | `UNAVAILABLE` | Unavailable | Displays `Not available from current Cloudflare API` |
| **KV Operations** | `kvTotalOps` | `APPLICATION_INSTRUMENTED` | Instrumented | Live KV put/get/delete wrapper counter (starts at 0) |
| **KV Native Analytics**| `kvOperationsAdaptive` | `CLOUDFLARE_NATIVE` | Live | Returns `null` with `source: UNAVAILABLE` |
| **KV Active Carts** | `activeSessionCarts` | `CALCULATED` | Calculated | Live count of non-empty cart keys in active store |
| **Durable Object WS** | `activeConnections` | `APPLICATION_INSTRUMENTED` | Instrumented | Live `sessions.size` within InventoryDO instance |
| **Durable Object DO** | `invocations`, `cpu` | `CLOUDFLARE_NATIVE` | Live | Returns `null` with `source: UNAVAILABLE` |
| **WebSocket Errors** | `connectionErrors` | `APPLICATION_INSTRUMENTED` | Instrumented | Measured socket disconnect/error counter (starts at 0) |
| **Subsystem Health** | `Worker`, `D1`, `KV`, `DO` | `APPLICATION_PROBE` | Live Probes | Measured roundtrip duration for real functional operations |
| **Pages Health** | `Pages`, `Pages Functions` | `UNAVAILABLE` | Unavailable | `status: "UNKNOWN"`, `responseTimeMs: null` |
| **Logs** | `recentLogs` | `APPLICATION_INSTRUMENTED` | Instrumented | In-memory buffer with automated secret/PII redaction |
| **Traces** | `recentTraces` | `APPLICATION_INSTRUMENTED` | Measured | Real measured span durations; unmeasured spans marked `null` |
| **Checkout Metrics** | `conversionRate`, `revenue` | `CALCULATED` | Calculated | Computed directly from live D1 `orders` table |
| **Deployments** | `pipelineStatus`, `release` | `UNAVAILABLE` / CI Provider | Live / Unavailable | Returns `UNAVAILABLE` unless GitHub Actions secret configured |
