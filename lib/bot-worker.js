'use strict';
const { parentPort } = require('node:worker_threads');
const engine = require('./engine')(['South', 'East', 'North', 'West'], () => {});
parentPort.on('message', ({ id, observation, bot }) => {
  try { parentPort.postMessage({ id, card: engine.computerCard(observation, bot) }); }
  catch { parentPort.postMessage({ id, card: engine.heuristic(observation, bot) }); }
});
