/* What one player is allowed to see.
   Shared by the hosted server and the quick-play build so the two versions
   can never drift apart on the one thing that matters: who knows what. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.CoverView = factory(root.CoverStory);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  function buildView(g, pid, opts) {
    opts = opts || {};
    var online = opts.online || function () { return true; };
    var me = E.findPlayer(g, pid);
    var isMole = !!(g.secret && g.secret.moleId === pid);
    var loc = g.secret ? E.locById(g, g.secret.locationId) : null;
    var revealed = g.phase === 'reveal' || g.phase === 'gameover';
    var idx = E.clueIndex(g);

    /* First words go on the table once round one closes; second words at the vote. */
    var show = [g.phase !== 'clue1', g.phase === 'vote' || g.phase === 'lastword' || revealed];

    var players = g.players.map(function (p) {
      return {
        id: p.id, name: p.name, isBot: p.isBot, score: p.score, left: !!p.left,
        online: p.isBot || online(p.id),
        submitted: !!(idx >= 0 && g.clues[p.id] && g.clues[p.id][idx]),
        voted: !!g.votes[p.id],
        clues: [
          show[0] ? (g.clues[p.id] || [])[0] || null : null,
          show[1] ? (g.clues[p.id] || [])[1] || null : null
        ]
      };
    });

    return {
      t: 'state',
      code: g.code,
      phase: g.phase,
      round: g.round,
      totalRounds: g.totalRounds,
      hostId: g.hostId,
      youAreHost: g.hostId === pid,
      deadline: opts.deadline || 0,
      serverNow: Date.now(),
      you: me ? { id: me.id, name: me.name, score: me.score, isMole: isMole } : null,
      players: players,
      category: g.secret ? g.secret.cat : null,
      location: g.secret ? ((isMole && !revealed) ? null : (loc ? loc.name : null)) : null,
      myClue: (g.clues[pid] || [])[idx] || null,
      myVote: g.votes[pid] || null,
      options: (g.phase === 'lastword' && isMole)
        ? g.secret.options.map(function (id) { return { id: id, name: E.locById(g, id).name }; })
        : null,
      moleGuess: g.moleGuess,
      result: revealed ? g.result : null,
      standings: revealed ? E.standings(g).map(function (p) {
        return { id: p.id, name: p.name, score: p.score };
      }) : null,
      minPlayers: E.MIN_PLAYERS, maxPlayers: E.MAX_PLAYERS, clueMax: E.CLUE_MAX
    };
  }

  return { buildView: buildView };
});
