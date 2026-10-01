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
  private originalRouteWheel: ((event: any) => void) | null = null;
  private unsubscribeInput: (() => void) | null = null;
  private coastTimer: ReturnType<typeof setInterval> | null = null;
  private lastTime = 0;
  private lastDir = 0;
  private speedAccumulator = 1;
  private disposed = false;
  private getCompositor?: () => any;

  constructor(tui: any, options: MomentumOptions = {}, getCompositor?: () => any) {
    this.tui = tui;
    this.options = {
      enabled: options.enabled ?? true,
      baseSpeed: options.baseSpeed ?? 1,
      maxSpeed: options.maxSpeed ?? 30,
      decayIntervalMs: options.decayIntervalMs ?? 16,
      friction: options.friction ?? 0.86,
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

    this.tui.routeWheel = function (event: any) {
      if (self.disposed || !self.options.enabled) {
        return origRouteWheel.call(this, event);
      }
      return self.handleWheel(this, origRouteWheel, event);
    };

    if (typeof this.tui.addInputListener === "function") {
      const unsub = this.tui.addInputListener((_data: string) => {
        // Any key press or input immediately stops active momentum coasting
        self.stopCoasting();
      });
      this.unsubscribeInput = typeof unsub === "function" ? unsub : null;
    }
  }

  setBaseSpeed(speed: number): void {
    this.options.baseSpeed = Math.max(1, speed);
    this.speedAccumulator = this.options.baseSpeed;
  }

  setCompositor(getCompositor: () => any): void {
    this.getCompositor = getCompositor;
  }

  setEnabled(enabled: boolean): void {
    this.options.enabled = enabled;
    if (!enabled) {
      this.stopCoasting();
    }
  }

  stopCoasting(): void {
    if (this.coastTimer) {
      clearInterval(this.coastTimer);
      this.coastTimer = null;
    }
  }

  private handleWheel(tuiInstance: any, origRouteWheel: (event: any) => void, event: any): void {
    this.stopCoasting();

    const now = Date.now();
    const dt = now - this.lastTime;
    this.lastTime = now;

    const dir = (event?.direction ?? 0) < 0 ? -1 : 1;

    if (dir !== this.lastDir || dt > 220) {
      // Slow or reversed scrolling stays strictly at base speed
      this.speedAccumulator = this.options.baseSpeed;
    } else if (dt < 45) {
      // Fast flick: high acceleration to quickly traverse long distances
      this.speedAccumulator = Math.min(this.options.maxSpeed, this.speedAccumulator * 1.45 + 1.2);
    } else if (dt < 80) {
      // Brisk scrolling: moderate, controlled acceleration
      this.speedAccumulator = Math.min(10, this.speedAccumulator * 1.15 + 0.3);
    } else if (dt < 140) {
      // Medium scrolling: gentle increment capped at 4 lines (no runaway speed)
      this.speedAccumulator = Math.min(4, this.speedAccumulator * 1.06 + 0.15);
    } else {
      // Slow-medium scrolling: stays right near base speed
      this.speedAccumulator = Math.min(2, this.speedAccumulator * 1.02 + 0.05);
    }
    this.lastDir = dir;

    const effectiveSpeed = Math.max(1, Math.round(this.speedAccumulator));

    // If mouse cursor is over the sidebar columns, scroll the sidebar instead of the main viewport
    const compositor = this.getCompositor?.();
    const sepCol = compositor?.getSeparatorColumn?.() ?? -1;
    const isOverSidebar = compositor && typeof event?.x === "number" && sepCol > 0 && event.x >= sepCol;

    if (isOverSidebar) {
      compositor.scrollBy(dir * effectiveSpeed);
      if (effectiveSpeed >= 6) {
        this.startCoastingSidebar(compositor, dir, effectiveSpeed);
      }
      return;
    }

    const prevWheelLines = tuiInstance.wheelScrollLines;
    try {
      tuiInstance.wheelScrollLines = effectiveSpeed;
      origRouteWheel.call(tuiInstance, event);
    } finally {
      tuiInstance.wheelScrollLines = prevWheelLines;
    }

    // Inertial coasting only activates for high-speed flick gestures (effectiveSpeed >= 6)
    // Medium scrolling stops cleanly without unexpected coasting.
    if (effectiveSpeed >= 6) {
      this.startCoasting(tuiInstance, dir, effectiveSpeed);
    }
  }

  private startCoasting(tuiInstance: any, dir: number, initialSpeed: number): void {
    let velocity = initialSpeed * 0.65;
    this.coastTimer = setInterval(() => {
      const step = Math.round(velocity);
      if (step < 1) {
        this.stopCoasting();
        return;
      }

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
        return;
      }

      velocity *= this.options.friction;
    }, this.options.decayIntervalMs);

    this.coastTimer.unref?.();
  }

  private startCoastingSidebar(compositor: any, dir: number, initialSpeed: number): void {
    let velocity = initialSpeed * 0.65;
    this.coastTimer = setInterval(() => {
      const step = Math.round(velocity);
      if (step < 1) {
        this.stopCoasting();
        return;
      }

      const prevScrollTop = compositor.getScrollTop?.() ?? 0;
      compositor.scrollBy(dir * step);
      const newScrollTop = compositor.getScrollTop?.() ?? 0;

      if (prevScrollTop === newScrollTop) {
        this.stopCoasting();
        return;
      }

      velocity *= this.options.friction;
    }, this.options.decayIntervalMs);

    this.coastTimer.unref?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopCoasting();

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
  }
}
