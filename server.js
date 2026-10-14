'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');
const Rooms = require('./lib/rooms');

function createServer(options = {}) {
  const rate = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  const rooms = new Rooms({ ...options, onChange: room => {
    for (const member of room.members) for (const ws of member.sockets) send(ws, rooms.view(room, member));
  } });
  function allowed(key, maximum = 30) {
    const now = Date.now(); let entry = rate.get(key);
    if (!entry || now - entry.start > 60000) { entry = { start: now, count: 0 }; rate.set(key, entry); }
    return ++entry.count <= maximum;
  }
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  async function body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('Use JSON.'), { status: 415 });
    let data = '', size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 8192) throw Object.assign(new Error('Request too large.'), { status: 413 }); data += chunk; }
    try { return JSON.parse(data); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return json(res, 200, { ok: true });
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Use the game’s own address.' });
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        const ip = process.env.RENDER ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim() : req.socket.remoteAddress;
        if (!allowed(ip)) return json(res, 429, { error: 'Too many requests. Try again in a minute.' });
        const data = await body(req);
        if (!data || typeof data !== 'object' || Array.isArray(data)) return json(res, 400, { error: 'Invalid request.' });
        let result;
        if (url.pathname === '/api/rooms') result = rooms.create(data.name);
        else {
          const match = url.pathname.match(/^\/api\/rooms\/([A-Fa-f0-9]{12})\/join$/);
          if (!match) return json(res, 404, { error: 'Unknown endpoint.' });
          result = rooms.join(match[1], data.name, data.seat);
        }
        return json(res, 201, { code: result.room.code, token: result.member.token });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/rooms/')) {
        const match = url.pathname.match(/^\/api\/rooms\/([A-Fa-f0-9]{12})$/);
        if (!match) return json(res, 404, { error: 'Unknown table.' });
        return json(res, 200, rooms.publicLobby(rooms.get(match[1])));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
      const assets = {
        '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'],
        '/cards.js': ['public/cards.js', 'text/javascript'], '/base.css': ['public/base.css', 'text/css'],
        '/app.css': ['public/app.css', 'text/css'], '/rules.html': ['public/rules.html', 'text/html'],
      };
      const asset = assets[url.pathname];
      if (!asset) return json(res, 404, { error: 'Not found.' });
      const content = fs.readFileSync(path.join(__dirname, asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { json(res, error.status || 500, { error: error.status ? error.message : 'The server could not complete that request.' }); }
  });
  server.requestTimeout = 15000;
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws' || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) || wss.clients.size >= 200) return socket.destroy();
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    } catch { socket.destroy(); }
  });
  wss.on('connection', ws => {
    ws.alive = true;
    const deadline = setTimeout(() => { if (!ws.member) ws.close(4001, 'Sign in to a seat'); }, 10000);
    let windowStart = Date.now(), count = 0;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => {});
    ws.on('message', raw => {
      let data;
      try {
        if (Date.now() - windowStart > 1000) { windowStart = Date.now(); count = 0; }
        if (++count > 30) throw Object.assign(new Error('Slow down and try again.'), { status: 429 });
        data = JSON.parse(raw.toString());
        if (!ws.member) {
          if (data.type !== 'auth') throw Object.assign(new Error('Sign in to your seat first.'), { status: 401 });
          const { room, member } = rooms.auth(data.code, data.token);
          ws.room = room; ws.member = member; clearTimeout(deadline);
          rooms.attach(room, member, ws);
        } else {
          const result = rooms.action(ws.room, ws.member, data);
          send(ws, { ...result, requestId: data.requestId });
        }
      } catch (error) {
        send(ws, { type: 'error', error: error.status ? error.message : 'Invalid request.', status: error.status || 400, requestId: data?.requestId });
        if (!ws.member) ws.close(4001, 'Invalid seat');
      }
    });
    ws.on('close', () => { clearTimeout(deadline); if (ws.member) rooms.detach(ws.room, ws.member, ws); });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
    for (const [key, value] of rate) if (Date.now() - value.start > 60000) rate.delete(key);
  }, 15000);
  heartbeat.unref();
  return { server, rooms, async close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rooms.close();
  } };
}
if (require.main === module) {
  const file = process.env.ROOM_STORE === 'none' || (process.env.RENDER && !process.env.ROOM_STORE) ? null : path.resolve(process.env.ROOM_STORE || 'data/rooms.json');
  const app = createServer({ file });
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '0.0.0.0', () => {
    console.log(`Tarneeb is ready: http://localhost:${port}`);
    if (file) console.log('Local matches save automatically. Keep data/ private.');
    else console.log('Rooms last until this server restarts. Browser refreshes preserve seats.');
  });
  let stopping = false;
  async function shutdown() { if (stopping) return; stopping = true; await app.close(); process.exit(0); }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
module.exports = { createServer };
