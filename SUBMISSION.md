# Cover Story — submission write-up

Paste-ready copy for the Handshake mission. Replace `YOUR-URL` with the deployed
link before submitting.

---

## Short description (one or two lines)

**Cover Story** — a real-time multiplayer social deduction game for 3–8 players.
Everyone is shown the same place except one player, who is told only the
category. Two rounds of one-word clues, then a vote. Play it at YOUR-URL.

---

## What I built

Cover Story is a party game that runs in a browser and needs nothing installed.
One player starts a game and reads out a four-character code; everyone else
joins from their own phone or laptop. Each player's brief is private to their
own screen, which is what makes the game work at all.

Every round, the game deals a place — an airport terminal, a dive bar, a
glacier, a lost property office — and shows it to everyone but one randomly
chosen **mole**, who sees only the category it belongs to. Players then give one
word each, twice. An insider's word has to prove they know the place without
being so obvious that the mole can simply copy it. The mole has to invent a word
that fits a place they have never seen, read the table, and blend in.

Then everyone votes. The mole is caught only on a clear, untied plurality — a
split vote lets them walk. A caught mole gets one last shot at naming the place
from six options in the same category, and still takes points home if they get
it right.

| | |
| --- | --- |
| Mole escapes the vote | +4 to the mole |
| Mole is caught | +2 to every other player |
| You voted for the real mole | +1 to you |
| A caught mole names the place | +3 to the mole |

## How the requirements shaped it

**"Two players on separate devices"** ruled out anything clever with a single
shared screen. It meant a real server holding one authoritative game and sending
each player a view built only for them. That constraint turned out to define the
whole architecture: the rules live in one pure module with no I/O, and a single
small file decides what each player is allowed to see. Nothing else in the
codebase touches the secret.

**"Rules a player could follow without you explaining them"** was the harder
one. The first version dropped players into a clue box with no framing. I
rewrote the game around a visible brief — a card that states your role and what
you know — a rules panel reachable from every screen, and a statement log where
every word anyone has played stays on the table next to their name. The test is
whether someone who joins cold can play without being told anything, and that is
now true.

**"Live at a URL other people can reach"** meant no build step, no database, and
no paid tier: one Node process serving static files and WebSockets, deployable
free in about five minutes.

## What went wrong and what I did about it

Building it was fast. Making it actually work was the job.

**The bots were unplayable, twice.** I added bot players so a table of two
people could still get a game. In the first version the bot mole was caught 99%
of the time — bot insiders drew from the location's own vocabulary, so the mole's
word stuck out like a flare. I wrote a script that plays a few thousand bot games
and reports the catch rate, then fixed the cause rather than the symptom: bot
insiders now hedge about half the time, playing a bland word rather than the
obvious one, because that is what a human does when they don't want to be read.
That swung too far the other way — 13% — so I tuned it against the script until
a three-player table sat near 45%, which is about right for a bluffing game.

**Bots could deadlock a round.** With eight players and only twelve words
associated with a location, later bots ran out of things to say and the round
never closed. The soak test caught it. Bots now fall back through a second tier
of vocabulary and, failing that, a word guaranteed to be unused.

**The secret was in the wrong place.** My first pass sent the whole game state to
every client and let the browser hide the parts you shouldn't see, which is not
hiding anything. Each client now receives a payload built for them, and one of
the tests asserts that the mole's identity never appears in what gets sent to a
player.

**Two layout bugs I only found by looking.** I screenshotted the running game at
phone width and found the clue chips overlapping the player names, and a button
orphaned onto its own line in the lobby. Both were invisible in the code.

## Testing

Three suites, all runnable offline with `npm test`:

- **Engine** — clue validation, every scoring branch, and a soak of 720 complete
  games across all table sizes, asserting no duplicate clues, even mole
  rotation, and a valid set of guess options every round.
- **Server** — boots the real server and drives real WebSocket clients through a
  full game: secrecy, rejected clues, host permissions, reconnecting into the
  same seat with your score intact, and the host role passing on when the host
  disconnects.
- **Transport** — runs the browser-only build in three isolated JS contexts
  against a stand-in data store, including a host walking away mid-game.

## What I learned about working this way

The useful skill was not describing the game. It was deciding what to measure.
"The bots feel too easy to catch" is not actionable; a script that prints a catch
rate per table size is, and it turned a vague complaint into two specific fixes
and a number I could aim at. The same went for secrecy: once "the mole's id must
never be in a player's payload" was a test rather than an intention, the
architecture question answered itself.

The other lesson was that some bugs are only visible in a picture. The rules, the
scoring and the networking were all correct while the interface was quietly
unreadable on a phone.

## Try it

- **Play:** YOUR-URL
- **Code:** YOUR-REPO
- 3–8 players, about ten minutes. Short on people? The host can add bots.
