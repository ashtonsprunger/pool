import { AimPreview, CheatPreview, GameState, hasModifier } from '../game/rules';
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
import { BallState, INFINITE_POCKETS } from '../physics/engine';

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

  const isInfinite = hasModifier(state, 'infinite');

  if (isInfinite) {
    drawInfiniteTiledBoards(ctx, vp, state);
  } else {
    drawOuterRailsAndCushions(ctx);
    drawPlayingSurfaceAndMarkings(ctx, state);
    drawPockets(ctx, state);
  }

  // Draw Aim Preview or Cheat Mode Trajectories (below balls/cue so balls sit cleanly on top)
  if (input.showAim && state.winner === null) {
    if (cheatPreview) {
      drawCheatPreviewTrajectories(ctx, cheatPreview, state);
    } else if (aimPreview) {
      drawAimGuide(ctx, aimPreview, vp.isPortrait);
    }
  }

  // Draw Ball-in-Hand cue ball halo if active
  const cueBall = state.balls.find((b) => b.id === 0);
  if (state.ballInHand && cueBall && !cueBall.pocketed && state.winner === null) {
    drawBallInHandHalo(ctx, cueBall, input.isDraggingCueBall);
  }

  // In Infinite mode, first draw the faded mirrored balls on the 8 surrounding boards
  if (isInfinite) {
    ctx.save();
    ctx.beginPath();
    const bdr = vp.borderInches || RAIL_BORDER;
    ctx.rect(-bdr, -bdr, TABLE_LENGTH + bdr * 2, TABLE_WIDTH + bdr * 2);
    ctx.clip();
    ctx.globalAlpha = 0.36;
    for (let gx = -1; gx <= 1; gx++) {
      for (let gy = -1; gy <= 1; gy++) {
        if (gx === 0 && gy === 0) continue;
        const ox = gx * TABLE_LENGTH;
        const oy = gy * TABLE_WIDTH;
        for (const b of state.balls) {
          if (b.pocketed) continue;
          const bx = b.x + ox;
          const by = b.y + oy;
          if (
            bx < -bdr - BALL_RADIUS ||
            bx > TABLE_LENGTH + bdr + BALL_RADIUS ||
            by < -bdr - BALL_RADIUS ||
            by > TABLE_WIDTH + bdr + BALL_RADIUS
          ) {
            continue;
          }
          drawBall(ctx, { ...b, x: bx, y: by }, vp.isPortrait);
        }
      }
    }
    ctx.restore();
  }

  // Draw all non-pocketed balls at their current positions on the main board
  for (const b of state.balls) {
    if (!b.pocketed) {
      drawBall(ctx, b, vp.isPortrait);
    }
  }

  // In Infinite mode, if a ball is straddling a seam, also draw its wrapped portion inside [0..100, 0..50] at full opacity
  if (isInfinite) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, TABLE_LENGTH, TABLE_WIDTH);
    ctx.clip();
    for (const b of state.balls) {
      if (b.pocketed) continue;
      const nearX = b.x < BALL_RADIUS + 0.1 || b.x > TABLE_LENGTH - BALL_RADIUS - 0.1;
      const nearY = b.y < BALL_RADIUS + 0.1 || b.y > TABLE_WIDTH - BALL_RADIUS - 0.1;
      if (!nearX && !nearY) continue;
      for (let gx = -1; gx <= 1; gx++) {
        for (let gy = -1; gy <= 1; gy++) {
          if (gx === 0 && gy === 0) continue;
          const bx = b.x + gx * TABLE_LENGTH;
          const by = b.y + gy * TABLE_WIDTH;
          if (
            bx + BALL_RADIUS >= 0 &&
            bx - BALL_RADIUS <= TABLE_LENGTH &&
            by + BALL_RADIUS >= 0 &&
            by - BALL_RADIUS <= TABLE_WIDTH
          ) {
            drawBall(ctx, { ...b, x: bx, y: by }, vp.isPortrait);
          }
        }
      }
    }
    ctx.restore();
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

function drawInfiniteTiledBoards(
  ctx: CanvasRenderingContext2D,
  vp: TableViewport,
  state: GameState
): void {
  const bdr = vp.borderInches || RAIL_BORDER;
  const isPortals = hasModifier(state, 'portals');
  const isBlackHole = hasModifier(state, 'blackhole');

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(-bdr, -bdr, TABLE_LENGTH + bdr * 2, TABLE_WIDTH + bdr * 2, 2.2);
  ctx.clip();

  // 1. Background fill for surrounding neighbor boards (dimmed baize)
  ctx.fillStyle = '#073622';
  ctx.fillRect(-bdr, -bdr, TABLE_LENGTH + bdr * 2, TABLE_WIDTH + bdr * 2);

  const drawSpot = (sx: number, sy: number, alpha: number) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(sx, sy, 0.28, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx, sy, 0.1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fill();
    ctx.restore();
  };

  // 2. Draw markings on the 8 surrounding neighbor boards (slightly faded)
  for (let gx = -1; gx <= 1; gx++) {
    for (let gy = -1; gy <= 1; gy++) {
      if (gx === 0 && gy === 0) continue;
      const ox = gx * TABLE_LENGTH;
      const oy = gy * TABLE_WIDTH;

      // Subtle checkerboard shade difference on diagonal vs orthogonal neighbors
      ctx.fillStyle = (gx + gy) % 2 === 0 ? 'rgba(17, 107, 67, 0.32)' : 'rgba(11, 77, 48, 0.38)';
      ctx.fillRect(ox, oy, TABLE_LENGTH, TABLE_WIDTH);

      // Neighbor Head String line
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(ox + HEAD_STRING_X, oy);
      ctx.lineTo(ox + HEAD_STRING_X, oy + TABLE_WIDTH);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 0.11;
      ctx.stroke();
      ctx.restore();

      drawSpot(ox + HEAD_SPOT.x, oy + HEAD_SPOT.y, 0.35);
      drawSpot(ox + FOOT_SPOT.x, oy + FOOT_SPOT.y, 0.35);
    }
  }

  // 3. Draw main center board (0..100 x 0..50) at full brightness
  const clothGrad = ctx.createRadialGradient(50, 25, 4, 50, 25, 62);
  clothGrad.addColorStop(0, '#116B43');
  clothGrad.addColorStop(1, '#0B4D30');
  ctx.fillStyle = clothGrad;
  ctx.fillRect(0, 0, TABLE_LENGTH, TABLE_WIDTH);

  if (state.isBreakShot && state.ballInHand) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.045)';
    ctx.fillRect(0, 0, HEAD_STRING_X, TABLE_WIDTH);
  }

  // Black Hole + Infinite: draw gravitational field rings around the grid pockets
  if (isBlackHole) {
    ctx.save();
    for (const pk of INFINITE_POCKETS) {
      const wellGrad = ctx.createRadialGradient(pk.x, pk.y, 1.5, pk.x, pk.y, 15.5);
      wellGrad.addColorStop(0, 'rgba(168, 85, 247, 0.22)');
      wellGrad.addColorStop(0.45, 'rgba(99, 102, 241, 0.08)');
      wellGrad.addColorStop(1, 'rgba(99, 102, 241, 0)');
      ctx.fillStyle = wellGrad;
      ctx.beginPath();
      ctx.arc(pk.x, pk.y, 15.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(pk.x, pk.y, 6.0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(192, 132, 252, 0.28)';
      ctx.lineWidth = 0.11;
      ctx.setLineDash([0.4, 0.35]);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Main Head String line
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

  drawSpot(HEAD_SPOT.x, HEAD_SPOT.y, 1.0);
  drawSpot(FOOT_SPOT.x, FOOT_SPOT.y, 1.0);

  // 4. Draw dotted teleport boundary seams separating the main board from the attached neighbor boards
  ctx.save();
  ctx.strokeStyle = 'rgba(186, 230, 253, 0.62)';
  ctx.lineWidth = 0.18;
  ctx.setLineDash([0.75, 0.55]);

  // Vertical seams at x = 0 and x = 100
  for (const sx of [0, TABLE_LENGTH]) {
    ctx.beginPath();
    ctx.moveTo(sx, -bdr);
    ctx.lineTo(sx, TABLE_WIDTH + bdr);
    ctx.stroke();
  }
  // Horizontal seams at y = 0 and y = 50
  for (const sy of [0, TABLE_WIDTH]) {
    ctx.beginPath();
    ctx.moveTo(-bdr, sy);
    ctx.lineTo(TABLE_LENGTH + bdr, sy);
    ctx.stroke();
  }
  ctx.restore();

  // Subtle diamond sights along the dotted seam lines
  ctx.save();
  ctx.fillStyle = 'rgba(212, 175, 55, 0.55)';
  const dSize = 0.28;
  const drawSeamDiamond = (cx: number, cy: number) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy - dSize);
    ctx.lineTo(cx + dSize, cy);
    ctx.lineTo(cx, cy + dSize);
    ctx.lineTo(cx - dSize, cy);
    ctx.closePath();
    ctx.fill();
  };
  for (let i = 1; i <= 7; i++) {
    if (i === 4) continue;
    drawSeamDiamond(i * 12.5, 0);
    drawSeamDiamond(i * 12.5, TABLE_WIDTH);
  }
  for (let j = 1; j <= 3; j++) {
    drawSeamDiamond(0, j * 12.5);
    drawSeamDiamond(TABLE_LENGTH, j * 12.5);
  }
  ctx.restore();

  // 5. Draw pockets at the grid seam intersections
  for (const pk of INFINITE_POCKETS) {
    const isPortalPocket = isPortals && pk.type === 'side';

    ctx.beginPath();
    ctx.arc(pk.x, pk.y, pk.renderRadius + 0.28, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(pk.x, pk.y, pk.renderRadius, 0, Math.PI * 2);
    const pGrad = ctx.createRadialGradient(
      pk.x,
      pk.y,
      pk.renderRadius * 0.1,
      pk.x,
      pk.y,
      pk.renderRadius
    );
    if (isPortalPocket) {
      const isTopBlue = pk.id === 4;
      pGrad.addColorStop(0, isTopBlue ? '#E0F2FE' : '#FFEDD5');
      pGrad.addColorStop(0.45, isTopBlue ? '#0284C7' : '#EA580C');
      pGrad.addColorStop(0.85, isTopBlue ? '#0369A1' : '#9A3412');
      pGrad.addColorStop(1, '#090D16');
    } else if (isBlackHole) {
      pGrad.addColorStop(0, '#000000');
      pGrad.addColorStop(0.65, '#090414');
      pGrad.addColorStop(0.9, '#3B0764');
      pGrad.addColorStop(1, '#7E22CE');
    } else {
      pGrad.addColorStop(0, '#020408');
      pGrad.addColorStop(0.8, '#090D16');
      pGrad.addColorStop(1, '#1E293B');
    }
    ctx.fillStyle = pGrad;
    ctx.fill();

    if (isPortalPocket) {
      const isTopBlue = pk.id === 4;
      ctx.save();
      ctx.beginPath();
      ctx.arc(pk.x, pk.y, pk.renderRadius * 0.92, 0, Math.PI * 2);
      ctx.strokeStyle = isTopBlue ? '#38BDF8' : '#FB923C';
      ctx.lineWidth = 0.22;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(pk.x, pk.y, pk.renderRadius * 0.56, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.lineWidth = 0.11;
      ctx.setLineDash([0.35, 0.25]);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(pk.x, pk.y, pk.renderRadius, 0, Math.PI * 2);
      ctx.strokeStyle = isBlackHole ? 'rgba(192, 132, 252, 0.75)' : 'rgba(148, 163, 184, 0.38)';
      ctx.lineWidth = isBlackHole ? 0.16 : 0.12;
      ctx.stroke();
    }
  }

  // Outer frame border around the preview viewport
  ctx.beginPath();
  ctx.roundRect(-bdr, -bdr, TABLE_LENGTH + bdr * 2, TABLE_WIDTH + bdr * 2, 2.2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 0.22;
  ctx.stroke();

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

  // Pinball Rails Mode: draw glowing neon bumper strips along the 6 main cushion noses
  if (hasModifier(state, 'pinball')) {
    ctx.save();
    ctx.lineCap = 'round';
    const bumperSegments: [number, number, number, number][] = [
      [C, 0, S1, 0],
      [S2, 0, 100 - C, 0],
      [C, 50, S1, 50],
      [S2, 50, 100 - C, 50],
      [0, C, 0, 50 - C],
      [100, C, 100, 50 - C],
    ];
    for (const [ax, ay, bx, by] of bumperSegments) {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.strokeStyle = 'rgba(244, 63, 94, 0.38)';
      ctx.lineWidth = 0.55;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.strokeStyle = '#FB7185';
      ctx.lineWidth = 0.18;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Black Hole Mode: draw subtle gravitational field rings clipped to the playing surface
  if (hasModifier(state, 'blackhole')) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, TABLE_LENGTH, TABLE_WIDTH);
    ctx.clip();

    for (const p of POCKETS) {
      // Soft violet gravity well gradient
      const wellGrad = ctx.createRadialGradient(p.x, p.y, 1.5, p.x, p.y, 15.5);
      wellGrad.addColorStop(0, 'rgba(168, 85, 247, 0.22)');
      wellGrad.addColorStop(0.45, 'rgba(99, 102, 241, 0.08)');
      wellGrad.addColorStop(1, 'rgba(99, 102, 241, 0)');
      ctx.fillStyle = wellGrad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 15.5, 0, Math.PI * 2);
      ctx.fill();

      // Event horizon indicator ring (6.0 in)
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6.0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(192, 132, 252, 0.28)';
      ctx.lineWidth = 0.11;
      ctx.setLineDash([0.4, 0.35]);
      ctx.stroke();
    }
    ctx.restore();
  }

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

function drawPockets(ctx: CanvasRenderingContext2D, state: GameState): void {
  const isPortals = hasModifier(state, 'portals');
  const isBlackHole = hasModifier(state, 'blackhole');

  for (const p of POCKETS) {
    const isPortalPocket = isPortals && p.type === 'side';

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
    if (isPortalPocket) {
      const isTopBlue = p.id === 1;
      pGrad.addColorStop(0, isTopBlue ? '#E0F2FE' : '#FFEDD5');
      pGrad.addColorStop(0.45, isTopBlue ? '#0284C7' : '#EA580C');
      pGrad.addColorStop(0.85, isTopBlue ? '#0369A1' : '#9A3412');
      pGrad.addColorStop(1, '#090D16');
    } else if (isBlackHole) {
      pGrad.addColorStop(0, '#000000');
      pGrad.addColorStop(0.65, '#090414');
      pGrad.addColorStop(0.9, '#3B0764');
      pGrad.addColorStop(1, '#7E22CE');
    } else {
      pGrad.addColorStop(0, '#040506');
      pGrad.addColorStop(0.8, '#090B0E');
      pGrad.addColorStop(1, '#16191E');
    }
    ctx.fillStyle = pGrad;
    ctx.fill();

    if (isPortalPocket) {
      const isTopBlue = p.id === 1;
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.renderX, p.renderY, p.renderRadius * 0.92, 0, Math.PI * 2);
      ctx.strokeStyle = isTopBlue ? '#38BDF8' : '#FB923C';
      ctx.lineWidth = 0.24;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(p.renderX, p.renderY, p.renderRadius * 0.56, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.lineWidth = 0.12;
      ctx.setLineDash([0.35, 0.25]);
      ctx.stroke();
      ctx.restore();
    } else if (isBlackHole) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.renderX, p.renderY, p.renderRadius * 0.94, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(192, 132, 252, 0.75)';
      ctx.lineWidth = 0.18;
      ctx.stroke();
      ctx.restore();
    }
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
  cheatPreview: CheatPreview,
  state?: GameState
): void {
  ctx.save();
  const isInfinite = state ? hasModifier(state, 'infinite') : false;

  for (const eb of cheatPreview.endBalls) {
    if (!eb.moved || eb.path.length < 2) continue;

    const isCue = eb.id === 0;
    const isCueFoul = isCue && (eb.pocketedThisShot || cheatPreview.isFoul);
    const baseColor = BALL_COLORS[eb.id] || '#FFFFFF';

    ctx.beginPath();
    ctx.moveTo(eb.path[0].x, eb.path[0].y);
    for (let i = 1; i < eb.path.length; i++) {
      const prev = eb.path[i - 1];
      const cur = eb.path[i];
      if (Math.hypot(cur.x - prev.x, cur.y - prev.y) > 15) {
        ctx.moveTo(cur.x, cur.y);
      } else {
        ctx.lineTo(cur.x, cur.y);
      }
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
    if (eb.pocketedThisShot && eb.pocketId !== null) {
      const infPk = isInfinite ? INFINITE_POCKETS[eb.pocketId] : null;
      const stdPk = !isInfinite ? POCKETS[eb.pocketId] : null;
      const rx = infPk ? infPk.x : stdPk ? stdPk.renderX : null;
      const ry = infPk ? infPk.y : stdPk ? stdPk.renderY : null;
      const rr = infPk ? infPk.renderRadius : stdPk ? stdPk.renderRadius : null;
      if (rx !== null && ry !== null && rr !== null) {
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(rx, ry, rr * 0.92, 0, Math.PI * 2);
        const isBadPocket = eb.id === 0 || (eb.id === 8 && cheatPreview.isFoul);
        ctx.strokeStyle = isBadPocket ? '#F87171' : '#4ADE80';
        ctx.lineWidth = 0.22;
        ctx.stroke();
      }
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
