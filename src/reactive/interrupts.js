// Notification facade between the PathfinderOwner and the executor.
//
// The owner calls notifyPreempt(reason) when reactive takes the token away
// from a skill, and notifyRelease(reason) when reactive returns to NORMAL.
// The executor subscribes to 'preempted' / 'released' to flip its paused flag
// and reads lastReleasedAt for the resume debounce.
//
// No state, no logic — just a typed event bus. All ownership/cancellation
// logic lives in src/control/pathfinder.js.

import { EventEmitter } from 'node:events';

import log from '../logger.js';

class InterruptBus extends EventEmitter {
  constructor() {
    super();
    this.lastReleasedAt = Date.now();
  }

  notifyPreempt(reason) {
    this._emitSafe('preempted', reason);
  }

  notifyRelease(reason) {
    this.lastReleasedAt = Date.now();
    this._emitSafe('released', reason);
  }

  _emitSafe(event, reason) {
    for (const listener of this.rawListeners(event)) {
      try {
        listener.call(this, reason);
      } catch (err) {
        log.reactive.warn('interrupt.listener-error', {
          event,
          err: err?.message || String(err),
        });
      }
    }
  }
}

export const interrupts = new InterruptBus();
export default interrupts;
