/**
 * boardLayout.js — Path-based domino board layout engine
 *
 * Computes deterministic absolute (x, y, w, h) for every tile on the board.
 * NO flexbox / CSS grid involvement — pure coordinate arithmetic.
 *
 * Algorithm overview
 * ──────────────────
 *  • A cursor (cx, cy, dir) marches along the snake path.
 *  • dir = +1 → going RIGHT;  dir = −1 → going LEFT.
 *  • Every tile advances the cursor by SLOT (= tile_long + gap) along dir.
 *  • When the cursor reaches the last slot of a row (isCorner = true) it:
 *      1. Places the tile VERTICALLY (perpendicular to the direction).
 *      2. Bumps cy down by ROW_H (= tile_short + gap).
 *      3. Flips dir and resets cx to the new row's starting edge.
 *  • The spinner double tile lives at its chain index in the main path.
 *  • Top/bottom arms are stacked vertically above/below the spinner,
 *    completely independent of the main path — no overlap possible.
 *
 * Usage
 * ─────
 *  const layout = BoardLayout.compute(board, boardW, selSides);
 *  // layout.chain   → array of positioned items (tiles + edge drop-zones)
 *  // layout.spinner → { topLayouts, bottomLayouts, topDZ, botDZ } | null
 *  // layout.totalW, layout.totalH → container dimensions
 */
(function (global) {
  'use strict';

  // ── Tile geometry (board scale) ─────────────────────────────────────────────
  const TW = 54;          // long  side of a horizontal tile  (px) — matches CSS
  const TH = 27;          // short side of a horizontal tile  (px) — matches CSS

  // ── Spacing constants (TILE_GAP / LANE_GAP philosophy) ──────────────────────
  // Adapted from the companion layout-engine spec:
  //   TILE_GAP = horizontal gap between adjacent chain tiles
  //   LANE_GAP = extra vertical breathing room between snake rows
  //              (on top of tile height, so rows never touch or overlap)
  const TILE_GAP = 8;            // px between tiles along the chain   ← was 3
  const LANE_GAP = 16;           // extra px between snake row centres  ← was implicit 0

  // Derived constants
  const GAP   = TILE_GAP;        // alias used by spacing math
  const SLOT  = TW + GAP;        // path advance per tile = 62          ← was 57
  // ROW_H must be ≥ TW/2 + TH/2 (= 40) to prevent corner-tile overlap with
  // the adjacent row.  TH + LANE_GAP = 27 + 16 = 43 → 3 px clearance. ✓
  const ROW_H = TH + LANE_GAP;   // vertical step between row centres = 43  ← was 30
  const MX    = 12;              // horizontal margin from board edge    ← was 8

  // First row: vertical centre ≥ TW/2 so vertical tiles never clip the top edge.
  // CY0 = TW/2 + TILE_GAP = 27 + 8 = 35                               ← was 31
  const CY0 = Math.ceil(TW / 2) + TILE_GAP;

  // Drop-zone geometry (must match CSS .board-chain .drop-zone)
  const DZ_W = 46;               // ← was 42
  const DZ_H = 42;               // ← was 38

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Tiles-per-row: how many SLOT-wide tiles fit horizontally inside boardW. */
  function perRowFor(boardW) {
    return Math.max(3, Math.floor((boardW - 2 * MX + GAP) / SLOT));
  }

  /**
   * Pixel bounds of one tile/DZ slot given the cursor state.
   *
   * @param {number}  cx        Path cursor X anchor.
   *                            For dir=+1: left edge of slot.
   *                            For dir=−1: right edge of tile (tile extends left).
   * @param {number}  cy        Row vertical center.
   * @param {number}  dir       +1 or −1.
   * @param {boolean} isVertical Tile rendered tall & narrow (doubles, corners).
   * @param {boolean} isDZ      Drop-zone (uses DZ_W × DZ_H).
   */
  function slotBounds(cx, cy, dir, isVertical, isDZ) {
    if (isDZ) {
      const x = dir === 1 ? cx : cx - DZ_W;
      return { x, y: Math.round(cy - DZ_H / 2), w: DZ_W, h: DZ_H };
    }
    if (isVertical) {
      // Vertical tile: TH wide × TW tall, horizontally centred in the TW slot.
      const hoff = Math.floor((TW - TH) / 2);   // = 13
      const x    = dir === 1 ? cx + hoff : cx - TH - hoff;
      const y    = Math.round(cy - TW / 2);
      return { x, y, w: TH, h: TW };
    }
    // Horizontal tile: TW wide × TH tall.
    const x = dir === 1 ? cx : cx - TW;
    const y = Math.round(cy - TH / 2);
    return { x, y, w: TW, h: TH };
  }

  // ── Main export ─────────────────────────────────────────────────────────────

  /**
   * Compute full board layout.
   *
   * @param {object}   board      Server board state.
   *   board.tiles        [{tile:[a,b], flipped}]  – main chain
   *   board.spinnerIdx   number | null
   *   board.topTiles     [{tile, flipped}]
   *   board.bottomTiles  [{tile, flipped}]
   * @param {number}   boardW     Available width in px.
   * @param {string[]} selSides   Active valid sides for drop-zones
   *                              (e.g. ['left','right'] or ['top','bottom']).
   *
   * @returns {{
   *   chain:   ChainItem[],   // main snake + left/right DZs
   *   spinner: SpinnerData | null,
   *   totalW:  number,
   *   totalH:  number
   * }}
   *
   * ChainItem: { isDZ, side?, x, y, w, h,
   *              showA?, showB?, isVertical?, isCorner?, isDouble?, isSpinner?,
   *              chainIdx? }
   */
  function compute(board, boardW, selSides) {
    selSides = selSides || [];

    if (!board || board.isEmpty) {
      return { chain: [], spinner: null, totalW: boardW, totalH: 100 };
    }

    const tiles      = board.tiles      || [];
    const spinnerIdx = board.spinnerIdx != null ? board.spinnerIdx : null;
    const armsOpen   = spinnerIdx !== null
      && spinnerIdx > 0
      && spinnerIdx < tiles.length - 1;

    const perRow = perRowFor(boardW);

    // ── Phase 1: Build item list ───────────────────────────────────────────────
    // Items = optional left-DZ + chain tiles + optional right-DZ.
    // Each item occupies exactly one SLOT on the path.
    const items = [];
    if (selSides.includes('left'))  items.push({ kind: 'dz', side: 'left'  });
    tiles.forEach((t, i) => items.push({ kind: 'tile', ...t, chainIdx: i }));
    if (selSides.includes('right')) items.push({ kind: 'dz', side: 'right' });

    // ── Phase 2: Walk the path ────────────────────────────────────────────────
    const N = items.length;
    let cx  = MX;    // path cursor X
    let cy  = CY0;   // row vertical centre
    let dir = 1;     // +1 = right, −1 = left

    const chain = [];

    for (let i = 0; i < N; i++) {
      const item       = items[i];
      const posInRow   = i % perRow;
      const isLastSlot = posInRow === perRow - 1;
      const isFinalRow = i + perRow >= N;
      // Corner = last slot of a non-final row → tile rendered vertical.
      const isCorner   = isLastSlot && !isFinalRow;

      if (item.kind === 'dz') {
        // Drop-zone uses the same slot position but DZ geometry.
        const b = slotBounds(cx, cy, dir, false, true);
        chain.push({ isDZ: true, side: item.side, ...b });
      } else {
        const { tile, flipped, chainIdx } = item;
        const [a, b] = tile;
        const isDouble  = a === b;
        const isSpinner = chainIdx === spinnerIdx;

        // Corners and doubles render vertically.
        const isVert = isDouble || isCorner;

        // Effective pip order: invert flip when travelling left so the
        // connecting pip always faces the chain interior.
        const eFlip = dir === -1 ? !flipped : flipped;
        const showA = eFlip ? b : a;
        const showB = eFlip ? a : b;

        const bounds = slotBounds(cx, cy, dir, isVert, false);
        chain.push({
          isDZ: false,
          ...bounds,
          showA, showB,
          isVertical: isVert,
          isCorner,
          isDouble,
          isSpinner,
          chainIdx,
        });
      }

      // ── Advance cursor ───────────────────────────────────────────────────────
      if (isCorner) {
        // Direction switch: move row down, flip, reset X to new row start.
        cy  += ROW_H;
        dir *= -1;
        cx   = dir === 1 ? MX : boardW - MX - TW;
      } else {
        cx += dir * SLOT;
      }
    }

    // ── Phase 3: Spinner arms ─────────────────────────────────────────────────
    // Arms are positioned relative to the spinner tile; they never interfere
    // with the main chain rows.
    let spinner = null;

    if (spinnerIdx !== null) {
      const sp = chain.find(c => !c.isDZ && c.isSpinner);
      if (sp) {
        // Spinner tile is vertical (TH wide × TW tall).
        // Horizontal centre of spinner (used to centre arm tiles).
        const scx = sp.x + sp.w / 2;   // = sp.x + TH/2

        // Arm tile x: horizontal tile (TW wide) centred on spinner.
        const armX = Math.round(scx - TW / 2);

        // Top arm — displayed in REVERSE (topTiles[last] is closest to spinner).
        // Server stores topTiles with the first played = index 0 = outermost.
        const topTiles    = board.topTiles || [];
        const topReversed = [...topTiles].reverse(); // index 0 = outermost

        const topLayouts = topReversed.map(({ tile, flipped }, armIdx) => {
          const [ta, tb] = tile;
          // Top arm tiles connect downward (toward spinner), so tb faces spinner.
          const showA = flipped ? tb : ta;
          const showB = flipped ? ta : tb;
          // Stack upward: tile closest to spinner at armIdx=0 is placed first,
          // outermost is placed last going up.
          const y = sp.y - (topReversed.length - armIdx) * (TH + GAP);
          return { x: armX, y, w: TW, h: TH, showA, showB, isVertical: false };
        });

        // Bottom arm — bottomTiles[0] is closest to spinner.
        const bottomTiles   = board.bottomTiles || [];
        const bottomLayouts = bottomTiles.map(({ tile, flipped }, armIdx) => {
          const [ta, tb] = tile;
          const showA = flipped ? tb : ta;
          const showB = flipped ? ta : tb;
          const y = sp.y + sp.h + GAP + armIdx * (TH + GAP);
          return { x: armX, y, w: TW, h: TH, showA, showB, isVertical: false };
        });

        // Drop zones for top/bottom arms (only when arms are unlocked).
        let topDZ = null;
        let botDZ = null;

        if (armsOpen && selSides.includes('top')) {
          const refY = topLayouts.length > 0
            ? topLayouts[0].y               // outermost top tile's top edge
            : sp.y;                         // no tiles yet — start at spinner top
          topDZ = {
            isDZ: true, side: 'top',
            x: Math.round(scx - DZ_W / 2),
            y: refY - DZ_H - GAP,
            w: DZ_W, h: DZ_H,
          };
        }
        if (armsOpen && selSides.includes('bottom')) {
          const last  = bottomLayouts[bottomLayouts.length - 1];
          const refY  = last ? last.y + TH : sp.y + sp.h;
          botDZ = {
            isDZ: true, side: 'bottom',
            x: Math.round(scx - DZ_W / 2),
            y: refY + GAP,
            w: DZ_W, h: DZ_H,
          };
        }

        spinner = { sp, topLayouts, bottomLayouts, topDZ, botDZ };
      }
    }

    // ── Phase 4: Bounding box + shift ─────────────────────────────────────────
    // Collect every positioned item and find min x/y.
    const all = [
      ...chain,
      ...(spinner?.topLayouts   || []),
      ...(spinner?.bottomLayouts|| []),
      spinner?.topDZ,
      spinner?.botDZ,
    ].filter(Boolean);

    const minX = Math.min(...all.map(t => t.x));
    const minY = Math.min(...all.map(t => t.y));
    const maxX = Math.max(...all.map(t => t.x + t.w));
    const maxY = Math.max(...all.map(t => t.y + t.h));

    // If any tile overflows left or top, shift everything right/down.
    const ox = minX < MX        ? MX - minX       : 0;
    const oy = minY < 4         ? 4  - minY        : 0;

    if (ox > 0 || oy > 0) {
      const shift = it => it ? { ...it, x: it.x + ox, y: it.y + oy } : it;
      for (let i = 0; i < chain.length; i++) chain[i] = shift(chain[i]);
      if (spinner) {
        spinner.topLayouts    = spinner.topLayouts.map(shift);
        spinner.bottomLayouts = spinner.bottomLayouts.map(shift);
        spinner.topDZ = shift(spinner.topDZ);
        spinner.botDZ = shift(spinner.botDZ);
        spinner.sp    = shift(spinner.sp);
      }
    }

    return {
      chain,
      spinner,
      totalW: Math.max(boardW, maxX + ox + MX),
      totalH: maxY + oy + 4,
    };
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  global.BoardLayout = {
    compute,
    // Constants exposed for renderBoard to set matching CSS tile sizes.
    TW, TH, GAP, DZ_W, DZ_H, SLOT, ROW_H, MX,
  };

})(window);
