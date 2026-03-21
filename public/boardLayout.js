/**
 * boardLayout.js — Domino snake board layout engine.
 *
 * ALGORITHM: Cursor-walking (dynamic — handles doubles correctly)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The chain is built by walking a cursor (cx) along each row. Advance per tile:
 *
 *   Regular tile  →  cursor advances TW  (w=TW, h=TH)
 *   Double tile   →  cursor advances TH  (w=TH, h=TW, flush to both neighbours)
 *   Corner tile   →  triggered when distToEdge < TW; placed at board margin,
 *                    starts the next row
 *
 * Unlike the old slot-grid approach there is no fixed `perRow`, so a row
 * containing doubles can fit more tiles than an all-regular row, and doubles
 * sit flush against their neighbours (no hoff gap).
 *
 * Each chain item carries `row` (0-based row index) and `rowDir` (+1/-1)
 * metadata so the test verifier and app.js can use them directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GEOMETRY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   n      = max(2, floor((boardW − 2·MX − TH) / TW))   used only for EMX
 *   EMX    = MX + floor(R / 2)   centres the chain horizontally
 *   ROW_H  = TW  (= 2·TH)       provides TH/2 visible gap between rows
 *   CY0    = TH + 4              first row centre-Y (corner fits above, y≥4)
 *
 *   Corner x:  dir=+1 → boardW − EMX − TH   (right margin)
 *              dir=−1 → EMX                  (left margin)
 *   Corner y:  round(cy − TH/2),  w = TH,  h = TW
 *
 *   WHY cy − TH/2 (not cy − TH):
 *     With ROW_H = TW = 2·TH, the next row centre is at cy + 2·TH.
 *     The corner tile spans [cy−TH/2 … cy+3·TH/2]:
 *       • upper pip [cy−TH/2 … cy+TH/2] aligns with the last row's horizontal
 *         tiles (they span [cy−TH/2 … cy+TH/2]) — face-to-face ✓
 *       • lower pip [cy+TH/2 … cy+3·TH/2] bottom = cy+3·TH/2 = (cy+2·TH)−TH/2
 *         = next row centre − TH/2 = top of first next-row tile ✓
 *     Using cy−TH instead would leave a TH/2 gap at the bottom connection.
 *
 *   Cursor after corner:
 *     right corner → new dir=−1, cx = boardW − EMX
 *     left  corner → new dir=+1, cx = EMX
 */
(function (global) {
  'use strict';

  function compute(board, boardW, selSides) {
    selSides = selSides || [];

    if (!board || board.isEmpty) {
      return { chain: [], spinner: null, totalW: boardW, totalH: 100 };
    }

    // ── Constants ─────────────────────────────────────────────────────────────
    const C = Tokens.forBoard(boardW);
    const { TW, TH, ROW_H, MX, DZ_W, DZ_H } = C;

    const tiles      = board.tiles || [];
    const spinnerIdx = board.spinnerIdx != null ? board.spinnerIdx : null;
    const armsOpen   = spinnerIdx !== null
                    && spinnerIdx > 0
                    && spinnerIdx < tiles.length - 1;
    const N = tiles.length;

    if (N === 0) return { chain: [], spinner: null, totalW: boardW, totalH: 100 };

    // ── Layout constants ───────────────────────────────────────────────────────
    // `n` is used only to compute EMX (chain centring). It is NOT a fixed perRow.
    const n   = Math.max(2, Math.floor((boardW - 2 * MX - TH) / TW));
    const R   = (boardW - 2 * MX - TH) - n * TW;
    const EMX = Math.max(MX, MX + Math.floor(R / 2));

    const CY0         = TH + 4;
    const cornerRight = boardW - EMX - TH;   // left edge of right-side corner
    const cornerLeft  = EMX;                 // left edge of left-side corner

    // ── Cursor-walking chain builder ───────────────────────────────────────────
    const chain = [];

    // cx: for dir=+1, left edge of next tile slot
    //     for dir=−1, right edge of next tile slot
    let cx  = EMX;
    let cy  = CY0;
    let dir = 1;     // +1 = L→R, −1 = R→L
    let row = 0;

    for (let i = 0; i < N; i++) {
      const t         = tiles[i];
      const [a, b]    = t.tile;
      const isDouble  = a === b;
      const isSpinner = i === spinnerIdx;

      // Capture current direction BEFORE any corner flip
      const tileDir = dir;

      // Remaining space before the margin corner position:
      //   dir=+1: pixels from cursor to right corner x
      //   dir=−1: pixels from cursor right-edge to left corner right-edge (EMX+TH)
      const distToEdge = tileDir === 1
        ? cornerRight - cx
        : cx - TH - cornerLeft;

      // Corner: not enough room for a regular tile, and not the last tile
      const isCorner = (i < N - 1) && (distToEdge < TW);

      let x, y, w, h;

      if (isCorner) {
        // ── Corner tile ───────────────────────────────────────────────────────
        // y = cy − TH/2 so the lower pip aligns with the next row's first tile.
        // See algorithm header for the full derivation.
        x = tileDir === 1 ? cornerRight : cornerLeft;
        y = Math.round(cy - TH / 2);
        w = TH;
        h = TW;
        // Advance to next row AFTER positioning this tile
        cy  += ROW_H;
        dir  = -tileDir;
        row += 1;
        cx   = dir === 1 ? EMX : boardW - EMX;

      } else if (isDouble) {
        // ── Double tile: flush against neighbours, no hoff offset ─────────────
        if (tileDir === 1) {
          x  = cx;
          cx += TH;          // double is TH wide → advance only TH
        } else {
          cx -= TH;
          x   = cx;
        }
        y = Math.round(cy - TH);   // centred on row cy, sticks TH above + below
        w = TH;
        h = TW;

      } else {
        // ── Regular horizontal tile ───────────────────────────────────────────
        if (tileDir === 1) {
          x  = cx;
          cx += TW;
        } else {
          cx -= TW;
          x   = cx;
        }
        y = Math.round(cy - TH / 2);
        w = TW;
        h = TH;
      }

      // Flip semantics: invert when going left so the connecting pip faces
      // the chain interior.
      const eFlip = tileDir === -1 ? !t.flipped : t.flipped;
      const showA = eFlip ? b : a;
      const showB = eFlip ? a : b;

      chain.push({
        isDZ:       false,
        x, y, w, h,
        showA, showB,
        isVertical: isDouble || isCorner,
        isCorner,
        isDouble,
        isSpinner,
        chainIdx:   i,
        row:        isCorner ? row - 1 : row,  // corner belongs to the row it ends
        rowDir:     tileDir,
      });
    }

    // ── Drop-zones: placed adjacent to chain endpoints ────────────────────────
    if (selSides.length > 0) {
      const firstTile = chain[0];
      const lastTile  = chain[chain.length - 1];

      if (selSides.includes('left') && firstTile) {
        // Tile 0 is always dir=+1; open face is on the left at x = EMX
        const dzX = Math.max(0, firstTile.x - DZ_W);
        const dzY = Math.round(firstTile.y + firstTile.h / 2 - DZ_H / 2);
        chain.unshift({ isDZ: true, side: 'left', x: dzX, y: dzY, w: DZ_W, h: DZ_H });
      }

      if (selSides.includes('right') && lastTile) {
        // Open face: right side for rowDir=+1, left side for rowDir=−1
        const dzX = lastTile.rowDir === 1
          ? lastTile.x + lastTile.w
          : Math.max(0, lastTile.x - DZ_W);
        const dzY = Math.round(lastTile.y + lastTile.h / 2 - DZ_H / 2);
        chain.push({ isDZ: true, side: 'right', x: dzX, y: dzY, w: DZ_W, h: DZ_H });
      }
    }

    // ── Spinner arms ──────────────────────────────────────────────────────────
    let spinner = null;

    if (spinnerIdx !== null) {
      const sp = chain.find(c => !c.isDZ && c.isSpinner);

      if (sp) {
        const scx  = sp.x + sp.w / 2;
        const armX = Math.round(scx - TW / 2);

        // Top arm — topTiles[0] is outermost; render nearest-first (reversed).
        const topTiles   = board.topTiles || [];
        const topRev     = [...topTiles].reverse();
        const topLayouts = topRev.map(({ tile, flipped }, idx) => {
          const [ta, tb] = tile;
          return {
            x: armX,
            y: sp.y - (topRev.length - idx) * (TH + 2),
            w: TW, h: TH,
            showA: flipped ? tb : ta,
            showB: flipped ? ta : tb,
            isVertical: false,
          };
        });

        // Bottom arm — bottomTiles[0] is closest to spinner.
        const bottomTiles   = board.bottomTiles || [];
        const bottomLayouts = bottomTiles.map(({ tile, flipped }, idx) => {
          const [ta, tb] = tile;
          return {
            x: armX,
            y: sp.y + sp.h + 2 + idx * (TH + 2),
            w: TW, h: TH,
            showA: flipped ? tb : ta,
            showB: flipped ? ta : tb,
            isVertical: false,
          };
        });

        // Arm drop-zones (only when arms are unlocked).
        let topDZ = null, botDZ = null;

        if (armsOpen && selSides.includes('top')) {
          const refY = topLayouts.length ? topLayouts[0].y : sp.y;
          topDZ = {
            isDZ: true, side: 'top',
            x: Math.round(scx - DZ_W / 2),
            y: refY - DZ_H - 2,
            w: DZ_W, h: DZ_H,
          };
        }

        if (armsOpen && selSides.includes('bottom')) {
          const last = bottomLayouts[bottomLayouts.length - 1];
          const refY = last ? last.y + TH : sp.y + sp.h;
          botDZ = {
            isDZ: true, side: 'bottom',
            x: Math.round(scx - DZ_W / 2),
            y: refY + 2,
            w: DZ_W, h: DZ_H,
          };
        }

        spinner = { sp, topLayouts, bottomLayouts, topDZ, botDZ, armsOpen };
      }
    }

    // ── Bounding box + overflow guard ─────────────────────────────────────────
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

    // Shift everything right/down if content clips the left or top edge.
    const ox = minX < 4 ? 4 - minX : 0;
    const oy = minY < 4 ? 4 - minY : 0;

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
      totalW: Math.max(boardW, maxX + ox + MX),
      totalH: maxY + oy + 8,
    };
  }

  global.BoardLayout = { compute };

})(window);
