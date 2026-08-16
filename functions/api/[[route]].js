// Cloudflare Pages Function: /functions/api/[[route]].js
// Proxies all incoming /api/* HTTP requests and WebSocket connections to the cloudcart-worker backend
// using the Cloudflare Service Binding (env.API_WORKER).

export async function onRequest(context) {
  const { request, env } = context;

  // If the Cloudflare Service Binding is active, forward the request at zero-latency edge IPC
  if (env.API_WORKER && typeof env.API_WORKER.fetch === "function") {
    return await env.API_WORKER.fetch(request);
  }

  return new Response(
    JSON.stringify({
      error: "Service binding 'API_WORKER' is not attached to Cloudflare Pages.",
      solution: "Bind API_WORKER to cloudcart-worker service in Pages Settings -> Functions -> Service Bindings."
    }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" }
    }
  );
}
