/* Drives the published-page transport (net-db.js) for real: three separate
   JS contexts, one shared in-memory stand-in for the artifact data store.
   Catches the things that only show up when a second player joins. */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL:', m); } else console.log('  ok  :', m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- a minimal stand-in for the artifact data store ---------- */
function MockDB() {
  const docs = new Map();            // path -> body
  const docListeners = new Map();    // path -> [fn]
  const colListeners = new Map();    // path -> [fn]
  const leases = new Map();          // path -> {holder, until}

  function notifyDoc(p) {
    (docListeners.get(p) || []).forEach(fn =>
      setTimeout(() => fn({ id: p.split('/').pop(), exists: docs.has(p),
                            data: () => docs.get(p), metadata: {} }), 0));
    const parent = p.split('/').slice(0, -1).join('/');
    (colListeners.get(parent) || []).forEach(fn => setTimeout(() => fn(colSnap(parent)), 0));
  }
  function colSnap(cp) {
    const out = [];
    for (const [p, body] of docs) {
      if (p.startsWith(cp + '/') && p.slice(cp.length + 1).indexOf('/') === -1) {
        out.push({ id: p.split('/').pop(), exists: true, data: () => body, metadata: {} });
      }
    }
    return { docs: out, size: out.length, empty: !out.length, docChanges: () => [], metadata: {} };
  }
  function docRef(p) {
    if (p.split('/').length % 2 !== 0) throw new TypeError('bad doc path ' + p);
    return {
      id: p.split('/').pop(), path: p,
      get: async () => ({ id: p.split('/').pop(), exists: docs.has(p), data: () => docs.get(p), metadata: {} }),
      set: async body => { docs.set(p, JSON.parse(JSON.stringify(body))); notifyDoc(p); },
      update: async body => { docs.set(p, Object.assign({}, docs.get(p), body)); notifyDoc(p); },
      delete: async () => { docs.delete(p); notifyDoc(p); },
      acquire: async ({ holder, ttlMs }) => {
        const l = leases.get(p);
        if (l && l.until > Date.now() && l.holder !== holder) return { acquired: false };
        leases.set(p, { holder, until: Date.now() + (ttlMs || 30000) });
        return { acquired: true, holder };
      },
      onSnapshot: (next) => {
        if (!docListeners.has(p)) docListeners.set(p, []);
        docListeners.get(p).push(next);
        setTimeout(() => next({ id: p.split('/').pop(), exists: docs.has(p), data: () => docs.get(p), metadata: {} }), 0);
        return () => {};
      },
      collection: sub => colRef(p + '/' + sub)
    };
  }
  function colRef(p) {
    return {
      path: p,
      doc: id => docRef(p + '/' + id),
      onSnapshot: next => {
        if (!colListeners.has(p)) colListeners.set(p, []);
        colListeners.get(p).push(next);
        setTimeout(() => next(colSnap(p)), 0);
        return () => {};
      },
      get: async () => colSnap(p)
    };
  }
  return { doc: docRef, collection: colRef, _docs: docs };
}

/* ---------- one browser-ish context per player ---------- */
const here = __dirname;
const sources = ['engine.js', 'view.js', 'public/net-db.js']
  .map(f => fs.readFileSync(path.join(here, f), 'utf8'));
const deck = JSON.parse(fs.readFileSync(path.join(here, 'deck.json'), 'utf8'));

function makePlayer(db, id) {
  const storage = {};
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, String, Object, Array, Number, TypeError,
    localStorage: {
      getItem: k => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); }
    }
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.DECK = deck;
  sandbox.claude = {
    use: async name => {
      if (name === 'db') return db;
      if (name === 'user') return { id: async () => id, me: async () => ({ name: id }) };
      return null;                       // no presence channel in this harness
    }
  };
  vm.createContext(sandbox);
  sources.forEach(src => vm.runInContext(src, sandbox));
  const p = { id, sandbox, Net: sandbox.Net, state: null, errors: [] };
  p.Net.on(m => {
    if (m.t === 'state') p.state = m;
    else if (m.t === 'error') p.errors.push(m.message);
    else if (m.t === 'joined') p.code = m.code;
  });
  return p;
}

async function waitFor(p, pred, label, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (p.state && pred(p.state)) return p.state; await sleep(30); }
  fails++; console.log('  FAIL: timed out on', label, '| phase =', p.state && p.state.phase);
  return p.state;
}

(async () => {
  const db = MockDB();
  const ana = makePlayer(db, 'u_ana');
  const ben = makePlayer(db, 'u_ben');
  const cleo = makePlayer(db, 'u_cleo');

  ana.Net.start(); ben.Net.start(); cleo.Net.start();
  await sleep(60);

  ana.Net.create('Ana');
  await waitFor(ana, s => s.phase === 'lobby', 'host lobby');
  ok(!!ana.code && ana.code.length === 4, 'host opened a table with a 4-character code');
  ok(ana.state.youAreHost, 'the player who opened it runs the table');

  ben.Net.join(ana.code, 'Ben');
  cleo.Net.join(ana.code, 'Cleo');
  await waitFor(ana, s => s.players.length === 3, 'three at the table', 6000);
  ok(ana.state.players.length === 3, 'both guests reached the table');
  await waitFor(ben, s => s.players.length === 3, 'guest sees the table');
  ok(!ben.state.youAreHost, 'a guest does not run the table');

  // bad code
  const zed = makePlayer(db, 'u_zed');
  zed.Net.start(); await sleep(40);
  zed.Net.join('ZZZZ', 'Zed');
  await sleep(200);
  ok(zed.errors.some(e => /No game/i.test(e)), 'an unknown code gives a clear error');

  ana.Net.send({ t: 'rounds', value: 2 });
  await waitFor(ana, s => s.totalRounds === 2, 'rounds set');
  ok(ben.state.totalRounds === 2, 'a host setting reaches the guests');

  ana.Net.send({ t: 'start' });
  await waitFor(ana, s => s.phase === 'clue1', 'round one');
  await waitFor(ben, s => s.phase === 'clue1', 'guest in round one');

  const all = [ana, ben, cleo];
  const moles = all.filter(p => p.state.you.isMole);
  ok(moles.length === 1, 'exactly one player is the mole');
  ok(moles[0].state.location === null, 'the mole is not shown the place');
  ok(all.filter(p => !p.state.you.isMole).every(p => typeof p.state.location === 'string'),
     'every insider is shown the place');

  // local validation fires before anything is written
  const insider = all.find(p => !p.state.you.isMole);
  insider.errors.length = 0;
  insider.Net.send({ t: 'clue', word: 'two words' });
  await sleep(80);
  ok(insider.errors.some(e => /one word/i.test(e)), 'a two-word clue is refused on the spot');
  insider.Net.send({ t: 'clue', word: insider.state.location.split(' ')[0] });
  await sleep(80);
  ok(insider.errors.length >= 2, 'a clue lifted from the place name is refused');

  let guard = 0;
  const used = new Set();
  while (ana.state.phase !== 'gameover' && guard++ < 40) {
    const ph = ana.state.phase;
    if (ph === 'clue1' || ph === 'clue2') {
      for (const p of all) {
        if (p.state.myClue) continue;
        let w; do { w = 'w' + Math.random().toString(36).slice(2, 7); } while (used.has(w));
        used.add(w);
        p.Net.send({ t: 'clue', word: w });
        await sleep(70);
      }
      await waitFor(ana, s => s.phase !== ph, 'left ' + ph, 8000);
    } else if (ph === 'vote') {
      const target = ana.state.players.find(p => p.id !== ana.state.you.id);
      for (const p of all) {
        const t = p.state.players.find(q => q.id === target.id && q.id !== p.state.you.id)
               || p.state.players.find(q => q.id !== p.state.you.id);
        p.Net.send({ t: 'vote', target: t.id });
        await sleep(70);
      }
      await waitFor(ana, s => s.phase !== 'vote', 'left vote', 8000);
    } else if (ph === 'lastword') {
      const m = all.find(p => p.state.options);
      if (m) m.Net.send({ t: 'guess', location: m.state.options[0].id });
      await waitFor(ana, s => s.phase !== 'lastword', 'left lastword', 8000);
    } else if (ph === 'reveal') {
      ok(!!ana.state.result, 'a result is produced');
      ok(all.every(p => p.state.result && p.state.result.moleId === ana.state.result.moleId),
         'all three see the same mole named');
      ana.Net.send({ t: 'next' });
      await waitFor(ana, s => s.phase !== 'reveal', 'left reveal', 8000);
    } else await sleep(100);
  }

  ok(ana.state.phase === 'gameover', 'the table reached the final screen');
  ok(ana.state.round === 2, 'it played the two rounds asked for');
  ok(ben.state.standings && ben.state.standings.length === 3, 'guests see the final standings');
  ok(JSON.stringify(ana.state.standings) === JSON.stringify(ben.state.standings),
     'host and guest agree on the final scores');

  /* ---- the table changes hands ---- */
  const beforeHost = ana.state.hostId;
  ana.Net.stop();                                   // Ana closes her tab
  const roomDoc = db._docs.get('rooms/' + ana.code);
  roomDoc.hostBeat = Date.now() - 60000;            // her heartbeat goes stale
  await db.doc('rooms/' + ana.code).set(roomDoc);
  await sleep(2500);
  ok(ben.state.hostId !== beforeHost || cleo.state.hostId !== beforeHost,
     'a stale host is replaced so the game can carry on');
  const newHost = ben.state.hostId;
  ok(newHost === ben.state.you.id || newHost === cleo.state.you.id,
     'the new host is one of the remaining players');

  /* the new host can actually run the game */
  const runner = [ben, cleo].find(p => p.state.youAreHost);
  ok(!!runner, 'exactly one of the remaining players took the table');
  if (runner) {
    runner.Net.send({ t: 'again' });
    await waitFor(runner, s => s.phase === 'lobby', 'new host restarted the game', 5000);
    ok(runner.state.phase === 'lobby', 'the replacement host can start a fresh game');
  }

  console.log(fails === 0 ? '\nALL PUBLISHED-PAGE TESTS PASSED\n' : `\n${fails} FAILURES\n`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
