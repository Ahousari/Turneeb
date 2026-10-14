'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/engine')(['A', 'B', 'C', 'D'], () => {});

test('Tarneeb scoring covers made, missed, kaboot, and bids of thirteen', () => {
  assert.deepEqual(engine.scoreHand(7, 8), [8, 0]);
  assert.deepEqual(engine.scoreHand(9, 6), [-9, 7]);
  assert.deepEqual(engine.scoreHand(7, 13), [16, 0]);
  assert.deepEqual(engine.scoreHand(13, 13), [26, 0]);
  assert.deepEqual(engine.scoreHand(13, 12), [-16, 2]);
});
test('auction validates turns and bids, and redeals when everyone passes', () => {
  const g = { dealer: 3, hand: 1, scores: [0, 0], target: 31 };
  engine.deal(g);
  assert.equal(engine.auctionAction(g, 1, 7), false);
  assert.equal(engine.auctionAction(g, 0, 6), false);
  assert.equal(engine.auctionAction(g, 0, null), true);
  assert.equal(engine.auctionAction(g, 1, null), true);
  assert.equal(engine.auctionAction(g, 2, null), true);
  assert.equal(engine.auctionAction(g, 3, null), true);
  assert.equal(g.phase, 'redeal');
  engine.deal(g);
  engine.auctionAction(g, 0, 13);
  assert.equal(g.phase, 'trump');
  assert.equal(engine.chooseTrump(g, 1, 'S'), false);
  assert.equal(engine.chooseTrump(g, 0, 'X'), false);
  assert.equal(engine.chooseTrump(g, 0, 'N'), true);
});
test('following suit is mandatory and trump beats the led suit', () => {
  const g = { phase: 'play', turn: 1, hands: [[], [0, 13], [], []], trick: [{ player: 0, card: 12 }], trump: 'H', voids: [[], [], [], []] };
  assert.deepEqual(engine.legalCards(g, 1), [0]);
  assert.equal(engine.playCard(g, 1, 13), false);
  assert.deepEqual(g.hands[1], [0, 13]);
  assert.equal(engine.winningPlay([{ player: 0, card: 12 }, { player: 1, card: 13 }], 'H').player, 1);
});
test('fifty full bot hands conserve every card and award thirteen tricks', () => {
  const bot = { skill: 'standard', style: 'balanced' };
  for (let i = 0; i < 50; i++) {
    const g = { dealer: i % 4, hand: 1, target: 10000, scores: [0, 0] };
    engine.deal(g);
    assert.equal(new Set(g.hands.flat()).size, 52);
    let actions = 0;
    while (!['handEnd', 'redeal'].includes(g.phase)) {
      assert.ok(++actions < 150, 'hand must terminate');
      const p = g.turn, o = engine.observe(g, p);
      assert.equal('hands' in o, false);
      if (g.phase === 'auction') assert.ok(engine.auctionAction(g, p, engine.computerBid(o, bot)));
      else if (g.phase === 'trump') assert.ok(engine.chooseTrump(g, p, engine.bestTrump(o.hand)));
      else if (g.phase === 'trick') assert.ok(engine.finishTrick(g));
      else assert.ok(engine.playCard(g, p, engine.computerCard(o, bot)));
      assert.equal(new Set([...g.hands.flat(), ...g.trick.map(x => x.card), ...g.history.flatMap(h => h.plays.map(x => x.card))]).size, 52);
    }
    if (g.phase !== 'redeal') { assert.equal(g.history.length, 13); assert.equal(g.tricks[0] + g.tricks[1], 13); assert.equal(g.hands.flat().length, 0); }
  }
});
test('expert chooses a legal move from a private observation', () => {
  const g = { dealer: 0, hand: 1, target: 31, scores: [0, 0] };
  engine.deal(g); engine.auctionAction(g, 1, 13); engine.chooseTrump(g, 1, 'S');
  const o = engine.observe(g, 1);
  assert.ok(engine.legalCards(g, 1).includes(engine.computerCard(o, { skill: 'expert', style: 'balanced' })));
});
