import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "src", "mcp.js");

test("MCP server exposes Machiai tools over stdio", async () => {
  const home = mkdtempSync(join(tmpdir(), "machiai-mcp-"));
  const client = new Client({ name: "machiai-test-client", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: home,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      MACHIAI_HOME: home,
    },
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "machiai_end_wait",
      "machiai_join_queue",
      "machiai_leaderboard",
      "machiai_make_move",
      "machiai_resign",
      "machiai_start_wait",
      "machiai_status",
    ]);
    const status = await client.callTool({ name: "machiai_status", arguments: {} });
    const content = status.content as Array<{ type: string; text: string }>;
    assert.equal(content[0].type, "text");
    assert.match(content[0].text, /profile/);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
});
