# Flash the ESP32 and drive it from the cockpit app

Sketch: `firmware/gt3_rs_car_wifi/gt3_rs_car_wifi.ino` (keep the folder name the same as the file name; the Arduino IDE needs that).

## 1. One-time Arduino IDE setup
1. **File > Preferences > Additional boards manager URLs**, paste:
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
2. **Tools > Board > Boards Manager**, search `esp32`, install **esp32 by Espressif Systems**, version **3.x**.
   (The sketch uses `ledcAttach()`, which only exists in 3.x. On 2.x you get "ledcAttach was not declared".)
3. **Tools > Manage Libraries**, search `WebSockets`, install **WebSockets by Markus Sattler**.
   Not "ArduinoWebsockets" or "WebSockets_Generic": those are different libraries.
4. **Tools > Board > esp32 > ESP32 Dev Module**. Plug in the USB cable, then **Tools > Port**: pick the new COM port.

## 2. Upload
1. Copy `secrets.example.h` to `secrets.h` in the same folder and set your own hotspot password (8+ characters).
   `secrets.h` is in `.gitignore`, so your password never ends up on GitHub.
2. Open `gt3_rs_car_wifi.ino`, press **Upload** (the arrow).
3. If it sits on `Connecting.....`, hold the **BOOT** button on the ESP32 until the percentage starts.
4. Open **Tools > Serial Monitor** at **115200**. Press **EN/RST** once. You should see:
   `Hotspot "GT3_RS_Drift_Car" is up.` and `In the app, connect to ws://192.168.4.1:81`

**Safety first:** put the car on a box with the rear wheels in the air for the first test.

## 3. Connect the app
1. On the laptop (or phone), join Wi-Fi **GT3_RS_Drift_Car**, with the password you put in `secrets.h`.
   Windows will say "No internet": that is normal, the ESP32 is a router with no internet behind it. Stay connected.
2. Start the app the usual way (`npm start` in the porsche-gt3-cockpit folder, then open http://localhost:8000).
   It loads from your own laptop, so it still works with no internet.
3. Open the settings panel, check the address is `ws://192.168.4.1:81`, press **CONNECT**.
   The status turns to **CONNECTED (ESP32)** and the Serial Monitor prints `App 0 connected`.

## 4. Test checklist (wheels in the air)
| Do this in the app | Car should | Serial Monitor shows |
|---|---|---|
| Connect | gear display shows **N** | `App 0 connected` |
| Hold W in N | nothing moves (neutral) | `THROTTLE:255` |
| E (shift up) to gear 1 | servo twitches, gear shows 1 | `SHIFT_UP` |
| Hold W | rear wheels spin **forward** | `THROTTLE:255` |
| Hold S | wheels stop fast (brake) | `BRAKE:255` |
| Hold A / D | front wheels turn **left / right** | `STEER:-255` / `STEER:255` |
| Q down to R, hold W | wheels spin **backward** | `SHIFT_DOWN`, `THROTTLE:255` |
| Hold W, then close the browser tab | car stops within about 3 s | `App 0 disconnected: stopping the car` |

If a direction is backwards, swap the two numbers of that pair at the top of the sketch
(`PIN_DRIVE_FWD`/`PIN_DRIVE_REV` or `PIN_STEER_LEFT`/`PIN_STEER_RIGHT`) and upload again. No rewiring needed.

## If something goes wrong
- **ESP32 resets / Serial shows "Brownout detector" when the motor starts**: the motor battery is pulling the ESP32's power down. Lower `MAX_DRIVE` to 150, and power the ESP32 from USB or its own supply with grounds joined.
- **App never connects**: check the laptop is still on GT3_RS_Drift_Car (Windows sometimes hops back to home Wi-Fi because this one has no internet), and the address is `ws://` not `wss://`.
- **Steering lets go in long turns**: raise `STEER_HOLD` (for example 200).
- **Hotspot doesn't appear**: password must be 8+ characters.
