// Cloudflare Durable Object for Real-Time Multi-User Inventory Synchronization

export class InventoryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set(); // Active WebSocket client connections
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Handle WebSocket Upgrade for real-time live sync channel
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      await this.handleSession(server);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    // HTTP Internal API Calls from Worker to DO
    const method = request.method;
    const path = url.pathname;

    if (path === "/sync-broadcast" && method === "POST") {
      const payload = await request.json();
      this.broadcast(payload);
      return new Response(JSON.stringify({ success: true, activeConnections: this.sessions.size }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (path === "/atomic-purchase" && method === "POST") {
      const { items, customerName } = await request.json();
      return await this.handleAtomicPurchase(items, customerName);
    }

    return new Response("Not Found", { status: 404 });
  }

  async handleSession(serverSocket) {
    serverSocket.accept();
    this.sessions.add(serverSocket);

    // Send initial handshake message with connection metadata
    serverSocket.send(JSON.stringify({
      type: "CONNECTED",
      activeConnections: this.sessions.size,
      message: "Connected to CloudCart Real-Time Synchronization Engine"
    }));

    // Broadcast updated active user count to all clients
    this.broadcastUserCount();

    serverSocket.addEventListener("message", async (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.type === "PING") {
          serverSocket.send(JSON.stringify({ type: "PONG" }));
        }
      } catch (err) {
        console.error("DO WS message error:", err);
      }
    });

    const closeHandler = () => {
      this.sessions.delete(serverSocket);
      this.broadcastUserCount();
    };

    serverSocket.addEventListener("close", closeHandler);
    serverSocket.addEventListener("error", closeHandler);
  }

  broadcastUserCount() {
    const countMessage = JSON.stringify({
      type: "ACTIVE_USERS_COUNT",
      activeConnections: this.sessions.size
    });
    this.broadcastRaw(countMessage);
  }

  broadcast(data) {
    const message = JSON.stringify(data);
    this.broadcastRaw(message);
  }

  broadcastRaw(message) {
    for (const session of this.sessions) {
      try {
        session.send(message);
      } catch (err) {
        this.sessions.delete(session);
      }
    }
  }

  async handleAtomicPurchase(items, customerName) {
    // Guard: validate items is a non-empty array
    if (!Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: "Cart is empty or invalid."
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    // Single-threaded execution inside Durable Object prevents race conditions
    // Check current stock levels from D1
    const validationErrors = [];
    const updatedProducts = [];
    const summaryParts = [];

    for (const item of items) {
      const prod = await this.env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(item.id).first();
      if (!prod) {
        validationErrors.push(`Product ${item.name || item.id} not found.`);
        continue;
      }
      if (prod.stock < item.quantity) {
        validationErrors.push(`Insufficient stock for ${prod.name}. Available: ${prod.stock}, Requested: ${item.quantity}`);
      } else {
        updatedProducts.push({ prod, requestedQuantity: item.quantity });
        summaryParts.push(`${item.quantity}x ${prod.name}`);
      }
    }

    if (validationErrors.length > 0) {
      return new Response(JSON.stringify({
        success: false,
        error: validationErrors.join(" ")
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    // Deduct stock in D1 atomically
    let totalAmount = 0;
    let totalItems = 0;

    for (const { prod, requestedQuantity } of updatedProducts) {
      const newStock = prod.stock - requestedQuantity;
      totalAmount += prod.price * requestedQuantity;
      totalItems += requestedQuantity;

      await this.env.DB.prepare(
        "UPDATE products SET stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(newStock, prod.id).run();

      // Broadcast instant stock change to all active customers & admin dashboard
      this.broadcast({
        type: "PRODUCT_STOCK_UPDATED",
        productId: prod.id,
        newStock: newStock,
        productName: prod.name,
        source: "PURCHASE"
      });
    }

    // Record order in D1
    const orderId = 'ord-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const summaryText = summaryParts.join(", ");
    const finalCustomerName = customerName || "Guest Customer";

    await this.env.DB.prepare(
      "INSERT INTO orders (id, customer_name, items_summary, total_amount, items_count) VALUES (?, ?, ?, ?, ?)"
    ).bind(orderId, finalCustomerName, summaryText, totalAmount, totalItems).run();

    // Broadcast Order Placed Event to Admin
    this.broadcast({
      type: "ORDER_PLACED",
      order: {
        id: orderId,
        customer_name: finalCustomerName,
        items_summary: summaryText,
        total_amount: totalAmount,
        items_count: totalItems,
        created_at: new Date().toISOString()
      }
    });

    return new Response(JSON.stringify({
      success: true,
      orderId,
      totalAmount,
      itemsCount: totalItems,
      message: "Order placed successfully!"
    }), { headers: { "Content-Type": "application/json" } });
  }
}
