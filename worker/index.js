import { InventoryDO, InventorySyncDO } from "./InventoryDO.js";
import { handleObservabilityRoute } from "./observability/routes.js";
import { startTrace, addSpan, closeSpan, closeTrace } from "./observability/tracing.js";
import { recordRequest, recordBusinessEvent } from "./observability/metrics.js";
import { recordLog, logInfo, logWarn, logError } from "./observability/logManager.js";
import { recordD1Query, recordKVOperation } from "./observability/d1Telemetry.js";

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

    // Route observability API early — before trace instrumentation to avoid self-recording
    if (path.startsWith("/api/observability")) {
      const obsResponse = await handleObservabilityRoute(request, env, ctx, path, url);
      if (obsResponse) return obsResponse;
    }

    // Handle CORS Preflight for storefront/admin API
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Start distributed trace ───────────────────────────────────
    const trace = startTrace(request);
    const requestId = trace.requestId;

    // ── Wrap DB with span instrumentation ─────────────────────────
    const wrappedEnv = { ...env };

    if (env.DB) {
      const origPrepare = env.DB.prepare.bind(env.DB);
      wrappedEnv.DB = {
        prepare: (query) => {
          const stmt = origPrepare(query);
          const isWrite = /^(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)/i.test(query.trim());

          const wrapExec = (fn) => async (...args) => {
            const span = addSpan(trace, {
              service: "d1",
              operation: isWrite ? "db.write" : "db.read",
              attributes: { query: query.substring(0, 150), type: isWrite ? "WRITE" : "READ" }
            });
            const t0 = performance.now();
            try {
              const res = await fn(...args);
              const dur = performance.now() - t0;
              closeSpan(span, { status: "ok" });
              recordD1Query(query, dur, isWrite);
              // Emit WARN log for slow queries
              if (dur > 35) {
                logWarn(`Slow D1 query (${Math.round(dur)}ms): ${query.substring(0, 80)}`, {
                  service: "d1", endpoint: path, durationMs: Math.round(dur)
                }, { traceId: trace.traceId, requestId });
              }
              return res;
            } catch (e) {
              closeSpan(span, { error: e.message });
              recordD1Query(query, performance.now() - t0, isWrite, e.message);
              logError(`D1 query failed: ${e.message}`, e, { service: "d1", endpoint: path }, { traceId: trace.traceId, requestId });
              throw e;
            }
          };

          return {
            bind: (...bArgs) => {
              const bound = stmt.bind(...bArgs);
              return {
                all:   wrapExec(bound.all.bind(bound)),
                run:   wrapExec(bound.run.bind(bound)),
                first: wrapExec(bound.first.bind(bound))
              };
            },
            all:   wrapExec(stmt.all.bind(stmt)),
            run:   wrapExec(stmt.run.bind(stmt)),
            first: wrapExec(stmt.first.bind(stmt))
          };
        }
      };
    }

    // ── Wrap KV with span instrumentation ────────────────────────
    if (env.CLOUDCART_KV) {
      wrappedEnv.CLOUDCART_KV = {
        get: async (...args) => {
          const span = addSpan(trace, { service: "kv", operation: "cache.get", attributes: { key: String(args[0]).substring(0, 80) } });
          const t0 = performance.now();
          try {
            const r = await env.CLOUDCART_KV.get(...args);
            closeSpan(span, { status: "ok" });
            recordKVOperation("get", performance.now() - t0);
            return r;
          } catch (e) {
            closeSpan(span, { error: e.message });
            recordKVOperation("get", performance.now() - t0, e.message);
            throw e;
          }
        },
        put: async (...args) => {
          const span = addSpan(trace, { service: "kv", operation: "cache.put", attributes: { key: String(args[0]).substring(0, 80) } });
          const t0 = performance.now();
          try {
            const r = await env.CLOUDCART_KV.put(...args);
            closeSpan(span, { status: "ok" });
            recordKVOperation("put", performance.now() - t0);
            return r;
          } catch (e) {
            closeSpan(span, { error: e.message });
            recordKVOperation("put", performance.now() - t0, e.message);
            throw e;
          }
        },
        delete: async (...args) => {
          const span = addSpan(trace, { service: "kv", operation: "cache.delete", attributes: { key: String(args[0]).substring(0, 80) } });
          const t0 = performance.now();
          try {
            const r = await env.CLOUDCART_KV.delete(...args);
            closeSpan(span, { status: "ok" });
            recordKVOperation("delete", performance.now() - t0);
            return r;
          } catch (e) {
            closeSpan(span, { error: e.message });
            recordKVOperation("delete", performance.now() - t0, e.message);
            throw e;
          }
        }
      };
    }

    // ── Durable Object stub ───────────────────────────────────────
    const doId = env.INVENTORY_DO.idFromName("cloudcart-inventory-global");
    const doStub = env.INVENTORY_DO.get(doId);

    let response;
    let errorText = null;
    let businessEvent = null;

    try {
      response = await handleWorkerRequest(request, wrappedEnv, ctx, url, path, doStub, requestId, trace);
    } catch (err) {
      console.error("Worker Server Error:", err);
      errorText = err.message;
      response = jsonResponse({ success: false, error: err.message }, 500);
    }

    const httpStatus = response.status;
    const durationMs = Math.round(performance.now() - trace.startMs);

    // ── Determine business event ──────────────────────────────────
    if (path === "/api/products" && request.method === "POST" && httpStatus === 201)                       businessEvent = "PRODUCT_CREATED";
    else if (path.startsWith("/api/products/") && request.method === "PUT" && httpStatus === 200)           businessEvent = "PRODUCT_UPDATED";
    else if (path.startsWith("/api/products/") && request.method === "DELETE" && httpStatus === 200)        businessEvent = "PRODUCT_DELETED";
    else if (path === "/api/checkout" && request.method === "POST" && httpStatus === 200)                   businessEvent = "CHECKOUT_SUCCEEDED";
    else if (path === "/api/checkout" && request.method === "POST" && httpStatus !== 200)                   businessEvent = "CHECKOUT_FAILED";
    else if (path === "/api/feedback" && request.method === "POST" && httpStatus === 201)                   businessEvent = "FEEDBACK_SUBMITTED";

    // ── Emit metrics + log + close trace ─────────────────────────
    if (path.startsWith("/api") && !path.startsWith("/api/observability")) {
      const normalizedEndpoint = path.startsWith("/api/products/") ? "/api/products/:id" : path;

      recordRequest({ traceId: trace.traceId, requestId, endpoint: normalizedEndpoint, method: request.method, status: httpStatus, durationMs, businessEvent, error: errorText });

      if (businessEvent) recordBusinessEvent(businessEvent);

      // Structured log for this request
      const logLevel = httpStatus >= 500 ? "ERROR" : httpStatus >= 400 ? "WARN" : "INFO";
      const logMsg = buildLogMessage(request.method, path, httpStatus, durationMs, businessEvent, errorText);

      recordLog({
        level: logLevel,
        service: "worker",
        traceId: trace.traceId,
        requestId,
        message: logMsg,
        context: { endpoint: normalizedEndpoint, method: request.method, httpStatus, durationMs, businessEvent },
        error: errorText ? { message: errorText } : null
      });
    }

    // ── Finalize trace ────────────────────────────────────────────
    closeTrace(trace, response, { businessEvent });

    // ── Propagate traceId in response headers ─────────────────────
    try {
      response.headers.set("X-Request-ID", requestId);
      response.headers.set("X-Trace-ID", trace.traceId);
    } catch (_) {
      if (response.status !== 101) {
        const newHeaders = new Headers(response.headers);
        newHeaders.set("X-Request-ID", requestId);
        newHeaders.set("X-Trace-ID", trace.traceId);
        response = new Response(response.body, { status: response.status, statusText: response.statusText, headers: newHeaders });
      }
    }

    return response;
  }
};

// ─── Business log message builder ────────────────────────────────

function buildLogMessage(method, path, status, durationMs, businessEvent, errorText) {
  if (businessEvent === "PRODUCT_CREATED")   return "Product created successfully in D1 catalog";
  if (businessEvent === "PRODUCT_UPDATED")   return "Product updated in D1 and broadcast via InventoryDO";
  if (businessEvent === "PRODUCT_DELETED")   return "Product soft-deleted from D1 and broadcast via InventoryDO";
  if (businessEvent === "CHECKOUT_SUCCEEDED") return "Atomic checkout transaction completed — stock deducted, order created";
  if (businessEvent === "CHECKOUT_FAILED")   return "Checkout rejected — insufficient stock or validation error";
  if (businessEvent === "FEEDBACK_SUBMITTED") return "Customer feedback stored in D1 and broadcast via InventoryDO";
  if (status >= 500) return `Server error on ${method} ${path}: ${errorText || "Internal error"}`;
  if (status === 404) return `Resource not found: ${method} ${path}`;
  if (status >= 400)  return `Bad request: ${method} ${path}`;
  return `${method} ${path} → ${status} (${durationMs}ms)`;
}

// ─── Request Router ───────────────────────────────────────────────

async function handleWorkerRequest(request, env, ctx, url, path, doStub, requestId, trace) {

  // 1. Real-time WebSocket connection
  if (path === "/api/sync" || request.headers.get("Upgrade") === "websocket") {
    return await doStub.fetch(request);
  }

  // 2. Static assets
  if (!path.startsWith("/api")) {
    if (env.ASSETS) {
      if (path === "/admin") return Response.redirect(`${url.origin}/admin/`, 301);
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

    if (!name || !category || price === undefined || stock === undefined) {
      return jsonResponse({ success: false, error: "Missing required product fields." }, 400);
    }

    const id = "prod-" + Date.now();
    const defaultImg = image_url || "https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=800&q=80";

    await env.DB.prepare(
      "INSERT INTO products (id, name, category, price, stock, description, image_url, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).bind(id, name, category, parseFloat(price), parseInt(stock), description || "", defaultImg).run();

    const newProd = { id, name, category, price: parseFloat(price), stock: parseInt(stock), description, image_url: defaultImg, is_active: 1 };

    const doSpan = addSpan(trace, { service: "inventory_do", operation: "do.broadcast", attributes: { type: "PRODUCT_ADDED" } });
    await doStub.fetch("http://do/sync-broadcast", { method: "POST", body: JSON.stringify({ type: "PRODUCT_ADDED", product: newProd }) });
    closeSpan(doSpan);

    logInfo(`Product created: "${name}" (${category}) @ ₹${price}`, { service: "worker", endpoint: "/api/products", httpStatus: 201, businessEvent: "PRODUCT_CREATED" }, { traceId: trace.traceId, requestId });

    return jsonResponse({ success: true, product: newProd }, 201);
  }

  // 6. Products — PUT (update)
  if (path.startsWith("/api/products/") && request.method === "PUT") {
    const prodId = path.split("/")[3];
    const body = await request.json();
    const { price, stock, name, category, description, image_url } = body;

    const existing = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(prodId).first();
    if (!existing) return jsonResponse({ success: false, error: "Product not found." }, 404);

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

    const doSpan = addSpan(trace, { service: "inventory_do", operation: "do.broadcast", attributes: { type: "PRODUCT_UPDATED" } });
    await doStub.fetch("http://do/sync-broadcast", { method: "POST", body: JSON.stringify({ type: "PRODUCT_UPDATED", product: updatedProd, source: "ADMIN" }) });
    closeSpan(doSpan);

    return jsonResponse({ success: true, product: updatedProd });
  }

  // 7. Products — DELETE (soft delete)
  if (path.startsWith("/api/products/") && request.method === "DELETE") {
    const prodId = path.split("/")[3];
    await env.DB.prepare("UPDATE products SET is_active = 0 WHERE id = ?").bind(prodId).run();

    const doSpan = addSpan(trace, { service: "inventory_do", operation: "do.broadcast", attributes: { type: "PRODUCT_DELETED" } });
    await doStub.fetch("http://do/sync-broadcast", { method: "POST", body: JSON.stringify({ type: "PRODUCT_DELETED", productId: prodId }) });
    closeSpan(doSpan);

    return jsonResponse({ success: true, message: "Product deleted successfully." });
  }

  // 8. Atomic Checkout (Durable Object)
  if (path === "/api/checkout" && request.method === "POST") {
    const doSpan = addSpan(trace, { service: "inventory_do", operation: "do.atomic_purchase" });
    const checkoutResp = await doStub.fetch("http://do/atomic-purchase", {
      method: "POST",
      body: JSON.stringify(await request.json())
    });
    closeSpan(doSpan, { status: checkoutResp.ok ? "ok" : "error" });
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

    if (!customer_name || !rating || !comments) {
      return jsonResponse({ success: false, error: "Missing required feedback fields." }, 400);
    }

    const id = "fb-" + Date.now();
    await env.DB.prepare(
      "INSERT INTO feedback (id, customer_name, email, rating, comments) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, customer_name, email || "", parseInt(rating), comments).run();

    const feedbackObj = { id, customer_name, email: email || "", rating: parseInt(rating), comments, created_at: new Date().toISOString() };

    const doSpan = addSpan(trace, { service: "inventory_do", operation: "do.broadcast", attributes: { type: "FEEDBACK_SUBMITTED" } });
    await doStub.fetch("http://do/sync-broadcast", { method: "POST", body: JSON.stringify({ type: "FEEDBACK_SUBMITTED", feedback: feedbackObj }) });
    closeSpan(doSpan);

    logInfo(`Customer feedback submitted: ${rating}★ from ${customer_name}`, { service: "worker", endpoint: "/api/feedback", httpStatus: 201, businessEvent: "FEEDBACK_SUBMITTED" }, { traceId: trace.traceId, requestId });

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
