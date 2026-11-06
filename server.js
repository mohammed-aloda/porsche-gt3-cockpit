// ═══════════════════════════════════════════════════════════════
//  Tiny static web server for the GT3 RS Virtual Cockpit.
//  Uses only Node's built-in modules, so "npm start" needs no installs.
//  Why a server at all? Browsers block the FMOD sound engine from
//  loading .wasm and .bank files when you double-click index.html
//  (file://), so the app has to be served over http://localhost.
// ═══════════════════════════════════════════════════════════════
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 8000;
const ROOT = __dirname;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.wav': 'audio/wav',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.bank': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
    let urlPath;
    try {
        urlPath = decodeURIComponent(req.url.split('?')[0]);
    } catch (e) {
        res.writeHead(400).end('Bad request');   // e.g. a stray "%" in the address
        return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.join(ROOT, urlPath);

    // Only serve files inside this folder, and never hidden ones like .git
    const hidden = path.relative(ROOT, file).split(path.sep).some((part) => part.startsWith('.'));
    if (!file.startsWith(ROOT + path.sep) || hidden) {
        res.writeHead(403).end('Forbidden');
        return;
    }

    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404).end('Not found');
            console.log('404', urlPath);
            return;
        }
        const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        res.end(data);
    });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is busy. Try:  set PORT=8080 && npm start`);
    } else {
        console.error(err);
    }
    process.exit(1);
});

server.listen(PORT, () => {
    const url = `http://localhost:${PORT}/`;
    console.log(`\n  GT3 RS Virtual Cockpit running at ${url}`);
    console.log('  Press Ctrl+C to stop.\n');

    // Open the browser (skip with NO_OPEN=1)
    if (!process.env.NO_OPEN) {
        const cmd = process.platform === 'win32' ? `start "" "${url}"`
                  : process.platform === 'darwin' ? `open "${url}"`
                  : `xdg-open "${url}"`;
        exec(cmd, () => {});
    }
});
