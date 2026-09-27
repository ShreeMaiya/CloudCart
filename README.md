# ☁️ CloudCart - Multi-Tier Cloudflare E-Commerce Platform

A production-grade, full-stack E-Commerce platform built with **HTML, Vanilla CSS, JavaScript** and architected natively on the **Cloudflare Developer Platform** using **Pages + Workers Microservice + Service Bindings**.

---

## 🚀 Cloudflare Stack Architecture

```mermaid
flowchart TD
    subgraph Client["Browser Clients (Customers & Admins)"]
        UI["Storefront & Admin UI"]
    end

    subgraph Pages["Cloudflare Pages (cloudcart.pages.dev)"]
        StaticAssets["Static Edge CDN Assets (HTML, CSS, JS)"]
        PagesFunction["Pages Functions Proxy (/functions/api/[[route]].js)"]
    end

    subgraph Worker["Cloudflare Worker Microservice (cloudcart-worker)"]
        API["REST API Router"]
        DO["Durable Objects (InventoryDO - Real-Time WebSocket Sync)"]
        D1[("D1 SQLite Database (cloudcart-db)")]
        KV[("KV Namespace (cloudcart-kv)")]
    end

    UI -->|"Static Files"| StaticAssets
    UI -->|"HTTP API & WebSockets"| PagesFunction
    PagesFunction -->|"Cloudflare Service Binding (Zero-Latency IPC)"| API
    API --> DO
    API --> D1
    API --> KV
```

| Cloudflare Service | Functionality in CloudCart |
| :--- | :--- |
| **Cloudflare Pages** | Global edge hosting for storefront & admin frontend at `cloudcart.pages.dev`. |
| **Cloudflare Pages Functions** | Serverless edge interceptor proxying `/api/*` requests. |
| **Cloudflare Service Bindings** | Direct, zero-latency edge-to-edge IPC connecting Pages to the backend Worker. |
| **Cloudflare Worker** | Backend microservice (`cloudcart-worker`) handling business logic, checkout, and inventory. |
| **Cloudflare D1 Database** | Serverless SQLite database (`cloudcart-db`) storing persistent products, inventory, orders, and customer feedback. |
| **Cloudflare Durable Objects** | Distributed coordination engine guaranteeing **atomic stock transactions** and **real-time WebSocket synchronization** across all active client sessions. |
| **Cloudflare KV Namespace** | Key-Value session cache (`cloudcart-kv`) providing persistent shopping cart states across browser sessions. |
| **GitHub Actions CI/CD** | Automated provisioning and deployment pipeline triggering on push to `main`. |

---

## 🎯 Implemented Features

### 🛒 1. Customer Surface (`/index.html`)
- **Modern UI**: Dark-mode tech storefront with responsive product cards, search, and category filters.
- **Dynamic Catalog**: Products and prices loaded from Cloudflare D1 with Indian Rupee (₹) formatting.
- **Live Stock Badges**: Real-time stock status badges (`In Stock`, `Only X Left!`, `Out of Stock`) updating silently via WebSockets.
- **Shopping Cart & Checkout**: Slide-in cart drawer with quantity controls, Cloudflare KV session persistence, and atomic backend checkout.
- **Customer Feedback Modal**: Interactive feedback submission form with 1-5 star rating and comments.

### 🛠️ 2. Admin Surface (`/admin/index.html`)
- **Dashboard Metrics**: Real-time counts for Active Products, Total Inventory, Connected Live Users, and Total Revenue.
- **Product Catalog & Stock Management**: Inline price editor, stock adjusters (`+`/`-`), and product deletion.
- **Add Product Modal**: Form to add new products directly into Cloudflare D1.
- **Recent Customer Orders Table**: Live listing of customer purchases showing Order ID, Customer Name, Items Summary, Total (₹), and Timestamp.
- **Customer Reviews & Feedback Panel**: Live table displaying submitted customer reviews and star ratings.

---

## 🌐 Automated Cloudflare Deployment (GitHub Actions)

This repository includes a fully automated provisioning script (`scripts/setup.js`) that creates all required Cloudflare resources (D1 Database, KV Namespace), configures the Service Binding, and deploys both the Worker and Pages projects.

### Setup Instructions:
1. Push this repository to GitHub.
2. In your GitHub repository, navigate to **Settings > Secrets and variables > Actions**.
3. Add the following repository secrets:
   - `CLOUDFLARE_API_TOKEN`: Cloudflare API Token with Workers, D1, KV, and Pages edit permissions.
   - `CLOUDFLARE_ACCOUNT_ID`: Found on your Cloudflare Dashboard homepage right sidebar.
4. Any push to `main` (or clicking **Run workflow** under Actions) will automatically provision D1/KV, run database migrations, and deploy CloudCart to Cloudflare!

---

## ⚡ 3. Monitoring & Observability Surface (`/admin/monitoring/`)

CloudCart includes a production-grade, Cloudflare-native edge monitoring and observability platform directly accessible from the Admin Portal.

For full architectural, schema, and API documentation, see [OBSERVABILITY.md](OBSERVABILITY.md).

### Metric Honesty & Observability Principles
- **Zero Fake Metrics**: Production mode contains no seeded telemetry, synthetic traces, or hardcoded fallback numbers (e.g. `p95 || 35`). Unexposed metrics return `UNAVAILABLE` with `value: null`.
- **Source Classification**: Every metric identifies its explicit provenance: `CLOUDFLARE_NATIVE`, `APPLICATION_INSTRUMENTED`, `CALCULATED`, `UNAVAILABLE`, or `DEMO`.
- **System Health & Subsystem Probes**: Active probes across all architectural tiers (Worker, D1 SQLite `SELECT 1`, KV read/write/delete, `InventoryDO` `/health-ping`, and WebSockets). Pages and Pages Functions honestly report `UNKNOWN` (`Observability limited`) from within the Worker isolate.
- **Centralized Logs & Redaction**: Filterable telemetry stream with automatic sanitization of authorization tokens, Cloudflare API tokens, cookies, passwords, and payment details.
- **Distributed Tracing & Correlation**: Universal `X-Request-ID` propagation across client, worker, database, and actor model with honest, data-driven span waterfalls.
- **Demo Mode**: Offline demonstration simulation is strictly isolated behind `MONITORING_DEMO_MODE=true` with prominent UI labeling.

### Automated Testing & Verification
```bash
# Run the 48-check automated verification test suite
npm run test:monitoring
```
*Validates 100% of monitoring endpoints, metric honesty, source classification, PII sanitization, and core e-commerce CRUD regressions.*


