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

### Key Capabilities
- **System Health & Subsystem Probes**: Active probes across all 7 architectural tiers (Pages, Worker, D1 SQLite `SELECT 1`, KV read/write/delete, `InventoryDO` `/health-ping`, and WebSockets).
- **API Telemetry & Latencies**: Endpoint performance table calculating P50, P95, and P99 percentiles alongside 2xx/4xx/5xx status breakdowns.
- **Time-Series Charts**: Pure responsive SVG charts for Invocations & Errors, Latency Percentiles (Avg, P50, P95, P99), and Worker CPU execution duration.
- **D1 & KV Storage Insights**: D1 query counters, table row inventory, slow query logs (`> 35ms`), and 7-day persistent cart cache operations.
- **Durable Objects & Real-Time Sync**: Live tracking of connected WebSocket sessions, catalog broadcast throughput, and serialized atomic purchase latencies.
- **Centralized Logs & Error Center**: Filterable telemetry stream (`INFO`, `WARN`, `ERROR`), live search, and slide-out inspector drawer with formatted JSON payloads and stack traces.
- **Distributed Tracing & Waterfall Visualizer**: Request correlation using universal `X-Request-ID` propagation and Gantt-style latency waterfalls across Pages ➜ Worker ➜ DO ➜ D1/KV.
- **CI/CD Deployments & Business Correlation**: 5-stage automated provisioning visualizer, release audit log, and business analytics correlating infrastructure performance to checkout conversion rates and revenue velocity.

### Automated Testing & Verification
```bash
# Run the 30-check automated verification test suite
npm run test:monitoring
```
*Validates 100% of monitoring endpoints, core e-commerce CRUD regressions, and metric integrity rules.*

