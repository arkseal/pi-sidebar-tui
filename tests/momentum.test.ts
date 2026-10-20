import test from "node:test";
import assert from "node:assert/strict";
import { ScrollMomentum } from "../momentum.ts";
import { SidebarCompositor } from "../compositor.ts";

function makeMockTui(initialScrollTop = 50) {
  let scrollTop = initialScrollTop;
  let renderRequested = 0;
  const inputListeners: ((data: string) => void)[] = [];

  const scrollView = {
    scrollTop,
    scrollBy(delta: number) {
      const prev = scrollTop;
      scrollTop = Math.max(0, scrollTop + delta);
      this.scrollTop = scrollTop;
      // return unconsumed delta (0 if fully scrolled)
      return delta - (scrollTop - prev);
    },
  };

  const tui = {
    wheelScrollLines: 3,
    routeWheelCalls: [] as any[],
    routeWheel(event: any, delta?: number) {
      this.routeWheelCalls.push({ ...event, lines: this.wheelScrollLines, delta });
      const lines = delta !== undefined ? delta : event.direction * this.wheelScrollLines;
      scrollView.scrollBy(lines);
    },
    getPrimaryScrollView() {
      return scrollView;
    },
    requestRender() {
      renderRequested++;
    },
    addInputListener(listener: (data: string) => void) {
      inputListeners.push(listener);
      return () => {
        const idx = inputListeners.indexOf(listener);
        if (idx !== -1) inputListeners.splice(idx, 1);
      };
    },
    emitInput(data: string) {
      for (const l of inputListeners) l(data);
    },
    get renderCount() {
      return renderRequested;
    },
  };

  return { tui, scrollView };
}

test("ScrollMomentum installs on tui and wraps routeWheel", () => {
  const { tui, scrollView } = makeMockTui();
  const momentum = new ScrollMomentum(tui, { baseSpeed: 3, enabled: true });
  momentum.install();

  tui.routeWheel({ direction: -1, button: 64, x: 0, y: 0 });
  assert.equal(tui.routeWheelCalls.length, 1);
  assert.equal(scrollView.scrollTop, 47);

  momentum.dispose();
});

test("Rapid consecutive wheel events accelerate scrolling", () => {
  const { tui } = makeMockTui(100);
  const momentum = new ScrollMomentum(tui, { baseSpeed: 3, enabled: true });
  momentum.install();

  tui.routeWheel({ direction: -1, button: 64, x: 0, y: 0 });
  assert.equal(tui.routeWheelCalls[0].lines, 3);

  // Fast second event within 30ms
  tui.routeWheel({ direction: -1, button: 64, x: 0, y: 0 });
  assert.ok(tui.routeWheelCalls[1].lines > 3, `Expected accelerated speed > 3, got ${tui.routeWheelCalls[1].lines}`);

  momentum.dispose();
});

test("Reversing direction resets momentum speed", () => {
  const { tui } = makeMockTui(100);
  const momentum = new ScrollMomentum(tui, { baseSpeed: 3, enabled: true });
  momentum.install();

  tui.routeWheel({ direction: -1, button: 64, x: 0, y: 0 });
  tui.routeWheel({ direction: -1, button: 64, x: 0, y: 0 });
  assert.ok(tui.routeWheelCalls[1].lines > 3);

  // Reverse direction
  tui.routeWheel({ direction: 1, button: 65, x: 0, y: 0 });
  assert.equal(tui.routeWheelCalls[2].lines, 3);

  momentum.dispose();
});

test("Typing input cancels active coasting timer", async () => {
  const { tui } = makeMockTui(200);
  const momentum = new ScrollMomentum(tui, { baseSpeed: 3, decayIntervalMs: 15, enabled: true });
  momentum.install();

  // Trigger rapid events to start coasting
  tui.routeWheel({ direction: -1, button: 64, x: 0, y: 0 });
  tui.routeWheel({ direction: -1, button: 64, x: 0, y: 0 });

  // Input arrives immediately
  tui.emitInput("a");
  const scrollAfterInput = tui.getPrimaryScrollView().scrollTop;

  await new Promise((r) => setTimeout(r, 60));
  // ScrollTop should not have kept coasting
  assert.equal(tui.getPrimaryScrollView().scrollTop, scrollAfterInput);

  momentum.dispose();
});

test("ScrollMomentum dispose restores original routeWheel", () => {
  const { tui } = makeMockTui();
  const origRoute = tui.routeWheel;
  const momentum = new ScrollMomentum(tui, { baseSpeed: 3 });
  momentum.install();
  assert.notEqual(tui.routeWheel, origRoute);

  momentum.dispose();
  assert.equal(tui.routeWheel, origRoute);
});

test("ScrollMomentum setEnabled(false) bypasses momentum acceleration", () => {
  const { tui } = makeMockTui(100);
  const momentum = new ScrollMomentum(tui, { baseSpeed: 3 });
  momentum.install();
  momentum.setEnabled(false);

  tui.routeWheel({ direction: -1, button: 64, x: 0, y: 0 });
  tui.routeWheel({ direction: -1, button: 64, x: 0, y: 0 });
  assert.equal(tui.routeWheelCalls[0].lines, 3);
  assert.equal(tui.routeWheelCalls[1].lines, 3);

  momentum.dispose();
});

test("Medium-paced scrolling stays gentle and does not trigger coasting", async () => {
  const { tui, scrollView } = makeMockTui(100);
  const momentum = new ScrollMomentum(tui, { baseSpeed: 1, enabled: true });
  momentum.install();

  // First tick
  tui.routeWheel({ direction: -1, button: 64, x: 0, y: 0 });
  assert.equal(tui.routeWheelCalls[0].lines, 1);

  // Moderate interval (100ms)
  await new Promise((r) => setTimeout(r, 100));
  tui.routeWheel({ direction: -1, button: 64, x: 0, y: 0 });
  assert.ok(tui.routeWheelCalls[1].lines <= 2, `Expected lines <= 2, got ${tui.routeWheelCalls[1].lines}`);

  // Moderate interval (100ms)
  await new Promise((r) => setTimeout(r, 100));
  tui.routeWheel({ direction: -1, button: 64, x: 0, y: 0 });
  assert.ok(tui.routeWheelCalls[2].lines <= 3, `Expected lines <= 3, got ${tui.routeWheelCalls[2].lines}`);

  const posAfterTicks = scrollView.scrollTop;
  // Wait to verify no coasting occurred
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(scrollView.scrollTop, posAfterTicks, "Medium scroll should not coast");

  momentum.dispose();
});

test("Wheel event over sidebar delegates to compositor instead of main viewport", () => {
  const { tui, scrollView } = makeMockTui(50);
  let sidebarScrolledDelta = 0;
  const mockCompositor = {
    getSeparatorColumn: () => 60,
    getScrollTop: () => 0,
    scrollBy(delta: number) {
      sidebarScrolledDelta += delta;
    },
  };

  const momentum = new ScrollMomentum(tui, { baseSpeed: 2, enabled: true }, () => mockCompositor);
  momentum.install();

  // Scroll with x = 70 (over sidebar which starts at col 60)
  tui.routeWheel({ direction: 1, button: 64, x: 70, y: 5 });

  // Main scroll view should NOT have changed
  assert.equal(scrollView.scrollTop, 50, "main viewport should not scroll when cursor is over sidebar");
  assert.equal(tui.routeWheelCalls.length, 0, "routeWheelCalls should be empty for sidebar scroll");

  // Sidebar compositor should have scrolled
  assert.equal(sidebarScrolledDelta, 2, "sidebar compositor should have scrolled by baseSpeed");

  // Scroll with x = 20 (over main viewport)
  tui.routeWheel({ direction: -1, button: 64, x: 20, y: 5 });
  assert.equal(scrollView.scrollTop, 48, "main viewport should scroll when cursor is over main area");
  assert.equal(tui.routeWheelCalls.length, 1);

  momentum.dispose();
});

test("Pi 0.99.0+ two-argument routeWheel(event, delta) forwards and scales delta", () => {
  const { tui, scrollView } = makeMockTui(100);
  const momentum = new ScrollMomentum(tui, { baseSpeed: 2, enabled: true });
  momentum.install();

  // Pi 0.99.0+ calls routeWheel(wheelEvent, wheelDelta) with delta argument
  tui.routeWheel({ direction: -1, button: 64, x: 10, y: 5 }, -2);
  assert.equal(tui.routeWheelCalls.length, 1);
  assert.equal(tui.routeWheelCalls[0].delta, -2);
  assert.equal(scrollView.scrollTop, 98);

  // Fast consecutive flick
  tui.routeWheel({ direction: -1, button: 64, x: 10, y: 5 }, -2);
  assert.equal(tui.routeWheelCalls.length, 2);
  assert.ok(tui.routeWheelCalls[1].delta < -2, `Expected accelerated delta < -2, got ${tui.routeWheelCalls[1].delta}`);

  // When momentum is disabled, forwards original delta verbatim
  momentum.setEnabled(false);
  tui.routeWheel({ direction: 1, button: 65, x: 10, y: 5 }, 5);
  assert.equal(tui.routeWheelCalls[2].delta, 5);

  momentum.dispose();
});

test("Reversing scroll direction over sidebar scrolls sidebar and does not scroll main chat", () => {
  const { tui, scrollView } = makeMockTui(100);
  let sidebarScrolledDelta = 0;
  const mockCompositor = {
    getSeparatorColumn: () => 50,
    getScrollTop: () => 10,
    scrollBy(delta: number) {
      sidebarScrolledDelta += delta;
    },
  };

  const momentum = new ScrollMomentum(tui, { baseSpeed: 1, enabled: true }, () => mockCompositor);
  momentum.install();

  // 1. Scroll DOWN over sidebar (x = 60)
  tui.routeWheel({ direction: 1, button: 64, x: 60, y: 5 }, 1);
  assert.equal(sidebarScrolledDelta, 1, "sidebar should scroll by 1");
  assert.equal(scrollView.scrollTop, 100, "main chat must not scroll");
  assert.equal(tui.routeWheelCalls.length, 0);

  // 2. Reverse direction: Scroll UP over sidebar (x = 60)
  tui.routeWheel({ direction: -1, button: 64, x: 60, y: 5 }, -1);
  assert.equal(sidebarScrolledDelta, 0, "sidebar should scroll up by 1 (net 0)");
  assert.equal(scrollView.scrollTop, 100, "main chat must NOT scroll on reversal over sidebar");
  assert.equal(tui.routeWheelCalls.length, 0, "routeWheelCalls must remain empty for sidebar reversal");

  momentum.dispose();
});

test("Switching from main chat scroll to sidebar scroll does not scroll main chat on reversal", () => {
  const { tui, scrollView } = makeMockTui(100);
  let sidebarScrolledDelta = 0;
  const mockCompositor = {
    getSeparatorColumn: () => 50,
    getScrollTop: () => 0,
    scrollBy(delta: number) {
      sidebarScrolledDelta += delta;
    },
  };

  const momentum = new ScrollMomentum(tui, { baseSpeed: 1, enabled: true }, () => mockCompositor);
  momentum.install();

  // 1. User scrolls UP in main chat (x = 20)
  tui.routeWheel({ direction: -1, button: 64, x: 20, y: 5 }, -1);
  assert.equal(scrollView.scrollTop, 99, "main chat should scroll up by 1");
  assert.equal(tui.routeWheelCalls.length, 1);

  // 2. User moves mouse to sidebar and scrolls DOWN (x = 60)
  // This would previously be flagged as a reversal from -1 to 1 and sent to origRouteWheel!
  tui.routeWheel({ direction: 1, button: 64, x: 60, y: 5 }, 1);
  assert.equal(scrollView.scrollTop, 99, "main chat must not scroll when moving to sidebar");
  assert.equal(sidebarScrolledDelta, 1, "sidebar must scroll");
  assert.equal(tui.routeWheelCalls.length, 1, "no new main chat scroll calls");

  momentum.dispose();
});

test("Scrolling over sidebar with momentum disabled delegates to compositor without scrolling main viewport", () => {
  const { tui, scrollView } = makeMockTui(100);
  let sidebarScrolledDelta = 0;
  const mockCompositor = {
    getSeparatorColumn: () => 50,
    getScrollTop: () => 0,
    scrollBy(delta: number) {
      sidebarScrolledDelta += delta;
    },
  };

  const momentum = new ScrollMomentum(tui, { baseSpeed: 2, enabled: false }, () => mockCompositor);
  momentum.install();

  // Scroll over sidebar with momentum disabled
  tui.routeWheel({ direction: 1, button: 64, x: 60, y: 5 }, 2);
  assert.equal(sidebarScrolledDelta, 2, "sidebar should scroll by lines even with momentum disabled");
  assert.equal(scrollView.scrollTop, 100, "main chat must not scroll when momentum is disabled over sidebar");
  assert.equal(tui.routeWheelCalls.length, 0);

  // Scroll over main viewport with momentum disabled
  tui.routeWheel({ direction: -1, button: 64, x: 20, y: 5 }, -2);
  assert.equal(scrollView.scrollTop, 98, "main chat should scroll when cursor is over main viewport");
  assert.equal(tui.routeWheelCalls.length, 1);

  momentum.dispose();
});

test("SidebarCompositor getSeparatorColumn returns mainWidth (0-based separator index)", () => {
  const term = {
    columns: 80,
    rows: 24,
    write() {},
  };
  const mockTui = {
    terminal: term,
    mode: "fullscreen",
    doRender() {},
  };
  const comp = new SidebarCompositor(mockTui, () => ({} as any), 30);
  comp.install();

  // rawCols = 80, sidebarWidth = 30
  // mainWidth = 80 - 30 - 1 = 49 (indices 0..48 main chat, index 49 separator line)
  assert.equal(comp.getSeparatorColumn(), 49);

  comp.dispose();
});


