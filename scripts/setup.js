// CloudCart - Cloudflare Provisioning & Deployment Script
// Automatically provisions D1 Database, KV Namespace, and deploys the Worker.
// Inspired by reference implementation pattern.

import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

// ─── Configuration ────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes("--dry-run");
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || (DRY_RUN ? "00000000000000000000000000000000" : "");
const API_TOKEN  = process.env.CLOUDFLARE_API_TOKEN  || (DRY_RUN ? "dry-run-token" : "");
const API_BASE   = "https://api.cloudflare.com/client/v4";

const RESOURCE_NAMES = {
  database : "cloudcart-db",
  kv       : "cloudcart-kv",
  worker   : "cloudcart",
};

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("ERROR: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables are required.");
  process.exit(1);
}

// ─── Cloudflare REST API Helper ───────────────────────────────────────────────
async function cloudflare(path, options = {}) {
  const response = await fetch(`${API_BASE}/accounts/${ACCOUNT_ID}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization : `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (options.allowNotFound && response.status === 404) return null;

  const payload = await response.json().catch(() => null);
  const ok = payload?.success !== false && response.ok;

  if (!ok) {
    const details =
      payload?.errors?.map((e) => e.message).join("; ") ||
      `${response.status} ${response.statusText}`;
    throw new Error(`Cloudflare API ${options.method || "GET"} ${path} failed: ${details}`);
  }

  return payload;
}

// ─── Provision D1 Database ────────────────────────────────────────────────────
async function ensureD1() {
  const payload = await cloudflare("/d1/database?per_page=100");
  const existing = payload.result?.find((db) => db.name === RESOURCE_NAMES.database);
  if (existing) {
    console.log(`✅ Reusing existing D1 database: ${RESOURCE_NAMES.database} (${existing.uuid})`);
    return existing;
  }

  console.log(`🔧 Creating D1 database: ${RESOURCE_NAMES.database}`);
  const created = await cloudflare("/d1/database", {
    method: "POST",
    body: { name: RESOURCE_NAMES.database },
  });
  console.log(`✅ Created D1 database: ${created.result.uuid}`);
  return created.result;
}

// ─── Provision KV Namespace ───────────────────────────────────────────────────
async function ensureKV() {
  const payload = await cloudflare("/storage/kv/namespaces?per_page=1000");
  const existing = payload.result?.find((ns) => ns.title === RESOURCE_NAMES.kv);
  if (existing) {
    console.log(`✅ Reusing existing KV namespace: ${RESOURCE_NAMES.kv} (${existing.id})`);
    return existing;
  }

  console.log(`🔧 Creating KV namespace: ${RESOURCE_NAMES.kv}`);
  const created = await cloudflare("/storage/kv/namespaces", {
    method: "POST",
    body: { title: RESOURCE_NAMES.kv },
  });
  console.log(`✅ Created KV namespace: ${created.result.id}`);
  return created.result;
}

// ─── Generate wrangler.toml with real resource IDs ───────────────────────────
function generateWranglerToml({ databaseId, kvId }) {
  return `name = "cloudcart"
main = "worker/index.js"
compatibility_date = "2024-08-01"
compatibility_flags = ["nodejs_compat"]

# D1 Database Binding (auto-provisioned)
[[d1_databases]]
binding = "DB"
database_name = "${RESOURCE_NAMES.database}"
database_id = "${databaseId}"

# Durable Object Binding for Real-Time Multi-User Synchronization
[[durable_objects.bindings]]
name = "INVENTORY_DO"
class_name = "InventorySyncDO"

# Cloudflare KV Binding for Persistent Cart Session Caching (auto-provisioned)
[[kv_namespaces]]
binding = "CLOUDCART_KV"
id = "${kvId}"

[[migrations]]
tag = "v2"
new_sqlite_classes = ["InventorySyncDO"]

# Cloudflare Assets Configuration for Workers
[assets]
directory = "./public"
binding = "ASSETS"
`;
}

// ─── Run Wrangler Commands ────────────────────────────────────────────────────
function runWrangler(args) {
  const wranglerBin = resolve(
    "node_modules", ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler"
  );

  console.log(`\n▶  wrangler ${args.join(" ")}`);
  if (DRY_RUN) {
    console.log("   (dry run — skipped)");
    return Promise.resolve();
  }

  return new Promise((res, rej) => {
    const child = spawn(wranglerBin, args, {
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN : API_TOKEN,
      },
      stdio: "inherit",
    });

    child.on("error", rej);
    child.on("exit", (code) => {
      if (code === 0) res();
      else rej(new Error(`wrangler exited with code ${code}`));
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log(DRY_RUN
  ? "\n📋 DRY RUN — generating config only, no deployments.\n"
  : "\n🚀 CloudCart — Provisioning Cloudflare resources and deploying...\n"
);

const [database, kv] = DRY_RUN
  ? [
      { name: RESOURCE_NAMES.database, uuid: "00000000-0000-0000-0000-000000000000" },
      { title: RESOURCE_NAMES.kv,      id:   "00000000000000000000000000000000"   },
    ]
  : await Promise.all([ensureD1(), ensureKV()]);

if (!database?.uuid || !kv?.id) {
  throw new Error("Cloudflare returned incomplete resource metadata.");
}

// Write the generated wrangler.toml with real IDs
const wranglerContent = generateWranglerToml({
  databaseId: database.uuid,
  kvId:       kv.id,
});

await writeFile(resolve("wrangler.toml"), wranglerContent, "utf8");
console.log("\n📝 Generated wrangler.toml with real Cloudflare resource IDs.");

if (DRY_RUN) {
  console.log("\n📋 Dry run complete — wrangler.toml generated, deployment skipped.");
  process.exit(0);
}

// Step 1: Apply D1 schema migration (CREATE TABLE + seed data)
console.log("\n📦 Running D1 schema migration on remote database...");
await runWrangler([
  "d1", "execute", "DB",
  "--remote",
  "--file", resolve("schema.sql"),
  "--config", resolve("wrangler.toml"),
]);

// Step 2: Deploy the Worker (serves API + static assets via [assets] binding)
console.log("\n🚀 Deploying CloudCart Worker to Cloudflare...");
await runWrangler([
  "deploy",
  "--config", resolve("wrangler.toml"),
]);

console.log("\n✅ CloudCart deployed successfully to Cloudflare!\n");
