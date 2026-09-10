import test from "node:test";
import assert from "node:assert/strict";
import {
  registerSidebarPanel,
  unregisterSidebarPanel,
  getRegisteredSidebarPanels,
  clearRegisteredSidebarPanels,
  isSidebarAvailable,
  requestSidebarRender,
  setSidebarRenderCallback,
} from "../panels/registry.ts";
import { renderSidebar } from "../sidebar.ts";
import type { SidebarContext } from "../types.ts";

function createMockContext(): SidebarContext {
  return {
    sessionTitle: "Test Session",
    sessionId: "test-id",
    todos: [],
    todosMax: 5,
    branch: "main",
    aheadCount: 0,
    untrackedCount: 0,
    workspaceFiles: [],
    cwd: "/test",
    model: "claude-3-5-sonnet",
    thinkingLevel: "off",
    contextTokens: 1000,
    contextPercent: 10,
    contextWindow: 100000,
    tokensIn: 500,
    tokensOut: 200,
    cacheRead: 0,
    cacheWrite: 0,
    sessionCost: 0,
    turnCount: 1,
    activeTool: null,
    autoCompactEnabled: false,
    sessionStartMs: Date.now(),
    mcpServers: [],
    modelProvider: "antigravity",
    cavemanLevel: null,
    cavemanFrame: 0,
    agentActive: false,
    spinnerFrame: 0,
    liveTps: null,
    lastTps: null,
    lastTurnMs: null,
    ctxSamples: [],
  };
}

test("registerSidebarPanel adds panel and sorts by order", () => {
  clearRegisteredSidebarPanels();

  const unreg1 = registerSidebarPanel({
    id: "panel-b",
    order: 35,
    render: () => ["Panel B Line 1"],
  });

  const unreg2 = registerSidebarPanel({
    id: "panel-a",
    order: 15,
    render: () => ["Panel A Line 1"],
  });

  const panels = getRegisteredSidebarPanels();
  assert.equal(panels.length, 2);
  assert.equal(panels[0]?.id, "panel-a");
  assert.equal(panels[1]?.id, "panel-b");

  unreg1();
  assert.equal(getRegisteredSidebarPanels().length, 1);
  assert.equal(getRegisteredSidebarPanels()[0]?.id, "panel-a");

  unreg2();
  assert.equal(getRegisteredSidebarPanels().length, 0);
});

test("renderSidebar incorporates dynamic panels into output", () => {
  clearRegisteredSidebarPanels();
  const ctx = createMockContext();

  registerSidebarPanel({
    id: "quota-test",
    order: 20,
    render: (_ctx, _w) => [" Quota", " 5h  ████░░░░  50%"],
  });

  const rendered = renderSidebar(ctx, 40);
  const combined = rendered.join("\n");
  assert.ok(combined.includes("Quota"), "Output should contain registered Quota panel");
  assert.ok(combined.includes("5h  ████░░░░  50%"), "Output should contain Quota bar");

  clearRegisteredSidebarPanels();
});

test("requestSidebarRender triggers registered callback", () => {
  let called = false;
  setSidebarRenderCallback(() => {
    called = true;
  });

  requestSidebarRender();
  assert.equal(called, true);

  setSidebarRenderCallback(null);
});

test("isSidebarAvailable returns true", () => {
  assert.equal(isSidebarAvailable(), true);
});
