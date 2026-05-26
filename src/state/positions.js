import { Vec3 } from 'vec3';

export function toVec3(position) {
  if (!isPositionLike(position)) {
    throw new TypeError('position must contain finite x, y, and z coordinates');
  }
  return new Vec3(Number(position.x), Number(position.y), Number(position.z));
}

export function clonePositionPlain(position) {
  if (!isPositionLike(position)) return null;
  return {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
  };
}

function isPositionLike(position) {
  return Boolean(position) && ['x', 'y', 'z'].every((axis) => Number.isFinite(Number(position[axis])));
}
