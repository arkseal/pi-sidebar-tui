import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SidebarStats {
  activeRunMs: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  sessionCost: number;
  turnCount: number;
  lastTps: number | null;
  lastTurnMs: number | null;
}

const COUNTERS = ["activeRunMs", "tokensIn", "tokensOut", "cacheRead", "cacheWrite", "sessionCost", "turnCount"] as const;
const validNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const add = (a: number, b: number): number => Math.min(Number.MAX_SAFE_INTEGER, a + b);

export function emptySidebarStats(): SidebarStats {
  return { activeRunMs: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, sessionCost: 0, turnCount: 0, lastTps: null, lastTurnMs: null };
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function sidebarStatsDir(): string {
  if (process.env.PI_SIDEBAR_STATS_DIR) return expandHome(process.env.PI_SIDEBAR_STATS_DIR);
  const root = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(expandHome(root), "sidebar-stats");
}

/**
 * Each extension runtime saves only its own contribution. Atomic per-writer
 * snapshots avoid lost updates when several Pi processes are open at once.
 * Open timer timestamps are never stored, so downtime cannot become runtime.
 */
export class SidebarStatsTracker {
  private readonly directory: string;
  private readonly fileName = `${randomUUID()}.json`;
  private readonly now: () => number;
  private readonly base = emptySidebarStats();
  private readonly own = emptySidebarStats();
  private startedAt: number | null = null;
  private dirty = true;
  private stored = false;
  private seeded = false;
  private lastTpsAt = 0;
  private lastTurnAt = 0;
  private latestMetricAt = 0;

  constructor(options: { directory?: string; now?: () => number } = {}) {
    this.directory = options.directory ?? sidebarStatsDir();
    this.now = options.now ?? (() => performance.now());
    let files: string[];
    try { files = readdirSync(this.directory).filter(f => f.endsWith(".json")).sort(); }
    catch { return; }
    let tpsAt = -1;
    let turnAt = -1;
    for (const file of files) {
      try {
        const entry = JSON.parse(readFileSync(join(this.directory, file), "utf8"));
        const stats = entry?.stats;
        if (entry?.version !== 1 || !stats || typeof stats !== "object" ||
            !COUNTERS.every(key => validNumber(stats[key]))) continue;
        this.stored = true;
        for (const key of COUNTERS) this.base[key] = add(this.base[key], stats[key]);
        if (validNumber(stats.lastTps) && validNumber(entry.lastTpsAt) && entry.lastTpsAt >= tpsAt) {
          this.base.lastTps = stats.lastTps;
          tpsAt = entry.lastTpsAt;
        }
        if (validNumber(stats.lastTurnMs) && validNumber(entry.lastTurnAt) && entry.lastTurnAt >= turnAt) {
          this.base.lastTurnMs = stats.lastTurnMs;
          turnAt = entry.lastTurnAt;
        }
      } catch { /* One damaged/unreadable fragment must not hide other totals. */ }
    }
    this.latestMetricAt = Math.max(0, tpsAt, turnAt);
  }

  get hasStoredStats(): boolean { return this.stored; }

  get snapshot(): SidebarStats {
    const result = emptySidebarStats();
    for (const key of COUNTERS) result[key] = add(this.base[key], this.own[key]);
    if (this.startedAt !== null) result.activeRunMs = add(result.activeRunMs, this.delta());
    result.lastTps = this.own.lastTps ?? this.base.lastTps;
    result.lastTurnMs = this.own.lastTurnMs ?? this.base.lastTurnMs;
    return result;
  }

  addUsage(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }): void {
    const pairs = [
      ["tokensIn", usage.input], ["tokensOut", usage.output],
      ["cacheRead", usage.cacheRead], ["cacheWrite", usage.cacheWrite],
      ["sessionCost", usage.cost?.total],
    ] as const;
    for (const [key, value] of pairs) {
      if (validNumber(value) && value > 0) {
        this.own[key] = add(this.own[key], value);
        this.dirty = true;
      }
    }
  }

  incrementTurns(): void {
    this.own.turnCount = add(this.own.turnCount, 1);
    this.dirty = true;
  }

  setLastTps(value: number): void {
    if (!validNumber(value)) return;
    this.own.lastTps = value;
    this.lastTpsAt = this.metricTime();
    this.dirty = true;
  }

  setLastTurnMs(value: number): void {
    if (!validNumber(value)) return;
    this.own.lastTurnMs = value;
    this.lastTurnAt = this.metricTime();
    this.dirty = true;
  }

  seed(stats: SidebarStats): void {
    if (this.stored || this.seeded) return;
    this.seeded = true;
    for (const key of COUNTERS) {
      if (validNumber(stats[key])) this.own[key] = add(this.own[key], stats[key]);
    }
    if (stats.lastTps !== null) this.setLastTps(stats.lastTps);
    if (stats.lastTurnMs !== null) this.setLastTurnMs(stats.lastTurnMs);
    this.dirty = true;
  }

  startRun(): void {
    if (this.startedAt === null) this.startedAt = this.now();
  }

  stopRun(): void {
    this.checkpoint();
    this.startedAt = null;
  }

  save(): boolean {
    this.checkpoint();
    if (!this.dirty) return true;
    const target = join(this.directory, this.fileName);
    const temporary = `${target}.tmp`;
    try {
      mkdirSync(this.directory, { recursive: true });
      writeFileSync(temporary, JSON.stringify({
        version: 1, stats: this.own,
        lastTpsAt: this.lastTpsAt, lastTurnAt: this.lastTurnAt,
      }) + "\n", { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, target);
      this.dirty = false;
      this.stored = true;
      return true;
    } catch {
      try { unlinkSync(temporary); } catch { /* Best-effort temporary cleanup. */ }
      return false;
    }
  }

  private metricTime(): number {
    this.latestMetricAt = Math.max(Date.now(), this.latestMetricAt + 1);
    return this.latestMetricAt;
  }

  private delta(): number {
    const delta = this.now() - this.startedAt!;
    return validNumber(delta) ? delta : 0;
  }

  private checkpoint(): void {
    if (this.startedAt === null) return;
    const now = this.now();
    const delta = now - this.startedAt;
    if (validNumber(delta) && delta > 0) {
      this.own.activeRunMs = add(this.own.activeRunMs, delta);
      this.dirty = true;
    }
    this.startedAt = now;
  }
}
