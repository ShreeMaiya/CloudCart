// Cloudflare Platform Status & Incident Telemetry Handler

export async function fetchCloudflareStatus() {
  try {
    const res = await fetch('/api/ops/cloudflare-status');
    const data = await res.json();
    return data;
  } catch (err) {
    console.warn("Could not fetch Cloudflare status:", err);
    return null;
  }
}

export function updateCloudflareStatusUI(data) {
  const incidentBanner = document.getElementById('incidentBanner');
  const incidentTitle = document.getElementById('incidentTitle');
  const incidentDesc = document.getElementById('incidentDesc');
  const statusCFPlatform = document.getElementById('statusCFPlatform');
  const cfIncidentsVal = document.getElementById('cfIncidentsVal');

  if (!data || !data.success) {
    if (cfIncidentsVal) cfIncidentsVal.textContent = "Telemetry Cached";
    return;
  }

  const incidents = data.incidents || [];
  const statusIndicator = data.status?.indicator || "none";

  // Check for active incidents
  if (incidents.length > 0) {
    const latest = incidents[0];
    if (incidentBanner) {
      incidentBanner.classList.remove('hidden');
      incidentTitle.textContent = `Cloudflare Incident: ${latest.name}`;
      incidentDesc.textContent = `${latest.impact?.toUpperCase() || 'INVESTIGATING'} — ${latest.incident_updates?.[0]?.body || 'Engineers are actively investigating.'}`;
    }

    if (statusCFPlatform) {
      statusCFPlatform.textContent = "Incident";
      statusCFPlatform.className = "service-status down";
    }

    if (cfIncidentsVal) {
      cfIncidentsVal.textContent = `${incidents.length} Active`;
      cfIncidentsVal.className = "val text-danger";
    }
  } else {
    // No active incidents
    if (incidentBanner) {
      incidentBanner.classList.add('hidden');
    }

    if (statusCFPlatform) {
      statusCFPlatform.textContent = statusIndicator === "none" ? "Operational" : "Degraded";
      statusCFPlatform.className = statusIndicator === "none" ? "service-status operational" : "service-status degraded";
    }

    if (cfIncidentsVal) {
      cfIncidentsVal.textContent = "0 Active Incidents";
      cfIncidentsVal.className = "val text-success";
    }
  }
}
