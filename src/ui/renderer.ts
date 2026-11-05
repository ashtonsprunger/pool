import { AimPreview, CheatPreview, GameState } from '../game/rules';
import { TableViewport, tableToScreen } from '../game/viewport';
import {
  BALL_COLORS,
  BALL_RADIUS,
  CORNER_JAW_OFFSET,
  CUSHION_THICKNESS,
  DIAMOND_OFFSET,
  FOOT_SPOT,
  HEAD_SPOT,
  HEAD_STRING_X,
  POCKETS,
  RAIL_BORDER,
  SIDE_JAW_HALF_WIDTH,
  TABLE_LENGTH,
  TABLE_WIDTH,
} from '../physics/constants';
import { BallState } from '../physics/engine';

export interface RenderInputState {
  aimAngle: number;
  shotPower: number;    // 0..1
  pullBackAmount: number; // 0..1 active pull-back visual
  spinX: number;
  spinY: number;
  showAim: boolean;
  isDraggingCueBall: boolean;
}

function rotatePointByQuat(
  vx: number,
  vy: number,
  vz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number
): { x: number; y: number; z: number } {
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // v' = v + qw * t + cross(q.xyz, t)
  return {
    x: vx + qw * tx + (qy * tz - qz * ty),
    y: vy + qw * ty + (qz * tx - qx * tz),
    z: vz + qw * tz + (qx * ty - qy * tx),
  };
}

export function renderPoolTable(
  ctx: CanvasRenderingContext2D,
  vp: TableViewport,
  state: GameState,
  input: RenderInputState,
  aimPreview: AimPreview | null,
  cheatPreview: CheatPreview | null = null
): void {
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(dpr, dpr);

  // Clear full canvas
  ctx.clearRect(0, 0, vp.widthCss, vp.heightCss);

  // Apply coordinate transform so we can draw directly in canonical Table Inches (0..100, 0..50)!
  ctx.save();
  if (!vp.isPortrait) {
    ctx.translate(vp.originX, vp.originY);
    ctx.scale(vp.scale, vp.scale);
  } else {
    // 90 deg CCW rotation: screenX = originX + ty * scale, screenY = originY - tx * scale
    ctx.translate(vp.originX, vp.originY);
    ctx.rotate(-Math.PI / 2);
    ctx.scale(vp.scale, vp.scale);
  }

  drawOuterRailsAndCushions(ctx);
  drawPlayingSurfaceAndMarkings(ctx, state);
  drawPockets(ctx);

  // Draw Aim Preview or Cheat Mode Trajectories (below balls/cue so balls sit cleanly on top)
  if (input.showAim && state.winner === null) {
    if (cheatPreview) {
      drawCheatPreviewTrajectories(ctx, cheatPreview);
    } else if (aimPreview) {
      drawAimGuide(ctx, aimPreview, vp.isPortrait);
    }
  }

  // Draw Ball-in-Hand cue ball halo if active
  const cueBall = state.balls.find((b) => b.id === 0);
  if (state.ballInHand && cueBall && !cueBall.pocketed && state.winner === null) {
    drawBallInHandHalo(ctx, cueBall, input.isDraggingCueBall);
  }

  // Draw all non-pocketed balls at their current positions
  for (const b of state.balls) {
    if (!b.pocketed) {
      drawBall(ctx, b, vp.isPortrait);
    }
  }

  // Draw Cheat Mode End-State Ghost Balls
  if (input.showAim && cheatPreview && state.winner === null) {
    drawCheatPreviewEndBalls(ctx, cheatPreview, vp.isPortrait);
  }

  // Draw Cue Stick when aiming
  if (input.showAim && cueBall && !cueBall.pocketed && state.winner === null && !input.isDraggingCueBall) {
    drawCueStick(ctx, cueBall, input.aimAngle, input.pullBackAmount || input.shotPower);
  }

  ctx.restore();
  ctx.restore();
}

function drawOuterRailsAndCushions(ctx: CanvasRenderingContext2D): void {
  const rb = RAIL_BORDER;
  const ct = CUSHION_THICKNESS;

  // Outer hardwood cabinet with rounded corners
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(-rb, -rb, TABLE_LENGTH + rb * 2, TABLE_WIDTH + rb * 2, 2.8);
  const railGrad = ctx.createLinearGradient(-rb, -rb, TABLE_LENGTH + rb, TABLE_WIDTH + rb);
  railGrad.addColorStop(0, '#321D13');
  railGrad.addColorStop(0.5, '#24140D');
  railGrad.addColorStop(1, '#180D08');
  ctx.fillStyle = railGrad;
  ctx.fill();

  // Subtle metallic outer trim border
  ctx.lineWidth = 0.18;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.stroke();

  // Inner cushion liner recess (-ct to TABLE + ct)
  ctx.fillStyle = '#073521';
  ctx.fillRect(-ct, -ct, TABLE_LENGTH + ct * 2, TABLE_WIDTH + ct * 2);

  // Draw 18 WPA Diamond Sights on the rails
  ctx.fillStyle = '#D4AF37'; // Warm mother-of-pearl / brass diamond inlay
  const diamondSize = 0.36;
  const drawDiamond = (cx: number, cy: number) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy - diamondSize);
    ctx.lineTo(cx + diamondSize, cy);
    ctx.lineTo(cx, cy + diamondSize);
    ctx.lineTo(cx - diamondSize, cy);
    ctx.closePath();
    ctx.fill();
  };

  // Top & Bottom rail diamonds (at x = 12.5, 25, 37.5, 62.5, 75, 87.5; 50 is side pocket)
  for (let i = 1; i <= 7; i++) {
    if (i === 4) continue;
    const dx = i * 12.5;
    drawDiamond(dx, -DIAMOND_OFFSET);
    drawDiamond(dx, TABLE_WIDTH + DIAMOND_OFFSET);
  }

  // Left (Head) & Right (Foot) rail diamonds (at y = 12.5, 25, 37.5)
  for (let j = 1; j <= 3; j++) {
    const dy = j * 12.5;
    drawDiamond(-DIAMOND_OFFSET, dy);
    drawDiamond(TABLE_LENGTH + DIAMOND_OFFSET, dy);
  }

  ctx.restore();
}

function drawPlayingSurfaceAndMarkings(ctx: CanvasRenderingContext2D, state: GameState): void {
  const ct = CUSHION_THICKNESS;

  // Main slate baize cloth
  const clothGrad = ctx.createRadialGradient(50, 25, 4, 50, 25, 62);
  clothGrad.addColorStop(0, '#116B43');
  clothGrad.addColorStop(1, '#0B4D30');
  ctx.fillStyle = clothGrad;
  ctx.fillRect(-ct, -ct, TABLE_LENGTH + ct * 2, TABLE_WIDTH + ct * 2);

  // Highlight Kitchen area lightly during Break Shot Ball-in-Hand
  if (state.isBreakShot && state.ballInHand) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.045)';
    ctx.fillRect(0, 0, HEAD_STRING_X, TABLE_WIDTH);
  }

  // Draw the 6 bevelled K-66 rubber cushions
  const C = CORNER_JAW_OFFSET;       // 3.27
  const S1 = 50.0 - SIDE_JAW_HALF_WIDTH; // 47.45
  const S2 = 50.0 + SIDE_JAW_HALF_WIDTH; // 52.55
  const CJ = C - 1.55; // 1.72
  const SJ = 0.50;

  ctx.fillStyle = '#0A442A';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.lineWidth = 0.1;

  const drawCushionPoly = (pts: [number, number][]) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i][0], pts[i][1]);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  };

  // Top-left cushion
  drawCushionPoly([[CJ, -ct], [S1 + SJ, -ct], [S1, 0], [C, 0]]);
  // Top-right cushion
  drawCushionPoly([[S2 - SJ, -ct], [100 - CJ, -ct], [100 - C, 0], [S2, 0]]);
  // Bottom-left cushion
  drawCushionPoly([[C, 50], [S1, 50], [S1 + SJ, 50 + ct], [CJ, 50 + ct]]);
  // Bottom-right cushion
  drawCushionPoly([[S2, 50], [100 - C, 50], [100 - CJ, 50 + ct], [S2 - SJ, 50 + ct]]);
  // Left head cushion
  drawCushionPoly([[-ct, CJ], [0, C], [0, 50 - C], [-ct, 50 - CJ]]);
  // Right foot cushion
  drawCushionPoly([[100, C], [100 + ct, CJ], [100 + ct, 50 - CJ], [100, 50 - C]]);

  // Head String line (x = 25.0)
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(HEAD_STRING_X, 0);
  ctx.lineTo(HEAD_STRING_X, TABLE_WIDTH);
  ctx.strokeStyle =
    state.isBreakShot && state.ballInHand
      ? 'rgba(255, 255, 255, 0.32)'
      : 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 0.12;
  if (state.isBreakShot && state.ballInHand) {
    ctx.setLineDash([0.6, 0.4]);
  }
  ctx.stroke();
  ctx.restore();

  // Foot Spot (75, 25) and Head Spot (25, 25)
  const drawSpot = (sx: number, sy: number) => {
    ctx.beginPath();
    ctx.arc(sx, sy, 0.28, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx, sy, 0.1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fill();
  };
  drawSpot(HEAD_SPOT.x, HEAD_SPOT.y);
  drawSpot(FOOT_SPOT.x, FOOT_SPOT.y);
}

function drawPockets(ctx: CanvasRenderingContext2D): void {
  for (const p of POCKETS) {
    // Outer dark leather/rubber pocket rim
    ctx.beginPath();
    ctx.arc(p.renderX, p.renderY, p.renderRadius + 0.35, 0, Math.PI * 2);
    ctx.fillStyle = '#141416';
    ctx.fill();

    // Pocket drop hole with depth gradient
    ctx.beginPath();
    ctx.arc(p.renderX, p.renderY, p.renderRadius, 0, Math.PI * 2);
    const pGrad = ctx.createRadialGradient(
      p.renderX,
      p.renderY,
      p.renderRadius * 0.1,
      p.renderX,
      p.renderY,
      p.renderRadius
    );
    pGrad.addColorStop(0, '#040506');
    pGrad.addColorStop(0.8, '#090B0E');
    pGrad.addColorStop(1, '#16191E');
    ctx.fillStyle = pGrad;
    ctx.fill();
  }
}

function drawBallInHandHalo(
  ctx: CanvasRenderingContext2D,
  cueBall: BallState,
  isDragging: boolean
): void {
  ctx.save();
  const r = BALL_RADIUS * (isDragging ? 1.55 : 1.42);
  ctx.beginPath();
  ctx.arc(cueBall.x, cueBall.y, r, 0, Math.PI * 2);
  ctx.fillStyle = isDragging ? 'rgba(56, 189, 248, 0.22)' : 'rgba(255, 255, 255, 0.15)';
  ctx.fill();
  ctx.lineWidth = 0.14;
  ctx.strokeStyle = isDragging ? '#38BDF8' : 'rgba(255, 255, 255, 0.65)';
  ctx.setLineDash([0.35, 0.25]);
  ctx.stroke();
  ctx.restore();
}

const CUE_BALL_DOTS: readonly [number, number, number][] = [
  [0, 0, 1],
  [0, 0, -1],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
];

function drawBall(ctx: CanvasRenderingContext2D, b: BallState, isPortrait: boolean): void {
  const R = BALL_RADIUS;

  ctx.save();
  ctx.translate(b.x, b.y);

  // 1. Soft drop shadow on cloth
  ctx.beginPath();
  ctx.arc(0.14, 0.18, R * 0.98, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.36)';
  ctx.fill();

  // 2. Clip to sphere circle
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.clip();

  const isStripe = b.id >= 9 && b.id <= 15;
  const baseColor = BALL_COLORS[b.id] || '#FFFFFF';

  if (b.id === 0) {
    // Cue ball ivory base
    ctx.fillStyle = '#F8F7F2';
    ctx.fillRect(-R, -R, R * 2, R * 2);

    // Draw 6 red Aramith pro-cup measles dots rotated by quaternion so player sees spin!
    ctx.fillStyle = '#DC2626';
    for (const [dx, dy, dz] of CUE_BALL_DOTS) {
      const rot = rotatePointByQuat(dx, dy, dz, b.qx, b.qy, b.qz, b.qw);
      if (rot.z > 0.15) {
        const px = rot.x * R * 0.82;
        const py = rot.y * R * 0.82;
        const scale = Math.max(0.25, rot.z);
        ctx.beginPath();
        ctx.arc(px, py, R * 0.14 * scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (!isStripe) {
    // Solid ball (1..8)
    ctx.fillStyle = baseColor;
    ctx.fillRect(-R, -R, R * 2, R * 2);
  } else {
    // Stripe ball (9..15): ivory base + colored band
    ctx.fillStyle = '#F8F7F2';
    ctx.fillRect(-R, -R, R * 2, R * 2);

    const pole = rotatePointByQuat(0, 0, 1, b.qx, b.qy, b.qz, b.qw);
    const bandAngle = Math.atan2(pole.y, pole.x);
    ctx.save();
    ctx.rotate(bandAngle);
    ctx.fillStyle = baseColor;
    ctx.fillRect(-R * 1.1, -R * 0.56, R * 2.2, R * 1.12);
    ctx.restore();
  }

  // 3. Number badge on object balls (1..15)
  if (b.id > 0) {
    const badgePos = rotatePointByQuat(0, 0, 1, b.qx, b.qy, b.qz, b.qw);
    // Keep number visible on top hemisphere (reflect if pointing down)
    const sign = badgePos.z >= 0 ? 1 : -1;
    const bx = badgePos.x * sign * R * 0.52;
    const by = badgePos.y * sign * R * 0.52;

    ctx.save();
    ctx.translate(bx, by);
    if (isPortrait) {
      // Counter-rotate text so ball numbers read upright in portrait mode too
      ctx.rotate(Math.PI / 2);
    }

    ctx.beginPath();
    ctx.arc(0, 0, R * 0.44, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.fill();

    ctx.fillStyle = '#0F172A';
    ctx.font = `700 ${R * 0.52}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(b.id), 0, 0.03);
    ctx.restore();
  }

  // 4. 3D Spherical shading + overhead specular highlight
  const shadeGrad = ctx.createRadialGradient(-R * 0.32, -R * 0.32, R * 0.08, 0, 0, R);
  shadeGrad.addColorStop(0, 'rgba(255, 255, 255, 0.38)');
  shadeGrad.addColorStop(0.28, 'rgba(255, 255, 255, 0.05)');
  shadeGrad.addColorStop(0.75, 'rgba(0, 0, 0, 0.08)');
  shadeGrad.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
  ctx.fillStyle = shadeGrad;
  ctx.fillRect(-R, -R, R * 2, R * 2);

  ctx.restore();
}

function drawAimGuide(
  ctx: CanvasRenderingContext2D,
  preview: AimPreview,
  _isPortrait: boolean
): void {
  ctx.save();

  const lineColor = preview.isLegalTarget
    ? 'rgba(255, 255, 255, 0.65)'
    : 'rgba(248, 113, 113, 0.85)';

  // Main aim ray from cue ball to ghost ball
  ctx.beginPath();
  ctx.moveTo(preview.cueX, preview.cueY);
  ctx.lineTo(preview.ghostX, preview.ghostY);
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 0.13;
  ctx.setLineDash([0.5, 0.35]);
  ctx.stroke();

  // Ghost ball circle
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(preview.ghostX, preview.ghostY, BALL_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = preview.isLegalTarget
    ? 'rgba(255, 255, 255, 0.8)'
    : 'rgba(248, 113, 113, 0.95)';
  ctx.lineWidth = 0.14;
  ctx.stroke();
  ctx.fillStyle = preview.isLegalTarget
    ? 'rgba(255, 255, 255, 0.12)'
    : 'rgba(248, 113, 113, 0.18)';
  ctx.fill();

  // Object ball path & cue ball tangent line on legal contact
  if (preview.hitBall) {
    // Object ball post-impact line
    ctx.beginPath();
    ctx.moveTo(preview.hitBall.x, preview.hitBall.y);
    ctx.lineTo(
      preview.hitBall.x + preview.targetDirX * 8.5,
      preview.hitBall.y + preview.targetDirY * 8.5
    );
    ctx.strokeStyle = preview.isLegalTarget
      ? 'rgba(56, 189, 248, 0.85)'
      : 'rgba(248, 113, 113, 0.8)';
    ctx.lineWidth = 0.16;
    ctx.stroke();

    // Cue ball tangent deflection line
    ctx.beginPath();
    ctx.moveTo(preview.ghostX, preview.ghostY);
    ctx.lineTo(
      preview.ghostX + preview.tangentDirX * 4.5,
      preview.ghostY + preview.tangentDirY * 4.5
    );
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.lineWidth = 0.11;
    ctx.stroke();
  }

  ctx.restore();
}

function drawCheatPreviewTrajectories(
  ctx: CanvasRenderingContext2D,
  cheatPreview: CheatPreview
): void {
  ctx.save();

  for (const eb of cheatPreview.endBalls) {
    if (!eb.moved || eb.path.length < 2) continue;

    const isCue = eb.id === 0;
    const isCueFoul = isCue && (eb.pocketedThisShot || cheatPreview.isFoul);
    const baseColor = BALL_COLORS[eb.id] || '#FFFFFF';

    ctx.beginPath();
    ctx.moveTo(eb.path[0].x, eb.path[0].y);
    for (let i = 1; i < eb.path.length; i++) {
      ctx.lineTo(eb.path[i].x, eb.path[i].y);
    }

    ctx.strokeStyle = isCueFoul
      ? 'rgba(248, 113, 113, 0.82)'
      : isCue
      ? 'rgba(255, 255, 255, 0.65)'
      : `${baseColor}BB`;
    ctx.lineWidth = isCue ? 0.14 : 0.12;
    ctx.setLineDash(isCue ? [0.45, 0.3] : [0.35, 0.28]);
    ctx.stroke();

    // Highlight pocket ring if pocketed on this shot
    if (eb.pocketedThisShot && eb.pocketId !== null && POCKETS[eb.pocketId]) {
      const pk = POCKETS[eb.pocketId];
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(pk.renderX, pk.renderY, pk.renderRadius * 0.92, 0, Math.PI * 2);
      const isBadPocket = eb.id === 0 || (eb.id === 8 && cheatPreview.isFoul);
      ctx.strokeStyle = isBadPocket ? '#F87171' : '#4ADE80';
      ctx.lineWidth = 0.22;
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawCheatPreviewEndBalls(
  ctx: CanvasRenderingContext2D,
  cheatPreview: CheatPreview,
  isPortrait: boolean
): void {
  ctx.save();

  for (const eb of cheatPreview.endBalls) {
    if (!eb.moved) continue;

    ctx.save();
    ctx.globalAlpha = eb.pocketedThisShot ? 0.82 : 0.68;
    drawBall(ctx, eb.ballState, isPortrait);
    ctx.restore();

    // Crisp outline ring around the predicted final resting position
    ctx.save();
    ctx.beginPath();
    ctx.arc(eb.endX, eb.endY, BALL_RADIUS + 0.1, 0, Math.PI * 2);
    const isCueFoul = eb.id === 0 && (eb.pocketedThisShot || cheatPreview.isFoul);
    ctx.strokeStyle = isCueFoul
      ? '#F87171'
      : eb.pocketedThisShot
      ? '#4ADE80'
      : eb.id === 0
      ? '#38BDF8'
      : 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 0.14;
    ctx.setLineDash([0.32, 0.22]);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

function drawCueStick(
  ctx: CanvasRenderingContext2D,
  cueBall: BallState,
  aimAngle: number,
  power: number
): void {
  ctx.save();
  ctx.translate(cueBall.x, cueBall.y);
  ctx.rotate(aimAngle + Math.PI); // Point behind the cue ball

  const tipOffset = BALL_RADIUS + 0.45 + power * 6.5;
  const cueLength = 28.0;
  const tipHalfWidth = 0.16;
  const buttHalfWidth = 0.38;

  // Cue shadow
  ctx.beginPath();
  ctx.moveTo(tipOffset, -tipHalfWidth + 0.2);
  ctx.lineTo(tipOffset + cueLength, -buttHalfWidth + 0.2);
  ctx.lineTo(tipOffset + cueLength, buttHalfWidth + 0.2);
  ctx.lineTo(tipOffset, tipHalfWidth + 0.2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fill();

  // Maple shaft
  ctx.beginPath();
  ctx.moveTo(tipOffset, -tipHalfWidth);
  ctx.lineTo(tipOffset + cueLength * 0.55, -0.27);
  ctx.lineTo(tipOffset + cueLength * 0.55, 0.27);
  ctx.lineTo(tipOffset, tipHalfWidth);
  ctx.closePath();
  ctx.fillStyle = '#F5DEB3';
  ctx.fill();

  // Ebony / Rosewood butt
  ctx.beginPath();
  ctx.moveTo(tipOffset + cueLength * 0.55, -0.27);
  ctx.lineTo(tipOffset + cueLength, -buttHalfWidth);
  ctx.lineTo(tipOffset + cueLength, buttHalfWidth);
  ctx.lineTo(tipOffset + cueLength * 0.55, 0.27);
  ctx.closePath();
  ctx.fillStyle = '#1E293B';
  ctx.fill();

  // White ferrule & blue chalk tip
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(tipOffset, -tipHalfWidth, 0.4, tipHalfWidth * 2);
  ctx.fillStyle = '#0284C7';
  ctx.fillRect(tipOffset - 0.18, -tipHalfWidth, 0.18, tipHalfWidth * 2);

  ctx.restore();
}

export { tableToScreen };
