# Machiai

Chess for people waiting on AI agents.

Machiai is a floating chess overlay for Codex, Claude, Cursor, and other coding agents. Open the square window, keep it beside your agent app, and play 3+0 chess only while an agent is running.

## One Command

For most users:

```bash
npx -y @aizakmi08/machiai app
```

The overlay opens, asks the user to sign in with X, then unlocks rated chess when an agent is active through Machiai.

Final public setup:

```bash
npx -y @aizakmi08/machiai run --overlay -- codex exec "build the feature"
```

Or open the overlay first:

```bash
npx -y @aizakmi08/machiai app
```

Before npm publish, use the GitHub quickstart fallback:

```bash
curl -fsSL https://raw.githubusercontent.com/aizakmi08/machiai/main/scripts/quickstart.sh | bash -s --
```

That installs/updates Machiai under `~/.machiai/source`, opens the overlay, and starts a temporary 5-minute wait session so rated chess is unlocked.

The most reliable unlock path is still wrapping the agent command:

```bash
npx -y @aizakmi08/machiai run --overlay -- codex exec "build the feature"
npx -y @aizakmi08/machiai run -- codex exec "build the feature"
npx -y @aizakmi08/machiai run -- claude -p "fix the bug"
```

The game does not pause when the agent finishes. You get notified, you can finish the current game, and you cannot queue for another rated game until another agent is running.

## Why It Exists

AI coding agents created a new idle state: waiting for work to finish. Most people fill that gap by scrolling. Machiai turns it into a small, bounded sidequest.

Rules that keep it healthy:

- 3+0 chess only: max 6 minutes of clock time.
- No rated queue without an active agent wait session.
- Rated online play requires X login; usernames are the player's `@handle`.
- No infinite rematch button.
- Quick chat and reactions are in-game only. No streaks, loot, or feed mechanics.
- Bot practice is unrated and only fills an empty lobby.

## Commands

```bash
machiai app [--dev-server <url>]  # open the floating desktop chess overlay
machiai app --local               # open overlay with a private local server
machiai run -- <command...>       # run an agent and unlock chess
machiai run --overlay -- <cmd...> # run an agent and open the overlay
machiai play                      # play only if a local wait session is active
machiai profile [--name <name>] [--twitter <handle>] # show/update anonymous profile
machiai leaderboard               # show hosted leaderboard
machiai demo                      # run a local two-client demo
machiai server [--port 4137]      # start local matchmaking server
machiai mcp-config                # print MCP config
machiai serve                     # start MCP server
```

## Local Demo

```bash
npx -y @aizakmi08/machiai demo
```

It starts an in-process matchmaking server, creates two fake waiting coders, matches them, plays four plies, and ends by resignation.

## Desktop Overlay

```bash
machiai app
machiai run --overlay -- codex exec "build the feature"
```

The overlay is an always-on-top macOS window with drag/drop and click-to-move chess. By default it connects to the public Machiai matchmaking server. Rated queue unlocks from a fresh Machiai wait session, MCP wait session, or a detected one-shot CLI agent command such as `codex exec ...` or `claude -p ...`. Open Codex/Claude/Cursor app windows are shown as best-effort context only unless a reliable running command is visible. Wrapping with `machiai run --overlay -- ...` is the strict unlock path.

On macOS, `machiai run --overlay -- codex ...` automatically falls back to the Codex app-bundled CLI if plain `codex` is not in your shell `PATH`.

Local wait sessions heartbeat while the wrapped command is running. If a terminal is killed or a stale session is left behind, Machiai expires it and locks Start again.

Rated queue requires X login. The package never asks users for API keys.

For private local testing:

```bash
machiai app --local
```

For a custom development server:

```bash
machiai app --dev-server http://127.0.0.1:4137
```

## Local Server

X login is configured only on the hosted server. For a deployed server, set:

```bash
X_CLIENT_ID=...
X_CLIENT_SECRET=...
MACHIAI_PUBLIC_URL=https://your-machiai-server.example
```

The X callback URL should be:

```text
https://your-machiai-server.example/auth/x/callback
```

Terminal 1:

```bash
machiai server --port 4137
```

Terminal 2:

```bash
MACHIAI_SERVER_URL=http://127.0.0.1:4137 machiai run -- node fake-agent.js
```

The server uses SQLite when the Node runtime exposes `node:sqlite`, with JSON fallback for older runtimes. Override the store path:

```bash
MACHIAI_STORE=.machiai/server-store.sqlite machiai server
```

For a scaled production server, use shared Postgres persistence and the Socket.IO Redis adapter:

```bash
DATABASE_URL=postgres://user:password@host:5432/machiai
REDIS_URL=redis://default:password@host:6379
MACHIAI_PG_POOL_SIZE=20
machiai server
```

`/stats` exposes sockets, online players, queued players, auth sessions, timers, and rate-limit buckets for basic monitoring.

Local scale check:

```bash
pnpm load:local
```

This starts a local server, connects 1,000 signed test clients, matches 50 games, sends real moves, checks presence/stats/leaderboard, and reconnects 100 clients without using production secrets.

## Friend Test

After the hosted server is deployed and npm is published, both players use the normal command:

```bash
npx -y @aizakmi08/machiai run --overlay -- codex exec "build the feature"
```

For temporary pre-launch testing, pass a shared server URL to the GitHub quickstart:

```bash
curl -fsSL https://raw.githubusercontent.com/aizakmi08/machiai/main/scripts/quickstart.sh | bash -s -- https://your-public-server.example
```

The overlay shows the live online count in the top-right corner after both clients connect.

## Rating

- Starting MMR: `500`
- First 20 rated games: `K=40`
- Later rated games: `K=24`
- Win = `1`, draw = `0.5`, loss = `0`
- Resign and timeout are losses
- Bot games are unrated
- Games aborted before both players move are unrated

## MCP

Add this to an MCP client:

```json
{
  "mcpServers": {
    "machiai": {
      "command": "npx",
      "args": ["-y", "@aizakmi08/machiai", "serve"]
    }
  }
}
```

MCP tools:

- `machiai_start_wait`
- `machiai_end_wait`
- `machiai_status`
- `machiai_join_queue`
- `machiai_make_move`
- `machiai_resign`
- `machiai_leaderboard`

MCP V1 uses local bot-backed games because most MCP clients do not expose a real-time chess UI yet. The CLI is the main multiplayer surface.

## Development

```bash
pnpm install
pnpm test:build
pnpm smoke
```

Release gate:

```bash
pnpm release:check
```

## Launch Copy

```text
I got tired of doomscrolling while Codex was running.

So I built Machiai:
a floating chess overlay for people waiting on AI agents.

Your agent works.
You play 3-minute chess.
When the agent finishes, you get notified.
No next game until another agent is running.
```
