export async function onRequest(context) {
  const { request, env } = context;

  // 1. If Cloudflare Service Binding is attached, use direct zero-latency Edge IPC
  if (env.API_WORKER && typeof env.API_WORKER.fetch === "function") {
    return await env.API_WORKER.fetch(request);
  }

  // 2. Seamless Edge Proxy Fallback to cloudcart-worker
  const url = new URL(request.url);
  const backendWorkerHost = "cloudcart-worker.shreesha.workers.dev";
  const targetUrl = `https://${backendWorkerHost}${url.pathname}${url.search}`;

  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.set("Host", backendWorkerHost);

  // Preserve WebSocket Upgrade if client is requesting /api/sync WebSocket
  const isWebSocket = request.headers.get("Upgrade") === "websocket";

  return await fetch(targetUrl, {
    method: request.method,
    headers: forwardHeaders,
    body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
    redirect: "manual",
  });
}
