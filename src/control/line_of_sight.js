export function entityAimPoint(entity) {
  const pos = entity?.position;
  if (!pos) return null;
  const height = Number.isFinite(entity.height) ? Math.min(Math.max(entity.height * 0.7, 0.5), 1.6) : 1;
  return typeof pos.offset === 'function'
    ? pos.offset(0, height, 0)
    : { x: pos.x, y: pos.y + height, z: pos.z };
}

export function readEntityLineOfSight(bot, entity, logSink, opts = {}) {
  const errorEvent = opts.errorEvent || 'entity.line-of-sight-error';
  if (!bot || !entity) return null;

  if (typeof bot.canSeeEntity === 'function') {
    try {
      const visible = bot.canSeeEntity(entity) === true;
      if (visible || opts.raycastOnCanSeeFalse !== true) return visible;
    } catch (err) {
      logSink?.warn?.(errorEvent, {
        entity: entity?.name,
        entityId: entity?.id,
        err: err?.message || String(err),
      });
    }
  }

  const origin = entityEyePoint(bot.entity);
  const target = entityAimPoint(entity);
  if (!origin || !target || !bot.world || typeof bot.world.raycast !== 'function') return null;

  const direction = typeof target.minus === 'function'
    ? target.minus(origin)
    : {
      x: Number(target.x) - Number(origin.x),
      y: Number(target.y) - Number(origin.y),
      z: Number(target.z) - Number(origin.z),
    };
  const distance = typeof origin.distanceTo === 'function'
    ? origin.distanceTo(target)
    : Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(distance) || distance <= 0) return null;

  const unit = typeof direction.scaled === 'function'
    ? direction.scaled(1 / distance)
    : { x: direction.x / distance, y: direction.y / distance, z: direction.z / distance };
  try {
    return bot.world.raycast(origin, unit, distance) == null;
  } catch (err) {
    logSink?.warn?.(errorEvent, {
      entity: entity?.name,
      entityId: entity?.id,
      err: err?.message || String(err),
    });
    return null;
  }
}

function entityEyePoint(entity) {
  const pos = entity?.position;
  if (!pos) return null;
  const eyeHeight = Number.isFinite(entity.height) ? Math.min(Math.max(entity.height * 0.9, 1), 1.7) : 1.62;
  return typeof pos.offset === 'function'
    ? pos.offset(0, eyeHeight, 0)
    : { x: pos.x, y: pos.y + eyeHeight, z: pos.z };
}
