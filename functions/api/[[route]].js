export async function onRequest(context) {
  const { request, env } = context;

  // 1. Direct Worker-to-Worker communication through a Cloudflare Service Binding without an external HTTP network hop
  // This is the primary (and preferred) path — zero latency, no external network hop.
  if (env.API_WORKER && typeof env.API_WORKER.fetch === "function") {
    return await env.API_WORKER.fetch(request);
  }

  // 2. HTTP fallback: forward to the Worker's public URL.
  // CLOUDCART_WORKER_HOST is a Pages environment variable set automatically by scripts/setup.js.
  // Format: <worker-name>.<your-cloudflare-subdomain>.workers.dev
  // You can also set it manually in the Cloudflare Pages dashboard under Settings > Environment Variables.
  const backendWorkerHost = env.CLOUDCART_WORKER_HOST;

  if (!backendWorkerHost) {
    return new Response(
      JSON.stringify({
        error: "API_WORKER service binding is not configured and CLOUDCART_WORKER_HOST env var is missing.",
        hint: "Deploy via GitHub Actions (scripts/setup.js) or set the CLOUDCART_WORKER_HOST Pages variable manually.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

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
}
