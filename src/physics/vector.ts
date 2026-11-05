export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function dot2(ax: number, ay: number, bx: number, by: number): number {
  return ax * bx + ay * by;
}

export function distSq2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

export function clamp(val: number, min: number, max: number): number {
  return val < min ? min : val > max ? max : val;
}

// Closest point on line segment AB to point P
export function closestPointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { x: number; y: number; t: number } {
  const abx = bx - ax;
  const aby = by - ay;
  const abLenSq = abx * abx + aby * aby;
  if (abLenSq === 0) return { x: ax, y: ay, t: 0 };
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / abLenSq, 0, 1);
  return {
    x: ax + t * abx,
    y: ay + t * aby,
    t,
  };
}
