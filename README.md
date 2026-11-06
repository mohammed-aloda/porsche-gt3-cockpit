# GT3 RS Virtual Cockpit

A browser dashboard that drives an ESP32-powered Porsche GT3 RS RC drift car over WebSocket.
It shows a live tachometer, gear and RPM, plays engine sound (FMOD), and turns the
steering wheels, paddles and pedals in the picture into touch controls.

## Run it on your computer

You need [Node.js](https://nodejs.org) (the LTS version). Nothing else to install.

```
npm start
```

That opens http://localhost:8000 in your browser. Press Ctrl+C in the terminal to stop it.

Why not just double-click `index.html`? Browsers block the sound engine from loading its
`.wasm` and `.bank` files from `file://`, so the app needs a tiny local web server (`server.js`,
built only from Node's own modules).

## Controls

| Action | Touch | Keyboard |
| --- | --- | --- |
| Throttle | Hold the right pedal (higher = more) | W / ↑ |
| Brake | Hold the left pedal | S / ↓ |
| Steer | Hold the left / right steering wheel | A / D or ← / → |
| Shift up | Tap the + paddle | E |
| Shift down | Tap the − paddle | Q or R |
| Show / hide the key guide | | H or ? |
| Settings | ⚙ button at the bottom | |

With no car connected it switches to **demo mode** so you can still play with it.

## Connecting to the car

Join the ESP32's Wi-Fi, open ⚙ settings, and connect to `ws://192.168.4.1:81` (the default).
The app sends `THROTTLE:0..255`, `BRAKE:0..255`, `STEER:-255..255`, `SHIFT_UP`, `SHIFT_DOWN`,
and accepts JSON telemetry like `{"rpm":3200,"gear":"2","throttle":180}`.

## Files

- `index.html`, `styles.css`, `app.js`: the page, its look, and its logic
- `audio-manager.js`, `fmod-wrapper.js`, `engine-audio.js`: FMOD engine sound, with a Web Audio synth fallback
- `wasm/`, `js/`, `sfx/`: the FMOD runtime and sound banks
- `server.js`, `package.json`: the local web server (`npm start`)
