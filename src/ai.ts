import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { predict, sampleFlight, type Prediction } from "./ball";
import type { MatchController, MatchEvent } from "./match";
import { AI_REACH, COURT, GROUND_Y, MAX_TOUCHES, SPAWN } from "./config";

export interface AIDifficulty {
  /** Fraction of the AI character's own court speed it actually uses. */
  speed: number;
  aimError: number;
  reactionTime: number;
  whiffChance: number;
  /** Chance per possession the AI starts a control-touch sequence. */
  popChance: number;
  /** Number of control touches to attempt when that sequence starts. */
  maxPopTouches: number;
}

// Difficulty presets. Friendly games let the player pick; competitions use
// "normal" and step up to "hard" for finals / the last league round.
export const DIFFICULTIES = {
  easy: {
    speed: 0.55,
    aimError: 0.65,
    reactionTime: 0.32,
    whiffChance: 0.24,
    popChance: 0.28,
    maxPopTouches: 1,
  },
  // Normal and hard still make human-looking mistakes through their aim and
  // reaction delay, but they should not give away a routine reception simply
  // because they were walking at an artificially low cruise speed.
  normal: {
    speed: 0.78,
    aimError: 0.45,
    reactionTime: 0.18,
    whiffChance: 0.04,
    popChance: 0.5,
    maxPopTouches: 1,
  },
  hard: {
    speed: 0.94,
    aimError: 0.22,
    reactionTime: 0.08,
    whiffChance: 0.01,
    popChance: 0.9,
    maxPopTouches: 2,
  },
} satisfies Record<string, AIDifficulty>;
export type DifficultyLevel = keyof typeof DIFFICULTIES;

export const DIFFICULTY: AIDifficulty = DIFFICULTIES.normal;

/**
 * AI opponent: predicts the ball's path with the same physics step, runs to an
 * interception point after the bounce on its half, and strikes with some aim
 * error. Occasionally "whiffs" (stands off the intercept) so rallies are winnable.
 */
export class AIController {
  private prediction: Prediction | null = null;
  private repredictIn = 0;
  private reaction = 0;
  private whiffOffset = 0;
  private rolledWhiff = false;
  /** Planned control touches for the current AI possession. */
  private plannedPops = 0;
  /** Let the ball drop below waist height before returning (shows low kicks). */
  private wantLow = false;
  /** Small lateral offset at the intercept so receptions aren't always dead-centre. */
  private jitterZ = 0;
  private home = new Vector3(SPAWN.x, GROUND_Y, SPAWN.z);
  /** Last viable run target, retained briefly across a reprediction gap. */
  private chaseSpot: Vector3 | null = null;
  private chaseGrace = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private match: MatchController, private diff: AIDifficulty = DIFFICULTY) {
    // `lastHitter` deliberately survives the between-point state, so it
    // cannot by itself tell us that a new player serve began.  Reset the
    // possession choice from the authoritative launch events instead.  In
    // particular this prevents one intentional whiff from offsetting every
    // later reception after that point has already ended.
    this.unsubscribe = this.match.subscribe((event) => this.onMatchEvent(event));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private onMatchEvent(event: MatchEvent): void {
    const playerSentBall =
      (event.type === "serve-committed" && event.side === "player") ||
      (event.type === "touch-committed" && event.side === "player" && event.action === "strike");
    if (playerSentBall) this.resetInboundPlan();
  }

  notifyNewRally(): void {
    this.resetInboundPlan();
  }

  /** Clear state that belongs to one incoming player ball, never a whole match. */
  private resetInboundPlan(): void {
    this.prediction = null;
    this.repredictIn = 0;
    this.rolledWhiff = false;
    this.whiffOffset = 0;
    this.plannedPops = 0;
    this.wantLow = false;
    this.jitterZ = 0;
    this.dropSpot = null;
    this.dropRecalcIn = 0;
    this.chaseSpot = null;
    this.chaseGrace = 0;
    this.reaction = this.diff.reactionTime;
  }

  update(dt: number): void {
    const m = this.match;
    const ai = m.chars.ai;
    if (ai.busy) {
      ai.velocity.setAll(0);
      return;
    }

    const incoming = m.lastHitter === "player" || m.strikeableSide === "ai";
    // Character-specific top speed, throttled by the difficulty fraction.
    // Receptions get a modest urgency boost: anticipation should make the
    // normal CPU reach a well-placed ball, rather than turn it into a dummy.
    const cruiseSpeed = ai.def.speed * this.diff.speed;
    const speed = Math.min(ai.def.speed, cruiseSpeed * 1.1);
    if (!incoming) {
      this.prediction = null;
      this.rolledWhiff = false;
      this.dropSpot = null;
      this.chaseSpot = null;
      this.chaseGrace = 0;
      ai.moveToward(this.home, cruiseSpeed * 0.8, dt);
      return;
    }

    this.repredictIn -= dt;
    if (this.repredictIn <= 0 || !this.prediction) {
      this.prediction = predict(m.ball.state, 3);
      this.repredictIn = 0.12;
    }

    if (
      !this.rolledWhiff &&
      (this.prediction.tableBounce?.side === "ai" || m.strikeableSide === "ai")
    ) this.rollPossessionChoice();

    const intercept = this.pickIntercept(dt);
    if (intercept) {
      intercept.z += this.whiffOffset + this.jitterZ;
      this.chaseSpot = intercept.clone();
      this.chaseGrace = 0.3;
      ai.moveToward(intercept, speed, dt);
    } else if (this.chaseSpot && this.chaseGrace > 0) {
      // A prediction can be empty for one refresh immediately around a table
      // contact.  Keep running to the last sound target instead of visibly
      // abandoning a ball that is still on its way to the AI half.
      this.chaseGrace -= dt;
      ai.moveToward(this.chaseSpot, speed, dt);
    } else {
      ai.moveToward(this.home, cruiseSpeed * 0.8, dt);
    }

    // Touch when allowed, in reach, and past the reaction delay.
    if (m.strikeableSide === "ai") {
      this.reaction -= dt;
      const chest = ai.position.add(new Vector3(0, ai.height * 0.55, 0));
      const d = Vector3.Distance(chest, m.ball.state.pos);
      if (d <= AI_REACH && this.reaction <= 0 && this.whiffOffset === 0) {
        const canBuildAttack =
          this.plannedPops > m.touchCount &&
          (m.touchCount === 0 || m.ball.state.vel.y < 0);
        if (canBuildAttack) {
          // Build the attack with as many legal control touches as this
          // difficulty selected, then finish with a return. A queued touch
          // still counts against neither side until MatchController commits
          // it, so the touchCount comparison naturally waits for the ball to
          // come back down before asking for the next one.
          const popX = (Math.random() - 0.5) * 0.8;
          const popZ = (Math.random() - 0.5) * 1.4;
          if (m.tryControlTouch("ai", popX, popZ)) this.reaction = 0.25;
        } else if (m.touchCount === 0 || m.ball.state.vel.y < 0) {
          // After a pop, wait for the ball to come back down before kicking.
          // On "low" possessions, let a direct return drop toward the feet first.
          const relH = (m.ball.state.pos.y - GROUND_Y) / ai.height;
          // Keep the occasional low return, but only while the ball is still
          // comfortably high and close.  The older condition could wait past
          // the only playable window, which read as the hard CPU giving up.
          const holdForLow =
            this.wantLow &&
            m.touchCount === 0 &&
            relH > 0.72 &&
            m.ball.state.pos.x > COURT.minX &&
            d < AI_REACH * 0.72;
          if (!holdForLow) {
            const aimFwd = Math.random() * 2 - 1;
            const aimLat = (Math.random() * 2 - 1) * (1 - this.diff.aimError * 0.4);
            if (m.tryStrike("ai", aimFwd, aimLat)) {
              this.notifyNewRally();
            }
          }
        }
      }
    }
  }

  /** Roll variety once for this inbound ball, never once per reprediction. */
  private rollPossessionChoice(): void {
    this.rolledWhiff = true;
    this.whiffOffset = Math.random() < this.diff.whiffChance ? 1.15 : 0;
    const maxPops = Math.max(0, Math.min(MAX_TOUCHES - 1, Math.floor(this.diff.maxPopTouches)));
    this.plannedPops = Math.random() < this.diff.popChance ? maxPops : 0;
    this.wantLow = Math.random() < 0.16;
    // Enough texture to keep the AI from parking on a perfect rail, but not
    // enough to turn a normal-difficulty reception into an accidental whiff.
    this.jitterZ = (Math.random() - 0.5) * 0.42;
    this.reaction = this.diff.reactionTime;
  }

  /** Cached drop point while in possession (recomputed on a short cadence). */
  private dropSpot: Vector3 | null = null;
  private dropRecalcIn = 0;

  /** First predicted point after the bounce where the ball is at playable height off the table. */
  private pickIntercept(dt: number): Vector3 | null {
    const m = this.match;
    // Ball already in possession (it bounced on our half, or we popped it up):
    // run to where it will DROP into playing height, not to its live shadow —
    // chasing the shadow sprinted the AI at the net right after a hard bounce,
    // then back-pedalled it when the ball flew overhead (reads as aimless).
    // The post-bounce reprediction has no further table bounce, so the normal
    // intercept below would vanish and walk the AI home mid-receive.
    if (m.strikeableSide === "ai") {
      this.dropRecalcIn -= dt;
      if (this.dropRecalcIn <= 0 || !this.dropSpot) {
        this.dropRecalcIn = 0.12;
        this.dropSpot = null;
        const flight = sampleFlight(m.ball.state, 1.6);
        this.dropSpot = this.pickDescendingDrop(flight, m.ball.state.pos.y);
      }
      if (this.dropSpot) return this.dropSpot.clone();
      // No drop point (ball hovering in reach right now): stand under the ball.
      const b = m.ball.state.pos;
      return new Vector3(
        Math.max(COURT.minX, Math.min(COURT.maxX, b.x)),
        GROUND_Y,
        Math.max(-COURT.maxZ, Math.min(COURT.maxZ, b.z))
      );
    }
    const p = this.prediction;
    if (!p || !p.tableBounce || p.tableBounce.side !== "ai") return null;
    // Plan the *descending* reception before the bounce. The old code chose
    // the first low sample immediately after the bounce, often while the ball
    // was still rising; AI would sprint toward the table then reverse itself.
    const afterBounceY = p.tableBounce.pos.y;
    const planned = this.pickDescendingDrop(p.samples, afterBounceY);
    if (planned) return planned;
    // Fallback: hover just behind the predicted bounce.
    const b = p.tableBounce.pos;
    return new Vector3(Math.max(COURT.minX, b.x + 1.2), GROUND_Y, b.z);
  }

  /**
   * Select the descending, chest-height part of a flight rather than its
   * rising shadow. This is used both while the ball approaches the table and
   * after the AI owns the bounce, so the run remains continuous across it.
   */
  private pickDescendingDrop(
    samples: Array<{ pos: Vector3; grounded?: boolean }>,
    initialY: number
  ): Vector3 | null {
    const ai = this.match.chars.ai;
    const idealHeight = ai.height * 0.55;
    let prevY = initialY;
    let best: { pos: Vector3; cost: number } | null = null;
    for (const s of samples) {
      if (s.grounded) break;
      const h = s.pos.y - GROUND_Y;
      const descending = s.pos.y <= prevY + 0.002;
      prevY = s.pos.y;
      const offTable = s.pos.x > COURT.minX || Math.abs(s.pos.z) > 0.95;
      if (!descending || !offTable || s.pos.x <= 0 || h < 0.28 || h > 1.22) continue;
      // Prefer a natural chest/foot reception height. A tiny forward bias
      // keeps the target from jumping to a much later, lower sample.
      const cost = Math.abs(h - idealHeight);
      if (!best || cost < best.cost) best = { pos: s.pos, cost };
    }
    if (!best) return null;
    return new Vector3(
      Math.max(COURT.minX, Math.min(COURT.maxX, best.pos.x)),
      GROUND_Y,
      Math.max(-COURT.maxZ, Math.min(COURT.maxZ, best.pos.z))
    );
  }
}
