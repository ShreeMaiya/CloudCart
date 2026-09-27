// CloudCart Monitoring - Cloudflare GraphQL Analytics API Client
import { validateCredentials } from "./schema.js";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/**
 * Execute a GraphQL query against Cloudflare Analytics API
 * Safely handles authorization, timeouts, and API error formatting.
 */
export async function executeGraphQL(env, query, variables = {}) {
  const credCheck = validateCredentials(env);
  if (!credCheck.isValid) {
    return {
      ok: false,
      isConfigured: false,
      error: credCheck.reason,
      data: null
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7000); // 7s timeout guard

  try {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${credCheck.apiToken}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return {
        ok: false,
        isConfigured: true,
        error: `Cloudflare GraphQL API HTTP ${res.status}: ${res.statusText}`,
        status: res.status,
        data: null
      };
    }

    const payload = await res.json();
    if (payload.errors && payload.errors.length > 0) {
      const errorMsg = payload.errors.map(e => e.message).join("; ");
      return {
        ok: false,
        isConfigured: true,
        error: `Cloudflare GraphQL error: ${errorMsg}`,
        errors: payload.errors,
        data: payload.data || null
      };
    }

    return {
      ok: true,
      isConfigured: true,
      data: payload.data,
      errors: null
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      ok: false,
      isConfigured: true,
      error: err.name === "AbortError" ? "Cloudflare GraphQL query timed out after 7s." : err.message,
      data: null
    };
  }
}
