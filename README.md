<<<<<<< HEAD
# IoT-Based Poultry Feed Trolley Monitoring System Using ESP32

A complete, college-level IoT project featuring an autonomous/remote poultry feed distribution trolley powered by an **ESP32 DevKit V1** microcontroller, paired with a modern, responsive web dashboard built with **HTML5, CSS3, JavaScript, and Node.js/Express.js**.

---

## 📌 Project Overview

This system monitors and controls a feed-dispensing trolley inside a poultry farm. It tracks:
1. **Current Feed Weight (grams)** using an **HX711 Load Cell** amplifier.
2. **Estimated Feed Dispensed (grams)** calculated via real-time differential weight.
3. **Trolley Motion Status** (Moving or Stopped) driven by an **L298N Motor Driver**.
4. **Feed Gate Status** (Open or Closed) actuated by a **Servo Motor**.
5. **Obstacle Detection** (Clear or Detected) via an **HC-SR04 Ultrasonic Sensor** with autonomous safety halts.
6. **Feed Availability** (Available or Low) based on a configurable hopper threshold.
7. **ESP32 Connection State** with dual-mode support (USB Serial or Wi-Fi IP).
8. **Live Telemetry & Safety Event Logs** kept purely in application runtime memory (**No Database Required**).

---

## 📁 Project Folder Structure

```text
poultry-feed-trolley/
│
├── package.json                # Node.js project manifest & dependencies
├── server.js                   # Express backend server with USB & Wi-Fi handlers
├── README.md                   # Comprehensive project documentation & guide
│
├── public/                     # Frontend web application
│   ├── index.html              # Modern, responsive dashboard markup
│   ├── style.css               # Clean styling, indicators & animations
│   └── app.js                  # Real-time polling, commands & UI logic
│
└── esp32/                      # Microcontroller firmware
    ├── poultry_feed_trolley.ino # Complete Arduino sketch for ESP32 DevKit V1
    └── libraries.txt           # Required Arduino IDE libraries list
```

---

## ⚡ Hardware Wiring & Pin Mapping

### ESP32 DevKit V1 Pin Connections

| Peripheral / Sensor | Peripheral Pin | ESP32 GPIO Pin | Description / Special Notes |
| :--- | :--- | :--- | :--- |
| **HX711 Load Cell** | DOUT | **GPIO 19** | Digital serial data input |
| | SCK | **GPIO 18** | Digital clock output |
| | VCC / GND | 5V / GND | Regulated power |
| **HC-SR04 Ultrasonic** | TRIG | **GPIO 5** | 10µs trigger pulse output |
| | ECHO | **GPIO 34** | **Requires Voltage Divider!** (See note below) |
| | VCC / GND | 5V / GND | Sensor operating voltage |
| **L298N Motor Driver** | ENA | **GPIO 25** | Motor A Speed Enable (PWM) |
| | IN1 | **GPIO 26** | Motor A Direction 1 |
| | IN2 | **GPIO 27** | Motor A Direction 2 |
| | IN3 | **GPIO 32** | Motor B Direction 1 |
| | IN4 | **GPIO 33** | Motor B Direction 2 |
| | ENB | **GPIO 14** | Motor B Speed Enable (PWM) |
| | GND | Common GND | Connect ESP32 GND and Motor Power GND together! |
| **Servo Motor** | Signal (PWM) | **GPIO 13** | Feed Gate valve control (0° to 90°) |
| | VCC / GND | 5V / GND | External 5V power supply recommended |
| **Optional I2C LCD** | SDA | **GPIO 21** | I2C Data line |
| | SCL | **GPIO 22** | I2C Clock line |

> [!WARNING]
> **HC-SR04 5V ECHO Level Shifter / Voltage Divider Protection:**  
> The HC-SR04 operates at 5V, meaning its `ECHO` pin emits a 5V signal. However, ESP32 GPIO pins tolerate a maximum of **3.3V**. Connect a voltage divider between ECHO and GPIO 34:
> - Connect `ECHO` to a **1 kΩ resistor**.
> - Connect the other end of the 1 kΩ resistor to **GPIO 34**.
> - From GPIO 34, connect a **2 kΩ resistor** to `GND`.  
> This safely scales the voltage to $(2 / (1 + 2)) \times 5\text{V} \approx 3.33\text{V}$.

---

## 🔌 Communication Modes

The project supports two independent, mutually exclusive communication modes:

### Mode A: USB Serial Mode
- Connect your ESP32 to the computer using a micro-USB / USB-C data cable.
- The Node.js server uses the `serialport` package to read newline-delimited JSON telemetry at **115200 baud**.
- You can scan and select your COM port (e.g., `COM3`, `COM7`) directly from the dashboard.

### Mode B: Wi-Fi IP Mode
- The ESP32 connects to your local Wi-Fi router or smartphone hotspot and starts a lightweight REST WebServer on port 80.
- The ESP32 prints its assigned IP address in the Arduino Serial Monitor upon booting.
- Enter this IP address in the dashboard (e.g., `192.168.1.105`) and click **Connect Using IP**.
- The backend polls `/api/status` and forwards commands to `/api/command`.

> [!NOTE]
> Only **one active communication mode** can run at any given time to eliminate conflicting commands.

---

## 🛠️ Step-by-Step Setup Instructions

### 1. Prerequisites
- Install **Node.js** (v18.0.0 or higher recommended): [Download Node.js](https://nodejs.org/)
- Install **Arduino IDE** (v2.x recommended): [Download Arduino IDE](https://www.arduino.cc/en/software)

### 2. Install Arduino IDE Libraries & ESP32 Board Core
1. In Arduino IDE, open **Tools** → **Board** → **Boards Manager...**
2. Search for `esp32` by *Espressif Systems* and click **Install**.
3. Under **Tools** → **Manage Libraries...** (Ctrl+Shift+I), install:
   - `ArduinoJson` (by Benoit Blanchon)
   - `HX711 Arduino Library` (by Bogdan Necula)
   - `ESP32Servo` (by Kevin Harrington)
   - `LiquidCrystal_I2C` (by Frank de Brabander) - *Only if using LCD display*

### 3. Configure and Upload the ESP32 Code
1. Open the file `esp32/poultry_feed_trolley.ino` in Arduino IDE.
2. Update the Wi-Fi credentials around line 57:
   ```cpp
   const char* WIFI_SSID     = "Your_WiFi_Name";
   const char* WIFI_PASSWORD = "Your_WiFi_Password";
   ```
3. Connect the ESP32 to your PC using a USB cable.
4. In Arduino IDE, select your board: **DOIT ESP32 DEVKIT V1** (or **ESP32 Dev Module**).
5. Select the correct **COM Port** under **Tools** → **Port**.
6. Click **Upload** (arrow icon).
7. Once uploaded, open the **Serial Monitor** at **115200 baud**.
8. Press the `EN` (Reset) button on the ESP32. Look for the message:
   ```text
   [SUCCESS] Wi-Fi Connected!
   [INFO] ESP32 IP Address: 192.168.1.105
   ```
   *(Note down this IP address for Wi-Fi Mode)*.

### 4. Install Node.js Backend Dependencies
Open your terminal (PowerShell, Command Prompt, or VS Code integrated terminal) in this project folder:
```bash
npm install
```

### 5. Run the Backend Server
Start the Express server:
```bash
npm start
```
You should see:
```text
===================================================================
POULTRY FEED TROLLEY MONITORING SYSTEM SERVER RUNNING
Access Web Dashboard at: http://localhost:3000
===================================================================
```

### 6. Open the Dashboard
Open your web browser and navigate to:
```text
http://localhost:3000
```

---

## 🧪 Testing the System

### Option A: Testing Without Hardware (Hardware Demo Mode)
If your ESP32 hardware is not assembled yet:
1. Open `http://localhost:3000`.
2. Click on the **Hardware Demo Mode** tab in the communication setup panel.
3. Click **Start Demo Mode**.
4. The dashboard will display the **DEMO MODE ACTIVE** badge and simulate hopper weight, dispensing, and trolley status.
5. Click **Simulate Obstacle** to test how the safety interlock automatically stops the trolley and prevents it from moving forward!

### Option B: Testing USB Serial Mode
1. Ensure the ESP32 is plugged into your PC via USB.
2. Select the **USB Serial Mode** tab.
3. Click **Scan Ports**, select your ESP32 COM port from the dropdown, and click **Connect USB**.
4. Live weight, obstacle distance, and trolley telemetry will immediately stream to the dashboard.
5. Click **Start Trolley** or **Open Feed Gate** to test actuator commands.

### Option C: Testing Wi-Fi IP Mode
1. Make sure your PC and ESP32 are on the same Wi-Fi network.
2. Select the **Wi-Fi IP Mode** tab.
3. Enter the ESP32 IP address obtained from the Serial Monitor (e.g. `192.168.1.105`).
4. Click **Connect Using IP**.
5. The dashboard establishes a periodic HTTP REST sync.

---

## 🛡️ Safety Interlocks & Emergency Stop

1. **Obstacle Collision Avoidance:**
   - If an obstacle is detected within **25 cm** by the HC-SR04 ultrasonic sensor, the ESP32 firmware **autonomously halts the trolley motors immediately**, regardless of dashboard commands.
   - The dashboard disables the "Start Trolley" button and displays an interlock warning.
2. **Low Feed Protection:**
   - When the hopper weight drops below **500 grams**, the trolley start action is blocked until the hopper is refilled.
3. **Emergency Stop (E-Stop):**
   - Clicking **EMERGENCY STOP** immediately halts both drive motors and shuts the feed gate servo.
   - *Advisory Note: Browser-based emergency stopping depends on active network/USB connectivity and does not replace a physical emergency-stop kill switch on the trolley chassis.*

---

## 🚫 No Database Architecture

- **No external database** (no MySQL, Firebase, MongoDB, or PostgreSQL) is used.
- All telemetry and recent logs are held strictly in **volatile application memory (RAM)** while the Node.js server is running.
- When the Node.js server restarts, temporary logs are cleanly reset.

---

## 🎓 College Project Viva / Presentation Q&A Reference

- **Q: Why use ESP32 instead of Arduino Uno?**  
  *A: The ESP32 features a 240MHz dual-core 32-bit processor, built-in 802.11 b/g/n Wi-Fi, hardware PWM timers, and multiple ADCs, eliminating the need for external Wi-Fi shields.*
- **Q: How does the load cell calculate weight?**  
  *A: The strain gauge bridges produce microvolt changes amplified by the 24-bit HX711 ADC. A calibration factor scales raw counts into grams.*
- **Q: How is safety guaranteed over latency?**  
  *A: Collision avoidance is implemented directly in the ESP32 firmware loop (`updateSensors()`), ensuring instantaneous motor cut-off independent of Wi-Fi or USB communication delay.*
#   T R A L L Y  
 #   T R A L L Y  
 
=======
# TRALLY
>>>>>>> 92279efba0458b1a98a3dab9a4ca5ee6d7b9866f
