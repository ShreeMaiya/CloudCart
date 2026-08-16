import { InventorySyncDO } from "./InventoryDO.js";

export { InventorySyncDO };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

    const url = new URL(request.url);
    const path = url.pathname;

    // Durable Object instance getter (single global instance for CloudCart catalog sync)
    const doId = env.INVENTORY_DO.idFromName("cloudcart-inventory-global");
    const doStub = env.INVENTORY_DO.get(doId);

    try {
      // 1. Real-time WebSocket connection route
      if (path === "/api/sync" || request.headers.get("Upgrade") === "websocket") {
        return await doStub.fetch(request);
      }

      // 2. Serve static frontend assets for non-API routes
      if (!path.startsWith("/api")) {
        if (env.ASSETS) {
          if (path === "/admin") {
            return Response.redirect(`${url.origin}/admin/`, 301);
          }
          return await env.ASSETS.fetch(request);
        }
      }

      // 3. Health check route
      if (path === "/api/health") {
        return jsonResponse({
          status: "OK",
          service: "CloudCart Cloudflare API",
          timestamp: new Date().toISOString()
        });
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

        return jsonResponse({ success: true, products: results || [] });
      }

      // Admin - Create Product
      if (path === "/api/products" && request.method === "POST") {
        const body = await request.json();
        const { name, category, price, stock, description, image_url } = body;

        if (!name || !category || price === undefined || stock === undefined) {
          return jsonResponse({ success: false, error: "Missing required product fields." }, 400);
        }

        const id = 'prod-' + Date.now();
        const defaultImg = image_url || 'https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=800&q=80';

        await env.DB.prepare(
          "INSERT INTO products (id, name, category, price, stock, description, image_url, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
        ).bind(id, name, category, parseFloat(price), parseInt(stock), description || "", defaultImg).run();

        const newProd = { id, name, category, price: parseFloat(price), stock: parseInt(stock), description, image_url: defaultImg, is_active: 1 };

        // Broadcast new product insertion to all active customer sessions via DO
        await doStub.fetch("http://do/sync-broadcast", {
          method: "POST",
          body: JSON.stringify({ type: "PRODUCT_ADDED", product: newProd })
        });

        return jsonResponse({ success: true, product: newProd }, 201);
      }

      // Single Product / Stock Update Endpoint
      if (path.startsWith("/api/products/") && request.method === "PUT") {
        const prodId = path.split("/")[3];
        const body = await request.json();
        const { price, stock, name, category, description, image_url } = body;

        const existing = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(prodId).first();
        if (!existing) {
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

        // Broadcast sync to all open browser windows via DO
        await doStub.fetch("http://do/sync-broadcast", {
          method: "POST",
          body: JSON.stringify({
            type: "PRODUCT_UPDATED",
            product: updatedProd,
            source: "ADMIN"
          })
        });

        return jsonResponse({ success: true, product: updatedProd });
      }

      // Admin - Delete Product (Soft delete)
      if (path.startsWith("/api/products/") && request.method === "DELETE") {
        const prodId = path.split("/")[3];
        await env.DB.prepare("UPDATE products SET is_active = 0 WHERE id = ?").bind(prodId).run();

        // Broadcast deletion to all users
        await doStub.fetch("http://do/sync-broadcast", {
          method: "POST",
          body: JSON.stringify({ type: "PRODUCT_DELETED", productId: prodId })
        });

        return jsonResponse({ success: true, message: "Product deleted successfully." });
      }

      // 5. Atomic Multi-User Checkout Route (Handled by Durable Object)
      if (path === "/api/checkout" && request.method === "POST") {
        return await doStub.fetch("http://do/atomic-purchase", {
          method: "POST",
          body: JSON.stringify(await request.json())
        });
      }

      // 6. Orders List Route (Admin)
      if (path === "/api/orders" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM orders ORDER BY created_at DESC LIMIT 50"
        ).all();
        return jsonResponse({ success: true, orders: results || [] });
      }

      // 7. Cloudflare KV Session Cart Persistent Routes
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

      if (path === "/api/session/cart" && request.method === "POST") {
        const body = await request.json();
        const { sessionId, cart } = body;
        if (!sessionId) return jsonResponse({ success: false, error: "Missing sessionId" }, 400);

        if (env.CLOUDCART_KV) {
          // Save cart in Cloudflare KV with 7 days expiration (604800 seconds)
          await env.CLOUDCART_KV.put(`cart:${sessionId}`, JSON.stringify(cart || []), { expirationTtl: 604800 });
        }
        return jsonResponse({ success: true, message: "Cart saved to Cloudflare KV" });
      }

      // 8. Customer Feedback Routes
      if (path === "/api/feedback" && request.method === "POST") {
        const body = await request.json();
        const { customer_name, email, rating, comments } = body;

        if (!customer_name || !rating || !comments) {
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

        return jsonResponse({ success: true, feedback: feedbackObj }, 201);
      }

      if (path === "/api/feedback" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM feedback ORDER BY created_at DESC LIMIT 50"
        ).all();
        return jsonResponse({ success: true, feedback: results || [] });
      }

      // 9. Admin Metrics Route
      if (path === "/api/metrics" && request.method === "GET") {
        const totalProds = await env.DB.prepare("SELECT COUNT(*) as count FROM products WHERE is_active = 1").first();
        const totalStock = await env.DB.prepare("SELECT SUM(stock) as sum FROM products WHERE is_active = 1").first();
        const lowStock = await env.DB.prepare("SELECT COUNT(*) as count FROM products WHERE is_active = 1 AND stock <= 5").first();
        const totalOrders = await env.DB.prepare("SELECT COUNT(*) as count, SUM(total_amount) as revenue FROM orders").first();
        const totalFeedback = await env.DB.prepare("SELECT COUNT(*) as count FROM feedback").first();

        return jsonResponse({
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
      }

      return jsonResponse({ error: "Endpoint not found" }, 404);
    } catch (err) {
      console.error("Worker Server Error:", err);
      return jsonResponse({ success: false, error: err.message }, 500);
    }
  }
};
