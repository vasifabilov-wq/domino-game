// ── Sound System (Web Audio API — no files needed) ────────────────────────────
let _sfxCtx = null;
function _sfx() {
  if (!_sfxCtx) {
    try { _sfxCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { return null; }
  }
  if (_sfxCtx.state === 'suspended') _sfxCtx.resume();
  return _sfxCtx;
}
// Short woody "clack" when a tile is placed
function playTileSound() {
  const ctx = _sfx(); if (!ctx) return;
  try {
    const len = Math.floor(ctx.sampleRate * 0.11);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.14));
    const src  = ctx.createBufferSource(); src.buffer = buf;
    const bp   = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 1.0;
    const gain = ctx.createGain(); gain.gain.value = 0.55;
    src.connect(bp); bp.connect(gain); gain.connect(ctx.destination);
    src.start();
  } catch(e) {}
}
// Short beep for last-10-seconds timer warning
let _lastWarnSec = -1;
function playTimerBeep() {
  const ctx = _sfx(); if (!ctx) return;
  try {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.22, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.14);
  } catch(e) {}
}

// ── Socket & State ────────────────────────────────────────────────────────────
const socket = io();

let S = {
  myId: null, myName: null, room: null, isHost: false,
  picks: {
    gameType: '5s', playerCount: 3, playMode: 'individual',
    rules: { spinner: true, armsBoth: true, autoDrawLoop: true, redeal: true, bomb: true, timerSecs: 60, targetScore: 365 }
  },
  // game
  gs: null,           // last game-update payload
  selectedTileIdx: null,
  selectedTileSides: [],
  timerInterval: null,
  autoPassInterval: null,  // countdown timer for auto-pass when no moves + empty graveyard
};

// ── Dot positions in 3×3 grid (0-indexed, row-major) ──────────────────────────
const DOTS = { 0:[], 1:[4], 2:[2,6], 3:[2,4,6], 4:[0,2,6,8], 5:[0,2,4,6,8], 6:[0,2,3,5,6,8] };

// ── Build a tile DOM element ──────────────────────────────────────────────────
// opts.vertical = true → render as vertical tile (doubles on the board)
function makeTile(a, b, opts = {}) {
  const { playable, selected, disabled, vertical } = opts;
  const isDouble = (a === b);
  // Doubles on board are placed perpendicular (vertical); hand tiles always horizontal
  const orient = vertical ? 'v' : 'h';
  const div = document.createElement('div');
  div.className = ['tile', orient, isDouble ? 'double' : '',
    playable ? 'playable' : '', selected ? 'selected' : '',
    disabled ? 'disabled' : ''
  ].filter(Boolean).join(' ');
  div.appendChild(makePipHalf(a));
  const line = document.createElement('div'); line.className = 'tile-line';
  div.appendChild(line);
  div.appendChild(makePipHalf(b));
  return div;
}
function makePipHalf(pip) {
  const d = document.createElement('div'); d.className = 'tile-half';
  for (let i = 0; i < 9; i++) {
    const s = document.createElement('span');
    s.className = 'pip' + (DOTS[pip] && DOTS[pip].includes(i) ? ' on' : '');
    d.appendChild(s);
  }
  return d;
}
function makeFaceDown(vertical = false) {
  const d = document.createElement('div'); d.className = 'opp-tile-back';
  if (vertical) d.style.cssText = 'width:14px;height:28px';
  return d;
}

// ── Mobile phone detection (portrait or landscape phone) ──────────────────────
function isPhone() {
  const w = window.innerWidth, h = window.innerHeight;
  const short = Math.min(w, h), long = Math.max(w, h);
  return short <= 500 || w <= 640; // landscape phone (short side ≤500) or portrait phone
}

// ── Try to lock orientation to landscape (Android Chrome only; iOS ignores) ───
async function tryLandscape() {
  try {
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen().catch(() => {});
    }
    if (screen.orientation?.lock) {
      await screen.orientation.lock('landscape').catch(() => {});
    }
  } catch(e) { /* Graceful fail — rotate hint (CSS) handles iOS */ }
}

// ── Views ──────────────────────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'game' && isPhone()) tryLandscape();
}

// ── Lobby option selectors ─────────────────────────────────────────────────────
function pickOpt(key, el) {
  el.closest('.option-grid').querySelectorAll('.opt-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  if (key === 'gametype') {
    S.picks.gameType = el.dataset.val;
    const is101 = el.dataset.val === '101';
    // Auto-fill target input with game-type default
    const defaultTarget = is101 ? 101 : 365;
    const inp = document.getElementById('rule-target');
    if (inp) inp.value = defaultTarget;
    S.picks.rules.targetScore = defaultTarget;
    // Show/hide rules that only apply to 5s (spinner, armsBoth, bomb)
    document.querySelectorAll('.rule-pill[data-only="5s"]').forEach(btn => {
      btn.style.display = is101 ? 'none' : '';
    });
    // Force 5s-only rules off when switching to 101
    if (is101) {
      S.picks.rules.spinner  = false;
      S.picks.rules.armsBoth = false;
      S.picks.rules.bomb     = false;
    } else {
      // Restore ON state from the pill visual when switching back to 5s
      document.querySelectorAll('.rule-pill[data-only="5s"]').forEach(btn => {
        S.picks.rules[btn.dataset.rule] = btn.classList.contains('on');
      });
    }
  }
  if (key === 'mode') S.picks.playMode = el.dataset.val;
}
function pickPill(key, el) {
  el.closest('.pill-row').querySelectorAll('.pill').forEach(p => p.classList.remove('selected'));
  el.classList.add('selected');
  if (key === 'players') {
    S.picks.playerCount = parseInt(el.dataset.val);
    document.getElementById('field-mode').style.display = S.picks.playerCount === 4 ? 'block' : 'none';
  }
}
// ── Reset target to game-type default ─────────────────────────────────────────
function resetTarget() {
  const def = S.picks.gameType === '101' ? 101 : 365;
  const inp = document.getElementById('rule-target');
  if (inp) inp.value = def;
  S.picks.rules.targetScore = def;
}

// ── Rules toggle / value selectors ────────────────────────────────────────────
function toggleRule(el) {
  const rule = el.dataset.rule;
  const nowOn = !el.classList.contains('on');
  el.classList.toggle('on', nowOn);
  S.picks.rules[rule] = nowOn;
}
function pickRuleVal(el) {
  const group = el.dataset.group;
  document.querySelectorAll(`[data-group="${group}"]`).forEach(b => b.classList.remove('on'));
  el.classList.add('on');
  S.picks.rules[group] = parseInt(el.dataset.val);
}

// ── Lobby actions ──────────────────────────────────────────────────────────────
function createGame() {
  const name = document.getElementById('create-name').value.trim();
  const err  = document.getElementById('create-err');
  if (!name) { err.textContent = 'Please enter your name.'; return; }
  // Read target from input (validate it)
  const targetVal = parseInt(document.getElementById('rule-target')?.value) || 0;
  if (targetVal < 10) { err.textContent = 'Target score must be at least 10.'; return; }
  S.picks.rules.targetScore = targetVal;
  err.textContent = ''; S.myName = name;
  socket.emit('create-room', {
    gameType: S.picks.gameType, playerCount: S.picks.playerCount,
    playMode: S.picks.playerCount === 4 ? S.picks.playMode : 'individual',
    hostName: name,
    rules: { ...S.picks.rules }
  });
}
function joinGame() {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  const name = document.getElementById('join-name').value.trim();
  const err  = document.getElementById('join-err');
  if (code.length < 6) { err.textContent = 'Enter the 6-character room code.'; return; }
  if (!name)           { err.textContent = 'Please enter your name.'; return; }
  err.textContent = ''; S.myName = name;
  socket.emit('join-room', { code, playerName: name });
}
function startGame() {
  document.getElementById('start-err').textContent = '';
  socket.emit('start-game', { code: S.room.code });
}
function assignTeam(pid, team) { socket.emit('assign-team', { code: S.room.code, playerId: pid, team }); }

// ── Share or copy a link (Web Share API on mobile, clipboard fallback) ─────────
function shareOrCopy(link, { title = 'Domino Game', text = 'Join my Domino game!', toastMsg = '🔗 Link copied!' } = {}) {
  if (navigator.share) {
    navigator.share({ title, text, url: link }).catch(() => {});
    return;
  }
  const ok = () => toast(toastMsg, 'ok');
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(ok).catch(() => fallCopy(link, ok));
  else fallCopy(link, ok);
}

// ── Copy/Share game link (in-game, from score panel) ─────────────────────────
function copyGameLink() {
  if (!S.room?.code) return;
  const link = `${location.origin}/?room=${S.room.code}`;
  shareOrCopy(link, { text: `Join my Domino game! Room: ${S.room.code}`, toastMsg: '🔗 Rejoin link copied!' });
}

// ── Share/copy lobby invite link ───────────────────────────────────────────────
function copyLink() {
  const link = `${location.origin}/?room=${S.room.code}`;
  const btn  = document.getElementById('copy-btn');
  if (navigator.share) {
    navigator.share({ title: 'Domino Game', text: `Join my Domino game! Room: ${S.room.code}`, url: link }).catch(() => {});
    return;
  }
  const ok = () => {
    btn.textContent = '✓ Copied!'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent = '📤 Share'; btn.classList.remove('copied'); }, 2200);
    toast('🔗 Link copied!', 'ok');
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(ok).catch(() => fallCopy(link, ok));
  else fallCopy(link, ok);
}
function fallCopy(text, cb) {
  const ta = Object.assign(document.createElement('textarea'), { value: text });
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.append(ta); ta.focus(); ta.select();
  try { document.execCommand('copy'); cb(); } catch(e) {}
  ta.remove();
}

// ── Render lobby ───────────────────────────────────────────────────────────────
function renderLobby(room) {
  S.room   = room;
  S.isHost = room.hostId === S.myId;
  const gameLabel = room.gameType === '5s' ? '5s — All Fives' : '101 — Kozel';
  document.getElementById('lob-title').textContent    = gameLabel;
  document.getElementById('lob-subtitle').textContent = `${room.playerCount} Players · ${room.playMode === 'teams' ? '2v2 Teams' : 'Individual'}`;
  document.getElementById('lob-code').textContent     = room.code;
  const miss = room.playerCount - room.players.length;
  document.getElementById('lob-status').textContent = miss > 0
    ? `⏳ Waiting for ${miss} more player${miss > 1 ? 's' : ''}…`
    : '✅ All players joined!';
  // Rules chips
  const rulesEl = document.getElementById('lob-rules');
  if (rulesEl && room.rules) {
    const r = room.rules;
    const chips = [];
    if (r.spinner)       chips.push('Spinner');
    if (r.armsBoth)      chips.push('ArmsBoth');
    if (r.autoDrawLoop)  chips.push('AutoDraw');
    if (r.redeal)        chips.push('Redeal');
    if (r.bomb)          chips.push('💣 Bomb');
    if (r.timerSecs > 0) chips.push(`${r.timerSecs}s Timer`);
    chips.push(`Target: ${r.targetScore}`);
    rulesEl.innerHTML = chips.map(c => `<span class="rules-chip">${c}</span>`).join('');
  }
  const isTeams = room.playMode === 'teams';
  document.getElementById('sec-individual').style.display = isTeams ? 'none' : 'block';
  document.getElementById('sec-teams').style.display      = isTeams ? 'block' : 'none';
  isTeams ? renderTeams(room) : renderIndividual(room);
  document.getElementById('host-ctrl').style.display = S.isHost ? 'block'  : 'none';
  document.getElementById('guest-msg').style.display = S.isHost ? 'none'   : 'block';
}
function renderIndividual(room) {
  const list = document.getElementById('list-individual'); list.innerHTML = '';
  for (let i = 0; i < room.playerCount; i++) {
    const p = room.players[i];
    list.appendChild(p ? makePlayerItem(p, room) : makeEmptySlot(i + 1));
  }
}
function renderTeams(room) {
  ['A','B'].forEach(tm => {
    const list = document.getElementById('list-team-' + tm.toLowerCase()); list.innerHTML = '';
    const members = room.players.filter(p => p.team === tm);
    for (let i = 0; i < 2; i++) {
      const p = members[i];
      if (p) { const el = makePlayerItem(p, room, tm); el.classList.add('team-' + tm.toLowerCase() + '-card'); list.appendChild(el); }
      else   { list.appendChild(makeEmptySlot(null, 'Empty slot')); }
    }
  });
  const unassigned = room.players.filter(p => !p.team);
  const secU = document.getElementById('sec-unassigned');
  const listU = document.getElementById('list-unassigned'); listU.innerHTML = '';
  secU.style.display = unassigned.length ? 'block' : 'none';
  unassigned.forEach(p => listU.appendChild(makePlayerItem(p, room, null)));
}
function makePlayerItem(p, room, teamCtx) {
  const div = document.createElement('div'); div.className = 'p-item';
  const left = document.createElement('div'); left.className = 'p-left';
  const nameEl = document.createElement('span'); nameEl.className = 'p-name'; nameEl.textContent = p.name;
  left.appendChild(nameEl);
  if (p.isHost) left.appendChild(mkBadge('Host','badge-host'));
  if (p.id === S.myId) left.appendChild(mkBadge('You','badge-you'));
  div.appendChild(left);
  if (S.isHost && room.playMode === 'teams') {
    const right = document.createElement('div'); right.className = 'p-right';
    if (teamCtx === null) {
      // Only show a team button if that team still has room (max 2 per team)
      const countA = room.players.filter(pl => pl.id !== p.id && pl.team === 'A').length;
      const countB = room.players.filter(pl => pl.id !== p.id && pl.team === 'B').length;
      if (countA < 2) right.appendChild(teamBtn('→ A', 'team-btn-a', () => assignTeam(p.id, 'A')));
      if (countB < 2) right.appendChild(teamBtn('→ B', 'team-btn-b', () => assignTeam(p.id, 'B')));
    } else {
      right.appendChild(teamBtn('✕', 'team-btn-rm', () => assignTeam(p.id, null)));
    }
    div.appendChild(right);
  }
  return div;
}
function makeEmptySlot(n, text) {
  const d = document.createElement('div'); d.className = 'p-item empty';
  d.innerHTML = `<span class="muted" style="font-size:.82rem">${text || `Waiting for player ${n}…`}</span>`;
  return d;
}
function mkBadge(text, cls) {
  const s = document.createElement('span'); s.className = 'badge ' + cls; s.textContent = text; return s;
}
function teamBtn(text, cls, fn) {
  const b = document.createElement('button'); b.className = 'team-btn ' + cls; b.textContent = text; b.onclick = fn; return b;
}

// ══════════════════════════════════════════════════════════════════════════════
// ── GAME RENDERING ────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function renderGame(gs) {
  S.gs = gs;
  // Cancel any pending auto-pass from previous turn
  if (S.autoPassInterval) { clearInterval(S.autoPassInterval); S.autoPassInterval = null; }
  // Show room code in score panel
  const codeEl = document.getElementById('sp-room-code');
  if (codeEl && S.room?.code) codeEl.textContent = S.room.code;
  renderBoard(gs);
  renderScorePanel(gs);
  renderPlayers(gs);
  renderMyHand(gs);
  renderTimer(gs);
  if (gs.lastScore > 0) showScoreFlash(gs.lastScore);
}

// ── Board ──────────────────────────────────────────────────────────────────────
// Snake layout: tiles are arranged in rows that alternate direction (LTR → RTL → LTR…)
// like a real domino board. Rows wrap when they hit the edge, growing downward.
function renderBoard(gs) {
  const chain    = document.getElementById('board-chain');
  const emptyMsg = document.getElementById('board-empty-msg');
  chain.innerHTML = '';

  if (gs.board.isEmpty) {
    emptyMsg.style.display = 'block';
    if (gs.isMyTurn && S.selectedTileIdx !== null) {
      emptyMsg.style.display = 'none';
      const row = document.createElement('div');
      row.className = 'chain-row row-ltr';
      row.appendChild(makeDropZone('right', '▶', 'Play here', 'dz-center'));
      chain.appendChild(row);
    }
    scrollToActive();
    return;
  }
  emptyMsg.style.display = 'none';

  const bd         = gs.board;
  const spinnerIdx = bd.spinnerIdx ?? null;
  const armsOpen   = spinnerIdx !== null
    && spinnerIdx > 0
    && spinnerIdx < bd.tiles.length - 1;
  const selSides   = (S.selectedTileIdx !== null && gs.isMyTurn) ? S.selectedTileSides : [];

  // ── Phase 1: Build ordered element array ────────────────────────────────────
  const elements = [];

  bd.tiles.forEach(({ tile, flipped }, idx) => {
    const [a, b] = tile;
    const showA = flipped ? b : a;
    const showB = flipped ? a : b;

    if (idx === spinnerIdx) {
      const wrap = document.createElement('div');
      wrap.className = 'spinner-wrap';

      const topArm = document.createElement('div');
      topArm.className = 'arm-tiles arm-top';
      if (armsOpen && selSides.includes('top')) topArm.appendChild(makeDropZone('top', '▲', ''));
      [...(bd.topTiles || [])].reverse().forEach(({ tile: t, flipped: f }) => {
        const ta = f ? t[1] : t[0], tb = f ? t[0] : t[1];
        topArm.appendChild(makeTile(ta, tb, { vertical: ta !== tb }));
      });
      if (!armsOpen && spinnerIdx !== null) {
        const lk = document.createElement('div');
        lk.className = 'arm-locked'; lk.title = 'Extend both sides first';
        topArm.appendChild(lk);
      }
      wrap.appendChild(topArm);

      const spinEl = makeTile(showA, showB, { vertical: true });
      spinEl.classList.add('spinner-tile');
      wrap.appendChild(spinEl);

      const botArm = document.createElement('div');
      botArm.className = 'arm-tiles arm-bottom';
      if (!armsOpen && spinnerIdx !== null) {
        const lk = document.createElement('div');
        lk.className = 'arm-locked'; lk.title = 'Extend both sides first';
        botArm.appendChild(lk);
      }
      (bd.bottomTiles || []).forEach(({ tile: t, flipped: f }) => {
        const ta = f ? t[1] : t[0], tb = f ? t[0] : t[1];
        botArm.appendChild(makeTile(ta, tb, { vertical: ta !== tb }));
      });
      if (armsOpen && selSides.includes('bottom')) botArm.appendChild(makeDropZone('bottom', '▼', ''));
      wrap.appendChild(botArm);

      elements.push(wrap);
    } else {
      const isDouble = (a === b);
      const el = makeTile(showA, showB, { vertical: isDouble });
      elements.push(el);
    }
  });

  // Drop zones at logical chain ends
  if (gs.isMyTurn && S.selectedTileIdx !== null) {
    if (selSides.includes('left'))  elements.unshift(makeDropZone('left',  '◀', ''));
    if (selSides.includes('right')) elements.push(makeDropZone('right', '▶', ''));
  }

  // ── Phase 2: Arrange into snake rows ────────────────────────────────────────
  // RTL rows use CSS flex-direction:row-reverse, so DOM order stays logical
  // but the visual snake turns at each row end naturally.
  const perRow = calcTilesPerRow();
  let rowIdx = 0;
  for (let i = 0; i < elements.length; i += perRow, rowIdx++) {
    const row = document.createElement('div');
    const isLast = (i + perRow >= elements.length);
    row.className = 'chain-row ' + (rowIdx % 2 === 0 ? 'row-ltr' : 'row-rtl');
    if (isLast) row.dataset.lastRow = '1';
    elements.slice(i, i + perRow).forEach(el => row.appendChild(el));
    chain.appendChild(row);
  }
  // Single-row board: CSS centres tiles horizontally via .solo-row
  if (chain.children.length === 1) chain.classList.add('solo-row');

  // Update open-ends indicator
  updateBoardEnds(gs.board);

  scrollToActive();
}

// ── Always-visible open-ends pip indicator ────────────────────────────────────
function updateBoardEnds(board) {
  const el = document.getElementById('board-ends');
  if (!el) return;
  if (!board || board.isEmpty) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  document.getElementById('board-end-left').textContent  = `◀ ${board.leftEnd  ?? '–'}`;
  document.getElementById('board-end-right').textContent = `${board.rightEnd ?? '–'} ▶`;
}

// ── How many tile-slots fit in one board row ────────────────────────────────────
function calcTilesPerRow() {
  const wrap = document.getElementById('board-chain')?.parentElement;
  if (!wrap) return 8;
  // Slot sizes match CSS tile widths + gap:
  //   phone   ≤640px  → 44px tile → 50px slot
  //   tablet  641–1100px → 52px tile → 58px slot
  //   desktop >1100px → 62px tile → 67px slot
  const w = window.innerWidth;
  const TILE_SLOT = isPhone() ? 50 : w <= 1100 ? 58 : 67;
  return Math.max(3, Math.floor((wrap.clientWidth - 12) / TILE_SLOT));
}

// ── Scroll board to show the active end ────────────────────────────────────────
function scrollToActive() {
  const wrap  = document.getElementById('board-chain')?.parentElement;
  const chain = document.getElementById('board-chain');
  if (!wrap || !chain) return;

  // All devices use snake: vertical scroll to last row, then auto-scale
  const rows = chain.querySelectorAll('.chain-row');
  if (rows.length <= 1) {
    requestAnimationFrame(() => { wrap.scrollTop = 0; autoScaleBoard(); });
    return;
  }
  requestAnimationFrame(() => {
    const lastRow = chain.querySelector('[data-last-row="1"]');
    if (lastRow) {
      wrap.scrollTop = Math.max(0,
        lastRow.offsetTop + lastRow.offsetHeight - wrap.clientHeight + 20);
    }
    autoScaleBoard();
  });
}

// ── Phone: jump to either end of the chain ────────────────────────────────────
function boardNavTo(side) {
  const wrap = document.getElementById('board-chain')?.parentElement;
  if (!wrap) return;
  wrap.scrollTo({ left: side === 'left' ? 0 : wrap.scrollWidth, behavior: 'smooth' });
}

// ── Auto-scale board chain to fit the visible board area (all devices) ────────
function autoScaleBoard() {
  const wrap  = document.getElementById('board-chain')?.parentElement;
  const chain = document.getElementById('board-chain');
  if (!wrap || !chain) return;

  // Reset first so we can measure the natural size
  chain.style.transform        = '';
  chain.style.transformOrigin  = '';
  chain.style.marginTop        = 'auto';
  chain.style.marginBottom     = 'auto';

  requestAnimationFrame(() => {
    const ww = wrap.clientWidth  - 8;
    const wh = wrap.clientHeight - 8;
    const cw = chain.scrollWidth;
    const ch = chain.scrollHeight;
    if (cw <= ww && ch <= wh) return; // already fits — nothing to do

    const scale = Math.max(Math.min(ww / cw, wh / ch, 1), 0.45);
    chain.style.transformOrigin = 'center center';
    chain.style.transform       = `scale(${scale})`;
    // Keep auto margins so the scaled chain stays centred
  });
}

// Alias kept for any legacy calls
function scrollToCenter() { scrollToActive(); }

// ── Drop zone factory ──────────────────────────────────────────────────────────
function makeDropZone(side, arrow, label, extraClass = '') {
  const zone = document.createElement('div');
  zone.className = 'drop-zone' + (extraClass ? ' ' + extraClass : '');
  zone.innerHTML = `<span class="dz-arrow">${arrow}</span>`
    + (label ? `<span class="dz-label">${label}</span>` : '');
  zone.onclick = () => playSide(side);
  return zone;
}

// renderDropZones kept for compatibility but now a no-op (renderBoard handles all zones)
function renderDropZones(gs) {}

// ── Score panel ────────────────────────────────────────────────────────────────
function renderScorePanel(gs) {
  document.getElementById('sp-gametype').textContent = gs.gameType === '5s' ? '5s — All Fives' : '101 — Kozel';
  document.getElementById('sp-round').textContent    = `Round ${gs.round}`;
  const scoresEl = document.getElementById('sp-scores');
  scoresEl.innerHTML = '';
  if (gs.playMode === 'teams') {
    ['A','B'].forEach(tm => {
      const row = document.createElement('div'); row.className = 'sp-row';
      const nm = document.createElement('span'); nm.className = 'sp-name'; nm.textContent = `Team ${tm}`;
      const pt = document.createElement('span'); pt.className = `sp-pts team-${tm.toLowerCase()}`; pt.textContent = gs.scores[tm] || 0;
      row.append(nm, pt); scoresEl.appendChild(row);
    });
  } else {
    gs.players.forEach(p => {
      const row = document.createElement('div'); row.className = 'sp-row';
      const nm = document.createElement('span'); nm.className = 'sp-name'; nm.textContent = p.seat === gs.mySeat ? 'You' : p.name;
      const pt = document.createElement('span'); pt.className = 'sp-pts' + (p.seat === gs.mySeat ? ' me' : ''); pt.textContent = gs.scores[p.seat] || 0;
      row.append(nm, pt); scoresEl.appendChild(row);
    });
  }
  const pendEl = document.getElementById('sp-pending');
  if (gs.pendingPts > 0) {
    pendEl.style.display = 'flex';
    document.getElementById('sp-pending-pts').textContent = gs.pendingPts + ' pts';
  } else {
    pendEl.style.display = 'none';
  }
}

// ── Player areas (opponents) ───────────────────────────────────────────────────
function renderPlayers(gs) {
  const me = gs.mySeat;
  const pc = gs.players.length;
  // Map seats to visual positions relative to me
  // Positions: top, left, right (up to 3 opponents for 4-player)
  const positions = [];
  for (let i = 1; i < pc; i++) {
    const seat = (me + i) % pc;
    if      (i === 1 && pc === 2) positions.push({ pos: 'top',   seat });
    else if (i === 1)             positions.push({ pos: 'left',  seat });
    else if (i === 2)             positions.push({ pos: 'top',   seat });
    else if (i === 3)             positions.push({ pos: 'right', seat });
  }

  // Clear all
  ['top','left','right'].forEach(pos => {
    document.getElementById('opp-' + pos + '-name').textContent = '';
    document.getElementById('opp-' + pos + '-tiles').innerHTML  = '';
    document.getElementById('opp-' + pos).classList.remove('current-turn');
  });

  positions.forEach(({ pos, seat }) => {
    const p = gs.players.find(p => p.seat === seat);
    if (!p) return;
    const nameEl  = document.getElementById('opp-' + pos + '-name');
    const tilesEl = document.getElementById('opp-' + pos + '-tiles');
    const area    = document.getElementById('opp-' + pos);
    const isVert  = (pos === 'left' || pos === 'right');

    nameEl.textContent = p.name + (p.isCurrentTurn ? ' 🎲' : '') + ` (${p.tileCount})`;
    if (p.isCurrentTurn) area.classList.add('current-turn');

    tilesEl.innerHTML = '';
    const show = Math.min(p.tileCount, 7);
    for (let i = 0; i < show; i++) tilesEl.appendChild(makeFaceDown(isVert));
  });

  // Turn indicator in score panel
  const curP = gs.players.find(p => p.isCurrentTurn);
  const spTurn = document.getElementById('sp-turn');
  if (curP) {
    const name = curP.seat === me ? 'Your Turn!' : `${curP.name}'s Turn`;
    const teamInfo = gs.playMode === 'teams' ? ` · Team ${curP.team}` : '';
    spTurn.innerHTML = `<strong>${name}</strong>${teamInfo}`;
  }
}

// ── My hand ────────────────────────────────────────────────────────────────────
function renderMyHand(gs) {
  const hand    = gs.myHand || [];
  const moves   = gs.validMoves || [];
  const handEl  = document.getElementById('my-hand');
  const label   = document.getElementById('my-label');
  const sideBtns= document.getElementById('side-btns');
  const actBtns = document.getElementById('action-btns');

  handEl.innerHTML = '';
  sideBtns.style.display = 'none';
  actBtns.style.display  = 'none';

  label.textContent = gs.isMyTurn ? '🎲 Your Turn — Pick a tile' : `Your Hand (${hand.length} tiles)`;

  hand.forEach((tile, idx) => {
    const [a, b] = tile;
    const moveInfo = moves.find(m => m.tileIdx === idx);
    const isPlayable = gs.isMyTurn && !!moveInfo;
    const isSelected = S.selectedTileIdx === idx;
    const tileEl = makeTile(a, b, { playable: isPlayable && !isSelected, selected: isSelected, disabled: gs.isMyTurn && !isPlayable && !isSelected, vertical: true });

    if (isPlayable) {
      tileEl.onclick = () => selectTile(idx, moveInfo.sides);
    }
    handEl.appendChild(tileEl);
  });

  // If no valid moves on your turn:
  if (gs.isMyTurn && moves.length === 0) {
    if (gs.graveyardCount > 0) {
      // Graveyard available → auto-draw (server loops until playable tile or graveyard empty)
      label.textContent = '⬆ Drawing from pile…';
      setTimeout(() => {
        // Guard: still our turn and still no moves when the timer fires
        if (S.gs && S.gs.isMyTurn && (!S.gs.validMoves || S.gs.validMoves.length === 0)) {
          socket.emit('draw-tile');
        }
      }, 600);
    } else {
      // Graveyard empty, no moves → countdown and auto-pass in 3 seconds
      actBtns.style.display = 'flex';
      document.getElementById('btn-draw').style.display = 'none';
      const passBtn = document.getElementById('btn-pass');
      passBtn.style.display = 'inline-flex';

      let secs = 3;
      passBtn.textContent = `No moves — passing in ${secs}s`;

      if (S.autoPassInterval) clearInterval(S.autoPassInterval);
      S.autoPassInterval = setInterval(() => {
        secs--;
        if (secs <= 0) {
          clearInterval(S.autoPassInterval);
          S.autoPassInterval = null;
          socket.emit('pass-turn');
        } else {
          passBtn.textContent = `No moves — passing in ${secs}s`;
        }
      }, 1000);
    }
  }

  // Show fallback side buttons when tile selected (board drop zones handled by renderBoard)
  if (S.selectedTileIdx !== null) {
    sideBtns.style.display = 'flex';
    const hasBoth = S.selectedTileSides.length === 2;
    document.querySelector('.btn-left-end').style.display  = (hasBoth || S.selectedTileSides.includes('left'))  ? 'inline-flex' : 'none';
    document.querySelector('.btn-right-end').style.display = (hasBoth || S.selectedTileSides.includes('right')) ? 'inline-flex' : 'none';
  }
}

// ── Tile selection ─────────────────────────────────────────────────────────────
function selectTile(idx, sides) {
  if (S.selectedTileIdx === idx) { cancelSelect(); return; }
  // Only one valid placement → play immediately, no drop-zone UI needed
  if (sides.length === 1) {
    playTileSound();
    socket.emit('play-tile', { tileIdx: idx, side: sides[0] });
    return;
  }
  S.selectedTileIdx   = idx;
  S.selectedTileSides = sides;
  renderMyHand(S.gs);
  renderBoard(S.gs);    // refresh board to show/hide arm drop zones
}
function cancelSelect() {
  S.selectedTileIdx   = null;
  S.selectedTileSides = [];
  renderMyHand(S.gs);
  renderBoard(S.gs);    // clear all zones
}
function playSide(side) {
  if (S.selectedTileIdx === null) return;
  playTileSound();
  socket.emit('play-tile', { tileIdx: S.selectedTileIdx, side });
  S.selectedTileIdx   = null;
  S.selectedTileSides = [];
}
function drawTile() { socket.emit('draw-tile'); }
function passTurn() { socket.emit('pass-turn'); }

// ── Timer ──────────────────────────────────────────────────────────────────────
function renderTimer(gs) {
  if (S.timerInterval) clearInterval(S.timerInterval);
  const bar = document.getElementById('timer-bar');
  const txt = document.getElementById('timer-txt');
  // Hide timer if game not playing OR timer is disabled (timerSecs === 0)
  if (gs.status !== 'playing' || !gs.turnSecs) { bar.style.width = '0%'; txt.textContent = ''; return; }

  _lastWarnSec = -1; // reset warning tracker on each turn

  const update = () => {
    const elapsed = (Date.now() - gs.turnStartTime) / 1000;
    const left    = Math.max(0, gs.turnSecs - elapsed);
    const pct     = (left / gs.turnSecs) * 100;
    bar.style.width = pct + '%';
    bar.className = 'timer-bar' + (pct < 25 ? ' urgent' : pct < 50 ? ' warn' : '');
    const m = Math.floor(left / 60), s = Math.floor(left % 60);
    txt.textContent = `${m}:${String(s).padStart(2,'0')}`;
    // ⚠ Last 10 seconds warning beep (only on your turn, once per second)
    if (gs.isMyTurn && left > 0 && left <= 10) {
      const secNow = Math.ceil(left);
      if (secNow !== _lastWarnSec) { _lastWarnSec = secNow; playTimerBeep(); }
    }
  };
  update();
  S.timerInterval = setInterval(update, 500);
}

// ── Score flash ────────────────────────────────────────────────────────────────
function showScoreFlash(pts) {
  const el = document.getElementById('sp-last');
  el.textContent = `+${pts} pts scored!`;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 2500);
}

// ── Round result overlay ───────────────────────────────────────────────────────
function showRoundResult(gs) {
  const r = gs.roundResult;
  if (!r) return;

  document.getElementById('round-overlay').style.display = 'flex';

  // Icon & title
  const isWin = r.roundWinner !== null;
  const myOwner = gs.playMode === 'teams'
    ? gs.players.find(p => p.seat === gs.mySeat)?.team
    : gs.mySeat;
  const iMeWin = isWin && String(r.roundWinner) === String(myOwner);

  document.getElementById('ro-icon').textContent = r.reason === 'domino' ? '🁣' : '🚫';
  document.getElementById('ro-title').textContent = r.reason === 'domino'
    ? (iMeWin ? '🎉 Domino! You win!' : `Domino! ${winnerName(gs, r.roundWinner)} wins!`)
    : (r.roundWinner === null ? '🤝 Tied Round' : `Blocked! ${winnerName(gs, r.roundWinner)} wins!`);

  document.getElementById('ro-sub').textContent = buildRoundSubtitle(gs, r);

  // Hands
  const handsEl = document.getElementById('ro-hands');
  handsEl.innerHTML = '';
  if (r.hands) {
    r.hands.forEach(({ name, hand, pipSum }) => {
      const row = document.createElement('div'); row.className = 'ro-hand-row';
      const tiles = hand.map(([a,b]) => `[${a}|${b}]`).join(' ');
      row.innerHTML = `<span>${name}</span><span style="color:var(--muted)">${tiles} = ${pipSum} pts</span>`;
      handsEl.appendChild(row);
    });
  }

  // Scores
  const scoresEl = document.getElementById('ro-scores');
  scoresEl.innerHTML = '<div style="font-size:.7rem;color:var(--muted);margin-bottom:4px">TOTAL SCORES</div>';
  if (gs.playMode === 'teams') {
    ['A','B'].forEach(tm => {
      const row = document.createElement('div');
      row.className = 'ro-score-row' + (String(r.roundWinner) === tm ? ' winner-row' : '');
      row.innerHTML = `<span>Team ${tm}</span><span style="color:var(--team-${tm.toLowerCase()})">${r.scores[tm] || 0}</span>`;
      scoresEl.appendChild(row);
    });
  } else {
    gs.players.forEach(p => {
      const row = document.createElement('div');
      row.className = 'ro-score-row' + (String(r.roundWinner) === String(p.seat) ? ' winner-row' : '');
      const label = p.seat === gs.mySeat ? 'You' : p.name;
      row.innerHTML = `<span>${label}</span><span>${r.scores[p.seat] || 0}</span>`;
      scoresEl.appendChild(row);
    });
  }
}

function buildRoundSubtitle(gs, r) {
  const parts = [];
  if (r.scoreAdded > 0)  parts.push(`+${r.scoreAdded} pts scored`);
  if (r.pendingAdd > 0)  parts.push(`+${r.pendingAdd} pts pending collected`);
  if (r.pendingForfeited) parts.push('Pending points forfeited!');
  if (r.pendingPts > 0)  parts.push(`${r.pendingPts} pts still pending`);
  return parts.join(' · ') || 'Round complete';
}

function winnerName(gs, owner) {
  if (gs.playMode === 'teams') return `Team ${owner}`;
  const p = gs.players.find(p => p.seat === Number(owner));
  return p ? (p.seat === gs.mySeat ? 'You' : p.name) : 'Unknown';
}

function hideRoundOverlay()   { document.getElementById('round-overlay').style.display   = 'none'; }
function hideGameOverOverlay(){ document.getElementById('gameover-overlay').style.display = 'none'; }

// ── Rematch: same players, same settings, fresh game ─────────────────────────
function rematch() {
  if (!S.room?.code) return;
  socket.emit('rematch', { code: S.room.code });
}

// ── Game over overlay ──────────────────────────────────────────────────────────
function showGameOver(gs) {
  document.getElementById('gameover-overlay').style.display = 'flex';
  const myOwner = gs.playMode === 'teams'
    ? gs.players.find(p => p.seat === gs.mySeat)?.team
    : gs.mySeat;
  const iWin = String(gs.roundResult?.gameWinner) === String(myOwner);
  const isBomb = gs.roundResult?.isBomb === true;

  if (isBomb) {
    document.getElementById('go-title').textContent = iWin ? '💣 BOMBED! You Win!' : '💣 BOMBED!';
    const scorer = winnerName(gs, gs.roundResult?.gameWinner);
    document.getElementById('go-sub').textContent =
      `${scorer} scored ${gs.roundResult.roundPts} pts in one play — game over!`;
  } else {
    document.getElementById('go-title').textContent = iWin ? '🏆 You Win!' : '😔 Game Over';
    document.getElementById('go-sub').textContent   = `Winner: ${winnerName(gs, gs.roundResult?.gameWinner)}`;
  }
  const sc = document.getElementById('go-scores'); sc.innerHTML = '';
  if (gs.roundResult?.scores) {
    if (gs.playMode === 'teams') {
      ['A','B'].forEach(tm => {
        const row = document.createElement('div'); row.className = 'ro-score-row';
        row.innerHTML = `<span>Team ${tm}</span><span style="color:var(--team-${tm.toLowerCase()})">${gs.roundResult.scores[tm] || 0}</span>`;
        sc.appendChild(row);
      });
    } else {
      gs.players.forEach(p => {
        const row = document.createElement('div'); row.className = 'ro-score-row';
        row.innerHTML = `<span>${p.seat === gs.mySeat ? 'You' : p.name}</span><span>${gs.roundResult.scores[p.seat] || 0}</span>`;
        sc.appendChild(row);
      });
    }
  }

  // ── Series wins ledger ──────────────────────────────────────────────────────
  const wins = gs.wins || {};
  const winsEl = document.getElementById('go-wins');
  const winsListEl = document.getElementById('go-wins-list');
  const totalWins = Object.values(wins).reduce((a, b) => a + b, 0);
  if (totalWins > 0) {
    winsEl.style.display = 'block';
    winsListEl.innerHTML = '';
    if (gs.playMode === 'teams') {
      ['A', 'B'].forEach(tm => {
        const w = wins[tm] || 0;
        const row = document.createElement('div'); row.className = 'ro-score-row';
        row.innerHTML = `<span>Team ${tm}</span><span style="color:var(--team-${tm.toLowerCase()})">${w} win${w !== 1 ? 's' : ''}</span>`;
        winsListEl.appendChild(row);
      });
    } else {
      gs.players.forEach(p => {
        const w = wins[String(p.seat)] || 0;
        const row = document.createElement('div'); row.className = 'ro-score-row';
        row.innerHTML = `<span>${p.seat === gs.mySeat ? 'You' : p.name}</span><span>${w} win${w !== 1 ? 's' : ''}</span>`;
        winsListEl.appendChild(row);
      });
    }
  } else {
    winsEl.style.display = 'none';
  }
}

// ── Toast ──────────────────────────────────────────────────────────────────────
let _tt;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast ' + type;
  clearTimeout(_tt);
  requestAnimationFrame(() => el.classList.add('show'));
  _tt = setTimeout(() => el.classList.remove('show'), 3000);
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Socket Events ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
socket.on('connect', () => { S.myId = socket.id; });

socket.on('room-created', ({ code, room }) => {
  S.room = room; renderLobby(room); showView('lobby');
  toast('Room created! Share the link.', 'ok');
});
socket.on('room-joined',    ({ room })  => { S.room = room; renderLobby(room); showView('lobby'); });
socket.on('lobby-updated',  ({ room })  => { S.room = room; renderLobby(room); });
socket.on('join-error',     ({ message }) => { document.getElementById('join-err').textContent = message; });
socket.on('start-error',    ({ message }) => { document.getElementById('start-err').textContent = message; });
socket.on('player-left',         ({ playerName }) => toast(`${playerName} left.`, 'err'));
socket.on('player-disconnected', ({ playerName }) => toast(`${playerName} disconnected.`, 'err'));
socket.on('player-reconnected',  ({ playerName }) => toast(`${playerName} reconnected!`, 'ok'));

socket.on('game-update', (gs) => {
  hideRoundOverlay();
  hideGameOverOverlay();
  showView('game');
  renderGame(gs);
  if (gs.status === 'round_over') {
    setTimeout(() => showRoundResult(gs), 300);
  } else if (gs.status === 'game_over') {
    setTimeout(() => showGameOver(gs), 300);
  }
});

// ── URL room code autofill ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const code = new URLSearchParams(location.search).get('room');
  if (code) { document.getElementById('join-code').value = code.toUpperCase(); showView('join'); }
});

// ── Enter key shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const v = document.querySelector('.view.active')?.id;
  if (v === 'view-create') createGame();
  if (v === 'view-join')   joinGame();
});
