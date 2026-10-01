import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSidebarSettings, saveSidebarSettings, MIN_TODOS_MAX, MAX_TODOS_MAX, MIN_SCROLL_SPEED, MAX_SCROLL_SPEED } from "./config.ts";
import type { TodoItem, SidebarContext, CtxSample } from "./types.ts";
import { parseTodos, reconstructTodosFromBranch } from "./parse-todos.ts";
import { renderSidebar } from "./sidebar.ts";
import { getWorkspaceData, invalidateWorkspaceCache } from "./workspace.ts";
import { SidebarCompositor } from "./compositor.ts";
import { getMcpServers, invalidateMcpCache } from "./mcp.ts";
import { loadCavemanConfig, resolveCavemanLevel, cavemanInterval, type CavemanConfig } from "./caveman.ts";
import { setPiTheme } from "./colors.ts";
import { setSidebarRenderCallback } from "./panels/registry.ts";
import { ScrollMomentum } from "./momentum.ts";

const TODO_TOOL_PATTERN = /todo/i;
const WRITE_TOOLS = new Set(["write", "edit", "bash", "computer"]);

const initialSettings = loadSidebarSettings();
let sidebarEnabled = initialSettings.enabled;
let sidebarWidth = initialSettings.width;
let todosMax = initialSettings.todosMax;
let scrollSpeed = initialSettings.scrollSpeed ?? 1;
let momentumEnabled = initialSettings.momentum ?? true;
let subagentsEnabled = initialSettings.subagents ?? true;
let currentPi: ExtensionAPI | null = null;
let sessionManager: any = null;
let sessionTitle: string | null = null;
let todos: TodoItem[] = [];
let currentModel: string | null = null;
let thinkingLevel: string | null = null;
let contextTokens: number | null = null;
let contextPercent: number | null = null;
let contextWindow: number | null = null;
let tokensIn = 0;
let tokensOut = 0;
let cacheRead = 0;
let cacheWrite = 0;
let sessionCost = 0;
let turnCount = 0;
let activeTool: { name: string; startedAt: number } | null = null;
let autoCompactEnabled: boolean | null = null;
let sessionStartMs = Date.now();
let modelProvider: string | null = null;
let agentStartMs: number | null = null;
let msgStartMs: number | null = null;
let liveTps: number | null = null;
let lastTps: number | null = null;
let lastTurnMs: number | null = null;
let ctxSamples: CtxSample[] = [];
let tpsSamples: { t: number; tokens: number }[] = [];
const CTX_SAMPLE_MAX = 10;
const TPS_WINDOW_MS = 2000;
let sessionTimerHandle: ReturnType<typeof setInterval> | null = null;
let unsubscribeMcpStatus: (() => void) | null = null;
let unsubscribeSubagentStats: (() => void) | null = null;
let cavemanLevel: string | null = null;
let cavemanFrame = 0;
let cavemanTimer: ReturnType<typeof setInterval> | null = null;
let cavemanCfg: CavemanConfig = { defaultLevel: "full", showStatus: true, present: false };
let agentActive = false;
let activityFrame = 0;
let activityTimer: ReturnType<typeof setInterval> | null = null;

function inferThinkingLevel(sm: any): string | null {
  try {
    const entries: any[] = sm.getBranch?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type === "thinking_level_change" && typeof e.thinkingLevel === "string") {
        return e.thinkingLevel;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

const FILLER_PREFIX = /^(can you |could you |please |i want you to |i'd like you to |i need you to |help me |i need to |let's |let us )+/i;
const METHOD_WRAPPER = /^(use|create|run|make|build|write|add|generate|implement|spawn|start)\s+(?:(?:a|an|the|some|my|one)\s+)?(?:\w+\s+){0,3}(?:to|that|which|for)\s+/i;

function summarizePrompt(raw: string): string {
  const firstLine = raw.split("\n").map(l => l.trim()).find(l => l.length > 0) ?? raw.trim();
  const noFiller = firstLine.replace(FILLER_PREFIX, "").trim();
  const noWrapper = noFiller.replace(METHOD_WRAPPER, "").trim();
  const title = noWrapper.charAt(0).toUpperCase() + noWrapper.slice(1);
  return title.slice(0, 60);
}

async function generateTitleWithModel(prompt: string, ctx: any, onTitle: (t: string) => void): Promise<void> {
  try {
    const registry = ctx.modelRegistry;
    if (!registry?.streamSimple) return;
    const modelDesc = ctx.model;
    if (!modelDesc) return;
    const fullModel = (registry.getAll() as any[]).find((m: any) => m.id === modelDesc.id);
    if (!fullModel) return;
    const context = {
      messages: [{
        role: "user" as const,
        content: `Write a 5-7 word task title for this request. Start with an action verb. No punctuation. Output only the title.\n\n${prompt.slice(0, 500)}`,
      }],
    };
    const stream = registry.streamSimple(fullModel, context, { maxTokens: 20, reasoning: "off" });
    const message = await (stream as any).result();
    const text = (message.content as any[]).find((c: any) => c.type === "text")?.text?.trim() ?? "";
    if (text.length > 0 && text.length <= 80) onTitle(text.slice(0, 60));
  } catch {
    // fallback already set
  }
}

function inferSessionTitle(sm: any): string | null {
  try {
    const entries: any[] = sm.getBranch?.() ?? [];
    for (const e of entries) {
      if (e?.type !== "message") continue;
      const msg = e.message;
      if (msg?.role !== "user") continue;
      const content = msg.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.find((c: any) => c?.type === "text")?.text ?? ""
          : "";
      if (text.trim()) return summarizePrompt(text);
    }
  } catch {
    // ignore
  }
  return null;
}

function refreshCavemanLevel(): void {
  const branch = sessionManager?.getBranch?.() ?? [];
  cavemanLevel = resolveCavemanLevel(branch, cavemanCfg);
}

function buildSidebarContext(cwd: string | undefined): SidebarContext {
  const ws = getWorkspaceData(cwd);
  return {
    sessionTitle,
    sessionId: sessionManager?.getSessionId?.() ?? null,
    todos,
    todosMax,
    branch: ws.branch,
    aheadCount: ws.aheadCount,
    untrackedCount: ws.untrackedCount,
    workspaceFiles: ws.files,
    cwd,
    model: currentModel,
    thinkingLevel,
    contextTokens,
    contextPercent,
    contextWindow,
    tokensIn,
    tokensOut,
    cacheRead,
    cacheWrite,
    sessionCost,
    turnCount,
    activeTool,
    autoCompactEnabled,
    sessionStartMs,
    mcpServers: getMcpServers(currentPi?.getAllTools?.()),
    modelProvider,
    cavemanLevel,
    cavemanFrame,
    agentActive,
    spinnerFrame: activityFrame,
    liveTps,
    lastTps,
    lastTurnMs,
    ctxSamples,
    showSubagents: subagentsEnabled,
  };
}

function recordCtxSample(tokens: number): void {
  const last = ctxSamples[ctxSamples.length - 1];
  if (last && last.turns === turnCount) {
    last.tokens = tokens; // dedupe: one sample per turn
  } else {
    ctxSamples.push({ tokens, turns: turnCount });
    if (ctxSamples.length > CTX_SAMPLE_MAX) ctxSamples.shift();
  }
}

function updateContextUsage(ctx: any): void {
  try {
    const usage = ctx.getContextUsage?.();
    if (usage) {
      contextTokens = typeof usage.tokens === "number" ? usage.tokens : null;
      contextPercent = typeof usage.percent === "number" ? usage.percent : null;
      contextWindow = typeof usage.contextWindow === "number" ? usage.contextWindow : null;
      if (contextTokens !== null) recordCtxSample(contextTokens);
    }
    const model = ctx.model;
    if (model?.name) currentModel = model.name;
    else if (model?.id) currentModel = model.id;
    modelProvider = (model as any)?.provider ?? (model as any)?.backend ?? null;
  } catch {
    // ignore
  }
}

export function applyScrollSpeed(tui: any, speed: number): void {
  if (tui && typeof speed === "number" && speed >= 1) {
    try {
      tui.wheelScrollLines = speed;
    } catch {
      // ignore
    }
  }
}

export function ensureFullscreenTuiMode(ctx: any): boolean {
  try {
    const sm = ctx?.settingsManager;
    if (sm && typeof sm.getTuiMode === "function" && sm.getTuiMode() !== "fullscreen") {
      sm.setTuiMode("fullscreen");
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export default function piSidebar(pi: ExtensionAPI) {
  currentPi = pi;
  let currentCwd: string | undefined = process.cwd();
  let requestRender: (() => void) | null = null;
  let tuiRef: any = null;
  let compositorRef: SidebarCompositor | null = null;
  let momentumRef: ScrollMomentum | null = null;

  const stopCavemanAnim = () => {
    if (cavemanTimer) { clearInterval(cavemanTimer); cavemanTimer = null; }
    cavemanFrame = 0;
  };
  const startCavemanAnim = () => {
    stopCavemanAnim();
    if (cavemanLevel && cavemanLevel !== "off") {
      cavemanTimer = setInterval(() => {
        cavemanFrame++;
        requestRender?.();
      }, cavemanInterval(cavemanLevel));
      cavemanTimer.unref?.();
    }
  };
  const stopActivityAnim = () => {
    if (activityTimer) { clearInterval(activityTimer); activityTimer = null; }
    activityFrame = 0;
  };
  const startActivityAnim = () => {
    stopActivityAnim();
    activityTimer = setInterval(() => {
      activityFrame++;
      requestRender?.();
    }, 90);
    activityTimer.unref?.();
  };

  const setSidebarEnabled = (enabled: boolean, ctx: any) => {
    sidebarEnabled = enabled;
    saveSidebarSettings({ enabled: sidebarEnabled, width: sidebarWidth, todosMax, scrollSpeed, momentum: momentumEnabled, subagents: subagentsEnabled });

    if (!sidebarEnabled) {
      compositorRef?.dispose();
      compositorRef = null;
      momentumRef?.dispose();
      momentumRef = null;
    } else if (tuiRef && !compositorRef) {
      const comp = new SidebarCompositor(tuiRef, () => buildSidebarContext(currentCwd), sidebarWidth);
      comp.install();
      compositorRef = comp;
      applyScrollSpeed(tuiRef, scrollSpeed);
      if (!momentumRef) {
        const m = new ScrollMomentum(tuiRef, { enabled: momentumEnabled, baseSpeed: scrollSpeed }, () => compositorRef);
        m.install();
        momentumRef = m;
      } else {
        momentumRef.setCompositor(() => compositorRef);
      }
      requestRender?.();
    }

    if (sidebarEnabled) {
      const changed = ensureFullscreenTuiMode(ctx);
      if (changed && (ctx as any).mode === "tui") {
        (ctx as any).ui?.notify?.(
          "Sidebar persistent scrolling requires fullscreen TUI mode. Setting saved to fullscreen; restart session to activate.",
          "info"
        );
      }
    }

    (ctx as any).ui?.notify?.(
      `Sidebar ${sidebarEnabled ? "enabled" : "disabled"}`,
      "info"
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    sessionManager = ctx.sessionManager;
    sessionTitle = ctx.sessionManager.getSessionName() ?? inferSessionTitle(ctx.sessionManager) ?? null;
    // Seed todos from session history so the panel is correct on resume/branch
    // (pi-todo stores a full snapshot in each `todo` tool result's details).
    todos = reconstructTodosFromBranch(sessionManager?.getBranch?.() ?? []);
    currentModel = null;
    thinkingLevel = null;
    contextTokens = null;
    contextPercent = null;
    contextWindow = null;
    ctxSamples = [];
    sessionStartMs = Date.now();
    cavemanCfg = loadCavemanConfig();
    refreshCavemanLevel();
    stopCavemanAnim();
    if (sessionTimerHandle) { clearInterval(sessionTimerHandle); sessionTimerHandle = null; }
    if ((ctx as any).hasUI) {
      sessionTimerHandle = setInterval(() => requestRender?.(), 30_000);
      sessionTimerHandle.unref?.();
    }
    activeTool = null;
    turnCount = 0;
    autoCompactEnabled = (ctx as any).settingsManager?.getCompactionSettings?.()?.enabled ?? null;
    // Seed usage totals from existing session entries (handles resume)
    { let inSum = 0, outSum = 0, cacheSum = 0, costSum = 0, turns = 0;
      for (const e of (ctx.sessionManager.getBranch?.() ?? [])) {
        const m = (e as any).message;
        if ((e as any).type !== "message") continue;
        if (m?.role === "user") { turns++; continue; }
        if (m?.role !== "assistant") continue;
        if (m?.stopReason === "error" || m?.stopReason === "aborted") continue;
        inSum += m.usage?.input ?? 0;
        outSum += m.usage?.output ?? 0;
        cacheSum += m.usage?.cacheRead ?? 0;
        cacheWrite += m.usage?.cacheWrite ?? 0;
        costSum += m.usage?.cost?.total ?? 0;
      }
      tokensIn = inSum; tokensOut = outSum; cacheRead = cacheSum; sessionCost = costSum;
      turnCount = turns;
    }
    invalidateWorkspaceCache();
    currentCwd = (ctx as any).cwd;
    updateContextUsage(ctx);
    // Prefer live API; fall back to last thinking_level_change entry in history
    // Session history is authoritative for resumed sessions; fall back to live API
    thinkingLevel = inferThinkingLevel(ctx.sessionManager) ?? pi.getThinkingLevel?.() ?? null;

    const hasUI = (ctx as any).hasUI;
    if (!hasUI) return;

    const ui = (ctx as any).ui;
    let renderTick = 0;

    const scheduleRender = () => {
      const tick = ++renderTick;
      setTimeout(() => {
        if (tick === renderTick) {
          if (compositorRef) {
            compositorRef.paint();
          } else {
            tuiRef?.requestRender();
          }
        }
      }, 16);
    };
    const myRender = scheduleRender;
    requestRender = myRender;
    setSidebarRenderCallback(myRender);

    // Keep MCP status live: the MCP adapter publishes a runtime snapshot on the
    // shared event bus whenever server state changes (enable/disable, connect,
    // fail, auth). Invalidate the file cache and repaint so the panel updates
    // directly instead of waiting for the next session.
    if (pi.events) {
      if (unsubscribeMcpStatus) { unsubscribeMcpStatus(); unsubscribeMcpStatus = null; }
      unsubscribeMcpStatus = pi.events.on("pi-mcp-adapter/status/v1", () => {
        invalidateMcpCache();
        requestRender?.();
      });

      if (unsubscribeSubagentStats) { unsubscribeSubagentStats(); unsubscribeSubagentStats = null; }
      unsubscribeSubagentStats = pi.events.on("subagent:stats", (data: any) => {
        const st = data?.stats;
        if (st) {
          tokensIn += st.tokensIn ?? 0;
          tokensOut += st.tokensOut ?? 0;
          cacheRead += st.cacheRead ?? 0;
          cacheWrite += st.cacheWrite ?? 0;
          sessionCost += st.cost ?? 0;
          requestRender?.();
        }
      });
    }

    ui.setWidget("pi-sidebar", (tui: any, _theme: any) => {
      setPiTheme(_theme);
      tuiRef = tui;

      if (compositorRef) {
        compositorRef.dispose();
        compositorRef = null;
      }
      if (momentumRef) {
        momentumRef.dispose();
        momentumRef = null;
      }

      if (sidebarEnabled) {
        applyScrollSpeed(tui, scrollSpeed);
        const m = new ScrollMomentum(tui, { enabled: momentumEnabled, baseSpeed: scrollSpeed }, () => compositorRef);
        m.install();
        momentumRef = m;

        const comp = new SidebarCompositor(
          tui,
          () => buildSidebarContext(currentCwd),
          sidebarWidth,
        );
        comp.install();
        compositorRef = comp;

        if (tui?.mode === "regular") {
          const changed = ensureFullscreenTuiMode(ctx);
          if (changed) {
            (ctx as any).ui?.notify?.(
              "Sidebar persistent scrolling requires fullscreen TUI mode. Setting saved to fullscreen; restart session to activate.",
              "info"
            );
          }
        }
      }

      return {
        dispose() {
          if (requestRender === myRender) {
            requestRender = null;
            setSidebarRenderCallback(null);
          }
          compositorRef?.dispose();
          compositorRef = null;
          momentumRef?.dispose();
          momentumRef = null;
          tuiRef = null;
        },
        invalidate() {},
        render(_width: number): string[] { return []; },
      };
    }, { placement: "belowEditor" });
  });

  pi.on("session_info_changed", async (event, _ctx) => {
    const name = (event as any).name;
    sessionTitle = typeof name === "string" ? name : null;
    requestRender?.();
  });

  pi.on("session_shutdown", async () => {
    setSidebarRenderCallback(null);
    momentumRef?.dispose();
    momentumRef = null;
    if (sessionTimerHandle) { clearInterval(sessionTimerHandle); sessionTimerHandle = null; }
    if (unsubscribeMcpStatus) { unsubscribeMcpStatus(); unsubscribeMcpStatus = null; }
    if (unsubscribeSubagentStats) { unsubscribeSubagentStats(); unsubscribeSubagentStats = null; }
    stopCavemanAnim();
    stopActivityAnim();
    agentActive = false;
    cavemanLevel = null;
    tokensIn = 0;
    tokensOut = 0;
    cacheRead = 0;
    cacheWrite = 0;
    sessionCost = 0;
    turnCount = 0;
    activeTool = null;
    agentStartMs = null;
    msgStartMs = null;
    liveTps = null;
    lastTps = null;
    lastTurnMs = null;
    ctxSamples = [];
    tpsSamples = [];
    sessionTitle = null;
    todos = [];
  });

  pi.on("before_agent_start", async (event, ctx) => {
    currentCwd = (ctx as any).cwd;
    if (sessionTitle === null && typeof (event as any).prompt === "string") {
      const raw = (event as any).prompt as string;
      sessionTitle = summarizePrompt(raw);
      generateTitleWithModel(raw, ctx, (title) => {
        sessionTitle = title;
        requestRender?.();
      });
    }
    updateContextUsage(ctx);
    requestRender?.();
  });

  pi.on("tool_call", async (event, ctx) => {
    currentCwd = (ctx as any).cwd;
    const toolName = (event as any).toolName ?? "";
    const input = (event as any).input;

    if (TODO_TOOL_PATTERN.test(toolName)) {
      const parsed = parseTodos(input);
      if (parsed !== null) {
        todos = parsed;
        requestRender?.();
      }
    }
  });

  pi.on("tool_result", async (event) => {
    const toolName = (event as any).toolName ?? "";

    if (WRITE_TOOLS.has(toolName.toLowerCase())) {
      invalidateWorkspaceCache();
    }

    // Todo tools (pi-todo, built-in) keep the list in the tool RESULT
    // details, not the input. The `tool_call` handler above only sees the
    // action ({ action, text, id }), so read the authoritative list here.
    if (TODO_TOOL_PATTERN.test(toolName)) {
      const parsed = parseTodos((event as any).details);
      if (parsed !== null) {
        todos = parsed;
        requestRender?.();
      }
    }

  });

  pi.on("message_start", async (event) => {
    if ((event as any).message?.role === "assistant") {
      msgStartMs = Date.now();
      liveTps = null;
      tpsSamples = [];
    }
  });

  pi.on("message_update", async (event) => {
    if ((event as any).message?.role !== "assistant") return;
    if (msgStartMs === null) msgStartMs = Date.now();
    const now = Date.now();
    // prefer usage.output; fall back to char count / 4
    const usageOut = (event as any).message?.usage?.output ?? 0;
    const textLen = ((event as any).message?.content as any[] | undefined)
      ?.filter((c: any) => c.type === "text")
      .reduce((s: number, c: any) => s + (c.text?.length ?? 0), 0) ?? 0;
    const tokens = usageOut > 0 ? usageOut : Math.round(textLen / 4);
    if (tokens > 0) {
      tpsSamples.push({ t: now, tokens });
      // drop samples outside the window
      while (tpsSamples.length > 1 && now - tpsSamples[0].t > TPS_WINDOW_MS) {
        tpsSamples.shift();
      }
      if (tpsSamples.length >= 2) {
        const oldest = tpsSamples[0];
        const dt = now - oldest.t;
        const dk = tokens - oldest.tokens;
        if (dt > 0 && dk > 0) {
          liveTps = Math.round(dk / (dt / 1000));
          requestRender?.();
        }
      }
    }
  });

  pi.on("message_end", async (event, ctx) => {
    currentCwd = (ctx as any).cwd;
    const usage = (event as any).message?.usage;
    if (usage && (event as any).message?.role === "assistant") {
      const stopReason = (event as any).message?.stopReason;
      if (stopReason !== "error" && stopReason !== "aborted") {
        tokensIn += usage.input ?? 0;
        tokensOut += usage.output ?? 0;
        cacheRead += usage.cacheRead ?? 0;
        cacheWrite += usage.cacheWrite ?? 0;
        sessionCost += usage.cost?.total ?? 0;
        const out = usage.output ?? 0;
        const elapsed = msgStartMs !== null ? Date.now() - msgStartMs : null;
        if (elapsed !== null && elapsed > 50 && out > 0) {
          lastTps = Math.round(out / (elapsed / 1000));
        }
        liveTps = null;
        msgStartMs = null;
      }
    }
    requestRender?.();
  });

  pi.on("turn_end", async (_event, ctx) => {
    currentCwd = (ctx as any).cwd;
    updateContextUsage(ctx);
    invalidateWorkspaceCache();
    refreshCavemanLevel();
    turnCount++;
    activeTool = null;
    if (agentStartMs !== null) {
      lastTurnMs = Date.now() - agentStartMs;
      agentStartMs = null;
    }
    requestRender?.();
  });

  pi.on("agent_end", async (_event, ctx) => {
    currentCwd = (ctx as any).cwd;
    updateContextUsage(ctx);
    invalidateWorkspaceCache();
    stopCavemanAnim();
    agentActive = false;
    stopActivityAnim();
    requestRender?.();
  });

  pi.on("model_select", async (event, ctx) => {
    const m = (event as any).model;
    if (m?.name) currentModel = m.name;
    else if (m?.id) currentModel = m.id;
    msgStartMs = null;
    liveTps = null;
    lastTps = null;
    lastTurnMs = null;
    tpsSamples = [];
    updateContextUsage(ctx);
    requestRender?.();
  });

  pi.on("agent_start", async (_event, ctx) => {
    currentCwd = (ctx as any).cwd;
    agentStartMs = Date.now();
    msgStartMs = null;
    updateContextUsage(ctx);
    refreshCavemanLevel();
    startCavemanAnim();
    agentActive = true;
    startActivityAnim();
    requestRender?.();
  });

  pi.on("tool_execution_start", async (event) => {
    const name = (event as any).toolName ?? "";
    activeTool = { name, startedAt: Date.now() };
    requestRender?.();
  });

  pi.on("tool_execution_end", async () => {
    activeTool = null;
    requestRender?.();
  });

  pi.on("thinking_level_select", async (event) => {
    thinkingLevel = (event as any).level ?? null;
    requestRender?.();
  });

  pi.registerCommand("sidebar-tui", {
    description: "Control sidebar: /sidebar-tui on | off | width <N> | todos <N> | scroll <N> | momentum <on|off> | subagents <input|sidebar|both|on|off>",
    handler: async (args, ctx) => {
      currentCwd = (ctx as any).cwd;
      const parts = (args?.trim() ?? "").split(/\s+/);
      const cmd = parts[0];

      if (cmd === "subagents") {
        const val = parts[1]?.toLowerCase();
        if (val === "input" || val === "off" || val === "1") {
          subagentsEnabled = false;
        } else if (val === "sidebar" || val === "both" || val === "on" || val === "2" || val === "3") {
          subagentsEnabled = true;
        } else {
          subagentsEnabled = !subagentsEnabled;
        }
        saveSidebarSettings({ enabled: sidebarEnabled, width: sidebarWidth, todosMax, scrollSpeed, momentum: momentumEnabled, subagents: subagentsEnabled });
        requestRender?.();
        (ctx as any).ui?.notify?.(`Sidebar subagents panel ${subagentsEnabled ? "enabled" : "disabled"}`, "info");
        return;
      }

      if (cmd === "width") {
        const n = parseInt(parts[1] ?? "", 10);
        if (isNaN(n) || n < 10 || n > 120) {
          (ctx as any).ui?.notify?.("Usage: /sidebar-tui width <10-120>", "warning");
          return;
        }
        sidebarWidth = n;
        saveSidebarSettings({ enabled: sidebarEnabled, width: sidebarWidth, todosMax, scrollSpeed, momentum: momentumEnabled, subagents: subagentsEnabled });
        if (compositorRef && tuiRef) {
          compositorRef.dispose();
          compositorRef = null;
          const comp = new SidebarCompositor(tuiRef, () => buildSidebarContext(currentCwd), sidebarWidth);
          comp.install();
          compositorRef = comp;
          requestRender?.();
        }
        (ctx as any).ui?.notify?.(`Sidebar width set to ${n}`, "info");
        return;
      }

      if (cmd === "todos") {
        const n = parseInt(parts[1] ?? "", 10);
        if (isNaN(n) || n < MIN_TODOS_MAX || n > MAX_TODOS_MAX) {
          (ctx as any).ui?.notify?.(`Usage: /sidebar-tui todos <${MIN_TODOS_MAX}-${MAX_TODOS_MAX}>`, "warning");
          return;
        }
        todosMax = n;
        saveSidebarSettings({ enabled: sidebarEnabled, width: sidebarWidth, todosMax, scrollSpeed, momentum: momentumEnabled, subagents: subagentsEnabled });
        requestRender?.();
        (ctx as any).ui?.notify?.(`Todos max set to ${n}`, "info");
        return;
      }

      if (cmd === "scroll") {
        const n = parseInt(parts[1] ?? "", 10);
        if (isNaN(n) || n < MIN_SCROLL_SPEED || n > MAX_SCROLL_SPEED) {
          (ctx as any).ui?.notify?.(`Usage: /sidebar-tui scroll <${MIN_SCROLL_SPEED}-${MAX_SCROLL_SPEED}>`, "warning");
          return;
        }
        scrollSpeed = n;
        saveSidebarSettings({ enabled: sidebarEnabled, width: sidebarWidth, todosMax, scrollSpeed, momentum: momentumEnabled, subagents: subagentsEnabled });
        applyScrollSpeed(tuiRef, scrollSpeed);
        momentumRef?.setBaseSpeed(scrollSpeed);
        (ctx as any).ui?.notify?.(`Scroll speed set to ${n} lines`, "info");
        return;
      }

      if (cmd === "momentum") {
        const val = parts[1]?.toLowerCase();
        if (val !== "on" && val !== "off") {
          (ctx as any).ui?.notify?.("Usage: /sidebar-tui momentum <on|off>", "warning");
          return;
        }
        momentumEnabled = val === "on";
        saveSidebarSettings({ enabled: sidebarEnabled, width: sidebarWidth, todosMax, scrollSpeed, momentum: momentumEnabled, subagents: subagentsEnabled });
        momentumRef?.setEnabled(momentumEnabled);
        (ctx as any).ui?.notify?.(`Scroll momentum ${momentumEnabled ? "enabled" : "disabled"}`, "info");
        return;
      }

      if (cmd !== "on" && cmd !== "off") {
        (ctx as any).ui?.notify?.("Usage: /sidebar-tui on | off | width <N> | todos <N> | scroll <N> | momentum <on|off> | subagents <on|off>", "warning");
        return;
      }

      setSidebarEnabled(cmd === "on", ctx);
    },
  });

  pi.registerShortcut("ctrl+shift+t", {
    description: "Toggle sidebar on/off",
    handler: async (ctx) => {
      currentCwd = (ctx as any).cwd;
      setSidebarEnabled(!sidebarEnabled, ctx);
    },
  });

  pi.registerCommand("session-title", {
    description: "Set session title shown in sidebar",
    handler: async (args, ctx) => {
      const title = args?.trim() ?? "";
      if (!title) {
        (ctx as any).ui?.notify?.("Usage: /session-title <text>", "warning");
        return;
      }
      sessionTitle = title;
      requestRender?.();
      (ctx as any).ui?.notify?.(`Session title set: ${title}`, "info");
    },
  });

  pi.registerCommand("sidebar-scroll", {
    description: "Scroll sidebar panel: /sidebar-scroll up | down | top | bottom | <lines>",
    handler: async (args, ctx) => {
      if (!compositorRef) {
        (ctx as any).ui?.notify?.("Sidebar is not active.", "warning");
        return;
      }
      const arg = args?.trim().toLowerCase() || "down";
      if (arg === "up") {
        compositorRef.scrollBy(-3);
      } else if (arg === "down") {
        compositorRef.scrollBy(3);
      } else if (arg === "top" || arg === "start") {
        compositorRef.scrollToTop();
      } else if (arg === "bottom" || arg === "end") {
        compositorRef.scrollToBottom();
      } else {
        const n = parseInt(arg, 10);
        if (!isNaN(n)) {
          compositorRef.scrollBy(n);
        } else {
          (ctx as any).ui?.notify?.("Usage: /sidebar-scroll up | down | top | bottom | <lines>", "warning");
          return;
        }
      }
    },
  });

  pi.registerShortcut("alt+shift+up", {
    description: "Scroll sidebar up",
    handler: async () => {
      compositorRef?.scrollBy(-3);
    },
  });

  pi.registerShortcut("alt+shift+down", {
    description: "Scroll sidebar down",
    handler: async () => {
      compositorRef?.scrollBy(3);
    },
  });

  pi.registerShortcut("ctrl+alt+up", {
    description: "Scroll sidebar up",
    handler: async () => {
      compositorRef?.scrollBy(-3);
    },
  });

  pi.registerShortcut("ctrl+alt+down", {
    description: "Scroll sidebar down",
    handler: async () => {
      compositorRef?.scrollBy(3);
    },
  });

  pi.registerShortcut("alt+pageup", {
    description: "Scroll sidebar page up",
    handler: async () => {
      compositorRef?.scrollBy(-10);
    },
  });

  pi.registerShortcut("alt+pagedown", {
    description: "Scroll sidebar page down",
    handler: async () => {
      compositorRef?.scrollBy(10);
    },
  });
}

export * from "./panels/registry.ts";
