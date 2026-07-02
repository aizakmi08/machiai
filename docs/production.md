# Production Setup

Goal:

```bash
npx -y @aizakmi08/machiai run --overlay -- codex exec "build the feature"
```

This needs two public pieces:

1. A Machiai Socket.IO server on Render.
2. The `@aizakmi08/machiai` npm package.

## Deploy Server on Render

The repo includes `render.yaml` for Render Blueprint deploys. The configured service URL is:

```text
https://machiai-aizakmi08.onrender.com
```

Deploy:

1. Open [Render Blueprints](https://dashboard.render.com/blueprints).
2. Click **New Blueprint Instance**.
3. Connect `https://github.com/aizakmi08/machiai`.
4. Select the `machiai-aizakmi08` web service from `render.yaml`.
5. Create/apply the Blueprint.

After the deploy completes:

```bash
curl https://machiai-aizakmi08.onrender.com/health
curl https://machiai-aizakmi08.onrender.com/presence
curl https://machiai-aizakmi08.onrender.com/stats
```

Expected health response:

```json
{
  "ok": true,
  "service": "machiai"
}
```

Render Free tradeoffs:

- The service can sleep after idle time.
- First request after sleep can be slow.
- The free filesystem is ephemeral, so ratings can reset after restarts.
- WebSockets are supported and work for MVP multiplayer testing.

## Runtime Guardrails

The server has built-in per-socket rate limits for auth, profile updates, wait heartbeats, queue actions, moves, resigns, reactions, and chat. X auth start/poll HTTP endpoints are rate-limited by client IP. These limits are intentionally in-memory for V1, so they protect one server process and reset when that process restarts.

`/stats` returns lightweight operational counters:

```json
{
  "ok": true,
  "service": "machiai",
  "sockets": 1,
  "onlinePlayers": 1,
  "queuedPlayers": 0,
  "redisAdapter": true,
  "pendingAuthSessions": 0,
  "botFallbackTimers": 0,
  "botMoveTimers": 0,
  "disconnectTimers": 0,
  "rateBuckets": 3
}
```

## Scaled Server Environment

For friend testing, no extra infrastructure is required. The server defaults to local SQLite.

For real production traffic, configure shared persistence and shared Socket.IO pub/sub:

```bash
DATABASE_URL=postgres://user:password@host:5432/machiai
REDIS_URL=redis://default:password@host:6379
MACHIAI_PG_POOL_SIZE=20
```

What these do:

- `DATABASE_URL` enables the Postgres store for players, X login state, wait sessions, games, moves, leaderboard, and rating events.
- `REDIS_URL` enables the Socket.IO Redis adapter so game rooms, player rooms, and broadcasts work across multiple server instances.
- `MACHIAI_PG_POOL_SIZE` controls the Postgres connection pool size per server process.

Postgres also stores a rating-finalization claim per game, so multiple server instances cannot apply the same rated result twice.

If `DATABASE_URL` is absent, Machiai uses SQLite or JSON fallback. If `REDIS_URL` is absent, Machiai uses the default in-process Socket.IO adapter.

## Scale Readiness

The included Render setup is good for public MVP testing and friend demos when left on local SQLite. With `DATABASE_URL`, `REDIS_URL`, sticky WebSocket sessions, and multiple web instances, Machiai has the core shared-state pieces needed for larger traffic.

Before pushing Machiai to thousands of concurrent users:

- Use managed Postgres or another network database with backups.
- Use Redis-backed Socket.IO pub/sub before running more than one server instance.
- Enable sticky WebSocket sessions at the load balancer.
- Move queue/presence/rate-limit state to shared infrastructure when running more than one server instance.
- Run a load test that covers connection churn, active games, bot fallback, reconnect grace, and leaderboard reads.

The npm client does not need to change for that architecture; `MACHIAI_SERVER_URL` can point users at the scaled server.

If Render changes the service slug, update both:

- `render.yaml` `name`
- `packages/cli/src/config.ts` `DEFAULT_SERVER_URL`

## Publish npm

Publish only after `/health` works:

```bash
pnpm release:check
pnpm login
pnpm publish --access public
```

If npm requires two-factor authentication, either enter the OTP in the publish prompt or create a granular npm token with publish rights and bypass 2FA for automation.

## Final Smoke Test

After Render deploy and npm publish:

```bash
npx -y @aizakmi08/machiai app
npx -y @aizakmi08/machiai run --overlay -- sleep 300
curl https://machiai-aizakmi08.onrender.com/presence
```

With two people running the command, the overlay should show the online count and match both players into the same lobby.
