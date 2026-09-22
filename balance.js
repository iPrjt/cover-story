const E = require('./engine.js'); const deck = require('./deck.json');
function run(n, seeds) {
  let caught = 0, rounds = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const g = E.createGame('B', 'b0', deck, { totalRounds: 5, seed: seed * 613 + n * 31 });
    for (let i = 0; i < n; i++) E.addPlayer(g, 'b' + i, 'Bot' + i, true);
    E.startRound(g);
    let guard = 0;
    while (g.phase !== 'gameover' && guard++ < 200) {
      if (g.phase === 'clue1' || g.phase === 'clue2') {
        E.activePlayers(g).forEach(p => E.submitClue(g, p.id, E.botClue(g, p.id)));
      } else if (g.phase === 'vote') {
        E.activePlayers(g).forEach(p => E.submitVote(g, p.id, E.botVote(g, p.id)));
      } else if (g.phase === 'lastword') {
        E.submitMoleGuess(g, E.pick(E.makeRng(seed * 7 + g.round), g.secret.options));
      } else if (g.phase === 'reveal') { rounds++; if (g.result.caught) caught++; }
      E.advance(g);
    }
  }
  return { rounds, pct: caught / rounds * 100 };
}
for (const c of [0.4, 0.5, 0.6, 0.7]) {
  for (const noise of [5, 7, 9]) {
    E._tune(c, noise);
    const out = [3,4,5,6,8].map(n => `${n}p ${run(n, 200).pct.toFixed(0)}%`).join('  ');
    console.log(`caution=${c} noise=${noise} | mole caught: ${out}`);
  }
}
