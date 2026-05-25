import log from '../logger.js';

const HAZARD_MOVEMENT_POLICY = Symbol('hazardMovementPolicy');

const PATHING_HAZARD_BLOCKS = new Set([
  'lava',
  'fire',
  'soul_fire',
  'magma_block',
  'cactus',
  'sweet_berry_bush',
  'wither_rose',
]);

const PATHING_ADJACENT_HAZARD_OFFSETS = Object.freeze([
  [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
]);

export function applyHazardMovementPolicy(movements, bot = null, opts = {}) {
  if (!movements) return { ok: true, applied: false };
  const logger = opts.logger || log.executor;
  const hazards = new Set(opts.hazardBlocks || PATHING_HAZARD_BLOCKS);
  const cost = opts.cost ?? 100;
  const checkAdjacent = opts.checkAdjacent !== false;
  let reportedReadError = false;
  const exclusion = (block) => {
    if (!block) return 0;
    if (hazards.has(block.name)) return cost;
    if (!checkAdjacent || !block.position || typeof bot?.blockAt !== 'function') return 0;
    for (const [ox, oy, oz] of PATHING_ADJACENT_HAZARD_OFFSETS) {
      let adjacent;
      try {
        adjacent = bot.blockAt(offsetPosition(block.position, ox, oy, oz));
      } catch (err) {
        if (!reportedReadError) {
          reportedReadError = true;
          logger?.warn?.('movement.hazard-read-error', {
            err: err?.message || String(err),
            position: positionForLog(block.position),
            offset: { x: ox, y: oy, z: oz },
          });
        }
        return cost;
      }
      if (hazards.has(adjacent?.name)) return cost;
    }
    return 0;
  };
  Object.defineProperty(exclusion, HAZARD_MOVEMENT_POLICY, { value: true });

  replaceMovementPolicy(movements.exclusionAreasStep, exclusion, HAZARD_MOVEMENT_POLICY);
  replaceMovementPolicy(movements.exclusionAreasBreak, exclusion, HAZARD_MOVEMENT_POLICY);
  replaceMovementPolicy(movements.exclusionAreasPlace, exclusion, HAZARD_MOVEMENT_POLICY);
  return { ok: true, applied: true };
}

function replaceMovementPolicy(areas, exclusion, marker) {
  if (!Array.isArray(areas)) return;
  for (let i = areas.length - 1; i >= 0; i--) {
    if (areas[i]?.[marker]) areas.splice(i, 1);
  }
  areas.push(exclusion);
}

function offsetPosition(p, dx, dy, dz) {
  if (typeof p?.offset === 'function') return p.offset(dx, dy, dz);
  return { x: p.x + dx, y: p.y + dy, z: p.z + dz };
}

function positionForLog(p) {
  if (!p) return null;
  return { x: p.x, y: p.y, z: p.z };
}
