# Cover Story

A real-time multiplayer social deduction game for 3–8 players, built to run on a
single small Node process with no database and no build step.

Everyone at the table is shown the same place — an airport terminal, a dive bar,
a glacier. Everyone except one player, **the mole**, who is told only the
category. Two rounds of one-word clues, then a vote. Find the faker, or survive
as one.

---

## Running it

```bash
npm install
npm start          # http://localhost:3000
```

Open the page on two or more devices, one player starts a game and reads out the
four-character code, everyone else joins with it. Nobody should see anyone
else's screen — each player's brief is private to their own device.

Short on people? The host can add bots in the lobby. Bots give real clues from
the location's vocabulary, bluff when they draw the mole, and vote on what they
see on the table.

## Tests

```bash
npm test
```

Three suites, all offline:

| Suite | What it covers |
| --- | --- |
| `test-engine.js` | Clue validation, every scoring branch, and a soak of 720 complete bot games across all table sizes — asserting no duplicate clues, even mole rotation, and valid guess options every round. |
| `test-server.js` | Boots the real server and drives real WebSocket clients: secrecy (the payload sent to a player never names the mole), rejected clues, host permissions, reconnect into the same seat, and host migration. |
| `test-artifact.js` | Runs the published-page transport in three isolated JS contexts against an in-memory stand-in for the shared data store, including a host walking away mid-game. |

There is also `balance.js`, which plays a few thousand bot games at different
bot-skill settings and reports how often the mole gets caught. The shipped
settings land around 45% at a three-player table, which is roughly where a
bluffing game should sit.

## How it is put together

```
engine.js        pure rules — no I/O, no DOM, no network
view.js          what one player is allowed to see
deck.json        48 locations across 6 categories, each with its own vocabulary
server.js        static files + WebSocket rooms + phase clocks
public/          the interface: index.html, styles.css, app.js
public/net-ws.js websocket transport
public/net-db.js transport for the published-artifact build
build-artifact.js bundles everything into one self-contained page
```

The rules live in one pure module that knows nothing about how the game is
delivered, so the same engine drives the hosted server and the browser-only
build. `view.js` is the only place that decides what each player sees, which
means the two versions cannot drift apart on the thing that actually matters.

**Where the secret lives.** On this server, the location and the mole's identity
never leave the Node process — each player's socket receives a view built just
for them, and a test asserts that the payload sent to a player never contains
the mole's id. The published-artifact build has no server, so one player's
browser holds the game and writes it to shared storage; it plays identically,
but a determined player could read the state in their developer tools. That is
the reason this version exists.

**If the host leaves.** The server hands the host role to the longest-present
player still connected. In the browser-only build, a client whose heartbeat has
gone stale loses the table to the next player, who picks the game up mid-round
using a short lease so two tabs can't both claim it.

## Scoring

| | |
| --- | --- |
| Mole escapes the vote | +4 to the mole |
| Mole is caught | +2 to every other player |
| You voted for the real mole | +1 to you |
| A caught mole names the place | +3 to the mole |

The mole is caught only on a clear, untied plurality — a tie lets them walk.
Highest total after the last round wins.

## Deploying

See [DEPLOY.md](DEPLOY.md).

MIT licensed.
