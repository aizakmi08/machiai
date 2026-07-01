# Testing

Run:

```bash
pnpm test:build
```

Coverage in V1:

- Legal and illegal chess moves
- Timeout, resign, abort, and draw-safe rating behavior
- Starting MMR and Elo-style rating deltas
- Two-client matchmaking and rated game completion
- Agent completion lockout: current game continues, next queue is blocked
- Bot fallback after an empty lobby
- Agent detector active/maybe/inactive behavior
- CLI profile, MCP config, and overlay asset smoke behavior

Smoke:

```bash
pnpm smoke
```

Overlay-only smoke:

```bash
pnpm build
node dist/packages/cli/src/cli.js app --smoke
```

Release:

```bash
pnpm release:check
```
