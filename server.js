const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const G       = require('./gameEngine');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

// ── Room code generator ───────────────────────────────────────────────────────
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return rooms.has(s) ? genCode() : s;
}

// ── Sanitize room for lobby broadcast ────────────────────────────────────────
function lobbyRoom(room) {
  return {
    code: room.code, gameType: room.gameType,
    playerCount: room.playerCount, playMode: room.playMode,
    hostId: room.hostId, status: room.status,
    rules: room.rules,
    players: room.players.map(p => ({
      id: p.id, name: p.name, seat: p.seat,
      team: p.team, isHost: p.isHost, connected: p.connected,
      isBot: !!p.isBot
    }))
  };
}

// ── Build personalized game state for one player ──────────────────────────────
function stateFor(room, seat) {
  const gs = room.gs;
  const myHand    = gs.hands[seat] || [];
  const isMyTurn  = gs.status === 'playing' && gs.currentSeat === seat;
  const validMoves = isMyTurn ? G.getValidMoves(myHand, gs.board, gs.mustTile, room.rules) : [];

  return {
    roomCode:  room.code,
    gameType:  room.gameType,
    playMode:  room.playMode,
    rules:     room.rules,
    wins:      room.wins || {},
    round:     gs.round,
    status:    gs.status,          // 'playing' | 'round_over' | 'game_over'
    board:     gs.board,
    graveyardCount: gs.graveyard.length,
    players: room.players.map(p => ({
      id: p.id, name: p.name, seat: p.seat, team: p.team,
      tileCount: (gs.hands[p.seat] || []).length,
      isConnected: p.connected,
      isCurrentTurn: gs.currentSeat === p.seat
    })),
    mySeat:      seat,
    myHand,
    validMoves,
    isMyTurn,
    scores:      gs.scores,
    pendingPts:  gs.pendingPts,
    pendingOwner: gs.pendingOwner,
    currentSeat: gs.currentSeat,
    turnStartTime: gs.turnStartTime,
    turnSecs:    room.rules?.timerSecs ?? 60,
    roundResult: gs.roundResult || null,
    lastPlayedTile: gs.lastPlayedTile || null,
    lastScore:   gs.lastScore || 0
  };
}

// ── Broadcast personalised state to every player ─────────────────────────────
function broadcast(room) {
  room.players.forEach(p => {
    const s = io.sockets.sockets.get(p.id);
    if (s) s.emit('game-update', stateFor(room, p.seat));
  });
}

// ── Turn timer ────────────────────────────────────────────────────────────────
function clearTimer(room) {
  if (room._timer) { clearTimeout(room._timer); room._timer = null; }
}
function setTimer(room) {
  clearTimer(room);
  const secs = room.rules?.timerSecs ?? 60;
  if (!secs) return; // Timer disabled
  // Bots don't use the timer — they're handled by scheduleBotPlay
  const currentPlayer = room.players.find(p => p.seat === room.gs?.currentSeat);
  if (currentPlayer?.isBot) return;
  room._timer = setTimeout(() => autoPlay(room), secs * 1000);
}

// ── Bot auto-play scheduler ───────────────────────────────────────────────────
function scheduleBotPlay(room) {
  if (room._botTimer) { clearTimeout(room._botTimer); room._botTimer = null; }
  const gs = room.gs;
  if (!gs || gs.status !== 'playing') return;
  const currentPlayer = room.players.find(p => p.seat === gs.currentSeat);
  if (!currentPlayer?.isBot) return;
  room._botTimer = setTimeout(() => {
    room._botTimer = null;
    if (rooms.has(room.code)) autoPlay(room);
  }, 1200);
}
function autoPlay(room) {
  const gs = room.gs;
  if (!gs || gs.status !== 'playing') return;
  const hand  = gs.hands[gs.currentSeat];
  const moves = G.getValidMoves(hand, gs.board, gs.mustTile, room.rules);
  if (moves.length > 0) {
    const m = moves[Math.floor(Math.random() * moves.length)];
    doPlayTile(room, gs.currentSeat, m.tileIdx, m.sides[0]);
  } else if (gs.graveyard.length > 0) {
    doDrawTile(room, gs.currentSeat);
  } else {
    doPassTurn(room, gs.currentSeat);
  }
}

// ── Start / restart a round ───────────────────────────────────────────────────
function startRound(room) {
  clearTimer(room);
  const prev = room.gs;

  // Deal & redeal check (only if rule enabled)
  let { hands, graveyard } = G.deal(room.playerCount);
  let tries = 0;
  const allowRedeal = room.rules?.redeal !== false;
  while (allowRedeal && G.checkRedeal(hands).redeal && tries++ < 20) {
    ({ hands, graveyard } = G.deal(room.playerCount));
  }

  // Carry over scores / pending
  const isTeams = room.playMode === 'teams';
  const scores  = prev ? { ...prev.scores }
    : isTeams ? { A: 0, B: 0 }
    : Object.fromEntries(room.players.map(p => [p.seat, 0]));

  const pendingPts  = prev ? prev.pendingPts  : 0;
  const pendingOwner = prev ? prev.pendingOwner : null;
  const round       = prev ? prev.round       : 1;
  const lastWinner  = prev ? prev.lastWinnerSeat : null;
  const lastBlocker = prev ? prev.lastBlockerSeat : null;

  // Determine if ANY score is on the board (for 101 start rule)
  const hasAnyScore = Object.values(scores).some(s => s > 0);

  // Find who starts
  const { seat: starterSeat, mustTile } = G.findStarter(hands, room.gameType, hasAnyScore);
  let startSeat = starterSeat ?? lastBlocker ?? lastWinner ?? 0;

  room.gs = {
    hands, graveyard,
    board: { tiles: [], leftEnd: null, rightEnd: null, isEmpty: true },
    currentSeat: startSeat,
    mustTile,
    isFirstMove: true,
    consecutivePasses: 0,
    turnStartTime: Date.now(),
    scores, pendingPts, pendingOwner,
    round, lastWinnerSeat: lastWinner, lastBlockerSeat: lastBlocker,
    status: 'playing',
    roundResult: null,
    lastPlayedTile: null,
    lastScore: 0
  };

  setTimer(room);
  broadcast(room);
  scheduleBotPlay(room);
}

// ── Play a tile ───────────────────────────────────────────────────────────────
function doPlayTile(room, seat, tileIdx, side) {
  const gs = room.gs;
  if (gs.status !== 'playing' || gs.currentSeat !== seat) return;

  const hand = gs.hands[seat];
  if (tileIdx < 0 || tileIdx >= hand.length) return;

  // Validate move
  const moves = G.getValidMoves(hand, gs.board, gs.mustTile, room.rules);
  const valid = moves.find(m => m.tileIdx === tileIdx && m.sides.includes(side));
  if (!valid) return;

  const tile = hand[tileIdx];

  // Place tile
  gs.board = G.placeTile(gs.board, tile, side, room.rules);
  hand.splice(tileIdx, 1);
  gs.mustTile = null;
  gs.lastPlayedTile = tile;
  gs.consecutivePasses = 0;

  // Score
  let pts = 0;
  if (room.gameType === '5s') {
    pts = G.score5s(gs.board, gs.isFirstMove, tile, room.rules);
    gs.lastScore = pts;
    if (pts > 0) {
      addScore(room, seat, pts);
      // ── BOMB rule: single-play score ≥ 35 → instant game over ──────────────
      if (room.rules?.bomb !== false && pts >= 35) {
        gs.isFirstMove = false;
        endBomb(room, seat, pts);
        return;
      }
    }
  }
  gs.isFirstMove = false;

  // Check domino (hand empty)
  if (hand.length === 0) {
    endRound(room, seat, 'domino');
    return;
  }

  // Advance turn
  nextTurn(room);
}

// ── Draw from graveyard ───────────────────────────────────────────────────────
// autoDrawLoop (default on): draw until playable tile found or graveyard empty
// standard (autoDrawLoop off): draw exactly one tile; auto-pass if still no moves
function doDrawTile(room, seat) {
  const gs = room.gs;
  if (gs.status !== 'playing' || gs.currentSeat !== seat) return;
  if (gs.graveyard.length === 0) { doPassTurn(room, seat); return; }

  const autoLoop = room.rules?.autoDrawLoop !== false;

  if (autoLoop) {
    // Draw until playable or graveyard empty
    while (gs.graveyard.length > 0) {
      const tile = gs.graveyard.pop();
      gs.hands[seat].push(tile);
      gs.lastPlayedTile = null;
      gs.lastScore = 0;
      const moves = G.getValidMoves(gs.hands[seat], gs.board, gs.mustTile, room.rules);
      if (moves.length > 0) {
        gs.turnStartTime = Date.now();
        setTimer(room);
        broadcast(room);
        scheduleBotPlay(room);
        return;
      }
    }
    doPassTurn(room, seat);
  } else {
    // Standard: draw exactly one tile
    const tile = gs.graveyard.pop();
    gs.hands[seat].push(tile);
    gs.lastPlayedTile = null;
    gs.lastScore = 0;
    const moves = G.getValidMoves(gs.hands[seat], gs.board, gs.mustTile, room.rules);
    if (moves.length > 0) {
      // Playable tile drawn — let the player act
      gs.turnStartTime = Date.now();
      setTimer(room);
      broadcast(room);
      scheduleBotPlay(room);
    } else {
      // Still no moves — show the new tile briefly then auto-pass
      broadcast(room);
      doPassTurn(room, seat);
    }
  }
}

// ── Draw exactly ONE tile (human players — client handles loop via overlay) ───
function doDrawOneTile(room, seat) {
  const gs = room.gs;
  if (gs.status !== 'playing' || gs.currentSeat !== seat) return;
  if (gs.graveyard.length === 0) { doPassTurn(room, seat); return; }

  const tile = gs.graveyard.pop();
  gs.hands[seat].push(tile);
  gs.lastPlayedTile = null;
  gs.lastScore = 0;
  gs.turnStartTime = Date.now();
  setTimer(room);
  broadcast(room);
  // No auto-pass here — client graveyard overlay handles "draw more or play"
}

// ── Pass turn ─────────────────────────────────────────────────────────────────
function doPassTurn(room, seat) {
  const gs = room.gs;
  if (gs.status !== 'playing' || gs.currentSeat !== seat) return;

  gs.consecutivePasses++;
  gs.lastPlayedTile = null;
  gs.lastScore = 0;

  if (gs.consecutivePasses >= room.playerCount) {
    endRound(room, null, 'blocked');
    return;
  }
  nextTurn(room);
}

// ── Advance to next player ────────────────────────────────────────────────────
function nextTurn(room) {
  const gs = room.gs;
  gs.currentSeat = (gs.currentSeat + 1) % room.playerCount;
  gs.turnStartTime = Date.now();
  setTimer(room);
  broadcast(room);
  scheduleBotPlay(room);
}

// ── Add score for a seat (or team) ───────────────────────────────────────────
function addScore(room, seat, pts) {
  const gs = room.gs;
  if (room.playMode === 'teams') {
    const team = room.players.find(p => p.seat === seat)?.team;
    if (team) gs.scores[team] = (gs.scores[team] || 0) + pts;
  } else {
    gs.scores[seat] = (gs.scores[seat] || 0) + pts;
  }
}

function ownerOf(room, seat) {
  if (room.playMode === 'teams')
    return room.players.find(p => p.seat === seat)?.team;
  return seat;
}

function opponentOwners(room, winningSeat) {
  const winOwner = ownerOf(room, winningSeat);
  if (room.playMode === 'teams') {
    return winOwner === 'A' ? ['B'] : ['A'];
  }
  return room.players.map(p => p.seat).filter(s => s !== winningSeat);
}

// ── BOMB: single-play score ≥ 35 → immediate game over ───────────────────────
function endBomb(room, seat, pts) {
  clearTimer(room);
  const gs = room.gs;
  gs.status = 'game_over';
  const winnerOwner = ownerOf(room, seat);
  gs.gameWinner = String(winnerOwner);

  gs.roundResult = {
    reason:      'bomb',
    isBomb:      true,
    roundWinner: winnerOwner,
    roundPts:    pts,
    scoreAdded:  pts,
    pendingAdd:  0,
    pendingForfeited: false,
    pendingPts:  gs.pendingPts,
    pendingOwner: gs.pendingOwner,
    scores:      { ...gs.scores },
    gameWinner:  String(winnerOwner),
    hands: gs.hands.map((h, i) => ({
      seat: i,
      name: room.players.find(p => p.seat === i)?.name,
      hand: h,
      pipSum: G.pipSum(h, room.gameType === '101')
    }))
  };
  broadcast(room);
}

// ── End of round ──────────────────────────────────────────────────────────────
function endRound(room, winningSeat, reason) {
  clearTimer(room);
  const gs = room.gs;
  gs.status = 'round_over';

  const is101  = room.gameType === '101';
  const isTeams = room.playMode === 'teams';

  let roundPts = 0;
  let roundWinner = null; // team key or seat number

  if (reason === 'domino') {
    // Winner gets opponents' pip total
    roundWinner = ownerOf(room, winningSeat);
    gs.lastWinnerSeat = winningSeat;
    gs.lastBlockerSeat = null;

    const opps = opponentOwners(room, winningSeat);
    let oppPips = 0;
    if (isTeams) {
      const oppTeam = opps[0];
      room.players.filter(p => p.team === oppTeam)
        .forEach(p => { oppPips += G.pipSum(gs.hands[p.seat], is101); });
    } else {
      opps.forEach(s => { oppPips += G.pipSum(gs.hands[s], is101); });
    }
    roundPts = is101 ? oppPips : G.roundTo5(oppPips);

  } else {
    // Blocked — find team/player with lowest pip total
    gs.lastBlockerSeat = gs.currentSeat;
    gs.lastWinnerSeat  = null;

    // Calculate pip totals
    let teamPips = {};
    if (isTeams) {
      ['A', 'B'].forEach(tm => {
        let sum = 0;
        room.players.filter(p => p.team === tm)
          .forEach(p => { sum += G.pipSum(gs.hands[p.seat], is101); });
        teamPips[tm] = sum;
      });
      const [tmA, tmB] = [teamPips['A'], teamPips['B']];
      if (tmA < tmB)      { roundWinner = 'A'; roundPts = is101 ? tmB : G.roundTo5(tmB); }
      else if (tmB < tmA) { roundWinner = 'B'; roundPts = is101 ? tmA : G.roundTo5(tmA); }
      else                { roundWinner = null; roundPts = tmA; } // tie
    } else {
      room.players.forEach(p => { teamPips[p.seat] = G.pipSum(gs.hands[p.seat], is101); });
      const seats = Object.keys(teamPips).map(Number);
      const minPips = Math.min(...Object.values(teamPips));
      const winners = seats.filter(s => teamPips[s] === minPips);
      if (winners.length === 1) {
        roundWinner = winners[0];
        const opponentPips = seats.filter(s => s !== winners[0])
          .reduce((a, s) => a + teamPips[s], 0);
        roundPts = is101 ? opponentPips : G.roundTo5(opponentPips);
      } else {
        roundWinner = null;
        roundPts = minPips;
      }
    }
  }

  // ── Apply scoring rules ──────────────────────────────────────────────────────
  let pendingAdd = 0;
  let scoreAdded = 0;
  let pendingForfeited = false;

  if (roundWinner === null) {
    // Tie: roundPts go pending, cancel each other if same existing owner
    if (gs.pendingOwner === null) {
      gs.pendingPts  += roundPts;
      gs.pendingOwner = 'tie'; // held in limbo
    } else {
      gs.pendingPts += roundPts;
      // Keep same pending owner — next winner collects all
    }
  } else {
    if (is101) {
      // ── Forfeit opponent's pending when a different team wins ────────────────
      if (gs.pendingOwner && gs.pendingOwner !== roundWinner && gs.pendingOwner !== 'tie') {
        gs.pendingPts   = 0;
        gs.pendingOwner = null;
        pendingForfeited = true;
      }

      // ── "Threshold unlock" rule ──────────────────────────────────────────────
      // Once a team (or player) has actual points on the board (score > 0),
      // the 13-point threshold no longer applies to THEM for the rest of the game.
      // The other team's threshold status is tracked independently.
      // A round with roundPts >= 13 also unlocks and collects immediately.
      const alreadyUnlocked = (gs.scores[roundWinner] || 0) > 0;

      if (alreadyUnlocked || roundPts >= 13) {
        // Collect this round + any pending belonging to this winner
        const pendingBonus = (gs.pendingPts > 0 && gs.pendingOwner === roundWinner)
          ? gs.pendingPts : 0;
        const total = roundPts + pendingBonus;
        gs.scores[roundWinner] = (gs.scores[roundWinner] || 0) + total;
        scoreAdded = total;
        pendingAdd = pendingBonus;
        gs.pendingPts   = 0;
        gs.pendingOwner = null;
      } else {
        // Below threshold AND not yet unlocked → accumulate in pending
        if (gs.pendingOwner === roundWinner || gs.pendingOwner === null || gs.pendingOwner === 'tie') {
          gs.pendingPts  += roundPts;
          gs.pendingOwner = roundWinner;
        } else {
          // Forfeited above; start fresh pending for new winner
          gs.pendingPts  = roundPts;
          gs.pendingOwner = roundWinner;
        }
      }
    } else {
      // 5s — no threshold, add directly; also collect any pending from tie
      const total = roundPts + (gs.pendingOwner === roundWinner ? gs.pendingPts : gs.pendingOwner === 'tie' ? gs.pendingPts : 0);
      gs.scores[roundWinner] = (gs.scores[roundWinner] || 0) + total;
      scoreAdded = total;
      pendingAdd = gs.pendingPts;
      gs.pendingPts   = 0;
      gs.pendingOwner = null;
    }
  }

  // ── Check win condition ───────────────────────────────────────────────────────
  const TARGET = room.rules?.targetScore ?? (is101 ? 101 : 365);
  const overTarget = Object.entries(gs.scores).filter(([, v]) => v >= TARGET);

  if (overTarget.length > 0) {
    // Someone crossed target — find overall winner (highest score)
    const winnerKey = overTarget.sort((a, b) => b[1] - a[1])[0][0];
    gs.status  = 'game_over';
    gs.gameWinner = winnerKey;
  }

  gs.roundResult = {
    reason,
    roundWinner,
    roundPts,
    scoreAdded,
    pendingAdd,
    pendingForfeited,
    pendingPts:  gs.pendingPts,
    pendingOwner: gs.pendingOwner,
    scores: { ...gs.scores },
    gameWinner: gs.gameWinner || null,
    hands: gs.hands.map((h, i) => ({
      seat: i,
      name: room.players.find(p => p.seat === i)?.name,
      hand: h,
      pipSum: G.pipSum(h, is101)
    }))
  };

  broadcast(room);

  // Auto-start next round after 6 seconds (unless game over)
  if (gs.status !== 'game_over') {
    setTimeout(() => {
      if (rooms.has(room.code)) {
        gs.round++;
        startRound(room);
      }
    }, 6000);
  }
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  // ── CREATE ROOM ──────────────────────────────────────────────────────────────
  socket.on('create-room', ({ gameType, playerCount, playMode, hostName, rules }) => {
    const code = genCode();
    const defaultRules = { spinner: true, armsBoth: true, autoDrawLoop: true, redeal: true, bomb: true, timerSecs: 60, targetScore: gameType === '101' ? 101 : 365, optionalDraw: false };
    const merged = rules ? { ...defaultRules, ...rules } : { ...defaultRules };
    // 101 (Kozel) has no in-play scoring — spinner, armsBoth, bomb never apply
    if (gameType === '101') {
      merged.spinner  = false;
      merged.armsBoth = false;
      merged.bomb     = false;
    }
    const room = {
      code, gameType,
      playerCount,
      playMode: playerCount === 4 ? playMode : 'individual',
      hostId: socket.id,
      players: [{
        id: socket.id, name: hostName, seat: 0,
        team: null, isHost: true, connected: true
      }],
      status: 'lobby',
      rules: merged,
      gs: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.seat = 0;
    socket.emit('room-created', { code, room: lobbyRoom(room) });
    console.log(`[Room] ${code} created by ${hostName}`);
  });

  // ── JOIN ROOM ────────────────────────────────────────────────────────────────
  socket.on('join-room', ({ code, playerName }) => {
    const upper = code.toUpperCase();
    const room  = rooms.get(upper);
    if (!room) return socket.emit('join-error', { message: 'Room not found.' });

    // ── Reconnect path: game in progress, name matches an existing player ─────
    if (room.status !== 'lobby') {
      const player = room.players.find(p => p.name.toLowerCase() === playerName.toLowerCase());
      if (!player) return socket.emit('join-error', { message: 'Game already started.' });
      // Swap socket ID and mark connected
      player.id = socket.id;
      player.connected = true;
      socket.join(upper);
      socket.data.roomCode = upper;
      socket.data.seat = player.seat;
      socket.emit('game-update', stateFor(room, player.seat));
      io.to(upper).emit('player-reconnected', { playerName: player.name });
      console.log(`[Room] ${playerName} rejoined ${upper}`);
      return;
    }

    // Cancel pending delete timer if room was waiting for someone
    if (room._deleteTimer) { clearTimeout(room._deleteTimer); room._deleteTimer = null; }

    if (room.players.length >= room.playerCount) return socket.emit('join-error', { message: 'Room is full.' });
    if (room.players.some(p => p.name.toLowerCase() === playerName.toLowerCase()))
      return socket.emit('join-error', { message: 'Name already taken.' });

    const seat = room.players.length;
    room.players.push({ id: socket.id, name: playerName, seat, team: null, isHost: false, connected: true });
    socket.join(upper);
    socket.data.roomCode = upper;
    socket.data.seat = seat;
    socket.emit('room-joined', { room: lobbyRoom(room) });
    io.to(upper).emit('lobby-updated', { room: lobbyRoom(room) });
    console.log(`[Room] ${playerName} joined ${upper}`);
  });

  // ── ASSIGN TEAM ──────────────────────────────────────────────────────────────
  socket.on('assign-team', ({ code, playerId, team }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    const p = room.players.find(p => p.id === playerId);
    if (!p) return;

    // Enforce max 2 per team — reject if target team is already full
    if (team !== null) {
      const occupants = room.players.filter(pl => pl.id !== playerId && pl.team === team).length;
      if (occupants >= 2) return;
    }

    p.team = team;
    io.to(code).emit('lobby-updated', { room: lobbyRoom(room) });
  });

  // ── START GAME ───────────────────────────────────────────────────────────────
  socket.on('start-game', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < room.playerCount)
      return socket.emit('start-error', { message: `Need ${room.playerCount - room.players.length} more player(s).` });
    if (room.playMode === 'teams') {
      const a = room.players.filter(p => p.team === 'A').length;
      const b = room.players.filter(p => p.team === 'B').length;
      if (a !== 2 || b !== 2)
        return socket.emit('start-error', { message: 'Assign exactly 2 players to each team.' });
    }
    room.status = 'playing';
    startRound(room);
    console.log(`[Room] Game started in ${code}`);
  });

  // ── ADD BOT ──────────────────────────────────────────────────────────────────
  socket.on('add-bot', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    if (room.players.length >= room.playerCount)
      return socket.emit('start-error', { message: 'Room is full.' });
    const BOT_NAMES = ['BOT-Vas', 'BOT-Baku', 'BOT-Aze'];
    const usedBots = room.players.filter(p => p.isBot).map(p => p.name);
    const botName = BOT_NAMES.find(n => !usedBots.includes(n));
    if (!botName) return;
    const seat = room.players.length;
    room.players.push({
      id: `BOT_${seat}`, name: botName, seat,
      team: null, isHost: false, connected: true, isBot: true
    });
    io.to(code).emit('lobby-updated', { room: lobbyRoom(room) });
    console.log(`[Bot] ${botName} added to ${code}`);
  });

  // ── REMOVE BOT ───────────────────────────────────────────────────────────────
  socket.on('remove-bot', ({ code, botName }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    const idx = room.players.findIndex(p => p.isBot && p.name === botName);
    if (idx === -1) return;
    room.players.splice(idx, 1);
    room.players.forEach((p, i) => { p.seat = i; }); // reassign seats after removal
    io.to(code).emit('lobby-updated', { room: lobbyRoom(room) });
    console.log(`[Bot] ${botName} removed from ${code}`);
  });

  // ── REMATCH ──────────────────────────────────────────────────────────────────
  socket.on('rematch', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'game_over') return;
    // Tally this game's winner before resetting
    if (!room.wins) room.wins = {};
    const winner = room.gs?.gameWinner;
    if (winner !== undefined && winner !== null) {
      const key = String(winner);
      room.wins[key] = (room.wins[key] || 0) + 1;
    }
    // Reset for fresh game (room.gs = null → startRound initialises clean scores/round)
    room.gs = null;
    room.status = 'playing';
    startRound(room);
    console.log(`[Room] Rematch started in ${code}`);
  });

  // ── PLAY TILE ────────────────────────────────────────────────────────────────
  socket.on('play-tile', ({ tileIdx, side }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    doPlayTile(room, socket.data.seat, tileIdx, side);
  });

  // ── DRAW TILE ────────────────────────────────────────────────────────────────
  // Human players always draw one tile at a time; bots use the loop via autoPlay.
  socket.on('draw-tile', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const gs = room.gs;
    if (!gs) return;
    // Guard: block draw if player has valid moves AND optionalDraw rule is off
    if (!room.rules?.optionalDraw) {
      const moves = G.getValidMoves(gs.hands[socket.data.seat], gs.board, gs.mustTile, room.rules);
      if (moves.length > 0) return;
    }
    doDrawOneTile(room, socket.data.seat);
  });

  // ── PASS TURN ────────────────────────────────────────────────────────────────
  socket.on('pass-turn', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    doPassTurn(room, socket.data.seat);
  });

  // ── DISCONNECT ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    const pi = room.players.findIndex(p => p.id === socket.id);
    if (pi === -1) return;
    const player = room.players[pi];

    if (room.status === 'lobby') {
      room.players.splice(pi, 1);
      room.players.forEach((p, i) => p.seat = i);
      if (room.hostId === socket.id && room.players.length > 0) {
        room.hostId = room.players[0].id;
        room.players[0].isHost = true;
      }
      if (room.players.length === 0) {
        // Don't delete immediately — give 60s grace window for host to reconnect
        room._deleteTimer = setTimeout(() => {
          if (rooms.get(code)?.players.length === 0) {
            rooms.delete(code);
            console.log(`[Room] ${code} expired (empty)`);
          }
        }, 60000);
      } else {
        io.to(code).emit('player-left', { playerName: player.name });
        io.to(code).emit('lobby-updated', { room: lobbyRoom(room) });
      }
    } else {
      player.connected = false;
      io.to(code).emit('player-disconnected', { playerName: player.name });
      // If it's their turn, auto-play immediately
      if (room.gs && room.gs.currentSeat === player.seat) {
        clearTimer(room);
        setTimeout(() => autoPlay(room), 2000);
      }
    }
    console.log(`[-] ${player.name} left ${code}`);
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`\n🁣  Domino running at http://localhost:${PORT}\n`));