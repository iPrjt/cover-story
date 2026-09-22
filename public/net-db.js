/* Quick-play transport for the published page.
   There is no server here, so one player's browser acts as the table: it holds
   the authoritative game, reads everyone's moves from the shared store and
   writes the result back. If that player closes the tab, the next one at the
   table picks the game up where it stopped. */
window.Net = (function () {
  'use strict';

  var E = window.CoverStory, V = window.CoverView;
  var handlers = [];
  var db = null, room = null, user = null;
  var myId = null, myName = 'Player';
  var code = null, gameRef = null, actionsRef = null;
  var game = null;
  var unsubGame = null, unsubActions = null;
  var isHost = false;
  var actionN = 0, seenN = {};
  var peers = {};                 // pid -> last seen (ms), from the presence channel
  var loop = null, dirty = false, lastWrite = 0, writing = false;
  var booted = false;

  var HOST_GRACE = 9000;          // how long a silent host keeps the table
  var KEEPALIVE = 12000;          // heartbeat while a round is running

  function emit(m) { handlers.forEach(function (h) { h(m); }); }
  function fail(msg) { emit({ t: 'error', message: msg }); }
  function now() { return Date.now(); }

  /* ---------- identity ---------- */
  function localId() {
    var k = 'cs_local_id', v = null;
    try { v = localStorage.getItem(k); } catch (_) {}
    if (!v) {
      v = 'p' + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem(k, v); } catch (_) {}
    }
    return v;
  }

  /* ---------- (de)serialising the table ---------- */
  function pack(g) {
    return {
      code: g.code, phase: g.phase, round: g.round, totalRounds: g.totalRounds,
      hostId: g.hostId, hostBeat: now(), seed: g.seed,
      players: g.players.map(function (p) {
        return { id: p.id, name: p.name, isBot: !!p.isBot, score: p.score,
                 left: !!p.left, moleCount: p.moleCount || 0 };
      }),
      usedLocations: g.usedLocations, secret: g.secret, clues: g.clues,
      votes: g.votes, moleGuess: g.moleGuess, result: g.result,
      deadline: g.deadline || 0, createdAt: g.createdAt
    };
  }
  function unpack(d) {
    var g = E.createGame(d.code, d.hostId, window.DECK, { totalRounds: d.totalRounds, seed: d.seed });
    ['phase', 'round', 'totalRounds', 'hostId', 'hostBeat', 'seed', 'players', 'usedLocations',
     'secret', 'clues', 'votes', 'moleGuess', 'result', 'deadline', 'createdAt'].forEach(function (k) {
      if (d[k] !== undefined) g[k] = d[k];
    });
    g.clues = g.clues || {}; g.votes = g.votes || {}; g.players = g.players || [];
    return g;
  }

  function commit(force) {
    if (!isHost || !gameRef || !game) return;
    dirty = true;
    if (writing) return;
    var since = now() - lastWrite;
    if (!force && since < 350) { setTimeout(function () { commit(true); }, 350 - since); return; }
    writing = true; dirty = false; lastWrite = now();
    gameRef.set(pack(game))
      .catch(function () { /* a lost write is re-sent by the next change */ })
      .then(function () { writing = false; if (dirty) commit(true); });
  }

  /* ---------- host duties ---------- */
  function hostOnline() {
    if (!game) return false;
    if (game.hostId === myId) return true;
    var p = peers[game.hostId];
    if (p && now() - p < HOST_GRACE) return true;
    if (!room && game.hostBeat && now() - game.hostBeat < KEEPALIVE * 2) return true;
    return false;
  }

  function maybeTakeOver() {
    if (!game || isHost || hostOnline() || !gameRef) return;
    // Only the lowest-id present human tries, so eight tabs don't all grab at once.
    var contenders = Object.keys(peers)
      .filter(function (id) { return now() - peers[id] < HOST_GRACE; });
    if (contenders.indexOf(myId) === -1) contenders.push(myId);
    contenders.sort();
    if (contenders[0] !== myId) return;

    gameRef.acquire({ holder: myId, ttlMs: 8000 }).then(function (res) {
      if (!res || !res.acquired || !game) return;
      isHost = true;
      game.hostId = myId;
      startLoop();
      commit(true);
    }).catch(function () {});
  }

  function armPhase() {
    var limits = { clue1: 75000, clue2: 75000, vote: 60000, lastword: 30000, reveal: 25000 };
    game.deadline = limits[game.phase] ? now() + limits[game.phase] : 0;
  }

  function step() { E.advance(game); armPhase(); commit(true); }

  function hostTick() {
    if (!isHost || !game) { return; }
    var g = game, changed = false;

    /* bots act a beat after the phase opens */
    if (g.phase === 'clue1' || g.phase === 'clue2') {
      E.activePlayers(g).filter(function (p) { return p.isBot; }).forEach(function (b) {
        if (!(g.clues[b.id] && g.clues[b.id][E.clueIndex(g)])) {
          if (now() > (g.deadline - 71000)) { E.submitClue(g, b.id, E.botClue(g, b.id)); changed = true; }
        }
      });
    } else if (g.phase === 'vote') {
      E.activePlayers(g).filter(function (p) { return p.isBot; }).forEach(function (b) {
        if (!g.votes[b.id] && now() > (g.deadline - 56000)) {
          E.submitVote(g, b.id, E.botVote(g, b.id)); changed = true;
        }
      });
    } else if (g.phase === 'lastword') {
      var mole = E.findPlayer(g, g.secret.moleId);
      if (mole && mole.isBot && !g.moleGuess && now() > (g.deadline - 26000)) {
        E.submitMoleGuess(g, g.secret.options[Math.floor(Math.random() * g.secret.options.length)]);
        changed = true;
      }
    }

    /* everyone has acted — move on without waiting for the clock */
    if ((g.phase === 'clue1' || g.phase === 'clue2') && E.allCluesIn(g)) { step(); return; }
    if (g.phase === 'vote' && E.allVotesIn(g)) { step(); return; }
    if (g.phase === 'lastword' && g.moleGuess) { step(); return; }

    /* the clock ran out */
    if (g.deadline && now() > g.deadline) {
      if (g.phase === 'clue1' || g.phase === 'clue2') {
        E.activePlayers(g).forEach(function (p) {
          if (!(g.clues[p.id] && g.clues[p.id][E.clueIndex(g)])) E.submitClue(g, p.id, E.botClue(g, p.id));
        });
      }
      step(); return;
    }

    if (changed) { commit(); return; }
    if (now() - lastWrite > KEEPALIVE && g.phase !== 'lobby' && g.phase !== 'gameover') commit(true);
  }

  function startLoop() {
    clearInterval(loop);
    loop = setInterval(function () {
      if (isHost) hostTick(); else maybeTakeOver();
      sendPresence();
    }, 1000);
  }

  /* ---------- actions ---------- */
  function apply(pid, a) {
    var g = game;
    if (!g) return;
    var host = g.hostId === pid;
    switch (a.type) {
      case 'join': {
        var ex = E.findPlayer(g, pid);
        if (ex) { ex.left = false; if (a.name) ex.name = String(a.name).slice(0, 18); }
        else E.addPlayer(g, pid, a.name, false);
        break;
      }
      case 'leave': E.removePlayer(g, pid); break;
      case 'rounds':
        if (host && g.phase === 'lobby') g.totalRounds = Math.max(1, Math.min(10, a.value | 0));
        break;
      case 'addBot': {
        if (!host || g.phase !== 'lobby') break;
        var names = ['Robin', 'Ash', 'Wren', 'Nico', 'Sol', 'Rex', 'Indy'];
        var taken = g.players.map(function (p) { return p.name; });
        var nm = names.filter(function (n) { return taken.indexOf(n) === -1; })[0] || ('Bot' + g.players.length);
        E.addPlayer(g, 'bot_' + nm.toLowerCase(), nm, true);
        break;
      }
      case 'removeBot': {
        if (!host || g.phase !== 'lobby') break;
        var bots = g.players.filter(function (p) { return p.isBot; });
        if (bots.length) E.removePlayer(g, bots[bots.length - 1].id);
        break;
      }
      case 'start':
        if (host && g.phase === 'lobby' && E.startRound(g).ok) armPhase();
        break;
      case 'clue': E.submitClue(g, pid, a.word); break;
      case 'vote': E.submitVote(g, pid, a.target); break;
      case 'guess': if (g.secret && g.secret.moleId === pid) E.submitMoleGuess(g, a.location); break;
      case 'next': if (host && g.phase === 'reveal') { E.advance(g); armPhase(); } break;
      case 'again':
        if (!host || g.phase !== 'gameover') break;
        g.players.forEach(function (p) { p.score = 0; p.moleCount = 0; });
        g.players = g.players.filter(function (p) { return !p.left; });
        g.round = 0; g.phase = 'lobby'; g.secret = null; g.result = null;
        g.usedLocations = []; g.seed = now() & 0x7fffffff; g.deadline = 0;
        break;
    }
    commit();
  }

  function pushAction(a) {
    if (!actionsRef) return;
    actionN++;
    a.n = actionN; a.at = now(); a.name = a.name || myName;
    if (isHost) { seenN[myId] = actionN; apply(myId, a); }
    actionsRef.doc(myId).set(a).catch(function () {
      fail('That did not reach the table — check your connection and try again.');
    });
  }

  /* ---------- presence ---------- */
  function sendPresence() {
    peers[myId] = now();
    if (room) { try { room.presence({ pid: myId, at: now() }); } catch (_) {} }
  }
  function onlineNow(pid) {
    if (pid === myId) return true;
    if (!room) return true;                       // no presence channel: assume present
    return !!peers[pid] && now() - peers[pid] < HOST_GRACE;
  }

  /* ---------- rendering out ---------- */
  function publishState() {
    if (!game || !code) return;
    emit(V.buildView(game, myId, { online: onlineNow, deadline: game.deadline || 0 }));
  }

  /* ---------- wiring a room ---------- */
  function attach(c, asHost) {
    code = c;
    gameRef = db.doc('rooms/' + code);
    actionsRef = db.collection('rooms/' + code + '/actions');
    isHost = !!asHost;

    if (unsubGame) unsubGame();
    unsubGame = gameRef.onSnapshot(function (snap) {
      if (!snap.exists) return;
      var d = snap.data();
      if (isHost && d.hostId !== myId) isHost = false;   // somebody else took the table
      if (!isHost || !game) game = unpack(d);
      publishState();
    }, function () {
      fail('Lost the connection to this game. Reload the page to rejoin.');
    });

    if (unsubActions) unsubActions();
    unsubActions = actionsRef.onSnapshot(function (snap) {
      if (!isHost) return;
      snap.docs.forEach(function (doc) {
        var a = doc.data();
        if (!a || typeof a.n !== 'number') return;
        if ((seenN[doc.id] || 0) >= a.n) return;
        seenN[doc.id] = a.n;
        apply(doc.id, a);
      });
    }, function () {});

    startLoop();
    sendPresence();
    emit({ t: 'joined', code: code, pid: myId });
  }

  /* ---------- boot ---------- */
  function boot() {
    if (booted) return Promise.resolve();
    booted = true;
    var C = window.claude;
    if (!C || !C.use) { fail('This game needs to run on its published page.'); return Promise.resolve(); }

    return Promise.all([
      C.use('db').catch(function () { return null; }),
      C.use('user').catch(function () { return null; }),
      C.use('room').catch(function () { return null; })
    ]).then(function (r) {
      db = r[0]; user = r[1]; room = r[2];
      if (!db) { fail('Shared play is not available in this view. Open the published page while signed in.'); return; }

      if (room) {
        try {
          room.onPeers(function (list) {
            (list || []).forEach(function (p) {
              var st = p && (p.state || p.presence || p);
              if (st && st.pid) peers[st.pid] = now();
            });
          });
        } catch (_) { room = null; }
      }

      if (user && user.id) {
        return user.id().then(function (id) {
          myId = id || localId();
          return user.me ? user.me().catch(function () { return null; }) : null;
        }).then(function (me) {
          if (me && me.name) myName = me.name;
        }).catch(function () { myId = localId(); });
      }
      myId = localId();
    }).then(function () {
      if (!myId) myId = localId();
    });
  }

  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function newCode() {
    var c = '';
    for (var i = 0; i < 4; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return c;
  }

  return {
    suggestedName: function () { return myName === 'Player' ? '' : myName; },

    start: function () { boot(); },

    create: function (name) {
      boot().then(function () {
        if (!db) return;
        myName = name || myName;
        var c = newCode();
        game = E.createGame(c, myId, window.DECK, { totalRounds: 5 });
        E.addPlayer(game, myId, myName, false);
        game.deadline = 0;
        attach(c, true);
        commit(true);
      });
    },

    join: function (c, name) {
      boot().then(function () {
        if (!db) return;
        myName = name || myName;
        db.doc('rooms/' + c).get().then(function (snap) {
          if (!snap.exists) { fail('No game with that code. Check the four characters.'); return; }
          game = unpack(snap.data());
          attach(c, game.hostId === myId);
          pushAction({ type: 'join', name: myName });
        }).catch(function () {
          fail('Could not reach that game. Try again in a moment.');
        });
      });
    },

    send: function (m) {
      if (!game) return;
      /* Validate locally first: the answer is instant and the table stays clean. */
      if (m.t === 'clue') {
        var amMole = game.secret && game.secret.moleId === myId;
        var loc = amMole ? null : E.locById(game, game.secret.locationId);
        var v = E.checkClue(m.word, loc, E.usedWordsThisRound(game));
        if (!v.ok) { fail(v.error); return; }
        pushAction({ type: 'clue', word: v.word });
        return;
      }
      if (m.t === 'vote') {
        if (m.target === myId) { fail("You can't vote for yourself."); return; }
        pushAction({ type: 'vote', target: m.target });
        return;
      }
      if (m.t === 'guess') { pushAction({ type: 'guess', location: m.location }); return; }
      pushAction({ type: m.t, value: m.value });
    },

    on: function (h) { handlers.push(h); },

    /* Leave the table cleanly — stops this tab claiming to be the host. */
    stop: function () {
      clearInterval(loop); loop = null;
      isHost = false;
      if (unsubGame) { unsubGame(); unsubGame = null; }
      if (unsubActions) { unsubActions(); unsubActions = null; }
    }
  };
})();
