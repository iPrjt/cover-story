/* WebSocket transport for the hosted build.
   Keeps one socket alive, reconnects with backoff, and silently rejoins the
   same seat so a dropped phone comes straight back into the round. */
window.Net = (function () {
  'use strict';

  var ws = null;
  var handlers = [];
  var queue = [];
  var opts = {};
  var attempt = 0;
  var intent = null;      // {t:'create'|'join', ...} — replayed on reconnect
  var alive = null;

  function emit(msg) { handlers.forEach(function (h) { h(msg); }); }

  function url() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host;
  }

  function connect() {
    try { ws = new WebSocket(url()); } catch (_) { return retry(); }

    ws.onopen = function () {
      attempt = 0;
      if (intent) send(intent);
      var q = queue; queue = [];
      q.forEach(send);
      clearInterval(alive);
      alive = setInterval(function () { send({ t: 'ping' }); }, 25000);
    };

    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.t === 'pong') return;
      if (msg.t === 'joined') {
        // Remember how to come back to exactly this seat.
        intent = { t: 'join', code: msg.code, pid: msg.pid, name: intent && intent.name };
      }
      emit(msg);
    };

    ws.onclose = function () {
      clearInterval(alive);
      emit({ t: 'closed' });
      retry();
    };
    ws.onerror = function () { try { ws.close(); } catch (_) {} };
  }

  function retry() {
    attempt++;
    var wait = Math.min(8000, 400 * Math.pow(1.7, attempt));
    setTimeout(connect, wait);
  }

  function send(msg) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return; }
    queue.push(msg);
  }

  return {
    start: function (o) {
      opts = o || {};
      connect();
    },
    create: function (name) {
      intent = { t: 'create', name: name, pid: opts.pid || undefined };
      send(intent);
    },
    join: function (code, name) {
      intent = { t: 'join', code: code, name: name, pid: opts.pid || undefined };
      send(intent);
    },
    send: send,
    on: function (h) { handlers.push(h); }
  };
})();
