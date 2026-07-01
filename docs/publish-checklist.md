# Publish Checklist

```bash
pnpm install
pnpm release:check
curl https://machiai-aizakmi08.onrender.com/health
pnpm publish --access public
```

Before publish:

- Confirm package name is `@aizakmi08/machiai`.
- Confirm `.npmrc` is not committed.
- Confirm `pnpm smoke` passes.
- Confirm Render `/health` returns `ok: true`.
- Confirm `machiai mcp-config` uses `npx -y @aizakmi08/machiai serve`.
- Confirm README examples match the published package name.
