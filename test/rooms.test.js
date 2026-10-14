'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Rooms = require('../lib/rooms');
function setup(t, options = {}) {
  const rooms = new Rooms({ auto: false, ...options });
  t.after(() => rooms.close());
  const { room, member: host } = rooms.create('Host');
  const socket = {}; rooms.attach(room, host, socket);
  const act = (member, data) => rooms.action(room, member, { ...data, revision: room.revision });
  return { rooms, room, host, socket, act };
}
test('private views never contain another hand or session credentials', t => {
  const { rooms, room, host, act } = setup(t);
  const { member: guest } = rooms.join(room.code, 'Guest', 2);
  rooms.attach(room, guest, {}); act(host, { type: 'start' });
  for (const m of [host, guest]) {
    const view = rooms.view(room, m), serialized = JSON.stringify(view);
    assert.deepEqual(view.game.hand, room.game.hands[m.seat]);
    assert.equal(view.game.hand.length, 13);
    assert.equal('hands' in view.game, false);
    for (const p of room.members) { assert.equal(serialized.includes(p.token), false); assert.equal(serialized.includes(p.id), false); }
  }
  assert.equal('game' in rooms.publicLobby(room), false);
  assert.throws(() => rooms.auth(room.code, 'a'.repeat(64)), /could not be restored/);
  assert.throws(() => rooms.auth(room.code, 'é'.repeat(64)), /could not be restored/);
});
test('host-only controls, seat swapping, and open seats are enforced', t => {
  const { rooms, room, host, act } = setup(t);
  const { member: guest } = rooms.join(room.code, 'Guest', 1); rooms.attach(room, guest, {});
  assert.throws(() => act(guest, { type: 'start' }), /Only the host/);
  assert.throws(() => act(guest, { type: 'configure' }), /Only the host/);
  act(host, { type: 'swap', a: 1, b: 2 });
  assert.equal(guest.seat, 2);
  const seats = room.seats.map(s => ({ mode: s.mode, bot: s.bot })); seats[1].mode = 'open';
  act(host, { type: 'configure', target: 41, speed: 180, seats });
  assert.throws(() => act(host, { type: 'start' }), /Fill open seats/);
  seats[1].mode = 'bot'; act(host, { type: 'configure', target: 41, speed: 180, seats });
  act(host, { type: 'start' });
  assert.equal(room.game.target, 41);
  assert.throws(() => act(host, { type: 'swap', a: 0, b: 1 }), /between hands/);
});
test('late friends wait for the next hand and cannot see bot cards', t => {
  const { rooms, room, host, act } = setup(t);
  act(host, { type: 'start' });
  const { member: guest } = rooms.join(room.code, 'Guest', 2); rooms.attach(room, guest, {});
  assert.equal(guest.pending, true); assert.deepEqual(rooms.view(room, guest).game.hand, []);
  assert.throws(() => act(guest, { type: 'card', value: 0 }), /cannot play/);
  room.game.phase = 'handEnd';
  act(host, { type: 'next' });
  assert.equal(guest.pending, false); assert.equal(guest.takeover, false); assert.equal(rooms.view(room, guest).game.hand.length, 13);
});
test('reconnect within grace restores play; takeover lasts until the next deal', t => {
  const { rooms, room, host, socket, act } = setup(t);
  act(host, { type: 'start' });
  const hand = room.game.hands[0].slice();
  rooms.detach(room, host, socket); rooms.attach(room, host, socket);
  assert.equal(host.takeover, false); assert.deepEqual(rooms.view(room, host).game.hand, hand);
  rooms.detach(room, host, socket); host.disconnectedAt = Date.now() - 31000; rooms.sweep();
  assert.equal(host.takeover, true);
  rooms.attach(room, host, socket); assert.equal(host.takeover, true);
  room.game.phase = 'handEnd'; act(host, { type: 'next' }); assert.equal(host.takeover, false);
});
test('disconnected host passes controls to a connected friend after grace', t => {
  const { rooms, room, host, socket, act } = setup(t);
  const { member: guest } = rooms.join(room.code, 'Guest', 2); rooms.attach(room, guest, {});
  act(host, { type: 'start' }); rooms.detach(room, host, socket);
  host.disconnectedAt = Date.now() - 31000; rooms.sweep();
  assert.equal(room.host, guest.id); assert.equal(rooms.view(room, guest).host, true);
  act(guest, { type: 'pause' }); assert.equal(room.paused, true);
});
test('stale requests, illegal cards, and full tables cannot mutate game state', t => {
  const { rooms, room, host, act } = setup(t);
  [1, 2, 3].forEach(seat => rooms.join(room.code, 'Guest ' + seat, seat));
  assert.throws(() => rooms.join(room.code, 'Fifth', 2), /four seats/);
  act(host, { type: 'start' });
  room.game.turn = 0;
  assert.throws(() => rooms.action(room, host, { type: 'bid', value: 7, revision: room.revision - 1 }), /table changed/);
  assert.equal(room.game.bid, 0);
  act(host, { type: 'bid', value: 13 }); act(host, { type: 'trump', value: 'S' });
  const before = room.game.hands[0].slice();
  assert.throws(() => act(host, { type: 'card', value: 99 }), /not allowed/);
  assert.deepEqual(room.game.hands[0], before);
});
test('local saves restore room, token, and exact private hand after a server restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tarneeb-test-'));
  const file = path.join(directory, 'rooms.json');
  const rooms = new Rooms({ auto: false, file });
  const { room, member } = rooms.create('Host'); rooms.attach(room, member, {});
  rooms.action(room, member, { type: 'start' });
  const expected = room.game.hands[0].slice(); await rooms.close();
  const restored = new Rooms({ auto: false, file });
  t.after(async () => { await restored.close(); fs.unlinkSync(file); fs.rmdirSync(directory); });
  const session = restored.auth(room.code, member.token);
  assert.deepEqual(session.room.game.hands[0], expected);
  assert.equal(session.member.sockets.size, 0);
  restored.attach(session.room, session.member, {});
  assert.equal(session.member.takeover, false);
});
test('a solo match with three bots reaches the target across repeated deals', t => {
  const { rooms, room, host, act } = setup(t);
  act(host, { type: 'start' });
  let actions = 0;
  while (room.game.phase !== 'matchEnd') {
    assert.ok(++actions < 20000, 'match must finish');
    const g = room.game, p = g.turn, o = room.engine.observe(g, p), bot = room.seats[p].bot;
    if (['handEnd', 'redeal'].includes(g.phase)) { act(host, { type: 'next' }); continue; }
    if (g.phase === 'trick') room.engine.finishTrick(g);
    else {
      const move = g.phase === 'auction' ? { type: 'bid', value: room.engine.computerBid(o, bot) } : g.phase === 'trump' ? { type: 'trump', value: room.engine.bestTrump(o.hand) } : { type: 'card', value: room.engine.computerCard(o, bot) };
      if (p === host.seat) { act(host, move); continue; }
      if (move.type === 'bid') room.engine.auctionAction(g, p, move.value);
      else if (move.type === 'trump') room.engine.chooseTrump(g, p, move.value);
      else room.engine.playCard(g, p, move.value);
    }
    rooms.touch(room);
  }
  assert.ok(room.game.scores.some(score => score >= 31));
  assert.equal(room.game.history.length, 13);
});
