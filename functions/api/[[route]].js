export async function onRequest(context) {
  const { request, env } = context;

  // 1. Direct Worker-to-Worker communication through a Cloudflare Service Binding without an external HTTP network hop
  if (env.API_WORKER && typeof env.API_WORKER.fetch === "function") {
    return await env.API_WORKER.fetch(request);
  }

  // 2. Seamless Edge Proxy Fallback to cloudcart-worker
  const url = new URL(request.url);
  const backendWorkerHost = "cloudcart-worker.shreesha.workers.dev";
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
