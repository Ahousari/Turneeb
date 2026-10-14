'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
// A single reusable worker bounds memory and keeps expert simulations off the network thread.
class Bots {
  constructor() { this.worker = null; this.queue = []; this.active = null; this.sequence = 0; }
  card(observation, bot) {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, observation, bot, resolve, reject });
      this.pump();
    });
  }
  pump() {
    if (this.active || !this.queue.length) return;
    if (!this.worker) {
      this.worker = new Worker(path.join(__dirname, 'bot-worker.js'));
      this.worker.on('message', result => {
        const task = this.active;
        if (!task || result.id !== task.id) return;
        this.active = null;
        task.resolve(result.card);
        this.pump();
      });
      this.worker.on('error', error => {
        this.active?.reject(error);
        this.active = null;
        this.worker = null;
        this.pump();
      });
    }
    this.active = this.queue.shift();
    const { id, observation, bot } = this.active;
    this.worker.postMessage({ id, observation, bot });
  }
  async close() {
    this.queue.splice(0).forEach(task => task.reject(new Error('Server shutting down')));
    this.active?.reject(new Error('Server shutting down'));
    this.active = null;
    if (this.worker) await this.worker.terminate();
    this.worker = null;
  }
}
module.exports = Bots;
