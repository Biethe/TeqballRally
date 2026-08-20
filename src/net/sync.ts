/**
 * How old an arriving snapshot already is, measured in simulation ticks.
 *
 * Every snapshot is stamped with the sender's tick, and both clocks advance
 * once per fixed step — but they started at different moments, so the raw
 * difference `localTick - msg.tick` is the true age plus an unknown constant
 * offset. The offset never matters on its own: what playback needs is how the
 * age *changes*, and the running minimum of the samples is exactly the
 * smallest age the route can produce. Subtracting it leaves the transport
 * delay alone, self-calibrated, with no handshake.
 *
 * The floor is released a sliver per sample because a device that drops its
 * accumulator remainder falls permanently behind wall time; the samples then
 * grow for reasons that are not transport, and a frozen floor would read the
 * drift as latency forever.
 *
 * Pure on purpose, like `reconcile`: two peers must agree about time without
 * sharing a clock, and that is testable without a socket in the room.
 */

import { MAX_CATCHUP_TICKS } from "./protocol";

/**
 * Floor release per sample, in ticks.
 *
 * Sized against the worst realistic drift: a step budget of four 60 Hz steps
 * per frame loses at most a step every frame a device is saturating, and a
 * device saturating for a whole second at 30 snapshots per second accrues far
 * more than this releases — but saturating devices are not the ones playing
 * smooth online matches, and the clamp below bounds any error the release
 * itself makes.
 */
export const AGE_BASE_RELEASE = 0.05;

export class TickAge {
  private base: number | null = null;

  /**
   * Feed one `localTick - msg.tick` sample and get the estimated age of that
   * snapshot in ticks, clamped to what a fast-forward may ever spend.
   */
  observe(sample: number): number {
    if (!Number.isFinite(sample)) return 0;
    if (this.base === null) {
      this.base = sample;
      return 0;
    }
    if (sample < this.base) {
      // A shorter route (or a corrected clock) is real immediately.
      this.base = sample;
    } else {
      this.base += AGE_BASE_RELEASE;
    }
    const age = sample - this.base;
    if (age < 0) return 0;
    return Math.min(age, MAX_CATCHUP_TICKS);
  }

  /** Forget everything; a new match keeps the estimator, a reconnect need not. */
  reset(): void {
    this.base = null;
  }
}
