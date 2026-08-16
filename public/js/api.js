// CloudCart API & Real-time WebSocket Client

const isLocalHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
export const API_BASE = isLocalHost ? "http://127.0.0.1:8787/api" : (window.location.protocol === "file:" ? "http://127.0.0.1:8787/api" : "/api");

export async function fetchProducts(category = 'all', search = '') {
  try {
    const url = new URL(`${API_BASE}/products`);
    if (category && category !== 'all') url.searchParams.append('category', category);
    if (search) url.searchParams.append('search', search);

    const res = await fetch(url.toString());
    const data = await res.json();
    return data.products || [];
  } catch (err) {
    console.error("Error fetching products:", err);
    return [];
  }
}

export async function submitCheckout(items, customerName = "Guest Customer") {
  try {
    const res = await fetch(`${API_BASE}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, customerName })
    });
    return await res.json();
  } catch (err) {
    console.error("Checkout error:", err);
    return { success: false, error: "Network error during checkout." };
  }
}

export async function fetchKVCart(sessionId) {
  try {
    const res = await fetch(`${API_BASE}/session/cart?sessionId=${sessionId}`);
    const data = await res.json();
    return data.cart || [];
  } catch (err) {
    console.error("Error fetching KV cart:", err);
    return [];
  }
}

export async function saveKVCart(sessionId, cart) {
  try {
    await fetch(`${API_BASE}/session/cart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, cart })
    });
  } catch (err) {
    console.error("Error saving KV cart:", err);
  }
}

export async function submitFeedback(feedbackData) {
  try {
    const res = await fetch(`${API_BASE}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(feedbackData)
    });
    return await res.json();
  } catch (err) {
    console.error("Feedback submit error:", err);
    return { success: false, error: "Network error submitting feedback." };
  }
}

export async function fetchFeedbackList() {
  try {
    const res = await fetch(`${API_BASE}/feedback`);
    const data = await res.json();
    return data.feedback || [];
  } catch (err) {
    console.error("Error fetching feedback:", err);
    return [];
  }
}

export function initRealtimeSync(onEventCallback, onStatusCallback) {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  let wsHost = window.location.host;
  if (isLocalHost || window.location.protocol === "file:") {
    wsHost = "127.0.0.1:8787";
  }

  const wsUrl = `${wsProtocol}//${wsHost}/api/sync`;
  let socket = null;

  function connect() {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log("⚡ Connected to Cloudflare CloudCart Sync Server");
      if (onStatusCallback) onStatusCallback(true);
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (onEventCallback) onEventCallback(data);
      } catch (e) {
        console.error("Error parsing WS message:", e);
      }
    };

    socket.onclose = () => {
      console.warn("WebSocket sync closed. Reconnecting in 3s...");
      if (onStatusCallback) onStatusCallback(false);
      setTimeout(connect, 3000);
    };

    socket.onerror = (err) => {
      console.error("WebSocket error:", err);
      socket.close();
    };
  }

  connect();
}
