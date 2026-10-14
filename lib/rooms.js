'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const createEngine = require('./engine');
const Bots = require('./bots');
const SKILLS = ['beginner', 'standard', 'expert'];
const STYLES = ['cautious', 'balanced', 'aggressive'];
const BOUNDARY = ['redeal', 'handEnd', 'matchEnd'];
const token = () => crypto.randomBytes(32).toString('hex');
const id = () => crypto.randomBytes(8).toString('hex');
const botConfig = () => ({ skill: 'standard', style: 'balanced' });
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 24) fail('Enter a name between 1 and 24 characters.');
  return value.trim().replace(/[\x00-\x1f\x7f]/g, '');
}
class Rooms {
  constructor({ file = null, auto = true, grace = 30000, onChange = () => {} } = {}) {
    this.rooms = new Map(); this.file = file; this.auto = auto; this.grace = grace;
    this.onChange = onChange; this.bots = new Bots(); this.saveTimer = null; this.closing = false;
    if (file && fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.version !== 1) throw new Error('Unsupported save version');
        for (const data of saved.rooms) {
          if (Date.now() - data.updated > 86400000) continue;
          const room = this.hydrate(data);
          room.members.forEach(m => { m.sockets = new Set(); m.disconnectedAt = Date.now(); });
          this.rooms.set(room.code, room);
        }
      } catch (error) { throw new Error(`Cannot load room save: ${error.message}. Preserve the save file before starting a fresh server.`); }
    }
    this.maintenance = setInterval(() => this.sweep(), 1000);
    this.maintenance.unref();
  }
  hydrate(data) {
    const room = { ...data, timer: null, epoch: 0 };
    room.names = Array.from({ length: 4 }, (_, i) => this.seatName(room, i));
    room.engine = createEngine(room.names, text => {
      room.log.push(text); if (room.log.length > 65) room.log.shift();
    });
    return room;
  }
  create(displayName) {
    const clean = name(displayName);
    if (this.rooms.size >= 50) fail('The server is full. Try again later.', 503);
    let code;
    do { code = crypto.randomBytes(6).toString('hex').toUpperCase(); } while (this.rooms.has(code));
    const member = { id: id(), token: token(), name: clean, seat: 0, pending: false, takeover: false, sockets: new Set(), disconnectedAt: Date.now() };
    const room = this.hydrate({ code, host: member.id, members: [member], seats: Array.from({ length: 4 }, (_, i) => ({ mode: 'bot', bot: botConfig(), memberId: i === 0 ? member.id : null })), target: 31, speed: 650, game: null, paused: false, revision: 0, log: ['Your table is ready. Invite friends or start with bots.'], updated: Date.now() });
    this.rooms.set(code, room); this.touch(room);
    return { room, member };
  }
  get(code) {
    const room = typeof code === 'string' ? this.rooms.get(code.toUpperCase()) : null;
    if (!room) fail('This table is no longer available. Create a new one.', 404);
    return room;
  }
  auth(code, credential) {
    const room = this.get(code);
    const member = room.members.find(m => typeof credential === 'string' && /^[a-f0-9]{64}$/.test(credential) && crypto.timingSafeEqual(Buffer.from(credential), Buffer.from(m.token)));
    if (!member) fail('Your seat could not be restored. Join the table again.', 401);
    return { room, member };
  }
  seatName(room, seat) {
    const member = room.members.find(m => m.id === room.seats[seat].memberId);
    return member ? member.name : room.seats[seat].mode === 'open' ? 'Open seat' : ['Nour', 'Omar', 'Zaid', 'Sami'][seat] + ' · Bot';
  }
  join(code, displayName, seat) {
    const room = this.get(code), clean = name(displayName);
    if (room.members.length >= 4) fail('All four seats are reserved. Ask the host to release an absent player’s seat.', 409);
    if (!Number.isInteger(seat) || seat < 0 || seat > 3 || room.seats[seat].memberId) fail('That seat has already been taken. Choose another.', 409);
    const pending = !!room.game && !BOUNDARY.includes(room.game.phase);
    const member = { id: id(), token: token(), name: clean, seat, pending, takeover: pending, sockets: new Set(), disconnectedAt: Date.now() };
    room.members.push(member); room.seats[seat].memberId = member.id;
    room.log.push(`${clean} joined${pending ? ' and will play from the next hand' : ''}.`);
    this.touch(room);
    return { room, member };
  }
  attach(room, member, socket) {
    member.sockets.add(socket); member.disconnectedAt = null;
    if (!room.game || BOUNDARY.includes(room.game.phase)) { member.pending = false; member.takeover = false; }
    this.touch(room);
  }
  detach(room, member, socket) {
    member.sockets.delete(socket);
    if (!member.sockets.size) member.disconnectedAt = Date.now();
    this.touch(room);
  }
  publicLobby(room) {
    return { code: room.code, started: !!room.game, seats: room.seats.map((s, seat) => ({ seat, name: this.seatName(room, seat), occupied: !!s.memberId, mode: s.mode })) };
  }
  view(room, member) {
    const g = room.game, canControl = member.sockets.size > 0 && !member.pending && !member.takeover;
    const observation = g ? room.engine.observe(g, member.seat) : null;
    if (observation && member.pending) observation.hand = [];
    return {
      type: 'state', code: room.code, revision: room.revision, you: member.seat, host: room.host === member.id,
      pending: member.pending, takeover: member.takeover, paused: room.paused, target: room.target, speed: room.speed,
      seats: room.seats.map((s, seat) => {
        const m = room.members.find(x => x.id === s.memberId);
        return { seat, name: this.seatName(room, seat), mode: s.mode, bot: s.bot, human: !!m, online: !!m?.sockets.size,
          host: m?.id === room.host, pending: !!m?.pending, takeover: !!m?.takeover,
          reconnectSeconds: m && !m.sockets.size && m.disconnectedAt ? Math.max(0, Math.ceil((this.grace - (Date.now() - m.disconnectedAt)) / 1000)) : null };
      }),
      game: g ? { ...observation, phase: g.phase, turn: g.turn, dealer: g.dealer, handNumber: g.hand, scores: g.scores.slice(), result: g.result,
        legal: canControl && !room.paused && g.phase === 'play' && g.turn === member.seat ? room.engine.legalCards(g, member.seat) : [] } : null,
      log: room.log.slice(-25),
    };
  }
  touch(room) {
    room.revision++; room.updated = Date.now();
    room.log = room.log.slice(-65);
    room.names.splice(0, 4, ...room.seats.map((_, i) => this.seatName(room, i)));
    this.onChange(room); this.schedule(room);
    if (this.file && !this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 200);
  }
  start(room) {
    for (const m of room.members) { m.pending = false; m.takeover = !m.sockets.size; }
    room.game = { scores: [0, 0], hand: 1, dealer: crypto.randomInt(4), target: room.target };
    room.paused = false; room.engine.deal(room.game);
  }
  action(room, member, data) {
    if (!data || typeof data.type !== 'string') fail('Invalid action.');
    const host = room.host === member.id, g = room.game;
    const hostTypes = ['start', 'pause', 'next', 'configure', 'swap', 'release', 'transfer'];
    if (hostTypes.includes(data.type) && !host) fail('Only the host can do that.', 403);
    if (['bid', 'trump', 'card'].includes(data.type)) {
      if (!g || room.paused || member.pending || member.takeover || !member.sockets.size) fail('You cannot play right now.', 409);
      if (data.revision !== room.revision) fail('The table changed. Try your move again.', 409);
      const accepted = data.type === 'bid' ? room.engine.auctionAction(g, member.seat, data.value)
        : data.type === 'trump' ? room.engine.chooseTrump(g, member.seat, data.value)
          : room.engine.playCard(g, member.seat, data.value);
      if (!accepted) fail('That move is not allowed. Check whose turn it is and follow suit.', 409);
    } else if (data.type === 'start') {
      if (g && g.phase !== 'matchEnd') fail('Finish the current match before starting another.', 409);
      if (room.seats.some(s => s.mode === 'open' && !s.memberId)) fail('Fill open seats with bots or wait for friends before starting.', 409);
      this.start(room);
    } else if (data.type === 'pause') {
      if (!g) fail('Start a match first.');
      room.paused = !room.paused;
    } else if (data.type === 'next') {
      if (!g || !['redeal', 'handEnd'].includes(g.phase)) fail('The hand is still being played.', 409);
      if (g.phase !== 'redeal') { g.hand++; g.dealer = (g.dealer + 1) % 4; }
      for (const m of room.members) { m.pending = false; m.takeover = !m.sockets.size; }
      room.paused = false; room.engine.deal(g);
    } else if (data.type === 'configure') {
      if (g && !BOUNDARY.includes(g.phase)) fail('Settings can change between hands.', 409);
      if (![31, 41, 61].includes(data.target) || ![180, 650, 1100].includes(data.speed)) fail('Invalid match settings.');
      if (!Array.isArray(data.seats) || data.seats.length !== 4 || data.seats.some(s => !s || !['bot', 'open'].includes(s.mode) || !SKILLS.includes(s.bot?.skill) || !STYLES.includes(s.bot?.style))) fail('Invalid seat settings.');
      room.target = data.target; room.speed = data.speed;
      data.seats.forEach((s, i) => { room.seats[i].mode = s.mode; room.seats[i].bot = { skill: s.bot.skill, style: s.bot.style }; });
      if (g) { g.target = room.target; if (['handEnd', 'matchEnd'].includes(g.phase)) g.phase = g.scores.some(s => s >= g.target) ? 'matchEnd' : 'handEnd'; }
    } else if (data.type === 'swap') {
      if (g && !BOUNDARY.includes(g.phase)) fail('Seats can change between hands.', 409);
      if (![data.a, data.b].every(s => Number.isInteger(s) && s >= 0 && s < 4)) fail('Invalid seats.');
      [room.seats[data.a].memberId, room.seats[data.b].memberId] = [room.seats[data.b].memberId, room.seats[data.a].memberId];
      room.members.forEach(m => { m.seat = room.seats.findIndex(s => s.memberId === m.id); });
    } else if (data.type === 'release') {
      if (!Number.isInteger(data.seat) || data.seat < 0 || data.seat > 3) fail('Invalid seat.');
      const removed = room.members.find(m => m.id === room.seats[data.seat].memberId);
      if (!removed || removed.id === room.host || removed.sockets.size) fail('Only a disconnected guest’s seat can be released.', 409);
      room.seats[data.seat].memberId = null; room.seats[data.seat].mode = 'bot';
      room.members = room.members.filter(m => m !== removed);
      room.log.push(`${removed.name}'s seat is now a bot.`);
    } else if (data.type === 'transfer') {
      const nextHost = room.members.find(m => m.seat === data.seat && m.sockets.size);
      if (!nextHost) fail('Choose a connected player.');
      room.host = nextHost.id;
    } else if (data.type === 'hint') {
      if (!g || member.pending || member.takeover || g.turn !== member.seat || room.paused || !['auction', 'trump', 'play'].includes(g.phase)) fail('Hints are available on your turn.', 409);
      const o = room.engine.observe(g, member.seat);
      return { type: 'hint', card: g.phase === 'play' ? room.engine.heuristic(o) : null,
        text: g.phase === 'auction' ? `Your strongest suit is ${room.engine.bestTrump(o.hand)}. A rough team estimate is ${room.engine.bidEstimate(o, { skill: 'expert', style: 'balanced' })} tricks.` : g.phase === 'trump' ? `Consider ${room.engine.bestTrump(o.hand)} for your trump suit.` : 'Suggested card highlighted. Follow suit and conserve strength when your partner is winning.' };
    } else fail('Unknown action.');
    this.touch(room);
    return { type: 'ok' };
  }
  computer(room, seat) {
    const m = room.members.find(x => x.id === room.seats[seat].memberId);
    if (!m || m.pending || m.takeover) return true;
    return false;
  }
  schedule(room) {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null; const epoch = ++room.epoch;
    const g = room.game;
    if (!this.auto || this.closing || !g || room.paused || !room.members.some(m => m.sockets.size)) return;
    if (g.phase !== 'trick' && (!['auction', 'trump', 'play'].includes(g.phase) || !this.computer(room, g.turn))) return;
    const wait = g.phase === 'trick' ? Math.max(1250, room.speed * 1.5) : room.speed;
    room.timer = setTimeout(async () => {
      room.timer = null;
      try {
        if (epoch !== room.epoch) return;
        if (g.phase === 'trick') room.engine.finishTrick(g);
        else {
          const seat = g.turn, bot = room.seats[seat].bot, o = room.engine.observe(g, seat);
          if (g.phase === 'auction') room.engine.auctionAction(g, seat, room.engine.computerBid(o, bot));
          else if (g.phase === 'trump') room.engine.chooseTrump(g, seat, room.engine.bestTrump(o.hand));
          else {
            const card = bot.skill === 'expert' ? await this.bots.card(o, bot) : room.engine.computerCard(o, bot);
            if (epoch !== room.epoch || this.closing) return;
            room.engine.playCard(g, seat, card);
          }
        }
        this.touch(room);
      } catch (error) { if (!this.closing) { console.error('Bot action failed:', error.message); this.schedule(room); } }
    }, wait);
  }
  sweep() {
    for (const room of this.rooms.values()) {
      let changed = false;
      for (const m of room.members) {
        if (!m.sockets.size && !m.takeover && m.disconnectedAt && Date.now() - m.disconnectedAt >= this.grace) {
          m.takeover = true; changed = true;
          if (room.game) room.log.push(`${m.name} disconnected. A bot will play until the next hand.`);
        }
      }
      const host = room.members.find(m => m.id === room.host);
      if (host && !host.sockets.size && host.disconnectedAt && Date.now() - host.disconnectedAt >= this.grace) {
        const replacement = room.members.find(m => m.sockets.size);
        if (replacement) { room.host = replacement.id; room.log.push(`${replacement.name} is now the host while ${host.name} is away.`); changed = true; }
      }
      if (!room.members.some(m => m.sockets.size) && Date.now() - room.updated > 86400000) {
        clearTimeout(room.timer); this.rooms.delete(room.code); changed = true;
      }
      if (changed) this.touch(room);
    }
  }
  save() {
    if (!this.file) return;
    const rooms = [...this.rooms.values()].map(({ names, engine, timer, epoch, ...r }) => ({ ...r, members: r.members.map(({ sockets, ...m }) => m) }));
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, rooms }), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (error) { console.error('Room save failed:', error.message); }
  }
  async close() {
    this.closing = true; clearInterval(this.maintenance); clearTimeout(this.saveTimer);
    for (const r of this.rooms.values()) clearTimeout(r.timer);
    this.save(); await this.bots.close();
  }
}
module.exports = Rooms;
