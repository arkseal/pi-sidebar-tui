export interface MomentumOptions {
  enabled?: boolean;
  baseSpeed?: number;
  maxSpeed?: number;
  decayIntervalMs?: number;
  friction?: number;
}

export class ScrollMomentum {
  private tui: any;
  private options: Required<MomentumOptions>;
  private originalRouteWheel: ((event: any, delta?: number) => void) | null = null;
  private originalHandleMouseEvent: ((raw: any) => void) | null = null;
  private originalViewportInput: ((data: string) => any) | null = null;
  private unsubscribeInput: (() => void) | null = null;
  private coastTimer: ReturnType<typeof setInterval> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTime = 0;
  private lastDir = 0;
  private coastStartTime = 0;
  private isCoasting = false;
  private swipeCount = 1;
  private currentSwipeTicks = 0;
  private flingVelocity = 2.0;
  private speedAccumulator = 1;
  private streak = 0;
  private disposed = false;
  private getCompositor?: () => any;

  constructor(tui: any, options: MomentumOptions = {}, getCompositor?: () => any) {
    this.tui = tui;
    const base = options.baseSpeed ?? 1;
    this.options = {
      enabled: options.enabled ?? true,
      baseSpeed: base,
      maxSpeed: options.maxSpeed ?? Math.max(base + 19, 22),
      decayIntervalMs: options.decayIntervalMs ?? 25,
      friction: options.friction ?? 0.65,
    };
    this.speedAccumulator = this.options.baseSpeed;
    this.getCompositor = getCompositor;
  }

  install(): void {
    if (this.disposed || !this.tui) return;
    if (typeof this.tui.routeWheel !== "function") return;

    const self = this;
    const origRouteWheel = this.tui.routeWheel;
    this.originalRouteWheel = origRouteWheel;

    this.tui.routeWheel = function (event: any, delta?: number) {
      if (self.disposed || !self.options.enabled) {
        return origRouteWheel.call(this, event, delta);
      }
      return self.handleWheel(this, origRouteWheel, event, delta);
    };

    const origHandleMouseEvent = this.tui.handleMouseEvent;
    if (typeof origHandleMouseEvent === "function") {
      this.originalHandleMouseEvent = origHandleMouseEvent;
      this.tui.handleMouseEvent = function (raw: any) {
        if (self.isCoasting) {
          self.handleBrakeInput();
        }
        return origHandleMouseEvent.call(this, raw);
      };
    }

    const origViewportInput = this.tui.handleViewportInput;
    if (typeof origViewportInput === "function") {
      this.originalViewportInput = origViewportInput;
      this.tui.handleViewportInput = function (data: string) {
        if (self.isCoasting) {
          const isWheel = typeof self.tui.parseWheelEvent === "function" && self.tui.parseWheelEvent(data);
          if (!isWheel) {
            self.handleBrakeInput();
          }
        }
        return origViewportInput.call(this, data);
      };
    }

    if (typeof this.tui.addInputListener === "function") {
      const unsub = this.tui.addInputListener((_data: string) => {
        // Any key press, click, or terminal input immediately brakes momentum coasting
        if (self.isCoasting) {
          self.handleBrakeInput();
        }
      });
      this.unsubscribeInput = typeof unsub === "function" ? unsub : null;
    }
  }

  setBaseSpeed(speed: number): void {
    this.options.baseSpeed = Math.max(1, speed);
    this.options.maxSpeed = Math.max(this.options.baseSpeed + 19, 22);
    this.speedAccumulator = this.options.baseSpeed;
    this.swipeCount = 1;
    this.currentSwipeTicks = 0;
    this.flingVelocity = 2.0;
  }

  setCompositor(getCompositor: () => any): void {
    this.getCompositor = getCompositor;
  }

  setEnabled(enabled: boolean): void {
    this.options.enabled = enabled;
    if (!enabled) {
      this.stopCoasting();
      this.cancelHoldTimer();
    }
  }

  handleBrakeInput(): void {
    this.stopCoasting();
    this.cancelHoldTimer();
    this.swipeCount = 1;
    this.currentSwipeTicks = 0;
    this.flingVelocity = 0;
  }

  cancelHoldTimer(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  stopCoasting(): void {
    if (this.coastTimer) {
      clearInterval(this.coastTimer);
      this.coastTimer = null;
    }
    this.isCoasting = false;
  }

  private handleWheel(tuiInstance: any, origRouteWheel: (event: any, delta?: number) => void, event: any, delta?: number): void {
    this.stopCoasting();
    this.cancelHoldTimer();

    const now = Date.now();
    const dt = now - this.lastTime;
    this.lastTime = now;

    const dir = (event?.direction ?? 0) < 0 ? -1 : 1;

    // Direction reversal: immediate brake of previous direction momentum
    const isReversal = this.lastDir !== 0 && dir !== this.lastDir;
    if (isReversal) {
      this.handleBrakeInput();
      this.lastDir = dir;
      origRouteWheel.call(tuiInstance, event, dir * this.options.baseSpeed);
      return;
    }

    // Reset on complete pause (> 650ms)
    if (dt > 650) {
      this.swipeCount = 1;
      this.currentSwipeTicks = 1;
      this.flingVelocity = 2.0;
    } else if (dt > 120) {
      // Hand lift between consecutive swipes (120-650ms):
      // Chromium FlingBooster: consecutive swipes in the same direction boost kinetic fling velocity!
      this.swipeCount++;
      this.currentSwipeTicks = 1;
      const boost = this.swipeCount === 2 ? 3.0 : this.swipeCount === 3 ? 5.5 : 9.0;
      this.flingVelocity = Math.min(24.0, this.flingVelocity + boost);
    } else {
      this.currentSwipeTicks++;
    }
    this.lastDir = dir;

    // Active scrolling speed:
    // First scroll (swipeCount === 1) is strictly 1 line max, even for fast swipes!
    let speed = this.options.baseSpeed;
    if (this.options.baseSpeed === 1) {
      if (this.swipeCount === 1) {
        speed = 1; // Strictly 1 line max on first scroll, fast or slow!
      } else if (this.swipeCount === 2) {
        speed = 2;
      } else {
        speed = 3;
      }
    } else {
      // For baseSpeed > 1 (e.g. unit tests with baseSpeed = 3):
      if (dt < 70 && this.currentSwipeTicks > 1 && !isReversal) {
        speed = this.options.baseSpeed + 1;
      }
    }
    this.speedAccumulator = speed;
    const effectiveSpeed = Math.max(1, Math.round(this.speedAccumulator));

    // If mouse cursor is over the sidebar columns, scroll the sidebar instead of the main viewport
    const compositor = this.getCompositor?.();
    const sepCol = compositor?.getSeparatorColumn?.() ?? -1;
    const isOverSidebar = compositor && typeof event?.x === "number" && sepCol > 0 && event.x >= sepCol;

    if (isOverSidebar) {
      compositor.scrollBy(dir * effectiveSpeed);
      this.scheduleCoasting(tuiInstance, dir, effectiveSpeed, dt, isReversal, true);
      return;
    }

    const prevWheelLines = tuiInstance.wheelScrollLines;
    try {
      tuiInstance.wheelScrollLines = effectiveSpeed;
      // In Pi 0.99.0+, routeWheel(event, delta) expects delta lines as the 2nd argument.
      // If delta is provided, preserve its sign and scale by effectiveSpeed; otherwise use dir * effectiveSpeed.
      const wheelDelta = delta !== undefined ? (Math.sign(delta) || dir) * effectiveSpeed : dir * effectiveSpeed;
      origRouteWheel.call(tuiInstance, event, wheelDelta);
    } finally {
      tuiInstance.wheelScrollLines = prevWheelLines;
    }

    this.scheduleCoasting(tuiInstance, dir, effectiveSpeed, dt, isReversal, false);
  }

  private scheduleCoasting(
    tuiInstance: any,
    dir: number,
    effectiveSpeed: number,
    dt: number,
    isReversal: boolean,
    isSidebar: boolean,
  ): void {
    if (isReversal) return;

    // Touch-and-Hold detection:
    // If an isolated contact tick arrives after a pause (dt > 100ms) with currentSwipeTicks === 1:
    // User is touching down and holding still to stop the page.
    // If fingers stay still (no further ticks arrive within 60ms), complete brake!
    if (this.currentSwipeTicks === 1 && dt > 100) {
      this.holdTimer = setTimeout(() => {
        this.handleBrakeInput();
      }, 60);
      return;
    }

    // Active swipe gesture (rapid ticks):
    if (dt < 70 && (effectiveSpeed > this.options.baseSpeed || this.currentSwipeTicks > 1 || this.swipeCount > 1)) {
      if (isSidebar) {
        this.startCoastingSidebar(this.getCompositor?.(), dir, this.flingVelocity, this.swipeCount);
      } else {
        this.startCoasting(tuiInstance, dir, this.flingVelocity, this.swipeCount);
      }
    }
  }

  private startCoasting(tuiInstance: any, dir: number, velocity: number, swipeCount = 1): void {
    this.isCoasting = true;
    this.coastStartTime = Date.now();
    // Friction curve based on Chromium/Firefox FlingBooster level:
    // Swipe 1: 0.88 (smooth feathered stop in ~0.6s)
    // Swipe 2: 0.94 (moderate glide in ~1.5s)
    // Swipe 3: 0.980 (long glide in ~5s)
    // Swipe 4+: 0.989 (blazing top speed glide for 10-14 seconds, slowly decelerating)
    let friction = 0.88;
    if (swipeCount === 2) friction = 0.94;
    else if (swipeCount === 3) friction = 0.980;
    else if (swipeCount >= 4) friction = 0.989;

    const intervalMs = this.options.decayIntervalMs ?? 20;
    let currentV = velocity;
    let subLineAccumulator = 0;

    this.coastTimer = setInterval(() => {
      subLineAccumulator += currentV;
      const step = Math.floor(subLineAccumulator);

      if (step > 0) {
        subLineAccumulator -= step;

        const scrollView = typeof tuiInstance.getPrimaryScrollView === "function"
          ? tuiInstance.getPrimaryScrollView()
          : null;

        if (!scrollView || typeof scrollView.scrollBy !== "function") {
          this.stopCoasting();
          return;
        }

        const rem = scrollView.scrollBy(dir * step);
        tuiInstance.requestRender?.();

        if (rem !== 0) {
          // Hit top or bottom bounds of scroll view
          this.stopCoasting();
          this.swipeCount = 1;
          this.flingVelocity = 0;
          return;
        }
      }

      currentV *= friction;

      // Stop once velocity drops below threshold and sub-line remainder is spent
      if (currentV < 0.05 && subLineAccumulator < 0.5) {
        this.stopCoasting();
      }
    }, intervalMs);

    this.coastTimer.unref?.();
  }

  private startCoastingSidebar(compositor: any, dir: number, velocity: number, swipeCount = 1): void {
    this.isCoasting = true;
    this.coastStartTime = Date.now();
    let friction = 0.88;
    if (swipeCount === 2) friction = 0.94;
    else if (swipeCount === 3) friction = 0.980;
    else if (swipeCount >= 4) friction = 0.989;

    const intervalMs = this.options.decayIntervalMs ?? 20;
    let currentV = velocity;
    let subLineAccumulator = 0;

    this.coastTimer = setInterval(() => {
      subLineAccumulator += currentV;
      const step = Math.floor(subLineAccumulator);

      if (step > 0) {
        subLineAccumulator -= step;

        const prevScrollTop = compositor.getScrollTop?.() ?? 0;
        compositor.scrollBy(dir * step);
        const newScrollTop = compositor.getScrollTop?.() ?? 0;

        if (prevScrollTop === newScrollTop) {
          this.stopCoasting();
          this.swipeCount = 1;
          this.flingVelocity = 0;
          return;
        }
      }

      currentV *= friction;

      if (currentV < 0.05 && subLineAccumulator < 0.5) {
        this.stopCoasting();
      }
    }, intervalMs);

    this.coastTimer.unref?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopCoasting();
    this.cancelHoldTimer();

    if (this.unsubscribeInput) {
      try {
        this.unsubscribeInput();
      } catch {
        // ignore
      }
      this.unsubscribeInput = null;
    }

    if (this.originalRouteWheel && this.tui) {
      this.tui.routeWheel = this.originalRouteWheel;
      this.originalRouteWheel = null;
    }

    if (this.originalHandleMouseEvent && this.tui) {
      this.tui.handleMouseEvent = this.originalHandleMouseEvent;
      this.originalHandleMouseEvent = null;
    }

    if (this.originalViewportInput && this.tui) {
      this.tui.handleViewportInput = this.originalViewportInput;
      this.originalViewportInput = null;
    }
  }
}
