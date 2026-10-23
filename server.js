/**
 * =====================================================================================
 * POULTRY FEED TROLLEY MONITORING SYSTEM - NODE.JS & EXPRESS BACKEND
 * =====================================================================================
 * Project: IoT-Based Poultry Feed Trolley Monitoring System Using ESP32
 * Features:
 *  - Serves modern web dashboard from public/
 *  - USB Serial communication using SerialPort & ReadlineParser
 *  - Wi-Fi HTTP communication to ESP32 IP address
 *  - Mutually exclusive active communication mode (USB vs Wi-Fi vs Demo)
 *  - Demonstration Mode for testing without hardware
 *  - 100% In-Memory state management (NO DATABASE as requested)
 * =====================================================================================
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');

// Optional load of serialport with friendly fallback if driver/compilation needs care
let SerialPortPackage = null;
let ReadlineParserPackage = null;
try {
  const spModule = require('serialport');
  SerialPortPackage = spModule.SerialPort;
  const parserModule = require('@serialport/parser-readline');
  ReadlineParserPackage = parserModule.ReadlineParser;
} catch (err) {
  console.warn('[WARN] SerialPort module load warning:', err.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =====================================================================================
// IN-MEMORY APPLICATION STATE (No Database)
// =====================================================================================
const state = {
  mode: 'NONE',         // 'NONE' | 'USB' | 'WIFI' | 'DEMO'
  connected: false,
  isDemo: false,
  usbPortName: '',
  baudRate: 115200,
  wifiIp: '',
  lastUpdate: null,
  error: null,
  // Sensor readings
  data: {
    feedWeight: 0,
    feedDispensed: 0,
    trolleyStatus: 'STOPPED', // 'MOVING' | 'STOPPED'
    gateStatus: 'CLOSED',      // 'OPEN' | 'CLOSED'
    obstacleStatus: 'CLEAR',   // 'CLEAR' | 'DETECTED'
    feedStatus: 'AVAILABLE',   // 'AVAILABLE' | 'LOW'
    obstacleDistance: 100.0,
    ipAddress: 'NOT CONNECTED'
  },
  // In-memory activity log (temporary, cleared on server restart)
  activityLog: []
};

function addLog(type, message) {
  const entry = {
    id: Date.now() + Math.random().toString(36).substring(2, 6),
    timestamp: new Date().toLocaleTimeString(),
    type,
    message
  };
  state.activityLog.unshift(entry);
  if (state.activityLog.length > 50) {
    state.activityLog.pop();
  }
}

addLog('SYSTEM', 'Backend server initialized in idle state.');

// =====================================================================================
// COMMUNICATION CONTROLLERS
// =====================================================================================

// USB Serial Controller Handle
let activeSerialPort = null;
let activeSerialParser = null;

// Wi-Fi Polling Handle
let wifiPollTimer = null;

// Demo Simulation Handle
let demoIntervalTimer = null;

// Helper to disconnect any active mode cleanly
function resetAllModes() {
  // Stop USB
  if (activeSerialPort) {
    try {
      if (activeSerialPort.isOpen) {
        activeSerialPort.close();
      }
    } catch (e) {}
    activeSerialPort = null;
    activeSerialParser = null;
  }

  // Stop Wi-Fi Polling
  if (wifiPollTimer) {
    clearInterval(wifiPollTimer);
    wifiPollTimer = null;
  }

  // Stop Demo
  if (demoIntervalTimer) {
    clearInterval(demoIntervalTimer);
    demoIntervalTimer = null;
  }

  state.mode = 'NONE';
  state.connected = false;
  state.isDemo = false;
  state.error = null;
}

// -------------------------------------------------------------------------------------
// USB SERIAL COMMUNICATION
// -------------------------------------------------------------------------------------

function connectUsb(portPath, baudRate = 115200) {
  return new Promise((resolve, reject) => {
    if (!SerialPortPackage) {
      return reject(new Error('SerialPort library is not available. Please run npm install.'));
    }

    resetAllModes();

    try {
      activeSerialPort = new SerialPortPackage({
        path: portPath,
        baudRate: parseInt(baudRate, 10) || 115200,
        autoOpen: false
      });

      activeSerialParser = activeSerialPort.pipe(new ReadlineParserPackage({ delimiter: '\n' }));

      activeSerialPort.open((err) => {
        if (err) {
          activeSerialPort = null;
          let hint = '';
          if (err.message && (err.message.includes('Access denied') || err.message.includes('Permission denied') || err.message.includes('busy'))) {
            hint = ' (Port is busy. Please close Arduino IDE Serial Monitor or any other app using this port!)';
          }
          state.error = `Failed to open ${portPath}: ${err.message}${hint}`;
          addLog('ERROR', state.error);
          return reject(new Error(state.error));
        }

        state.mode = 'USB';
        state.connected = true;
        state.usbPortName = portPath;
        state.baudRate = baudRate;
        state.error = null;
        addLog('USB', `Connected to ESP32 on ${portPath} @ ${baudRate} baud.`);
        resolve({ port: portPath, baudRate });
      });

      activeSerialParser.on('data', (rawLine) => {
        const line = rawLine.trim();
        if (!line) return;

        // Any active serial incoming line confirms the connection is alive
        state.connected = true;

        // Try parsing JSON from ESP32
        if (line.startsWith('{') && line.endsWith('}')) {
          try {
            const parsed = JSON.parse(line);

            // Command confirmation message
            if (parsed.type === 'COMMAND_ACK') {
              addLog('COMMAND', `ESP32 ACK: ${parsed.status} - ${parsed.message || ''}`);
              return;
            }

            // Safety / warning broadcast
            if (parsed.warning) {
              addLog('WARNING', parsed.warning);
            }
            if (parsed.error) {
              addLog('ERROR', parsed.error);
            }

            // Normal telemetry payload
            if (parsed.feedWeight !== undefined) {
              updateTelemetryData(parsed);
            }
          } catch (jsonErr) {
            // Malformed JSON line from serial noise; ignore gracefully
          }
        } else {
          // ESP32 system or bootup log line
          if (line.length > 2 && !line.startsWith('---') && !line.startsWith('===')) {
            addLog('ESP32', line);
          }
        }
      });

      activeSerialPort.on('error', (err) => {
        console.error(`[USB Error on ${portPath}]:`, err.message);
        state.connected = false;
        state.error = `Serial port error: ${err.message}`;
        addLog('ERROR', `USB Serial Error: ${err.message}`);
      });

      activeSerialPort.on('close', () => {
        console.log(`[USB Disconnected] ${portPath}`);
        if (state.mode === 'USB') {
          state.connected = false;
          addLog('USB', `Port ${portPath} was closed or disconnected.`);
        }
      });

    } catch (e) {
      reject(e);
    }
  });
}

function sendUsbCommand(commandString) {
  return new Promise((resolve, reject) => {
    if (!activeSerialPort || !activeSerialPort.isOpen) {
      return reject(new Error('USB Serial is not connected.'));
    }

    const payload = JSON.stringify({ command: commandString }) + '\n';
    activeSerialPort.write(payload, (err) => {
      if (err) {
        return reject(new Error(`Failed to write to Serial: ${err.message}`));
      }
      activeSerialPort.drain((drainErr) => {
        if (drainErr) return reject(drainErr);
        resolve({ sent: commandString });
      });
    });
  });
}

// -------------------------------------------------------------------------------------
// WI-FI IP COMMUNICATION
// -------------------------------------------------------------------------------------

async function fetchFromEsp32(ip, endpoint, options = {}) {
  const url = `http://${ip}${endpoint}`;
  const controller = new AbortController();
  const timeoutMs = options.timeout || 3000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchFn = globalThis.fetch;
    if (!fetchFn) {
      throw new Error('Node.js fetch is unavailable. Requires Node 18+');
    }

    const res = await fetchFn(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
    }

    return await res.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`Request to ESP32 at ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

async function connectWifi(ip) {
  resetAllModes();

  // Test connection to ESP32 /api/status endpoint
  const cleanIp = ip.trim().replace(/^http:\/\//, '').replace(/\/$/, '');
  try {
    const data = await fetchFromEsp32(cleanIp, '/api/status', { timeout: 3500 });
    state.mode = 'WIFI';
    state.connected = true;
    state.wifiIp = cleanIp;
    state.error = null;
    updateTelemetryData(data);
    addLog('WIFI', `Connected to ESP32 at http://${cleanIp}`);

    // Start background poller (every 1.5 seconds)
    wifiPollTimer = setInterval(async () => {
      if (state.mode !== 'WIFI') return;
      try {
        const polled = await fetchFromEsp32(cleanIp, '/api/status', { timeout: 2500 });
        state.connected = true;
        updateTelemetryData(polled);
      } catch (pollErr) {
        if (state.connected) {
          state.connected = false;
          state.error = `Wi-Fi poll error: ${pollErr.message}`;
          addLog('WIFI', `Lost communication with ESP32 at ${cleanIp}`);
        }
      }
    }, 1500);

    return { ip: cleanIp, status: 'CONNECTED' };
  } catch (err) {
    state.error = `Cannot connect to ESP32 at ${cleanIp}: ${err.message}`;
    throw err;
  }
}

async function sendWifiCommand(ip, commandString) {
  const cleanIp = ip.trim().replace(/^http:\/\//, '').replace(/\/$/, '');
  const res = await fetchFromEsp32(cleanIp, '/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: commandString }),
    timeout: 3500
  });
  return res;
}

// -------------------------------------------------------------------------------------
// TELEMETRY UPDATE HELPER
// -------------------------------------------------------------------------------------

function updateTelemetryData(newReadings) {
  const prevTrolley = state.data.trolleyStatus;
  const prevGate = state.data.gateStatus;
  const prevObstacle = state.data.obstacleStatus;
  const prevFeed = state.data.feedStatus;

  state.data = {
    ...state.data,
    feedWeight: Number(newReadings.feedWeight) || 0,
    feedDispensed: Number(newReadings.feedDispensed) || 0,
    trolleyStatus: newReadings.trolleyStatus || 'STOPPED',
    gateStatus: newReadings.gateStatus || 'CLOSED',
    obstacleStatus: newReadings.obstacleStatus || 'CLEAR',
    feedStatus: newReadings.feedStatus || 'AVAILABLE',
    obstacleDistance: newReadings.obstacleDistance !== undefined ? Number(newReadings.obstacleDistance) : 100.0,
    ipAddress: newReadings.ipAddress || (state.mode === 'WIFI' ? state.wifiIp : 'SERIAL_MODE')
  };
  state.lastUpdate = new Date().toISOString();

  // Log important status changes
  if (prevTrolley !== state.data.trolleyStatus) {
    addLog('TROLLEY', `Trolley status changed to ${state.data.trolleyStatus}`);
  }
  if (prevGate !== state.data.gateStatus) {
    addLog('GATE', `Feed dispensing gate changed to ${state.data.gateStatus}`);
  }
  if (prevObstacle !== state.data.obstacleStatus) {
    addLog('OBSTACLE', state.data.obstacleStatus === 'DETECTED' ? 'Obstacle DETECTED ahead of trolley!' : 'Obstacle CLEARED.');
  }
  if (prevFeed !== state.data.feedStatus && state.data.feedStatus === 'LOW') {
    addLog('FEED', 'Warning: Hopper feed level is LOW! Refill needed.');
  }
}

// -------------------------------------------------------------------------------------
// DEMO SIMULATION MODE
// -------------------------------------------------------------------------------------

function startDemoMode() {
  resetAllModes();

  state.mode = 'DEMO';
  state.connected = true;
  state.isDemo = true;
  state.error = null;
  state.data = {
    feedWeight: 5000,
    feedDispensed: 0,
    trolleyStatus: 'STOPPED',
    gateStatus: 'CLOSED',
    obstacleStatus: 'CLEAR',
    feedStatus: 'AVAILABLE',
    obstacleDistance: 85.0,
    ipAddress: '192.168.1.150 (SIMULATED)'
  };
  state.lastUpdate = new Date().toISOString();
  addLog('DEMO', 'Demonstration mode started with simulated sensors.');

  // Simulation loop
  demoIntervalTimer = setInterval(() => {
    if (state.mode !== 'DEMO') return;

    // If gate is open and trolley is moving, dispense feed
    if (state.data.gateStatus === 'OPEN') {
      const dispenseRate = state.data.trolleyStatus === 'MOVING' ? 35 : 15;
      if (state.data.feedWeight > dispenseRate) {
        state.data.feedWeight -= dispenseRate;
        state.data.feedDispensed += dispenseRate;
      } else {
        state.data.feedWeight = 0;
      }
    }

    // Check feed availability
    if (state.data.feedWeight < 600) {
      state.data.feedStatus = 'LOW';
    } else {
      state.data.feedStatus = 'AVAILABLE';
    }

    // Jitter distance slightly
    if (state.data.obstacleStatus === 'CLEAR') {
      state.data.obstacleDistance = Math.floor(60 + Math.random() * 40);
    }

    state.lastUpdate = new Date().toISOString();
  }, 1000);
}

// =====================================================================================
// REST API ROUTES
// =====================================================================================

// 1. Get current system status and telemetry
app.get('/api/status', (req, res) => {
  res.json({
    mode: state.mode,
    connected: state.connected,
    isDemo: state.isDemo,
    usbPortName: state.usbPortName,
    baudRate: state.baudRate,
    wifiIp: state.wifiIp,
    lastUpdate: state.lastUpdate,
    error: state.error,
    data: state.data,
    activityLog: state.activityLog
  });
});

// 2. List available COM ports on computer
app.get('/api/ports', async (req, res) => {
  if (!SerialPortPackage) {
    return res.status(500).json({ error: 'SerialPort library not available' });
  }
  try {
    const ports = await SerialPortPackage.list();
    res.json({ ports });
  } catch (err) {
    res.status(500).json({ error: `Failed to list ports: ${err.message}` });
  }
});

// 3. Connect USB Serial
app.post('/api/connect/usb', async (req, res) => {
  const { port, baudRate } = req.body;
  if (!port) {
    return res.status(400).json({ error: 'COM port name is required (e.g., COM3, COM7)' });
  }

  try {
    const result = await connectUsb(port, baudRate || 115200);
    res.json({ success: true, message: `Connected to ${port}`, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Disconnect USB Serial
app.post('/api/disconnect/usb', (req, res) => {
  if (state.mode === 'USB') {
    const port = state.usbPortName;
    resetAllModes();
    addLog('USB', `Manually disconnected from ${port}`);
    return res.json({ success: true, message: `Disconnected from ${port}` });
  }
  res.json({ success: true, message: 'USB was not active' });
});

// 5. Connect Wi-Fi IP
app.post('/api/connect/wifi', async (req, res) => {
  const { ip } = req.body;
  if (!ip) {
    return res.status(400).json({ error: 'ESP32 IP address is required (e.g. 192.168.1.105)' });
  }

  try {
    const result = await connectWifi(ip);
    res.json({ success: true, message: `Connected to ESP32 at ${ip}`, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// 6. Disconnect Wi-Fi IP
app.post('/api/disconnect/wifi', (req, res) => {
  if (state.mode === 'WIFI') {
    const ip = state.wifiIp;
    resetAllModes();
    addLog('WIFI', `Disconnected from ESP32 at ${ip}`);
    return res.json({ success: true, message: `Disconnected from ${ip}` });
  }
  res.json({ success: true, message: 'Wi-Fi mode was not active' });
});

// 7. Toggle Demonstration Mode
app.post('/api/demo/toggle', (req, res) => {
  if (state.mode === 'DEMO') {
    resetAllModes();
    addLog('DEMO', 'Demonstration mode stopped.');
    res.json({ success: true, isDemo: false, message: 'Demo mode deactivated' });
  } else {
    startDemoMode();
    res.json({ success: true, isDemo: true, message: 'Demo mode activated' });
  }
});

// 8. Demo obstacle trigger (for testing obstacle interlock)
app.post('/api/demo/obstacle', (req, res) => {
  if (state.mode !== 'DEMO') {
    return res.status(400).json({ error: 'Obstacle injection is only available in Demo Mode' });
  }

  if (state.data.obstacleStatus === 'CLEAR') {
    state.data.obstacleStatus = 'DETECTED';
    state.data.obstacleDistance = 12.0; // 12 cm obstacle
    if (state.data.trolleyStatus === 'MOVING') {
      state.data.trolleyStatus = 'STOPPED';
      addLog('DEMO', 'Obstacle detected ahead! Simulated trolley halted autonomously.');
    } else {
      addLog('DEMO', 'Simulated obstacle injected (12 cm).');
    }
  } else {
    state.data.obstacleStatus = 'CLEAR';
    state.data.obstacleDistance = 85.0;
    addLog('DEMO', 'Simulated obstacle removed.');
  }

  res.json({
    success: true,
    obstacleStatus: state.data.obstacleStatus,
    obstacleDistance: state.data.obstacleDistance,
    trolleyStatus: state.data.trolleyStatus
  });
});

// 9. Send Command to ESP32
app.post('/api/command', async (req, res) => {
  const { command } = req.body;
  if (!command) {
    return res.status(400).json({ error: 'Command parameter is required' });
  }

  if (state.mode === 'NONE' || !state.connected) {
    return res.status(400).json({ error: 'No active connection. Connect via USB, Wi-Fi, or enable Demo Mode first.' });
  }

  // Handle Demo Mode commands
  if (state.mode === 'DEMO') {
    const cmd = command.toUpperCase();
    if (cmd === 'START' || cmd === 'START_TROLLEY') {
      if (state.data.obstacleStatus === 'DETECTED') {
        return res.status(422).json({ error: 'Safety Interlock: Cannot start trolley! Obstacle detected ahead within 25 cm.' });
      }
      state.data.trolleyStatus = 'MOVING';
      const feedNote = state.data.feedStatus === 'LOW' ? ' (Notice: Hopper feed is low)' : '';
      addLog('COMMAND', `Trolley started moving forward${feedNote} (DEMO)`);
      return res.json({ success: true, message: `Trolley started moving forward.${feedNote}`, data: state.data });
    }
    else if (cmd === 'STOP' || cmd === 'STOP_TROLLEY') {
      state.data.trolleyStatus = 'STOPPED';
      addLog('COMMAND', 'Trolley stopped (DEMO)');
      return res.json({ success: true, message: 'Trolley stopped.', data: state.data });
    }
    else if (cmd === 'OPEN_GATE') {
      state.data.gateStatus = 'OPEN';
      addLog('COMMAND', 'Feed dispensing gate OPENED (DEMO)');
      return res.json({ success: true, message: 'Feed dispensing gate opened.', data: state.data });
    }
    else if (cmd === 'CLOSE_GATE') {
      state.data.gateStatus = 'CLOSED';
      addLog('COMMAND', 'Feed dispensing gate CLOSED (DEMO)');
      return res.json({ success: true, message: 'Feed dispensing gate closed.', data: state.data });
    }
    else if (cmd === 'EMERGENCY_STOP') {
      state.data.trolleyStatus = 'STOPPED';
      state.data.gateStatus = 'CLOSED';
      addLog('COMMAND', 'EMERGENCY STOP executed! All actuators halted (DEMO)');
      return res.json({ success: true, message: 'Emergency stop executed successfully.', data: state.data });
    }
    else if (cmd === 'TARE') {
      state.data.feedWeight = 5000;
      state.data.feedDispensed = 0;
      addLog('COMMAND', 'Scale reset & hopper refilled to 5000g (DEMO)');
      return res.json({ success: true, message: 'Scale tared to zero (Demo refilled to 5000g).', data: state.data });
    }
    return res.status(400).json({ error: `Unknown command: ${command}` });
  }

  // Handle USB Serial Mode
  if (state.mode === 'USB') {
    try {
      await sendUsbCommand(command);
      addLog('COMMAND', `Sent command over USB: ${command}`);
      return res.json({ success: true, message: `Command '${command}' sent over USB Serial.` });
    } catch (err) {
      addLog('ERROR', `USB Command Error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  // Handle Wi-Fi IP Mode
  if (state.mode === 'WIFI') {
    try {
      const response = await sendWifiCommand(state.wifiIp, command);
      addLog('COMMAND', `ESP32 Wi-Fi Response: ${response.message || response.status}`);
      return res.json({ success: true, esp32Response: response });
    } catch (err) {
      addLog('ERROR', `Wi-Fi Command Error: ${err.message}`);
      return res.status(502).json({ error: `Failed to send command to ESP32: ${err.message}` });
    }
  }
});

// =====================================================================================
// START EXPRESS SERVER
// =====================================================================================
app.listen(PORT, () => {
  console.log('===================================================================');
  console.log(`POULTRY FEED TROLLEY MONITORING SYSTEM SERVER RUNNING`);
  console.log(`Access Web Dashboard at: http://localhost:${PORT}`);
  console.log('===================================================================');
});
