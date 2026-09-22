const E = require('./engine.js');
const deck = require('./deck.json');
let fails = 0;
function ok(cond, msg) { if (!cond) { fails++; if (fails <= 20) console.log('  FAIL:', msg); } }
function eq(a, b, msg) { if (a !== b) { fails++; console.log('  FAIL:', msg, '| got', JSON.stringify(a), 'want', JSON.stringify(b)); } }

/* ---- 1. clue validation ---- */
const loc = deck.locations.find(l => l.id === 'airport');
ok(!E.checkClue('', loc, []).ok, 'empty rejected');
ok(!E.checkClue('two words', loc, []).ok, 'spaces rejected');
ok(!E.checkClue('averyveryverylongword', loc, []).ok, 'too long rejected');
ok(!E.checkClue('AIRPORT', loc, []).ok, 'location word rejected (case-insensitive)');
ok(!E.checkClue('terminal', loc, []).ok, 'second location word rejected');
ok(!E.checkClue('gate', loc, ['Gate']).ok, 'duplicate rejected case-insensitively');
ok(E.checkClue('gate', loc, []).ok, 'normal word accepted');
ok(E.checkClue('duty-free', loc, []).ok, 'hyphen accepted');
ok(E.checkClue("queue", loc, []).ok, 'plain word accepted');
ok(!E.checkClue('bad!', loc, []).ok, 'punctuation rejected');
ok(E.checkClue('anything', null, []).ok, 'mole clue skips location check');

/* ---- 2. explicit scoring scenarios ---- */
function rig(nPlayers) {
  const g = E.createGame('TEST', 'p0', deck, { totalRounds: 1, seed: 42 });
  for (let i = 0; i < nPlayers; i++) E.addPlayer(g, 'p' + i, 'P' + i, false);
  E.startRound(g);
  return g;
}

// (a) mole caught cleanly, guesses wrong
{
  const g = rig(4);
  const mole = g.secret.moleId;
  const others = g.players.filter(p => p.id !== mole).map(p => p.id);
  g.phase = 'vote';
  others.forEach(id => { g.votes[id] = mole; });
  g.votes[mole] = others[0];
  eq(E.advance(g), 'lastword', 'clean catch goes to lastword');
  const wrong = g.secret.options.find(o => o !== g.secret.locationId);
  E.submitMoleGuess(g, wrong);
  E.advance(g);
  const r = g.result;
  ok(r.caught, 'marked caught');
  others.forEach(id => eq(r.deltas[id], 3, 'insider who voted mole gets 2+1 = 3'));
  eq(r.deltas[mole], 0, 'mole caught + wrong guess scores 0');
}

// (b) mole caught, guesses right
{
  const g = rig(4);
  const mole = g.secret.moleId;
  const others = g.players.filter(p => p.id !== mole).map(p => p.id);
  g.phase = 'vote';
  others.forEach(id => { g.votes[id] = mole; });
  g.votes[mole] = others[0];
  E.advance(g);
  E.submitMoleGuess(g, g.secret.locationId);
  E.advance(g);
  eq(g.result.deltas[mole], 3, 'mole caught but redeems with correct guess = 3');
  ok(g.result.guessRight, 'guessRight flag set');
}

// (c) mole escapes — innocent takes the most votes
{
  const g = rig(5);
  const mole = g.secret.moleId;
  const others = g.players.filter(p => p.id !== mole).map(p => p.id);
  const scapegoat = others[0];
  g.phase = 'vote';
  g.votes[others[1]] = scapegoat;
  g.votes[others[2]] = scapegoat;
  g.votes[others[3]] = mole;      // lone correct voter
  g.votes[scapegoat] = others[1];
  g.votes[mole] = scapegoat;
  eq(E.advance(g), 'reveal', 'escape skips lastword');
  const r = g.result;
  ok(!r.caught, 'not caught');
  eq(r.deltas[mole], 4, 'escaped mole scores 4');
  eq(r.deltas[others[3]], 1, 'lone correct voter still gets +1');
  eq(r.deltas[others[1]], 0, 'wrong voter gets 0');
}

// (d) tie at the top lets the mole walk
{
  const g = rig(4);
  const mole = g.secret.moleId;
  const o = g.players.filter(p => p.id !== mole).map(p => p.id);
  g.phase = 'vote';
  g.votes[o[0]] = mole;
  g.votes[o[1]] = o[2];
  g.votes[o[2]] = o[1];      // o[1] and o[2] and mole all on 1 => tie
  g.votes[mole] = o[0];
  const t = E.tally(g);
  ok(!t.caught, 'tie means not caught');
  E.advance(g);
  eq(g.result.deltas[mole], 4, 'mole escapes a tie with 4');
  eq(g.result.deltas[o[0]], 1, 'correct voter in a tie still gets +1');
}

// (e) a player cannot vote for themselves
{
  const g = rig(3); g.phase = 'vote';
  ok(!E.submitVote(g, 'p0', 'p0').ok, 'self-vote rejected');
  ok(E.submitVote(g, 'p0', 'p1').ok, 'normal vote accepted');
}

/* ---- 3. soak: full games, all sizes, many seeds ---- */
let games = 0, rounds = 0, caughtCount = 0, moleWins = 0;
for (let n = 3; n <= 8; n++) {
  for (let seed = 1; seed <= 120; seed++) {
    const g = E.createGame('S' + seed, 'b0', deck, { totalRounds: 5, seed: seed * 977 + n });
    for (let i = 0; i < n; i++) E.addPlayer(g, 'b' + i, 'Bot' + i, true);
    E.startRound(g);
    let guard = 0;
    while (g.phase !== 'gameover' && guard++ < 200) {
      if (g.phase === 'clue1' || g.phase === 'clue2') {
        E.activePlayers(g).forEach(p => {
          if (g.clues[p.id] && g.clues[p.id][E.clueIndex(g)]) return;
          const w = E.botClue(g, p.id);
          const r = E.submitClue(g, p.id, w);
          ok(r.ok, `bot clue rejected (${w}): ${r.error}`);
        });
        ok(E.allCluesIn(g), 'all clues registered');
        const words = E.usedWordsThisRound(g).map(E.norm);
        eq(new Set(words).size, words.length, 'no duplicate clues in a round');
        E.advance(g);
      } else if (g.phase === 'vote') {
        E.activePlayers(g).forEach(p => {
          const t = E.botVote(g, p.id);
          const r = E.submitVote(g, p.id, t);
          ok(r.ok, 'bot vote rejected: ' + r.error);
        });
        ok(E.allVotesIn(g), 'all votes registered');
        E.advance(g);
      } else if (g.phase === 'lastword') {
        E.submitMoleGuess(g, E.pick(E.makeRng(seed + g.round), g.secret.options));
        E.advance(g);
      } else if (g.phase === 'reveal') {
        rounds++;
        if (g.result.caught) caughtCount++; else moleWins++;
        ok(g.secret.options.length === 6, 'six guess options');
        ok(g.secret.options.includes(g.secret.locationId), 'true location among options');
        ok(g.secret.options.every(id => E.locById(g, id).cat === g.secret.cat), 'options share the category');
        E.advance(g);
      } else { ok(false, 'unexpected phase ' + g.phase); break; }
    }
    eq(g.phase, 'gameover', 'game reached gameover');
    eq(g.round, 5, 'played five rounds');
    g.players.forEach(p => ok(Number.isInteger(p.score) && p.score >= 0, 'score is a non-negative integer'));
    // mole rotation should be roughly even
    const mc = g.players.map(p => p.moleCount || 0);
    ok(Math.max(...mc) - Math.min(...mc) <= 1, 'mole duty spread evenly (max-min<=1)');
    games++;
  }
}

console.log(`\nsoak: ${games} games, ${rounds} rounds`);
console.log(`bot mole caught ${(caughtCount / rounds * 100).toFixed(1)}% of rounds, escaped ${(moleWins / rounds * 100).toFixed(1)}%`);
console.log(fails === 0 ? '\nALL ENGINE TESTS PASSED' : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
