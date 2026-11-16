/*
  GT3 RS Drift Car: ESP32 firmware for the Porsche cockpit web app  (v3, 2026-11-08)

  NEW IN v3: the app sends MOTOR:0..255 about 25 times a second. It is worked out from
  the app's GT3 RS gearbox model, so the drive power follows the gear and the revs:
  rev-limiter stutter at 9,000, a 0.1 s cut on each upshift, and gentle engine braking
  when you lift off. THROTTLE no longer drives the motor directly.
  Needs the matching cockpit app (app.js with MOTOR_TOP_KMH in its CONFIG).

  WHAT IT DOES
    1. Makes its own Wi-Fi hotspot "GT3_RS_Drift_Car" (the ESP32 is the router).
    2. Listens for the app on ws://192.168.4.1:81 (a WebSocket = a phone line that stays open).
    3. Reads the app's text commands and drives the two motors through the MX1508:
         MOTOR:0..255   BRAKE:0..255   STEER:-255..255   SHIFT_UP   SHIFT_DOWN
         (THROTTLE:0..255 still arrives, but only the app uses it, for its model)
    4. Tells the app which gear the car is in:  {"gear":"3"}
       (The app works out RPM and engine sound itself with its real GT3 RS gear ratios,
        so the ESP32 does NOT send rpm. If both sent RPM, the needle would fight itself.)

  LIBRARY (Arduino IDE > Tools > Manage Libraries):
    "WebSockets" by Markus Sattler   (only this one; the servo is driven without a library)
  BOARD: install "esp32 by Espressif Systems" version 3.x in Boards Manager,
         then pick Tools > Board > esp32 > "ESP32 Dev Module".

  WIRING (unchanged from the motor test, only the jobs of the pins moved):
    GPIO 18 -> MX1508 IN1  }  MOTOR-A = steering motor   (18 = right, 19 = left)
    GPIO 19 -> MX1508 IN2  }
    GPIO 21 -> MX1508 IN3  }  MOTOR-B = rear drive motor (22 = forward, 21 = backward)
    GPIO 22 -> MX1508 IN4  }
    GPIO 14 -> shift-kick servo signal (orange wire)   optional, see USE_KICK_SERVO
    ESP32 GND -> MX1508 GND -> battery minus   (all grounds joined, or nothing works)
*/

#include <WiFi.h>
#include <WebSocketsServer.h>

// ================= Settings you can change =================
// Hotspot name and password live in secrets.h, which git ignores.
// First time: copy secrets.example.h to secrets.h and pick your own password.
#include "secrets.h"

// Motor pins: same numbers as motor_test_keys.ino, where F went forward and L went left.
const int PIN_DRIVE_FWD   = 22;
const int PIN_DRIVE_REV   = 21;
const int PIN_STEER_LEFT  = 19;
const int PIN_STEER_RIGHT = 18;

// Shift kick: a 360-degree SG90 on GPIO 14 that twitches on every gear change.
const bool USE_KICK_SERVO = true;   // set to false if nothing is plugged into GPIO 14
const int  PIN_KICK_SERVO = 14;

// PWM = switching the motor on and off very fast; the on-share sets the power.
const int PWM_FREQ_HZ = 1000;   // same as the motor test. Try 5000 or 20000 for less whine.
const int MAX_DRIVE   = 255;    // top drive power 0..255. Use about 192 on a 2S LiPo.
const int MAX_STEER   = 255;    // steering power 0..255.
// The lowest power at which the drive motor still turns. Below it the motor only hums,
// so any MOTOR value above 0 starts here. Raise it if 1st gear doesn't creep off the line,
// lower it if 1st is too fast at low revs.
const int MIN_DRIVE   = 50;
// Safety: if the app's MOTOR updates stop (tab closed, phone asleep, Wi-Fi hiccup),
// cut the drive after this long.
const unsigned long MOTOR_TIMEOUT_MS = 300;

// Steering motor protection: a DC motor pushed against its end stop draws its biggest
// current and heats up. After STEER_FULL_MS at full power we drop to STEER_HOLD power.
const unsigned long STEER_FULL_MS = 400;
const int STEER_HOLD = 140;     // raise it if the wheels drift back to centre in long turns

const bool DEBUG_PRINT = true;  // print every command in the Serial Monitor (115200 baud)

// Same gear list, same order as the app (R, N, 1..6).
const char* GEARS[] = {"R", "N", "1", "2", "3", "4", "5", "6"};
const int GEAR_COUNT = 8;
const int GEAR_N = 1;

// ================= State =================
WebSocketsServer webSocket(81);

int throttle = 0;          // 0..255 from the app (pedal position, not used for driving)
int motor    = 0;          // 0..255 from the app: drive power from its gearbox model
unsigned long motorAt = 0; // when the last MOTOR command arrived
int brake    = 0;          // 0..255 from the app
int steer    = 0;          // -255 (left) .. 255 (right)
int gearIdx  = GEAR_N;     // start in neutral, so the car can't leap off the table

int lastSteerDir = 0;              // -1, 0 or +1
unsigned long steerSince = 0;      // when the current steering direction started

int kickStage = 0;                 // 0 = idle, 1 = spin one way, 2 = spin back
unsigned long kickStart = 0;

// ================= Motors =================
void updateDrive() {
  int fwd = 0, rev = 0;
  int power = motor > 0 ? map(motor, 1, 255, MIN_DRIVE, MAX_DRIVE) : 0;
  if (brake > 0) {
    // Both MX1508 inputs on together shorts the motor's two wires, which brakes it hard.
    fwd = rev = map(brake, 0, 255, 0, MAX_DRIVE);
  } else if (gearIdx == 0) {
    rev = power;                                     // R = reverse
  } else if (gearIdx >= 2) {
    fwd = power;                                     // 1..6 = forward
  }                                                  // N = free-rev, no drive
  ledcWrite(PIN_DRIVE_FWD, fwd);
  ledcWrite(PIN_DRIVE_REV, rev);
}

void updateSteer() {
  int dir = (steer > 0) - (steer < 0);
  if (dir != lastSteerDir) { lastSteerDir = dir; steerSince = millis(); }

  int power = map(abs(steer), 0, 255, 0, MAX_STEER);
  if (dir != 0 && millis() - steerSince > STEER_FULL_MS) power = min(power, STEER_HOLD);

  ledcWrite(PIN_STEER_LEFT,  dir < 0 ? power : 0);
  ledcWrite(PIN_STEER_RIGHT, dir > 0 ? power : 0);
}

void stopEverything() {
  throttle = 0; motor = 0; brake = 0; steer = 0;
  updateDrive();
  updateSteer();
}

// ================= Shift kick servo (no library) =================
// A servo wants one pulse every 20 ms (50 Hz). Pulse length: 1500 us = stop,
// shorter = spin one way, longer = spin the other. No pulses at all = silent.
void servoPulse(int us) {
  ledcWrite(PIN_KICK_SERVO, (uint32_t)us * 16384 / 20000);   // 14-bit duty for a 20 ms period
}

void startKick() {
  if (!USE_KICK_SERVO) return;
  servoPulse(2400);
  kickStart = millis();
  kickStage = 1;
}

void updateKick() {
  if (kickStage == 0) return;
  unsigned long t = millis() - kickStart;
  if (kickStage == 1 && t >= 80)       { servoPulse(600); kickStage = 2; }   // back the other way
  else if (kickStage == 2 && t >= 160) { ledcWrite(PIN_KICK_SERVO, 0); kickStage = 0; }   // quiet
}

// ================= Telling the app the gear =================
void sendGear(int client = -1) {
  char msg[24];
  snprintf(msg, sizeof(msg), "{\"gear\":\"%s\"}", GEARS[gearIdx]);
  if (client < 0) webSocket.broadcastTXT(msg);
  else            webSocket.sendTXT(client, msg);
}

void shiftGear(int dir) {
  int next = constrain(gearIdx + dir, 0, GEAR_COUNT - 1);
  if (next == gearIdx) return;     // already in R or 6th
  gearIdx = next;
  startKick();
  updateDrive();                   // e.g. dropping into N cuts the drive at once
  sendGear();
}

// ================= Reading the app's commands =================
void handleCommand(String cmd) {
  cmd.trim();
  // MOTOR arrives 25 times a second: printing it all would flood the Serial Monitor
  if (DEBUG_PRINT && !cmd.startsWith("MOTOR:")) Serial.println(cmd);

  if (cmd == "SHIFT_UP"   || cmd == "SHIFT:UP")   { shiftGear(+1); return; }
  if (cmd == "SHIFT_DOWN" || cmd == "SHIFT:DOWN") { shiftGear(-1); return; }

  int colon = cmd.indexOf(':');
  if (colon < 0) return;                       // not a command we know, ignore it
  String key = cmd.substring(0, colon);
  int val = cmd.substring(colon + 1).toInt();

  if      (key == "MOTOR")    { motor    = constrain(val, 0, 255);    motorAt = millis(); updateDrive(); }
  else if (key == "THROTTLE") { throttle = constrain(val, 0, 255); }
  else if (key == "BRAKE")    { brake    = constrain(val, 0, 255);    updateDrive(); }
  else if (key == "STEER")    { steer    = constrain(val, -255, 255); updateSteer(); }
}

void onWebSocketEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("App %u connected\n", num);
      sendGear(num);               // so the app's gear display matches the car straight away
      break;
    case WStype_DISCONNECTED:
      Serial.printf("App %u disconnected: stopping the car\n", num);
      stopEverything();            // failsafe: lose the phone, lose the power
      break;
    case WStype_TEXT:
      handleCommand(String((char*)payload));
      break;
    default:
      break;
  }
}

// ================= Setup and loop =================
void setup() {
  Serial.begin(115200);
  delay(200);

  // 8-bit PWM = values 0..255, the same range the app sends.
  ledcAttach(PIN_DRIVE_FWD,   PWM_FREQ_HZ, 8);
  ledcAttach(PIN_DRIVE_REV,   PWM_FREQ_HZ, 8);
  ledcAttach(PIN_STEER_LEFT,  PWM_FREQ_HZ, 8);
  ledcAttach(PIN_STEER_RIGHT, PWM_FREQ_HZ, 8);
  stopEverything();

  if (USE_KICK_SERVO) {
    ledcAttach(PIN_KICK_SERVO, 50, 14);   // 50 Hz, 14-bit, for servo pulses
    ledcWrite(PIN_KICK_SERVO, 0);         // no pulses = servo sits still and quiet
  }

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.println();
  Serial.printf("Hotspot \"%s\" is up.\n", AP_SSID);
  Serial.print("In the app, connect to ws://");
  Serial.print(WiFi.softAPIP());
  Serial.println(":81");

  webSocket.begin();
  webSocket.onEvent(onWebSocketEvent);
  // Ping the app every second. Two missed answers (about 3 s) = treat it as gone and stop.
  // This catches the phone walking out of range, which never sends a proper "goodbye".
  webSocket.enableHeartbeat(1000, 1000, 2);
}

void loop() {
  webSocket.loop();      // must run often: this is where commands arrive
  updateKick();
  updateSteer();         // re-check the steering timer so it drops to hold power

  // No MOTOR update for a while: the app is gone or asleep, so stop driving
  if (motor > 0 && millis() - motorAt > MOTOR_TIMEOUT_MS) {
    motor = 0;
    updateDrive();
  }
}
