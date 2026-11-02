import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SidebarStatsTracker, emptySidebarStats, sidebarStatsDir } from "../stats.ts";

function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "sidebar-stats-test-"));
  const directory = join(root, "stats");
  let now = 0;
  const tracker = new SidebarStatsTracker({ directory, now: () => now });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory, tracker, advance: (ms: number) => { now += ms; }, setNow: (value: number) => { now = value; } };
}

test("stats: only active runs accumulate time, including a start at zero", t => {
  const { tracker, advance } = setup(t);
  advance(60_000);
  assert.equal(tracker.snapshot.activeRunMs, 0);
  tracker.startRun();
  advance(5000);
  assert.equal(tracker.snapshot.activeRunMs, 5000);
  tracker.stopRun();
  advance(86_400_000);
  assert.equal(tracker.snapshot.activeRunMs, 5000);
  tracker.startRun();
  advance(2000);
  tracker.stopRun();
  assert.equal(tracker.snapshot.activeRunMs, 7000);
});

test("stats: duplicate start/stop and checkpoints never double count", t => {
  const { tracker, advance } = setup(t);
  tracker.startRun();
  advance(1000);
  tracker.startRun();
  assert.equal(tracker.snapshot.activeRunMs, 1000);
  assert.equal(tracker.save(), true);
  assert.equal(tracker.save(), true);
  advance(2000);
  tracker.stopRun();
  tracker.stopRun();
  assert.equal(tracker.snapshot.activeRunMs, 3000);
});

test("stats: active checkpoint resumes from saved duration, never offline timestamp", t => {
  const { tracker, advance, directory } = setup(t);
  tracker.startRun();
  advance(12_345);
  tracker.save();
  const restarted = new SidebarStatsTracker({ directory, now: () => 1_000_000_000 });
  assert.equal(restarted.snapshot.activeRunMs, 12_345);
  assert.equal(restarted.hasStoredStats, true);
  const raw = readFileSync(join(directory, readdirSync(directory)[0]), "utf8");
  assert.ok(!raw.includes("startedAt"));
});

test("stats: usage, cache writes, turns, speed and last duration survive restarts", t => {
  const { tracker, directory } = setup(t);
  tracker.addUsage({ input: 100, output: 20, cacheRead: 40, cacheWrite: 7, cost: { total: 0.123 } });
  tracker.incrementTurns();
  tracker.setLastTps(80);
  tracker.setLastTurnMs(9000);
  tracker.save();
  const restarted = new SidebarStatsTracker({ directory });
  assert.deepEqual(restarted.snapshot, { ...emptySidebarStats(), tokensIn: 100, tokensOut: 20, cacheRead: 40, cacheWrite: 7, sessionCost: 0.123, turnCount: 1, lastTps: 80, lastTurnMs: 9000 });
  restarted.save();
  assert.deepEqual(new SidebarStatsTracker({ directory }).snapshot, restarted.snapshot);
});

test("stats: parallel writers keep independent contributions instead of overwriting totals", t => {
  const { tracker: a, directory } = setup(t);
  const b = new SidebarStatsTracker({ directory });
  a.addUsage({ input: 10, cacheWrite: 3 });
  b.addUsage({ input: 20, cacheWrite: 4 });
  a.save(); b.save();
  a.addUsage({ input: 5 });
  a.save();
  const total = new SidebarStatsTracker({ directory }).snapshot;
  assert.equal(total.tokensIn, 35);
  assert.equal(total.cacheWrite, 7);
  assert.equal(readdirSync(directory).filter(file => file.endsWith(".json")).length, 2);
});

test("stats: a new writer never saves loaded totals again", t => {
  const { tracker, directory } = setup(t);
  tracker.addUsage({ input: 50 }); tracker.save();
  const b = new SidebarStatsTracker({ directory });
  b.addUsage({ input: 10 }); b.save();
  const c = new SidebarStatsTracker({ directory });
  c.save();
  assert.equal(new SidebarStatsTracker({ directory }).snapshot.tokensIn, 60);
});

test("stats: empty writers and checkpoints do not erase last-run metrics", t => {
  const { tracker, directory } = setup(t);
  tracker.setLastTps(99); tracker.setLastTurnMs(1200); tracker.save();
  const idle = new SidebarStatsTracker({ directory }); idle.save();
  const active = new SidebarStatsTracker({ directory });
  active.incrementTurns(); active.save();
  assert.equal(new SidebarStatsTracker({ directory }).snapshot.lastTps, 99);
  assert.equal(new SidebarStatsTracker({ directory }).snapshot.lastTurnMs, 1200);
  active.setLastTps(111); active.save();
  assert.equal(new SidebarStatsTracker({ directory }).snapshot.lastTps, 111);
});

test("stats: history bootstrap is once only, including after restart", t => {
  const { tracker, directory } = setup(t);
  const seed = { ...emptySidebarStats(), tokensIn: 100, cacheWrite: 5, turnCount: 2 };
  tracker.seed(seed); tracker.seed(seed); tracker.save();
  const restarted = new SidebarStatsTracker({ directory });
  restarted.seed(seed); restarted.save();
  assert.equal(new SidebarStatsTracker({ directory }).snapshot.tokensIn, 100);
  assert.equal(restarted.snapshot.cacheWrite, 5);
});

test("stats: malformed fragments and abandoned temp files do not hide valid totals", t => {
  const { tracker, directory } = setup(t);
  tracker.addUsage({ input: 42 }); tracker.save();
  writeFileSync(join(directory, "broken.json"), "{not json");
  writeFileSync(join(directory, "wrong-version.json"), JSON.stringify({ version: 9, stats: { ...emptySidebarStats(), tokensIn: 999 } }));
  writeFileSync(join(directory, "invalid.json"), JSON.stringify({ version: 1, stats: { ...emptySidebarStats(), tokensIn: -10 } }));
  writeFileSync(join(directory, "interrupted.json.tmp"), "{partial");
  const restored = new SidebarStatsTracker({ directory });
  assert.equal(restored.snapshot.tokensIn, 42);
  assert.equal(restored.hasStoredStats, true);
});

test("stats: write failures retain unsaved usage and runtime for retry", t => {
  const { tracker, directory, advance } = setup(t);
  writeFileSync(directory, "not a directory");
  tracker.addUsage({ input: 17 }); tracker.startRun(); advance(1000);
  assert.equal(tracker.save(), false);
  rmSync(directory);
  advance(2000);
  tracker.stopRun();
  assert.equal(tracker.save(), true);
  const restored = new SidebarStatsTracker({ directory });
  assert.equal(restored.snapshot.tokensIn, 17);
  assert.equal(restored.snapshot.activeRunMs, 3000);
});

test("stats: invalid numeric usage is ignored, snapshots cannot mutate stored state", t => {
  const { tracker } = setup(t);
  tracker.addUsage({ input: NaN, output: -1, cacheRead: Infinity, cacheWrite: 2, cost: { total: -5 } });
  tracker.setLastTps(NaN); tracker.setLastTurnMs(-1);
  const snapshot = tracker.snapshot;
  assert.deepEqual(snapshot, { ...emptySidebarStats(), cacheWrite: 2 });
  snapshot.cacheWrite = 999;
  assert.equal(tracker.snapshot.cacheWrite, 2);
});

test("stats: a backward clock never subtracts accumulated runtime", t => {
  const { tracker, setNow } = setup(t);
  setNow(100); tracker.startRun();
  setNow(1100); tracker.save();
  setNow(1000); tracker.stopRun();
  assert.equal(tracker.snapshot.activeRunMs, 1000);
});

test("stats: constructor does not create files or directories", t => {
  const { directory } = setup(t);
  assert.throws(() => readdirSync(directory), /ENOENT/);
  mkdirSync(directory);
  assert.equal(readdirSync(directory).length, 0);
});

test("stats: storage honors the agent directory and explicit override", t => {
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousStats = process.env.PI_SIDEBAR_STATS_DIR;
  t.after(() => {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousStats === undefined) delete process.env.PI_SIDEBAR_STATS_DIR; else process.env.PI_SIDEBAR_STATS_DIR = previousStats;
  });
  delete process.env.PI_SIDEBAR_STATS_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/custom-agent";
  assert.equal(sidebarStatsDir(), "/tmp/custom-agent/sidebar-stats");
  process.env.PI_SIDEBAR_STATS_DIR = "/tmp/custom-stats";
  assert.equal(sidebarStatsDir(), "/tmp/custom-stats");
});
