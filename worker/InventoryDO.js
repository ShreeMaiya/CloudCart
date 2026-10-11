// Cloudflare Durable Object for Real-Time Multi-User Inventory Synchronization

export class InventoryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set(); // Active WebSocket client connections
    
    // Telemetry & Lifecycle Instrumentation
    this.totalConnectionsOpened = 0;
    this.totalConnectionsClosed = 0;
    this.totalMessagesSent = 0;
    this.totalMessagesReceived = 0;
    this.connectionErrors = 0;
    this.totalPurchases = 0;
    this.purchaseErrors = 0;
    this.purchaseLatencies = [];
    this.startedAt = new Date().toISOString();
  }

  emitLog(level, message, context = {}, traceMeta = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      service: "inventory_do",
      message,
      traceId: traceMeta.traceId || null,
      spanId: traceMeta.spanId || null,
      requestId: traceMeta.requestId || null,
      context
    };
    const line = JSON.stringify(entry);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const traceMeta = {
      traceId: request.headers.get("X-Trace-ID") || null,
      spanId: request.headers.get("X-Span-ID") || null,
      requestId: request.headers.get("X-Request-ID") || null
    };

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

    if (path === "/health-ping") {
      return new Response(JSON.stringify({
        status: "OK",
        role: "Real-time inventory synchronization and atomic inventory coordination.",
        activeConnections: this.sessions.size,
        timestamp: new Date().toISOString()
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (path === "/metrics") {
      const avgPurchaseLat = this.purchaseLatencies.length > 0
        ? Math.round(this.purchaseLatencies.reduce((a, b) => a + b, 0) / this.purchaseLatencies.length)
        : 0;

      return new Response(JSON.stringify({
        success: true,
        role: "Real-time inventory synchronization and atomic inventory coordination.",
        className: "InventoryDO",
        activeConnections: this.sessions.size,
        totalConnectionsOpened: this.totalConnectionsOpened,
        totalConnectionsClosed: this.totalConnectionsClosed,
        totalMessagesSent: this.totalMessagesSent,
        totalMessagesReceived: this.totalMessagesReceived,
        connectionErrors: this.connectionErrors,
        totalPurchases: this.totalPurchases,
        purchaseErrors: this.purchaseErrors,
        avgPurchaseLatencyMs: avgPurchaseLat,
        recentPurchaseLatencies: this.purchaseLatencies.slice(-10),
        startedAt: this.startedAt,
        timestamp: new Date().toISOString()
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (path === "/sync-broadcast" && method === "POST") {
      const payload = await request.json();
      this.broadcast(payload);
      this.emitLog("info", `Broadcasted ${payload.type || "EVENT"} to ${this.sessions.size} connected clients`, {
        broadcastType: payload.type,
        activeClients: this.sessions.size
      }, traceMeta);
      return new Response(JSON.stringify({ success: true, activeConnections: this.sessions.size }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (path === "/atomic-purchase" && method === "POST") {
      const { items, customerName } = await request.json();
      return await this.handleAtomicPurchase(items, customerName, traceMeta);
    }

    return new Response("Not Found", { status: 404 });
  }

  async handleSession(serverSocket) {
    serverSocket.accept();
    this.sessions.add(serverSocket);
    this.totalConnectionsOpened++;

    this.emitLog("info", "WebSocket client connected", {
      activeConnections: this.sessions.size,
      totalOpened: this.totalConnectionsOpened
    });

    // Send initial handshake message with connection metadata
    serverSocket.send(JSON.stringify({
      type: "CONNECTED",
      activeConnections: this.sessions.size,
      message: "Connected to CloudCart Real-Time Synchronization Engine"
    }));

    // Broadcast updated active user count to all clients
    this.broadcastUserCount();

    serverSocket.addEventListener("message", async (evt) => {
      this.totalMessagesReceived++;
      try {
        const data = JSON.parse(evt.data);
        if (data.type === "PING") {
          serverSocket.send(JSON.stringify({ type: "PONG" }));
        }
      } catch (err) {
        this.emitLog("warn", "DO WebSocket message parse error", { error: err.message });
      }
    });

    const closeHandler = () => {
      this.sessions.delete(serverSocket);
      this.totalConnectionsClosed++;
      this.emitLog("info", "WebSocket client disconnected", {
        activeConnections: this.sessions.size,
        totalClosed: this.totalConnectionsClosed
      });
      this.broadcastUserCount();
    };

    serverSocket.addEventListener("close", closeHandler);
    serverSocket.addEventListener("error", (err) => {
      this.connectionErrors++;
      this.emitLog("error", "WebSocket client socket error", {
        error: err?.message || "Unknown socket error"
      });
      closeHandler();
    });
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
    this.totalMessagesSent += this.sessions.size;
    for (const session of this.sessions) {
      try {
        session.send(message);
      } catch (err) {
        this.sessions.delete(session);
      }
    }
  }

  async handleAtomicPurchase(items, customerName, traceMeta = {}) {
    const purchaseStart = performance.now();

    // Guard: validate items is a non-empty array
    if (!Array.isArray(items) || items.length === 0) {
      this.purchaseErrors++;
      this.emitLog("warn", "Atomic purchase failed: cart is empty or invalid", { error: "Cart is empty" }, traceMeta);
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
      this.purchaseErrors++;
      this.emitLog("warn", `Atomic purchase stock validation failed: ${validationErrors.join("; ")}`, {
        errors: validationErrors,
        customerName: customerName || "Guest"
      }, traceMeta);
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

    const durationMs = Math.round(performance.now() - purchaseStart);
    this.totalPurchases++;
    this.purchaseLatencies.push(durationMs);
    if (this.purchaseLatencies.length > 50) this.purchaseLatencies.shift();

    this.emitLog("info", `Atomic checkout completed: Order ${orderId} (₹${totalAmount}, ${totalItems} items) in ${durationMs}ms`, {
      orderId,
      customerName: finalCustomerName,
      totalAmount,
      totalItems,
      durationMs
    }, traceMeta);

    return new Response(JSON.stringify({
      success: true,
      orderId,
      totalAmount,
      itemsCount: totalItems,
      durationMs,
      message: "Order placed successfully!"
    }), { headers: { "Content-Type": "application/json" } });
  }
}

export class InventorySyncDO extends InventoryDO {}
