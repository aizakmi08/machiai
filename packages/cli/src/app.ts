import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag, readOption } from "./config.js";

const require = createRequire(import.meta.url);

export interface OverlayLaunchOptions {
  waitForExit?: boolean;
}

export async function startOverlayApp(args: string[], options: OverlayLaunchOptions = {}): Promise<void> {
  const waitForExit = options.waitForExit ?? true;
  const server = readOption(args, "--dev-server") ?? readOption(args, "--server-url");
  const localServer = hasFlag(args, "--local");
  const smoke = hasFlag(args, "--smoke");
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const mainPath = resolve(cliDir, "../../../apps/overlay/src/main.js");
  const rendererPath = resolve(cliDir, "../../../apps/overlay/renderer/index.html");

  if (!existsSync(mainPath)) {
    throw new Error("Machiai overlay is not built. Run `pnpm build` before `machiai app` in development.");
  }
  if (!existsSync(rendererPath)) {
    throw new Error("Machiai overlay renderer is not built. Run `pnpm overlay:build`.");
  }
  validateRendererBundle(rendererPath);
  if (smoke) {
    console.log(`Machiai overlay ready: ${mainPath}`);
    console.log(`Renderer: ${rendererPath}`);
    return;
  }

  const electronPath = require("electron") as string;
  const child = spawn(electronPath, [mainPath], {
    stdio: waitForExit ? "inherit" : "ignore",
    detached: !waitForExit,
    env: {
      ...process.env,
      ...(server ? { MACHIAI_SERVER_URL: server } : {}),
      ...(localServer ? { MACHIAI_LOCAL_SERVER: "1" } : {}),
    },
  });

  if (!waitForExit) {
    child.unref();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code && code !== 0) reject(new Error(`Machiai overlay exited with code ${code}.`));
      else resolve();
    });
  });
}

function validateRendererBundle(rendererPath: string): void {
  const html = readFileSync(rendererPath, "utf8");
  const refs = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]).filter((ref) => ref.startsWith("./"));
  if (refs.length === 0) {
    throw new Error("Machiai overlay renderer has no relative JS/CSS asset references. Run `pnpm overlay:build`.");
  }
  for (const ref of refs) {
    const assetPath = resolve(dirname(rendererPath), ref);
    if (!existsSync(assetPath)) {
      throw new Error(`Machiai overlay renderer asset is missing: ${ref}`);
    }
  }
}
