import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, screen, shell, type Rectangle } from "electron";
import { MachiaiServer } from "../../server/src/server.js";
import { detectAgentActivity } from "../../../packages/cli/src/agent-detector.js";
import {
  activeLocalWaitSession,
  attachMatchRating,
  clearAuth,
  loadState,
  machiaiHome,
  recentMatches,
  recordMatch,
  saveProfile,
  setReferenceSelector,
  updateProfile,
} from "../../../packages/cli/src/local.js";
import { linkHooks } from "../../../packages/cli/src/hook-install.js";
import { serverUrl } from "../../../packages/cli/src/config.js";
import type { MatchRecord, OverlayBootstrap, PlayerProfile, ReferenceSelector, SnapResult } from "../../../packages/shared/src/index.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(here, "preload.js");
const rendererPath = resolve(here, "../renderer/index.html");
const overlayStatePath = join(machiaiHome(), "overlay.json");

let mainWindow: BrowserWindow | undefined;
let localOverlayServer: MachiaiServer | undefined;
let localOverlayServerUrl: string | undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  app.whenReady().then(() => {
    registerIpc();
    createWindow();
  });
}

app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  if (localOverlayServer) {
    void localOverlayServer.stop();
    localOverlayServer = undefined;
    localOverlayServerUrl = undefined;
  }
});

app.on("activate", () => {
  if (!mainWindow) createWindow();
});

function createWindow(): BrowserWindow {
  const saved = loadOverlayBounds();
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 420,
    height: saved?.height ?? 520,
    minWidth: 360,
    minHeight: 460,
    x: saved?.x,
    y: saved?.y,
    title: "Machiai",
    alwaysOnTop: true,
    resizable: true,
    movable: true,
    show: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#101114",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", () => {
    if (mainWindow) saveOverlayBounds(mainWindow.getBounds());
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  const devUrl = process.env.MACHIAI_OVERLAY_RENDERER_URL;
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(rendererPath);
  return mainWindow;
}

function registerIpc(): void {
  ipcMain.handle("machiai:bootstrap", async (): Promise<OverlayBootstrap> => {
    const state = loadState();
    const detection = await detectAgentActivity({ state });
    return {
      profile: state.profile,
      serverUrl: await overlayServerUrl(),
      detection,
      activeWaitSession: activeLocalWaitSession(),
    };
  });

  ipcMain.handle("machiai:detect-agent", async () => detectAgentActivity());
  ipcMain.handle("machiai:set-reference", async (_event, selector: ReferenceSelector) => {
    setReferenceSelector(selector);
    return detectAgentActivity();
  });
  ipcMain.handle("machiai:link-hooks", async () => linkHooks());
  ipcMain.handle("machiai:record-match", (_event, record: MatchRecord) => recordMatch(record));
  ipcMain.handle("machiai:rating-result", (_event, gameId: string, mmrDelta: number, mmrAfter: number) => attachMatchRating(gameId, mmrDelta, mmrAfter));
  ipcMain.handle("machiai:list-matches", () => recentMatches());
  ipcMain.handle("machiai:update-profile", (_event, displayName: string, twitterHandle?: string) => updateProfile(displayName.trim(), twitterHandle));
  ipcMain.handle("machiai:save-profile", (_event, profile: PlayerProfile) => saveProfile(profile));
  ipcMain.handle("machiai:sign-out", () => clearAuth());
  ipcMain.handle("machiai:open-external", async (_event, url: string): Promise<void> => {
    await shell.openExternal(url, { activate: true });
  });
  ipcMain.handle("machiai:snap", async (): Promise<SnapResult> => snapWindow());
}

async function snapWindow(): Promise<SnapResult> {
  if (!mainWindow) return { ok: false, reason: "Window is not open." };
  const current = mainWindow.getBounds();
  const target = await readTargetWindowBounds();
  if (target) {
    const display = screen.getDisplayMatching(target);
    const next = placeBeside(target, current, display.workArea);
    mainWindow.setBounds(next, true);
    saveOverlayBounds(next);
    return { ok: true, reason: `Snapped beside ${target.appName}.` };
  }

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const next = {
    ...current,
    x: display.workArea.x + display.workArea.width - current.width - 16,
    y: display.workArea.y + 56,
  };
  mainWindow.setBounds(next, true);
  saveOverlayBounds(next);
  return { ok: true, reason: "Snapped to the current display. Enable macOS Accessibility for app-aware snapping." };
}

function placeBeside(target: TargetWindowBounds, current: Rectangle, workArea: Rectangle): Rectangle {
  const rightX = target.x + target.width + 12;
  const leftX = target.x - current.width - 12;
  const x = rightX + current.width <= workArea.x + workArea.width ? rightX : Math.max(workArea.x, leftX);
  const y = Math.min(Math.max(workArea.y, target.y), workArea.y + workArea.height - current.height);
  return { ...current, x, y };
}

interface TargetWindowBounds extends Rectangle {
  appName: string;
}

async function readTargetWindowBounds(): Promise<TargetWindowBounds | undefined> {
  if (process.platform !== "darwin") return undefined;
  const script = `
set targetApps to {"Codex", "Claude", "Cursor", "Terminal", "iTerm2"}
tell application "System Events"
  repeat with appName in targetApps
    if exists process appName then
      tell process appName
        if (count of windows) > 0 then
          set windowPosition to position of window 1
          set windowSize to size of window 1
          return (item 1 of windowPosition as text) & "," & (item 2 of windowPosition as text) & "," & (item 1 of windowSize as text) & "," & (item 2 of windowSize as text) & "," & (appName as text)
        end if
      end tell
    end if
  end repeat
end tell
return ""
`;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 1500 });
    const trimmed = stdout.trim();
    if (!trimmed) return undefined;
    const [x, y, width, height, appName] = trimmed.split(",");
    const bounds = {
      x: Number(x),
      y: Number(y),
      width: Number(width),
      height: Number(height),
      appName,
    };
    if ([bounds.x, bounds.y, bounds.width, bounds.height].some((value) => !Number.isFinite(value))) return undefined;
    return bounds;
  } catch {
    return undefined;
  }
}

function loadOverlayBounds(): Rectangle | undefined {
  if (!existsSync(overlayStatePath)) return undefined;
  try {
    const data = JSON.parse(readFileSync(overlayStatePath, "utf8")) as Partial<Rectangle>;
    const { x, y, width, height } = data;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      return undefined;
    }
    return { x: x as number, y: y as number, width: width as number, height: height as number };
  } catch {
    return undefined;
  }
}

function saveOverlayBounds(bounds: Rectangle): void {
  mkdirSync(dirname(overlayStatePath), { recursive: true });
  writeFileSync(overlayStatePath, JSON.stringify(bounds, null, 2));
}

async function overlayServerUrl(): Promise<string> {
  if (process.env.MACHIAI_LOCAL_SERVER !== "1") return serverUrl();
  if (localOverlayServerUrl) return localOverlayServerUrl;
  const storePath = join(machiaiHome(), "overlay-server.sqlite");
  localOverlayServer = new MachiaiServer({ storePath });
  localOverlayServerUrl = await localOverlayServer.start(0);
  return localOverlayServerUrl;
}
