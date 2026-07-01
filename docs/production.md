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
