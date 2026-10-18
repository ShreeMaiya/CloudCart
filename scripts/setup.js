// CloudCart - Cloudflare Provisioning & Deployment Script
// Provisions D1 Database, KV Namespace, Backend Worker (cloudcart-worker),
// and Cloudflare Pages (cloudcart) connected via Service Bindings.

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
  worker   : "cloudcart-worker",
  pages    : "cloudcart",
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

// ─── Ensure Pages Project with Service Binding ───────────────────────────────
async function ensurePages() {
  const existing = await cloudflare(`/pages/projects/${RESOURCE_NAMES.pages}`, {
    allowNotFound: true,
  });

  const serviceBindingConfig = {
    production: {
      service_bindings: {
        API_WORKER: { service: RESOURCE_NAMES.worker, environment: "production" }
      }
    },
    preview: {
      service_bindings: {
        API_WORKER: { service: RESOURCE_NAMES.worker, environment: "production" }
      }
    }
  };

  if (existing && existing.result) {
    console.log(`✅ Reusing existing Cloudflare Pages project: ${RESOURCE_NAMES.pages}`);
    try {
      await cloudflare(`/pages/projects/${RESOURCE_NAMES.pages}`, {
        method: "PATCH",
        body: {
          deployment_configs: serviceBindingConfig
        }
      });
      console.log(`🔗 Service binding 'API_WORKER -> ${RESOURCE_NAMES.worker}' configured for Pages.`);
    } catch (err) {
      console.log(`ℹ️ Note on Pages Service Binding config: ${err.message}`);
    }
    return existing.result;
  }

  console.log(`🔧 Creating Cloudflare Pages project: ${RESOURCE_NAMES.pages}`);
  const created = await cloudflare("/pages/projects", {
    method: "POST",
    body: {
      name: RESOURCE_NAMES.pages,
      production_branch: "main",
      deployment_configs: serviceBindingConfig
    },
  });
  console.log(`✅ Created Cloudflare Pages project: ${RESOURCE_NAMES.pages}`);
  return created.result;
}

// ─── Generate wrangler.toml with real resource IDs ───────────────────────────
function generateWranglerToml({ databaseId, kvId }) {
  return `name = "${RESOURCE_NAMES.worker}"
main = "worker/index.js"
compatibility_date = "2026-10-18"
compatibility_flags = ["nodejs_compat"]

[vars]
CF_ACCOUNT_ID = "${ACCOUNT_ID}"
CF_WORKER_NAME = "${RESOURCE_NAMES.worker}"
CF_D1_DATABASE_ID = "${databaseId}"

[observability]
enabled = true

[observability.logs]
enabled = true
invocation_logs = true
head_sampling_rate = 1.0
redact_query_string = true

[observability.traces]
enabled = false

# Enable Smart Placement to run Worker close to D1 and minimize cross-region query RTT
[placement]
mode = "smart"

# D1 Database Binding (auto-provisioned)
[[d1_databases]]
binding = "DB"
database_name = "${RESOURCE_NAMES.database}"
database_id = "${databaseId}"

# Durable Object Binding for Real-Time Multi-User Synchronization
[[durable_objects.bindings]]
name = "INVENTORY_DO"
class_name = "InventoryDO"

# Cloudflare KV Binding for Persistent Cart Session Caching (auto-provisioned)
[[kv_namespaces]]
binding = "CLOUDCART_KV"
id = "${kvId}"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["InventoryDO"]
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

// Send a secret through Wrangler stdin so its value is never printed in CI logs.
function putWranglerSecret(name, value) {
  const wranglerBin = resolve(
    "node_modules", ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler"
  );

  if (!value) {
    console.log(`ℹ️ Skipping Worker secret ${name}; its GitHub Actions secret is not configured.`);
    return Promise.resolve();
  }

  console.log(`\n▶  wrangler secret put ${name}`);
  return new Promise((res, rej) => {
    const child = spawn(wranglerBin, ["secret", "put", name, "--config", resolve("wrangler.toml")], {
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: API_TOKEN,
      },
      stdio: ["pipe", "inherit", "inherit"],
    });

    child.on("error", rej);
    child.on("exit", (code) => {
      if (code === 0) res();
      else rej(new Error(`wrangler secret put ${name} exited with code ${code}`));
    });
    child.stdin.end(value);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log(DRY_RUN
  ? "\n📋 DRY RUN — generating config only, no deployments.\n"
  : "\n🚀 CloudCart — Provisioning Cloudflare resources (Pages + Workers + D1 + KV + DO)...\n"
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

// Write the generated wrangler.toml with real IDs for the backend worker
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

// Step 1: Apply D1 database schema (tables & indexes only — no seed data to prevent overwriting production data)
console.log("\n📦 Applying D1 database schema on remote database...");
await runWrangler([
  "d1", "execute", "DB",
  "--remote",
  "--file", resolve("schema.sql"),
  "--config", resolve("wrangler.toml"),
]);

// Step 1b: Apply initial catalog safely using INSERT OR IGNORE (existing catalog records are never overwritten)
console.log("\n📦 Populating initial product catalog (non-destructive INSERT OR IGNORE)...");
await runWrangler([
  "d1", "execute", "DB",
  "--remote",
  "--file", resolve("initial_catalog.sql"),
  "--config", resolve("wrangler.toml"),
]);

// Step 2: Deploy Backend Worker (serves REST API, Durable Objects, D1, KV)
console.log("\n🚀 Deploying CloudCart Backend Worker (cloudcart-worker)...");
await runWrangler([
  "deploy",
  "--config", resolve("wrangler.toml"),
]);

// Observability uses a restricted read/query token and a separate dashboard key.
await putWranglerSecret("OBSERVABILITY_API_KEY", process.env.OBSERVABILITY_API_KEY);
await putWranglerSecret("CF_OBSERVABILITY_API_TOKEN", process.env.CF_OBSERVABILITY_API_TOKEN);

// Step 3: Ensure Cloudflare Pages project with Service Binding
console.log("\n⚡ Provisioning Cloudflare Pages project with Service Binding...");
await ensurePages();

// Step 4: Deploy Cloudflare Pages frontend (serves UI + Pages Functions)
console.log("\n🌐 Deploying CloudCart Frontend to Cloudflare Pages (cloudcart.pages.dev)...");
await runWrangler([
  "pages", "deploy", resolve("public"),
  "--project-name", RESOURCE_NAMES.pages,
  "--branch", "main",
  "--commit-dirty=true",
]);

console.log("\n✨ CloudCart Multi-Tier Architecture deployed successfully!");
console.log(`   Frontend (Pages):  https://${RESOURCE_NAMES.pages}.pages.dev`);
console.log(`   Backend  (Worker): https://${RESOURCE_NAMES.worker}.shreesha.workers.dev\n`);
