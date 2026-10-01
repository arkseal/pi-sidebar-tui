import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Mirrors pi-coding-agent's getAgentDir() ($PI_CODING_AGENT_DIR or ~/.pi/agent).
// Inlined instead of importing the package so tests never load the full
// pi-coding-agent module graph (it pulls in @earendil-works/pi-server, which
// is only present inside a real pi runtime).
function agentDir(): string {
  const envDir = process.env["PI_CODING_AGENT_DIR"];
  if (envDir) {
    return envDir.startsWith("~/") ? join(homedir(), envDir.slice(2)) : envDir;
  }
  return join(homedir(), ".pi", "agent");
}

export interface SidebarSettings {
  enabled: boolean;
  width: number;
  /** Max todos shown in the Todos panel before it caps to the last N (+ a "+N more" footer). */
  todosMax: number;
  /** Number of lines to scroll per wheel/trackpad tick in fullscreen mode (default: 1). */
  scrollSpeed: number;
  /** Whether scrolling carries velocity and momentum in fullscreen mode (default: true). */
  momentum: boolean;
  /** Whether the dynamic subagents panel is shown in the sidebar (default: true). */
  subagents: boolean;
}

export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = { enabled: true, width: 45, todosMax: 5, scrollSpeed: 1, momentum: true, subagents: true };
export const MIN_SIDEBAR_WIDTH = 10;
export const MAX_SIDEBAR_WIDTH = 120;
export const MIN_TODOS_MAX = 1;
export const MAX_TODOS_MAX = 100;
export const MIN_SCROLL_SPEED = 1;
export const MAX_SCROLL_SPEED = 20;

export function sidebarConfigPath(): string {
  return process.env["PI_SIDEBAR_CONFIG"] || join(agentDir(), "sidebar-tui.json");
}

export function loadSidebarSettings(path: string = sidebarConfigPath()): SidebarSettings {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ...DEFAULT_SIDEBAR_SETTINGS };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SIDEBAR_SETTINGS };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...DEFAULT_SIDEBAR_SETTINGS };
  }

  const obj = parsed as Record<string, unknown>;
  const settings: SidebarSettings = { ...DEFAULT_SIDEBAR_SETTINGS };
  if (typeof obj["enabled"] === "boolean") {
    settings.enabled = obj["enabled"];
  }
  const w = obj["width"];
  if (typeof w === "number" && Number.isInteger(w) && w >= MIN_SIDEBAR_WIDTH && w <= MAX_SIDEBAR_WIDTH) {
    settings.width = w;
  }
  const tm = obj["todosMax"];
  if (typeof tm === "number" && Number.isInteger(tm) && tm >= MIN_TODOS_MAX && tm <= MAX_TODOS_MAX) {
    settings.todosMax = tm;
  }
  const ss = obj["scrollSpeed"];
  if (typeof ss === "number" && Number.isInteger(ss) && ss >= MIN_SCROLL_SPEED && ss <= MAX_SCROLL_SPEED) {
    settings.scrollSpeed = ss;
  }
  const envSpeed = process.env["PI_SIDEBAR_SCROLL_SPEED"] ? parseInt(process.env["PI_SIDEBAR_SCROLL_SPEED"], 10) : NaN;
  if (!isNaN(envSpeed) && envSpeed >= MIN_SCROLL_SPEED && envSpeed <= MAX_SCROLL_SPEED) {
    settings.scrollSpeed = envSpeed;
  }
  if (typeof obj["momentum"] === "boolean") {
    settings.momentum = obj["momentum"];
  }
  const envMom = process.env["PI_SIDEBAR_MOMENTUM"];
  if (envMom === "1" || envMom === "true") settings.momentum = true;
  if (envMom === "0" || envMom === "false") settings.momentum = false;
  if (typeof obj["subagents"] === "boolean") {
    settings.subagents = obj["subagents"];
  }
  const envSubagents = process.env["PI_SIDEBAR_SUBAGENTS"];
  if (envSubagents === "1" || envSubagents === "true") settings.subagents = true;
  if (envSubagents === "0" || envSubagents === "false") settings.subagents = false;
  return settings;
}

export function saveSidebarSettings(settings: SidebarSettings, path: string = sidebarConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
