/*
 * =====================================================================================
 * PROJECT: IoT-Based Poultry Feed Trolley Monitoring System Using ESP32
 * TARGET HARDWARE: ESP32 DevKit V1 (30-pin or 38-pin)
 * 
 * SENSORS & ACTUATORS:
 * 1. HX711 Load Cell Amplifier (Hopper Feed Weight Measurement)
 *    - DOUT: GPIO 19
 *    - SCK:  GPIO 18
 * 2. HC-SR04 Ultrasonic Distance Sensor (Obstacle Detection)
 *    - TRIG: GPIO 5
 *    - ECHO: GPIO 34 (input-only, use voltage divider to drop 5V to 3.3V)
 * 3. L298N Dual H-Bridge Motor Driver (Trolley DC Motors)
 *    - Motor A: ENA=25, IN1=26, IN2=27
 *    - Motor B: IN3=32, IN4=33, ENB=14
 * 4. Micro Servo SG90 / MG90S / MG995 (Feed Dispensing Gate Valve)
 *    - PWM Signal: GPIO 13
 * 5. External I2C LCD (16x2 or 20x4 PCF8574 module)
 *    - SDA: GPIO 21
 *    - SCL: GPIO 22
 *    - Auto-detects I2C addresses 0x27 and 0x3F!
 * 
 * COMMUNICATION MODES SUPPORTED:
 * A. USB Serial Mode: 115200 Baud, sends & receives newline-delimited JSON & plain text.
 * B. Wi-Fi IP Mode: HTTP Web Server on Port 80 (/api/status & /api/command).
 * =====================================================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "HX711.h"

// =====================================================================================
// 1. PIN CONFIGURATIONS
// =====================================================================================

// HX711 Load Cell Pins
const int PIN_HX711_DOUT = 19;
const int PIN_HX711_SCK  = 18;

// HC-SR04 Ultrasonic Sensor Pins
const int PIN_TRIG = 5;
const int PIN_ECHO = 34; // Input-only on ESP32

// L298N Motor Driver Pins
const int PIN_ENA = 25;  // Motor A Speed Enable
const int PIN_IN1 = 26;  // Motor A Direction 1
const int PIN_IN2 = 27;  // Motor A Direction 2
const int PIN_IN3 = 32;  // Motor B Direction 1
const int PIN_IN4 = 33;  // Motor B Direction 2
const int PIN_ENB = 14;  // Motor B Speed Enable

// Servo Motor Pin for Feed Gate
const int PIN_SERVO = 13;

// I2C Pins for External Display (ESP32 Defaults: SDA=21, SCL=22)
const int PIN_SDA = 21;
const int PIN_SCL = 22;

// Built-in status LED
const int PIN_LED = 2;

// =====================================================================================
// 2. WI-FI CREDENTIALS CONFIGURATION
// =====================================================================================
const char* WIFI_SSID     = "THE BEAST";
const char* WIFI_PASSWORD = "78451810";

// =====================================================================================
// 3. OPERATIONAL THRESHOLDS & CALIBRATION
// =====================================================================================
float CALIBRATION_FACTOR = 219.0942; 

// Low feed threshold in grams
const float LOW_FEED_THRESHOLD_GRAMS = 500.0; 

// Obstacle threshold distance in centimeters
const float OBSTACLE_THRESHOLD_CM = 25.0; 

// Servo angles for feed gate valve
const int GATE_CLOSED_ANGLE = 0;   // 0 degrees = Closed shut
const int GATE_OPEN_ANGLE   = 90;  // 90 degrees = Open dispensing

// =====================================================================================
// 4. GLOBAL OBJECTS & STATE VARIABLES
// =====================================================================================
HX711 scale;
Servo feedServo;
WebServer server(80);

// External I2C LCD Pointer and Detection
LiquidCrystal_I2C* lcd = nullptr;
uint8_t lcdI2CAddress = 0;
bool lcdAvailable = false;

// System states
float currentFeedWeight = 0.0;     // Current grams in hopper
float initialFeedWeight = 0.0;     // Starting grams for dispensed calculation
float feedDispensed     = 0.0;     // Grams dispensed since start
float obstacleDistance  = 100.0;   // Measured distance in cm
int   obstacleDebounceCount = 0;   // Noise rejection filter

String trolleyStatus  = "STOPPED";   // "MOVING" or "STOPPED"
String gateStatus     = "CLOSED";    // "OPEN" or "CLOSED"
String obstacleStatus = "CLEAR";     // "CLEAR" or "DETECTED"
String feedStatus     = "AVAILABLE"; // "AVAILABLE" or "LOW"

unsigned long lastSerialBroadcast = 0;
const unsigned long SERIAL_INTERVAL = 1000; // Broadcast every 1 second

// =====================================================================================
// 5. EXTERNAL DISPLAY FUNCTIONS (Auto-Scanning I2C 16x2 / 20x4 LCD)
// =====================================================================================

uint8_t scanI2CAddress() {
  uint8_t standardAddrs[] = { 0x27, 0x3F, 0x38, 0x20, 0x26 };
  for (uint8_t i = 0; i < sizeof(standardAddrs); i++) {
    Wire.beginTransmission(standardAddrs[i]);
    if (Wire.endTransmission() == 0) {
      return standardAddrs[i];
    }
  }
  // If not found in standard list, do full 1-127 scan
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      return addr;
    }
  }
  return 0; // No I2C device detected
}

void initExternalDisplay() {
  Wire.begin(PIN_SDA, PIN_SCL);
  delay(100);

  lcdI2CAddress = scanI2CAddress();
  if (lcdI2CAddress != 0) {
    Serial.print("[INFO] I2C Display detected at address: 0x");
    Serial.println(lcdI2CAddress, HEX);

    lcd = new LiquidCrystal_I2C(lcdI2CAddress, 16, 2);
    lcd->init();
    lcd->backlight();
    lcd->clear();
    lcd->setCursor(0, 0);
    lcd->print("POULTRY TROLLEY");
    lcd->setCursor(0, 1);
    lcd->print("ESP32 READY");
    lcdAvailable = true;
  } else {
    Serial.println("[WARNING] No I2C LCD detected on SDA(21)/SCL(22). Display output disabled.");
    lcdAvailable = false;
  }
}

void updateExternalDisplay() {
  if (!lcdAvailable || lcd == nullptr) return;

  // Row 0: Weight & Trolley Status
  char row0[17];
  int wt = (int)round(currentFeedWeight);
  const char* trStr = (trolleyStatus == "MOVING") ? "RUN" : "STP";
  snprintf(row0, sizeof(row0), "Wt:%4dg Tr:%-3s", wt, trStr);

  // Row 1: Obstacle & Gate Status
  char row1[17];
  int dist = (int)round(obstacleDistance);
  if (dist > 999) dist = 999;
  const char* gtStr = (gateStatus == "OPEN") ? "OPN" : "CLS";
  snprintf(row1, sizeof(row1), "Obs:%3dcm Gt:%-3s", dist, gtStr);

  lcd->setCursor(0, 0);
  lcd->print(row0);
  lcd->setCursor(0, 1);
  lcd->print(row1);
}

// =====================================================================================
// 6. MOTOR & HARDWARE ACTUATOR CONTROL FUNCTIONS
// =====================================================================================

void initMotors() {
  pinMode(PIN_ENA, OUTPUT);
  pinMode(PIN_IN1, OUTPUT);
  pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_IN3, OUTPUT);
  pinMode(PIN_IN4, OUTPUT);
  pinMode(PIN_ENB, OUTPUT);
  
  stopTrolley();
}

void moveTrolleyForward() {
  // Safety Interlock Check
  if (obstacleStatus == "DETECTED") {
    Serial.println("{\"error\":\"Safety Interlock: Cannot start trolley! Obstacle detected ahead within 25 cm.\"}");
    return;
  }
  if (feedStatus == "LOW") {
    Serial.println("{\"warning\":\"Notice: Trolley moving with low feed hopper level.\"}");
  }

  // Motor A Forward (Full drive torque)
  digitalWrite(PIN_IN1, HIGH);
  digitalWrite(PIN_IN2, LOW);
  digitalWrite(PIN_ENA, HIGH);

  // Motor B Forward (Full drive torque)
  digitalWrite(PIN_IN3, HIGH);
  digitalWrite(PIN_IN4, LOW);
  digitalWrite(PIN_ENB, HIGH);

  trolleyStatus = "MOVING";
  digitalWrite(PIN_LED, HIGH);
  Serial.println("{\"event\":\"TROLLEY_STARTED\",\"trolleyStatus\":\"MOVING\"}");

  updateExternalDisplay();
}

void stopTrolley() {
  // Motor A Stop
  digitalWrite(PIN_IN1, LOW);
  digitalWrite(PIN_IN2, LOW);
  digitalWrite(PIN_ENA, LOW);

  // Motor B Stop
  digitalWrite(PIN_IN3, LOW);
  digitalWrite(PIN_IN4, LOW);
  digitalWrite(PIN_ENB, LOW);

  trolleyStatus = "STOPPED";
  digitalWrite(PIN_LED, LOW);
  Serial.println("{\"event\":\"TROLLEY_STOPPED\",\"trolleyStatus\":\"STOPPED\"}");

  updateExternalDisplay();
}

void openFeedGate() {
  if (!feedServo.attached()) {
    feedServo.attach(PIN_SERVO, 500, 2400);
  }
  // Smooth angle stepping prevents sudden current inrush spike that can cause ESP32 brownout
  for (int a = GATE_CLOSED_ANGLE; a <= GATE_OPEN_ANGLE; a += 15) {
    feedServo.write(a);
    delay(20);
  }
  feedServo.write(GATE_OPEN_ANGLE);
  gateStatus = "OPEN";
  Serial.println("{\"event\":\"GATE_OPENED\",\"gateStatus\":\"OPEN\",\"angle\":90}");

  updateExternalDisplay();
}

void closeFeedGate() {
  if (!feedServo.attached()) {
    feedServo.attach(PIN_SERVO, 500, 2400);
  }
  // Smooth angle stepping
  for (int a = GATE_OPEN_ANGLE; a >= GATE_CLOSED_ANGLE; a -= 15) {
    feedServo.write(a);
    delay(20);
  }
  feedServo.write(GATE_CLOSED_ANGLE);
  gateStatus = "CLOSED";
  Serial.println("{\"event\":\"GATE_CLOSED\",\"gateStatus\":\"CLOSED\",\"angle\":0}");

  updateExternalDisplay();
}

void emergencyStop() {
  stopTrolley();
  closeFeedGate();
  Serial.println("{\"event\":\"EMERGENCY_STOP_TRIGGERED\",\"status\":\"HALTED\"}");
  if (lcdAvailable && lcd != nullptr) {
    lcd->clear();
    lcd->setCursor(0, 0);
    lcd->print("EMERGENCY STOP!");
    lcd->setCursor(0, 1);
    lcd->print("ALL MOTORS HALT");
  }
}

// =====================================================================================
// 7. SENSOR READING FUNCTIONS (Ultrasonic & HX711 Load Cell)
// =====================================================================================

float readUltrasonicDistance() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  // Read ECHO pulse duration (timeout: 25ms = ~4.2 meters max)
  long duration = pulseIn(PIN_ECHO, HIGH, 25000);
  if (duration <= 0) {
    return 999.0; // Out of range or no reflection
  }

  // Speed of sound: 343 m/s = 0.0343 cm/microsecond
  float distance = (duration * 0.0343) / 2.0;
  return distance;
}

void updateSensors() {
  // 1. Read Obstacle Sensor with 2-sample debounce noise filter
  float measuredDist = readUltrasonicDistance();
  
  if (measuredDist > 2.0 && measuredDist <= OBSTACLE_THRESHOLD_CM) {
    obstacleDebounceCount++;
    if (obstacleDebounceCount >= 2) { // Confirmed after 2 consecutive reads
      obstacleStatus = "DETECTED";
      obstacleDistance = measuredDist;

      // Immediate Autonomous Safety Stop if obstacle encountered while moving
      if (trolleyStatus == "MOVING") {
        stopTrolley();
        Serial.println("{\"warning\":\"Obstacle detected ahead! Trolley stopped autonomously.\"}");
      }
    }
  } else {
    obstacleDebounceCount = 0;
    obstacleStatus = "CLEAR";
    if (measuredDist > 2.0 && measuredDist < 450.0) {
      obstacleDistance = measuredDist;
    }
  }

  // 2. Read Load Cell Feed Weight
  if (scale.is_ready() || scale.wait_ready_timeout(80)) {
    float reading = scale.get_units(3); // Average of 3 readings
    
    // Auto-correct for reversed load cell wiring or inverted calibration
    if (reading < -1.0) {
      reading = abs(reading);
    } else if (reading < 0) {
      reading = 0.0;
    }
    currentFeedWeight = reading;

    // Calculate dispensed weight
    if (initialFeedWeight > 0 && initialFeedWeight >= currentFeedWeight) {
      feedDispensed = initialFeedWeight - currentFeedWeight;
    } else {
      feedDispensed = 0.0;
    }

    // Check feed availability status (sets alert warning, but never forces manual gate shut!)
    if (currentFeedWeight <= LOW_FEED_THRESHOLD_GRAMS) {
      feedStatus = "LOW";
    } else {
      feedStatus = "AVAILABLE";
    }
  }
}

// =====================================================================================
// 8. JSON GENERATION (Unified for USB Serial and HTTP API)
// =====================================================================================

String buildStatusJson() {
  StaticJsonDocument<384> doc;
  doc["feedWeight"]        = round(currentFeedWeight * 10.0) / 10.0;
  doc["feedDispensed"]     = round(feedDispensed * 10.0) / 10.0;
  doc["trolleyStatus"]     = trolleyStatus;
  doc["gateStatus"]        = gateStatus;
  doc["obstacleStatus"]    = obstacleStatus;
  doc["feedStatus"]        = feedStatus;
  doc["obstacleDistance"]  = round(obstacleDistance * 10.0) / 10.0;
  doc["ipAddress"]         = (WiFi.status() == WL_CONNECTED) ? WiFi.localIP().toString() : "DISCONNECTED";

  String output;
  serializeJson(doc, output);
  return output;
}

// =====================================================================================
// 9. COMMAND PROCESSING (Unified for Serial and HTTP)
// =====================================================================================

bool processCommand(String cmd, String &replyMessage) {
  cmd.trim();
  cmd.toUpperCase();

  if (cmd == "START" || cmd == "START_TROLLEY") {
    if (obstacleStatus == "DETECTED") {
      replyMessage = "Cannot start trolley: Obstacle detected ahead.";
      return false;
    }
    moveTrolleyForward();
    replyMessage = (feedStatus == "LOW") 
      ? "Trolley started moving forward (Hopper feed is low)."
      : "Trolley started moving forward.";
    return true;
  }
  else if (cmd == "STOP" || cmd == "STOP_TROLLEY") {
    stopTrolley();
    replyMessage = "Trolley stopped.";
    return true;
  }
  else if (cmd == "OPEN_GATE") {
    openFeedGate();
    replyMessage = "Feed dispensing gate OPENED.";
    return true;
  }
  else if (cmd == "CLOSE_GATE") {
    closeFeedGate();
    replyMessage = "Feed dispensing gate CLOSED.";
    return true;
  }
  else if (cmd == "EMERGENCY_STOP") {
    emergencyStop();
    replyMessage = "Emergency stop executed. All motors stopped and gate closed.";
    return true;
  }
  else if (cmd == "TARE") {
    if (scale.is_ready()) {
      scale.tare();
      currentFeedWeight = 0.0;
      initialFeedWeight = 0.0;
      feedDispensed = 0.0;
      replyMessage = "Scale tared successfully to zero.";
      return true;
    } else {
      replyMessage = "HX711 scale not ready for tare.";
      return false;
    }
  }
  else if (cmd == "SET_INITIAL") {
    initialFeedWeight = currentFeedWeight;
    feedDispensed = 0.0;
    replyMessage = "Initial feed weight recorded for dispense tracking.";
    return true;
  }
  else {
    replyMessage = "Unknown command received: " + cmd;
    return false;
  }
}

// =====================================================================================
// 10. HTTP REST API HANDLERS (Wi-Fi Mode)
// =====================================================================================

void sendCORSHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

void handleOptions() {
  sendCORSHeaders();
  server.send(204);
}

void handleGetStatus() {
  sendCORSHeaders();
  updateSensors();
  String json = buildStatusJson();
  server.send(200, "application/json", json);
}

void handlePostCommand() {
  sendCORSHeaders();
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"status\":\"ERROR\",\"message\":\"Missing request body\"}");
    return;
  }

  String body = server.arg("plain");
  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, body);

  if (error) {
    server.send(400, "application/json", "{\"status\":\"ERROR\",\"message\":\"Invalid JSON\"}");
    return;
  }

  const char* cmd = doc["command"];
  if (!cmd) {
    server.send(400, "application/json", "{\"status\":\"ERROR\",\"message\":\"Field 'command' missing\"}");
    return;
  }

  String replyMsg;
  bool success = processCommand(String(cmd), replyMsg);

  StaticJsonDocument<256> resDoc;
  resDoc["status"] = success ? "OK" : "REJECTED";
  resDoc["message"] = replyMsg;
  resDoc["trolleyStatus"] = trolleyStatus;
  resDoc["gateStatus"] = gateStatus;

  String resJson;
  serializeJson(resDoc, resJson);
  server.send(success ? 200 : 422, "application/json", resJson);
}

// =====================================================================================
// 11. SERIAL MONITOR & WEB SERIAL COMMAND PARSER (USB Mode)
// =====================================================================================

void checkSerialInput() {
  if (Serial.available() > 0) {
    String input = Serial.readStringUntil('\n');
    input.trim();
    if (input.length() == 0) return;

    // Check if input is a JSON object e.g. {"command":"START"}
    if (input.startsWith("{") && input.endsWith("}")) {
      StaticJsonDocument<256> doc;
      DeserializationError err = deserializeJson(doc, input);
      if (!err && doc.containsKey("command")) {
        const char* cmd = doc["command"];
        String reply;
        bool ok = processCommand(String(cmd), reply);
        
        StaticJsonDocument<256> resp;
        resp["type"] = "COMMAND_ACK";
        resp["status"] = ok ? "OK" : "REJECTED";
        resp["message"] = reply;
        String respStr;
        serializeJson(resp, respStr);
        Serial.println(respStr);
        return;
      }
    }

    // Direct plain text command support over serial (e.g. "START", "STOP", "OPEN_GATE")
    String reply;
    bool ok = processCommand(input, reply);
    Serial.println("{\"type\":\"COMMAND_ACK\",\"status\":\"" + String(ok ? "OK" : "REJECTED") + "\",\"message\":\"" + reply + "\"}");
  }
}

// =====================================================================================
// 12. SETUP
// =====================================================================================

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(50); // Set short timeout so readStringUntil never stalls the loop
  delay(500);

  Serial.println();
  Serial.println("==================================================");
  Serial.println("POULTRY FEED TROLLEY MONITORING SYSTEM - ESP32");
  Serial.println("==================================================");

  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);

  // Initialize Ultrasonic Sensor Pins
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);

  // Initialize Motors
  initMotors();

  // Initialize Servo Timers & Pin (Critical for ESP32Servo!)
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  feedServo.setPeriodHertz(50); // Standard 50Hz servo
  feedServo.attach(PIN_SERVO, 500, 2400);
  closeFeedGate();
  Serial.println("[INFO] Servo motor initialized on GPIO 13.");

  // Initialize External I2C LCD Display (with auto-scanning!)
  initExternalDisplay();

  // Initialize HX711 Load Cell
  Serial.println("[INFO] Initializing HX711 Load Cell...");
  scale.begin(PIN_HX711_DOUT, PIN_HX711_SCK);
  delay(300);
  if (scale.is_ready()) {
    scale.set_scale(CALIBRATION_FACTOR);
    scale.tare(); // Zero scale on startup
    Serial.println("[INFO] HX711 Load Cell calibrated and zeroed.");
  } else {
    Serial.println("[WARNING] HX711 not detected! Check DOUT (GPIO 19) and SCK (GPIO 18).");
  }

  // Connect to Wi-Fi (Non-blocking with 8-second timeout so USB Serial always runs!)
  Serial.print("[INFO] Connecting to Wi-Fi SSID: ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startAttemptTime = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttemptTime < 8000) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("--------------------------------------------------");
    Serial.println("[SUCCESS] Wi-Fi Connected!");
    Serial.print("[INFO] ESP32 IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.println("--------------------------------------------------");

    // Set up WebServer endpoints
    server.on("/api/status", HTTP_GET, handleGetStatus);
    server.on("/api/command", HTTP_POST, handlePostCommand);
    server.on("/api/command", HTTP_OPTIONS, handleOptions);
    server.on("/api/status", HTTP_OPTIONS, handleOptions);
    server.begin();
    Serial.println("[INFO] HTTP REST Server started on port 80.");

    if (lcdAvailable && lcd != nullptr) {
      lcd->clear();
      lcd->setCursor(0, 0);
      lcd->print("IP: ");
      lcd->print(WiFi.localIP().toString().substring(0, 12));
      lcd->setCursor(0, 1);
      lcd->print("STATUS: ONLINE");
    }
  } else {
    Serial.println("[WARNING] Wi-Fi Connection Timed Out.");
    Serial.println("[INFO] ESP32 operating in USB SERIAL / WEB SERIAL MODE.");
    if (lcdAvailable && lcd != nullptr) {
      lcd->clear();
      lcd->setCursor(0, 0);
      lcd->print("USB SERIAL MODE");
      lcd->setCursor(0, 1);
      lcd->print("READY @ 115200");
    }
  }

  // Record initial reading as baseline
  updateSensors();
  initialFeedWeight = currentFeedWeight;

  Serial.println("[INFO] Setup complete. Ready for USB Web Serial & Wi-Fi commands.");
}

// =====================================================================================
// 13. MAIN LOOP
// =====================================================================================

void loop() {
  // Handle incoming HTTP requests if Wi-Fi is connected
  if (WiFi.status() == WL_CONNECTED) {
    server.handleClient();
  }

  // Check incoming USB Serial / Web Serial commands (instant response)
  checkSerialInput();

  // Periodic sensor updates and JSON broadcast over Serial & External LCD
  unsigned long currentMillis = millis();
  if (currentMillis - lastSerialBroadcast >= SERIAL_INTERVAL) {
    lastSerialBroadcast = currentMillis;
    
    // Read hardware sensors
    updateSensors();

    // Broadcast newline-delimited JSON line over Serial
    String jsonOutput = buildStatusJson();
    Serial.println(jsonOutput);

    // Update physical external LCD display
    updateExternalDisplay();
  }
}
