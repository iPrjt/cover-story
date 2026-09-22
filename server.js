/* COVER STORY — game server.
   One tiny Node process: static files + a WebSocket room server.
   The secret (who the mole is, where the location is) never leaves this file
   for a player who shouldn't have it — each client gets its own view. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const E = require('./engine.js');
const V = require('./view.js');
const deck = require('./deck.json');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

/* ---- phase clocks (ms) ---- */
const LIMITS = { clue1: 75000, clue2: 75000, vote: 60000, lastword: 30000, reveal: 25000 };
const BOT_DELAY = [1200, 4200];      // bots think for a beat, so they feel like players
const ROOM_TTL = 1000 * 60 * 90;     // an idle room is swept after 90 minutes

/* ---- static file serving ---- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  let rel = url === '/' ? '/index.html' : url;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // Unknown paths fall back to the app so /ABCD style links work.
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': TYPES['.html'] }); res.end(idx);
      });
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

/* ---- rooms ---- */
const rooms = new Map();   // code -> { game, sockets:Map(pid->ws), timer, timerEnds, touched }

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no look-alikes
function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
function newId() { return 'p' + Math.random().toString(36).slice(2, 10); }

function makeRoom(hostId) {
  const code = newCode();
  const room = { code, game: E.createGame(code, hostId, deck, { totalRounds: 5 }),
                 sockets: new Map(), timer: null, timerEnds: 0, touched: Date.now(), botTimers: [] };
  rooms.set(code, room);
  return room;
}

/* ---- per-player view ---- */
function viewFor(room, pid) {
  return V.buildView(room.game, pid, {
    online: function (id) { return room.sockets.has(id); },
    deadline: room.timerEnds || 0
  });
}

function broadcast(room) {
  room.touched = Date.now();
  for (const [pid, ws] of room.sockets) {
    if (ws.readyState === 1) { try { ws.send(JSON.stringify(viewFor(room, pid))); } catch (_) {} }
  }
}
function sendErr(ws, msg) {
  if (ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'error', message: msg })); } catch (_) {} }
}

/* ---- timers ---- */
function clearTimers(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.botTimers.forEach(clearTimeout); room.botTimers = [];
  room.timerEnds = 0;
}

function armPhase(room) {
  clearTimers(room);
  const g = room.game;
  const limit = LIMITS[g.phase];
  if (!limit) return;
  room.timerEnds = Date.now() + limit;
  room.timer = setTimeout(() => onTimeout(room), limit);
  scheduleBots(room);
}

function scheduleBots(room) {
  const g = room.game;
  const bots = E.activePlayers(g).filter(p => p.isBot);
  bots.forEach(bot => {
    const delay = BOT_DELAY[0] + Math.random() * (BOT_DELAY[1] - BOT_DELAY[0]);
    room.botTimers.push(setTimeout(() => {
      const gg = room.game;
      if (gg.phase === 'clue1' || gg.phase === 'clue2') {
        if (!(gg.clues[bot.id] && gg.clues[bot.id][E.clueIndex(gg)])) {
          E.submitClue(gg, bot.id, E.botClue(gg, bot.id));
        }
      } else if (gg.phase === 'vote') {
        if (!gg.votes[bot.id]) E.submitVote(gg, bot.id, E.botVote(gg, bot.id));
      } else if (gg.phase === 'lastword' && gg.secret.moleId === bot.id) {
        const opts = gg.secret.options;
        E.submitMoleGuess(gg, opts[Math.floor(Math.random() * opts.length)]);
      } else return;
      maybeAdvance(room);
      broadcast(room);
    }, delay));
  });
}

/* Move on as soon as everyone has acted — never make players wait out a clock. */
function maybeAdvance(room) {
  const g = room.game;
  if ((g.phase === 'clue1' || g.phase === 'clue2') && E.allCluesIn(g)) { step(room); return true; }
  if (g.phase === 'vote' && E.allVotesIn(g)) { step(room); return true; }
  if (g.phase === 'lastword' && g.moleGuess) { step(room); return true; }
  return false;
}

function step(room) {
  E.advance(room.game);
  armPhase(room);
}

function onTimeout(room) {
  const g = room.game;
  if (g.phase === 'clue1' || g.phase === 'clue2') {
    // A player who ran out of time gets a stand-in word rather than a dead round.
    E.activePlayers(g).forEach(p => {
      if (!(g.clues[p.id] && g.clues[p.id][E.clueIndex(g)])) E.submitClue(g, p.id, E.botClue(g, p.id));
    });
  }
  // Missing votes simply abstain; a missing mole guess counts as wrong.
  step(room);
  broadcast(room);
}

/* If the host disappears, the longest-present human takes over so the game lives on. */
function ensureHost(room) {
  const g = room.game;
  const host = E.findPlayer(g, g.hostId);
  const hostOnline = host && !host.left && room.sockets.has(g.hostId);
  if (hostOnline) return;
  const heir = g.players.find(p => !p.left && !p.isBot && room.sockets.has(p.id));
  if (heir) g.hostId = heir.id;
}

/* ---- websocket ---- */
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  let room = null, pid = null;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    const g = room && room.game;

    switch (m.t) {
      case 'create': {
        pid = m.pid || newId();
        room = makeRoom(pid);
        E.addPlayer(room.game, pid, m.name, false);
        room.sockets.set(pid, ws);
        ws.send(JSON.stringify({ t: 'joined', code: room.code, pid }));
        broadcast(room);
        break;
      }
      case 'join': {
        const code = String(m.code || '').toUpperCase().trim();
        const r = rooms.get(code);
        if (!r) return sendErr(ws, 'No game with that code. Check the four letters.');
        pid = m.pid || newId();
        const existing = E.findPlayer(r.game, pid);
        if (!existing) {
          const res = E.addPlayer(r.game, pid, m.name, false);
          if (!res.ok) return sendErr(ws, res.error);
        } else {
          existing.left = false;
          if (m.name) existing.name = String(m.name).slice(0, 18);
        }
        room = r;
        room.sockets.set(pid, ws);
        ensureHost(room);
        ws.send(JSON.stringify({ t: 'joined', code: room.code, pid }));
        broadcast(room);
        break;
      }
      case 'addBot': {
        if (!room || g.hostId !== pid) return;
        if (g.phase !== 'lobby') return sendErr(ws, 'Add bots before the game starts.');
        const names = ['Robin', 'Ash', 'Wren', 'Nico', 'Sol', 'Rex', 'Indy'];
        const taken = g.players.map(p => p.name);
        const name = names.find(n => !taken.includes(n)) || ('Bot' + g.players.length);
        const res = E.addPlayer(g, 'bot_' + name.toLowerCase(), name, true);
        if (!res.ok) return sendErr(ws, res.error);
        broadcast(room);
        break;
      }
      case 'removeBot': {
        if (!room || g.hostId !== pid || g.phase !== 'lobby') return;
        const bots = g.players.filter(p => p.isBot);
        if (bots.length) E.removePlayer(g, bots[bots.length - 1].id);
        broadcast(room);
        break;
      }
      case 'rounds': {
        if (!room || g.hostId !== pid || g.phase !== 'lobby') return;
        const n = Math.max(1, Math.min(10, parseInt(m.value, 10) || 5));
        g.totalRounds = n;
        broadcast(room);
        break;
      }
      case 'start': {
        if (!room || g.hostId !== pid) return;
        if (g.phase !== 'lobby') return;
        const res = E.startRound(g);
        if (!res.ok) return sendErr(ws, res.error);
        armPhase(room);
        broadcast(room);
        break;
      }
      case 'clue': {
        if (!room) return;
        const res = E.submitClue(g, pid, m.word);
        if (!res.ok) return sendErr(ws, res.error);
        maybeAdvance(room);
        broadcast(room);
        break;
      }
      case 'vote': {
        if (!room) return;
        const res = E.submitVote(g, pid, m.target);
        if (!res.ok) return sendErr(ws, res.error);
        maybeAdvance(room);
        broadcast(room);
        break;
      }
      case 'guess': {
        if (!room || g.secret.moleId !== pid) return;
        const res = E.submitMoleGuess(g, m.location);
        if (!res.ok) return sendErr(ws, res.error);
        maybeAdvance(room);
        broadcast(room);
        break;
      }
      case 'next': {
        if (!room || g.hostId !== pid || g.phase !== 'reveal') return;
        step(room);
        broadcast(room);
        break;
      }
      case 'again': {
        if (!room || g.hostId !== pid || g.phase !== 'gameover') return;
        g.players.forEach(p => { p.score = 0; p.moleCount = 0; p.left = p.left && !room.sockets.has(p.id); });
        g.players = g.players.filter(p => !p.left);
        g.round = 0; g.phase = 'lobby'; g.secret = null; g.result = null;
        g.usedLocations = []; g.seed = Date.now() & 0x7fffffff;
        clearTimers(room);
        broadcast(room);
        break;
      }
      case 'ping': {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'pong' }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!room || !pid) return;
    if (room.sockets.get(pid) === ws) room.sockets.delete(pid);
    const g = room.game;
    if (g.phase === 'lobby') E.removePlayer(g, pid);
    ensureHost(room);
    broadcast(room);
  });
});

/* sweep idle rooms so a long-running free instance stays tidy */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.sockets.size === 0 && now - room.touched > ROOM_TTL) {
      clearTimers(room); rooms.delete(code);
    }
  }
}, 60000);

server.listen(PORT, () => console.log('COVER STORY listening on ' + PORT));

module.exports = { server, rooms };
