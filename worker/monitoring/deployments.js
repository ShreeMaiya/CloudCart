// CloudCart Monitoring - CI/CD Deployments & Business Correlation Service
import { METRIC_SOURCES, isDemoMode, formatMetric } from "./sources.js";

/**
 * Retrieve deployment pipeline status, release history, and business correlation analytics
 */
export async function getDeploymentMetrics(env) {
  const demo = isDemoMode(env);
  const now = Date.now();

  // 1. Check for real deployment environment variables (e.g. injected during CI/CD build)
  const commitSha = env?.GITHUB_SHA || env?.CF_PAGES_COMMIT_SHA || null;
  const branch = env?.GITHUB_REF_NAME || env?.GITHUB_REF || null;
  const workflow = env?.GITHUB_WORKFLOW || null;
  const deploymentId = env?.DEPLOYMENT_ID || null;
  const githubRepo = env?.GITHUB_REPOSITORY || null;
  const githubToken = env?.GITHUB_TOKEN || null;

  let currentRelease = null;
  let pipelineStages = [];
  let history = [];
  let deploymentSource = METRIC_SOURCES.UNAVAILABLE;
  let deploymentReason = "CI/CD deployment metadata requires GitHub Actions API integration or environment build variables.";

  // If real GitHub / Pages build metadata was injected
  if (commitSha) {
    deploymentSource = "GITHUB_ACTIONS";
    currentRelease = {
      version: deploymentId || `sha-${commitSha.substring(0, 7)}`,
      commitSha: commitSha.substring(0, 7),
      fullCommitSha: commitSha,
      branch: branch || "main",
      workflow: workflow || "Deploy CloudCart Stack",
      environment: "production",
      deployedAt: env?.DEPLOYED_AT || new Date().toISOString(),
      status: "HEALTHY",
      source: METRIC_SOURCES.APPLICATION_INSTRUMENTED
    };
  } else if (demo) {
    deploymentSource = METRIC_SOURCES.DEMO;
    deploymentReason = "DEMO DATA — Simulated CI/CD deployment pipeline for local demonstration.";
    currentRelease = {
      version: "v1.2.0-demo",
      commitSha: "c8f2a1b",
      commitMessage: "[DEMO] feat(monitoring): request correlation, distributed tracing & edge observability",
      branch: "main",
      author: "CloudCart Engineer (Demo)",
      environment: "production",
      deployedAt: new Date(now - 1000 * 60 * 60 * 18).toISOString(),
      uptimeHours: 18.4,
      pagesUrl: "https://cloudcart.pages.dev",
      workerService: "cloudcart-worker.shreesha.workers.dev",
      status: "HEALTHY",
      source: METRIC_SOURCES.DEMO
    };

    pipelineStages = [
      { id: "stage_checkout", step: 1, name: "GitHub Actions Checkout & Node Setup", status: "SUCCESS", durationSeconds: 7, source: METRIC_SOURCES.DEMO },
      { id: "stage_d1", step: 2, name: "Cloudflare D1 Schema & Migrations", status: "SUCCESS", durationSeconds: 11, source: METRIC_SOURCES.DEMO },
      { id: "stage_kv_do", step: 3, name: "KV Namespace & Durable Object Binding", status: "SUCCESS", durationSeconds: 9, source: METRIC_SOURCES.DEMO },
      { id: "stage_worker", step: 4, name: "Worker Microservice Deployment", status: "SUCCESS", durationSeconds: 14, source: METRIC_SOURCES.DEMO },
      { id: "stage_pages", step: 5, name: "Cloudflare Pages CDN & Service Binding", status: "SUCCESS", durationSeconds: 8, source: METRIC_SOURCES.DEMO }
    ];

    history = [
      { id: "dep_demo_1", version: "v1.2.0-demo", commitSha: "c8f2a1b", deployedAt: new Date(now - 1000 * 60 * 60 * 18).toISOString(), status: "SUCCESS", source: METRIC_SOURCES.DEMO }
    ];
  } else {
    currentRelease = {
      version: null,
      commitSha: null,
      branch: null,
      workflow: null,
      status: "UNKNOWN",
      source: METRIC_SOURCES.UNAVAILABLE,
      reason: deploymentReason
    };
  }

  // 2. Business Correlation Analytics (Calculated from real D1 database records)
  let totalOrders = 0;
  let totalRevenueCents = 0;
  let businessSource = METRIC_SOURCES.UNAVAILABLE;

  if (env && env.DB) {
    try {
      const ordersRes = await env.DB.prepare("SELECT COUNT(*) as count, SUM(total_amount) as totalRev FROM orders").first();
      totalOrders = ordersRes?.count ?? 0;
      totalRevenueCents = ordersRes?.totalRev ?? 0;
      businessSource = METRIC_SOURCES.CALCULATED;
    } catch (_) {
      businessSource = METRIC_SOURCES.UNAVAILABLE;
    }
  }

  return {
    source: deploymentSource,
    isDemoData: demo,
    reason: deploymentReason,
    currentRelease,
    pipeline: {
      source: deploymentSource,
      stages: pipelineStages
    },
    history,
    businessCorrelation: {
      source: businessSource,
      label: "Business + Infrastructure Correlation (D1 & InventoryDO)",
      checkoutConversion: {
        totalOrdersRecorded: formatMetric(totalOrders, businessSource),
        source: businessSource
      },
      revenueVelocity: {
        totalRevenueCents: formatMetric(totalRevenueCents, businessSource),
        formattedRevenue: formatMetric(`$${(totalRevenueCents / 100).toFixed(2)}`, businessSource),
        source: businessSource
      }
    }
  };
}
