'use strict';
const SUITS=['S','H','D','C'];
const SYMBOL={S:'♠',H:'♥',D:'♦',C:'♣'};
const SUITNAME={S:'Spades',H:'Hearts',D:'Diamonds',C:'Clubs',N:'No trump'};
const RANKNAME={11:'Jack',12:'Queen',13:'King',14:'Ace'};
const DEFAULT={target:31,speed:650,bots:[null,{skill:'standard',style:'aggressive'},{skill:'standard',style:'balanced'},{skill:'standard',style:'cautious'}]};
const STORE='tarneeb-table-v1';
const clone=x=>JSON.parse(JSON.stringify(x));
const partner=p=>(p+2)%4;
const team=p=>p%2;
const next=p=>(p+1)%4;
const rank=c=>c%13+2;
const suit=c=>SUITS[Math.floor(c/13)];
const label=c=>(RANKNAME[rank(c)]||rank(c))+' of '+SUITNAME[suit(c)];
const short=c=>({11:'J',12:'Q',13:'K',14:'A'}[rank(c)]||rank(c))+SYMBOL[suit(c)];
const shuffle=a=>{for(let i=a.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const sortHand=(a,trump=null)=>a.slice().sort((a,b)=>((suit(a)===trump?-1:SUITS.indexOf(suit(a)))-(suit(b)===trump?-1:SUITS.indexOf(suit(b))))||rank(b)-rank(a));

module.exports = function createEngine(names, emit) {
 const NAMES = names;
 const log = emit;
 function deal(g){const deck=shuffle(Array.from({length:52},(_,i)=>i));g.hands=[[],[],[],[]];deck.forEach((c,i)=>g.hands[i%4].push(c));g.hands=g.hands.map(h=>sortHand(h));Object.assign(g,{phase:'auction',turn:next(g.dealer),passed:[false,false,false,false],bid:0,bidder:null,trump:null,trick:[],history:[],tricks:[0,0],voids:[[],[],[],[]],result:null});log('Hand '+g.hand+' · '+NAMES[g.dealer]+' deals.');}
function legalCards(g,p){const hand=g.hands[p];if(!g.trick.length)return hand.slice();const follows=hand.filter(c=>suit(c)===suit(g.trick[0].card));return follows.length?follows:hand.slice();}
function beats(c,b,led,trump){if(suit(c)===suit(b))return rank(c)>rank(b);if(suit(c)===trump)return true;if(suit(b)===trump)return false;return suit(c)===led&&suit(b)!==led;}
function winningPlay(trick,trump){if(!trick.length)return null;let best=trick[0],led=suit(best.card);for(const play of trick.slice(1))if(beats(play.card,best.card,led,trump))best=play;return best;}
function auctionAction(g,p,bid){if(g.phase!=='auction'||g.turn!==p||g.passed[p])return false;if(bid===null){g.passed[p]=true;log(NAMES[p]+' passes.');}else{if(!Number.isInteger(bid)||bid<7||bid>13||bid<=g.bid)return false;g.bid=bid;g.bidder=p;log(NAMES[p]+' bids '+bid+'.');}
 if(g.bid===13||(g.bidder!==null&&g.passed.filter(Boolean).length===3)){g.phase='trump';g.turn=g.bidder;log(NAMES[g.bidder]+' wins the auction at '+g.bid+'.');return true;}
 if(g.passed.every(Boolean)){g.phase='redeal';log('Everyone passed. The same dealer will redeal.');return true;}
 let pnext=next(p);while(g.passed[pnext])pnext=next(pnext);g.turn=pnext;return true;
}
function chooseTrump(g,p,trump){if(g.phase!=='trump'||p!==g.bidder||![...SUITS,'N'].includes(trump))return false;g.trump=trump;g.turn=p;g.phase='play';g.hands=g.hands.map(h=>sortHand(h,trump));log(NAMES[p]+' chooses '+SUITNAME[trump]+'.');return true;}
function playCard(g,p,c){if(g.phase!=='play'||g.turn!==p||!legalCards(g,p).includes(c))return false;const led=g.trick.length?suit(g.trick[0].card):null;if(led&&suit(c)!==led&&!g.voids[p].includes(led))g.voids[p].push(led);g.hands[p].splice(g.hands[p].indexOf(c),1);g.trick.push({player:p,card:c});if(g.trick.length===4){g.phase='trick';g.turn=winningPlay(g.trick,g.trump).player;}else g.turn=next(p);return true;}
function finishTrick(g){if(g.phase!=='trick')return false;const winner=winningPlay(g.trick,g.trump).player;g.tricks[team(winner)]++;g.history.push({plays:g.trick.slice(),winner});log('Trick '+g.history.length+': '+NAMES[winner]+' takes it with '+short(winningPlay(g.trick,g.trump).card)+'.');g.trick=[];g.turn=winner;if(g.history.length===13)finishHand(g);else g.phase='play';return true;}
function scoreHand(bid,taken){const other=13-taken;if(bid===13)return taken===13?[26,0]:[-16,other*2];if(taken===13)return [16,0];return taken>=bid?[taken,0]:[-bid,other];}
function finishHand(g){const bt=team(g.bidder),taken=g.tricks[bt],delta=scoreHand(g.bid,taken),changes=[0,0];changes[bt]=delta[0];changes[1-bt]=delta[1];g.scores=g.scores.map((v,i)=>v+changes[i]);g.result={made:taken>=g.bid,changes,taken};g.phase=g.scores.some(s=>s>=g.target)?'matchEnd':'handEnd';log((NAMES[bt]+' + '+NAMES[bt+2])+(g.result.made?' makes':' misses')+' the bid. '+(changes[0]>=0?'+':'')+changes[0]+' / '+(changes[1]>=0?'+':'')+changes[1]+' points.');}

 function observe(g,p){return {player:p,hand:g.hands[p].slice(),counts:g.hands.map(h=>h.length),trick:g.trick.map(x=>({...x})),history:g.history.map(h=>({plays:h.plays.map(x=>({...x})),winner:h.winner})),voids:g.voids.map(v=>v.slice()),trump:g.trump,bid:g.bid,bidder:g.bidder,tricks:g.tricks.slice(),passed:g.passed.slice()};}
function trumpStrength(hand,s){const cards=hand.filter(c=>suit(c)===s),ranks=cards.map(rank);let power=cards.length*.53+Math.max(0,cards.length-4)*.43;for(const r of ranks)power+=({14:1.05,13:.7,12:.4,11:.2}[r]||0);for(const c of hand.filter(c=>suit(c)!==s)){const length=hand.filter(x=>suit(x)===suit(c)).length;power+=rank(c)===14?.9:rank(c)===13&&length>1?.48:rank(c)===12&&length>2?.2:0;}return power;}
function bestTrump(hand){return SUITS.reduce((best,s)=>trumpStrength(hand,s)>trumpStrength(hand,best)?s:best,'S');}
function bidEstimate(o,bot){const t=bestTrump(o.hand),power=trumpStrength(o.hand,t);let expectation=power+1.9+(bot.style==='aggressive'?.65:bot.style==='cautious'?-.65:0);if(bot.skill==='beginner')expectation+=(Math.random()-.5)*3.4;else if(bot.skill==='standard')expectation+=(Math.random()-.5)*.9;return Math.max(0,Math.min(13,Math.floor(expectation)));}
function computerBid(o,bot){let estimate=bidEstimate(o,bot);if(o.bidder===partner(o.player)&&o.bid>=7)estimate-=bot.style==='aggressive'?.8:1.8;return estimate>=Math.max(7,o.bid+1)?Math.max(7,o.bid+1):null;}
function obsLegal(o){if(!o.trick.length)return o.hand.slice();const led=suit(o.trick[0].card),follow=o.hand.filter(c=>suit(c)===led);return follow.length?follow:o.hand.slice();}
function publicPlayed(o){return o.history.flatMap(h=>h.plays.map(x=>x.card)).concat(o.trick.map(x=>x.card));}
function isMaster(c,o){const known=o._known||(o._known=new Set([...publicPlayed(o),...o.hand]));const masters=o._masters||(o._masters=new Map());if(masters.has(c))return masters.get(c);let answer=true;for(let r=rank(c)+1;r<=14;r++)if(!known.has(SUITS.indexOf(suit(c))*13+r-2)){answer=false;break;}masters.set(c,answer);return answer;}
function cheap(c,o){return rank(c)+(suit(c)===o.trump?9:0)+(isMaster(c,o)?4:0);}
function heuristic(o,bot={style:'balanced'}){const legal=obsLegal(o);if(legal.length===1)return legal[0];const low=a=>a.slice().sort((a,b)=>cheap(a,o)-cheap(b,o))[0];if(o.trick.length){const winner=winningPlay(o.trick,o.trump);if(team(winner.player)===team(o.player))return low(legal);const wins=legal.filter(c=>beats(c,winner.card,suit(o.trick[0].card),o.trump));if(wins.length){if(o.trick.length===3)return low(wins);const safe=wins.filter(c=>isMaster(c,o));if(safe.length)return low(safe);return low(wins);}return low(legal);}
 const masters=legal.filter(c=>isMaster(c,o));const bt=team(o.bidder);const trumps=legal.filter(c=>suit(c)===o.trump);const opponentMightTrump=[next(o.player),next(partner(o.player))].some(p=>!o.voids[p].includes(o.trump)&&o.counts[p]>0);if(bt===team(o.player)&&trumps.length>=3&&opponentMightTrump){const high=trumps.filter(c=>isMaster(c,o));if(high.length)return high.sort((a,b)=>rank(b)-rank(a))[0];if(bot.style==='aggressive')return low(trumps);}
 if(masters.length){const safe=masters.filter(c=>[next(o.player),next(partner(o.player))].every(p=>!o.voids[p].includes(suit(c))||o.voids[p].includes(o.trump)||o.trump==='N'||suit(c)===o.trump));if(safe.length)return safe.sort((a,b)=>cheap(a,o)-cheap(b,o))[0];}
 const support=legal.filter(c=>o.voids[partner(o.player)].includes(suit(c))&&!o.voids[partner(o.player)].includes(o.trump)&&suit(c)!==o.trump&&o.trump!=='N');if(support.length)return low(support);
 const nonTrump=legal.filter(c=>suit(c)!==o.trump);if(nonTrump.length){const lengths={};nonTrump.forEach(c=>lengths[suit(c)]=(lengths[suit(c)]||0)+1);const longest=Math.max(...Object.values(lengths));return low(nonTrump.filter(c=>lengths[suit(c)]===longest));}return low(legal);
}
// Sample unseen cards consistent with public failures to follow suit and hand sizes.
function sampleHands(o){const known=new Set([...publicPlayed(o),...o.hand]);const unseen=Array.from({length:52},(_,i)=>i).filter(c=>!known.has(c));const others=[0,1,2,3].filter(p=>p!==o.player);for(let attempt=0;attempt<80;attempt++){let hands=[[],[],[],[]],caps=o.counts.slice();hands[o.player]=o.hand.slice();let cards=shuffle(unseen.slice());cards.sort((a,b)=>others.filter(p=>!o.voids[p].includes(suit(a))).length-others.filter(p=>!o.voids[p].includes(suit(b))).length);let valid=true;for(const c of cards){const allowed=others.filter(p=>caps[p]>0&&!o.voids[p].includes(suit(c)));if(!allowed.length){valid=false;break;}const total=allowed.reduce((n,p)=>n+caps[p],0);let roll=Math.random()*total,pick=allowed[allowed.length-1];for(const p of allowed){roll-=caps[p];if(roll<0){pick=p;break;}}hands[pick].push(c);caps[pick]--;}if(valid&&others.every(p=>caps[p]===0))return hands;}return null;}
function rollout(o,hands,first){let s={hands:hands.map(h=>h.slice()),trump:o.trump,bid:o.bid,bidder:o.bidder,tricks:o.tricks.slice(),trick:o.trick.map(x=>({...x})),history:o.history.slice(),voids:o.voids.map(v=>v.slice()),passed:[false,false,false,false]};let p=o.player,c=first;while(s.hands.some(h=>h.length)){const led=s.trick.length?suit(s.trick[0].card):null;if(led&&suit(c)!==led&&!s.voids[p].includes(led))s.voids[p].push(led);const idx=s.hands[p].indexOf(c);if(idx<0)return 0;s.hands[p].splice(idx,1);s.trick.push({player:p,card:c});if(s.trick.length===4){p=winningPlay(s.trick,s.trump).player;s.tricks[team(p)]++;s.history.push({plays:s.trick.slice(),winner:p});s.trick=[];}else p=next(p);if(!s.hands.some(h=>h.length))break;c=heuristic({player:p,hand:s.hands[p],counts:s.hands.map(h=>h.length),trick:s.trick,history:s.history,voids:s.voids,trump:s.trump,bidder:s.bidder});}
 const my=team(o.player),bt=team(o.bidder),taken=s.tricks[bt],d=scoreHand(o.bid,taken);return (my===bt?d[0]-d[1]:d[1]-d[0])+s.tricks[my]*.15;
}
function expert(o,bot){const legal=obsLegal(o);if(legal.length===1)return legal[0];const totals=new Map(legal.map(c=>[c,0]));let samples=0;const count=o.hand.length>8?30:48;for(let i=0;i<count;i++){const hands=sampleHands(o);if(!hands)continue;samples++;for(const c of legal)totals.set(c,totals.get(c)+rollout(o,hands,c));}if(!samples)return heuristic(o,bot);const recommended=heuristic(o,bot);return legal.reduce((best,c)=>{const bias=x=>(x===recommended?.035:0)+(bot.style==='cautious'?-cheap(x,o)*.002:bot.style==='aggressive'?rank(x)*.002:0);return totals.get(c)/samples+bias(c)>totals.get(best)/samples+bias(best)?c:best;},legal[0]);}
function computerCard(o,bot){const legal=obsLegal(o);if(bot.skill==='beginner'&&Math.random()<.38)return legal[Math.floor(Math.random()*legal.length)];return bot.skill==='expert'?expert(o,bot):heuristic(o,bot);}


 return {deal,legalCards,auctionAction,chooseTrump,playCard,finishTrick,scoreHand,observe,computerBid,bestTrump,computerCard,expert,bidEstimate,heuristic,winningPlay};
};
