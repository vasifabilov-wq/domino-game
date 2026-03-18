'use strict';

// ── Tile Set ──────────────────────────────────────────────────────────────────
const ALL_TILES = [];
for (let i = 0; i <= 6; i++)
  for (let j = i; j <= 6; j++)
    ALL_TILES.push([i, j]);

function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Deal 7 tiles per player ───────────────────────────────────────────────────
function deal(n) {
  const tiles = shuffle([...ALL_TILES]);
  const hands = [];
  for (let i = 0; i < n; i++) hands.push(tiles.splice(0, 7));
  return { hands, graveyard: tiles };
}

// ── Redeal check: 5+ of same pip WITHOUT the double ──────────────────────────
function checkRedeal(hands) {
  for (let p = 0; p < hands.length; p++) {
    for (let pip = 0; pip <= 6; pip++) {
      const cnt = hands[p].filter(t => t[0] === pip || t[1] === pip).length;
      const hasD = hands[p].some(t => t[0] === pip && t[1] === pip);
      if (cnt >= 5 && !hasD) return { redeal: true, seat: p, pip };
    }
  }
  return { redeal: false };
}

// ── Find which player must go first ──────────────────────────────────────────
// 5s:  player with [2,3] always starts first round
// 101: player with [1,1] starts when no scores yet
// Returns { seat, mustTile } — seat=null means use lastWinner/lastBlocker
function findStarter(hands, gameType, hasAnyScore) {
  if (gameType === '5s') {
    for (let i = 0; i < hands.length; i++)
      if (hands[i].some(t => (t[0]===2&&t[1]===3)||(t[0]===3&&t[1]===2)))
        return { seat: i, mustTile: [2, 3] };
  } else {
    if (!hasAnyScore)
      for (let i = 0; i < hands.length; i++)
        if (hands[i].some(t => t[0]===1 && t[1]===1))
          return { seat: i, mustTile: [1, 1] };
  }
  return { seat: null, mustTile: null };
}

// ── Valid moves for a player ──────────────────────────────────────────────────
// Returns [{ tileIdx, sides: ['left'|'right'|'top'|'bottom'] }]
// rules.spinner  — false → no 4-end spinner; all doubles play as regular tiles
// rules.armsBoth — false → arms open immediately when spinner placed (standard)
//                  true  → require tiles on BOTH sides of spinner first (default / custom)
function getValidMoves(hand, board, mustTile, rules = {}) {
  if (board.isEmpty) {
    if (mustTile) {
      const idx = hand.findIndex(t =>
        (t[0]===mustTile[0]&&t[1]===mustTile[1]) ||
        (t[0]===mustTile[1]&&t[1]===mustTile[0])
      );
      return idx >= 0 ? [{ tileIdx: idx, sides: ['right'] }] : [];
    }
    return hand.map((_, i) => ({ tileIdx: i, sides: ['right'] }));
  }

  const spinnerEnabled = rules.spinner !== false;
  const effectiveSpinnerIdx = spinnerEnabled ? board.spinnerIdx : null;

  let armsOpen = false;
  if (effectiveSpinnerIdx !== null) {
    if (rules.armsBoth === false) {
      armsOpen = true; // standard: arms open immediately
    } else {
      armsOpen = effectiveSpinnerIdx > 0 && effectiveSpinnerIdx < board.tiles.length - 1;
    }
  }

  const moves = [];
  hand.forEach((t, i) => {
    const sides = new Set();
    if (t[0]===board.leftEnd  || t[1]===board.leftEnd)  sides.add('left');
    if (t[0]===board.rightEnd || t[1]===board.rightEnd) sides.add('right');

    if (armsOpen) {
      const topConnect = board.topEnd    !== null ? board.topEnd    : board.spinnerPip;
      const botConnect = board.bottomEnd !== null ? board.bottomEnd : board.spinnerPip;
      if (t[0]===topConnect || t[1]===topConnect) sides.add('top');
      if (t[0]===botConnect || t[1]===botConnect) sides.add('bottom');
    }

    if (sides.size) moves.push({ tileIdx: i, sides: [...sides] });
  });
  return moves;
}

// ── Place a tile, returns updated board ───────────────────────────────────────
// Board fields:
//   tiles[]          — main chain tiles { tile:[a,b], flipped }
//   leftEnd/rightEnd — open pip at each main-chain end
//   leftEndDouble / rightEndDouble — whether that end tile is a double
//   centerIdx        — index of first-placed tile (for scroll centering)
//   spinnerIdx       — index of the spinner double (null if none / disabled)
//   spinnerPip       — pip value of the spinner
//   topTiles[] / bottomTiles[] — arm tiles
//   topEnd / bottomEnd — open pip at each arm end (null = arm not started)
//   topEndDouble / bottomEndDouble — whether arm end tile is a double
//
// rules.spinner — false → never set spinnerIdx (doubles play as regular tiles)
function placeTile(board, tile, side, rules = {}) {
  const [a, b] = tile;
  const isDouble = (a === b);
  const spinnerEnabled = rules.spinner !== false;
  const nb = {
    tiles:          [...board.tiles],
    leftEnd:        board.leftEnd,
    rightEnd:       board.rightEnd,
    leftEndDouble:  board.leftEndDouble  ?? false,
    rightEndDouble: board.rightEndDouble ?? false,
    topEndDouble:   board.topEndDouble   ?? false,
    bottomEndDouble:board.bottomEndDouble?? false,
    isEmpty:        false,
    centerIdx:      board.centerIdx   ?? 0,
    spinnerIdx:     board.spinnerIdx  ?? null,
    spinnerPip:     board.spinnerPip  ?? null,
    topTiles:       [...(board.topTiles    || [])],
    bottomTiles:    [...(board.bottomTiles || [])],
    topEnd:         board.topEnd    ?? null,
    bottomEnd:      board.bottomEnd ?? null,
  };

  // ── First tile ever ─────────────────────────────────────────────────────────
  if (board.isEmpty) {
    nb.tiles          = [{ tile, flipped: false }];
    nb.leftEnd        = a;
    nb.rightEnd       = isDouble ? a : b;
    nb.leftEndDouble  = isDouble;
    nb.rightEndDouble = isDouble;
    nb.centerIdx      = 0;
    if (spinnerEnabled && isDouble) { nb.spinnerIdx = 0; nb.spinnerPip = a; }
    return nb;
  }

  // ── Arm placement (top / bottom) ────────────────────────────────────────────
  if (side === 'top' || side === 'bottom') {
    const isTop = (side === 'top');
    const connectPip = isTop
      ? (board.topEnd    !== null ? board.topEnd    : board.spinnerPip)
      : (board.bottomEnd !== null ? board.bottomEnd : board.spinnerPip);

    if (isTop) {
      if (b === connectPip) {
        nb.topTiles = [...nb.topTiles, { tile, flipped: false }];
        nb.topEnd   = a;
      } else {
        nb.topTiles = [...nb.topTiles, { tile, flipped: true }];
        nb.topEnd   = b;
      }
      nb.topEndDouble = isDouble;
    } else {
      if (a === connectPip) {
        nb.bottomTiles = [...nb.bottomTiles, { tile, flipped: false }];
        nb.bottomEnd   = b;
      } else {
        nb.bottomTiles = [...nb.bottomTiles, { tile, flipped: true }];
        nb.bottomEnd   = a;
      }
      nb.bottomEndDouble = isDouble;
    }
    return nb;
  }

  // ── Main chain left ─────────────────────────────────────────────────────────
  if (side === 'left') {
    if (b === nb.leftEnd) {
      nb.tiles   = [{ tile, flipped: false }, ...nb.tiles];
      nb.leftEnd = a;
    } else {
      nb.tiles   = [{ tile, flipped: true }, ...nb.tiles];
      nb.leftEnd = b;
    }
    nb.leftEndDouble = isDouble;
    nb.centerIdx = (board.centerIdx ?? 0) + 1;
    if (nb.spinnerIdx !== null) nb.spinnerIdx = board.spinnerIdx + 1;
    if (spinnerEnabled && nb.spinnerIdx === null && isDouble) { nb.spinnerIdx = 0; nb.spinnerPip = a; }

  // ── Main chain right ────────────────────────────────────────────────────────
  } else {
    if (a === nb.rightEnd) {
      nb.tiles    = [...nb.tiles, { tile, flipped: false }];
      nb.rightEnd = b;
    } else {
      nb.tiles    = [...nb.tiles, { tile, flipped: true }];
      nb.rightEnd = a;
    }
    nb.rightEndDouble = isDouble;
    nb.centerIdx = board.centerIdx ?? 0;
    if (spinnerEnabled && nb.spinnerIdx === null && isDouble) { nb.spinnerIdx = nb.tiles.length - 1; nb.spinnerPip = a; }
  }
  return nb;
}

// ── 5s scoring after a placement ─────────────────────────────────────────────
// Standard All Fives rule: a double at an open end exposes BOTH halves → counts pip × 2.
// e.g. [6,6] at the end contributes 12, not 6.
// This makes BOMB possible: [6,6](12) + [4,4](8) + [5,5](10) + 5 = 35 → BOMBED!
function score5s(board, isFirst, tile, rules = {}) {
  if (isFirst) return (tile[0]===5 && tile[1]===5) ? 10 : 0;

  const spinnerEnabled = rules.spinner !== false;
  const effectiveSpinnerIdx = spinnerEnabled ? board.spinnerIdx : null;

  let armsOpen = false;
  if (effectiveSpinnerIdx !== null) {
    if (rules.armsBoth === false) {
      armsOpen = true;
    } else {
      armsOpen = effectiveSpinnerIdx > 0 && effectiveSpinnerIdx < board.tiles.length - 1;
    }
  }

  // Double at an open end → both pips count (pip × 2)
  const ev = (pip, isDbl) => isDbl ? pip * 2 : pip;

  let sum = ev(board.leftEnd, board.leftEndDouble) + ev(board.rightEnd, board.rightEndDouble);
  if (armsOpen) {
    // If arm not started yet, spinner pip itself shows — spinner is a double but each arm
    // sees only ONE face of it (not doubled), so no ×2 for bare spinner ends
    const topPip    = board.topEnd    !== null ? board.topEnd    : board.spinnerPip;
    const botPip    = board.bottomEnd !== null ? board.bottomEnd : board.spinnerPip;
    const topIsDbl  = board.topEnd    !== null ? (board.topEndDouble    ?? false) : false;
    const botIsDbl  = board.bottomEnd !== null ? (board.bottomEndDouble ?? false) : false;
    sum += ev(topPip, topIsDbl);
    sum += ev(botPip, botIsDbl);
  }
  return sum % 5 === 0 ? sum : 0;
}

// ── Pip sum of a hand ─────────────────────────────────────────────────────────
// 101 special: if ONLY [0,0] remains → counts as 10
function pipSum(hand, is101 = false) {
  if (is101 && hand.length === 1 && hand[0][0] === 0 && hand[0][1] === 0) return 10;
  return hand.reduce((s, t) => s + t[0] + t[1], 0);
}

// Round to nearest 5
function roundTo5(n) { return Math.round(n / 5) * 5; }

module.exports = {
  ALL_TILES, deal, checkRedeal, findStarter,
  getValidMoves, placeTile, score5s, pipSum, roundTo5
};
