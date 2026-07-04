# Machiai Claude Handoff Context

Use this file as the compact full-context handoff for working on Machiai.

## Product Summary

Machiai is a macOS-first floating chess overlay for developers waiting on AI coding agents such as Codex, Claude, Cursor, and terminal agent CLIs.

Core public command:

```bash
npx -y @aizakmi08/machiai app
```

Most reliable agent-wait command:

```bash
npx -y @aizakmi08/machiai run --overlay -- codex exec "build the feature"
npx -y @aizakmi08/machiai run --overlay -- claude -p "fix the bug"
```

Product promise:

- User opens a small always-on-top chess overlay.
- Rated chess unlocks only while an AI coding agent is actively working.
- Games are 3+0 blitz, so max clock time is 6 minutes.
- When the agent finishes, the current game continues, but the user cannot queue for another rated match until an agent is working again.
- X login is required for rated online play.
- Bot fallback starts an unrated practice game if the lobby is empty.
- No infinite rematch/feed/streak mechanics. This is meant to be a bounded "side quest," not brainrot.

## Current State

Repo:

```text
/Users/admin/Documents/YC/machiai
github: git@github.com:aizakmi08/machiai.git
public repo: https://github.com/aizakmi08/machiai
npm package: @aizakmi08/machiai
```

Current local package version at the time this file was created:

```text
0.1.24
```

The repo is on `main` and has been pushed to `origin/main`.

Important commit history around launch:

```text
196d5ed Fix post-game MMR display, chat visibility, and history X links
620a38b Fix false 'agent running' when an agent app is merely opened (0.1.24)
b3e9f9a Release 0.1.23: piece legibility, Games placement, faster idle detection
0f9eeb9 Fix 'agent running' lingering ~12s after the turn ends
f815eb5 Release 0.1.21: supersede 0.1.20, fix bin paths for npm 11
0cd6915 Fix X login persistence and retry flow
```

## Architecture

Small monorepo:

```text
packages/cli      CLI, local profile/state, agent wrapper, MCP server, detector
packages/shared   chess/rating/profile/session/shared types
apps/server       Socket.IO matchmaking server + HTTP auth/status endpoints
apps/overlay      Electron main/preload + React renderer chess overlay
test              node --test test suite
scripts           load test and quickstart
docs              setup, production, testing docs
```

Main technologies:

- TypeScript
- Electron for the desktop overlay
- React renderer inside Electron
- chess.js for legal moves/game state
- Socket.IO for realtime matchmaking/game events
- SQLite/JSON local stores, Postgres support for production
- Redis adapter support for multi-instance Socket.IO
- MCP SDK for `machiai serve`
- node-pty optional dependency for TTY-preserving command wrapping

## Important Commands

Development:

```bash
pnpm install
pnpm build
pnpm check
pnpm test:build
pnpm release:check
pnpm load:local
```

Manual app:

```bash
pnpm app
node dist/packages/cli/src/cli.js app
node dist/packages/cli/src/cli.js app --local
node dist/packages/cli/src/cli.js app --smoke
```

Public package smoke:

```bash
npx -y @aizakmi08/machiai app --smoke
npx -y @aizakmi08/machiai app
```

If a local machine has a stale pnpm-backed `npx` shim, pin the package:

```bash
npx -y @aizakmi08/machiai@0.1.24 app
```

Release:

```bash
pnpm release:check
pnpm publish --access public --no-git-checks
```

## Agent Detection

This is the most sensitive product behavior.

Machiai should NOT unlock rated chess just because Codex/Claude/Cursor is open. It should unlock only when an agent is actually working.

Detection layers, strongest first:

1. Exact local hooks installed by `machiai link`.
2. Local wait sessions created by `machiai run --overlay -- ...`.
3. Session transcript structure from `~/.claude/projects` and `~/.codex/sessions`.
4. Process/app activity fallback.

Rules:

- Open agent app only: `maybe` or idle, not rated unlock.
- Active agent turn: `active`, queue unlocks.
- Finished/paused/stopped turn: should quickly become idle/inactive.
- UI status pill should be stable and not flicker between agents when multiple sessions exist.
- Detection must not read source code, prompts, secrets, or full transcript contents. It should use structural metadata/timestamps/turn markers only.

Relevant files:

```text
packages/cli/src/agent-detector.ts
packages/cli/src/session-registry.ts
packages/cli/src/hook-install.ts
test/agent-detector.test.ts
test/session-registry.test.ts
test/detection-methods.test.ts
```

## X Login

Rated online play requires X login. The UI should use the player's X handle as identity.

Important previous bug:

- Pending X OAuth sessions were originally in server memory only.
- Render restarts/deploys could break callbacks or leave local clients with stale auth.
- Fixed by persisting X auth sessions in the store.

Current behavior:

- `/auth/x/start` creates a persisted auth session.
- Browser opens X OAuth.
- `/auth/x/callback` completes login, stores profile/auth token.
- Overlay polls `/auth/x/session/:id`.
- If Chrome does not foreground the tab, overlay shows `Open X login again` so the flow is recoverable.
- If server rejects stale local auth with `auth_required`, overlay clears stale local auth and asks user to sign in again.

Relevant files:

```text
apps/server/src/server.ts
apps/server/src/store.ts
apps/overlay/src/main.ts
apps/overlay/src/renderer/App.tsx
test/server.test.ts
```

Hosted callback URL:

```text
https://machiai-aizakmi08.onrender.com/auth/x/callback
```

Render env needed:

```text
X_CLIENT_ID
X_CLIENT_SECRET
MACHIAI_PUBLIC_URL=https://machiai-aizakmi08.onrender.com
DATABASE_URL
```

## Matchmaking / Game Flow

Server events:

Client sends:

```text
auth.anonymous
wait.heartbeat
queue.join
queue.leave
game.move
game.resign
reaction.send
chat.send
profile.update
```

Server sends:

```text
auth.ready
presence.updated
queue.status
wait.locked
game.started
game.state
game.ended
rating.updated
reaction.received
chat.received
error
```

Rated games:

- Require trusted X auth.
- Require active wait session.
- MMR starts at 500.
- First 20 rated games K=40, after that K=24.
- Resign and timeout are losses.
- Aborted games before both players move do not affect MMR.

Bot games:

- Start after empty lobby fallback.
- Unrated, no MMR change.
- Bot strength scales with user MMR but remains bounded.

Relevant files:

```text
apps/server/src/server.ts
packages/shared/src/chess.ts
packages/shared/src/rating.ts
packages/shared/src/bot.ts
test/server.test.ts
test/shared.test.ts
```

## Overlay UX Requirements

Design direction:

- Minimal black and white.
- Compact floating square-ish window.
- Board-first.
- Start button under the board and as wide as the board.
- Text must never overlap clocks, board, or controls.
- Opponent/player name and MMR must be visible.
- Opponent X handle should be clickable to profile.
- Last move and legal move hints should be visible.
- Reactions and quick chat are on the side rail and must stay usable as the window resizes.
- Post-game MMR and history must be accurate.

Known UI gotchas already fixed before this handoff:

- Old app launcher sometimes opened Electron default page. Fixed by launcher `main.cjs` using `MACHIAI_ELECTRON_MAIN`.
- Start button looked dead when server rejected stale X auth. Fixed by prioritizing error messages and clearing stale auth.
- X login could appear stuck. Fixed with `Open X login again`.
- Piece colors were muddy/low contrast. Fixed in later releases.
- Games/history button placement had to avoid macOS traffic lights and centered title.
- False `agent running` from merely opened app was fixed in 0.1.24.

## Production / Hosting

Current intended hosted server:

```text
https://machiai-aizakmi08.onrender.com
```

Health endpoints:

```bash
curl https://machiai-aizakmi08.onrender.com/health
curl https://machiai-aizakmi08.onrender.com/stats
curl https://machiai-aizakmi08.onrender.com/presence
```

Render config:

```text
render.yaml
```

Production persistence:

- Public server should use Postgres via `DATABASE_URL`.
- Redis optional but needed for multi-instance Socket.IO.
- Without Postgres, Render ephemeral disk can lose ratings/auth tokens after restart.

## GitHub Contribution Graph Note

Some earlier commits were authored as:

```text
Admin <admin@Admins-MacBook-Pro.local>
```

Those commits may not show on the GitHub contribution graph unless that email is added to the GitHub account or history is rewritten. This is not an app bug.

For future commits, configure:

```bash
git config --global user.name "Ulugbek Karimov"
git config --global user.email "96584624+aizakmi08@users.noreply.github.com"
```

Confirm the correct email from GitHub Settings -> Emails before using it.

## Local npx Gotcha

On the owner's machine, `/Users/admin/.local/bin/npx` is a custom shim around pnpm. pnpm had a `minimumReleaseAge` gate that caused unpinned `@latest` to resolve to stale `0.1.0` for a freshly published package.

Fix/workaround:

```bash
npx -y @aizakmi08/machiai@0.1.24 app
```

or ensure the local npx shim sets:

```bash
PNPM_CONFIG_MINIMUM_RELEASE_AGE=0
```

Public npm latest itself was fine.

## Testing Expectations

Before claiming a fix is done:

```bash
pnpm check
pnpm test:build
pnpm smoke
pnpm release:check
```

For server scale:

```bash
pnpm load:local
```

Manual QA checklist:

- `npx -y @aizakmi08/machiai app --smoke` resolves to current version.
- Overlay opens.
- X login button works or shows recoverable retry state.
- Signed-in state shows `@handle`.
- No agent running: Start should be locked.
- Agent active: Start unlocks.
- Start enters queue.
- Bot fallback starts if no human appears.
- Legal move hints show.
- Last move shows.
- Bot/human game result appears.
- Bot game does not change MMR.
- Rated game changes MMR.
- Games history records result and links X handles.
- Closing/reopening preserves local profile and match history.

## Things To Avoid

- Do not make rated chess available when no agent is active.
- Do not read user prompts/source/secrets for detection.
- Do not add infinite rematch/feed/streaks/loot.
- Do not make the first screen a landing page. It must be the usable overlay.
- Do not silently swallow auth errors.
- Do not rely on Render ephemeral disk for public auth/rating persistence.
- Do not hand-roll chess rules; use `chess.js`.
- Do not break the one-command public launch:

```bash
npx -y @aizakmi08/machiai app
```

