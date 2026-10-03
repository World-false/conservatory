export interface HeartbeatOptions {
  intervalSeconds: number;
  now(): number;
  tick(): void | Promise<void>;
  onError(error: unknown): void;
  /**
   * While this returns true the heartbeat still runs, but its tick only checks
   * the switch: no agent is woken for as long as the whole conservatory is
   * paused. Time stops, but the clock that could restart it keeps beating.
   */
  isPaused?(): boolean;
}

/**
 * Wakes the supervisor on a fixed wall-clock interval. A tick that is still
 * running when the next one is due is skipped, so a slow round can never
 * stack up behind itself.
 */
export class Heartbeat {
  private readonly options: HeartbeatOptions;
  private handle: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastTick: number | null = null;
  private skipped = 0;
  private pausedSkips = 0;

  constructor(options: HeartbeatOptions) {
    this.options = options;
  }

  start(): void {
    if (this.handle !== null) {
      return;
    }
    const periodMs = this.options.intervalSeconds * 1000;
    this.handle = setInterval(() => {
      void this.runTick();
    }, periodMs);
  }

  stop(): void {
    if (this.handle === null) {
      return;
    }
    clearInterval(this.handle);
    this.handle = null;
  }

  get isRunning(): boolean {
    return this.handle !== null;
  }

  get lastTickAt(): number | null {
    return this.lastTick;
  }

  get skippedTicks(): number {
    return this.skipped;
  }

  /** Beats that woke nobody because the conservatory was paused. */
  get pausedTicks(): number {
    return this.pausedSkips;
  }

  /** Runs one tick now; used by the console's "wake up now" and by tests. */
  async runTick(): Promise<void> {
    if (this.ticking) {
      this.skipped += 1;
      return;
    }
    this.ticking = true;
    this.lastTick = this.options.now();
    try {
      if (this.options.isPaused?.() === true) {
        this.pausedSkips += 1;
        return;
      }
      await this.options.tick();
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.ticking = false;
    }
  }
}
