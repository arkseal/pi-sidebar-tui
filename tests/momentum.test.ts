import test from "node:test";
import assert from "node:assert/strict";
import { ScrollMomentum } from "../momentum.ts";

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
    routeWheel(event: any) {
      this.routeWheelCalls.push({ ...event, lines: this.wheelScrollLines });
      scrollView.scrollBy(event.direction * this.wheelScrollLines);
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
