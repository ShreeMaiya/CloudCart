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
    PagesFunction -->|"Cloudflare Service Binding (Direct Edge Hop)"| API
    API --> DO
    API --> D1
    API --> KV
```

| Cloudflare Service | Functionality in CloudCart |
| :--- | :--- |
| **Cloudflare Pages** | Global edge hosting for storefront & admin frontend at `cloudcart.pages.dev`. |
| **Cloudflare Pages Functions** | Serverless edge interceptor proxying `/api/*` requests. |
| **Cloudflare Service Bindings** | Direct Worker-to-Worker communication through a Cloudflare Service Binding without an external HTTP network hop. |
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

## ⚡ 3. Cloudflare-Native Observability (`/admin/observability/`)

The observability dashboard queries Cloudflare Workers Observability for recent logs, metrics, and traces. It does not write observability data to D1 or KV. Cloudflare retains logs and traces for a limited period; this project does not keep a separate historical telemetry store.

### Configure access

The workflow uses these two existing **repository secrets** and installs the observability values into the `cloudcart-worker` Worker after each deploy:

| GitHub secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Your existing deploy token, also used to query Cloudflare telemetry. It needs Workers Observability Write and Account Analytics Read permissions in addition to the permissions needed for deployment. |
| `OBSERVABILITY_API_KEY` | Existing GitHub secret retained for later; the current dashboard does not require it. |

The workflow reuses your existing `CLOUDFLARE_ACCOUNT_ID` as a Worker variable and your existing `CLOUDFLARE_API_TOKEN` for both deployment and Cloudflare telemetry queries. Neither admin page currently has a password prompt. Observability API routes are open, so anyone who can reach the Worker can query its telemetry; authentication can be added later. The Cloudflare API token stays in Worker secrets and is never sent to browser code. `scripts/setup.js` fills `CF_WORKER_NAME` and `CF_D1_DATABASE_ID` in Wrangler configuration when it provisions resources; for manual provisioning, set those variables to the deployed Worker name and D1 database UUID.

After deployment, open **Admin** or **Observability** directly without a password prompt. The dashboard auto-refresh is off by default; each view is queried on demand and cached briefly in Worker memory.

### Health and quota behavior

Passive health refreshes do not call D1, KV, or the Durable Object. They show unknown when the dashboard has no fresh evidence. **Run health check** deliberately performs one D1 `SELECT 1`, one KV read, and one InventoryDO request; the result is reused for 30 seconds. Pages availability is not inferred from a backend Worker probe.

Logs and traces are sampled and may not represent every invocation. Current tracing sampling is configured in `wrangler.toml`; review Cloudflare Observability usage and pricing before increasing it. Keep personal/customer data out of log messages and span attributes.


