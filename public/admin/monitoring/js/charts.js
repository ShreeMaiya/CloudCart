// CloudCart Observability Custom Lightweight SVG Chart Engine
// Zero external dependencies, pure vector rendering

export function renderThroughputChart(svgElement, timeSeriesData) {
  if (!svgElement) return;

  const width = 700;
  const height = 240;
  const padding = { top: 20, right: 30, bottom: 40, left: 45 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  // Prepare fallback data if timeSeriesData is sparse (e.g. at startup)
  let points = [...(timeSeriesData || [])];
  if (points.length < 2) {
    const now = new Date();
    const mockPoints = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 60000);
      const timeStr = d.toISOString().substring(11, 16);
      mockPoints.push({
        time: timeStr,
        requests: i === 0 && points[0] ? points[0].requests : 0,
        errors: 0,
        avgLatency: i === 0 && points[0] ? points[0].avgLatency : 0
      });
    }
    points = mockPoints;
  }

  // Calculate scales
  const maxReq = Math.max(...points.map(p => p.requests), 5);
  const maxLat = Math.max(...points.map(p => p.avgLatency), 50);

  const getX = (index) => padding.left + (index / (points.length - 1)) * chartW;
  const getYReq = (val) => padding.top + chartH - (val / maxReq) * chartH;
  const getYLat = (val) => padding.top + chartH - (val / maxLat) * chartH;

  // Generate SVG paths
  let reqAreaPath = `M ${getX(0)} ${padding.top + chartH}`;
  let reqLinePath = `M ${getX(0)} ${getYReq(points[0].requests)}`;
  let latLinePath = `M ${getX(0)} ${getYLat(points[0].avgLatency)}`;

  points.forEach((p, idx) => {
    const x = getX(idx);
    const yReq = getYReq(p.requests);
    const yLat = getYLat(p.avgLatency);

    reqAreaPath += ` L ${x} ${yReq}`;
    reqLinePath += ` L ${x} ${yReq}`;
    latLinePath += ` L ${x} ${yLat}`;
  });

  reqAreaPath += ` L ${getX(points.length - 1)} ${padding.top + chartH} Z`;

  // Build gridlines
  let gridLines = '';
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (i / 4) * chartH;
    const reqVal = Math.round(maxReq - (i / 4) * maxReq);
    gridLines += `
      <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3,3" />
      <text x="${padding.left - 8}" y="${y + 4}" fill="#64748b" font-size="10" font-family="'JetBrains Mono', monospace" text-anchor="end">${reqVal}</text>
    `;
  }

  // Build X-axis labels
  let xLabels = '';
  const step = Math.max(1, Math.floor(points.length / 5));
  points.forEach((p, idx) => {
    if (idx % step === 0 || idx === points.length - 1) {
      const x = getX(idx);
      xLabels += `
        <text x="${x}" y="${height - 12}" fill="#64748b" font-size="10" font-family="'JetBrains Mono', monospace" text-anchor="middle">${p.time}</text>
      `;
    }
  });

  // Data point dots
  let dots = '';
  points.forEach((p, idx) => {
    const x = getX(idx);
    const yReq = getYReq(p.requests);
    const yLat = getYLat(p.avgLatency);

    dots += `
      <circle cx="${x}" cy="${yReq}" r="4" fill="#38bdf8" stroke="#070a12" stroke-width="2">
        <title>Time: ${p.time} | Requests: ${p.requests}</title>
      </circle>
      <circle cx="${x}" cy="${yLat}" r="3" fill="#818cf8" stroke="#070a12" stroke-width="1.5">
        <title>Time: ${p.time} | Latency: ${p.avgLatency}ms</title>
      </circle>
    `;

    if (p.errors > 0) {
      dots += `
        <circle cx="${x}" cy="${yReq - 8}" r="5" fill="#f43f5e" stroke="#fff" stroke-width="1.5">
          <title>Time: ${p.time} | Errors: ${p.errors}</title>
        </circle>
      `;
    }
  });

  svgElement.innerHTML = `
    <defs>
      <linearGradient id="reqGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.0"/>
      </linearGradient>
    </defs>
    
    <!-- Grid -->
    ${gridLines}

    <!-- Area & Lines -->
    <path d="${reqAreaPath}" fill="url(#reqGradient)" />
    <path d="${reqLinePath}" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
    <path d="${latLinePath}" fill="none" stroke="#818cf8" stroke-width="2" stroke-dasharray="4,2" stroke-linejoin="round" />

    <!-- X-Axis Labels -->
    ${xLabels}

    <!-- Data Markers -->
    ${dots}
  `;
}
