# ☁️ CloudCart - Cloudflare E-Commerce Platform

A production-grade, serverless E-Commerce platform built with **HTML, CSS, JavaScript** and powered natively by the **Cloudflare Developer Platform**.

---

## 🚀 Cloudflare Stack Architecture

| Cloudflare Service | Functionality in CloudCart |
| :--- | :--- |
| **Cloudflare Workers & Assets** | Serverless API router handling products, orders, feedback, and serving static customer/admin frontend assets. |
| **Cloudflare D1 Database** | Serverless SQLite database (`cloudcart-db`) storing persistent products, inventory, orders, and customer feedback. |
| **Cloudflare Durable Objects** | Single-point coordination engine guaranteeing **atomic stock transactions** and **real-time WebSocket synchronization** across all active client sessions. |
| **Cloudflare KV Namespace** | Key-Value session cache (`cloudcart-kv`) providing persistent shopping cart states across browser tabs and sessions. |
| **GitHub Actions CI/CD** | Fully automated provisioning and deployment pipeline triggering on push to `main`. |

---

## 🎯 Implemented Features

### 🛒 1. Customer Surface (`/public/index.html`)
- **Modern UI**: Dark-mode tech storefront with responsive product cards, search, and category filters.
- **Dynamic Catalog**: Products and prices loaded from Cloudflare D1 with Indian Rupee (₹) formatting.
- **Live Stock Badges**: Real-time stock status badges (`In Stock`, `Only X Left!`, `Out of Stock`) updating silently via WebSockets.
- **Shopping Cart & Checkout**: Slide-in cart drawer with quantity controls, Cloudflare KV session persistence, and atomic backend checkout.
- **Customer Feedback Modal**: Interactive feedback submission form with 1-5 star rating and comments.

### 🛠️ 2. Admin Surface (`/public/admin/index.html`)
- **Dashboard Metrics**: Real-time counts for Active Products, Total Inventory, Connected Live Users, and Total Revenue.
- **Product Catalog & Stock Management**: Inline price editor, stock adjusters (`+`/`-`), and product deletion.
- **Add Product Modal**: Form to add new products directly into Cloudflare D1.
- **Recent Customer Orders Table**: Live listing of customer purchases showing Order ID, Customer Name, Items Summary, Total (₹), and Timestamp.
- **Customer Reviews & Feedback Panel**: Live table displaying submitted customer reviews and star ratings.

## 🌐 Automated Cloudflare Deployment (GitHub Actions)

This repository includes a fully automated provisioning script (`scripts/setup.js`) that creates all required Cloudflare resources (D1 Database, KV Namespace) and deploys the Worker automatically.

### Setup Instructions:
1. Push this repository to GitHub.
2. In your GitHub repository, navigate to **Settings > Secrets and variables > Actions**.
3. Add the following repository secrets:
   - `CLOUDFLARE_API_TOKEN`: Cloudflare API Token with Workers, D1, and KV edit permissions.
   - `CLOUDFLARE_ACCOUNT_ID`: Found on your Cloudflare Dashboard homepage right sidebar.
4. Any push to `main` (or clicking **Run workflow** under Actions) will automatically provision D1/KV, run database migrations, and deploy CloudCart to Cloudflare!
