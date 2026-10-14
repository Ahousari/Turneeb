// One-time extraction of the existing rules, strategies, and card artwork.
const fs = require('node:fs');
const source = fs.readFileSync('tarneeb.html', 'utf8');
fs.mkdirSync('lib', { recursive: true });
fs.mkdirSync('public', { recursive: true });
const constants = source.slice(source.indexOf('const SUITS='), source.indexOf('let config='));
const rules = source.slice(source.indexOf('function deal('), source.indexOf('function newMatch('))
  + source.slice(source.indexOf('function legalCards('), source.indexOf('function nextHand('));
const strategy = source.slice(source.indexOf('function observe('), source.indexOf('// INTERFACE.'));
fs.writeFileSync('lib/engine.js', `'use strict';\n${constants.replace(/const NAMES=.*\n/, '')}
module.exports = function createEngine(names, emit) {
 const NAMES = names;
 const log = emit;
 ${rules.replace("(bt===0?'Your team':'Opponents')", "(NAMES[bt]+' + '+NAMES[bt+2])")}
 ${strategy}
 return {deal,legalCards,auctionAction,chooseTrump,playCard,finishTrick,scoreHand,observe,computerBid,bestTrump,computerCard,expert,bidEstimate,heuristic,winningPlay};
};\n`);
fs.writeFileSync('public/base.css', source.match(/<style>([\s\S]*?)<\/style>/)[1]);
const artwork = source.slice(source.indexOf('function landscapeHTML('), source.indexOf('function titleCase('));
fs.writeFileSync('public/cards.js', `'use strict';\nconst SUITS=['S','H','D','C'];
const SYMBOL={S:'♠',H:'♥',D:'♦',C:'♣',N:'NT'};
const SUITNAME={S:'Spades',H:'Hearts',D:'Diamonds',C:'Clubs',N:'No trump'};
const rank=c=>c%13+2;
const suit=c=>SUITS[Math.floor(c/13)];
const label=c=>({11:'Jack',12:'Queen',13:'King',14:'Ace'}[rank(c)]||rank(c))+' of '+SUITNAME[suit(c)];
let hintCard=null;\n${artwork}`);
let rulesDialog = source.slice(source.indexOf('<dialog id="rules-dialog"'), source.indexOf('<dialog id="history-dialog"'));
rulesDialog = rulesDialog.replace('You and Zaid are a team; Omar and Sami are the other team.', 'Partners sit opposite each other.');
rulesDialog = rulesDialog.replace('You → Omar → Zaid → Sami', 'You → Right → Partner → Left');
rulesDialog = rulesDialog.replace(/<h3>Running and saving<\/h3>[\s\S]*?<\/dialog>/, '<h3>Playing with friends</h3><p>Share your table invitation. Your browser remembers your seat so you can refresh and reconnect. After 30 seconds disconnected, a computer takes over until the next hand. New players enter between hands. Only the host can pause, start, or change seats.</p></dialog>');
fs.writeFileSync('public/rules.html', rulesDialog);
