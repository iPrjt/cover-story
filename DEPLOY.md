# Putting Cover Story on the internet

The whole game is one Node process serving static files and WebSockets, with no
database and no build step, so it deploys almost anywhere. These steps take
about five minutes and cost nothing.

## Render (free, checked September 2026)

Render still runs a genuine free web-service tier: 750 free instance hours per
workspace per calendar month, and WebSocket traffic is supported and counts as
activity. A free service spins down after 15 minutes with no inbound traffic and
takes about a minute to wake back up.

1. **Put the code on GitHub.** From the project folder:

   ```bash
   git init
   git add .
   git commit -m "Cover Story"
   gh repo create cover-story --public --source . --push
   ```

   (Or create an empty repo on github.com and push to it the usual way.)

2. **Create the service.** On [render.com](https://render.com) → **New** →
   **Web Service** → connect the repo.

3. **Settings** — the defaults are almost right:

   | Field | Value |
   | --- | --- |
   | Runtime | Node |
   | Build command | `npm install` |
   | Start command | `npm start` |
   | Instance type | Free |

   Leave the port alone. The server reads `process.env.PORT`, which Render sets.

4. **Deploy.** You get a URL like `https://cover-story-xxxx.onrender.com`. That
   is the link you share — anyone on the internet can open it, no account
   needed.

**Two things worth knowing before a game night.** A free service sleeps after 15
minutes of quiet, so open the URL yourself a minute before you send it to
anyone. And because rooms are held in memory, a restart ends any game in
progress — fine for a party game, but don't start a five-round game the moment
after waking the service.

## Other options

- **Fly.io** — run `fly launch` in the project folder and accept the defaults;
  it detects Node and writes the config. Good if you want the service to stay
  awake.
- **Railway** — connect the repo and it will detect Node automatically. Its free
  usage is a trial credit rather than an ongoing free tier, so check the current
  terms before relying on it.
- **Any VPS** — `npm install && npm start` behind nginx or Caddy. Make sure your
  proxy passes WebSocket upgrade headers (`Connection: upgrade`).

## Checking it worked

Open the deployed URL on your phone and your laptop. Start a game on one, join
with the code on the other, add a bot so you have three players, and play a
round. If the clue box accepts a word and both screens update, everything is
wired correctly.

`GET /healthz` returns `ok` if you want an uptime check.

---

Sources for the free-tier details above:
[Render — Deploy for Free](https://render.com/docs/free),
[Render — Platforms with a real free tier for developers in 2026](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026),
[Render vs Railway vs Fly.io: Pricing Compared (2026)](https://dev.to/pavel-hostim/render-vs-railway-vs-flyio-pricing-compared-2026-2e5p).
