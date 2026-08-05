/**
 * The opponent, driven by the network instead of by input or the AI.
 *
 * Two things arrive from the other peer and are handled very differently:
 *
 * - **Pose**, continuously and cheaply. Each peer owns its own avatar
 *   absolutely — the two characters never collide or contend — so there is
 *   nothing to arbitrate, only to smooth. Position updates land at a fraction
 *   of the simulation rate, so the gap is closed over time rather than
 *   teleported, and `velocity` is written too because the locomotion blend
 *   reads it to choose a jog clip.
 *
 * - **Launches**, rarely and exactly. A strike is authoritative: the sender
 *   already rolled its aim error and picked its clip, so the ball state is
 *   copied verbatim and fast-forwarded for transit. This is what keeps the two
 *   simulations converged without lockstep.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { applyStrike, type MoveMessage, type StrikeMessage } from "./protocol";
import type { BallState } from "../ball";

/** The part of a Character this needs. Character satisfies it structurally. */
export interface RemoteAvatar {
  position: Vector3;
  velocity: Vector3;
  /** True while an action clip owns the pose; smoothing must not fight it. */
  readonly busy: boolean;
}

/**
 * Beyond this gap the pose is snapped rather than run to. A player who
 * reconnects, or whose packets stalled, should reappear where they are instead
 * of sprinting across the court.
 */
export const SNAP_DISTANCE = 3.0;
/** Seconds to close a normal gap. Long enough to look like running. */
export const CONVERGE_TIME = 0.12;
/** Ceiling on smoothing speed (m/s), so a correction never outruns a sprint. */
export const MAX_CORRECTION_SPEED = 9;
/**
 * Within this distance the pose is taken exactly and the avatar stops.
 *
 * Convergence toward a target is geometric, so it approaches without ever
 * arriving — which would leave a permanent residual velocity and a locomotion
 * blend that jogs on the spot forever. A centimetre is far below anything
 * visible and makes arrival an actual event.
 */
export const ARRIVE_EPSILON = 0.01;

export class RemotePlayer {
  /** Latest pose the peer reported, or null before the first message. */
  private target: { x: number; z: number; moveX: number; moveZ: number } | null = null;
  /** Ticks since a message last arrived, for staleness reporting. */
  private silentTicks = 0;

  /** Record an incoming pose. Cheap and lossy: only the newest one matters. */
  onMove(msg: MoveMessage): void {
    this.target = { x: msg.pos.x, z: msg.pos.z, moveX: msg.moveX, moveZ: msg.moveZ };
    this.silentTicks = 0;
  }

  /**
   * Apply an authoritative launch to the ball. `localTick` is the receiver's
   * current tick; the difference from the message's own tick is the transit
   * time to fast-forward through.
   */
  onStrike(msg: StrikeMessage, ball: BallState, localTick: number): void {
    applyStrike(ball, msg, localTick);
    this.silentTicks = 0;
  }

  /** How long the peer has been quiet, in seconds. */
  silentFor(): number {
    return this.silentTicks / 60;
  }

  hasPose(): boolean {
    return this.target !== null;
  }

  /**
   * Move the avatar toward the reported pose for one simulation step.
   *
   * Skipped entirely while an action clip is playing: a strike animation moves
   * the character itself (the lunge onto the ball), and correcting position
   * underneath it would drag the contact away from the limb.
   */
  update(dt: number, avatar: RemoteAvatar): void {
    this.silentTicks++;
    const target = this.target;
    if (!target) return;
    if (avatar.busy) {
      avatar.velocity.setAll(0);
      return;
    }

    const p = avatar.position;
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const gap = Math.hypot(dx, dz);

    if (gap > SNAP_DISTANCE) {
      p.x = target.x;
      p.z = target.z;
      avatar.velocity.setAll(0);
      return;
    }
    if (gap < ARRIVE_EPSILON) {
      // Arrived: take the pose exactly and stop, so the locomotion blend can
      // settle to idle instead of jogging on the spot against a residual gap.
      p.x = target.x;
      p.z = target.z;
      avatar.velocity.setAll(0);
      return;
    }

    const speed = Math.min(gap / CONVERGE_TIME, MAX_CORRECTION_SPEED);
    const step = Math.min(gap, speed * dt);
    p.x += (dx / gap) * step;
    p.z += (dz / gap) * step;
    // The locomotion blend reads velocity, so the opponent jogs rather than
    // sliding. It is the correction's direction, not the peer's raw stick.
    avatar.velocity.set((dx / gap) * speed, 0, (dz / gap) * speed);
  }
}
