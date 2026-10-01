import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SIDEBAR_SETTINGS,
  loadSidebarSettings,
  saveSidebarSettings,
} from "../config.ts";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "sidebar-cfg-")), "sidebar-tui.json");
}

test("loadSidebarSettings returns defaults when file is missing", () => {
  const s = loadSidebarSettings(tmpFile());
  assert.deepEqual(s, DEFAULT_SIDEBAR_SETTINGS);
});

test("saveSidebarSettings then loadSidebarSettings round-trips", () => {
  const p = tmpFile();
  saveSidebarSettings({ enabled: false, width: 64, todosMax: 5, scrollSpeed: 1, momentum: true, subagents: true }, p);
  assert.deepEqual(loadSidebarSettings(p), { enabled: false, width: 64, todosMax: 5, scrollSpeed: 1, momentum: true, subagents: true });
});

test("saveSidebarSettings creates parent directory if missing", () => {
  const p = join(mkdtempSync(join(tmpdir(), "sidebar-cfg-")), "nested", "dir", "sidebar-tui.json");
  saveSidebarSettings({ enabled: true, width: 50, todosMax: 5, scrollSpeed: 1, momentum: true, subagents: true }, p);
  assert.deepEqual(loadSidebarSettings(p), { enabled: true, width: 50, todosMax: 5, scrollSpeed: 1, momentum: true, subagents: true });
});

test("loadSidebarSettings returns defaults for corrupt JSON", () => {
  const p = tmpFile();
  writeFileSync(p, "{not json");
  assert.deepEqual(loadSidebarSettings(p), DEFAULT_SIDEBAR_SETTINGS);
});

test("loadSidebarSettings falls back to defaults for out-of-range width", () => {
  const p = tmpFile();
  writeFileSync(p, JSON.stringify({ enabled: false, width: 999 }));
  const s = loadSidebarSettings(p);
  assert.equal(s.enabled, false);
  assert.equal(s.width, DEFAULT_SIDEBAR_SETTINGS.width);
});

test("loadSidebarSettings falls back to default width for non-integer width", () => {
  const p = tmpFile();
  writeFileSync(p, JSON.stringify({ enabled: true, width: "wide" }));
  const s = loadSidebarSettings(p);
  assert.equal(s.width, DEFAULT_SIDEBAR_SETTINGS.width);
});

test("loadSidebarSettings defaults todosMax to 5 when missing", () => {
  assert.equal(loadSidebarSettings(tmpFile()).todosMax, 5);
});

test("saveSidebarSettings round-trips a non-default todosMax", () => {
  const p = tmpFile();
  saveSidebarSettings({ enabled: true, width: 50, todosMax: 8 }, p);
  assert.equal(loadSidebarSettings(p).todosMax, 8);
});

test("loadSidebarSettings ignores out-of-range todosMax", () => {
  const p = tmpFile();
  writeFileSync(p, JSON.stringify({ todosMax: 999 }));
  assert.equal(loadSidebarSettings(p).todosMax, 5);
});

test("loadSidebarSettings defaults scrollSpeed to 1 when missing", () => {
  assert.equal(loadSidebarSettings(tmpFile()).scrollSpeed, 1);
});

test("saveSidebarSettings round-trips a non-default scrollSpeed", () => {
  const p = tmpFile();
  saveSidebarSettings({ enabled: true, width: 50, todosMax: 5, scrollSpeed: 6 }, p);
  assert.equal(loadSidebarSettings(p).scrollSpeed, 6);
});

test("loadSidebarSettings ignores out-of-range scrollSpeed", () => {
  const p = tmpFile();
  writeFileSync(p, JSON.stringify({ scrollSpeed: 999 }));
  assert.equal(loadSidebarSettings(p).scrollSpeed, 1);
});

test("loadSidebarSettings defaults momentum to true when missing", () => {
  assert.equal(loadSidebarSettings(tmpFile()).momentum, true);
});

test("saveSidebarSettings round-trips a non-default momentum", () => {
  const p = tmpFile();
  saveSidebarSettings({ enabled: true, width: 50, todosMax: 5, scrollSpeed: 1, momentum: false, subagents: true }, p);
  assert.equal(loadSidebarSettings(p).momentum, false);
});

test("loadSidebarSettings defaults subagents to true when missing", () => {
  assert.equal(loadSidebarSettings(tmpFile()).subagents, true);
});

test("saveSidebarSettings round-trips a non-default subagents setting", () => {
  const p = tmpFile();
  saveSidebarSettings({ enabled: true, width: 50, todosMax: 5, scrollSpeed: 1, momentum: true, subagents: false }, p);
  assert.equal(loadSidebarSettings(p).subagents, false);
});
