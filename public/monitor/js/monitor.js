// CloudCart - Cloudflare Edge Observability & Monitoring Logic

import { API_BASE } from '../../js/api.js';

// DOM Elements
const coloCodeEl = document.getElementById('coloCode');
const coloLocationEl = document.getElementById('coloLocation');
const cfRayIdEl = document.getElementById('cfRayId');
const httpProtoEl = document.getElementById('httpProto');
const tlsInfoEl = document.getElementById('tlsInfo');
const asnInfoEl = document.getElementById('asnInfo');
const clientIpEl = document.getElementById('clientIp');

const d1ProdCountEl = document.getElementById('d1ProdCount');
const d1OrderCountEl = document.getElementById('d1OrderCount');
const d1RevenueEl = document.getElementById('d1Revenue');
const d1LatencyEl = document.getElementById('d1Latency');

const kvLatencyEl = document.getElementById('kvLatency');
const doClientsCountEl = document.getElementById('doClientsCount');
const doUptimeEl = document.getElementById('doUptime');
const doLatencyEl = document.getElementById('doLatency');

const runTraceBtn = document.getElementById('runTraceBtn');
const traceIdDisplay = document.getElementById('traceIdDisplay');
const totalTraceTime = document.getElementById('totalTraceTime');
const waterfallContainer = document.getElementById('waterfallContainer');

const refreshTelemetryBtn = document.getElementById('refreshTelemetryBtn');
const wsStatusDot = document.getElementById('wsStatusDot');
const wsStatusText = document.getElementById('wsStatusText');

const terminalLogsContainer = document.getElementById('terminalLogsContainer');
const pauseStreamBtn = document.getElementById('pauseStreamBtn');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const filterBtns = document.querySelectorAll('.filter-btn');

let isStreamPaused = false;
let activeFilter = 'all';
let logsBuffer = [];

// Initialize Monitor
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await loadTelemetry();
  await runTraceBenchmark();
  initWebSocketStream();

  // Auto-refresh telemetry every 15s
  setInterval(loadTelemetry, 15000);
});

function setupEventListeners() {
  refreshTelemetryBtn.addEventListener('click', async () => {
    refreshTelemetryBtn.innerHTML = '<span class="icon">⏳</span> Refreshing...';
    await loadTelemetry();
    setTimeout(() => {
      refreshTelemetryBtn.innerHTML = '<span class="icon">🔄</span> Refresh';
    }, 400);
  });

  runTraceBtn.addEventListener('click', runTraceBenchmark);

  pauseStreamBtn.addEventListener('click', () => {
    isStreamPaused = !isStreamPaused;
    pauseStreamBtn.textContent = isStreamPaused ? '▶️ Resume' : '⏸️ Pause';
  });

  clearLogsBtn.addEventListener('click', () => {
    logsBuffer = [];
    terminalLogsContainer.innerHTML = `
      <div class="log-entry system">
        <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
        <span class="log-msg">Terminal logs cleared by operator.</span>
      </div>
    `;
  });

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderLogs();
    });
  });
}

function formatCurrency(amount) {
  return '₹' + Number(amount || 0).toLocaleString('en-IN');
}

// ─── Fetch Telemetry ──────────────────────────────────────────────────────────
async function loadTelemetry() {
  try {
    const res = await fetch(`${API_BASE}/ops/telemetry`);
    if (!res.ok) throw new Error(`Telemetry failed: ${res.status}`);
    const data = await res.json();
    if (!data.success) return;

    const { edge, services, recentLogs } = data.telemetry;

    // Edge Intelligence
    coloCodeEl.textContent = edge.colo || 'BOM';
    coloLocationEl.textContent = `${edge.city || 'Mumbai'}, ${edge.country || 'India'}`;
    cfRayIdEl.textContent = edge.rayId || 'cf-ray-live';
    httpProtoEl.textContent = edge.httpProtocol || 'HTTP/3 (QUIC)';
    tlsInfoEl.textContent = `${edge.tlsVersion} / ${edge.tlsCipher}`;
    asnInfoEl.textContent = `AS${edge.asn} (${edge.asOrganization || 'Cloudflare'})`;
    clientIpEl.textContent = edge.clientIp || '127.0.0.1';

    // D1 Diagnostics
    d1ProdCountEl.textContent = `${services.d1.tables.products} active`;
    d1OrderCountEl.textContent = `${services.d1.tables.orders} orders`;
    d1RevenueEl.textContent = formatCurrency(services.d1.totalRevenue);
    d1LatencyEl.textContent = `${services.d1.queryLatencyMs} ms`;

    // KV Diagnostics
    kvLatencyEl.textContent = `${services.kv.latencyMs} ms`;

    // Durable Object Diagnostics
    doClientsCountEl.textContent = `${services.durableObject.activeWebSocketClients} Clients`;
    doUptimeEl.textContent = `${services.durableObject.uptimeSeconds} sec`;
    doLatencyEl.textContent = `${services.durableObject.latencyMs} ms`;

    // Populate initial logs buffer if empty
    if (logsBuffer.length === 0 && recentLogs && recentLogs.length > 0) {
      logsBuffer = recentLogs;
      renderLogs();
    }
  } catch (err) {
    console.error('Error loading telemetry:', err);
  }
}

// ─── Run Distributed Trace Benchmark ───────────────────────────────────────────
async function runTraceBenchmark() {
  runTraceBtn.disabled = true;
  runTraceBtn.innerHTML = '<span>⏳ Tracing...</span>';

  try {
    const res = await fetch(`${API_BASE}/ops/trace`);
    const data = await res.json();

    if (!data.success) throw new Error('Trace API returned error');

    const { trace } = data;
    traceIdDisplay.textContent = trace.traceId;
    totalTraceTime.textContent = `${trace.totalDurationMs} ms`;

    renderWaterfall(trace.spans, trace.totalDurationMs);
  } catch (err) {
    console.error('Error running trace:', err);
    waterfallContainer.innerHTML = `<div class="waterfall-loading" style="color: #ef4444;">Error executing trace: ${err.message}</div>`;
  } finally {
    runTraceBtn.disabled = false;
    runTraceBtn.innerHTML = '<span>🚀 Run Trace Benchmark</span>';
  }
}

function getSpanBarClass(service) {
  switch (service) {
    case 'CLOUDFLARE_EDGE': return 'bar-edge';
    case 'SERVICE_BINDING': return 'bar-sb';
    case 'KV_NAMESPACE': return 'bar-kv';
    case 'D1_DATABASE': return 'bar-d1';
    case 'DURABLE_OBJECT': return 'bar-do';
    default: return 'bar-edge';
  }
}

function renderWaterfall(spans, totalTime) {
  const safeTotal = Math.max(totalTime, 0.1);

  waterfallContainer.innerHTML = spans.map(span => {
    const percentage = Math.max(Math.min((span.durationMs / safeTotal) * 100, 100), 5);
    const barClass = getSpanBarClass(span.service);

    return `
      <div class="waterfall-span-row">
        <div class="span-info">
          <span class="span-name">${span.name}</span>
          <span class="span-details">${span.details}</span>
        </div>
        <div class="span-bar-track">
          <div class="span-bar-fill ${barClass}" style="width: ${percentage.toFixed(1)}%;"></div>
        </div>
        <div class="span-dur">${span.durationMs.toFixed(2)} ms</div>
      </div>
    `;
  }).join('');
}

// ─── Real-Time WebSocket Telemetry Log Stream ──────────────────────────────────
function initWebSocketStream() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/api/sync`;

  let socket = null;

  function connect() {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      wsStatusDot.className = 'pulse-dot online';
      wsStatusText.textContent = 'Edge Live Connected';
      appendLogEntry({
        service: 'EDGE',
        level: 'INFO',
        message: '⚡ Live WebSocket link established with Cloudflare Durable Object Telemetry singleton.',
        timestamp: new Date().toISOString()
      });
    };

    socket.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);

        // Active user count
        if (data.type === 'ACTIVE_USERS_COUNT') {
          doClientsCountEl.textContent = `${data.activeConnections} Clients`;
        }

        // Telemetry Log Entry
        if (data.type === 'TELEMETRY_LOG' && data.log) {
          appendLogEntry(data.log);
        }

        // Product updates & orders
        if (data.type === 'PRODUCT_STOCK_UPDATED') {
          appendLogEntry({
            service: 'DURABLE_OBJECT',
            level: 'INFO',
            message: `[STOCK_SYNC] Product ${data.productId} (${data.productName || 'item'}) updated to ${data.newStock} units.`,
            timestamp: new Date().toISOString()
          });
        }

        if (data.type === 'ORDER_PLACED') {
          appendLogEntry({
            service: 'D1_DATABASE',
            level: 'SUCCESS',
            message: `[ORDER_EVENT] Order #${data.order.id} placed by ${data.order.customer_name} (₹${data.order.total_amount}).`,
            timestamp: new Date().toISOString()
          });
          loadTelemetry(); // Refresh metrics on new order
        }
      } catch (err) {
        console.error('Error handling WS event:', err);
      }
    };

    socket.onclose = () => {
      wsStatusDot.className = 'pulse-dot';
      wsStatusText.textContent = 'Reconnecting...';
      setTimeout(connect, 3000);
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  connect();
}

function appendLogEntry(log) {
  logsBuffer.push(log);
  if (logsBuffer.length > 100) logsBuffer.shift();

  if (!isStreamPaused) {
    renderLogs();
  }
}

function getTagClass(service) {
  const s = String(service || '').toUpperCase();
  if (s.includes('D1')) return 'tag-d1';
  if (s.includes('KV')) return 'tag-kv';
  if (s.includes('DO') || s.includes('DURABLE')) return 'tag-do';
  if (s.includes('SERVICE_BINDING') || s.includes('PAGES')) return 'tag-sb';
  return 'tag-edge';
}

function renderLogs() {
  const filtered = logsBuffer.filter(log => {
    if (activeFilter === 'all') return true;
    const s = String(log.service || '').toUpperCase();
    if (activeFilter === 'D1') return s.includes('D1');
    if (activeFilter === 'KV') return s.includes('KV');
    if (activeFilter === 'DO') return s.includes('DO') || s.includes('DURABLE');
    if (activeFilter === 'EDGE') return s.includes('EDGE') || s.includes('PAGES') || s.includes('SERVICE');
    return true;
  });

  if (filtered.length === 0) {
    terminalLogsContainer.innerHTML = `
      <div class="log-entry system">
        <span class="log-time">[${new Date().toLocaleTimeString()}]</span>
        <span class="log-msg">No logs matching filter "${activeFilter}".</span>
      </div>
    `;
    return;
  }

  terminalLogsContainer.innerHTML = filtered.map(log => {
    const timeStr = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
    const tagClass = getTagClass(log.service);
    const durSpan = log.durationMs !== null && log.durationMs !== undefined ? `<span class="log-dur">${log.durationMs}ms</span>` : '';

    return `
      <div class="log-entry">
        <span class="log-time">[${timeStr}]</span>
        <span class="log-tag ${tagClass}">[${log.service || 'EDGE'}]</span>
        <span class="log-msg">${log.message}</span>
        ${durSpan}
      </div>
    `;
  }).join('');

  // Scroll to bottom
  terminalLogsContainer.scrollTop = terminalLogsContainer.scrollHeight;
}
