# Client Setup

## One Command

```bash
npx -y @aizakmi08/machiai run --overlay -- codex exec "build the feature"
```

Or open the overlay first:

```bash
npx -y @aizakmi08/machiai app
```

These commands use the default hosted server at `https://machiai-aizakmi08.onrender.com`.

## GitHub Quickstart Before npm Publish

```bash
curl -fsSL https://raw.githubusercontent.com/aizakmi08/machiai/main/scripts/quickstart.sh | bash -s --
```

With a temporary shared server URL:

```bash
curl -fsSL https://raw.githubusercontent.com/aizakmi08/machiai/main/scripts/quickstart.sh | bash -s -- https://your-public-server.example
```

The quickstart script requires Git and Node 20+. It installs/updates Machiai in `~/.machiai/source`, builds the overlay, and launches `machiai run --overlay`.

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

## Friend Test

Start one shared server and point both overlays at it:

```bash
machiai app --dev-server https://your-public-server.example
MACHIAI_SERVER_URL=https://your-public-server.example machiai run --overlay -- codex exec "build the feature"
```

The public URL can come from a hosted Machiai server or a temporary tunnel to `machiai server --port 4137`. Both players must use the same server URL.

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
