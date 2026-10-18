import { InventoryDO, InventorySyncDO } from "./InventoryDO.js";
import { handleObservabilityRoute } from "./observability/routes.js";

export { InventoryDO, InventorySyncDO };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-ID",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Observability routes do not probe dependencies unless explicitly requested.
    if (path.startsWith("/api/observability")) {
      const obsResponse = await handleObservabilityRoute(request, env, ctx, path, url);
      if (obsResponse) return obsResponse;
    }

    // Handle CORS Preflight for storefront/admin API
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const requestId = request.headers.get("X-Request-ID") || `req_${crypto.randomUUID()}`;
    const startedAt = performance.now();

    // ── Durable Object stub ───────────────────────────────────────
    const doId = env.INVENTORY_DO.idFromName("cloudcart-inventory-global");
    const doStub = env.INVENTORY_DO.get(doId);

    let response;
    let errorText = null;

    try {
      response = await handleWorkerRequest(request, env, ctx, url, path, doStub, requestId);
    } catch (err) {
      console.error(JSON.stringify({ level: "ERROR", service: "worker", requestId, message: "Worker request failed", error: String(err?.message || "Unknown error").slice(0, 300) }));
      errorText = "Internal server error";
      response = jsonResponse({ success: false, error: errorText }, 500);
    }

    const httpStatus = response.status;
    const durationMs = Math.round(performance.now() - startedAt);

    if (path.startsWith("/api") && httpStatus >= 500) {
      console.error(JSON.stringify({ level: "ERROR", service: "worker", requestId, endpoint: path, method: request.method, status: httpStatus, durationMs, message: errorText || "Server error" }));
    }

    // ── Propagate traceId in response headers ─────────────────────
    try {
      response.headers.set("X-Request-ID", requestId);
    } catch (_) {
      if (response.status !== 101) {
        const newHeaders = new Headers(response.headers);
        newHeaders.set("X-Request-ID", requestId);
        response = new Response(response.body, { status: response.status, statusText: response.statusText, headers: newHeaders });
      }
    }

    return response;
  }
};

// ─── Request Router ───────────────────────────────────────────────

async function handleWorkerRequest(request, env, ctx, url, path, doStub, requestId) {

  // 1. Real-time WebSocket connection
  if (path === "/api/sync" || request.headers.get("Upgrade") === "websocket") {
    return await doStub.fetch(request);
  }

  // 2. Static assets
  if (!path.startsWith("/api")) {
    if (env.ASSETS) {
      if (path === "/admin") return Response.redirect(`${url.origin}/admin/`, 301);
      if (path === "/admin/monitoring" || path === "/admin/monitoring/") return Response.redirect(`${url.origin}/admin/observability/`, 301);
      return await env.ASSETS.fetch(request);
    }
    return jsonResponse({
      service: "CloudCart Backend API",
      status: "healthy",
      endpoints: ["/api/products", "/api/checkout", "/api/session/cart", "/api/feedback", "/api/metrics", "/api/sync", "/api/observability"]
    });
  }

  // 3. Health check
  if (path === "/api/health") {
    return jsonResponse({ status: "OK", service: "CloudCart Cloudflare API", timestamp: new Date().toISOString() });
  }

  // 4. Products — GET (catalog)
  if (path === "/api/products" && request.method === "GET") {
    const category = url.searchParams.get("category");
    const search = url.searchParams.get("search");

    let query = "SELECT * FROM products WHERE is_active = 1";
    const params = [];

    if (category && category !== "all") { query += " AND category = ?"; params.push(category); }
    if (search) { query += " AND (name LIKE ? OR description LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }
    query += " ORDER BY created_at DESC";

    const stmt = env.DB.prepare(query);
    const { results } = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();
    return jsonResponse({ success: true, products: results || [] });
  }

  // 5. Products — POST (create)
  if (path === "/api/products" && request.method === "POST") {
    const body = await request.json();
    const { name, category, price, stock, description, image_url } = body;

    const trimmedName = typeof name === "string" ? name.trim() : "";
    const trimmedCat = typeof category === "string" ? category.trim() : "";
    const p = parseFloat(price);
    const s = Number(stock);

    if (!trimmedName || !trimmedCat) {
      return jsonResponse({ success: false, error: "Name and category are required." }, 400);
    }
    if (isNaN(p) || p <= 0) {
      return jsonResponse({ success: false, error: "Price must be a positive number." }, 400);
    }
    if (!Number.isInteger(s) || s < 0) {
      return jsonResponse({ success: false, error: "Stock must be a non-negative integer (0 or greater)." }, 400);
    }

    const id = "prod-" + Date.now();
    const defaultImg = image_url || "https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=800&q=80";

    await env.DB.prepare(
      "INSERT INTO products (id, name, category, price, stock, description, image_url, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).bind(id, trimmedName, trimmedCat, p, s, description || "", defaultImg).run();

    const newProd = { id, name: trimmedName, category: trimmedCat, price: p, stock: s, description, image_url: defaultImg, is_active: 1 };

    await doStub.fetch("http://do/sync-broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
      body: JSON.stringify({ type: "PRODUCT_ADDED", product: newProd })
    });

    return jsonResponse({ success: true, product: newProd }, 201);
  }

  // 6. Products — PUT (update)
  if (path.startsWith("/api/products/") && request.method === "PUT") {
    const prodId = path.split("/")[3];
    const body = await request.json();
    const { price, stock, name, category, description, image_url } = body;

    const existing = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(prodId).first();
    if (!existing) return jsonResponse({ success: false, error: "Product not found." }, 404);

    let newPrice = existing.price;
    if (price !== undefined) {
      const p = parseFloat(price);
      if (isNaN(p) || p <= 0) {
        return jsonResponse({ success: false, error: "Price must be a positive number." }, 400);
      }
      newPrice = p;
    }

    let newStock = existing.stock;
    if (stock !== undefined) {
      const s = Number(stock);
      if (!Number.isInteger(s) || s < 0) {
        return jsonResponse({ success: false, error: "Stock must be a non-negative integer (0 or greater)." }, 400);
      }
      newStock = s;
    }

    const newName = (typeof name === "string" && name.trim()) ? name.trim() : existing.name;
    const newCat = (typeof category === "string" && category.trim()) ? category.trim() : existing.category;
    const newDesc = description !== undefined ? String(description) : existing.description;
    const newImg = image_url || existing.image_url;

    await env.DB.prepare(
      "UPDATE products SET name = ?, category = ?, price = ?, stock = ?, description = ?, image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(newName, newCat, newPrice, newStock, newDesc, newImg, prodId).run();

    const updatedProd = { id: prodId, name: newName, category: newCat, price: newPrice, stock: newStock, description: newDesc, image_url: newImg };

    await doStub.fetch("http://do/sync-broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
      body: JSON.stringify({ type: "PRODUCT_UPDATED", product: updatedProd, source: "ADMIN" })
    });

    return jsonResponse({ success: true, product: updatedProd });
  }

  // 7. Products — DELETE (soft delete)
  if (path.startsWith("/api/products/") && request.method === "DELETE") {
    const prodId = path.split("/")[3];

    const existing = await env.DB.prepare("SELECT id, name FROM products WHERE id = ? AND is_active = 1").bind(prodId).first();
    if (!existing) {
      return jsonResponse({ success: false, error: "Product not found or already deleted." }, 404);
    }

    await env.DB.prepare("UPDATE products SET is_active = 0 WHERE id = ?").bind(prodId).run();

    await doStub.fetch("http://do/sync-broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
      body: JSON.stringify({ type: "PRODUCT_DELETED", productId: prodId })
    });

    return jsonResponse({ success: true, message: "Product deleted successfully." });
  }

  // 8. Atomic Checkout (Durable Object)
  if (path === "/api/checkout" && request.method === "POST") {
    const checkoutResp = await doStub.fetch("http://do/atomic-purchase", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-ID": requestId
      },
      body: JSON.stringify(await request.json())
    });
    return checkoutResp;
  }

  // 9. Orders (Admin)
  if (path === "/api/orders" && request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 50").all();
    return jsonResponse({ success: true, orders: results || [] });
  }

  // 10. Session Cart — GET
  if (path === "/api/session/cart" && request.method === "GET") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) return jsonResponse({ success: false, error: "Missing sessionId" }, 400);

    let cartData = [];
    if (env.CLOUDCART_KV) {
      const raw = await env.CLOUDCART_KV.get(`cart:${sessionId}`);
      if (raw) cartData = JSON.parse(raw);
    }
    return jsonResponse({ success: true, cart: cartData });
  }

  // 11. Session Cart — POST
  if (path === "/api/session/cart" && request.method === "POST") {
    const body = await request.json();
    const { sessionId, cart } = body;
    if (!sessionId) return jsonResponse({ success: false, error: "Missing sessionId" }, 400);

    if (env.CLOUDCART_KV) {
      await env.CLOUDCART_KV.put(`cart:${sessionId}`, JSON.stringify(cart || []), { expirationTtl: 604800 });
    }
    return jsonResponse({ success: true, message: "Cart saved to Cloudflare KV" });
  }

  // 12. Feedback — POST
  if (path === "/api/feedback" && request.method === "POST") {
    const body = await request.json();
    const { customer_name, email, rating, comments } = body;

    const trimmedName = typeof customer_name === "string" ? customer_name.trim() : "";
    const trimmedComments = typeof comments === "string" ? comments.trim() : "";
    const r = Number(rating);

    if (!trimmedName || !trimmedComments) {
      return jsonResponse({ success: false, error: "Customer name and comments are required." }, 400);
    }
    if (!Number.isInteger(r) || r < 1 || r > 5) {
      return jsonResponse({ success: false, error: "Rating must be an integer between 1 and 5." }, 400);
    }

    const id = "fb-" + Date.now();
    await env.DB.prepare(
      "INSERT INTO feedback (id, customer_name, email, rating, comments) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, trimmedName, email || "", r, trimmedComments).run();

    const feedbackObj = { id, customer_name: trimmedName, email: email || "", rating: r, comments: trimmedComments, created_at: new Date().toISOString() };

    await doStub.fetch("http://do/sync-broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
      body: JSON.stringify({ type: "FEEDBACK_SUBMITTED", feedback: feedbackObj })
    });

    return jsonResponse({ success: true, feedback: feedbackObj }, 201);
  }

  // 13. Feedback — GET
  if (path === "/api/feedback" && request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM feedback ORDER BY created_at DESC LIMIT 50").all();
    return jsonResponse({ success: true, feedback: results || [] });
  }

  // 14. Admin Business Metrics
  if (path === "/api/metrics" && request.method === "GET") {
    const [totalProds, totalStock, lowStock, totalOrders, totalFeedback] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) as count FROM products WHERE is_active = 1").first(),
      env.DB.prepare("SELECT SUM(stock) as sum FROM products WHERE is_active = 1").first(),
      env.DB.prepare("SELECT COUNT(*) as count FROM products WHERE is_active = 1 AND stock <= 5").first(),
      env.DB.prepare("SELECT COUNT(*) as count, SUM(total_amount) as revenue FROM orders").first(),
      env.DB.prepare("SELECT COUNT(*) as count FROM feedback").first()
    ]);

    return jsonResponse({
      success: true,
      metrics: {
        totalProducts:  totalProds?.count   || 0,
        totalStock:     totalStock?.sum     || 0,
        lowStockCount:  lowStock?.count     || 0,
        totalOrders:    totalOrders?.count  || 0,
        totalRevenue:   totalOrders?.revenue || 0,
        totalFeedback:  totalFeedback?.count || 0
      }
    });
  }

  return jsonResponse({ error: "Endpoint not found" }, 404);
}
