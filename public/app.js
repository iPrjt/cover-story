/* COVER STORY — interface.
   Renders whatever view the transport hands it. The transport (websocket in
   the hosted build, the artifact data store in the quick-play build) is the
   only thing that differs between the two versions of this game. */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var state = null;          // the latest view from the server
  var screen = 'home';       // 'home' | 'game'
  var pending = { clue: '', name: '', code: '' };
  var errorMsg = '';
  var toastTimer = null;
  var tick = null;

  /* ---------- small helpers ---------- */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === true) n.setAttribute(k, '');
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function frag(kids) {
    var f = document.createDocumentFragment();
    kids.forEach(function (c) { if (c) f.appendChild(c); });
    return f;
  }
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (_) { return null; }
  }
  function toast(msg) {
    var old = document.querySelector('.toast');
    if (old) old.remove();
    var t = el('div', { class: 'toast', text: msg, role: 'status' });
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.remove(); }, 3200);
  }

  /* ---------- masthead + rules ---------- */
  function masthead() {
    return el('header', { class: 'masthead' }, [
      el('div', {}, [
        el('h1', { class: 'display title', text: 'Cover Story' }),
        el('span', { class: 'label sub', text: 'One of you was never there' })
      ]),
      el('button', { class: 'ghost small', type: 'button', onclick: openRules }, [
        document.createTextNode('Rules')
      ])
    ]);
  }

  function openRules() {
    var d = document.getElementById('rulesDialog');
    if (d) { d.showModal(); return; }
    d = el('dialog', { class: 'rules', id: 'rulesDialog' }, [
      el('div', { class: 'body' }, [
        el('h2', { class: 'display', text: 'How to play' }),
        el('p', { class: 'label', text: '3 to 8 players · about 10 minutes' }),
        el('ol', {}, [
          el('li', { html: '<b>Everyone gets the same place</b> — an airport terminal, a dive bar, a glacier. Everyone except one player, <b>the mole</b>, who is told only the category.' }),
          el('li', { html: '<b>Give one word, twice.</b> Two rounds of clues. Your word should prove you know the place — without being so obvious that the mole can copy it.' }),
          el('li', { html: '<b>The mole bluffs.</b> They have to invent a word that fits a place they have never seen, then watch what everyone else says and blend in.' }),
          el('li', { html: '<b>Vote.</b> Everyone accuses one player. The mole is caught only on a clear majority — a tie lets them walk.' }),
          el('li', { html: '<b>Last word.</b> A caught mole gets one shot at naming the place from six options. Guess right and they still take points home.' })
        ]),
        el('div', { class: 'scoring' }, [
          el('p', { class: 'label', text: 'Scoring' }),
          scoreLine('Mole escapes the vote', '+4 to the mole'),
          scoreLine('Mole is caught', '+2 to every other player'),
          scoreLine('You voted for the real mole', '+1 to you'),
          scoreLine('Caught mole names the place', '+3 to the mole'),
          el('p', { class: 'hint', text: 'Highest total after the last round wins.' })
        ]),
        el('div', { class: 'row', style: 'margin-top:18px' }, [
          el('button', { class: 'primary', type: 'button', onclick: function () { d.close(); } }, [document.createTextNode('Got it')])
        ])
      ])
    ]);
    document.body.appendChild(d);
    d.showModal();
  }
  function scoreLine(what, pts) {
    return el('div', {}, [el('span', { text: what }), el('b', { text: pts })]);
  }

  /* ---------- home ---------- */
  function renderHome() {
    var savedName = store('cs_name') || (Net.suggestedName ? Net.suggestedName() : '') || '';
    if (!pending.name) pending.name = savedName;

    var nameInput = el('input', {
      type: 'text', id: 'nameInput', maxlength: '18', placeholder: 'e.g. Priya',
      value: pending.name, autocomplete: 'nickname',
      oninput: function (e) { pending.name = e.target.value; }
    });
    var codeInput = el('input', {
      type: 'text', id: 'codeInput', maxlength: '4', placeholder: 'ABCD',
      class: 'mono', value: pending.code, autocapitalize: 'characters', autocomplete: 'off',
      oninput: function (e) { pending.code = e.target.value.toUpperCase(); e.target.value = pending.code; }
    });

    function needName() {
      var n = (pending.name || '').trim();
      if (!n) { errorMsg = 'Enter a name first — the others need to know who is talking.'; render(); return null; }
      store('cs_name', n);
      return n;
    }

    return frag([
      masthead(),
      el('section', { class: 'sheet stack' }, [
        el('div', { class: 'field' }, [
          el('label', { for: 'nameInput', text: 'Your name' }), nameInput
        ]),
        el('button', {
          class: 'primary wide', type: 'button',
          onclick: function () { var n = needName(); if (n) Net.create(n); }
        }, [document.createTextNode('Start a new game')]),
        el('div', { class: 'row', style: 'gap:8px' }, [
          el('div', { class: 'field', style: 'flex:1 1 140px' }, [
            el('label', { for: 'codeInput', text: 'Join with a code' }), codeInput
          ]),
          el('button', {
            class: 'small', type: 'button', style: 'align-self:flex-end',
            onclick: function () {
              var n = needName(); if (!n) return;
              var c = (pending.code || '').trim().toUpperCase();
              if (c.length !== 4) { errorMsg = 'A game code is four characters.'; render(); return; }
              Net.join(c, n);
            }
          }, [document.createTextNode('Join')])
        ]),
        el('p', { class: 'err', text: errorMsg }),
        Net.notice ? el('p', { class: 'banner', text: Net.notice }) : null
      ]),
      el('section', { class: 'sheet' }, [
        el('p', { class: 'label', text: 'The short version' }),
        el('p', { style: 'margin:8px 0 0', text: 'Everyone is shown the same place. One player is shown only the category. Two rounds of one-word clues, then a vote. Find the faker, or survive as one.' }),
        el('div', { class: 'row', style: 'margin-top:14px' }, [
          el('button', { class: 'ghost small', type: 'button', onclick: openRules }, [document.createTextNode('Full rules and scoring')])
        ])
      ]),
      foot()
    ]);
  }

  function foot() {
    return el('footer', { class: 'foot' }, [
      el('span', { class: 'label', text: 'Cover Story' }),
      el('span', { class: 'label', text: '3–8 players' })
    ]);
  }

  /* ---------- lobby ---------- */
  function renderLobby() {
    var s = state;
    var canStart = s.players.filter(function (p) { return !p.left; }).length >= s.minPlayers;
    var shareUrl = location.origin + '/?code=' + s.code;

    return frag([
      masthead(),
      el('section', { class: 'sheet stack' }, [
        el('div', { class: 'code-display' }, [
          el('div', {}, [
            el('p', { class: 'label', text: 'Game code' }),
            el('div', { class: 'code', text: s.code })
          ]),
          el('button', {
            class: 'small', type: 'button',
            onclick: function () {
              var ok = false;
              try {
                if (navigator.clipboard) { navigator.clipboard.writeText(shareUrl); ok = true; }
              } catch (_) {}
              toast(ok ? 'Link copied — send it to your players.' : shareUrl);
            }
          }, [document.createTextNode('Copy link')])
        ]),
        el('p', { class: 'hint', text: 'Everyone opens this page on their own phone or laptop and enters the code. Nobody should see anyone else’s screen.' }),
        playerLog(s, false),
        !canStart ? el('p', { class: 'banner', text: 'Waiting for ' + (s.minPlayers - s.players.filter(function (p) { return !p.left; }).length) + ' more. Short on people? The host can add a bot.' }) : null,
        s.youAreHost ? hostControls(s, canStart) : el('p', { class: 'hint', text: 'Waiting for the host to start.' })
      ]),
      foot()
    ]);
  }

  function hostControls(s, canStart) {
    var botCount = s.players.filter(function (p) { return p.isBot; }).length;
    function stepper(label, value, dec, inc, decOff) {
      return el('div', { class: 'setting' }, [
        el('span', { class: 'label', text: label }),
        el('div', { class: 'stepper' }, [
          el('button', { class: 'small', type: 'button', disabled: decOff, 'aria-label': 'Fewer ' + label, onclick: dec }, [document.createTextNode('\u2212')]),
          el('span', { class: 'mono', text: String(value) }),
          el('button', { class: 'small', type: 'button', 'aria-label': 'More ' + label, onclick: inc }, [document.createTextNode('+')])
        ])
      ]);
    }
    return el('div', { class: 'stack' }, [
      el('div', { class: 'settings' }, [
        stepper('Rounds', s.totalRounds,
          function () { Net.send({ t: 'rounds', value: s.totalRounds - 1 }); },
          function () { Net.send({ t: 'rounds', value: s.totalRounds + 1 }); },
          s.totalRounds <= 1),
        stepper('Bots', botCount,
          function () { Net.send({ t: 'removeBot' }); },
          function () { Net.send({ t: 'addBot' }); },
          botCount === 0)
      ]),
      el('p', { class: 'hint', text: 'Bots fill empty seats. They give real clues, bluff when they draw the mole, and vote on what they see.' }),
      el('button', {
        class: 'primary wide', type: 'button', disabled: !canStart,
        onclick: function () { Net.send({ t: 'start' }); }
      }, [document.createTextNode(canStart ? 'Start the game' : 'Need ' + s.minPlayers + ' players')])
    ]);
  }

  /* ---------- the statement log ---------- */
  function playerLog(s, inGame) {
    var voting = s.phase === 'vote';
    var revealed = s.phase === 'reveal' || s.phase === 'gameover';
    var result = s.result;

    var rows = s.players.filter(function (p) { return !p.left || inGame; }).map(function (p) {
      var isYou = s.you && p.id === s.you.id;
      var votable = voting && !isYou && !p.left;

      var tags = [];
      if (isYou) tags.push(el('span', { class: 'tag you', text: 'you' }));
      if (p.id === s.hostId) tags.push(el('span', { class: 'tag host', text: 'host' }));
      if (p.isBot) tags.push(el('span', { class: 'tag bot', text: 'bot' }));
      if (!p.online && !p.isBot) tags.push(el('span', { class: 'tag off', text: 'away' }));

      var rightKids;
      if (!inGame) {
        rightKids = [];
      } else if (revealed && result) {
        var d = (result.deltas && result.deltas[p.id]) || 0;
        rightKids = [
          el('span', { class: 'delta' + (d ? '' : ' zero'), text: (d > 0 ? '+' + d : '\u00b7') }),
          el('span', { class: 'score', text: String(p.score) })
        ];
      } else {
        rightKids = [el('span', { class: 'score', text: String(p.score) })];
      }
      var right = el('span', { class: 'right' }, rightKids);

      /* Who has acted belongs next to the name; the words row stays words. */
      if (revealed && result && p.id === result.moleId) {
        tags.push(el('span', { class: 'stamp-mark', text: 'MOLE' }));
      }
      if (inGame) {
        if (voting) tags.push(el('span', { class: 'tag' + (p.voted ? ' host' : ''), text: p.voted ? 'voted' : 'thinking' }));
        else if ((s.phase === 'clue1' || s.phase === 'clue2') && p.submitted) {
          tags.push(el('span', { class: 'tag', style: 'border-color:var(--good);color:var(--good)', text: 'ready' }));
        }
      }

      var words = el('span', { class: 'words' }, []);
      if (inGame) {
        [0, 1].forEach(function (i) {
          var w = p.clues[i];
          if (w) words.appendChild(el('span', { class: 'word', text: w }));
          else if (s.phase === 'clue' + (i + 1)) {
            words.appendChild(el('span', {
              class: 'word ' + (p.submitted ? 'ready' : 'blank'),
              text: p.submitted ? 'locked in' : '\u00b7 \u00b7 \u00b7'
            }));
          } else if ((s.phase === 'vote' || revealed) && !w) {
            words.appendChild(el('span', { class: 'word blank', text: '—' }));
          }
        });
        if (revealed && result && result.counts) {
          var n = result.counts[p.id] || 0;
          if (n > 0) words.appendChild(el('span', { class: 'tag off', text: n + (n === 1 ? ' vote' : ' votes') }));
        }
      }

      var attrs = {
        class: 'entry' + (votable ? ' votable' : '') +
               (voting && s.myVote === p.id ? ' picked' : '') +
               (voting && isYou ? ' self-row' : '')
      };
      if (votable) {
        attrs.role = 'button';
        attrs.tabindex = '0';
        attrs['aria-label'] = 'Accuse ' + p.name;
        attrs.onclick = function () { Net.send({ t: 'vote', target: p.id }); };
        attrs.onkeydown = function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Net.send({ t: 'vote', target: p.id }); }
        };
      }

      var row = el('div', attrs, [
        el('span', { class: 'who' }, [el('span', { class: 'name', text: p.name })].concat(tags)),
        right,
        words
      ]);

      return row;
    });

    return el('div', {}, [
      el('div', { class: 'sheet-head' }, [
        el('p', { class: 'label', text: inGame ? 'Statements' : 'Players (' + s.players.length + '/' + s.maxPlayers + ')' }),
        inGame ? el('p', { class: 'label', text: 'Score' }) : null
      ]),
      el('div', { class: 'log' }, rows)
    ]);
  }

  /* ---------- the brief ---------- */
  function brief(s) {
    if (!s.you) return null;
    var revealed = s.phase === 'reveal' || s.phase === 'gameover';
    if (s.you.isMole && !revealed) {
      return el('div', { class: 'brief is-mole' }, [
        el('p', { class: 'label', text: 'Your brief' }),
        el('div', { class: 'display role', text: 'You are the mole' }),
        el('div', { class: 'place', text: 'Category: ' + s.category }),
        el('p', { class: 'note', text: 'You do not know the place. Read the other clues, give a word that could belong, and do not be the odd one out.' })
      ]);
    }
    return el('div', { class: 'brief' }, [
      el('p', { class: 'label', text: 'Your brief' }),
      el('div', { class: 'display role', text: s.you.isMole ? 'You were the mole' : 'You were there' }),
      el('div', { class: 'place', text: s.location || '—' }),
      el('p', { class: 'note', text: s.you.isMole ? 'Everyone can see it now.' : 'Prove you know it — without handing it to the mole.' })
    ]);
  }

  /* ---------- phase panels ---------- */
  function cluePanel(s) {
    var n = s.phase === 'clue1' ? 'first' : 'second';
    if (s.myClue) {
      return el('div', { class: 'stack' }, [
        el('p', { class: 'label', text: 'Your ' + n + ' word' }),
        el('div', { class: 'row' }, [
          el('span', { class: 'word', style: 'font-size:18px;padding:8px 14px', text: s.myClue }),
          el('span', { class: 'hint', text: 'Locked in. Waiting for the others.' })
        ])
      ]);
    }
    var input = el('input', {
      type: 'text', id: 'clueInput', maxlength: String(s.clueMax),
      placeholder: 'one word', class: 'mono', value: pending.clue,
      autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
      oninput: function (e) { pending.clue = e.target.value; },
      onkeydown: function (e) { if (e.key === 'Enter') submitClue(); }
    });
    function submitClue() {
      var w = (pending.clue || '').trim();
      if (!w) { errorMsg = 'Type one word.'; render(); return; }
      Net.send({ t: 'clue', word: w });
    }
    return el('div', { class: 'stack' }, [
      el('div', { class: 'field' }, [
        el('label', { for: 'clueInput', text: 'Your ' + n + ' word — one word, and not the name of the place' }),
        input
      ]),
      el('button', { class: 'primary wide', type: 'button', onclick: submitClue }, [document.createTextNode('Submit word')]),
      el('p', { class: 'err', text: errorMsg })
    ]);
  }

  function votePanel(s) {
    if (s.myVote) {
      var who = s.players.filter(function (p) { return p.id === s.myVote; })[0];
      return el('div', { class: 'stack' }, [
        el('p', { class: 'banner', text: 'You accused ' + (who ? who.name : '?') + '. Tap another name to change your mind while the others decide.' })
      ]);
    }
    return el('p', { class: 'banner', text: 'Tap the player you think is the mole.' });
  }

  function lastWordPanel(s) {
    if (!s.options) {
      return el('p', { class: 'banner warn', text: 'The mole was caught. They get one guess at the place.' });
    }
    return el('div', { class: 'stack' }, [
      el('p', { class: 'banner warn', text: 'They got you. Name the place and you still walk away with points.' }),
      el('div', { class: 'options' }, s.options.map(function (o) {
        return el('button', { type: 'button', onclick: function () { Net.send({ t: 'guess', location: o.id }); } },
          [document.createTextNode(o.name)]);
      }))
    ]);
  }

  function revealPanel(s) {
    var r = s.result;
    if (!r) return null;
    var youMole = s.you && s.you.id === r.moleId;
    var headline = r.caught
      ? (r.guessRight ? 'Caught — but they named the place' : 'The mole was caught')
      : 'The mole walked free';
    var detail;
    if (r.caught && r.guessRight) {
      detail = r.moleName + ' was the mole, and guessed ' + r.locationName + ' correctly. Everyone else takes +2, the mole takes +3.';
    } else if (r.caught) {
      detail = r.moleName + ' was the mole' + (r.moleGuessName ? ' and guessed ' + r.moleGuessName : ' and ran out of guesses') + '. Everyone else takes +2.';
    } else {
      detail = r.moleName + ' was the mole and nobody pinned it down. +4 to the mole.';
    }

    return el('div', { class: 'stack' }, [
      el('div', { class: 'verdict ' + (r.caught ? 'caught' : 'escaped') }, [
        el('h3', { class: 'display', text: headline }),
        el('p', { text: detail }),
        el('p', { text: 'The place was ' + r.locationName + '.' })
      ]),
      s.youAreHost
        ? el('button', {
            class: 'primary wide', type: 'button',
            onclick: function () { Net.send({ t: 'next' }); }
          }, [document.createTextNode(s.round >= s.totalRounds ? 'See the final scores' : 'Next round')])
        : el('p', { class: 'hint', text: 'Waiting for the host to deal the next round.' }),
      youMole && !r.caught ? el('p', { class: 'hint', text: 'Nobody suspected you. Try not to look pleased.' }) : null
    ]);
  }

  function gameOverPanel(s) {
    var top = s.standings && s.standings[0];
    var winners = s.standings ? s.standings.filter(function (p) { return p.score === top.score; }) : [];
    return el('section', { class: 'sheet stack' }, [
      el('p', { class: 'label', text: 'Final' }),
      el('h2', { class: 'display', style: 'font-size:clamp(26px,7vw,38px)',
        text: winners.length > 1
          ? 'A tie: ' + winners.map(function (w) { return w.name; }).join(' and ')
          : (top ? top.name + ' wins' : 'Game over') }),
      el('div', { class: 'log' }, (s.standings || []).map(function (p, i) {
        return el('div', { class: 'entry' }, [
          el('span', { class: 'who' }, [
            el('span', { class: 'mono', style: 'color:var(--ink-3);min-width:2.5ch', text: String(i + 1) }),
            el('span', { class: 'name', text: p.name })
          ]),
          el('span', { class: 'score', text: String(p.score) })
        ]);
      })),
      s.youAreHost
        ? el('button', { class: 'primary wide', type: 'button', onclick: function () { Net.send({ t: 'again' }); } },
            [document.createTextNode('Play again')])
        : el('p', { class: 'hint', text: 'The host can start another game.' })
    ]);
  }

  /* ---------- status bar ---------- */
  function statusbar(s) {
    var names = {
      clue1: 'First word', clue2: 'Second word', vote: 'Vote',
      lastword: 'Last word', reveal: 'Result', gameover: 'Final scores'
    };
    var bar = el('div', { class: 'statusbar' }, [
      el('span', { class: 'label', text: 'Round ' + s.round + ' of ' + s.totalRounds }),
      el('span', { class: 'display', style: 'font-size:15px', text: names[s.phase] || s.phase }),
      el('span', { class: 'clock mono', id: 'clock', text: '' })
    ]);
    return el('div', {}, [bar, el('div', { class: 'meter' }, [el('i', { id: 'meterFill', style: 'width:100%' })])]);
  }

  function runClock() {
    clearInterval(tick);
    if (!state || !state.deadline) {
      var c0 = document.getElementById('clock'); if (c0) c0.textContent = '';
      var m0 = document.getElementById('meterFill'); if (m0) m0.style.width = '0%';
      return;
    }
    var total = state.deadline - (state.receivedAt || Date.now());
    function paint() {
      var c = document.getElementById('clock');
      var m = document.getElementById('meterFill');
      if (!c) { clearInterval(tick); return; }
      var left = Math.max(0, state.deadline - (Date.now() + (state.skew || 0)));
      c.textContent = Math.ceil(left / 1000) + 's';
      c.className = 'clock mono' + (left < 11000 ? ' low' : '');
      if (m) m.style.width = Math.max(0, Math.min(100, (left / Math.max(total, 1)) * 100)) + '%';
    }
    paint();
    tick = setInterval(paint, 1000);
  }

  /* ---------- game screen ---------- */
  function renderGame() {
    var s = state;
    var panel = null;
    if (s.phase === 'clue1' || s.phase === 'clue2') panel = cluePanel(s);
    else if (s.phase === 'vote') panel = votePanel(s);
    else if (s.phase === 'lastword') panel = lastWordPanel(s);
    else if (s.phase === 'reveal') panel = revealPanel(s);

    return frag([
      masthead(),
      statusbar(s),
      brief(s),
      panel ? el('section', { class: 'sheet' }, [panel]) : null,
      el('section', { class: 'sheet' }, [playerLog(s, true)]),
      foot()
    ]);
  }

  /* ---------- render ---------- */
  function render() {
    var focusId = document.activeElement && document.activeElement.id;
    var selStart = null;
    if (focusId && document.activeElement.setSelectionRange) {
      try { selStart = document.activeElement.selectionStart; } catch (_) {}
    }

    app.textContent = '';
    if (screen === 'home' || !state) app.appendChild(renderHome());
    else if (state.phase === 'lobby') app.appendChild(renderLobby());
    else if (state.phase === 'gameover') app.appendChild(frag([masthead(), gameOverPanel(state), foot()]));
    else app.appendChild(renderGame());

    if (focusId) {
      var again = document.getElementById(focusId);
      if (again) {
        again.focus();
        if (selStart != null && again.setSelectionRange) {
          try { again.setSelectionRange(selStart, selStart); } catch (_) {}
        }
      }
    }
    runClock();
  }

  /* ---------- transport wiring ---------- */
  var lastPhase = null;
  Net.on(function (msg) {
    if (msg.t === 'joined') {
      store('cs_pid', msg.pid);
      store('cs_code', msg.code);
      screen = 'game';
      errorMsg = '';
      try { history.replaceState(null, '', '?code=' + msg.code); } catch (_) {}
      return;
    }
    if (msg.t === 'error') { errorMsg = msg.message; toast(msg.message); render(); return; }
    if (msg.t === 'state') {
      msg.receivedAt = Date.now();
      msg.skew = msg.serverNow ? (Date.now() - msg.serverNow) : 0;
      if (msg.phase !== lastPhase) { pending.clue = ''; errorMsg = ''; lastPhase = msg.phase; }
      state = msg;
      screen = 'game';
      render();
      return;
    }
    if (msg.t === 'closed') {
      toast('Connection lost — reconnecting…');
      return;
    }
  });

  /* deep link: /?code=ABCD prefills the join box */
  var qs = new URLSearchParams(location.search);
  if (qs.get('code')) pending.code = qs.get('code').toUpperCase().slice(0, 4);

  if (Net.stop) window.addEventListener('pagehide', function () { Net.stop(); });
  Net.start({ pid: store('cs_pid') });
  render();
})();
