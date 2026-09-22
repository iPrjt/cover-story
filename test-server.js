/* End-to-end test: boots the real server, drives real WebSocket clients
   through a whole game, and checks both the rules and the secrecy. */
'use strict';
process.env.PORT = process.env.TEST_PORT || 4123;

const WebSocket = require('ws');
const { server } = require('./server.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL:', m); } else console.log('  ok  :', m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(name) {
  const c = {
    name, ws: null, pid: null, code: null, state: null, errors: [],
    send(m) { c.ws.send(JSON.stringify(m)); }
  };
  c.ready = new Promise(res => {
    c.ws = new WebSocket('ws://127.0.0.1:' + process.env.PORT);
    c.ws.on('open', res);
  });
  c.joined = new Promise(res => {
    c.ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'joined') { c.pid = m.pid; c.code = m.code; res(m); }
      else if (m.t === 'state') c.state = m;
      else if (m.t === 'error') c.errors.push(m.message);
    });
  });
  return c;
}

async function waitFor(c, pred, label, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (c.state && pred(c.state)) return c.state;
    await sleep(40);
  }
  fails++;
  console.log('  FAIL: timed out waiting for', label, '| phase =', c.state && c.state.phase);
  return c.state;
}

(async () => {
  console.log('\n— booting server —');
  await sleep(300);

  const host = client('Ana');
  await host.ready;
  host.send({ t: 'create', name: 'Ana' });
  await host.joined;
  ok(!!host.code && host.code.length === 4, 'host created a room with a 4-character code');

  const b = client('Ben'), d = client('Cleo');
  await Promise.all([b.ready, d.ready]);
  b.send({ t: 'join', code: host.code, name: 'Ben' });
  d.send({ t: 'join', code: host.code, name: 'Cleo' });
  await Promise.all([b.joined, d.joined]);
  await waitFor(host, s => s.players.length === 3, 'three players in the lobby');
  ok(host.state.players.length === 3, 'lobby shows all three players');
  ok(host.state.youAreHost && !b.state.youAreHost, 'only the creator is host');

  // a non-host cannot start or change settings
  b.send({ t: 'start' });
  await sleep(150);
  ok(host.state.phase === 'lobby', 'a non-host cannot start the game');

  host.send({ t: 'addBot' });
  await waitFor(host, s => s.players.length === 4, 'bot added');
  ok(host.state.players.some(p => p.isBot), 'host can add a bot');

  host.send({ t: 'rounds', value: 2 });
  await waitFor(host, s => s.totalRounds === 2, 'rounds set to 2');

  host.send({ t: 'start' });
  await waitFor(host, s => s.phase === 'clue1', 'round one started');

  const humans = [host, b, d];

  /* --- secrecy: exactly one player is the mole, and only insiders see the place --- */
  const moles = humans.filter(c => c.state.you.isMole);
  ok(moles.length <= 1, 'at most one human is the mole');
  humans.forEach(c => {
    if (c.state.you.isMole) ok(c.state.location === null, c.name + ' is the mole and is NOT told the place');
    else ok(typeof c.state.location === 'string', c.name + ' is an insider and IS told the place');
  });
  ok(humans.every(c => c.state.category), 'everyone is told the category');
  const rawFromServer = JSON.stringify(moles.length ? moles[0].state : host.state);
  ok(!/moleId/.test(rawFromServer), 'the payload sent to a player never names the mole');

  /* --- clue validation over the wire --- */
  const insider = humans.find(c => !c.state.you.isMole);
  insider.errors.length = 0;
  insider.send({ t: 'clue', word: 'two words' });
  await sleep(200);
  ok(insider.errors.some(e => /one word/i.test(e)), 'server rejects a two-word clue');
  insider.send({ t: 'clue', word: insider.state.location.split(' ')[0] });
  await sleep(200);
  ok(insider.errors.length >= 2, 'server rejects a clue taken from the location name');

  /* --- play both rounds to the end --- */
  const usedWords = new Set();
  let safety = 0;
  while (host.state.phase !== 'gameover' && safety++ < 60) {
    const ph = host.state.phase;
    if (ph === 'clue1' || ph === 'clue2') {
      for (const c of humans) {
        if (c.state.myClue) continue;
        let w, n = 0;
        do { w = 'word' + Math.random().toString(36).slice(2, 7); n++; } while (usedWords.has(w) && n < 5);
        usedWords.add(w);
        c.send({ t: 'clue', word: w });
        await sleep(90);
      }
      await waitFor(host, s => s.phase !== ph, 'left ' + ph, 9000);
      if (host.state.phase === 'vote' || host.state.phase === 'clue2') {
        // round-one words are visible to everyone once round one has closed
        const seen = host.state.players.filter(p => p.clues[0]).length;
        ok(seen === host.state.players.length, 'all first words are on the table after round one');
      }
    } else if (ph === 'vote') {
      // everyone accuses the same player so the vote is decisive
      const target = host.state.players.find(p => p.id !== host.state.you.id);
      for (const c of humans) {
        const t = c.state.players.find(p => p.id === target.id && p.id !== c.state.you.id)
               || c.state.players.find(p => p.id !== c.state.you.id);
        c.send({ t: 'vote', target: t.id });
        await sleep(80);
      }
      await waitFor(host, s => s.phase !== 'vote', 'left vote', 9000);
    } else if (ph === 'lastword') {
      const mole = humans.find(c => c.state.options);
      if (mole) mole.send({ t: 'guess', location: mole.state.options[0].id });
      await waitFor(host, s => s.phase !== 'lastword', 'left lastword', 9000);
    } else if (ph === 'reveal') {
      ok(!!host.state.result, 'a result is delivered at the reveal');
      ok(typeof host.state.location === 'string', 'the place is revealed to everyone');
      ok(humans.every(c => c.state.result.moleId === host.state.result.moleId), 'every client sees the same mole');
      host.send({ t: 'next' });
      await waitFor(host, s => s.phase !== 'reveal', 'left reveal', 9000);
    } else {
      await sleep(120);
    }
  }

  ok(host.state.phase === 'gameover', 'the game reached its final screen');
  ok(host.state.round === 2, 'it played exactly the two rounds requested');
  ok(Array.isArray(host.state.standings) && host.state.standings.length === 4, 'final standings list every player');
  const total = host.state.standings.reduce((a, p) => a + p.score, 0);
  ok(total > 0, 'points were actually awarded (total ' + total + ')');

  /* --- reconnect: same seat, same score --- */
  const scoreBefore = b.state.you.score;
  const savedPid = b.pid, savedCode = b.code;
  b.ws.close();
  await sleep(250);
  const back = client('Ben');
  await back.ready;
  back.send({ t: 'join', code: savedCode, pid: savedPid, name: 'Ben' });
  await back.joined;
  await waitFor(back, s => !!s.you, 'reconnected client has a seat');
  ok(back.state.you.id === savedPid, 'reconnecting returns you to the same seat');
  ok(back.state.you.score === scoreBefore, 'your score survives a reconnect');

  /* --- host migration --- */
  host.ws.close();
  await sleep(400);
  await waitFor(d, s => s.hostId !== savedHost(), 'host migrated', 4000);
  function savedHost() { return host.pid; }
  ok(d.state.hostId !== host.pid, 'the host role passes on when the host disconnects');

  /* --- bad code --- */
  const stray = client('Zed');
  await stray.ready;
  stray.send({ t: 'join', code: 'ZZZZ', name: 'Zed' });
  await sleep(250);
  ok(stray.errors.some(e => /No game/i.test(e)), 'joining a nonexistent code gives a clear error');

  [d, back, stray].forEach(c => { try { c.ws.close(); } catch (_) {} });
  server.close();

  console.log(fails === 0 ? '\nALL SERVER TESTS PASSED\n' : `\n${fails} FAILURES\n`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
