/**
 * tokens.js — Single source of truth for ALL visual game constants.
 *
 * DESIGN CONTRACT:
 *   • Tile geometry: TH = TW / 2  (each pip-square is TH × TH)
 *   • GAP = 0  → tiles touch face-to-face (correct domino semantics)
 *   • SLOT = TW  → cursor advances exactly one tile-width per horizontal slot
 *   • ROW_H = TW  → = 2×TH, gives TH/2 (≈11–15 px) visible gap between rows
 *       so non-connected tiles in the same column never visually touch.
 *       (The previous ceil(TH×1.5) left only 0.5 px, causing the row-1
 *       left-corner to appear merged with tile-0 on narrow boards.)
 *
 * PUBLIC API:
 *   Tokens.forBoard(boardW)  →  { TW, TH, SLOT, ROW_H, MX, DZ_W, DZ_H }
 *   (also writes matching CSS custom properties as a side-effect)
 */
(function (global) {
  'use strict';

  // ── Tile size table (mobile-first, keyed on available board width) ──────────
  // TH is always TW/2 so every pip-square is perfectly square.
  function _tileSize(boardW) {
    if (boardW <= 260) return { TW: 38, TH: 19 };
    if (boardW <= 320) return { TW: 42, TH: 21 };
    if (boardW <= 420) return { TW: 46, TH: 23 };
    if (boardW <= 560) return { TW: 50, TH: 25 };
    if (boardW <= 720) return { TW: 54, TH: 27 };
    return               { TW: 62, TH: 31 };
  }

  // ── Fixed layout constants ──────────────────────────────────────────────────
  const MX   = 12;   // horizontal margin from board edge to chain
  const DZ_W = 44;   // drop-zone width
  const DZ_H = 40;   // drop-zone height

  // ── Sync CSS custom properties so CSS and JS always agree ──────────────────
  function _applyCSS(TW, TH) {
    const s = document.documentElement.style;
    s.setProperty('--tile-w', TW + 'px');
    s.setProperty('--tile-h', TH + 'px');
    s.setProperty('--dz-w',   DZ_W + 'px');
    s.setProperty('--dz-h',   DZ_H + 'px');
  }

  /**
   * Returns the complete set of layout constants for a given board width.
   * Also writes matching CSS custom properties as a side-effect.
   *
   * @param  {number} boardW  Available board pixel width
   * @returns {{ TW, TH, SLOT, ROW_H, MX, DZ_W, DZ_H }}
   */
  function forBoard(boardW) {
    const { TW, TH } = _tileSize(boardW);
    _applyCSS(TW, TH);
    return {
      TW,
      TH,
      MX,
      DZ_W,
      DZ_H,
      SLOT:  TW,        // one horizontal tile = one SLOT (no gap in geometry)
      ROW_H: TW,        // = 2×TH — provides TH/2 visible gap between rows (see contract)
    };
  }

  global.Tokens = { forBoard };

})(window);
