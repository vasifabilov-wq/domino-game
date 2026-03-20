/**
 * tokens.js — Single source of truth for ALL visual game constants.
 *
 * RULE: No other file may hardcode tile dimensions, gaps, or colors.
 *
 * ARCHITECTURE:
 *   1. JS calls Tokens.forBoard(boardW) to get layout constants.
 *   2. This module writes matching CSS custom properties so CSS and JS
 *      always agree — no !important wars, no out-of-sync breakpoints.
 *   3. BoardLayout.js reads from Tokens only, never from the DOM.
 */
(function (global) {
  'use strict';

  // ── Tile size table (mobile-first, driven by available board width) ─────────
  // TW = long side of a horizontal tile
  // TH = short side  (always TW / 2 so doubles are perfectly square)
  function getTileSize(boardW) {
    if (boardW <= 260) return { TW: 38, TH: 19 };
    if (boardW <= 320) return { TW: 42, TH: 21 };
    if (boardW <= 420) return { TW: 46, TH: 23 };
    if (boardW <= 560) return { TW: 50, TH: 25 };
    if (boardW <= 720) return { TW: 54, TH: 27 };
    return               { TW: 62, TH: 31 };
  }

  // ── Spacing constants ───────────────────────────────────────────────────────
  const SPACING = {
    GAP:  2,   // px between tiles along the chain (nearly touching)
    MX:   12,  // horizontal margin from board edge
    DZ_W: 44,  // drop-zone width
    DZ_H: 40,  // drop-zone height
    // LANE_GAP is derived from TH in forBoard() — must equal TH/2 so the
    // corner tile's bottom face aligns with the top face of the next row.
  };

  // ── Push constants to CSS so CSS vars always match JS ──────────────────────
  function _applyCSS(TW, TH) {
    const s = document.documentElement.style;
    s.setProperty('--tile-w',   TW + 'px');
    s.setProperty('--tile-h',   TH + 'px');
    s.setProperty('--tile-gap', SPACING.GAP + 'px');
    s.setProperty('--dz-w',     SPACING.DZ_W + 'px');
    s.setProperty('--dz-h',     SPACING.DZ_H + 'px');
  }

  /**
   * Returns a complete set of layout constants for a given board width.
   * Also writes matching CSS custom properties as a side effect.
   *
   * @param  {number} boardW  Available board width in px
   * @returns {{ TW, TH, GAP, MX, SLOT, ROW_H, DZ_W, DZ_H }}
   */
  function forBoard(boardW) {
    const { TW, TH } = getTileSize(boardW);
    _applyCSS(TW, TH);
    const { GAP, MX, DZ_W, DZ_H } = SPACING;
    // LANE_GAP = TH/2 means: corner tile bottom (cy + TH) exactly meets
    // the next row's first tile top (new_cy - TH/2), i.e. ROW_H = 3*TH/2.
    const LANE_GAP = Math.ceil(TH / 2);
    return {
      TW,
      TH,
      GAP,
      MX,
      DZ_W,
      DZ_H,
      LANE_GAP,
      SLOT:  TW + GAP,       // path advance per tile slot
      ROW_H: TH + LANE_GAP,  // vertical step between snake row centres (≈ 3*TH/2)
    };
  }

  global.Tokens = { getTileSize, forBoard, SPACING };

})(window);
