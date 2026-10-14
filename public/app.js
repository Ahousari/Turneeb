'use strict';
const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const titleCase = value => value[0].toUpperCase() + value.slice(1);
let state = null, socket = null, connected = false, reconnectTimer = null, reconnectAttempt = 0;
let credentials = null, requestSequence = 0, hintText = '', joinRoom = null, noticeTimer = null;
const requests = new Map();
const boundary = () => !state?.game || ['handEnd', 'matchEnd', 'redeal'].includes(state.game.phase);
const active = () => connected && state && !state.pending && !state.takeover && !state.paused;
function notice(message, lasting = false) {
  clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').hidden = false;
  if (!lasting) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 7000);
}
function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) {
  try { localStorage.setItem(key, value); }
  catch { notice('This browser cannot remember your seat. Keep this tab open during the match.', true); }
}
async function api(url, data) {
  const response = await fetch(url, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to connect. Try again.');
  return result;
}
function request(type, values = {}) {
  if (!connected || !socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Reconnecting. Wait for the table to come back online.'));
  const requestId = ++requestSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(requestId); reject(new Error('The server did not confirm the action. Check the table before trying again.')); }, 10000);
    requests.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ type, ...values, revision: state?.revision, requestId }));
  });
}
async function command(type, values = {}) {
  try { return await request(type, values); } catch (error) { notice(error.message); return null; }
}
function connect() {
  clearTimeout(reconnectTimer);
  if (!credentials) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket = ws;
  $('connection').textContent = reconnectAttempt ? 'Reconnecting…' : 'Connecting…';
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', ...credentials }));
  ws.onmessage = event => {
    if (socket !== ws) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'state') {
      const old = state;
      state = message; connected = true; reconnectAttempt = 0;
      if (!old || old.game?.turn !== state.game?.turn || old.game?.phase !== state.game?.phase || old.game?.handNumber !== state.game?.handNumber || old.game?.hand.length !== state.game?.hand.length) { hintCard = null; hintText = ''; }
      render();
    } else {
      const pending = requests.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timer); requests.delete(message.requestId);
        if (message.type === 'error') pending.reject(new Error(message.error)); else pending.resolve(message);
      } else if (message.type === 'error') {
        notice(message.error, true);
        if (message.status === 401 || message.status === 404) {
          credentials = null; state = null; connected = false;
          $('connection').textContent = 'Seat unavailable';
          render();
          if (joinRoom) loadJoin(joinRoom).catch(error => notice(error.message, true));
        }
      }
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    if (socket !== ws) return;
    connected = false;
    requests.forEach(p => { clearTimeout(p.timer); p.reject(new Error('Connection interrupted. Rejoining your seat…')); }); requests.clear();
    render();
    if (!credentials) return;
    $('connection').textContent = 'Reconnecting…'; $('connection').classList.add('offline');
    reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** reconnectAttempt++, 10000));
  };
}
function enter(result) {
  credentials = { code: result.code, token: result.token }; joinRoom = result.code;
  storageSet(`tarneeb-seat:${result.code}`, JSON.stringify(credentials));
  storageSet('tarneeb-name', $('name').value.trim());
  history.replaceState(null, '', `/?room=${encodeURIComponent(result.code)}`);
  connect();
}
async function loadJoin(code) {
  const info = await api(`/api/rooms/${encodeURIComponent(code)}`);
  joinRoom = info.code;
  $('cancel-invite').hidden = false;
  $('entry-title').textContent = 'Join your friends'; $('enter').textContent = info.started ? 'Join the table' : 'Take this seat';
  $('entry-note').textContent = info.started ? 'If a hand is underway, you’ll take over a bot seat when it ends.' : 'Seats 1 & 3 are partners. Seats 2 & 4 are partners.';
  $('join-seats').hidden = false;
  const available = info.seats.filter(s => !s.occupied);
  $('join-seats').innerHTML = '<label>Choose your seat</label><div class="join-seat-list">' + available.map((s, i) => `<label class="join-seat"><input type="radio" name="join-seat" value="${s.seat}" ${i === 0 ? 'checked' : ''}><span>Seat ${s.seat + 1}<br><small>${escapeHTML(s.name)}</small></span></label>`).join('') + '</div>';
  if (!available.length) $('join-seats').innerHTML = '<p>All seats are reserved. Ask the host to release a disconnected guest’s seat.</p>';
  $('enter').disabled = !available.length;
}
function codeFrom(value) {
  let code = value.trim();
  try { if (code.includes('://')) code = new URL(code).searchParams.get('room') || ''; } catch { return null; }
  return /^[a-f0-9]{12}$/i.test(code) ? code.toUpperCase() : null;
}
async function findRoom() {
  const code = codeFrom($('room-code').value);
  if (!code) return notice('Paste a complete invitation link or a 12-character table code.');
  const saved = storageGet(`tarneeb-seat:${code}`);
  if (saved) {
    try { enter(JSON.parse(saved)); return; } catch { /* Offer a fresh join if the saved session is invalid. */ }
  }
  try { await loadJoin(code); history.replaceState(null, '', `/?room=${code}`); }
  catch (error) { notice(error.message); }
}
async function copyInvite() {
  if (!state) return;
  const value = `${location.origin}/?room=${state.code}`;
  try { await navigator.clipboard.writeText(value); notice(location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? 'Invitation copied. Use your LAN or Render address before sending it to friends; localhost works only on this computer.' : 'Invitation copied. Send it to your friends!'); }
  catch { $('invite').value = value; $('invite').focus(); $('invite').select(); notice('Select and copy the invitation link shown on the page.'); }
}
function statusFor(seat) {
  if (!seat.human) return seat.mode === 'open' && !state.game ? 'Waiting for a friend' : `${titleCase(seat.bot.skill)} computer`;
  if (seat.pending) return 'Joining next hand';
  if (seat.takeover) return seat.online ? 'Bot playing · return next hand' : 'Disconnected · bot playing';
  if (!seat.online) return 'Reconnecting · up to 30 seconds';
  return 'Connected';
}
function render() {
  const hasState = !!state;
  $('welcome').hidden = hasState;
  $('lobby').hidden = !hasState || !!state.game;
  $('game-layout').hidden = !state?.game;
  $('players').hidden = !hasState; $('pause').hidden = !state?.host || !state.game;
  $('pause').disabled = !connected; $('pause').textContent = state?.paused ? 'Resume' : 'Pause';
  $('pause').setAttribute('aria-pressed', String(!!state?.paused));
  $('leave').hidden = !hasState;
  $('connection').classList.toggle('offline', hasState && !connected);
  if (!hasState) return;
  $('connection').textContent = connected ? 'Table connected' : 'Reconnecting…';
  $('save-status').textContent = 'Your seat is remembered in this browser';
  $('invite').value = `${location.origin}/?room=${state.code}`;
  if (!state.game) renderLobby(); else renderGame();
}
function renderLobby() {
  $('lobby-message').textContent = state.host ? 'Invite your friends, choose your seats, and deal when you’re ready.' : 'Choose your company. The host will deal when everyone is ready.';
  $('lobby-seats').innerHTML = state.seats.map((seat, i) => `<article class="panel lobby-seat"><div class="avatar">${escapeHTML(seat.name[0])}</div><h3>${escapeHTML(seat.name)}${i === state.you ? ' · You' : ''}</h3><p>${escapeHTML(statusFor(seat))}</p><span class="tag">SEAT ${i + 1} · TEAM ${i % 2 + 1}${seat.host ? ' · HOST' : ''}</span></article>`).join('');
  $('lobby-target').textContent = `First to ${state.target} · ${state.seats.filter(s => s.human).length} human players`;
  $('start').hidden = !state.host;
  $('start').disabled = !connected || state.seats.some(s => s.mode === 'open' && !s.human);
  $('start').textContent = state.seats.some(s => s.mode === 'open' && !s.human) ? 'Waiting for open seats' : 'Deal the first hand';
}
function renderGame() {
  const g = state.game, you = state.you, yourTeam = you % 2, names = state.seats.map(s => s.name);
  const myTurn = active() && g.turn === you;
  $('us-score').textContent = g.scores[yourTeam]; $('them-score').textContent = g.scores[1 - yourTeam];
  $('us-names').innerHTML = `YOUR TEAM<br>${escapeHTML(names[you])} + ${escapeHTML(names[(you + 2) % 4])}`;
  $('them-names').innerHTML = `OPPONENTS<br>${escapeHTML(names[(you + 1) % 4])} + ${escapeHTML(names[(you + 3) % 4])}`;
  $('round-meta').innerHTML = `HAND ${g.handNumber}<br>FIRST TO ${state.target}`;
  for (let relative = 0; relative < 4; relative++) {
    const p = (you + relative) % 4, seat = state.seats[p];
    const element = $('seat-' + relative);
    element.classList.toggle('active', !state.paused && ['auction', 'trump', 'play'].includes(g.phase) && g.turn === p);
    const description = !seat.online && seat.human ? statusFor(seat) : seat.pending || seat.takeover ? statusFor(seat) : g.turn === p && ['auction', 'trump', 'play'].includes(g.phase) ? (g.phase === 'auction' ? 'Bidding' : g.phase === 'trump' ? 'Choosing trump' : p === you ? 'Your turn' : 'Playing') : g.phase === 'auction' && g.passed[p] ? 'Passed' : g.bidder === p ? `Bidder · ${g.bid}` : p % 2 === yourTeam ? 'Your team' : 'Other team';
    element.innerHTML = `<div class="seat-name"><span class="avatar">${escapeHTML(seat.name[0])}</span>${escapeHTML(seat.name)}${relative === 2 ? '<span class="tag">PARTNER</span>' : ''}</div><div class="sub">${escapeHTML(description)}</div>${relative ? `<div class="backs" aria-label="${g.counts[p]} hidden cards">${Array.from({ length: Math.min(g.counts[p], 9) }, () => '<i class="back"></i>').join('')}</div>` : ''}`;
    const play = g.trick.find(x => x.player === p), slot = $('slot-' + relative);
    slot.innerHTML = play ? cardHTML(play.card) : '';
    slot.classList.toggle('winner', g.phase === 'trick' && g.turn === p);
  }
  const message = state.paused ? 'Table paused by the host' : g.phase === 'auction' ? `Auction · highest bid ${g.bid || '—'}` : g.phase === 'trump' ? `${names[g.bidder]} chooses trump` : g.phase === 'trick' ? `${names[g.turn]} wins this trick` : g.phase === 'play' ? `Trick ${g.history.length + 1} of 13 · ${SUITNAME[g.trump]}` : g.phase === 'redeal' ? 'Everyone passed · redeal' : g.phase === 'matchEnd' ? 'Match complete' : 'Hand complete';
  $('table-message').textContent = message;
  $('hand').innerHTML = g.hand.map(c => cardHTML(c, true, !connected || !g.legal.includes(c))).join('');
  $('hand-count').textContent = `· ${g.hand.length} cards`;
  $('hint').disabled = !myTurn || !['auction', 'trump', 'play'].includes(g.phase);
  $('legend').textContent = !connected ? 'Reconnecting to your table. Your seat is reserved.' : state.pending ? 'You’ll take over this seat when the next hand begins.' : state.takeover ? 'A bot is finishing this hand. You’ll return for the next deal.' : hintText || (state.paused ? 'The host has paused the table.' : myTurn && g.phase === 'play' ? g.trick.length ? `Follow ${SUITNAME[suit(g.trick[0].card)]} if you can. Gold edges mark legal cards.` : 'You lead. Choose any card with a gold edge.' : '');
  $('legend').classList.toggle('hint-text', !!hintText);
  renderAction(g, myTurn, names, yourTeam);
  $('contract-panel').innerHTML = g.bidder === null ? '<div class="eyebrow">Your table</div><p>Partners sit opposite each other. The highest bidder names trump.</p>' : `<div class="eyebrow">The contract</div><div class="contract"><span>${escapeHTML(names[g.bidder])}</span><strong>${g.bid} ${SYMBOL[g.trump] || ''}</strong></div><div class="mini-row"><span>${g.trump ? SUITNAME[g.trump] : 'Trump to be chosen'}</span><b>${g.tricks[g.bidder % 2]} / ${g.bid}</b></div><div class="progress"><div style="width:${Math.min(100, g.tricks[g.bidder % 2] / g.bid * 100)}%"></div></div><div class="mini-row"><span>Tricks remaining</span><b>${13 - g.history.length}</b></div>`;
  $('feed').replaceChildren(...state.log.slice(-14).map(text => { const div = document.createElement('div'); div.textContent = text; return div; }));
  $('feed').scrollTop = $('feed').scrollHeight;
  const announcement = message + (myTurn && g.phase === 'play' ? '. Your turn.' : '');
  if ($('announcement').textContent !== announcement) $('announcement').textContent = announcement;
}
function renderAction(g, myTurn, names, yourTeam) {
  const panel = $('action-panel'), who = escapeHTML(names[g.turn]);
  if (state.paused) { panel.innerHTML = '<div class="eyebrow">Take your time</div><h2>Table paused</h2><p>The host can resume when everyone is ready.</p>'; return; }
  if (g.phase === 'auction') {
    panel.innerHTML = `<div class="eyebrow">The auction</div><h2>${myTurn ? 'What can your team take?' : who + ' is bidding'}</h2><p>${g.bid ? `${escapeHTML(names[g.bidder])} has bid <b>${g.bid}</b>. Raise or pass.` : 'The minimum bid is 7 tricks. Think about your strongest suit.'}</p>${myTurn ? `<div class="bid-grid">${[7, 8, 9, 10, 11, 12, 13].map(b => `<button data-bid="${b}" ${b <= g.bid ? 'disabled' : ''}>${b}</button>`).join('')}</div><button class="wide subtle" data-action="pass">Pass</button>` : '<div class="badge">Waiting for the next bid…</div>'}`;
  } else if (g.phase === 'trump') {
    panel.innerHTML = `<div class="eyebrow">Choose the advantage</div><h2>${myTurn ? 'Name your trump' : who + ' chooses trump'}</h2><p>The bidding team must take at least ${g.bid} tricks.</p>${myTurn ? `<div class="suit-grid">${SUITS.map(s => `<button data-trump="${s}" class="${['H', 'D'].includes(s) ? 'red' : ''}" aria-label="Choose ${SUITNAME[s]}">${SYMBOL[s]}</button>`).join('')}</div><button class="wide subtle" data-trump="N" style="margin-top:10px">No trump</button>` : ''}`;
  } else if (['play', 'trick'].includes(g.phase)) {
    panel.innerHTML = `<div class="eyebrow">Trick ${g.history.length + 1} of 13</div><h2>${g.phase === 'trick' ? who + ' takes the trick' : myTurn ? 'Your move' : who + ' is playing'}</h2><p>${myTurn && g.phase === 'play' ? g.trick.length ? 'Follow the suit led if you have it. Otherwise, play any card.' : 'You lead this trick. Choose a card from your hand.' : 'The winner leads the next trick.'}</p><div class="mini-row"><span>Your team’s tricks</span><b>${g.tricks[yourTeam]}</b></div><div class="mini-row"><span>Opponents’ tricks</span><b>${g.tricks[1 - yourTeam]}</b></div>`;
  } else if (g.phase === 'redeal') {
    panel.innerHTML = '<div class="eyebrow">No contract</div><h2>Everyone passed</h2><p>The same dealer will shuffle and deal again.</p>' + (state.host ? '<button class="primary wide" data-action="next">Redeal</button>' : '<p>Waiting for the host to redeal.</p>');
  } else {
    const match = g.phase === 'matchEnd', usWon = g.scores[yourTeam] >= state.target;
    panel.innerHTML = `<div class="eyebrow">${match ? 'Match complete' : 'Hand complete'}</div><h2 class="${match ? 'win-title' : ''}">${match ? usWon ? 'Your team wins!' : 'Opponents win' : g.result.made ? 'Contract made' : 'Contract missed'}</h2><p>${escapeHTML(names[g.bidder])} bid ${g.bid} and their team took ${g.result.taken} tricks.</p><div class="mini-row"><span>Your team</span><b>${g.result.changes[yourTeam] >= 0 ? '+' : ''}${g.result.changes[yourTeam]}</b></div><div class="mini-row"><span>Opponents</span><b>${g.result.changes[1 - yourTeam] >= 0 ? '+' : ''}${g.result.changes[1 - yourTeam]}</b></div>${state.host ? `<button class="primary wide" data-action="${match ? 'start' : 'next'}">${match ? 'Play another match' : 'Deal next hand'}</button>` : '<p>Waiting for the host.</p>'}`;
  }
  if (!connected) panel.querySelectorAll('button').forEach(b => { b.disabled = true; });
}
function openPlayers() {
  if (!state) return;
  const editable = state.host && boundary() && connected;
  $('settings-note').textContent = !state.host ? 'Only the host can change settings. Partners sit opposite each other.' : boundary() ? 'Partners sit opposite. Choose computers or open seats for friends.' : 'Seat and difficulty changes are available when this hand ends.';
  $('seat-settings').innerHTML = state.seats.map((seat, i) => `<section class="setting-seat"><h3>Seat ${i + 1} · ${escapeHTML(seat.name)} · Team ${i % 2 + 1}</h3><p class="small">${escapeHTML(statusFor(seat))}</p><div class="setting-grid"><div><label for="mode-${i}">Empty seat</label><select id="mode-${i}" ${!editable || seat.human ? 'disabled' : ''}>${['bot', 'open'].map(x => `<option value="${x}" ${seat.mode === x ? 'selected' : ''}>${x === 'bot' ? 'Computer' : 'Wait for friend'}</option>`).join('')}</select></div><div><label for="skill-${i}">Computer skill</label><select id="skill-${i}" ${!editable ? 'disabled' : ''}>${['beginner', 'standard', 'expert'].map(x => `<option ${seat.bot.skill === x ? 'selected' : ''} value="${x}">${titleCase(x)}</option>`).join('')}</select></div><div><label for="style-${i}">Personality</label><select id="style-${i}" ${!editable ? 'disabled' : ''}>${['cautious', 'balanced', 'aggressive'].map(x => `<option ${seat.bot.style === x ? 'selected' : ''} value="${x}">${titleCase(x)}</option>`).join('')}</select></div></div>${state.host ? `<div class="setting-tools">${editable ? `<select id="swap-${i}" aria-label="Seat to swap with seat ${i + 1}">${[0, 1, 2, 3].filter(s => s !== i).map(s => `<option value="${s}">Seat ${s + 1}</option>`).join('')}</select><button type="button" data-swap="${i}">Swap seats</button>` : ''}${seat.human && !seat.online && !seat.host ? `<button type="button" data-release="${i}">Release seat to bot</button>` : ''}${seat.human && seat.online && !seat.host ? `<button type="button" data-transfer="${i}">Make host</button>` : ''}</div>` : ''}</section>`).join('');
  $('target').value = state.target; $('speed').value = state.speed;
  $('target').disabled = $('speed').disabled = $('apply-settings').disabled = !editable;
  if (!$('players-dialog').open) $('players-dialog').showModal();
}
function showHistory() {
  if (!state?.game) return;
  $('history-content').innerHTML = state.game.history.length ? state.game.history.map((h, i) => `<div class="history-trick"><div>Trick ${i + 1}<br><small>${escapeHTML(state.seats[h.winner].name)} won</small></div><div class="history-cards">${h.plays.map(p => `<div><small>${escapeHTML(state.seats[p.player].name)}</small>${cardHTML(p.card)}</div>`).join('')}</div></div>`).join('') : '<p>No completed tricks yet.</p>';
  $('history-dialog').showModal();
}
function home() {
  if (state && !confirm('Leave this table? A bot will fill in after 30 seconds. You can return using the same invitation in this browser.')) return;
  credentials = null; state = null; connected = false; joinRoom = null;
  clearTimeout(reconnectTimer);
  const old = socket; socket = null; old?.close();
  history.replaceState(null, '', '/'); location.reload();
}
$('cancel-invite').onclick = () => {
  credentials = null; joinRoom = null; connected = false;
  clearTimeout(reconnectTimer); const old = socket; socket = null; old?.close();
  history.replaceState(null, '', '/'); location.reload();
};
$('entry-form').addEventListener('submit', async event => {
  event.preventDefault(); $('enter').disabled = true;
  try {
    const displayName = $('name').value.trim();
    const seat = document.querySelector('input[name="join-seat"]:checked');
    if (joinRoom && !seat) throw new Error('Choose an available seat.');
    enter(await api(joinRoom ? `/api/rooms/${joinRoom}/join` : '/api/rooms', joinRoom ? { name: displayName, seat: Number(seat.value) } : { name: displayName }));
  } catch (error) { notice(error.message); if (joinRoom) loadJoin(joinRoom).catch(() => {}); }
  finally { $('enter').disabled = false; }
});
$('find-room').onclick = findRoom;
$('room-code').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); findRoom(); } });
$('copy-invite').onclick = $('settings-invite').onclick = copyInvite;
$('start').onclick = () => command('start');
$('pause').onclick = () => command('pause');
$('players').onclick = openPlayers;
$('history').onclick = showHistory;
$('leave').onclick = home;
$('hint').onclick = async () => {
  const result = await command('hint');
  if (result) { hintCard = result.card; hintText = result.text.replace(/\b([SHDC])\b/g, s => SUITNAME[s]); render(); }
};
$('hand').addEventListener('click', event => {
  const button = event.target.closest('[data-card]');
  if (button && !button.disabled && active()) command('card', { value: Number(button.dataset.card) });
});
$('action-panel').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.bid) command('bid', { value: Number(button.dataset.bid) });
  else if (button.dataset.trump) command('trump', { value: button.dataset.trump });
  else if (button.dataset.action === 'pass') command('bid', { value: null });
  else if (button.dataset.action) command(button.dataset.action);
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const result = await command('configure', { target: Number($('target').value), speed: Number($('speed').value), seats: [0, 1, 2, 3].map(i => ({ mode: $('mode-' + i).value, bot: { skill: $('skill-' + i).value, style: $('style-' + i).value } })) });
  if (result) $('players-dialog').close();
});
$('seat-settings').addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  let result;
  if (button.dataset.swap !== undefined) result = await command('swap', { a: Number(button.dataset.swap), b: Number($('swap-' + button.dataset.swap).value) });
  else if (button.dataset.release !== undefined) result = await command('release', { seat: Number(button.dataset.release) });
  else if (button.dataset.transfer !== undefined && confirm('Give this player the host controls?')) result = await command('transfer', { seat: Number(button.dataset.transfer) });
  if (result) openPlayers();
});
document.addEventListener('click', event => { const button = event.target.closest('[data-close]'); if (button) $(button.dataset.close).close(); });
const rulesReady = fetch('/rules.html').then(r => r.text()).then(html => document.body.insertAdjacentHTML('beforeend', html));
$('rules').onclick = async () => { try { await rulesReady; $('rules-dialog').showModal(); } catch { notice('The rules could not load. Check your connection.'); } };
$('name').value = storageGet('tarneeb-name') || '';
document.querySelector('.welcome-cards').innerHTML = [12, 38, 24].map(c => cardHTML(c)).join('');
(async () => {
  const code = codeFrom(new URL(location.href).searchParams.get('room') || '');
  if (!code) return;
  joinRoom = code;
  const saved = storageGet(`tarneeb-seat:${code}`);
  if (saved) { try { const parsed = JSON.parse(saved); if (parsed.code === code && /^[a-f0-9]{64}$/.test(parsed.token)) { credentials = parsed; connect(); return; } } catch { /* Join screen remains available. */ } }
  try { await loadJoin(code); } catch (error) { joinRoom = null; notice(error.message, true); }
})();
