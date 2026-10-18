export async function onRequest(context) {
  const { request, env } = context;

  // Route API requests through the provisioned Pages-to-Worker service binding.
  if (env.API_WORKER && typeof env.API_WORKER.fetch === "function") {
    return await env.API_WORKER.fetch(request);
  }

  return new Response(JSON.stringify({
    success: false,
    error: "The API_WORKER Pages service binding is not configured."
  }), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}
