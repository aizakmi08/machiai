import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadState, saveProfile } from "../packages/cli/src/local.js";

const cli = join(process.cwd(), "dist", "packages", "cli", "src", "cli.js");

test("profile command creates anonymous 500 MMR profile", () => {
  const home = mkdtempSync(join(tmpdir(), "machiai-profile-"));
  const output = execFileSync(process.execPath, [cli, "profile"], {
    encoding: "utf8",
    env: { ...process.env, MACHIAI_HOME: home },
  });
  assert.match(output, /MMR: 500/);
  assert.match(output, /Handle: coder-/);
});

test("profile command migrates old machiai handles to coder handles", () => {
  const home = mkdtempSync(join(tmpdir(), "machiai-profile-migrate-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({
      profile: {
        playerId: "player_test",
        deviceKey: "device_test",
        handle: "machiai-9153",
        mmr: 500,
        ratedGames: 0,
        createdAt: "2026-07-01T12:00:00.000Z",
        updatedAt: "2026-07-01T12:00:00.000Z",
      },
      waitSessions: [],
      games: [],
    }),
  );
  const output = execFileSync(process.execPath, [cli, "profile"], {
    encoding: "utf8",
    env: { ...process.env, MACHIAI_HOME: home },
  });
  const saved = JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as { profile: { handle: string } };
  assert.match(output, /Handle: coder-9153/);
  assert.equal(saved.profile.handle, "coder-9153");
});

test("saved rating survives local profile reload", () => {
  const previousHome = process.env.MACHIAI_HOME;
  const home = mkdtempSync(join(tmpdir(), "machiai-profile-rating-"));
  process.env.MACHIAI_HOME = home;
  try {
    const initial = loadState().profile;
    saveProfile({ ...initial, mmr: 612, ratedGames: 4, updatedAt: new Date().toISOString() });
    const reloaded = loadState().profile;
    assert.equal(reloaded.mmr, 612);
    assert.equal(reloaded.ratedGames, 4);
    assert.equal(reloaded.playerId, initial.playerId);
  } finally {
    if (previousHome === undefined) delete process.env.MACHIAI_HOME;
    else process.env.MACHIAI_HOME = previousHome;
  }
});

test("public server profile does not erase saved X auth", () => {
  const previousHome = process.env.MACHIAI_HOME;
  const home = mkdtempSync(join(tmpdir(), "machiai-profile-auth-preserve-"));
  process.env.MACHIAI_HOME = home;
  try {
    const initial = loadState().profile;
    saveProfile({
      ...initial,
      displayName: "@coder_dev",
      twitterHandle: "coder_dev",
      xUserId: "x_coder_dev",
      authToken: "local_auth_token",
      profileImageUrl: "https://example.com/avatar.jpg",
      updatedAt: new Date().toISOString(),
    });
    saveProfile({
      ...initial,
      displayName: "@coder_dev",
      twitterHandle: "coder_dev",
      mmr: 540,
      ratedGames: 2,
      updatedAt: new Date().toISOString(),
    });
    const reloaded = loadState().profile;
    assert.equal(reloaded.authToken, "local_auth_token");
    assert.equal(reloaded.xUserId, "x_coder_dev");
    assert.equal(reloaded.profileImageUrl, "https://example.com/avatar.jpg");
    assert.equal(reloaded.mmr, 540);
    assert.equal(reloaded.ratedGames, 2);
  } finally {
    if (previousHome === undefined) delete process.env.MACHIAI_HOME;
    else process.env.MACHIAI_HOME = previousHome;
  }
});

test("profile command saves twitter handle", () => {
  const home = mkdtempSync(join(tmpdir(), "machiai-profile-twitter-"));
  const output = execFileSync(process.execPath, [cli, "profile", "--twitter", "https://x.com/coder_dev"], {
    encoding: "utf8",
    env: { ...process.env, MACHIAI_HOME: home },
  });
  const saved = JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as { profile: { twitterHandle?: string } };
  assert.match(output, /Twitter: @coder_dev/);
  assert.equal(saved.profile.twitterHandle, "coder_dev");
});

test("profile save can clear twitter handle", () => {
  const previousHome = process.env.MACHIAI_HOME;
  const home = mkdtempSync(join(tmpdir(), "machiai-profile-clear-twitter-"));
  process.env.MACHIAI_HOME = home;
  try {
    const initial = loadState().profile;
    saveProfile({ ...initial, twitterHandle: "coder_dev", updatedAt: new Date().toISOString() });
    saveProfile({ ...initial, twitterHandle: undefined, updatedAt: new Date().toISOString() });
    assert.equal(loadState().profile.twitterHandle, undefined);
  } finally {
    if (previousHome === undefined) delete process.env.MACHIAI_HOME;
    else process.env.MACHIAI_HOME = previousHome;
  }
});

test("mcp-config prints npx config", () => {
  const output = execFileSync(process.execPath, [cli, "mcp-config"], { encoding: "utf8" });
  const parsed = JSON.parse(output) as { mcpServers: { machiai: { command: string; args: string[] } } };
  assert.equal(parsed.mcpServers.machiai.command, "npx");
  assert.deepEqual(parsed.mcpServers.machiai.args, ["-y", "@aizakmi08/machiai", "serve"]);
});

test("app smoke validates built overlay assets", () => {
  const output = execFileSync(process.execPath, [cli, "app", "--smoke"], { encoding: "utf8" });
  assert.match(output, /Machiai overlay ready:/);
  assert.match(output, /Renderer:/);
});
