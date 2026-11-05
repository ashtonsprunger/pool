// Official WPA (World Pool-Billiard Association) 9-Foot Regulation Specifications
// All canonical spatial dimensions are in INCHES, time in SECONDS.

export const TABLE_LENGTH = 100.0; // Playing surface length (nose-to-nose) in inches
export const TABLE_WIDTH = 50.0;   // Playing surface width (nose-to-nose) in inches
export const TABLE_ASPECT_RATIO = TABLE_LENGTH / TABLE_WIDTH; // Strict 2:1

export const BALL_DIAMETER = 2.25; // WPA standard 2.25 inches (57.15 mm)
export const BALL_RADIUS = BALL_DIAMETER / 2; // 1.125 inches
export const BALL_MASS = 0.156; // kg (5.5 oz)

// Gravity in inches/s^2 (9.80665 m/s^2 * 39.3700787 in/m)
export const GRAVITY = 386.08858;

// Cloth & Ball Physics Coefficients (Tournament Worsted Cloth + Phenolic Resin Balls)
export const MU_SLIDE = 0.20;           // Sliding (kinetic) friction coefficient on cloth
export const MU_ROLL = 0.012;           // Rolling resistance coefficient on cloth
export const MU_SPIN = 0.022;           // Vertical axis (z-spin / english) decay coefficient
export const BALL_RESTITUTION = 0.94;   // Ball-to-ball coefficient of restitution
export const BALL_FRICTION = 0.045;     // Ball-to-ball contact throw friction
export const CUSHION_RESTITUTION = 0.78;// Cushion rail coefficient of restitution
export const CUSHION_FRICTION = 0.14;   // Cushion tangential friction (running/reverse english)

// Cushion contact height above slate (WPA: 63.5% of ball diameter = 1.42875 in)
export const CUSHION_HEIGHT = 0.635 * BALL_DIAMETER;

// Simulation parameters
export const FIXED_DT = 1 / 240;        // 240 Hz fixed physics timestep
export const MAX_SHOT_SPEED = 310.0;    // Max break/shot cue ball speed in inches/s (~17.6 mph)
export const STOP_SPEED_THRESHOLD = 0.12; // Linear speed threshold to snap to rest (in/s)
export const STOP_SPIN_THRESHOLD = 0.25;  // Angular speed threshold to snap to rest (rad/s)

// WPA Table Markings (in inches from top-left cushion nose (0,0))
export const HEAD_STRING_X = TABLE_LENGTH * 0.25; // 25.0 in (Kitchen line)
export const CENTER_STRING_X = TABLE_LENGTH * 0.5; // 50.0 in
export const FOOT_STRING_X = TABLE_LENGTH * 0.75; // 75.0 in

export const HEAD_SPOT = { x: HEAD_STRING_X, y: TABLE_WIDTH * 0.5 } as const;   // (25, 25)
export const CENTER_SPOT = { x: CENTER_STRING_X, y: TABLE_WIDTH * 0.5 } as const; // (50, 25)
export const FOOT_SPOT = { x: FOOT_STRING_X, y: TABLE_WIDTH * 0.5 } as const;   // (75, 25)

// Visual rail & cushion dimensions (in inches)
export const CUSHION_THICKNESS = 2.0;   // Nose to featherstrip
export const RAIL_BORDER = 5.25;        // Total rail border around playing surface
export const DIAMOND_OFFSET = 3.6875;   // WPA 3-11/16 in from cushion nose to diamond center

// Pocket Geometry (WPA 9-ft Regulation)
// Corner mouth across diagonal = 4.625 in -> offset along each axis = 4.625 / sqrt(2) = 3.27 in
export const CORNER_JAW_OFFSET = 3.27;
// Side mouth along long rail = 5.10 in -> half-width = 2.55 in
export const SIDE_JAW_HALF_WIDTH = 2.55;

export const CORNER_POCKET_RADIUS = 2.35;
export const SIDE_POCKET_RADIUS = 2.30;

export interface PocketSpec {
  id: number;
  name: string;
  type: 'corner' | 'side';
  x: number;         // Drop center X
  y: number;         // Drop center Y
  radius: number;    // Drop capture radius (center of ball)
  renderX: number;   // Visual pocket hole center X
  renderY: number;   // Visual pocket hole center Y
  renderRadius: number;
}

export const POCKETS: readonly PocketSpec[] = [
  { id: 0, name: 'Top-Left',     type: 'corner', x: -0.95,  y: -0.95, renderX: -1.15,  renderY: -1.15, radius: CORNER_POCKET_RADIUS, renderRadius: 2.45 },
  { id: 1, name: 'Top-Side',     type: 'side',   x: 50.0,   y: -1.35, renderX: 50.0,   renderY: -1.65, radius: SIDE_POCKET_RADIUS,   renderRadius: 2.45 },
  { id: 2, name: 'Top-Right',    type: 'corner', x: 100.95, y: -0.95, renderX: 101.15, renderY: -1.15, radius: CORNER_POCKET_RADIUS, renderRadius: 2.45 },
  { id: 3, name: 'Bottom-Left',  type: 'corner', x: -0.95,  y: 50.95, renderX: -1.15,  renderY: 51.15, radius: CORNER_POCKET_RADIUS, renderRadius: 2.45 },
  { id: 4, name: 'Bottom-Side',  type: 'side',   x: 50.0,   y: 51.35, renderX: 50.0,   renderY: 51.65, radius: SIDE_POCKET_RADIUS,   renderRadius: 2.45 },
  { id: 5, name: 'Bottom-Right', type: 'corner', x: 100.95, y: 50.95, renderX: 101.15, renderY: 51.15, radius: CORNER_POCKET_RADIUS, renderRadius: 2.45 },
];

export interface CushionSegment {
  id: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  nx: number; // Unit inward normal X (pointing toward playing surface)
  ny: number; // Unit inward normal Y
  isJaw: boolean;
}

function makeSegment(id: string, ax: number, ay: number, bx: number, by: number, insideX: number, insideY: number, isJaw: boolean): CushionSegment {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  let nx = -dy / len;
  let ny = dx / len;
  // Ensure normal points toward (insideX, insideY)
  const midX = (ax + bx) * 0.5;
  const midY = (ay + by) * 0.5;
  if ((insideX - midX) * nx + (insideY - midY) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { id, ax, ay, bx, by, nx, ny, isJaw };
}

const C = CORNER_JAW_OFFSET;       // 3.27
const S1 = 50.0 - SIDE_JAW_HALF_WIDTH; // 47.45
const S2 = 50.0 + SIDE_JAW_HALF_WIDTH; // 52.55
const CD = 2.0; // Corner jaw depth into throat
// WPA corner jaw cut angle: 142 deg from rail (38 deg bevel). tan(38 deg) ≈ 0.78, so going 2.0 in into throat shifts by ~1.55 in along rail
const CJ = C - 1.55; // 1.72
// WPA side jaw cut angle: 104 deg from rail (14 deg bevel). Going 2.0 in into throat shifts by ~0.50 in
const SJ = 0.50;

export const CUSHION_SEGMENTS: readonly CushionSegment[] = [
  // 6 Main Cushion Noses
  makeSegment('top-left-rail',     C,  0,  S1, 0,  25, 25, false),
  makeSegment('top-right-rail',    S2, 0,  100 - C, 0, 75, 25, false),
  makeSegment('bottom-left-rail',  C,  50, S1, 50, 25, 25, false),
  makeSegment('bottom-right-rail', S2, 50, 100 - C, 50, 75, 25, false),
  makeSegment('left-rail',         0,  C,  0,  50 - C, 25, 25, false),
  makeSegment('right-rail',        100, C, 100, 50 - C, 75, 25, false),

  // 8 Corner Pocket Jaw Facings (142 deg WPA cut angle)
  // Orient normals toward each corner pocket mouth (0,0), (100,0), (0,50), (100,50)
  makeSegment('tl-jaw-top',    CJ, -CD, C, 0,   0, 0, true),
  makeSegment('tl-jaw-left',   -CD, CJ, 0, C,   0, 0, true),
  makeSegment('tr-jaw-top',    100 - C, 0, 100 - CJ, -CD, 100, 0, true),
  makeSegment('tr-jaw-right',  100, C, 100 + CD, CJ, 100, 0, true),
  makeSegment('bl-jaw-bottom', CJ, 50 + CD, C, 50, 0, 50, true),
  makeSegment('bl-jaw-left',   -CD, 50 - CJ, 0, 50 - C, 0, 50, true),
  makeSegment('br-jaw-bottom', 100 - C, 50, 100 - CJ, 50 + CD, 100, 50, true),
  makeSegment('br-jaw-right',  100, 50 - C, 100 + CD, 50 - CJ, 100, 50, true),

  // 4 Side Pocket Jaw Facings (104 deg WPA cut angle)
  // Orient normals toward each side pocket mouth (50, 0) and (50, 50)
  makeSegment('ts-jaw-left',   S1, 0, S1 + SJ, -CD, 50, 0, true),
  makeSegment('ts-jaw-right',  S2 - SJ, -CD, S2, 0, 50, 0, true),
  makeSegment('bs-jaw-left',   S1, 50, S1 + SJ, 50 + CD, 50, 50, true),
  makeSegment('bs-jaw-right',  S2 - SJ, 50 + CD, S2, 50, 50, 50, true),
];

// Knuckle vertices (where main rails meet pocket jaws) for exact point-collision rebound
export const JAW_KNUCKLES: readonly { x: number; y: number }[] = [
  { x: C, y: 0 },
  { x: S1, y: 0 },
  { x: S2, y: 0 },
  { x: 100 - C, y: 0 },
  { x: C, y: 50 },
  { x: S1, y: 50 },
  { x: S2, y: 50 },
  { x: 100 - C, y: 50 },
  { x: 0, y: C },
  { x: 0, y: 50 - C },
  { x: 100, y: C },
  { x: 100, y: 50 - C },
];

// Ball Colors & Metadata (Traditional WPA Tournament Palette)
export const BALL_COLORS: Record<number, string> = {
  0: '#F8F7F2',  // Cue ball (phenolic ivory white)
  1: '#F5B800',  // 1 Yellow
  2: '#1A56DB',  // 2 Blue
  3: '#E02424',  // 3 Red
  4: '#6B21A8',  // 4 Purple
  5: '#EA580C',  // 5 Orange
  6: '#15803D',  // 6 Green
  7: '#7F1D1D',  // 7 Maroon / Burgundy
  8: '#18181B',  // 8 Black
  9: '#F5B800',  // 9 Yellow Stripe
  10: '#1A56DB', // 10 Blue Stripe
  11: '#E02424', // 11 Red Stripe
  12: '#6B21A8', // 12 Purple Stripe
  13: '#EA580C', // 13 Orange Stripe
  14: '#15803D', // 14 Green Stripe
  15: '#7F1D1D', // 15 Maroon Stripe
};
