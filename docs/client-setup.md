# Client Setup

## npx

```bash
npx -y @aizakmi08/machiai app
npx -y @aizakmi08/machiai run --overlay -- codex exec "build the feature"
npx -y @aizakmi08/machiai demo
npx -y @aizakmi08/machiai run -- codex exec "build the feature"
```

## Local Development Server

```bash
pnpm server --port 4137
MACHIAI_SERVER_URL=http://127.0.0.1:4137 pnpm dev -- run -- node fake-agent.js
pnpm build
node dist/packages/cli/src/cli.js app --dev-server http://127.0.0.1:4137
MACHIAI_SERVER_URL=http://127.0.0.1:4137 node dist/packages/cli/src/cli.js run --overlay -- node examples/fake-agent.js
```

## MCP Config

```bash
machiai mcp-config
```

Output:

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

## Environment Variables

- `MACHIAI_SERVER_URL`: override matchmaking server URL.
- `MACHIAI_HOME`: override local profile/session state directory.
- `MACHIAI_STORE`: override server persistence path.
- `MACHIAI_STORE_DRIVER=json`: force JSON persistence instead of SQLite.
- `MACHIAI_DISABLE_PTY=1`: force pipe-mode agent wrapping.
- `MACHIAI_DISABLE_INK=1`: print plain text banner instead of Ink banner.
- `MACHIAI_OVERLAY_RENDERER_URL`: load a local renderer dev URL in the Electron overlay.
