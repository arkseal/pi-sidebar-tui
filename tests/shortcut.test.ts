import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SIDEBAR_SETTINGS } from "../config.ts";

// The sidebar module captures width/todosMax from the config at import time
// (the defaults when no file exists) and persists them on every toggle, so the
// expected saved settings must match those defaults.
const W = DEFAULT_SIDEBAR_SETTINGS.width;
const saved = (enabled: boolean) => ({
  enabled,
  width: W,
  todosMax: DEFAULT_SIDEBAR_SETTINGS.todosMax,
  scrollSpeed: DEFAULT_SIDEBAR_SETTINGS.scrollSpeed,
  momentum: DEFAULT_SIDEBAR_SETTINGS.momentum,
  subagents: DEFAULT_SIDEBAR_SETTINGS.subagents,
});

function fakePi() {
  const shortcuts = new Map<string, { description?: string; handler: (ctx: any) => void }>();
  const commands = new Map<string, any>();
  return {
    shortcuts,
    commands,
    pi: {
      on: () => {},
      registerCommand: (name: string, opts: any) => { commands.set(name, opts); },
      registerShortcut: (id: string, opts: any) => { shortcuts.set(id, opts); },
    } as any,
  };
}

function makeCtx(notify: (msg: string, level?: string) => void) {
  return { cwd: process.cwd(), ui: { notify } } as any;
}

test("ctrl+shift+t shortcut is registered and toggles persistence", async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), "sidebar-shortcut-")), "sidebar-tui.json");
  process.env.PI_SIDEBAR_CONFIG = configPath;

  const { default: piSidebar } = await import("../index.ts");
  const { shortcuts, pi } = fakePi();
  piSidebar(pi);

  const sc = shortcuts.get("ctrl+shift+t");
  assert.ok(sc, 'shortcut "ctrl+shift+t" should be registered');
  assert.ok(sc!.description, "shortcut should have a description");

  // Start from known state: enabled (default)
  writeFileSync(configPath, JSON.stringify({ enabled: true, width: W }));

  const messages: string[] = [];
  const ctx = makeCtx((msg) => messages.push(msg));
  await sc!.handler(ctx);
  assert.equal(messages.at(-1), "Sidebar disabled");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), saved(false));

  await sc!.handler(ctx);
  assert.equal(messages.at(-1), "Sidebar enabled");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), saved(true));
});

test("command handler and shortcut share the same enabled state", async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), "sidebar-shortcut-")), "sidebar-tui.json");
  process.env.PI_SIDEBAR_CONFIG = configPath;
  writeFileSync(configPath, JSON.stringify({ enabled: true, width: W }));

  const { default: piSidebar } = await import("../index.ts");
  const { shortcuts, commands, pi } = fakePi();
  piSidebar(pi);

  const messages: string[] = [];
  const ctx = makeCtx((msg) => messages.push(msg));

  await commands.get("sidebar-tui")!.handler("off", ctx);
  assert.equal(messages.at(-1), "Sidebar disabled");

  // Shortcut should now toggle FROM disabled -> enabled (shared state)
  await shortcuts.get("ctrl+shift+t")!.handler(ctx);
  assert.equal(messages.at(-1), "Sidebar enabled");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), saved(true));
});

test("sidebar scrolling shortcuts do not conflict with built-in pi shortcuts", async () => {
  const { default: piSidebar } = await import("../index.ts");
  const { shortcuts, pi } = fakePi();
  piSidebar(pi);

  // Must NOT register conflicting alt+up or alt+down
  assert.equal(shortcuts.get("alt+up"), undefined, "alt+up conflicts with app.models.reorderUp/dequeue");
  assert.equal(shortcuts.get("alt+down"), undefined, "alt+down conflicts with app.models.reorderDown");

  // Must register non-conflicting scroll shortcuts
  assert.ok(shortcuts.get("alt+shift+up"), "alt+shift+up should be registered");
  assert.ok(shortcuts.get("alt+shift+down"), "alt+shift+down should be registered");
  assert.ok(shortcuts.get("ctrl+alt+up"), "ctrl+alt+up should be registered");
  assert.ok(shortcuts.get("ctrl+alt+down"), "ctrl+alt+down should be registered");
  assert.ok(shortcuts.get("alt+pageup"), "alt+pageup should be registered");
  assert.ok(shortcuts.get("alt+pagedown"), "alt+pagedown should be registered");
});
