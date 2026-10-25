export async function onRequest(context) {
  const { request, env } = context;

  // 1. Direct Worker-to-Worker communication through Cloudflare Service Binding (zero latency)
  if (env.API_WORKER && typeof env.API_WORKER.fetch === "function") {
    try {
      return await env.API_WORKER.fetch(request);
    } catch (err) {
      console.warn("API_WORKER service binding failed, falling back to HTTP:", err?.message || err);
    }
  }

  // 2. HTTP fallback: forward to the Worker's public URL.
  // Validate the host so that any invalid/unresolved host (or spaces from account name) safely falls back.
  let backendWorkerHost = (env.CLOUDCART_WORKER_HOST || "").trim();

  if (!backendWorkerHost || /[^a-zA-Z0-9.-]/.test(backendWorkerHost)) {
    backendWorkerHost = "cloudcart-worker.shreesha.workers.dev";
  }

  try {
    const url = new URL(request.url);
    const targetUrl = `https://${backendWorkerHost}${url.pathname}${url.search}`;

    const forwardHeaders = new Headers(request.headers);
    forwardHeaders.set("Host", backendWorkerHost);

    return await fetch(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      redirect: "manual",
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Backend Worker proxy connection error",
        message: err.message,
        host: backendWorkerHost,
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}
