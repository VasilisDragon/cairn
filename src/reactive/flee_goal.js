// FleeGoal — threat-relative "always be running" goal for the reactive flee
// branch. Replaces GoalInvert(GoalFollow) which had two structural problems
// that produced the boundary-yo-yo bug:
//
//   1. GoalInvert(GoalFollow).isEnd(node) returns true the moment the bot
//      crosses the range boundary from the cached entity position. With
//      dynamic=true, pathfinder's main loop (index.js ~458) then suppresses
//      goal_reached but also stops re-planning — the bot literally stops
//      walking inside the boundary.
//   2. GoalFollow.hasChanged only fires after the entity has moved
//      strictly more than `range` blocks from its cached position. Against
//      a same-speed pursuer that means the pursuer has fully closed the
//      gap before the next re-plan.
//
// This goal instead:
//   - reports isEnd === false unconditionally. The pathfinder never
//     considers the bot "done fleeing" while the goal is set. With
//     dynamic=true, A* returns partial paths (search budget hits before
//     isEnd) and the bot continuously walks them — and pathfinder
//     re-plans whenever the path runs out OR hasChanged() trips.
//   - reports hasChanged() true when the live entity has moved more than
//     hasChangedThresholdBlocks from the cached position. Default is small
//     (4 blocks) so re-plans are frequent and the bot's path keeps
//     pointing away from the LIVE entity, not a stale snapshot.
//   - reports isValid() === at least one threat is non-null and still alive.
//   - heuristic is a negative aggregate live-distance, so A* expansion prefers
//     nodes farther from the active threat set, not only the nearest mob.
//
// The reactive controller handles ending FLEEING via its own state machine
// (hostiles cleared from the configured exit radius after the hysteresis debounce);
// the goal itself stays armed forever and the controller stops the
// pathfinder + releases the token on transition back to NORMAL.

export class FleeGoal {
  /**
   * @param {object|object[]} threatSource — live mineflayer entity reference(s)
   * @param {object} [opts]
   * @param {number} [opts.hasChangedThresholdBlocks=4]
   *        Re-plan trigger threshold. Smaller = more frequent re-plans,
   *        fresher paths against the live threat set, at higher A* cost.
   */
  constructor(threatSource, opts = {}) {
    this.entities = Array.isArray(threatSource) ? threatSource : [threatSource];
    this.hasChangedThresholdSq = (opts.hasChangedThresholdBlocks ?? 4) ** 2;
    this._cached = new Map();
    for (const entity of this._liveEntities()) {
      const p = entity.position.floored();
      this._cached.set(entity, p);
    }
    const p = this._aggregatePosition();
    this.x = p?.x ?? 0;
    this.y = p?.y ?? 0;
    this.z = p?.z ?? 0;
  }

  // Negative aggregate distance — A* picks lowest-f nodes; with negative h,
  // "farthest from the threat field" wins. The minimum distance protects
  // against paths that run directly through one hostile while increasing total
  // distance from another, and the average distance rewards broader separation.
  heuristic(node) {
    const entities = this._liveEntities();
    if (entities.length === 0) return 0;

    let minDistance = Infinity;
    let totalDistance = 0;
    for (const entity of entities) {
      const p = entity.position;
      const dx = node.x - p.x;
      const dy = node.y - p.y;
      const dz = node.z - p.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      minDistance = Math.min(minDistance, distance);
      totalDistance += distance;
    }

    const averageDistance = totalDistance / entities.length;
    return -(minDistance + averageDistance);
  }

  // Never satisfied. The bot is always "trying to flee" while this goal is
  // set; the reactive controller is responsible for taking the goal down.
  isEnd(_node) {
    return false;
  }

  // True when any live threat drifts more than threshold from its cached pos;
  // updates cached positions as a side effect (consumes the change).
  hasChanged() {
    let changed = false;
    const live = this._liveEntities();
    for (const entity of live) {
      const p = entity.position.floored();
      const previous = this._cached.get(entity);
      if (!previous) {
        this._cached.set(entity, p);
        changed = true;
        continue;
      }

      const dx = previous.x - p.x;
      const dy = previous.y - p.y;
      const dz = previous.z - p.z;
      if (dx * dx + dy * dy + dz * dz > this.hasChangedThresholdSq) {
        this._cached.set(entity, p);
        changed = true;
      }
    }

    for (const entity of [...this._cached.keys()]) {
      if (!live.includes(entity)) {
        this._cached.delete(entity);
        changed = true;
      }
    }

    if (changed) {
      const p = this._aggregatePosition(live);
      this.x = p?.x ?? 0;
      this.y = p?.y ?? 0;
      this.z = p?.z ?? 0;
    }
    return changed;
  }

  isValid() {
    return this._liveEntities().length > 0;
  }

  _liveEntities() {
    return this.entities.filter((entity) => entity != null && entity.isValid !== false && entity.position != null);
  }

  _aggregatePosition(entities = this._liveEntities()) {
    if (entities.length === 0) return null;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const entity of entities) {
      x += entity.position.x;
      y += entity.position.y;
      z += entity.position.z;
    }
    return {
      x: Math.round(x / entities.length),
      y: Math.round(y / entities.length),
      z: Math.round(z / entities.length),
    };
  }
}

export default FleeGoal;
