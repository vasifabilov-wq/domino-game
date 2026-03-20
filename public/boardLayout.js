/**
 * boardLayout.js — Pure coordinate engine for the domino snake board.
 *
 * RULES:
 *   • No DOM reads. No DOM writes. Pure math only.
 *   • All size constants come from Tokens.forBoard(boardW).
 *   • Returns absolute { x, y, w, h } for every tile and drop-zone.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COORDINATE INVARIANT  (the foundational rule — never break this)
 * ─────────────────────────────────────────────────────────────────────────────
 *   cx  =  cursor that tracks the current slot's "origin"
 *
 *   dir = +1 (going RIGHT):  cx = LEFT  edge of the slot
 *   dir = -1 (going LEFT):   cx = RIGHT edge of the slot
 *
 *   Horizontal tile placement:
 *     dir=+1 →  x = cx          (tile starts at left edge)
 *     dir=-1 →  x = cx - TW     (tile ends at right edge)
 *
 *   Vertical tile placement (doubles & corner turns):
 *     hoff = floor((TW - TH) / 2)   ← centres the narrow tile in the wide slot
 *     dir=+1 →  x = cx + hoff
 *     dir=-1 →  x = cx - TH - hoff
 *
 *   Row start cursor  (applied after every corner, and at the very beginning):
 *     dir=+1 →  cx = MX              ← LEFT  edge of first slot = left  margin
 *     dir=-1 →  cx = boardW - MX     ← RIGHT edge of first slot = right margin
 *
 *   Cursor advance after a non-corner tile:
 *     cx += dir * SLOT
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function (global) {
  'use strict';

  /**
   * Compute the full board layout.
   *
   * @param  {object}   board     - Server board state
   *   board.tiles       [{tile:[a,b], flipped}]
   *   board.spinnerIdx  number | null
   *   board.topTiles    [{tile,flipped}]
   *   board.bottomTiles [{tile,flipped}]
   *   board.isEmpty     boolean
   * @param  {number}   boardW    - Available board width in px (already measured)
   * @param  {string[]} selSides  - Active drop-zone sides e.g. ['left','right']
   *
   * @returns {{
   *   chain:   ChainItem[],   // main snake path items (tiles + left/right DZs)
   *   spinner: SpinnerData | null,
   *   totalW:  number,
   *   totalH:  number,
   * }}
   */
  function compute(board, boardW, selSides) {
    selSides = selSides || [];

    if (!board || board.isEmpty) {
      return { chain: [], spinner: null, totalW: boardW, totalH: 100 };
    }

    // ── Layout constants for this board width (also writes CSS vars) ──────────
    const C = Tokens.forBoard(boardW);
    const { TW, TH, GAP, MX, SLOT, ROW_H, DZ_W, DZ_H } = C;

    // hoff: offset that centres a TH-wide double tile inside the TW-wide slot.
    // Used only for doubles; corner tiles use margin-snapping instead.
    const hoff = Math.floor((TW - TH) / 2);

    // ── Effective margin (EMX) — centres the chain and snaps corners to edges ─
    // A row consists of (perRow-1) horizontal tiles (SLOT each) + 1 corner (TH wide).
    // We choose nHoriz so the row fits, then centre it, deriving EMX.
    // With EMX, the cursor at the corner slot equals boardW - EMX - TH, meaning
    // the corner's right face is exactly at boardW - EMX (same as row-2 first
    // tile's right face) → pixel-perfect corner↔row alignment.
    const nHoriz = Math.max(2, Math.floor((boardW - 2 * MX - TH) / SLOT));
    const perRow = nHoriz + 1;
    const rowUsed = nHoriz * SLOT + TH;
    const EMX = Math.max(MX, Math.ceil((boardW - rowUsed) / 2));

    // First row centre Y: must be ≥ TW/2 so vertical corner tiles don't clip the top
    const CY0 = Math.ceil(TW / 2) + GAP;

    const tiles      = board.tiles      || [];
    const spinnerIdx = board.spinnerIdx != null ? board.spinnerIdx : null;
    const armsOpen   = spinnerIdx !== null
                    && spinnerIdx > 0
                    && spinnerIdx < tiles.length - 1;

    // ── Phase 1: Build ordered item list ─────────────────────────────────────
    // Optional left DZ → all chain tiles → optional right DZ
    const items = [];
    if (selSides.includes('left'))  items.push({ kind: 'dz', side: 'left'  });
    tiles.forEach((t, i) => items.push({ kind: 'tile', ...t, chainIdx: i }));
    if (selSides.includes('right')) items.push({ kind: 'dz', side: 'right' });

    // ── Phase 2: Walk the snake path ──────────────────────────────────────────
    const N     = items.length;
    let cx      = EMX;  // cursor — see COORDINATE INVARIANT above (use EMX not MX)
    let cy      = CY0;  // row vertical centre
    let dir     = 1;    // +1 = right, -1 = left
    const chain = [];

    for (let i = 0; i < N; i++) {
      const item       = items[i];
      const posInRow   = i % perRow;
      const isLastSlot = posInRow === perRow - 1;
      const isFinalRow = i + perRow >= N;
      // A corner is the last slot in any non-final row → tile placed vertically
      const isCorner   = isLastSlot && !isFinalRow;

      if (item.kind === 'dz') {
        // Drop-zone: same slot origin, DZ dimensions
        const x = dir === 1 ? cx : cx - DZ_W;  // DZ follows cursor like a horizontal tile
        const y = Math.round(cy - DZ_H / 2);
        chain.push({ isDZ: true, side: item.side, x, y, w: DZ_W, h: DZ_H });

      } else {
        const { tile, flipped, chainIdx } = item;
        const [a, b] = tile;
        const isDouble  = a === b;
        const isSpinner = chainIdx === spinnerIdx;

        // Doubles and corner-turn tiles are placed vertically (perpendicular)
        const isVert = isDouble || isCorner;

        // Flip semantics: invert when going left so the connecting pip always
        // faces the chain interior (visually correct for the player)
        const eFlip = dir === -1 ? !flipped : flipped;
        const showA = eFlip ? b : a;
        const showB = eFlip ? a : b;

        let x, y, w, h;
        if (isVert) {
          if (isCorner) {
            // Corner tile: snap to the board margin so its outer face aligns
            // with the first tile of the next row (both share the same margin edge).
            // dir=+1 row ends on the RIGHT → corner right face = boardW - EMX
            // dir=-1 row ends on the LEFT  → corner left  face = EMX
            x = dir === 1 ? boardW - EMX - TH : EMX;
          } else {
            // Double tile in mid-chain: centre it within its TW-wide slot
            x = dir === 1 ? cx + hoff : cx - TH - hoff;
          }
          y = Math.round(cy - TW / 2);
          w = TH;
          h = TW;
        } else {
          // Horizontal: TW wide × TH tall
          x = dir === 1 ? cx : cx - TW;
          y = Math.round(cy - TH / 2);
          w = TW;
          h = TH;
        }

        chain.push({
          isDZ: false, x, y, w, h,
          showA, showB,
          isVertical: isVert,
          isCorner,
          isDouble,
          isSpinner,
          chainIdx,
        });
      }

      // ── Advance cursor ──────────────────────────────────────────────────────
      if (isCorner) {
        // ═══════════════════════════════════════════════════════════════════════
        // CURSOR RESET  — the most important line in this file.
        //
        // After a corner the direction flips. The new cx must satisfy the
        // COORDINATE INVARIANT for the NEW direction:
        //
        //   dir=+1 after flip  →  cx = MX            (left edge of first slot)
        //   dir=-1 after flip  →  cx = boardW - MX   (right edge of first slot)
        //
        // Common mistake: using boardW - MX - TW for dir=-1.
        // That places the tile at x = cx - TW = boardW - MX - 2*TW,
        // which is one full tile-width too far left, causing cascade overflow.
        // ═══════════════════════════════════════════════════════════════════════
        cy  += ROW_H;
        dir *= -1;
        cx   = dir === 1 ? EMX : boardW - EMX;  // ← INVARIANT-CORRECT reset (use EMX)

      } else {
        cx += dir * SLOT;
      }
    }

    // ── Phase 3: Spinner arms ─────────────────────────────────────────────────
    let spinner = null;

    if (spinnerIdx !== null) {
      const sp = chain.find(c => !c.isDZ && c.isSpinner);

      if (sp) {
        const scx = sp.x + sp.w / 2;            // horizontal centre of spinner tile
        const armX = Math.round(scx - TW / 2);  // arm tiles are horizontal (TW wide)

        // Top arm — server stores topTiles[0]=outermost, we render nearest-first
        const topTiles    = board.topTiles    || [];
        const topRev      = [...topTiles].reverse();

        const topLayouts  = topRev.map(({ tile, flipped }, idx) => {
          const [ta, tb] = tile;
          const showA = flipped ? tb : ta;
          const showB = flipped ? ta : tb;
          const y = sp.y - (topRev.length - idx) * (TH + GAP);
          return { x: armX, y, w: TW, h: TH, showA, showB, isVertical: false };
        });

        // Bottom arm — bottomTiles[0] is closest to spinner
        const bottomTiles   = board.bottomTiles || [];
        const bottomLayouts = bottomTiles.map(({ tile, flipped }, idx) => {
          const [ta, tb] = tile;
          const showA = flipped ? tb : ta;
          const showB = flipped ? ta : tb;
          const y = sp.y + sp.h + GAP + idx * (TH + GAP);
          return { x: armX, y, w: TW, h: TH, showA, showB, isVertical: false };
        });

        // Drop-zones for arms (only when arms are unlocked)
        let topDZ = null, botDZ = null;

        if (armsOpen && selSides.includes('top')) {
          const refY = topLayouts.length ? topLayouts[0].y : sp.y;
          topDZ = {
            isDZ: true, side: 'top',
            x: Math.round(scx - DZ_W / 2),
            y: refY - DZ_H - GAP,
            w: DZ_W, h: DZ_H,
          };
        }

        if (armsOpen && selSides.includes('bottom')) {
          const last = bottomLayouts[bottomLayouts.length - 1];
          const refY = last ? last.y + TH : sp.y + sp.h;
          botDZ = {
            isDZ: true, side: 'bottom',
            x: Math.round(scx - DZ_W / 2),
            y: refY + GAP,
            w: DZ_W, h: DZ_H,
          };
        }

        spinner = { sp, topLayouts, bottomLayouts, topDZ, botDZ, armsOpen };
      }
    }

    // ── Phase 4: Bounding box — shift if anything clips left or top ───────────
    const all = [
      ...chain,
      ...(spinner?.topLayouts    || []),
      ...(spinner?.bottomLayouts || []),
      spinner?.topDZ,
      spinner?.botDZ,
    ].filter(Boolean);

    if (!all.length) return { chain: [], spinner: null, totalW: boardW, totalH: 100 };

    const minX = Math.min(...all.map(t => t.x));
    const minY = Math.min(...all.map(t => t.y));
    const maxX = Math.max(...all.map(t => t.x + t.w));
    const maxY = Math.max(...all.map(t => t.y + t.h));

    const ox = minX < EMX ? EMX - minX : 0;
    const oy = minY < 4   ? 4   - minY : 0;

    if (ox > 0 || oy > 0) {
      const shift = it => it ? { ...it, x: it.x + ox, y: it.y + oy } : it;
      for (let i = 0; i < chain.length; i++) chain[i] = shift(chain[i]);
      if (spinner) {
        spinner.topLayouts    = spinner.topLayouts.map(shift);
        spinner.bottomLayouts = spinner.bottomLayouts.map(shift);
        spinner.topDZ         = shift(spinner.topDZ);
        spinner.botDZ         = shift(spinner.botDZ);
        spinner.sp            = shift(spinner.sp);
      }
    }

    return {
      chain,
      spinner,
      totalW: Math.max(boardW, maxX + ox + EMX),
      totalH: maxY + oy + 8,
    };
  }

  global.BoardLayout = { compute };

})(window);
