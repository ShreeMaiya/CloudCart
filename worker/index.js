import { InventoryDO, InventorySyncDO } from "./InventoryDO.js";
import { telemetry, runSyntheticProbe } from "./telemetry.js";

export { InventoryDO, InventorySyncDO };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    // Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const startTime = performance.now();
    const requestId = request.headers.get("CF-Ray") || 'req-' + Math.random().toString(36).substring(2, 9);
    const url = new URL(request.url);
    const path = url.pathname;
    const clientIp = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "127.0.0.1";
    const userAgent = request.headers.get("User-Agent") || "";
    const cfRay = request.headers.get("CF-Ray") || "";
    const colo = request.cf?.colo || "LOCAL";
    const country = request.cf?.country || "LOCAL";

    // Helper to log telemetry on response completion
    const finalizeTelemetry = (status, error = null) => {
      const durationMs = performance.now() - startTime;
      telemetry.recordRequest({
        requestId,
        method: request.method,
        path: url.pathname + url.search,
        status,
        durationMs,
        clientIp,
        colo,
        country,
        userAgent,
        cfRay,
        errorMessage: error?.message || null,
        errorStack: error?.stack || null
      });
    };

    // Durable Object instance getter (single global instance for CloudCart catalog sync)
    const doId = env.INVENTORY_DO.idFromName("cloudcart-inventory-global");
    const doStub = env.INVENTORY_DO.get(doId);

    try {
      // 1. Real-time WebSocket connection route
      if (path === "/api/sync" || request.headers.get("Upgrade") === "websocket") {
        finalizeTelemetry(101);
        return await doStub.fetch(request);
      }

      // 2. Serve static frontend assets if ASSETS bound, or handle admin redirects
      if (!path.startsWith("/api")) {
        if (path === "/admin") {
          return Response.redirect(`${url.origin}/admin/`, 301);
        }
        if (path === "/admin/monitoring") {
          return Response.redirect(`${url.origin}/admin/monitoring/`, 301);
        }

        if (env.ASSETS) {
          const assetRes = await env.ASSETS.fetch(request);
          finalizeTelemetry(assetRes.status);
          return assetRes;
        }

        const infoRes = jsonResponse({
          service: "CloudCart Backend API Microservice with Observability Engine",
          status: "healthy",
          endpoints: [
            "/api/products",
            "/api/checkout",
            "/api/session/cart",
            "/api/feedback",
            "/api/metrics",
            "/api/sync",
            "/api/ops/summary",
            "/api/ops/logs",
            "/api/ops/probe",
            "/api/ops/cloudflare-status"
          ]
        });
        finalizeTelemetry(200);
        return infoRes;
      }

      // ----------------------------------------------------
      // OBSERVABILITY & OPERATIONS ROUTES (/api/ops/*)
      // ----------------------------------------------------

      // Ops: High-level Telemetry Summary
      if (path === "/api/ops/summary" && request.method === "GET") {
        let doActiveConnections = 0;
        let doStats = {};
        try {
          const doRes = await doStub.fetch("http://do/stats");
          doStats = await doRes.json();
          doActiveConnections = doStats.activeConnections || 0;
        } catch (e) {
          console.warn("Could not query DO stats:", e.message);
        }

        // Get database row counts
        let dbStats = { products: 0, orders: 0, feedback: 0 };
        try {
          const p = await env.DB.prepare("SELECT COUNT(*) as count FROM products WHERE is_active = 1").first();
          const o = await env.DB.prepare("SELECT COUNT(*) as count FROM orders").first();
          const f = await env.DB.prepare("SELECT COUNT(*) as count FROM feedback").first();
          dbStats = {
            products: p?.count || 0,
            orders: o?.count || 0,
            feedback: f?.count || 0
          };
        } catch (e) {
          console.warn("Could not query D1 stats:", e.message);
        }

        const summary = telemetry.getSummary(doActiveConnections);
        summary.doStats = doStats;
        summary.dbStats = dbStats;

        const res = jsonResponse({ success: true, summary });
        finalizeTelemetry(200);
        return res;
      }

      // Ops: Searchable & Filterable Live Request / Error Logs
      if (path === "/api/ops/logs" && request.method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        const level = url.searchParams.get("level") || "ALL";
        const status = url.searchParams.get("status") || null;
        const search = url.searchParams.get("search") || "";

        const logs = telemetry.getLogs({ limit, level, status, search });
        const res = jsonResponse({ success: true, count: logs.length, logs });
        finalizeTelemetry(200);
        return res;
      }

      // Ops: Real-time Inventory Mutation Event Stream
      if (path === "/api/ops/inventory-events" && request.method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "20", 10);
        const events = telemetry.getInventoryEvents(limit);
        const res = jsonResponse({ success: true, count: events.length, events });
        finalizeTelemetry(200);
        return res;
      }

      // Ops: Synthetic Health Probe (Active latency ping across Worker, D1, KV, DO)
      if ((path === "/api/ops/probe" && (request.method === "GET" || request.method === "POST"))) {
        const probeResult = await runSyntheticProbe(env);
        const res = jsonResponse({ success: true, probe: probeResult });
        finalizeTelemetry(200);
        return res;
      }

      // Ops: Cloudflare Platform Status Proxy & Cache
      if (path === "/api/ops/cloudflare-status" && request.method === "GET") {
        try {
          const cfStatusRes = await fetch("https://www.cloudflarestatus.com/api/v2/summary.json", {
            headers: { "User-Agent": "CloudCart-Observability-Agent" }
          });
          if (cfStatusRes.ok) {
            const rawData = await cfStatusRes.json();
            // Filter relevant developer platform components
            const relevantNames = ["Workers", "Pages", "D1", "KV", "Durable Objects", "Cloudflare Dashboard", "Edge Network", "DNS"];
            const filteredComponents = (rawData.components || []).filter(c =>
              relevantNames.some(name => c.name.toLowerCase().includes(name.toLowerCase()))
            );

            const statusPayload = {
              success: true,
              page: rawData.page,
              status: rawData.status,
              incidents: rawData.incidents || [],
              components: filteredComponents
            };
            finalizeTelemetry(200);
            return jsonResponse(statusPayload);
          }
        } catch (cfErr) {
          console.warn("Cloudflare status API fetch failed, returning synthetic status:", cfErr.message);
        }

        // Fallback default operational status if offline / sandboxed
        const fallback = {
          success: true,
          status: { indicator: "none", description: "All Systems Operational" },
          incidents: [],
          components: [
            { name: "Cloudflare Workers & Functions", status: "operational" },
            { name: "Cloudflare D1 SQL Database", status: "operational" },
            { name: "Cloudflare KV", status: "operational" },
            { name: "Durable Objects", status: "operational" },
            { name: "Cloudflare Pages CDN", status: "operational" }
          ]
        };
        finalizeTelemetry(200);
        return jsonResponse(fallback);
      }

      // Ops: Reset / Clear Metrics
      if (path === "/api/ops/reset" && request.method === "POST") {
        telemetry.reset();
        finalizeTelemetry(200);
        return jsonResponse({ success: true, message: "Telemetry metrics reset." });
      }

      // ----------------------------------------------------
      // APPLICATION HEALTH & CORE ROUTES
      // ----------------------------------------------------

      // 3. Health check route
      if (path === "/api/health") {
        const res = jsonResponse({
          status: "OK",
          service: "CloudCart Cloudflare API",
          timestamp: new Date().toISOString()
        });
        finalizeTelemetry(200);
        return res;
      }

      // 4. Products Endpoints
      if (path === "/api/products" && request.method === "GET") {
        const category = url.searchParams.get("category");
        const search = url.searchParams.get("search");

        let query = "SELECT * FROM products WHERE is_active = 1";
        const params = [];

        if (category && category !== "all") {
          query += " AND category = ?";
          params.push(category);
        }

        if (search) {
          query += " AND (name LIKE ? OR description LIKE ?)";
          params.push(`%${search}%`, `%${search}%`);
        }

        query += " ORDER BY created_at DESC";

        const stmt = env.DB.prepare(query);
        const { results } = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();

        const res = jsonResponse({ success: true, products: results || [] });
        finalizeTelemetry(200);
        return res;
      }

      // Admin - Create Product
      if (path === "/api/products" && request.method === "POST") {
        const body = await request.json();
        const { name, category, price, stock, description, image_url } = body;

        if (!name || !category || price === undefined || stock === undefined) {
          finalizeTelemetry(400);
          return jsonResponse({ success: false, error: "Missing required product fields." }, 400);
        }

        const id = 'prod-' + Date.now();
        const defaultImg = image_url || 'https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=800&q=80';

        await env.DB.prepare(
          "INSERT INTO products (id, name, category, price, stock, description, image_url, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
        ).bind(id, name, category, parseFloat(price), parseInt(stock), description || "", defaultImg).run();

        const newProd = { id, name, category, price: parseFloat(price), stock: parseInt(stock), description, image_url: defaultImg, is_active: 1 };

        // Telemetry inventory record
        telemetry.recordInventoryEvent({
          type: "PRODUCT_CREATED",
          productId: id,
          productName: name,
          newStock: parseInt(stock),
          source: "ADMIN"
        });

        // Broadcast new product insertion to all active customer sessions via DO
        await doStub.fetch("http://do/sync-broadcast", {
          method: "POST",
          body: JSON.stringify({ type: "PRODUCT_ADDED", product: newProd })
        });

        const res = jsonResponse({ success: true, product: newProd }, 201);
        finalizeTelemetry(201);
        return res;
      }

      // Single Product / Stock Update Endpoint
      if (path.startsWith("/api/products/") && request.method === "PUT") {
        const prodId = path.split("/")[3];
        const body = await request.json();
        const { price, stock, name, category, description, image_url } = body;

        const existing = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(prodId).first();
        if (!existing) {
          finalizeTelemetry(404);
          return jsonResponse({ success: false, error: "Product not found." }, 404);
        }

        const newPrice = price !== undefined ? parseFloat(price) : existing.price;
        const newStock = stock !== undefined ? parseInt(stock) : existing.stock;
        const newName = name || existing.name;
        const newCat = category || existing.category;
        const newDesc = description !== undefined ? description : existing.description;
        const newImg = image_url || existing.image_url;

        await env.DB.prepare(
          "UPDATE products SET name = ?, category = ?, price = ?, stock = ?, description = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(newName, newCat, newPrice, newStock, newDesc, newImg, prodId).run();

        const updatedProd = { id: prodId, name: newName, category: newCat, price: newPrice, stock: newStock, description: newDesc, image_url: newImg };

        // Telemetry inventory record
        telemetry.recordInventoryEvent({
          type: "STOCK_UPDATED",
          productId: prodId,
          productName: newName,
          oldStock: existing.stock,
          newStock: newStock,
          source: "ADMIN"
        });

        // Broadcast sync to all open browser windows via DO
        await doStub.fetch("http://do/sync-broadcast", {
          method: "POST",
          body: JSON.stringify({
            type: "PRODUCT_UPDATED",
            product: updatedProd,
            source: "ADMIN"
          })
        });

        const res = jsonResponse({ success: true, product: updatedProd });
        finalizeTelemetry(200);
        return res;
      }

      // Admin - Delete Product (Soft delete)
      if (path.startsWith("/api/products/") && request.method === "DELETE") {
        const prodId = path.split("/")[3];
        await env.DB.prepare("UPDATE products SET is_active = 0 WHERE id = ?").bind(prodId).run();

        telemetry.recordInventoryEvent({
          type: "PRODUCT_DELETED",
          productId: prodId,
          source: "ADMIN"
        });

        // Broadcast deletion to all users
        await doStub.fetch("http://do/sync-broadcast", {
          method: "POST",
          body: JSON.stringify({ type: "PRODUCT_DELETED", productId: prodId })
        });

        const res = jsonResponse({ success: true, message: "Product deleted successfully." });
        finalizeTelemetry(200);
        return res;
      }

      // 5. Atomic Multi-User Checkout Route (Handled by Durable Object)
      if (path === "/api/checkout" && request.method === "POST") {
        let checkoutBody;
        try {
          checkoutBody = await request.json();
        } catch {
          checkoutBody = {};
        }

        const doRes = await doStub.fetch("http://do/atomic-purchase", {
          method: "POST",
          body: JSON.stringify(checkoutBody)
        });

        const doResData = await doRes.json();
        if (doRes.ok && doResData.success) {
          telemetry.recordCheckoutEvent(true, null, { orderId: doResData.orderId, totalAmount: doResData.totalAmount });
          telemetry.recordInventoryEvent({
            type: "CHECKOUT_PURCHASE",
            orderId: doResData.orderId,
            itemsCount: doResData.itemsCount,
            source: "CUSTOMER_CHECKOUT"
          });
        } else {
          telemetry.recordCheckoutEvent(false, doResData.error || "Checkout error", checkoutBody);
        }

        finalizeTelemetry(doRes.status);
        return jsonResponse(doResData, doRes.status);
      }

      // 6. Orders List Route (Admin)
      if (path === "/api/orders" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM orders ORDER BY created_at DESC LIMIT 50"
        ).all();
        const res = jsonResponse({ success: true, orders: results || [] });
        finalizeTelemetry(200);
        return res;
      }

      // 7. Cloudflare KV Session Cart Persistent Routes
      if (path === "/api/session/cart" && request.method === "GET") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) {
          finalizeTelemetry(400);
          return jsonResponse({ success: false, error: "Missing sessionId" }, 400);
        }

        let cartData = [];
        if (env.CLOUDCART_KV) {
          const raw = await env.CLOUDCART_KV.get(`cart:${sessionId}`);
          if (raw) cartData = JSON.parse(raw);
        }
        const res = jsonResponse({ success: true, cart: cartData });
        finalizeTelemetry(200);
        return res;
      }

      if (path === "/api/session/cart" && request.method === "POST") {
        const body = await request.json();
        const { sessionId, cart } = body;
        if (!sessionId) {
          finalizeTelemetry(400);
          return jsonResponse({ success: false, error: "Missing sessionId" }, 400);
        }

        if (env.CLOUDCART_KV) {
          // Save cart in Cloudflare KV with 7 days expiration (604800 seconds)
          await env.CLOUDCART_KV.put(`cart:${sessionId}`, JSON.stringify(cart || []), { expirationTtl: 604800 });
        }
        const res = jsonResponse({ success: true, message: "Cart saved to Cloudflare KV" });
        finalizeTelemetry(200);
        return res;
      }

      // 8. Customer Feedback Routes
      if (path === "/api/feedback" && request.method === "POST") {
        const body = await request.json();
        const { customer_name, email, rating, comments } = body;

        if (!customer_name || !rating || !comments) {
          finalizeTelemetry(400);
          return jsonResponse({ success: false, error: "Missing required feedback fields." }, 400);
        }

        const id = 'fb-' + Date.now();
        await env.DB.prepare(
          "INSERT INTO feedback (id, customer_name, email, rating, comments) VALUES (?, ?, ?, ?, ?)"
        ).bind(id, customer_name, email || "", parseInt(rating), comments).run();

        const feedbackObj = {
          id,
          customer_name,
          email: email || "",
          rating: parseInt(rating),
          comments,
          created_at: new Date().toISOString()
        };

        // Broadcast FEEDBACK_SUBMITTED live to Admin Portal via DO
        await doStub.fetch("http://do/sync-broadcast", {
          method: "POST",
          body: JSON.stringify({ type: "FEEDBACK_SUBMITTED", feedback: feedbackObj })
        });

        const res = jsonResponse({ success: true, feedback: feedbackObj }, 201);
        finalizeTelemetry(201);
        return res;
      }

      if (path === "/api/feedback" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM feedback ORDER BY created_at DESC LIMIT 50"
        ).all();
        const res = jsonResponse({ success: true, feedback: results || [] });
        finalizeTelemetry(200);
        return res;
      }

      // 9. Admin Metrics Route
      if (path === "/api/metrics" && request.method === "GET") {
        const totalProds = await env.DB.prepare("SELECT COUNT(*) as count FROM products WHERE is_active = 1").first();
        const totalStock = await env.DB.prepare("SELECT SUM(stock) as sum FROM products WHERE is_active = 1").first();
        const lowStock = await env.DB.prepare("SELECT COUNT(*) as count FROM products WHERE is_active = 1 AND stock <= 5").first();
        const totalOrders = await env.DB.prepare("SELECT COUNT(*) as count, SUM(total_amount) as revenue FROM orders").first();
        const totalFeedback = await env.DB.prepare("SELECT COUNT(*) as count FROM feedback").first();

        const res = jsonResponse({
          success: true,
          metrics: {
            totalProducts: totalProds?.count || 0,
            totalStock: totalStock?.sum || 0,
            lowStockCount: lowStock?.count || 0,
            totalOrders: totalOrders?.count || 0,
            totalRevenue: totalOrders?.revenue || 0,
            totalFeedback: totalFeedback?.count || 0
          }
        });
        finalizeTelemetry(200);
        return res;
      }

      finalizeTelemetry(404);
      return jsonResponse({ error: "Endpoint not found" }, 404);
    } catch (err) {
      console.error("Worker Server Error:", err);
      finalizeTelemetry(500, err);
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }
};
