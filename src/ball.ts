import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { BALL_RADIUS, GRAVITY, GROUND_Y, TABLE, tableSurfaceY } from "./config";

export type Side = "player" | "ai"; // player owns x < 0, ai owns x > 0

export type BallEvent =
  | { type: "table"; side: Side; pos: Vector3 }
  | { type: "net" }
  | { type: "ground"; pos: Vector3 }
  | { type: "side"; pos: Vector3 }
  | { type: "body"; side: Side };

/** Vertical capsule around a character the ball deflects off (never through). */
export interface BodyCollider {
  side: Side;
  /** Character foot point (live reference is fine — read only). */
  base: Vector3;
  height: number;
  radius: number;
}

const BODY_RESTITUTION = 0.45;

export interface BallState {
  pos: Vector3;
  vel: Vector3;
}

const MAX_SPEED = 20;
const TABLE_RESTITUTION = 0.82;
const GROUND_RESTITUTION = 0.55;
const NET_RESTITUTION = 0.35;

/**
 * Advance the ball with analytic collisions against the curved table top,
 * the net plane, the table sides and the ground. Pure function over `s` so the
 * AI can run it on a scratch state for trajectory prediction.
 */
export function stepBall(
  s: BallState,
  dt: number,
  onEvent?: (e: BallEvent) => void,
  colliders?: BodyCollider[]
): void {
  let remaining = dt;
  const sub = 1 / 240;
  while (remaining > 1e-6) {
    const h = Math.min(sub, remaining);
    remaining -= h;

    const prevX = s.pos.x;
    s.vel.y -= GRAVITY * h;
    const speed = s.vel.length();
    if (speed > MAX_SPEED) s.vel.scaleInPlace(MAX_SPEED / speed);
    s.pos.addInPlace(s.vel.scale(h));

    // Character bodies: soft deflection off a vertical capsule (shoulders at
    // ~92% of height). Only balls moving inward bounce, so a separating ball
    // can't re-trigger.
    if (colliders) {
      let deflected = false;
      for (const c of colliders) {
        const minD = c.radius + BALL_RADIUS;
        const top = c.base.y + c.height * 0.92 - c.radius;
        const bot = c.base.y + c.radius;
        const cy = Math.min(top, Math.max(bot, s.pos.y));
        const dx = s.pos.x - c.base.x;
        const dy = s.pos.y - cy;
        const dz = s.pos.z - c.base.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d >= minD || d < 1e-6) continue;
        const n = new Vector3(dx / d, dy / d, dz / d);
        const vn = Vector3.Dot(s.vel, n);
        if (vn < 0) {
          s.vel.subtractInPlace(n.scale((1 + BODY_RESTITUTION) * vn));
          s.vel.scaleInPlace(0.9);
          onEvent?.({ type: "body", side: c.side });
        }
        s.pos.set(c.base.x + n.x * minD, cy + n.y * minD, c.base.z + n.z * minD);
        deflected = true;
      }
      if (deflected) continue;
    }

    const overTable = Math.abs(s.pos.x) <= TABLE.halfLen && Math.abs(s.pos.z) <= TABLE.halfWid;

    // Net: vertical plane at x = 0 up to net top (covers the table body below it too).
    const crossedNet = Math.sign(prevX) !== Math.sign(s.pos.x) && prevX !== 0;
    if (crossedNet && s.pos.y - BALL_RADIUS < GROUND_Y + TABLE.netTop && Math.abs(s.pos.z) <= TABLE.netHalfWidth) {
      s.pos.x = Math.sign(prevX) * Math.max(Math.abs(s.pos.x), 0.02);
      s.vel.x = -s.vel.x * NET_RESTITUTION;
      s.vel.y *= 0.85;
      s.vel.z *= 0.9;
      onEvent?.({ type: "net" });
      continue;
    }

    // Curved table top.
    if (overTable) {
      const surf = tableSurfaceY(s.pos.x);
      if (s.pos.y - BALL_RADIUS <= surf) {
        // Surface normal of y = f(x): n = normalize(-f'(x), 1, 0), f'(x) = -2kx
        const n = new Vector3(2 * TABLE.curveK * s.pos.x, 1, 0).normalize();
        const vn = Vector3.Dot(s.vel, n);
        if (vn < 0) {
          s.vel.subtractInPlace(n.scale((1 + TABLE_RESTITUTION) * vn));
          s.vel.x *= 0.97;
          s.vel.z *= 0.97;
          s.pos.y = surf + BALL_RADIUS + 0.001;
          onEvent?.({ type: "table", side: s.pos.x < 0 ? "player" : "ai", pos: s.pos.clone() });
        }
        continue;
      }
      // Hit the table from the side (below the surface): push back out horizontally.
      if (s.pos.y < surf) {
        s.vel.x = -s.vel.x * 0.4;
        s.vel.z = -s.vel.z * 0.4;
        onEvent?.({ type: "side", pos: s.pos.clone() });
        continue;
      }
    }

    // Ground.
    if (s.pos.y - BALL_RADIUS <= GROUND_Y) {
      s.pos.y = GROUND_Y + BALL_RADIUS;
      if (s.vel.y < 0) {
        s.vel.y = -s.vel.y * GROUND_RESTITUTION;
        s.vel.x *= 0.8;
        s.vel.z *= 0.8;
        if (Math.abs(s.vel.y) > 0.4) onEvent?.({ type: "ground", pos: s.pos.clone() });
        else s.vel.setAll(0);
      }
    }
  }
}

/** Solve a ballistic launch velocity from `from` to `target` over `flightTime` seconds. */
export function solveLaunch(from: Vector3, target: Vector3, flightTime: number): Vector3 {
  const t = flightTime;
  return new Vector3(
    (target.x - from.x) / t,
    (target.y - from.y) / t + 0.5 * GRAVITY * t,
    (target.z - from.z) / t
  );
}

/** Height at which a launch from `from` with velocity `v` crosses the x=0 plane (NaN if it never does). */
export function heightAtNet(from: Vector3, v: Vector3): number {
  if (Math.abs(v.x) < 1e-4) return NaN;
  const t = -from.x / v.x;
  if (!isFinite(t) || t < 0) return NaN;
  return from.y + v.y * t - 0.5 * GRAVITY * t * t;
}

/**
 * Pick a launch velocity that lands on `target` and clears the net by
 * `clearance`, lengthening the flight time (higher arc) until it does. Smashes
 * pass a small clearance so they stay flat and skim the net. The fine step
 * keeps the found arc close to the requested clearance instead of overshooting.
 */
export function solveLaunchClearingNet(
  from: Vector3,
  target: Vector3,
  baseTime: number,
  clearance = 0.18
): Vector3 {
  let t = baseTime;
  for (let i = 0; i < 18; i++) {
    const v = solveLaunch(from, target, t);
    const crossesNet = Math.sign(from.x) !== Math.sign(target.x);
    if (!crossesNet) return v;
    // heightAtNet is the ball CENTRE; the net collides with the ball's
    // underside, so the radius is part of the required clearance.
    const h = heightAtNet(from, v);
    if (isNaN(h) || h - BALL_RADIUS > GROUND_Y + TABLE.netTop + clearance) return v;
    t += 0.03;
  }
  return solveLaunch(from, target, t);
}

export class Ball {
  state: BallState = { pos: new Vector3(0, 2, 0), vel: Vector3.Zero() };
  mesh: AbstractMesh | null = null;
  /** While true the ball ignores physics (held in a hand / frozen between points). */
  held = true;
  /** Visual spin multiplier for the current flight (smashes spin faster, pops float). */
  private spin = 1;

  update(dt: number, onEvent?: (e: BallEvent) => void, colliders?: BodyCollider[]): void {
    if (!this.held) stepBall(this.state, dt, onEvent, colliders);
    this.mesh?.position.copyFrom(this.state.pos);
    if (this.mesh && !this.held) {
      const w = (this.state.vel.length() / BALL_RADIUS) * this.spin;
      if (w > 0.5) {
        this.mesh.rotate(new Vector3(this.state.vel.z, 0, -this.state.vel.x).normalize(), w * dt * 0.5);
      }
    }
  }

  place(pos: Vector3): void {
    this.state.pos.copyFrom(pos);
    this.state.vel.setAll(0);
    this.mesh?.position.copyFrom(pos);
  }

  launch(vel: Vector3, spin = 1): void {
    this.state.vel.copyFrom(vel);
    this.spin = spin;
    this.held = false;
  }
}

export interface FlightSample {
  t: number;
  pos: Vector3;
  /** True from the moment the ball has bounced on the ground in this flight. */
  grounded?: boolean;
}

/**
 * Sample the ball's natural flight (bounces included, no rule events) at fixed
 * steps. Used to plan touches: the character is moved to meet this trajectory,
 * which is never altered. Samples after a ground bounce are flagged `grounded`
 * so planners never schedule a contact on a ball that already touched down.
 */
export function sampleFlight(state: BallState, maxT: number): FlightSample[] {
  const s: BallState = { pos: state.pos.clone(), vel: state.vel.clone() };
  const dt = 1 / 120;
  const out: FlightSample[] = [];
  let grounded = false;
  const watch = (e: BallEvent) => {
    if (e.type === "ground") grounded = true;
  };
  for (let t = dt; t <= maxT + 1e-6; t += dt) {
    stepBall(s, dt, watch);
    // Soft settles don't emit a "ground" event; catch them by position.
    if (s.pos.y <= GROUND_Y + BALL_RADIUS + 1e-3) grounded = true;
    out.push({ t, pos: s.pos.clone(), grounded });
  }
  return out;
}

export interface Prediction {
  /** First bounce on a table half, if any. */
  tableBounce: { side: Side; pos: Vector3; t: number } | null;
  /** Sampled positions after the table bounce, for interception planning. */
  samples: { t: number; pos: Vector3 }[];
}

/** Simulate a copy of the ball forward to plan AI movement. */
export function predict(state: BallState, maxT = 3): Prediction {
  const s: BallState = { pos: state.pos.clone(), vel: state.vel.clone() };
  const out: Prediction = { tableBounce: null, samples: [] };
  const dt = 1 / 120;
  let t = 0;
  let grounded = false;
  while (t < maxT && !grounded) {
    stepBall(s, dt, (e) => {
      if (e.type === "table" && !out.tableBounce) {
        out.tableBounce = { side: e.side, pos: e.pos.clone(), t };
      }
      if (e.type === "ground") grounded = true;
    });
    t += dt;
    if (out.tableBounce && out.samples.length < 360) {
      out.samples.push({ t, pos: s.pos.clone() });
    }
  }
  return out;
}
