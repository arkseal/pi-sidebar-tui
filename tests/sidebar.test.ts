import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SidebarContext } from "../types.ts";
import { renderSidebar } from "../sidebar.ts";
import { ensureFullscreenTuiMode, applyScrollSpeed } from "../index.ts";
import { SidebarCompositor } from "../compositor.ts";
import { registerSidebarPanel, clearRegisteredSidebarPanels } from "../panels/registry.ts";

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeCtx(overrides: Partial<SidebarContext> = {}): SidebarContext {
  return {
    sessionTitle: null,
    sessionId: null,
    todos: [],
    todosMax: 5,
    branch: "main",
    aheadCount: 0,
    untrackedCount: 0,
    workspaceFiles: [],
    cwd: "/tmp/test",
    model: null,
    thinkingLevel: null,
    contextTokens: null,
    contextPercent: null,
    contextWindow: null,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    sessionCost: 0,
    turnCount: 0,
    activeTool: null,
    autoCompactEnabled: null,
    sessionStartMs: Date.now(),
    mcpServers: [],
    modelProvider: null,
    cavemanLevel: null,
    cavemanFrame: 0,
    agentActive: false,
    spinnerFrame: 0,
    liveTps: null,
    lastTps: null,
    lastTurnMs: null,
    ctxSamples: [],
    ...overrides,
  };
}

test("sidebar stacks all panels", () => {
  const ctx = makeCtx({});
  const lines = renderSidebar(ctx, 40);
  const text = lines.map(strip).join("\n");
  assert.ok(text.includes("Session"), "missing Session panel");
  assert.ok(text.includes("Todos"), "missing Todos panel");
  assert.ok(text.includes("Workspace"), "missing Workspace panel");
});

test("sidebar has blank separator lines between panels", () => {
  const ctx = makeCtx({});
  const lines = renderSidebar(ctx, 40);
  assert.ok(lines.some(l => strip(l).trim() === ""), "no blank separator line found");
});

test("sidebar all lines at most configured width", () => {
  const ctx = makeCtx({
    sessionTitle: "a".repeat(200),
    todos: [{ id: "1", content: "b".repeat(200), status: "in_progress" }],
  });
  const lines = renderSidebar(ctx, 30);
  for (const line of lines) {
    const w = visibleWidth(strip(line));
    assert.ok(w <= 30, `line too wide (${w}): "${strip(line)}"`);
  }
});

test("sidebar width=1 does not throw", () => {
  const ctx = makeCtx({});
  assert.doesNotThrow(() => renderSidebar(ctx, 1));
});

test("sidebar empty states for all panels render without error", () => {
  const ctx = makeCtx({
    sessionTitle: null,
    sessionId: null,
    todos: [],
    branch: null,
    workspaceFiles: [],
  });
  const lines = renderSidebar(ctx, 36);
  assert.ok(lines.length > 0);
  const text = lines.map(strip).join("\n");
  assert.ok(text.includes("waiting for first message"));
  assert.ok(text.includes("no todos"));
  assert.ok(text.includes("not a git repo"));
});

test("ensureFullscreenTuiMode sets fullscreen when regular", () => {
  let mode = "regular";
  const ctx = {
    settingsManager: {
      getTuiMode() { return mode; },
      setTuiMode(m: string) { mode = m; },
    },
  };
  const changed = ensureFullscreenTuiMode(ctx);
  assert.equal(changed, true);
  assert.equal(mode, "fullscreen");
});

test("ensureFullscreenTuiMode returns false when already fullscreen", () => {
  let mode = "fullscreen";
  const ctx = {
    settingsManager: {
      getTuiMode() { return mode; },
      setTuiMode(m: string) { mode = m; },
    },
  };
  const changed = ensureFullscreenTuiMode(ctx);
  assert.equal(changed, false);
  assert.equal(mode, "fullscreen");
});

test("ensureFullscreenTuiMode handles missing settingsManager safely", () => {
  assert.doesNotThrow(() => ensureFullscreenTuiMode({}));
  assert.equal(ensureFullscreenTuiMode(null), false);
});

test("applyScrollSpeed updates tui.wheelScrollLines", () => {
  const tui = { wheelScrollLines: 1 };
  applyScrollSpeed(tui, 4);
  assert.equal(tui.wheelScrollLines, 4);
});

test("applyScrollSpeed ignores invalid or null tui safely", () => {
  assert.doesNotThrow(() => applyScrollSpeed(null, 4));
  assert.doesNotThrow(() => applyScrollSpeed({}, 0));
});

test("SidebarCompositor limits full-line erase to mainWidth", () => {
  const writes: string[] = [];
  const term = {
    columns: 80,
    rows: 24,
    write(d: string) { writes.push(d); },
  };
  const mockTui = {
    terminal: term,
    mode: "fullscreen",
    doRender() {
      term.write("\x1b[1;1H\x1b[2KHello world");
    },
  };
  const comp = new SidebarCompositor(mockTui, () => makeCtx({}), 20);
  comp.install();

  mockTui.doRender();

  // mainWidth is 80 - 20 - 1 = 59
  assert.ok(writes.some(w => w.includes("\x1b[59X")), "erase was not bounded to mainWidth");
  assert.ok(!writes.some(w => w.includes("\x1b[2K")), "unbounded 2K erase leaked through");

  comp.dispose();
});

test("renderSidebar filters out subagents panel when showSubagents is false", () => {
  clearRegisteredSidebarPanels();
  registerSidebarPanel({
    id: "subagents",
    order: 15,
    render: () => ["Subagents (1 active)"],
  });

  const ctxEnabled = makeCtx({ showSubagents: true });
  const linesEnabled = renderSidebar(ctxEnabled, 40);
  assert.ok(linesEnabled.some(l => l.includes("Subagents")), "subagents panel should be rendered when enabled");

  const ctxDisabled = makeCtx({ showSubagents: false });
  const linesDisabled = renderSidebar(ctxDisabled, 40);
  assert.ok(!linesDisabled.some(l => l.includes("Subagents")), "subagents panel should not be rendered when disabled");

  clearRegisteredSidebarPanels();
});

test("SidebarCompositor supports scrolling and indicator rendering when content overflows", () => {
  const writes: string[] = [];
  const term = {
    columns: 80,
    rows: 15,
    write(d: string) { writes.push(d); },
  };
  const mockTui = {
    terminal: term,
    mode: "fullscreen",
    doRender() {},
  };

  clearRegisteredSidebarPanels();
  registerSidebarPanel({
    id: "tall-panel",
    order: 15,
    render: () => Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`),
  });

  const comp = new SidebarCompositor(mockTui, () => makeCtx({ cwd: "/test" }), 25);
  comp.install();
  comp.paint();

  // Initially at top (scrollTop === 0)
  assert.equal(comp.getScrollTop(), 0);
  assert.ok(comp.getMaxScrollTop() > 0, "maxScrollTop should be > 0 for overflowing content");
  let output = writes.join("");
  assert.ok(output.includes("lines below"), "bottom indicator should be shown when overflowing below");

  // Scroll down
  writes.length = 0;
  comp.scrollBy(5);
  assert.equal(comp.getScrollTop(), 5);
  output = writes.join("");
  assert.ok(output.includes("lines above"), "top indicator should appear when scrolled down");

  // Scroll to bottom
  writes.length = 0;
  comp.scrollToBottom();
  assert.equal(comp.getScrollTop(), comp.getMaxScrollTop());

  // Scroll to top
  writes.length = 0;
  comp.scrollToTop();
  assert.equal(comp.getScrollTop(), 0);

  comp.dispose();
  clearRegisteredSidebarPanels();
});

test("SidebarCompositor does not oscillate between last line and indicator on repeated paints at bottom", () => {
  const writes: string[] = [];
  const term = {
    columns: 80,
    rows: 15,
    write(d: string) { writes.push(d); },
  };
  const mockTui = {
    terminal: term,
    mode: "fullscreen",
    doRender() {},
  };

  clearRegisteredSidebarPanels();
  let spinnerTick = 0;
  registerSidebarPanel({
    id: "last-line-test",
    order: 15,
    render: () => Array.from({ length: 25 }, (_, i) => i === 24 ? "FINAL_LAST_LINE" : `Line ${i + 1} (tick ${spinnerTick})`),
  });

  const comp = new SidebarCompositor(mockTui, () => makeCtx({ cwd: "/test" }), 25);
  comp.install();
  writes.length = 0;
  comp.scrollToBottom();

  const initialBottom = writes.join("");
  assert.ok(initialBottom.includes("FINAL_LAST_LINE"), "should include FINAL_LAST_LINE at bottom");
  assert.ok(!initialBottom.includes("lines below"), "should not include lines below indicator at bottom");

  // Repeated animated repaints must remain completely stable and never flicker with lines below
  for (let frame = 1; frame <= 5; frame++) {
    spinnerTick = frame;
    writes.length = 0;
    comp.paint();
    const frameOutput = writes.join("");
    assert.ok(!frameOutput.includes("lines below"), `Frame ${frame} should not flicker with lines below`);
  }

  comp.dispose();
  clearRegisteredSidebarPanels();
});

test("SidebarCompositor dispatches mouse click to panel onClick handler", () => {
  let clickedLine: string | null = null;
  let clickedIndex: number | null = null;

  registerSidebarPanel({
    id: "clickable-panel",
    order: 15,
    render: () => ["Header", "Clickable Item", "Footer"],
    onClick: (text, idx) => {
      clickedLine = text;
      clickedIndex = idx;
    },
  });

  const mockTui: any = {
    mode: "fullscreen",
    terminal: { rows: 20, columns: 80, write: () => {} },
    handleMouseEvent: () => {},
  };

  const comp = new SidebarCompositor(mockTui, () => makeCtx({ cwd: "" }), 30);
  comp.install();
  comp.paint();

  const lines = renderSidebar(makeCtx({ cwd: "" }), 30);
  const targetRow = lines.findIndex(l => l.includes("Clickable Item"));
  assert.ok(targetRow >= 0, "should find Clickable Item in rendered lines");

  // Press down (raw.y is 0-based)
  mockTui.handleMouseEvent({
    x: 55,
    y: targetRow,
    button: 0,
    release: false,
  });

  // Release (click complete)
  mockTui.handleMouseEvent({
    x: 55,
    y: targetRow,
    button: 0,
    release: true,
  });

  assert.equal(clickedLine, "Clickable Item");
  assert.equal(clickedIndex, 1);

  comp.dispose();
  clearRegisteredSidebarPanels();
});

test("SidebarCompositor safely handles narrow terminal resize without negative coordinates", () => {
  const writes: string[] = [];
  const term = {
    columns: 45, // Narrow: 45 < 40 + 10 (MIN_USABLE_MAIN_WIDTH)
    rows: 24,
    write(d: string) { writes.push(d); },
  };
  const mockTui = {
    terminal: term,
    mode: "fullscreen",
    doRender() {
      term.write("\x1b[1;1H\x1b[2KContent");
    },
  };

  const comp = new SidebarCompositor(mockTui, () => makeCtx({}), 40);
  comp.install();

  // Terminal columns should not be shrunk down to 1 or negative
  assert.equal(term.columns, 45, "narrow terminal should retain its full width");

  mockTui.doRender();

  // Compositor must not write negative or zero column cursor sequences
  for (const w of writes) {
    assert.ok(!w.includes(";-"), `found negative coordinate in write: ${w}`);
    assert.ok(!w.includes(";0H"), `found zero column coordinate in write: ${w}`);
  }

  // Expanding back to the old dimensions must repaint after a narrow frame.
  const narrowWrites = writes.length;
  term.columns = 80;
  mockTui.doRender();
  assert.ok(writes.length > narrowWrites, "sidebar should repaint after expanding from a too-narrow terminal");
  assert.ok(writes.slice(narrowWrites).some(w => w.includes("│")), "expanded frame should paint separator again");

  comp.dispose();
});

test("SidebarCompositor restores exact terminal.write descriptor and does not clobber later wrappers", () => {
  const term: any = {
    columns: 80,
    rows: 24,
    write(d: string) { return d.length; },
  };
  const original = Object.getOwnPropertyDescriptor(term, "write")!;
  const tui: any = { terminal: term, mode: "fullscreen", doRender() {} };
  const comp = new SidebarCompositor(tui, () => makeCtx({}), 20);
  comp.install();
  assert.notEqual(term.write, original.value);
  comp.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(term, "write"), original);

  const comp2 = new SidebarCompositor(tui, () => makeCtx({}), 20);
  comp2.install();
  const compositorWrapper = term.write;
  const laterWrapper = function (this: any, data: string) { return compositorWrapper.call(this, data); };
  term.write = laterWrapper;
  comp2.dispose();
  assert.equal(term.write, laterWrapper, "dispose must not overwrite a wrapper installed later");
});

test("SidebarCompositor intercepts mouse-down inside sidebar to protect main transcript selection", () => {
  let mainMouseCalls = 0;
  const mockTui: any = {
    mode: "fullscreen",
    terminal: { rows: 20, columns: 80, write: () => {} },
    handleMouseEvent: () => {
      mainMouseCalls++;
    },
  };

  const comp = new SidebarCompositor(mockTui, () => makeCtx({ cwd: "" }), 30);
  comp.install();

  // Press down inside sidebar area (x = 60 >= 80 - 30 - 1 = 49)
  mockTui.handleMouseEvent({
    x: 60,
    y: 5,
    button: 0,
    release: false,
  });

  // Must be intercepted: main area handler never called for sidebar mouse-down
  assert.equal(mainMouseCalls, 0, "mouse down in sidebar should not reach main TUI handler");

  // Press down in main area (x = 10)
  mockTui.handleMouseEvent({
    x: 10,
    y: 5,
    button: 0,
    release: false,
  });

  assert.equal(mainMouseCalls, 1, "mouse down in main area should reach main TUI handler");

  comp.dispose();
});
