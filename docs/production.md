# Production Setup

Goal:

```bash
npx -y @aizakmi08/machiai run --overlay -- codex exec "build the feature"
```

This needs two public pieces:

1. A persistent Machiai Socket.IO server.
2. The `@aizakmi08/machiai` npm package.

## Deploy Server

The repo includes `Dockerfile` and `fly.toml` for Fly.io. The configured app URL is:

```text
https://machiai-aizakmi08.fly.dev
```

Deploy:

```bash
fly auth login
fly apps create machiai-aizakmi08
fly volumes create machiai_data --size 1 --region sjc
fly deploy
curl https://machiai-aizakmi08.fly.dev/health
curl https://machiai-aizakmi08.fly.dev/presence
```

If Fly says the app name is unavailable, choose another app name and update both:

- `fly.toml` `app`
- `packages/cli/src/config.ts` `DEFAULT_SERVER_URL`

## Publish npm

```bash
pnpm release:check
pnpm login
pnpm publish --access public
```

If npm requires two-factor authentication, either enter the OTP in the publish prompt or create a granular npm token with publish rights and bypass 2FA for automation.

## Final Smoke Test

After deploy and publish:

```bash
npx -y @aizakmi08/machiai app
npx -y @aizakmi08/machiai run --overlay -- sleep 300
curl https://machiai-aizakmi08.fly.dev/presence
```

With two people running the command, the overlay should show the online count and match both players into the same lobby.
