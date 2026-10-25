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
  // CLOUDCART_WORKER_HOST is set dynamically per-account by scripts/setup.js.
  let backendWorkerHost = (env.CLOUDCART_WORKER_HOST || "").trim();

  // If the host is not set or invalid, return a clean 503 response instead of hardcoding any personal domain.
  if (!backendWorkerHost || /[^a-zA-Z0-9.-]/.test(backendWorkerHost)) {
    return new Response(
      JSON.stringify({
        error: "Backend Worker is not connected.",
        hint: "Ensure the API_WORKER service binding is configured in Pages, or deploy via GitHub Actions (scripts/setup.js) to set CLOUDCART_WORKER_HOST automatically.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
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
