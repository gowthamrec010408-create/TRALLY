/**
 * =====================================================================================
 * POULTRY FEED TROLLEY MONITORING SYSTEM - FRONTEND APPLICATION JAVASCRIPT
 * =====================================================================================
 * Supports:
 * 1. Direct Web Serial API (Native in Chrome/Edge, zero server required)
 * 2. Node.js Backend Server COM Port bridge & Wi-Fi IP mode
 * 3. Client-Side & Server-Side Demo Simulation Modes
 * 4. Autonomous safety interlocks & instantaneous live actuator feedback
 * =====================================================================================
 */

// Resolve Backend Base URL
const API_BASE = (window.location.protocol === 'file:' || (window.location.port && window.location.port !== '3000'))
  ? 'http://localhost:3000'
  : '';

// Application state
let currentSystemState = {
  mode: 'NONE',         // 'NONE' | 'WEB_SERIAL' | 'USB' | 'WIFI' | 'DEMO'
  connected: false,
  isDemo: false,
  usbPortName: '',
  wifiIp: '',
  lastUpdate: null,
  error: null,
  data: {
    feedWeight: 0,
    feedDispensed: 0,
    trolleyStatus: 'STOPPED',
    gateStatus: 'CLOSED',
    obstacleStatus: 'CLEAR',
    feedStatus: 'AVAILABLE',
    obstacleDistance: 100.0,
    ipAddress: 'NOT CONNECTED'
  },
  activityLog: []
};

// Web Serial handles
let webSerialPort = null;
let webSerialReader = null;
let webSerialWriter = null;
let webSerialKeepReading = false;

// Client-side Demo Timer
let clientDemoInterval = null;

// Server availability flag
let isServerOnline = false;

// =====================================================================================
// 1. INITIALIZATION & LIFECYCLE
// =====================================================================================

document.addEventListener('DOMContentLoaded', () => {
  console.log('[System Init] Poultry Feed Trolley Dashboard started.');
  addLocalLog('SYSTEM', 'Dashboard initialized. Ready for ESP32 connection.');

  // Wire up event listeners
  setupEventListeners();

  // Check Web Serial browser support
  initWebSerialSupportCheck();

  // Immediate server healthcheck
  checkServerHealth();

  // Periodic server healthcheck & telemetry polling
  setInterval(checkServerHealth, 3000);
  setInterval(pollTelemetry, 1000);
});

function setupEventListeners() {
  // Web Serial Buttons
  const btnConnectWebSerial = document.getElementById('btnConnectWebSerial');
  if (btnConnectWebSerial) btnConnectWebSerial.addEventListener('click', handleConnectWebSerial);
  const btnDisconnectWebSerial = document.getElementById('btnDisconnectWebSerial');
  if (btnDisconnectWebSerial) btnDisconnectWebSerial.addEventListener('click', handleDisconnectWebSerial);

  // Quick Web Serial button from banner
  const btnQuickWeb = document.getElementById('btnQuickWebSerial');
  if (btnQuickWeb) {
    btnQuickWeb.addEventListener('click', () => {
      switchModeTab('USB');
      handleConnectWebSerial();
    });
  }

  const btnRetryServer = document.getElementById('btnRetryServer');
  if (btnRetryServer) btnRetryServer.addEventListener('click', checkServerHealth);

  // Server USB Mode Actions
  const btnScanPorts = document.getElementById('btnScanPorts');
  if (btnScanPorts) btnScanPorts.addEventListener('click', scanAvailablePorts);
  const btnConnectUsb = document.getElementById('btnConnectUsb');
  if (btnConnectUsb) btnConnectUsb.addEventListener('click', handleConnectServerUsb);
  const btnDisconnectUsb = document.getElementById('btnDisconnectUsb');
  if (btnDisconnectUsb) btnDisconnectUsb.addEventListener('click', handleDisconnectServerUsb);

  // Wi-Fi Mode Actions
  const btnConnectWifi = document.getElementById('btnConnectWifi');
  if (btnConnectWifi) btnConnectWifi.addEventListener('click', handleConnectWifi);
  const btnDisconnectWifi = document.getElementById('btnDisconnectWifi');
  if (btnDisconnectWifi) btnDisconnectWifi.addEventListener('click', handleDisconnectWifi);

  // Demo Simulation Actions
  const btnToggleDemo = document.getElementById('btnToggleDemo');
  if (btnToggleDemo) btnToggleDemo.addEventListener('click', handleToggleDemo);
  const btnInjectObstacle = document.getElementById('btnInjectObstacle');
  if (btnInjectObstacle) btnInjectObstacle.addEventListener('click', handleInjectObstacle);

  // Actuator Hardware Control Buttons (Explicit listeners + inline support)
  const btnStart = document.getElementById('btnStartTrolley');
  if (btnStart) btnStart.addEventListener('click', () => sendCommand('START'));
  const btnStop = document.getElementById('btnStopTrolley');
  if (btnStop) btnStop.addEventListener('click', () => sendCommand('STOP'));
  const btnOpen = document.getElementById('btnOpenGate');
  if (btnOpen) btnOpen.addEventListener('click', () => sendCommand('OPEN_GATE'));
  const btnClose = document.getElementById('btnCloseGate');
  if (btnClose) btnClose.addEventListener('click', () => sendCommand('CLOSE_GATE'));
  const btnTare = document.getElementById('btnTareScale');
  if (btnTare) btnTare.addEventListener('click', () => sendCommand('TARE'));
  const btnSetInitial = document.getElementById('btnSetInitial');
  if (btnSetInitial) btnSetInitial.addEventListener('click', () => promptSetWeight());
  const btnEstop = document.getElementById('btnEmergencyStop');
  if (btnEstop) btnEstop.addEventListener('click', () => sendCommand('EMERGENCY_STOP'));
}

// =====================================================================================
// 2. SERVER HEALTH CHECK & MODE DETECTION
// =====================================================================================

async function checkServerHealth() {
  const badge = document.getElementById('serverStatusBadge');
  const text = document.getElementById('serverStatusText');
  const noticeBanner = document.getElementById('serverOfflineBanner');

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);

    const res = await fetch(`${API_BASE}/api/status`, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      if (!isServerOnline) {
        isServerOnline = true;
        console.log('[Server Status] Connected to Node.js backend server.');
        scanAvailablePorts();
      }
      badge.className = 'badge badge-server-online';
      text.textContent = 'SERVER ONLINE (3000)';
      if (noticeBanner) noticeBanner.classList.add('hidden');
      return true;
    }
  } catch (err) {
    // Server is offline
  }

  isServerOnline = false;
  badge.className = 'badge badge-server-offline';
  text.textContent = 'SERVER OFFLINE';

  // Only show notice if not already connected via Web Serial or Demo
  if (noticeBanner && currentSystemState.mode !== 'WEB_SERIAL' && currentSystemState.mode !== 'DEMO') {
    noticeBanner.classList.remove('hidden');
  }

  const portSelect = document.getElementById('comPortSelect');
  if (portSelect && portSelect.options.length <= 1) {
    portSelect.innerHTML = '<option value="">Server offline (Run npm start)</option>';
  }

  return false;
}

function dismissServerNotice() {
  const noticeBanner = document.getElementById('serverOfflineBanner');
  if (noticeBanner) noticeBanner.classList.add('hidden');
}

// =====================================================================================
// 3. MODE TAB SWITCHER
// =====================================================================================

function switchModeTab(selectedMode) {
  document.getElementById('tabUsbBtn').classList.toggle('active', selectedMode === 'USB');
  document.getElementById('tabWifiBtn').classList.toggle('active', selectedMode === 'WIFI');
  document.getElementById('tabDemoBtn').classList.toggle('active', selectedMode === 'DEMO');

  document.getElementById('panelUsb').classList.toggle('active', selectedMode === 'USB');
  document.getElementById('panelWifi').classList.toggle('active', selectedMode === 'WIFI');
  document.getElementById('panelDemo').classList.toggle('active', selectedMode === 'DEMO');
}

// =====================================================================================
// 4. DIRECT BROWSER WEB SERIAL API
// =====================================================================================

function initWebSerialSupportCheck() {
  const note = document.getElementById('webSerialStatusNote');
  const btnConnect = document.getElementById('btnConnectWebSerial');

  if (!('serial' in navigator)) {
    if (note) {
      note.textContent = 'Web Serial API is not supported in this browser. Use Google Chrome or MS Edge, or use Server COM Port.';
      note.style.color = 'var(--color-warning)';
    }
    if (btnConnect) {
      btnConnect.disabled = true;
      btnConnect.title = 'Web Serial requires Chrome or Edge';
    }
  }
}

async function handleConnectWebSerial() {
  if (!('serial' in navigator)) {
    showAlert('Web Serial API is not supported in this browser. Please use Chrome or Edge.', 'error');
    return;
  }

  try {
    showAlert('Requesting USB Serial port. Please select your ESP32 in the browser prompt...', 'info');
    
    webSerialPort = await navigator.serial.requestPort();
    await webSerialPort.open({ baudRate: 115200 });

    currentSystemState.mode = 'WEB_SERIAL';
    currentSystemState.connected = true;
    currentSystemState.isDemo = false;
    currentSystemState.usbPortName = 'Browser Web Serial';
    currentSystemState.error = null;

    addLocalLog('USB', 'Connected to ESP32 directly via Browser Web Serial @ 115200 baud.');
    showAlert('Successfully connected to ESP32 via Browser Web Serial!', 'success');

    dismissServerNotice();
    readWebSerialLoop();
    renderDashboard(currentSystemState);
  } catch (err) {
    console.error('[Web Serial Error]:', err);
    if (err.name !== 'NotFoundError') {
      showAlert(`Web Serial Connection Failed: ${err.message}`, 'error');
      addLocalLog('ERROR', `Web Serial: ${err.message}`);
    } else {
      showAlert('Port selection cancelled.', 'info');
    }
  }
}

async function readWebSerialLoop() {
  webSerialKeepReading = true;
  let textDecoder = new TextDecoderStream();
  let readableStreamClosed = webSerialPort.readable.pipeTo(textDecoder.writable);
  let reader = textDecoder.readable.getReader();
  webSerialReader = reader;

  let lineBuffer = '';

  try {
    while (webSerialKeepReading) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        lineBuffer += value;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          if (line.startsWith('{') && line.endsWith('}')) {
            try {
              const parsed = JSON.parse(line);

              if (parsed.type === 'COMMAND_ACK') {
                addLocalLog('COMMAND', `ESP32 ACK: ${parsed.status} - ${parsed.message || ''}`);
                continue;
              }

              if (parsed.warning) addLocalLog('WARNING', parsed.warning);
              if (parsed.error) addLocalLog('ERROR', parsed.error);

              if (parsed.feedWeight !== undefined) {
                updateTelemetryFromHardware(parsed);
              }
            } catch (jsonErr) {}
          } else {
            if (line.length > 2 && !line.startsWith('---') && !line.startsWith('===')) {
              addLocalLog('ESP32', line);
            }
          }
        }
      }
    }
  } catch (err) {
    if (webSerialKeepReading) {
      console.warn('[Web Serial Read Error]:', err);
      addLocalLog('ERROR', `Web Serial stream error: ${err.message}`);
    }
  } finally {
    reader.releaseLock();
  }
}

async function handleDisconnectWebSerial() {
  webSerialKeepReading = false;

  try {
    if (webSerialReader) {
      await webSerialReader.cancel().catch(() => {});
      webSerialReader = null;
    }
    if (webSerialWriter) {
      await webSerialWriter.close().catch(() => {});
      webSerialWriter = null;
    }
    if (webSerialPort) {
      await webSerialPort.close().catch(() => {});
      webSerialPort = null;
    }

    currentSystemState.mode = 'NONE';
    currentSystemState.connected = false;
    addLocalLog('USB', 'Disconnected from Browser Web Serial.');
    showAlert('Web Serial disconnected.', 'info');
    renderDashboard(currentSystemState);
  } catch (err) {
    showAlert(`Error closing port: ${err.message}`, 'error');
  }
}

async function sendWebSerialCommand(commandName) {
  if (!webSerialPort || !webSerialPort.writable) {
    throw new Error('Web Serial port is not open for writing.');
  }

  // Use TextEncoder directly with getWriter() and releaseLock() in finally.
  // CRITICAL: Avoid using TextEncoderStream.pipeTo() here, because pipeTo permanently locks
  // webSerialPort.writable, which caused all subsequent button presses to throw an error!
  const encoder = new TextEncoder();
  const writer = webSerialPort.writable.getWriter();

  try {
    const payload = JSON.stringify({ command: commandName }) + '\n';
    await writer.write(encoder.encode(payload));
    addLocalLog('COMMAND', `Dispatched command '${commandName}' via Web Serial`);
  } catch (err) {
    console.error('[Web Serial Write Error]:', err);
    throw err;
  } finally {
    writer.releaseLock();
  }
}

// =====================================================================================
// 5. NODE.JS SERVER COM PORT (Bridge Mode)
// =====================================================================================

async function scanAvailablePorts() {
  const select = document.getElementById('comPortSelect');
  if (!select) return;

  select.innerHTML = '<option value="">Scanning COM ports...</option>';

  try {
    const res = await fetch(`${API_BASE}/api/ports`);
    if (!res.ok) throw new Error('Server returned error');

    const data = await res.json();
    select.innerHTML = '';

    if (data.ports && data.ports.length > 0) {
      data.ports.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = `${p.path} ${p.friendlyName ? '(' + p.friendlyName + ')' : ''}`;
        select.appendChild(opt);
      });
      select.value = data.ports[0].path;
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No USB Serial ports detected';
      select.appendChild(opt);
    }
  } catch (err) {
    select.innerHTML = '<option value="">Scan failed (Server offline)</option>';
  }
}

async function handleConnectServerUsb() {
  const port = document.getElementById('comPortSelect').value;
  const baudRate = document.getElementById('baudRateSelect').value;

  if (!port) {
    showAlert('Please select a valid COM port from the dropdown.', 'error');
    return;
  }

  showAlert(`Attempting to open ${port} at ${baudRate} baud via server...`, 'info');
  try {
    const res = await fetch(`${API_BASE}/api/connect/usb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port, baudRate })
    });
    const result = await res.json();

    if (!res.ok || result.error) {
      throw new Error(result.error || 'Failed to connect');
    }

    showAlert(`Successfully connected to ESP32 on ${port}`, 'success');
    fetchTelemetry(true);
  } catch (err) {
    showAlert(`USB Connection Failed: ${err.message}`, 'error');
  }
}

async function handleDisconnectServerUsb() {
  try {
    const res = await fetch(`${API_BASE}/api/disconnect/usb`, { method: 'POST' });
    const result = await res.json();
    showAlert(result.message || 'USB disconnected', 'info');
    fetchTelemetry(true);
  } catch (err) {
    showAlert(`Disconnect error: ${err.message}`, 'error');
  }
}

// =====================================================================================
// 6. WI-FI IP MODE
// =====================================================================================

async function handleConnectWifi() {
  const ip = document.getElementById('espIpInput').value.trim();
  if (!ip) {
    showAlert('Please enter the ESP32 IP address (e.g. 10.82.67.238)', 'error');
    return;
  }

  showAlert(`Connecting to ESP32 at http://${ip}...`, 'info');

  if (isServerOnline) {
    try {
      const res = await fetch(`${API_BASE}/api/connect/wifi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip })
      });
      const result = await res.json();

      if (!res.ok || result.error) {
        throw new Error(result.error || 'Failed to reach ESP32 endpoint');
      }

      showAlert(`Connected to ESP32 Wi-Fi HTTP Server at ${ip}`, 'success');
      fetchTelemetry(true);
      return;
    } catch (err) {
      showAlert(`Server Wi-Fi Connect Failed: ${err.message}`, 'error');
      return;
    }
  }

  // Fallback direct browser Wi-Fi fetch
  try {
    const cleanIp = ip.replace(/^http:\/\//, '').replace(/\/$/, '');
    const res = await fetch(`http://${cleanIp}/api/status`, { mode: 'cors' });
    if (!res.ok) throw new Error('ESP32 status endpoint unreachable');

    const data = await res.json();
    currentSystemState.mode = 'WIFI';
    currentSystemState.connected = true;
    currentSystemState.wifiIp = cleanIp;
    updateTelemetryFromHardware(data);
    addLocalLog('WIFI', `Connected directly to ESP32 at http://${cleanIp}`);
    showAlert(`Connected directly to ESP32 at http://${cleanIp}`, 'success');
    renderDashboard(currentSystemState);
  } catch (err) {
    showAlert(`Direct Wi-Fi Failed: ${err.message}. Ensure PC and ESP32 are on same Wi-Fi.`, 'error');
  }
}

async function handleDisconnectWifi() {
  if (isServerOnline) {
    try {
      const res = await fetch(`${API_BASE}/api/disconnect/wifi`, { method: 'POST' });
      const result = await res.json();
      showAlert(result.message || 'Wi-Fi mode disconnected', 'info');
      fetchTelemetry(true);
      return;
    } catch (err) {}
  }

  currentSystemState.mode = 'NONE';
  currentSystemState.connected = false;
  addLocalLog('WIFI', 'Disconnected from Wi-Fi mode.');
  showAlert('Wi-Fi disconnected', 'info');
  renderDashboard(currentSystemState);
}

// =====================================================================================
// 7. DEMO SIMULATION MODE
// =====================================================================================

async function handleToggleDemo() {
  if (isServerOnline) {
    try {
      const res = await fetch(`${API_BASE}/api/demo/toggle`, { method: 'POST' });
      const result = await res.json();
      showAlert(result.message, result.isDemo ? 'info' : 'warning');
      fetchTelemetry(true);
      return;
    } catch (err) {}
  }

  if (currentSystemState.mode === 'DEMO') {
    stopClientDemo();
    showAlert('Demo Mode Deactivated', 'warning');
  } else {
    startClientDemo();
    showAlert('Demo Mode Activated (Browser Simulation)', 'success');
  }
}

function startClientDemo() {
  if (currentSystemState.mode === 'WEB_SERIAL') {
    handleDisconnectWebSerial();
  }

  currentSystemState.mode = 'DEMO';
  currentSystemState.connected = true;
  currentSystemState.isDemo = true;
  currentSystemState.error = null;
  currentSystemState.data = {
    feedWeight: 5000,
    feedDispensed: 0,
    trolleyStatus: 'STOPPED',
    gateStatus: 'CLOSED',
    obstacleStatus: 'CLEAR',
    feedStatus: 'AVAILABLE',
    obstacleDistance: 85.0,
    ipAddress: '192.168.1.150 (VIRTUAL)'
  };
  currentSystemState.lastUpdate = new Date().toISOString();
  addLocalLog('DEMO', 'Hardware Demo Mode started with simulated sensors.');

  if (clientDemoInterval) clearInterval(clientDemoInterval);
  clientDemoInterval = setInterval(() => {
    if (currentSystemState.mode !== 'DEMO') return;

    if (currentSystemState.data.gateStatus === 'OPEN') {
      const rate = currentSystemState.data.trolleyStatus === 'MOVING' ? 35 : 15;
      if (currentSystemState.data.feedWeight > rate) {
        currentSystemState.data.feedWeight -= rate;
        currentSystemState.data.feedDispensed += rate;
      } else {
        currentSystemState.data.feedWeight = 0;
      }
    }

    if (currentSystemState.data.feedWeight <= 500) {
      currentSystemState.data.feedStatus = 'LOW';
    } else {
      currentSystemState.data.feedStatus = 'AVAILABLE';
    }

    if (currentSystemState.data.obstacleStatus === 'CLEAR') {
      currentSystemState.data.obstacleDistance = Math.floor(65 + Math.random() * 30);
    }

    currentSystemState.lastUpdate = new Date().toISOString();
    renderDashboard(currentSystemState);
  }, 1000);

  renderDashboard(currentSystemState);
}

function stopClientDemo() {
  if (clientDemoInterval) {
    clearInterval(clientDemoInterval);
    clientDemoInterval = null;
  }
  currentSystemState.mode = 'NONE';
  currentSystemState.connected = false;
  currentSystemState.isDemo = false;
  addLocalLog('DEMO', 'Hardware Demo Mode stopped.');
  renderDashboard(currentSystemState);
}

async function handleInjectObstacle() {
  if (isServerOnline && currentSystemState.mode === 'DEMO') {
    try {
      const res = await fetch(`${API_BASE}/api/demo/obstacle`, { method: 'POST' });
      const result = await res.json();
      if (result.obstacleStatus === 'DETECTED') {
        showAlert('Simulated obstacle injected! Safety interlock triggered.', 'error');
      } else {
        showAlert('Simulated obstacle cleared. Path is clear.', 'success');
      }
      fetchTelemetry(true);
      return;
    } catch (err) {}
  }

  if (currentSystemState.mode === 'DEMO') {
    if (currentSystemState.data.obstacleStatus === 'CLEAR') {
      currentSystemState.data.obstacleStatus = 'DETECTED';
      currentSystemState.data.obstacleDistance = 12.0;
      if (currentSystemState.data.trolleyStatus === 'MOVING') {
        currentSystemState.data.trolleyStatus = 'STOPPED';
        addLocalLog('DEMO', 'Obstacle detected ahead! Trolley halted autonomously.');
      } else {
        addLocalLog('DEMO', 'Simulated obstacle placed at 12 cm.');
      }
      showAlert('Simulated obstacle placed ahead! Interlock triggered.', 'error');
    } else {
      currentSystemState.data.obstacleStatus = 'CLEAR';
      currentSystemState.data.obstacleDistance = 85.0;
      addLocalLog('DEMO', 'Simulated obstacle cleared. Path safe.');
      showAlert('Simulated obstacle cleared.', 'success');
    }
    renderDashboard(currentSystemState);
  }
}

// =====================================================================================
// 8. ACTUATOR COMMAND DISPATCH WITH OPTIMISTIC LIVE UPDATES
// =====================================================================================

async function sendCommand(commandName) {
  // Obstacle collision safety stop check
  if (commandName === 'START') {
    if (currentSystemState.data.obstacleStatus === 'DETECTED') {
      showAlert('BLOCKED: Cannot start trolley! Obstacle detected ahead within 25 cm.', 'error');
      return;
    }
  }

  // 1. Optimistic UI update immediately on click (eliminates lag!)
  if (commandName === 'START') {
    currentSystemState.data.trolleyStatus = 'MOVING';
    document.getElementById('valTrolleyStatus').textContent = 'MOVING';
    document.getElementById('ctrlTrolleyStateBadge').textContent = 'L298N • MOVING FORWARD';
    document.getElementById('ctrlTrolleyStateBadge').style.color = '#34d399';
  } else if (commandName === 'STOP') {
    currentSystemState.data.trolleyStatus = 'STOPPED';
    document.getElementById('valTrolleyStatus').textContent = 'STOPPED';
    document.getElementById('ctrlTrolleyStateBadge').textContent = 'L298N • STOPPED';
    document.getElementById('ctrlTrolleyStateBadge').style.color = 'var(--text-secondary)';
  } else if (commandName === 'OPEN_GATE') {
    currentSystemState.data.gateStatus = 'OPEN';
    document.getElementById('valGateStatus').textContent = 'OPEN';
    document.getElementById('ctrlGateStateBadge').textContent = 'SERVO • 90° (OPEN)';
    document.getElementById('ctrlGateStateBadge').style.color = '#22d3ee';
  } else if (commandName === 'CLOSE_GATE') {
    currentSystemState.data.gateStatus = 'CLOSED';
    document.getElementById('valGateStatus').textContent = 'CLOSED';
    document.getElementById('ctrlGateStateBadge').textContent = 'SERVO • 0° (CLOSED)';
    document.getElementById('ctrlGateStateBadge').style.color = 'var(--text-secondary)';
  } else if (commandName === 'EMERGENCY_STOP') {
    currentSystemState.data.trolleyStatus = 'STOPPED';
    currentSystemState.data.gateStatus = 'CLOSED';
    document.getElementById('valTrolleyStatus').textContent = 'STOPPED';
    document.getElementById('valGateStatus').textContent = 'CLOSED';
  } else if (commandName === 'TARE') {
    currentSystemState.data.feedWeight = 0.0;
    currentSystemState.data.feedDispensed = 0.0;
    document.getElementById('valFeedWeight').textContent = '0.0';
    document.getElementById('valFeedDispensed').textContent = '0.0';
  }

  showAlert(`Sending command '${commandName}'...`, 'info');

  // Route 1: Direct Web Serial
  if (currentSystemState.mode === 'WEB_SERIAL') {
    try {
      await sendWebSerialCommand(commandName);
      showAlert(`Command '${commandName}' executed successfully on ESP32.`, 'success');
    } catch (err) {
      showAlert(`Web Serial Command Error: ${err.message}`, 'error');
    }
    return;
  }

  // Route 2: Client Demo Simulation
  if (currentSystemState.mode === 'DEMO' && !isServerOnline) {
    executeClientDemoCommand(commandName);
    return;
  }

  // Route 3: Direct Wi-Fi to ESP32 (When Node Server is offline)
  if (currentSystemState.mode === 'WIFI' && !isServerOnline && currentSystemState.wifiIp) {
    try {
      const res = await fetch(`http://${currentSystemState.wifiIp}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: commandName })
      });
      const result = await res.json();
      showAlert(result.message || `Command '${commandName}' executed via ESP32 Wi-Fi.`, 'success');
    } catch (err) {
      showAlert(`Direct Wi-Fi Command Error: ${err.message}`, 'error');
    }
    return;
  }

  // Route 4: Node.js Backend Server COM Port Bridge / Wi-Fi
  try {
    const res = await fetch(`${API_BASE}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: commandName })
    });

    const result = await res.json();
    if (!res.ok || result.error) {
      throw new Error(result.error || 'Command failed on controller');
    }

    const confirmMsg = result.message || (result.esp32Response && result.esp32Response.message) || `Command '${commandName}' confirmed by ESP32.`;
    showAlert(confirmMsg, 'success');
    fetchTelemetry(true);
  } catch (err) {
    showAlert(`Command Rejected: ${err.message}`, 'error');
    fetchTelemetry(true);
  }
}

function executeClientDemoCommand(commandName) {
  const cmd = commandName.toUpperCase();
  if (cmd === 'START') {
    currentSystemState.data.trolleyStatus = 'MOVING';
    addLocalLog('COMMAND', 'Trolley started moving forward (DEMO)');
    showAlert('Trolley started moving forward.', 'success');
  } else if (cmd === 'STOP') {
    currentSystemState.data.trolleyStatus = 'STOPPED';
    addLocalLog('COMMAND', 'Trolley stopped (DEMO)');
    showAlert('Trolley stopped.', 'warning');
  } else if (cmd === 'OPEN_GATE') {
    currentSystemState.data.gateStatus = 'OPEN';
    addLocalLog('COMMAND', 'Feed dispensing gate OPENED (DEMO)');
    showAlert('Feed gate opened.', 'success');
  } else if (cmd === 'CLOSE_GATE') {
    currentSystemState.data.gateStatus = 'CLOSED';
    addLocalLog('COMMAND', 'Feed dispensing gate CLOSED (DEMO)');
    showAlert('Feed gate closed.', 'info');
  } else if (cmd === 'EMERGENCY_STOP') {
    currentSystemState.data.trolleyStatus = 'STOPPED';
    currentSystemState.data.gateStatus = 'CLOSED';
    addLocalLog('COMMAND', 'EMERGENCY STOP executed! All actuators halted (DEMO)');
    showAlert('Emergency stop executed! All actuators halted.', 'error');
  } else if (cmd === 'TARE') {
    currentSystemState.data.feedWeight = 5000;
    currentSystemState.data.feedDispensed = 0;
    addLocalLog('COMMAND', 'Scale zeroed and refilled to 5000g (DEMO)');
    showAlert('Scale zeroed (Demo hopper refilled).', 'success');
  }
  renderDashboard(currentSystemState);
}

// User-friendly Refill / Set Hopper Weight Helper
function promptSetWeight() {
  const input = prompt('Enter hopper weight in grams (e.g. 5000 for full hopper):', '5000');
  if (input !== null && !isNaN(Number(input))) {
    const val = Math.max(0, Number(input));
    currentSystemState.data.feedWeight = val;
    currentSystemState.data.feedDispensed = 0.0;
    currentSystemState.data.feedStatus = val <= 500 ? 'LOW' : 'AVAILABLE';
    addLocalLog('SCALE', `Hopper weight calibrated/refilled to ${val} grams.`);
    showAlert(`Hopper weight set to ${val}g baseline.`, 'success');
    renderDashboard(currentSystemState);
    // Send SET_INITIAL to ESP32
    sendCommand('SET_INITIAL');
  }
}

// =====================================================================================
// 9. TELEMETRY POLLING & LIVE HARDWARE SYNC
// =====================================================================================

function updateTelemetryFromHardware(hardwarePayload) {
  const prevTrolley = currentSystemState.data.trolleyStatus;
  const prevGate = currentSystemState.data.gateStatus;
  const prevObstacle = currentSystemState.data.obstacleStatus;
  const prevFeed = currentSystemState.data.feedStatus;

  currentSystemState.data = {
    ...currentSystemState.data,
    feedWeight: Number(hardwarePayload.feedWeight) || 0,
    feedDispensed: Number(hardwarePayload.feedDispensed) || 0,
    trolleyStatus: hardwarePayload.trolleyStatus || 'STOPPED',
    gateStatus: hardwarePayload.gateStatus || 'CLOSED',
    obstacleStatus: hardwarePayload.obstacleStatus || 'CLEAR',
    feedStatus: hardwarePayload.feedStatus || 'AVAILABLE',
    obstacleDistance: hardwarePayload.obstacleDistance !== undefined ? Number(hardwarePayload.obstacleDistance) : 100.0,
    ipAddress: hardwarePayload.ipAddress || 'SERIAL_STREAM'
  };
  currentSystemState.lastUpdate = new Date().toISOString();

  if (prevTrolley !== currentSystemState.data.trolleyStatus) {
    addLocalLog('TROLLEY', `Trolley status: ${currentSystemState.data.trolleyStatus}`);
  }
  if (prevGate !== currentSystemState.data.gateStatus) {
    addLocalLog('GATE', `Gate valve: ${currentSystemState.data.gateStatus}`);
  }
  if (prevObstacle !== currentSystemState.data.obstacleStatus) {
    addLocalLog('OBSTACLE', currentSystemState.data.obstacleStatus === 'DETECTED' ? 'Obstacle DETECTED ahead of trolley!' : 'Obstacle CLEARED.');
  }
  if (prevFeed !== currentSystemState.data.feedStatus && currentSystemState.data.feedStatus === 'LOW') {
    addLocalLog('WARNING', 'Hopper feed level is LOW! Refill needed.');
  }

  renderDashboard(currentSystemState);
}

async function pollTelemetry() {
  if (currentSystemState.mode === 'WEB_SERIAL' || currentSystemState.mode === 'DEMO') {
    return;
  }
  fetchTelemetry(false);
}

async function fetchTelemetry(isExplicitRefresh = false) {
  if (currentSystemState.mode === 'WEB_SERIAL') {
    showAlert('Telemetry is streaming live via Browser Web Serial', 'info');
    return;
  }

  if (!isServerOnline) return;

  try {
    const res = await fetch(`${API_BASE}/api/status`);
    if (!res.ok) throw new Error('Status endpoint error');

    const state = await res.json();
    currentSystemState = {
      ...currentSystemState,
      ...state,
      data: state.data || currentSystemState.data,
      activityLog: state.activityLog || currentSystemState.activityLog
    };

    renderDashboard(currentSystemState);

    if (isExplicitRefresh) {
      const refBtn = document.getElementById('btnRefreshData');
      if (refBtn) {
        refBtn.style.opacity = '0.5';
        setTimeout(() => refBtn.style.opacity = '1', 300);
      }
    }
  } catch (err) {}
}

// =====================================================================================
// 10. UI RENDERING & DASHBOARD STATE
// =====================================================================================

function renderDashboard(state) {
  const data = state.data || {};

  // 1. Header Badges
  const demoBadge = document.getElementById('demoBadge');
  if (state.isDemo) {
    demoBadge.classList.remove('hidden');
  } else {
    demoBadge.classList.add('hidden');
  }

  const sysBadge = document.getElementById('systemStateBadge');
  const sysText = document.getElementById('systemStateText');
  if (state.connected) {
    sysBadge.className = 'badge badge-connected';
    sysText.textContent = `${state.mode} ACTIVE`;
  } else {
    sysBadge.className = 'badge badge-disconnected';
    sysText.textContent = 'NOT CONNECTED';
  }

  // 2. Update Mode Panels (Buttons, Status Notes)
  updateConnectionPanels(state);

  // 3. Update 8 Metrics Cards (With Decimal Precision for small weights)
  // Card 1: Feed Weight
  const rawWeight = Number(data.feedWeight) || 0;
  const displayWeight = rawWeight >= 10 ? Math.round(rawWeight) : (rawWeight > 0 ? rawWeight.toFixed(1) : '0.0');
  document.getElementById('valFeedWeight').textContent = displayWeight;

  const pct = Math.min(100, Math.max(0, (rawWeight / 5000) * 100));
  const progBar = document.getElementById('weightProgressBar');
  progBar.style.width = `${pct}%`;
  if (rawWeight <= 500) {
    progBar.classList.add('low');
  } else {
    progBar.classList.remove('low');
  }

  // Card 2: Feed Dispensed
  const rawDispensed = Number(data.feedDispensed) || 0;
  const displayDispensed = rawDispensed >= 10 ? Math.round(rawDispensed) : (rawDispensed > 0 ? rawDispensed.toFixed(1) : '0.0');
  document.getElementById('valFeedDispensed').textContent = displayDispensed;

  // Card 3: Trolley Status
  const trolleyVal = data.trolleyStatus || 'STOPPED';
  const badgeTrolley = document.getElementById('badgeTrolley');
  document.getElementById('valTrolleyStatus').textContent = trolleyVal;
  const trolleySub = document.getElementById('trolleyMotorSubtext');
  const ctrlTrolleyBadge = document.getElementById('ctrlTrolleyStateBadge');

  if (trolleyVal === 'MOVING') {
    badgeTrolley.className = 'metric-status-badge status-moving';
    trolleySub.textContent = 'L298N Drive: FORWARD (200 PWM)';
    if (ctrlTrolleyBadge) {
      ctrlTrolleyBadge.textContent = 'L298N • MOVING FORWARD';
      ctrlTrolleyBadge.style.color = '#34d399';
    }
  } else {
    badgeTrolley.className = 'metric-status-badge status-stopped';
    trolleySub.textContent = 'L298N Drive: Idle / Off';
    if (ctrlTrolleyBadge) {
      ctrlTrolleyBadge.textContent = 'L298N • STOPPED';
      ctrlTrolleyBadge.style.color = 'var(--text-secondary)';
    }
  }

  // Card 4: Feed Gate Status
  const gateVal = data.gateStatus || 'CLOSED';
  const badgeGate = document.getElementById('badgeGate');
  document.getElementById('valGateStatus').textContent = gateVal;
  const gateSub = document.getElementById('gateServoSubtext');
  const ctrlGateBadge = document.getElementById('ctrlGateStateBadge');

  if (gateVal === 'OPEN') {
    badgeGate.className = 'metric-status-badge status-open';
    gateSub.textContent = 'Servo Position: 90° (Dispensing)';
    if (ctrlGateBadge) {
      ctrlGateBadge.textContent = 'SERVO • 90° (OPEN)';
      ctrlGateBadge.style.color = '#22d3ee';
    }
  } else {
    badgeGate.className = 'metric-status-badge status-closed';
    gateSub.textContent = 'Servo Position: 0° (Shut)';
    if (ctrlGateBadge) {
      ctrlGateBadge.textContent = 'SERVO • 0° (CLOSED)';
      ctrlGateBadge.style.color = 'var(--text-secondary)';
    }
  }

  // Card 5: Obstacle Status
  const obsVal = data.obstacleStatus || 'CLEAR';
  const badgeObstacle = document.getElementById('badgeObstacle');
  document.getElementById('valObstacleStatus').textContent = obsVal;
  const dist = data.obstacleDistance !== undefined ? Math.round(data.obstacleDistance) : '--';
  document.getElementById('valObstacleDistance').textContent = `Distance: ${dist} cm (${obsVal === 'DETECTED' ? 'WARNING < 25cm' : 'Safe'})`;
  if (obsVal === 'DETECTED') {
    badgeObstacle.className = 'metric-status-badge status-detected';
  } else {
    badgeObstacle.className = 'metric-status-badge status-clear';
  }

  // Card 6: Feed Availability
  const feedVal = data.feedStatus || 'AVAILABLE';
  const badgeFeed = document.getElementById('badgeFeedAvail');
  document.getElementById('valFeedStatus').textContent = feedVal;
  if (feedVal === 'LOW') {
    badgeFeed.className = 'metric-status-badge status-low';
    document.getElementById('feedThresholdSubtext').textContent = 'Threshold Alert: ≤ 500g';
  } else {
    badgeFeed.className = 'metric-status-badge status-available';
    document.getElementById('feedThresholdSubtext').textContent = 'Stock Good: > 500g';
  }

  // Card 7: ESP32 Connection
  const badgeConn = document.getElementById('badgeConnection');
  const txtConn = document.getElementById('valEspConnection');
  const subConn = document.getElementById('connectionModeSubtext');
  if (state.connected) {
    badgeConn.className = 'metric-status-badge status-clear';
    txtConn.textContent = 'CONNECTED';
    if (state.mode === 'WEB_SERIAL') {
      subConn.textContent = 'Browser Web Serial (115200)';
    } else if (state.mode === 'USB') {
      subConn.textContent = `Server: ${state.usbPortName || 'COM'}`;
    } else if (state.mode === 'WIFI') {
      subConn.textContent = `Wi-Fi IP: ${state.wifiIp}`;
    } else if (state.mode === 'DEMO') {
      subConn.textContent = 'Virtual Simulator';
    }
  } else {
    badgeConn.className = 'metric-status-badge status-disconnected';
    txtConn.textContent = 'DISCONNECTED';
    subConn.textContent = isServerOnline ? 'No active hardware link' : 'Server offline & no Web Serial';
  }

  // Card 8: Last Data Update
  if (state.lastUpdate) {
    const dateObj = new Date(state.lastUpdate);
    document.getElementById('valLastUpdate').textContent = dateObj.toLocaleTimeString();
    const elapsedSec = Math.floor((Date.now() - dateObj.getTime()) / 1000);
    document.getElementById('valTimeAgo').textContent = elapsedSec <= 1 ? 'Just now' : `${elapsedSec}s ago`;
  } else {
    document.getElementById('valLastUpdate').textContent = '--:--:--';
    document.getElementById('valTimeAgo').textContent = 'Awaiting connection';
  }

  // 4. Update Actuator Control Buttons & Safety Checks
  updateActuatorButtons(state);

  // 5. Update Live Telemetry Table
  updateTelemetryTable(state);

  // 6. Update Activity Logs
  updateEventLogs(state.activityLog || []);
}

function updateConnectionPanels(state) {
  // Web Serial UI
  const isWebSerial = state.mode === 'WEB_SERIAL' && state.connected;
  const btnConnectWeb = document.getElementById('btnConnectWebSerial');
  const btnDisconnectWeb = document.getElementById('btnDisconnectWebSerial');
  const webNote = document.getElementById('webSerialStatusNote');

  if (btnConnectWeb) btnConnectWeb.disabled = isWebSerial || (state.connected && state.mode !== 'WEB_SERIAL');
  if (btnDisconnectWeb) btnDisconnectWeb.disabled = !isWebSerial;
  if (webNote) {
    if (isWebSerial) {
      webNote.textContent = 'Status: Active and receiving telemetry directly in browser.';
      webNote.style.color = 'var(--color-success)';
    } else {
      webNote.textContent = 'Status: Ready. Connect ESP32 cable and click above.';
      webNote.style.color = 'var(--text-secondary)';
    }
  }

  // Server USB UI
  const isServerUsb = state.mode === 'USB' && state.connected;
  const btnConnectServerUsb = document.getElementById('btnConnectUsb');
  const btnDisconnectServerUsb = document.getElementById('btnDisconnectUsb');
  const serverUsbNote = document.getElementById('usbStatusNote');

  if (btnConnectServerUsb) btnConnectServerUsb.disabled = isServerUsb || (state.connected && state.mode !== 'USB');
  if (btnDisconnectServerUsb) btnDisconnectServerUsb.disabled = !isServerUsb;
  if (serverUsbNote) {
    if (isServerUsb) {
      serverUsbNote.textContent = `Status: Active on ${state.usbPortName} (115200 baud). Receiving telemetry.`;
      serverUsbNote.style.color = 'var(--color-success)';
    } else {
      serverUsbNote.textContent = state.mode === 'USB' && !state.connected 
        ? `Status: Port closed or disconnected. ${state.error || ''}`
        : 'Status: Not connected over Server USB. Close Arduino Serial Monitor before connecting.';
      serverUsbNote.style.color = 'var(--text-secondary)';
    }
  }

  // Wi-Fi UI
  const isWifi = state.mode === 'WIFI' && state.connected;
  document.getElementById('btnConnectWifi').disabled = isWifi || (state.connected && state.mode !== 'WIFI');
  document.getElementById('btnDisconnectWifi').disabled = !isWifi;
  const wifiNote = document.getElementById('wifiStatusNote');
  if (isWifi) {
    wifiNote.textContent = `Status: Active on http://${state.wifiIp}. Polling /api/status.`;
    wifiNote.style.color = 'var(--color-success)';
  } else {
    wifiNote.textContent = 'Status: Wi-Fi mode inactive. Enter the ESP32 IP shown in the Arduino Serial Monitor upon boot.';
    wifiNote.style.color = 'var(--text-secondary)';
  }

  // Demo UI
  const isDemo = state.mode === 'DEMO';
  const demoBtn = document.getElementById('btnToggleDemo');
  const obstBtn = document.getElementById('btnInjectObstacle');
  if (isDemo) {
    demoBtn.textContent = 'Stop Demo Mode';
    demoBtn.className = 'btn btn-secondary';
    obstBtn.disabled = false;
    obstBtn.textContent = state.data.obstacleStatus === 'DETECTED' ? 'Remove Simulated Obstacle' : 'Simulate Obstacle (Test Interlock)';
  } else {
    demoBtn.textContent = 'Start Demo Simulation';
    demoBtn.className = 'btn btn-accent';
    obstBtn.disabled = true;
  }
}

function updateActuatorButtons(state) {
  const isConnected = state.connected;
  const isMoving = state.data.trolleyStatus === 'MOVING';
  const isGateOpen = state.data.gateStatus === 'OPEN';
  const hasObstacle = state.data.obstacleStatus === 'DETECTED';

  const btnStart = document.getElementById('btnStartTrolley');
  const btnStop = document.getElementById('btnStopTrolley');
  const btnOpen = document.getElementById('btnOpenGate');
  const btnClose = document.getElementById('btnCloseGate');
  const btnTare = document.getElementById('btnTareScale');
  const btnEstop = document.getElementById('btnEmergencyStop');

  // Trolley Start: Disabled if not connected or obstacle detected
  if (btnStart) {
    btnStart.disabled = !isConnected || hasObstacle;
    btnStart.title = hasObstacle 
      ? 'Safety Interlock: Blocked because an obstacle is detected within 25 cm.' 
      : (isMoving ? 'Trolley is currently moving forward' : 'Start moving trolley forward');
  }

  // Trolley Stop: ALWAYS enabled when connected so the user can immediately cut off motors!
  if (btnStop) {
    btnStop.disabled = !isConnected;
    btnStop.title = 'Immediately cut off trolley drive motors';
  }

  // Gate Open: Enabled when connected
  if (btnOpen) {
    btnOpen.disabled = !isConnected;
    btnOpen.title = 'Open servo feed gate valve to 90 degrees';
  }

  // Gate Close: ALWAYS enabled when connected so the user can close gate anytime!
  if (btnClose) {
    btnClose.disabled = !isConnected;
    btnClose.title = 'Lock servo feed gate valve shut to 0 degrees';
  }

  // Tare & Emergency Stop
  if (btnTare) {
    btnTare.disabled = !isConnected;
  }
  if (btnEstop) {
    btnEstop.disabled = !isConnected;
    btnEstop.title = 'PRIORITY HALT: Immediately cut motor drive and lock feed gate shut';
  }
}

function updateTelemetryTable(state) {
  const data = state.data || {};
  const rawW = Number(data.feedWeight) || 0;
  const rawD = Number(data.feedDispensed) || 0;

  document.getElementById('tblWeight').textContent = `${rawW >= 10 ? Math.round(rawW) : rawW.toFixed(1)} g`;
  document.getElementById('tblDispensed').textContent = `${rawD >= 10 ? Math.round(rawD) : rawD.toFixed(1)} g`;
  document.getElementById('tblDistance').textContent = `${data.obstacleDistance ? Math.round(data.obstacleDistance) : '--'} cm`;
  document.getElementById('tblTrolley').textContent = data.trolleyStatus || 'STOPPED';
  document.getElementById('tblGate').textContent = data.gateStatus || 'CLOSED';
  document.getElementById('tblMode').textContent = state.mode;

  const chipObs = document.getElementById('tblDistanceStatus');
  if (data.obstacleStatus === 'DETECTED') {
    chipObs.className = 'chip chip-warning';
    chipObs.textContent = 'Obstacle Detected!';
  } else {
    chipObs.className = 'chip chip-success';
    chipObs.textContent = 'Safe Distance';
  }

  const chipMode = document.getElementById('tblModeStatus');
  if (state.connected) {
    chipMode.className = 'chip chip-success';
    chipMode.textContent = 'Active & Syncing';
  } else {
    chipMode.className = 'chip chip-warning';
    chipMode.textContent = 'Awaiting Connect';
  }
}

// =====================================================================================
// 11. IN-MEMORY ACTIVITY LOGGING
// =====================================================================================

function addLocalLog(type, message) {
  const entry = {
    id: Date.now() + Math.random().toString(36).substring(2, 6),
    timestamp: new Date().toLocaleTimeString(),
    type,
    message
  };
  currentSystemState.activityLog.unshift(entry);
  if (currentSystemState.activityLog.length > 60) {
    currentSystemState.activityLog.pop();
  }
  updateEventLogs(currentSystemState.activityLog);
}

function updateEventLogs(logs) {
  const container = document.getElementById('logStreamContainer');
  if (!logs || logs.length === 0) {
    container.innerHTML = '<div class="log-placeholder">No activity logged yet. Connect to hardware or enable Demo Mode.</div>';
    return;
  }

  container.innerHTML = '';
  logs.forEach((item) => {
    const div = document.createElement('div');
    div.className = `log-entry log-${item.type || 'SYSTEM'}`;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = item.timestamp;

    const tagSpan = document.createElement('span');
    tagSpan.className = 'log-tag';
    tagSpan.textContent = item.type || 'EVENT';

    const textSpan = document.createElement('span');
    textSpan.className = 'log-text';
    textSpan.textContent = item.message;

    div.appendChild(timeSpan);
    div.appendChild(tagSpan);
    div.appendChild(textSpan);
    container.appendChild(div);
  });
}

function clearEventLogs() {
  currentSystemState.activityLog = [];
  updateEventLogs([]);
}

// =====================================================================================
// 12. ALERT BANNER UTILITY
// =====================================================================================

let alertTimeout = null;

function showAlert(message, type = 'info') {
  const alertEl = document.getElementById('commandAlert');
  const alertText = document.getElementById('commandAlertText');
  const alertIcon = document.getElementById('commandAlertIcon');

  alertText.textContent = message;
  alertEl.className = 'alert-banner';

  if (type === 'error') {
    alertEl.classList.add('alert-error');
    alertIcon.textContent = '⚠️';
  } else if (type === 'success') {
    alertEl.classList.add('alert-success');
    alertIcon.textContent = '✅';
  } else if (type === 'warning') {
    alertEl.classList.add('alert-warning');
    alertIcon.textContent = '⚡';
  } else {
    alertIcon.textContent = 'ℹ️';
  }

  alertEl.classList.remove('hidden');

  if (alertTimeout) clearTimeout(alertTimeout);
  alertTimeout = setTimeout(() => {
    closeAlert();
  }, 6000);
}

function closeAlert() {
  const alertEl = document.getElementById('commandAlert');
  if (alertEl) alertEl.classList.add('hidden');
}

// Expose handlers globally to window for bulletproof inline HTML execution
window.sendCommand = sendCommand;
window.switchModeTab = switchModeTab;
window.promptSetWeight = promptSetWeight;
window.clearEventLogs = clearEventLogs;
window.dismissServerNotice = dismissServerNotice;
window.closeAlert = closeAlert;

