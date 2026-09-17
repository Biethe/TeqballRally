/**
 * What a device is actually doing during a match, on its own screen.
 *
 * An online match is only as good as the slower half of it, and the ways it
 * goes wrong are invisible from either screen: a host that draws fifteen
 * frames a second runs the match itself slower than real time, and its guest
 * sees chaos without either player being able to say why. Two emulators on one
 * laptop made exactly that look like a netcode bug for a whole round of fixes.
 * These numbers are what would have said so in a glance.
 *
 * The meter is pure — timestamps and counts in, rates out — so the arithmetic
 * is testable; the overlay is a few lines of DOM on top of it.
 */

interface Sample {
  at: number;
  frames: number;
  simTicks: number;
  dropped: number;
  /** Milliseconds of this frame spent stepping the match. */
  simMs: number;
  /** Milliseconds of this frame spent in Babylon's render call. */
  renderMs: number;
}

/** Rolling rates over the last few seconds of wall time. */
export class RateMeter {
  private samples: Sample[] = [];

  constructor(private readonly windowSeconds = 3) {}

  /**
   * One rendered frame at wall time `at` (seconds): the simulation ticks it
   * ran and the simulation time it had to throw away.
   */
  record(at: number, simTicks: number, droppedSeconds: number, simMs = 0, renderMs = 0): void {
    this.samples.push({ at, frames: 1, simTicks, dropped: droppedSeconds, simMs, renderMs });
    const oldest = at - this.windowSeconds;
    while (this.samples.length > 2 && this.samples[0].at < oldest) this.samples.shift();
  }

  private span(): number {
    if (this.samples.length < 2) return 0;
    return this.samples[this.samples.length - 1].at - this.samples[0].at;
  }

  /** Sum over every sample but the first, which only marks where the span starts. */
  private sum(key: "frames" | "simTicks" | "dropped" | "simMs" | "renderMs"): number {
    let total = 0;
    for (let i = 1; i < this.samples.length; i++) total += this.samples[i][key];
    return total;
  }

  get fps(): number {
    const s = this.span();
    return s > 0 ? this.sum("frames") / s : 0;
  }

  get simTicksPerSecond(): number {
    const s = this.span();
    return s > 0 ? this.sum("simTicks") / s : 0;
  }

  /** Simulation seconds thrown away per wall second. */
  get droppedPerSecond(): number {
    const s = this.span();
    return s > 0 ? this.sum("dropped") / s : 0;
  }

  /**
   * Where a frame's time goes: stepping the match, and Babylon's render call.
   * Whatever is left of the frame after both is the GPU and the browser. On a
   * slow phone it is the difference between "our code is too heavy" and "the
   * scene is too heavy", which need opposite fixes.
   */
  get simMsPerFrame(): number {
    const n = this.samples.length - 1;
    return n > 0 ? this.sum("simMs") / n : 0;
  }

  get renderMsPerFrame(): number {
    const n = this.samples.length - 1;
    return n > 0 ? this.sum("renderMs") / n : 0;
  }

  get ticksPerFrame(): number {
    const n = this.samples.length - 1;
    return n > 0 ? this.sum("simTicks") / n : 0;
  }

  reset(): void {
    this.samples = [];
  }
}

/** The corner readout. Created hidden; shown only when the setting is on. */
export class NetStatsOverlay {
  private readonly el: HTMLDivElement;
  private shownAt = 0;

  constructor(root: HTMLElement) {
    this.el = document.createElement("div");
    this.el.id = "net-stats";
    this.el.hidden = true;
    root.appendChild(this.el);
  }

  /**
   * Write the lines, at most four times a second: rewriting text every frame
   * costs layout on exactly the devices this exists to diagnose.
   */
  show(lines: string[] | null, now: number): void {
    if (lines === null) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    if (now - this.shownAt < 0.25) return;
    this.shownAt = now;
    this.el.textContent = lines.join("\n");
  }
}
