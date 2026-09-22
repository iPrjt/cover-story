/* COVER STORY — pure game engine. No I/O, no DOM, no network.
   Used by the Node server and (inlined) by the browser build. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoverStory = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_PLAYERS = 3;
  var MAX_PLAYERS = 8;
  var CLUE_MAX = 16;
  var GUESS_OPTIONS = 6;
  var CAUTION = 0.4;      /* how often a bot insider plays a safe, bland clue */
  var SUSPICION_NOISE = 5; /* how unreliable a bot's read of the table is */

  /* ---------- deterministic RNG (seedable, so games are reproducible in tests) ---------- */
  function makeRng(seed) {
    var s = (seed >>> 0) || 0x2f6e2b1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function shuffle(rng, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------- text helpers ---------- */
  function norm(s) { return String(s || '').trim().toLowerCase(); }
  function nameWords(locName) {
    return norm(locName).split(/[^a-z0-9]+/).filter(function (w) { return w.length > 2; });
  }

  var CLUE_RE = /^[\p{L}\p{N}][\p{L}\p{N}'’-]*$/u;

  /* Validate a clue against the rules the UI states. */
  function checkClue(word, loc, usedWords) {
    var w = String(word == null ? '' : word).trim();
    if (!w) return { ok: false, error: 'Type one word.' };
    if (/\s/.test(w)) return { ok: false, error: 'One word only — no spaces.' };
    if (w.length > CLUE_MAX) return { ok: false, error: 'Max ' + CLUE_MAX + ' characters.' };
    if (!CLUE_RE.test(w)) return { ok: false, error: 'Letters, numbers and hyphens only.' };
    var n = norm(w);
    if (loc) {
      if (n === norm(loc.name)) return { ok: false, error: "You can't say the location." };
      if (nameWords(loc.name).indexOf(n) !== -1) return { ok: false, error: "That word is in the location's name." };
    }
    if (usedWords && usedWords.some(function (u) { return norm(u) === n; })) {
      return { ok: false, error: 'Someone already said that. Pick another word.' };
    }
    return { ok: true, word: w };
  }

  /* ---------- game construction ---------- */
  function createGame(code, hostId, deck, opts) {
    opts = opts || {};
    return {
      code: code,
      deck: deck,
      phase: 'lobby',
      round: 0,
      totalRounds: opts.totalRounds || 5,
      hostId: hostId,
      players: [],
      seed: opts.seed || (Date.now() & 0x7fffffff),
      usedLocations: [],
      secret: null,
      clues: {},
      votes: {},
      moleGuess: null,
      result: null,
      deadline: 0,
      createdAt: Date.now()
    };
  }

  function findPlayer(g, id) {
    for (var i = 0; i < g.players.length; i++) if (g.players[i].id === id) return g.players[i];
    return null;
  }
  function activePlayers(g) { return g.players.filter(function (p) { return !p.left; }); }

  function addPlayer(g, id, name, isBot) {
    if (findPlayer(g, id)) { var ex = findPlayer(g, id); ex.left = false; return { ok: true, player: ex }; }
    if (activePlayers(g).length >= MAX_PLAYERS) return { ok: false, error: 'Room is full (8 players).' };
    if (g.phase !== 'lobby') return { ok: false, error: 'That game is already in progress.' };
    var p = { id: id, name: String(name || 'Player').slice(0, 18), isBot: !!isBot, score: 0, left: false };
    g.players.push(p);
    return { ok: true, player: p };
  }

  function removePlayer(g, id) {
    var p = findPlayer(g, id);
    if (!p) return;
    if (g.phase === 'lobby') g.players = g.players.filter(function (q) { return q.id !== id; });
    else p.left = true;
  }

  function locById(g, id) {
    for (var i = 0; i < g.deck.locations.length; i++) if (g.deck.locations[i].id === id) return g.deck.locations[i];
    return null;
  }

  /* ---------- round lifecycle ---------- */
  function startRound(g) {
    var live = activePlayers(g);
    if (live.length < MIN_PLAYERS) return { ok: false, error: 'Need at least ' + MIN_PLAYERS + ' players.' };

    var rng = makeRng(g.seed + g.round * 7919 + 13);
    g.round += 1;

    var pool = g.deck.locations.filter(function (l) { return g.usedLocations.indexOf(l.id) === -1; });
    if (!pool.length) { g.usedLocations = []; pool = g.deck.locations.slice(); }
    var loc = pick(rng, pool);
    g.usedLocations.push(loc.id);

    /* The mole rotates: prefer players who have been mole least often. */
    var counts = {};
    live.forEach(function (p) { counts[p.id] = p.moleCount || 0; });
    var min = Math.min.apply(null, live.map(function (p) { return counts[p.id]; }));
    var eligible = live.filter(function (p) { return counts[p.id] === min; });
    var mole = pick(rng, eligible);
    mole.moleCount = (mole.moleCount || 0) + 1;

    var sameCat = g.deck.locations.filter(function (l) { return l.cat === loc.cat && l.id !== loc.id; });
    var decoys = shuffle(rng, sameCat).slice(0, GUESS_OPTIONS - 1).map(function (l) { return l.id; });
    var options = shuffle(rng, [loc.id].concat(decoys));

    g.secret = { locationId: loc.id, cat: loc.cat, moleId: mole.id, options: options };
    g.clues = {};
    g.votes = {};
    g.moleGuess = null;
    g.result = null;
    g.phase = 'clue1';
    return { ok: true };
  }

  function clueIndex(g) { return g.phase === 'clue1' ? 0 : g.phase === 'clue2' ? 1 : -1; }

  function usedWordsThisRound(g) {
    var out = [];
    Object.keys(g.clues).forEach(function (pid) {
      (g.clues[pid] || []).forEach(function (w) { if (w) out.push(w); });
    });
    return out;
  }

  function submitClue(g, pid, word) {
    var idx = clueIndex(g);
    if (idx < 0) return { ok: false, error: 'Not the clue phase.' };
    var p = findPlayer(g, pid);
    if (!p || p.left) return { ok: false, error: 'You are not in this game.' };
    if (g.clues[pid] && g.clues[pid][idx]) return { ok: false, error: 'You already gave a clue this round.' };

    /* The mole never sees the location, so their word is only checked for shape + duplicates. */
    var loc = pid === g.secret.moleId ? null : locById(g, g.secret.locationId);
    var v = checkClue(word, loc, usedWordsThisRound(g));
    if (!v.ok) return v;

    if (!g.clues[pid]) g.clues[pid] = [];
    g.clues[pid][idx] = v.word;
    return { ok: true };
  }

  function allCluesIn(g) {
    var idx = clueIndex(g);
    if (idx < 0) return false;
    return activePlayers(g).every(function (p) { return g.clues[p.id] && g.clues[p.id][idx]; });
  }

  function submitVote(g, pid, targetId) {
    if (g.phase !== 'vote') return { ok: false, error: 'Not the voting phase.' };
    var p = findPlayer(g, pid);
    if (!p || p.left) return { ok: false, error: 'You are not in this game.' };
    if (targetId === pid) return { ok: false, error: "You can't vote for yourself." };
    var t = findPlayer(g, targetId);
    if (!t || t.left) return { ok: false, error: 'Pick a player still in the game.' };
    g.votes[pid] = targetId;
    return { ok: true };
  }

  function allVotesIn(g) {
    return activePlayers(g).every(function (p) { return g.votes[p.id]; });
  }

  function tally(g) {
    var counts = {};
    activePlayers(g).forEach(function (p) { counts[p.id] = 0; });
    Object.keys(g.votes).forEach(function (voter) {
      var t = g.votes[voter];
      if (counts[t] === undefined) counts[t] = 0;
      counts[t] += 1;
    });
    var max = 0;
    Object.keys(counts).forEach(function (id) { if (counts[id] > max) max = counts[id]; });
    var top = Object.keys(counts).filter(function (id) { return counts[id] === max && max > 0; });
    /* Caught only on a clear, untied plurality. A tie lets the mole walk. */
    var caught = top.length === 1 && top[0] === g.secret.moleId;
    return { counts: counts, top: top, max: max, caught: caught };
  }

  function submitMoleGuess(g, locationId) {
    if (g.phase !== 'lastword') return { ok: false, error: 'Not the last-word phase.' };
    if (g.secret.options.indexOf(locationId) === -1) return { ok: false, error: 'Not one of the options.' };
    g.moleGuess = locationId;
    return { ok: true };
  }

  /* Scoring. Pure with respect to inputs; mutates player scores once. */
  function scoreRound(g) {
    var t = tally(g);
    var mole = findPlayer(g, g.secret.moleId);
    var loc = locById(g, g.secret.locationId);
    var deltas = {};
    activePlayers(g).forEach(function (p) { deltas[p.id] = 0; });
    if (deltas[mole.id] === undefined) deltas[mole.id] = 0;

    /* +1 to anyone who fingered the mole, win or lose. */
    Object.keys(g.votes).forEach(function (voter) {
      if (g.votes[voter] === g.secret.moleId && voter !== g.secret.moleId) {
        deltas[voter] = (deltas[voter] || 0) + 1;
      }
    });

    var guessRight = false;
    if (t.caught) {
      activePlayers(g).forEach(function (p) {
        if (p.id !== g.secret.moleId) deltas[p.id] += 2;
      });
      guessRight = g.moleGuess === g.secret.locationId;
      if (guessRight) deltas[mole.id] += 3;
    } else {
      deltas[mole.id] += 4;
    }

    Object.keys(deltas).forEach(function (id) {
      var p = findPlayer(g, id);
      if (p) p.score += deltas[id];
    });

    g.result = {
      round: g.round,
      caught: t.caught,
      counts: t.counts,
      top: t.top,
      moleId: g.secret.moleId,
      moleName: mole ? mole.name : '?',
      locationId: g.secret.locationId,
      locationName: loc ? loc.name : '?',
      moleGuess: g.moleGuess,
      moleGuessName: g.moleGuess ? (locById(g, g.moleGuess) || {}).name : null,
      guessRight: guessRight,
      deltas: deltas,
      votes: Object.assign({}, g.votes)
    };
    return g.result;
  }

  /* Phase machine. Call when a submission completes or a timer fires. */
  function advance(g) {
    if (g.phase === 'clue1') { g.phase = 'clue2'; return g.phase; }
    if (g.phase === 'clue2') { g.phase = 'vote'; return g.phase; }
    if (g.phase === 'vote') {
      var t = tally(g);
      if (t.caught) { g.phase = 'lastword'; return g.phase; }
      scoreRound(g);
      g.phase = 'reveal';
      return g.phase;
    }
    if (g.phase === 'lastword') {
      scoreRound(g);
      g.phase = 'reveal';
      return g.phase;
    }
    if (g.phase === 'reveal') {
      if (g.round >= g.totalRounds) { g.phase = 'gameover'; return g.phase; }
      startRound(g);
      return g.phase;
    }
    return g.phase;
  }

  function standings(g) {
    return g.players.slice().sort(function (a, b) {
      return b.score - a.score || a.name.localeCompare(b.name);
    });
  }

  /* ---------- bots ---------- */
  /* Insider bots draw on the location's association list; the mole bot
     falls back to bland category words, exactly like a bluffing human. */
  function botClue(g, pid) {
    var idx = clueIndex(g);
    var seat = 0;
    for (var k = 0; k < g.players.length; k++) if (g.players[k].id === pid) seat = k;
    var rng = makeRng(g.seed + g.round * 31 + seat * 7717 + (idx + 1) * 101 + 5);
    var used = usedWordsThisRound(g);
    var loc = locById(g, g.secret.locationId);
    var isMole = pid === g.secret.moleId;
    var generics = (g.deck.categories[g.secret.cat] || []).slice();
    var neighbours = g.deck.locations
      .filter(function (l) { return l.cat === g.secret.cat && l.id !== g.secret.locationId; })
      .reduce(function (acc, l) { return acc.concat(l.assoc); }, []);

    /* Insiders lead with the location's own vocabulary and thin out into
       bland category words. The mole has only the category, so it works the
       other way round — which is exactly what makes a mole findable. */
    /* Real insiders hedge: saying the most obvious word is how you get
       read, and how you hand the mole a free ride. So a bot insider plays
       it safe a fair share of the time. */
    var seatSkill = ((seat * 2654435761) % 1000) / 1000;  /* stable per seat */
    var cautious = rng() < (CAUTION - 0.15 + seatSkill * 0.3);
    var tiers = isMole
      ? [shuffle(rng, neighbours), shuffle(rng, generics)]
      : cautious
        ? [shuffle(rng, generics), shuffle(rng, neighbours), shuffle(rng, loc.assoc)]
        : [shuffle(rng, loc.assoc), shuffle(rng, generics)];

    for (var t = 0; t < tiers.length; t++) {
      for (var i = 0; i < tiers[t].length; i++) {
        if (checkClue(tiers[t][i], isMole ? null : loc, used).ok) return tiers[t][i];
      }
    }
    /* Guaranteed distinct per seat, round and phase — a bot never stalls a game. */
    return 'clue' + seat + '-' + g.round + (idx + 1);
  }

  /* A bot insider suspects whoever's clues sit furthest from the location.
     A bot mole votes for a plausible innocent — never itself. */
  function botVote(g, pid) {
    var seat = 0;
    for (var k = 0; k < g.players.length; k++) if (g.players[k].id === pid) seat = k;
    var rng = makeRng(g.seed + g.round * 577 + seat * 9173 + 29);
    var others = activePlayers(g).filter(function (p) { return p.id !== pid; });
    if (!others.length) return null;

    if (pid === g.secret.moleId) {
      /* The mole deflects onto whoever looks quietest, never onto itself. */
      var innocents = others.filter(function (p) { return p.id !== g.secret.moleId; });
      return pick(rng, innocents.length ? innocents : others).id;
    }

    var loc = locById(g, g.secret.locationId);
    var assoc = loc.assoc.map(norm);
    var generics = (g.deck.categories[g.secret.cat] || []).map(norm);

    var scored = others.map(function (p) {
      var words = (g.clues[p.id] || []).filter(Boolean).map(norm);
      var s = 0;
      words.forEach(function (w) {
        if (assoc.indexOf(w) !== -1) s += 3;            /* unmistakably inside */
        else if (generics.indexOf(w) !== -1) s += 1.2;  /* safe, could be either */
        else s += 1.6;                                   /* off-list but specific */
      });
      /* Bots are not oracles: a wide jitter keeps them beatable and keeps
         innocent players in real danger, which is the point of the game. */
      return { id: p.id, s: s + rng() * SUSPICION_NOISE };
    });
    scored.sort(function (a, b) { return a.s - b.s; });
    return scored[0].id;
  }

  return {
    MIN_PLAYERS: MIN_PLAYERS, MAX_PLAYERS: MAX_PLAYERS, CLUE_MAX: CLUE_MAX,
    _tune: function (c, n) { CAUTION = c; SUSPICION_NOISE = n; },
    makeRng: makeRng, shuffle: shuffle, pick: pick, norm: norm,
    checkClue: checkClue, createGame: createGame, addPlayer: addPlayer, removePlayer: removePlayer,
    findPlayer: findPlayer, activePlayers: activePlayers, locById: locById,
    startRound: startRound, submitClue: submitClue, allCluesIn: allCluesIn, clueIndex: clueIndex,
    submitVote: submitVote, allVotesIn: allVotesIn, tally: tally, submitMoleGuess: submitMoleGuess,
    scoreRound: scoreRound, advance: advance, standings: standings,
    botClue: botClue, botVote: botVote, usedWordsThisRound: usedWordsThisRound
  };
});
