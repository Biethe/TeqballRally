import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
  BALL_RADIUS,
  GRAVITY,
  GROUND_Y,
  TABLE,
  tableSurfaceY,
} from "./config";
import { TABLE_BOUNCE_TANGENTIAL, heightAtNet, solveLaunch } from "./ball";
import type { FlightSample } from "./ball";
import type { InteractionDims, InteractionShape } from "./config";

/**
 * Geometry for animation-derived interaction volumes.
 *
 * An interaction volume is the region of space around a clip's striking limb,
 * measured from the actual mocap pose at the contact frame, where that clip can
 * plausibly touch the ball. It answers one question — "can this animation take
 * the ball here?" — and deliberately answers nothing else: whether the player
 * can *reach* the volume in time is decided later, by movement.
 *
 * Everything here is pure and free of scene machinery, for the same reason
 * `stepBall` is: candidate evaluation has to be identical on both peers of a
 * networked match and testable without Babylon running.
 */

/** A volume measured in a character's root-local space (rig unrotated at origin). */
export interface InteractionVolumeDef {
  clip: string;
  part: string;
  shape: InteractionShape;
  /**
   * Centre of the volume relative to the character's foot point, in the space
   * the rig occupies before any runtime yaw — the same space
   * `measureContactOffsets` records striking-limb positions in. Includes any
   * tuning offset from `INTERACTION_VOLUME_OVERRIDES`.
   */
  center: [number, number, number];
  /**
   * The centre exactly as the contact pose measured it, before tuning
   * offsets — the baseline the editor's exported `d` deltas are computed
   * against.
   */
  measuredCenter: [number, number, number];
  /**
   * Orientation of the volume in that same root-local space, taken from the
   * limb bone's world rotation while posed at the contact frame.
   */
  quat: [number, number, number, number];
  dims: InteractionDims;
}

/** A volume placed into the world for one character pose. */
export interface WorldVolume {
  def: InteractionVolumeDef;
  /** World-space centre. */
  center: Vector3;
  /** World-space orientation (root yaw applied over the measured local one). */
  rotation: Quaternion;
}

/**
 * Place a measured volume into the world.
 *
 * `yaw` is the *effective* clip yaw — root yaw minus the current action offset
 * plus the clip's own offset — exactly what `clipContactPoint` rotates its
 * stored offsets by. Passing the same yaw therefore keeps a volume and the
 * legacy contact point in agreement, whichever way the character is turned.
 */
export function volumeToWorld(def: InteractionVolumeDef, rootPos: Vector3, yaw: number): WorldVolume {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const [cx, cy, cz] = def.center;
  const center = new Vector3(
    rootPos.x + cx * cos + cz * sin,
    rootPos.y + cy,
    rootPos.z - cx * sin + cz * cos
  );
  const yawQ = Quaternion.RotationAxis(new Vector3(0, 1, 0), yaw);
  const local = new Quaternion(def.quat[0], def.quat[1], def.quat[2], def.quat[3]);
  return { def, center, rotation: quatMultiply(yawQ, local) };
}

/** Hamilton product of two unit quaternions: apply `b` first, then `a`. */
function quatMultiply(a: Quaternion, b: Quaternion): Quaternion {
  return new Quaternion(
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  );
}

/** Conjugate of a unit quaternion — its inverse rotation. */
function quatConjugate(q: Quaternion): Quaternion {
  return new Quaternion(-q.x, -q.y, -q.z, q.w);
}

/** Rotate `v` by unit quaternion `q` without touching a matrix. */
function rotated(
  vx: number,
  vy: number,
  vz: number,
  q: Quaternion
): { x: number; y: number; z: number } {
  // t = 2 * (q.xyz × v); v' = v + q.w·t + q.xyz × t
  const tx = 2 * (q.y * vz - q.z * vy);
  const ty = 2 * (q.z * vx - q.x * vz);
  const tz = 2 * (q.x * vy - q.y * vx);
  return {
    x: vx + q.w * tx + (q.y * tz - q.z * ty),
    y: vy + q.w * ty + (q.z * tx - q.x * tz),
    z: vz + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/**
 * Distance from a point to a placed volume, in metres. Zero or negative means
 * the point is inside — the magnitude is how deep. This is the whole
 * intersection test: expanding the comparison by the ball radius turns "point
 * inside volume" into "ball sphere overlaps volume".
 */
export function distanceToVolume(vol: WorldVolume, p: Vector3): number {
  const inv = quatConjugate(vol.rotation);
  const d = rotated(p.x - vol.center.x, p.y - vol.center.y, p.z - vol.center.z, inv);
  const { dims } = vol.def;
  if (vol.def.shape === "sphere") {
    return Math.hypot(d.x, d.y, d.z) - (dims.r ?? 0.1);
  }
  if (vol.def.shape === "capsule") {
    const half = Math.max(0, (dims.length ?? 0.1) / 2);
    const t = Math.max(-half, Math.min(half, d.y));
    return Math.hypot(d.x, d.y - t, d.z) - (dims.r ?? 0.05);
  }
  const hx = dims.hx ?? 0.1;
  const hy = dims.hy ?? 0.1;
  const hz = dims.hz ?? 0.1;
  const qx = Math.max(-hx, Math.min(hx, d.x));
  const qy = Math.max(-hy, Math.min(hy, d.y));
  const qz = Math.max(-hz, Math.min(hz, d.z));
  return Math.hypot(d.x - qx, d.y - qy, d.z - qz);
}

/** Whether the ball sphere centred at `p` overlaps the volume. */
export function sphereOverlaps(vol: WorldVolume, p: Vector3, ballRadius: number): boolean {
  return distanceToVolume(vol, p) <= ballRadius;
}

/** Result of checking a whole incoming trajectory against one volume. */
export interface VolumeHit {
  /** True when the ball entered the volume at `t`; false means closest pass. */
  hit: boolean;
  /** Time of the entry sample (hit) or of the closest approach (miss). */
  t: number;
  /** Ball position at that moment. */
  pos: Vector3;
  /**
   * Signed clearance at `t`: negative while the ball centre is inside the
   * expanded volume. How far off a miss was, and how deep a hit sits, is what
   * candidate scoring reads later.
   */
  clearance: number;
}

/**
 * Test a sampled flight against a placed volume.
 *
 * Samples are read in order and the **first** one inside wins, so a lofted
 * arc that crosses a height twice can only ever be taken on the way it
 * actually passes through the volume — height alone never selects anything.
 *
 * Grounded samples are skipped outright: a planner must never schedule a
 * contact on a ball that has already touched down, exactly as `planContact`
 * breaks on `grounded` today.
 */
export function trajectoryVsVolume(
  vol: WorldVolume,
  flight: FlightSample[],
  ballRadius: number
): VolumeHit {
  let bestT = flight.length > 0 ? flight[0].t : 0;
  let bestPos = flight.length > 0 ? flight[0].pos.clone() : new Vector3();
  let bestClearance = Infinity;
  for (const s of flight) {
    if (s.grounded) break;
    const clearance = distanceToVolume(vol, s.pos) - ballRadius;
    if (clearance < bestClearance) {
      bestClearance = clearance;
      bestT = s.t;
      bestPos = s.pos.clone();
    }
    if (clearance <= 0) {
      return { hit: true, t: s.t, pos: s.pos.clone(), clearance };
    }
  }
  return { hit: false, t: bestT, pos: bestPos, clearance: bestClearance };
}

/** The volume's local basis vectors in world space — X red, Y green, Z blue. */
export function volumeAxes(vol: WorldVolume): [Vector3, Vector3, Vector3] {
  const ax = rotated(1, 0, 0, vol.rotation);
  const ay = rotated(0, 1, 0, vol.rotation);
  const az = rotated(0, 0, 1, vol.rotation);
  return [new Vector3(ax.x, ax.y, ax.z), new Vector3(ay.x, ay.y, ay.z), new Vector3(az.x, az.y, az.z)];
}

/** A strike solved to arrive at a volume the honest way: over the net, one table bounce first. */
export interface BounceStrike {
  /** Where the strike launches from — possibly raised above `from` to clear the net. */
  pos: Vector3;
  /** Initial velocity from `pos`. */
  vel: Vector3;
  /** Seconds until the table bounce. */
  arrivalT: number;
  /** How long to simulate for the full approach (bounce + a short tail). */
  maxT: number;
}

/**
 * Solve a strike from `from` (opposite half) that clears the net, bounces once
 * on the receiver's table half — the event that opens possession — and then
 * arrives at `target` (an interaction volume's world centre).
 *
 * Leg 2 is solved first: for a candidate post-bounce flight time it computes
 * the velocity that carries the ball from the bounce point to the volume, and
 * inverts the table's reflection (restitution about the dome's actual tilted
 * normal, then the tangential damping) to get the arrival velocity leg 1 must
 * have. Leg 1's flight time then follows from matching that velocity's
 * horizontal part, and a small scan over leg-2 times finds the one where the
 * vertical parts agree too. Candidates whose arc would clip the table on the
 * way in are rejected, so the planned bounce is the bounce that happens.
 *
 * Deterministic, pure, and small enough to only ever run in tooling — but held
 * to the same physics `stepBall` applies, so what the preview draws is what a
 * real strike would do. Returns null when no honest bounce-inclusive flight
 * exists for this geometry (volume beside the table, say); callers fall back
 * to a plain arc.
 */
export function solveBounceArrival(from: Vector3, target: Vector3): BounceStrike | null {
  const V = target;
  const denom = V.x - from.x;
  if (Math.abs(denom) < 0.1) return null;
  const side = Math.sign(V.x || Math.sign(denom));
  const e = 0.82; // TABLE_RESTITUTION

  /** Would this leg-1 arc reach B without clipping the dome on the way? */
  const legClearsDome = (start: Vector3, t1: number, vel: Vector3): boolean => {
    const steps = 12;
    for (let i = 1; i < steps; i++) {
      const t = (t1 * i) / steps;
      const x = start.x + vel.x * t;
      const z = start.z + vel.z * t;
      if (Math.abs(x) > TABLE.halfLen || Math.abs(z) > TABLE.halfWid) continue;
      const y = start.y + vel.y * t - 0.5 * GRAVITY * t * t;
      if (y - BALL_RADIUS <= tableSurfaceY(x) + 0.02) return false;
    }
    return true;
  };

  /**
   * Best velocity handover for one bounce point: scan leg-2 flight times for
   * the one whose initial velocity is leg 1's arrival velocity reflected by
   * the dome, and report how close the vertical parts can get.
   */
  const solveAt = (
    start: Vector3,
    bx: number
  ): { err: number; t1: number; t2: number; B: Vector3 } | null => {
    const frac = (bx - start.x) / denom;
    const bz = Math.max(
      -(TABLE.halfWid - 0.05),
      Math.min(TABLE.halfWid - 0.05, start.z + (V.z - start.z) * frac)
    );
    const B = new Vector3(bx, tableSurfaceY(bx) + BALL_RADIUS, bz);
    const horizBV = Math.hypot(V.x - B.x, V.z - B.z);
    const horizFB = Math.hypot(B.x - start.x, B.z - start.z);
    if (horizBV < 0.05 || horizFB < 0.05) return null;
    // The dome's real surface normal at the bounce point — the reflection the
    // sim will apply, so the inverse below has to undo exactly it.
    const n = new Vector3(2 * TABLE.curveK * bx, 1, 0).normalize();
    let bestErr = Infinity;
    let bestT2 = 0;
    let bestT1 = 0;
    // The scan reaches well below a second on purpose: the leg that fits
    // between a table bounce and a body-height volume is short and flat, and
    // restricting it to floaty arcs forces the solver into lobs that no striker
    // would hit.
    for (let t2 = 0.08; t2 <= 1.4; t2 += 1 / 120) {
      const v2 = solveLaunch(B, V, t2);
      // Undo the sim's bounce, in reverse order: tangential damping first,
      // then the normal reflection — giving the arrival velocity leg 1 needs.
      const wx = v2.x / TABLE_BOUNCE_TANGENTIAL;
      const wn = wx * n.x + v2.y * n.y; // w·n (n.z is zero over the dome)
      const vInX = wx - ((1 + e) / e) * wn * n.x;
      const vInY = v2.y - ((1 + e) / e) * wn * n.y;
      // Leg 1's arrival velocity is fully determined by its flight time; the
      // horizontal parts fix that time, the vertical part is the residual.
      if (vInX === 0 || Math.sign(vInX) !== Math.sign(B.x - start.x)) continue;
      const t1 = (B.x - start.x) / vInX;
      if (t1 < 0.15 || t1 > 2.2) continue;
      // The ball must be clearly descending onto the dome at B — a grazing
      // arrival is a coin flip with the substep integrator.
      const arrivalVy = (B.y - start.y) / t1 - 0.5 * GRAVITY * t1;
      if (arrivalVy > -0.3) continue;
      // Rank by the miss this residual implies (err × leg-2 time), not by
      // the raw velocity error — a small mismatch over a long float drifts
      // further than a big one over a sharp bounce-to-volume sprint.
      const score = Math.abs(arrivalVy - vInY) * t2;
      if (score >= bestErr) continue;
      const vel = new Vector3(
        (B.x - start.x) / t1,
        (B.y - start.y) / t1 + 0.5 * GRAVITY * t1,
        (B.z - start.z) / t1
      );
      if (!legClearsDome(start, t1, vel)) continue;
      bestErr = score;
      bestT2 = t2;
      bestT1 = t1;
    }
    if (bestT2 === 0) return null;
    return { err: bestErr, t1: bestT1, t2: bestT2, B };
  };

  const start = from.clone();
  for (let attempt = 0; attempt < 8; attempt++) {
    // Several bounce placements along the strike→volume line: which one hands
    // over cleanest depends on the whole geometry, so try a few and keep the
    // best handover.
    let best: { err: number; t1: number; t2: number; B: Vector3 } | null = null;
    for (const f of [0.3, 0.55, 0.8]) {
      const bx = side * Math.min(TABLE.halfLen - 0.05, Math.max(0.15, Math.abs(V.x) * f));
      const r = solveAt(start, bx);
      if (r && (!best || r.err < best.err)) best = r;
    }
    if (!best) return null;
    const vel = solveLaunch(start, best.B, best.t1);
    const atNet = heightAtNet(start, vel);
    if (Number.isFinite(atNet) && atNet < GROUND_Y + TABLE.netTop + 0.12) {
      start.y += 0.15; // lift the strike point until the arc clears the tape
      continue;
    }
    // The launch position goes back with the velocity: clearing a tall net
    // from deep may have raised the strike point, and a caller launching from
    // the original height would fly a different arc than the one solved here.
    return { pos: start.clone(), vel, arrivalT: best.t1, maxT: best.t1 + best.t2 + 0.25 };
  }
  return null;
}
