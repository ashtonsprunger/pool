import { RAIL_BORDER, TABLE_LENGTH, TABLE_WIDTH } from '../physics/constants';
import { Vec2 } from '../physics/vector';

export interface TableViewport {
  widthCss: number;     // Total canvas CSS width in pixels
  heightCss: number;    // Total canvas CSS height in pixels
  scale: number;        // CSS pixels per table inch
  isPortrait: boolean;  // True when rotated 90 deg CCW for portrait screens
  originX: number;      // Screen CSS X of table (0, 0)
  originY: number;      // Screen CSS Y of table (0, 0)
  borderInches: number; // Border margin around (0..100, 0..50) in table inches
}

export const TOTAL_OUTER_LENGTH = TABLE_LENGTH + RAIL_BORDER * 2; // 110.5 in
export const TOTAL_OUTER_WIDTH = TABLE_WIDTH + RAIL_BORDER * 2;   // 60.5 in
export const INFINITE_PREVIEW_BORDER = 14.0; // 14 in preview of adjacent mirrored tables

/**
 * Computes the optimal responsive viewport for a given container size (in CSS pixels).
 * Automatically rotates the table 90 degrees CCW in portrait orientation so the table
 * fills mobile phone screens with the break kitchen at the bottom and rack at the top.
 */
export function computeTableViewport(
  availWidth: number,
  availHeight: number,
  cuePullbackMarginInches: number = 3.5,
  borderInches: number = RAIL_BORDER
): TableViewport {
  const safeW = Math.max(200, availWidth);
  const safeH = Math.max(200, availHeight);

  const isPortrait = safeH > safeW * 1.08;

  const outerLength = TABLE_LENGTH + borderInches * 2;
  const outerWidth = TABLE_WIDTH + borderInches * 2;
  const spanLong = outerLength + cuePullbackMarginInches * 2;
  const spanShort = outerWidth + cuePullbackMarginInches * 2;

  if (!isPortrait) {
    const scale = Math.min(safeW / spanLong, safeH / spanShort);
    const widthCss = Math.round(outerLength * scale);
    const heightCss = Math.round(outerWidth * scale);
    const originX = borderInches * scale;
    const originY = borderInches * scale;
    return {
      widthCss,
      heightCss,
      scale,
      isPortrait: false,
      originX,
      originY,
      borderInches,
    };
  } else {
    const scale = Math.min(safeW / spanShort, safeH / spanLong);
    const widthCss = Math.round(outerWidth * scale);
    const heightCss = Math.round(outerLength * scale);
    // In 90 deg CCW rotation:
    // Table (0, 0) is at bottom-left of playing surface: sx = borderInches * scale, sy = (borderInches + TABLE_LENGTH) * scale
    const originX = borderInches * scale;
    const originY = (borderInches + TABLE_LENGTH) * scale;
    return {
      widthCss,
      heightCss,
      scale,
      isPortrait: true,
      originX,
      originY,
      borderInches,
    };
  }
}

/**
 * Converts canonical table coordinates (in inches) to canvas CSS pixel coordinates.
 */
export function tableToScreen(vp: TableViewport, tx: number, ty: number): Vec2 {
  if (!vp.isPortrait) {
    return {
      x: vp.originX + tx * vp.scale,
      y: vp.originY + ty * vp.scale,
    };
  } else {
    return {
      x: vp.originX + ty * vp.scale,
      y: vp.originY - tx * vp.scale,
    };
  }
}

/**
 * Converts canvas CSS pixel coordinates back to canonical table coordinates (in inches).
 */
export function screenToTable(vp: TableViewport, sx: number, sy: number): Vec2 {
  if (!vp.isPortrait) {
    return {
      x: (sx - vp.originX) / vp.scale,
      y: (sy - vp.originY) / vp.scale,
    };
  } else {
    return {
      x: (vp.originY - sy) / vp.scale,
      y: (sx - vp.originX) / vp.scale,
    };
  }
}
