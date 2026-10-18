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

## 🌐 Deploy with GitHub Actions

Deployment is designed for GitHub Actions and Cloudflare. There is no local setup requirement for deploying this project.

### Prerequisites

- A Cloudflare account with Workers, Pages, D1, KV, Durable Objects, and Workers Observability enabled as needed.
- A GitHub repository containing this project.
- A Cloudflare API token with permission to manage Workers, Pages, D1, KV, and the account-level analytics/observability APIs used by the dashboard.

### Configure GitHub Actions secrets

In **GitHub → Settings → Secrets and variables → Actions**, add exactly these repository secrets:

| Secret | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | Cloudflare account ID where the resources will be provisioned. |
| `CLOUDFLARE_API_TOKEN` | Yes | Used by the provisioning script and Wrangler to create resources, deploy the Worker and Pages project, apply the D1 schema, and query observability data. |

The workflow does **not** require a separate observability GitHub secret. The existing `CLOUDFLARE_API_TOKEN` is also installed as a Worker secret with the same name for server-side observability queries. The observability dashboard currently has no separate password or admin-key login.

### Deploy

1. Push the repository to GitHub.
2. Make sure the default branch is `main`.
3. Add the two required GitHub Actions secrets above.
4. Push to `main`, or open **Actions → Provision & Deploy CloudCart to Cloudflare → Run workflow**.
5. The workflow installs dependencies, provisions or reuses the D1 database and KV namespace, applies the schema and initial catalog, deploys the Worker, configures the Pages service binding, and deploys the frontend.

The deployment script writes the generated Cloudflare resource IDs into `wrangler.toml`. Do not commit real API tokens or other credentials to the repository.

The Pages API proxy requires the `API_WORKER` service binding created by the deployment script. It does not fall back to another account's Worker hostname. If the binding is missing or misconfigured, API requests return HTTP `503` with a configuration error until the Pages deployment configuration is corrected.

## ⚡ Cloudflare-Native Observability (`/admin/observability/`)

The observability dashboard queries Cloudflare Workers Observability for recent logs, metrics, and traces. It does not write observability data to D1 or KV. Cloudflare retains logs and traces for a limited period; this project does not keep a separate historical telemetry store.

The deployment workflow reuses `CLOUDFLARE_API_TOKEN` for Cloudflare telemetry queries and installs it as a Worker secret with the same name. The token must have the observability and analytics permissions required by the dashboard in addition to the deployment permissions. The Cloudflare API token stays in Worker secrets and is never sent to browser code.

Neither admin page currently has a password prompt. Observability API routes are open, so anyone who can reach the Worker can query its telemetry. Add application authentication before using the admin or observability pages for sensitive production data.

After deployment, open **Admin** or **Observability** directly without a password prompt. The dashboard auto-refresh is off by default; each view is queried on demand and cached briefly in Worker memory.

### Health and quota behavior

Passive health refreshes do not call D1, KV, or the Durable Object. They show unknown when the dashboard has no fresh evidence. **Run health check** deliberately performs one D1 `SELECT 1`, one KV read, and one InventoryDO request; the result is reused for 30 seconds. Pages availability is not inferred from a backend Worker probe.

Logs and traces are sampled and may not represent every invocation. Current tracing sampling is configured in `wrangler.toml`; review Cloudflare Observability usage and pricing before increasing it. Keep personal/customer data out of log messages and span attributes.
