'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createServer } = require('../server');
class Client {
  constructor(url, credentials) {
    this.ws = new WebSocket(url); this.state = null; this.sequence = 0; this.waits = []; this.requests = new Map();
    this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'auth', ...credentials })));
    this.ws.on('message', raw => {
      const data = JSON.parse(raw.toString());
      if (data.type === 'state') { this.state = data; this.waits = this.waits.filter(w => { if (w.predicate(data)) { clearTimeout(w.timer); w.resolve(data); return false; } return true; }); }
      const pending = this.requests.get(data.requestId);
      if (pending) { this.requests.delete(data.requestId); clearTimeout(pending.timer); pending.resolve(data); }
    });
  }
  wait(predicate = () => true) {
    if (this.state && predicate(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const task = { predicate, resolve, timer: setTimeout(() => reject(new Error('State timeout')), 3000) };
      this.waits.push(task);
    });
  }
  act(type, values = {}) {
    return new Promise((resolve, reject) => {
      const requestId = ++this.sequence;
      const timer = setTimeout(() => reject(new Error('Response timeout')), 3000);
      this.requests.set(requestId, { resolve, timer });
      this.ws.send(JSON.stringify({ type, ...values, revision: this.state.revision, requestId }));
    });
  }
}
async function setup(t, options = {}) {
  const app = createServer({ auto: false, ...options }); app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (route, data) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  };
  return { app, url, post };
}
test('HTTP routes serve the app, reject cross-origin and malformed requests, and keep rooms private', async t => {
  const { url, post } = await setup(t);
  assert.equal((await fetch(url + '/healthz')).status, 200);
  assert.match(await (await fetch(url)).text(), /Friends at your table/);
  assert.equal((await fetch(url + '/lib/rooms.js')).status, 404);
  assert.equal((await fetch(url + '/data/rooms.json')).status, 404);
  assert.equal((await fetch(url + '/api/rooms', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await post('/api/rooms', null)).status, 400);
  assert.equal((await post('/api/rooms', { name: '' })).status, 400);
  const created = await post('/api/rooms', { name: 'Host' }); assert.equal(created.status, 201);
  const lobby = await (await fetch(url + '/api/rooms/' + created.data.code)).json();
  assert.equal(JSON.stringify(lobby).includes(created.data.token), false);
  assert.equal((await post(`/api/rooms/${created.data.code}/join`, { name: 'Friend', seat: 0 })).status, 409);
});
test('four real socket clients play a full private hand and reconnect to the same seat', async t => {
  const { app, url, post } = await setup(t);
  const created = (await post('/api/rooms', { name: 'Host' })).data;
  const creds = [created];
  for (const seat of [1, 2, 3]) creds.push((await post(`/api/rooms/${created.code}/join`, { name: 'Friend ' + seat, seat })).data);
  const clients = creds.map(c => new Client(url.replace('http:', 'ws:') + '/ws', c));
  for (const c of clients) await c.wait();
  await clients[0].wait(s => s.seats.every(seat => seat.online));
  assert.equal((await clients[1].act('start')).type, 'error');
  assert.equal((await clients[0].act('start')).type, 'ok');
  const room = app.rooms.get(created.code);
  for (const c of clients) await c.wait(s => !!s.game);
  assert.equal(new Set(clients.flatMap(c => c.state.game.hand)).size, 52);
  assert.equal((await clients[room.game.turn].act('bid', { value: 13 })).type, 'ok');
  await clients[room.game.turn].wait(s => s.game.phase === 'trump');
  assert.equal((await clients[room.game.turn].act('trump', { value: 'H' })).type, 'ok');
  while (room.game.phase !== 'handEnd' && room.game.phase !== 'matchEnd') {
    if (room.game.phase === 'trick') { room.engine.finishTrick(room.game); app.rooms.touch(room); }
    else {
      const c = clients[room.game.turn];
      await c.wait(s => s.revision === room.revision && s.game.legal.length > 0);
      assert.equal((await c.act('card', { value: c.state.game.legal[0] })).type, 'ok');
    }
  }
  assert.equal(room.game.history.length, 13); assert.equal(room.game.tricks[0] + room.game.tricks[1], 13);
  const old = clients[2].ws; old.close(); await once(old, 'close');
  const rejoined = new Client(url.replace('http:', 'ws:') + '/ws', creds[2]);
  const restored = await rejoined.wait(); assert.equal(restored.you, 2); assert.equal(restored.game.history.length, 13);
  rejoined.ws.close(); clients.forEach(c => c.ws.close());
});
test('automatic bots act without blocking the server and host pause stops them', async t => {
  const { app, url, post } = await setup(t, { auto: true });
  const created = (await post('/api/rooms', { name: 'Host' })).data;
  const client = new Client(url.replace('http:', 'ws:') + '/ws', created); await client.wait();
  const room = app.rooms.get(created.code);
  room.speed = 180;
  assert.equal((await client.act('start')).type, 'ok');
  room.game.turn = 1; app.rooms.touch(room);
  await client.wait(s => s.game.passed[1] || s.game.bidder === 1);
  await client.wait(s => s.revision === room.revision);
  assert.equal((await client.act('pause')).type, 'ok');
  const before = JSON.stringify(room.game);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(JSON.stringify(room.game), before);
  assert.equal((await fetch(url + '/healthz')).status, 200);
  client.ws.close();
});
test('expert worker returns a legal card while HTTP remains available', async t => {
  const { app, url, post } = await setup(t);
  const created = (await post('/api/rooms', { name: 'Host' })).data;
  const client = new Client(url.replace('http:', 'ws:') + '/ws', created); await client.wait();
  await client.act('start');
  const room = app.rooms.get(created.code);
  room.game.turn = 1;
  room.engine.auctionAction(room.game, 1, 13); room.engine.chooseTrump(room.game, 1, 'S');
  const o = room.engine.observe(room.game, 1);
  const calculation = app.rooms.bots.card(o, { skill: 'expert', style: 'balanced' });
  assert.equal((await fetch(url + '/healthz')).status, 200);
  assert.ok(room.engine.legalCards(room.game, 1).includes(await calculation));
  client.ws.close();
});
