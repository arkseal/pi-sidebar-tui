import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piSidebar from "../index.ts";
import { SidebarStatsTracker } from "../stats.ts";

function setup(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "sidebar-lifecycle-"));
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldStats = process.env.PI_SIDEBAR_STATS_DIR;
  const oldDepth = process.env.PI_SUBAGENT_DEPTH;
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  process.env.PI_SIDEBAR_STATS_DIR = join(directory, "stats");
  process.env.PI_SUBAGENT_DEPTH = "0";
  let now = 0;
  let wall = 0;
  const restore: Array<() => void> = [];
  t.after(() => {
    for (const undo of restore.reverse()) undo();
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldStats === undefined) delete process.env.PI_SIDEBAR_STATS_DIR; else process.env.PI_SIDEBAR_STATS_DIR = oldStats;
    if (oldDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH; else process.env.PI_SUBAGENT_DEPTH = oldDepth;
    rmSync(directory, { recursive: true, force: true });
  });
  // Plain descriptor replacement also works in Bun, whose node:test mock API
  // is not implemented. Restore prototype-backed methods without shadowing.
  const replace = (object: object, key: string, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, writable: true, value });
    restore.push(() => { if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key); });
  };
  replace(performance, "now", () => now);
  replace(Date, "now", () => wall);
  const intervals: Array<{ callback: () => void; ms: number }> = [];
  replace(globalThis, "setInterval", (callback: () => void, ms: number) => {
    intervals.push({ callback, ms });
    return { unref() {} };
  });
  replace(globalThis, "clearInterval", () => {});
  return {
    directory, intervals,
    advance(ms: number) { now += ms; wall += ms; },
    stats: () => new SidebarStatsTracker({ directory: join(directory, "stats") }).snapshot,
  };
}

function harness(directory: string, branch: any[] = [], hasUI = false) {
  const handlers = new Map<string, ((event: any, ctx: any) => Promise<void>)[]>();
  const bus = new Map<string, (event: any) => void>();
  const writes: string[] = [];
  const terminal = { columns: 120, rows: 50, write: (data: string) => writes.push(data) };
  const tui = { terminal, mode: "fullscreen", doRender() { terminal.write("Main conversation"); }, requestRender() { this.doRender(); } };
  let widget: any;
  const pi = {
    on(type: string, callback: (event: any, ctx: any) => Promise<void>) {
      handlers.set(type, [...(handlers.get(type) ?? []), callback]);
    },
    registerCommand() {}, registerShortcut() {},
    getThinkingLevel: () => "off", getAllTools: () => [],
    events: { on(type: string, callback: (event: any) => void) { bus.set(type, callback); return () => { bus.delete(type); }; } },
  };
  piSidebar(pi as any);
  const ctx = {
    hasUI, mode: hasUI ? "tui" : "json", cwd: directory,
    sessionManager: { getSessionName: () => null, getSessionId: () => "test-session", getBranch: () => branch },
    model: { id: "test", provider: "openai" },
    getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 500_000 }),
    ui: {
      notify() {},
      setWidget(_id: string, factory: (tui: any, theme: any) => any) {
        widget = factory(tui, { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text });
      },
    },
  };
  const emit = async (type: string, event = {}) => {
    for (const callback of handlers.get(type) ?? []) await callback({ type, ...event }, ctx);
  };
  return { emit, bus, writes, tui, close: async () => { await emit("session_shutdown"); widget?.dispose(); } };
}

test("lifecycle: runtime and totals survive closing and reopening into a new session", async t => {
  const s = setup(t);
  const h = harness(s.directory);
  await h.emit("session_start");
  s.advance(86_400_000);
  assert.equal(s.stats().activeRunMs, 0);
  await h.emit("agent_start"); await h.emit("turn_start"); await h.emit("message_start", { message: { role: "assistant" } });
  s.advance(5000);
  await h.emit("message_end", { message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 7, cost: { total: 0.123 } } } });
  await h.emit("turn_end"); await h.emit("agent_end");
  assert.equal(s.stats().activeRunMs, 5000);
  assert.equal(s.stats().lastTurnMs, 5000);
  s.advance(86_400_000);
  await h.close();
  const reopened = harness(s.directory);
  await reopened.emit("session_start");
  assert.equal(s.stats().activeRunMs, 5000);
  assert.equal(s.stats().tokensIn, 100);
  assert.equal(s.stats().cacheWrite, 7);
  assert.equal(s.stats().lastTps, 4);
  await reopened.emit("model_select", { model: { id: "different" } });
  assert.equal(s.stats().lastTps, 4);
  await reopened.emit("agent_start"); s.advance(3000); await reopened.emit("agent_end");
  await reopened.close();
  assert.equal(s.stats().activeRunMs, 8000);
});

test("lifecycle: resuming history seeds once, counts model turns, and never doubles cache writes", async t => {
  const s = setup(t);
  const branch = [
    { type: "message", message: { role: "user", content: "one user prompt" } },
    { type: "message", message: { role: "assistant", usage: { input: 100, cacheWrite: 7 } } },
    { type: "message", message: { role: "assistant", usage: { input: 40, cacheWrite: 2 } } },
  ];
  const h = harness(s.directory, branch);
  await h.emit("session_start"); await h.close();
  const reopened = harness(s.directory, branch);
  await reopened.emit("session_start"); await reopened.close();
  assert.equal(s.stats().tokensIn, 140);
  assert.equal(s.stats().cacheWrite, 9);
  assert.equal(s.stats().turnCount, 2);
  assert.equal(s.stats().activeRunMs, 0);
});

test("lifecycle: nested user prompts pause runtime and cannot restart it after abort", async t => {
  const s = setup(t);
  const h = harness(s.directory);
  await h.emit("session_start"); await h.emit("agent_start");
  s.advance(1000); await h.emit("ui_prompt_start"); await h.emit("ui_prompt_start");
  s.advance(20_000); await h.emit("ui_prompt_end");
  s.advance(20_000); await h.emit("ui_prompt_end");
  s.advance(5000); await h.emit("agent_end");
  s.advance(10_000); await h.emit("ui_prompt_end"); await h.emit("agent_settled");
  await h.close();
  assert.equal(s.stats().activeRunMs, 6000);
});

test("lifecycle: active checkpoints and shutdown flush partial runs", async t => {
  const s = setup(t);
  const h = harness(s.directory);
  await h.emit("session_start"); await h.emit("agent_start");
  s.advance(10_000);
  s.intervals.find(interval => interval.ms === 10_000)!.callback();
  assert.equal(s.stats().activeRunMs, 10_000);
  s.advance(2500); await h.close();
  assert.equal(s.stats().activeRunMs, 12_500);
});

test("lifecycle: subagent usage persists without a terminal UI", async t => {
  const s = setup(t);
  const h = harness(s.directory);
  await h.emit("session_start");
  h.bus.get("subagent:stats")!({ stats: { tokensIn: 300, tokensOut: 30, cacheRead: 20, cacheWrite: 8, cost: 0.05 } });
  await h.emit("message_end", { message: { role: "assistant", stopReason: "aborted", usage: { input: 10, output: 1, cost: { total: 0.01 } } } });
  await h.close();
  assert.equal(s.stats().tokensIn, 310);
  assert.equal(s.stats().tokensOut, 31);
  assert.equal(s.stats().cacheWrite, 8);
  assert.ok(Math.abs(s.stats().sessionCost - 0.06) < 1e-9);
  assert.equal(h.bus.size, 0);
});

test("lifecycle: child-agent processes do not persist usage a second time", async t => {
  const s = setup(t);
  process.env.PI_SUBAGENT_DEPTH = "1";
  const h = harness(s.directory);
  await h.emit("session_start"); await h.emit("agent_start");
  s.advance(3000);
  await h.emit("message_end", { message: { role: "assistant", usage: { input: 1000, output: 100 } } });
  await h.emit("turn_end"); await h.emit("agent_end"); await h.close();
  assert.equal(s.stats().tokensIn, 0);
  assert.equal(s.stats().activeRunMs, 0);
});

test("lifecycle: startup paints sidebar, and shutdown/reload restores terminal width", async t => {
  const s = setup(t);
  for (let i = 0; i < 2; i++) {
    const h = harness(s.directory, [], true);
    await h.emit("session_start");
    h.tui.doRender();
    assert.ok(h.writes.join("").includes("Session"));
    assert.ok(h.writes.join("").includes("All-time"));
    assert.equal(h.tui.terminal.columns, 74);
    await h.close();
    assert.equal(h.tui.terminal.columns, 120);
  }
});
