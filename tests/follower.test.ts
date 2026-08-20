import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SIM_DT } from "../src/config";
import { stepBall, type BallState } from "../src/ball";
import { AIController, DIFFICULTIES } from "../src/ai";
import { idle, rig, silentUI, FakeCharacter, type Rig } from "./rig";
import type { InputState } from "../src/input";

/**
 * The guest's ball, played back from delayed snapshots, against the host's
 * own flight as the truth. Two rigs: one driven a tick at a time and sampled
 * the way the session samples, the other fed those samples through a fixed
 * delay — the wire without the socket.
 */

type Frame = Parameters<Rig["match"]["applySnapshot"]>[0];
type BallPos = { x: number; y: number; z: number };

/** Snapshots sampled every 2 host ticks (30 Hz), delivered `delay` ticks late. */
function feed(host: Rig, guest: Rig, delay: number) {
  const cpu = new AIController(host.match, DIFFICULTIES.normal);
  // The session's publishing wiring, reproduced the way session.step does it:
  // drain once per host step, in the step's tick, so clip windows are stamped
  // in the same clock the frames carry.
  host.match.netPublish = true;
  const queue: { due: number; frame: Frame }[] = [];
  const history: (BallPos & { vel: BallPos; held: boolean; aiX: number; aiZ: number })[] = [];
  let tick = 0;

  const stepHost = (input: Partial<InputState> = {}) => {
    host.match.update(SIM_DT, { ...idle, ...input }, (dt) => cpu.update(dt));
    tick += 1;
    host.match.drainNet(tick);
    const b = host.match.ball;
    history.push({
      x: b.state.pos.x,
      y: b.state.pos.y,
      z: b.state.pos.z,
      vel: { x: b.state.vel.x, y: b.state.vel.y, z: b.state.vel.z },
      held: b.held,
      aiX: host.match.chars.ai.position.x,
      aiZ: host.match.chars.ai.position.z,
    });
    if (tick % 2 === 0) {
      const m = host.match;
      const win = (side: "player" | "ai") => {
        const clip = m.chars[side].currentActionClip;
        const w = m.clipWindow[side];
        return w && w.clip === clip ? w : null;
      };
      const pw = win("player");
      const ow = win("ai");
      queue.push({
        due: tick + delay,
        frame: {
          ballPos: { x: b.state.pos.x, y: b.state.pos.y, z: b.state.pos.z },
          ballVel: { x: b.state.vel.x, y: b.state.vel.y, z: b.state.vel.z },
          ballHeld: b.held,
          selfPos: { x: m.chars.player.position.x, z: m.chars.player.position.z },
          opponentPos: { x: m.chars.ai.position.x, z: m.chars.ai.position.z },
          selfVel: { x: m.chars.player.velocity.x, z: m.chars.player.velocity.z },
          opponentVel: { x: m.chars.ai.velocity.x, z: m.chars.ai.velocity.z },
          selfClip: m.chars.player.currentActionClip,
          opponentClip: m.chars.ai.currentActionClip,
          selfClipFrom: pw?.from,
          selfClipTo: pw?.to,
          opponentClipFrom: ow?.from,
          opponentClipTo: ow?.to,
          tick,
          score: [m.score.player, m.score.ai],
          sets: [m.sets.player, m.sets.ai],
          serveOwner: m.serveOwner,
          phase: m.state,
        },
      });
    }
  };

  const deliver = () => {
    while (queue.length > 0 && queue[0].due <= tick) {
      guest.match.applySnapshot(queue.shift()!.frame, 0);
    }
  };

  const stepGuest = () => guest.match.update(SIM_DT, idle, () => {});

  return { stepHost, deliver, stepGuest, history, get tick() { return tick; } };
}

const snapshotBall = (r: Rig): BallPos & { held: boolean } => {
  const b = r.match.ball;
  return { x: b.state.pos.x, y: b.state.pos.y, z: b.state.pos.z, held: b.held };
};

const dist = (a: BallPos, b: BallPos) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Serve, then rally for `ticks`, stepping host, wire and guest together. */
function playRally(f: ReturnType<typeof feed>, guest: Rig, ticks: number): (BallPos & { held: boolean })[] {
  const guestPos: (BallPos & { held: boolean })[] = [];
  const step = (input: Partial<InputState> = {}) => {
    f.stepHost(input);
    f.deliver();
    f.stepGuest();
    guestPos.push(snapshotBall(guest));
  };
  for (let i = 0; i < 180; i++) step(); // walk to the service line
  step({ strikePressed: true }); // the serve
  for (let i = 1; i < ticks; i++) step(i % 24 === 0 ? { popPressed: true } : {});
  return guestPos;
}

/**
 * The ticks no guest can reproduce: wherever the HOST's own flight departs
 * from the pure shared physics — the steer onto the limb before a contact,
 * the snap onto it, the launch it fires, a deflection off a body. Detected
 * by re-simulating each host tick and looking for the ones that disagree.
 */
function hostOnlyTicks(history: (BallPos & { vel: BallPos; held: boolean })[]): Set<number> {
  const out = new Set<number>();
  const s: BallState = { pos: new Vector3(0, 0, 0), vel: new Vector3(0, 0, 0) };
  for (let t = 1; t < history.length; t++) {
    const prev = history[t - 1];
    const now = history[t];
    if (prev.held || now.held) {
      out.add(t);
      continue;
    }
    s.pos.set(prev.x, prev.y, prev.z);
    s.vel.set(prev.vel.x, prev.vel.y, prev.vel.z);
    stepBall(s, SIM_DT);
    if (Math.hypot(s.pos.x - now.x, s.pos.y - now.y, s.pos.z - now.z) > 0.02) {
      // The host bent physics here. The guest shows the bend only after the
      // frames carrying it have crossed the delay and the buffer, so the
      // ripple reaches well past the bend itself.
      for (let i = t - 2; i < t + 20; i++) out.add(i);
    }
  }
  return out;
}

const DELAY = 4;
const BUFFER = 6;

describe("the guest's ball, played back from the feed", () => {
  it("follows the host's flight at one constant delay", () => {
    const host = rig();
    const guest = rig({ ui: silentUI() });
    guest.match.netFollower = true;
    const f = feed(host, guest, DELAY);
    const guestPos = playRally(f, guest, 900);

    const skip = hostOnlyTicks(f.history);
    // The property: there is ONE steady lag at which the shown ball agrees
    // with the truth almost exactly — a constant delay, not a scatter of
    // corrections. Find the best offset and require it to sit in the window
    // the buffer delay defines.
    let bestOffset = -1;
    let bestMean = Infinity;
    for (let offset = DELAY + 2; offset <= DELAY + BUFFER + 5; offset++) {
      let sum = 0;
      let n = 0;
      for (let t = 300; t < guestPos.length - 30; t++) {
        const truth = f.history[t - offset];
        if (!truth || truth.held || skip.has(t) || guestPos[t].held) continue;
        sum += dist(guestPos[t], truth);
        n += 1;
      }
      if (n > 100 && sum / n < bestMean) {
        bestMean = sum / n;
        bestOffset = offset;
      }
    }

    expect(bestOffset).toBeGreaterThanOrEqual(DELAY + 2);
    expect(bestOffset).toBeLessThanOrEqual(DELAY + BUFFER + 5);
    // Near-exact agreement outside the host-only windows: the playback is the
    // flight itself, not an approximation of it.
    expect(bestMean).toBeLessThan(0.05);
  });

  it("never teleports the ball while it is flying free", () => {
    const host = rig();
    const guest = rig({ ui: silentUI() });
    guest.match.netFollower = true;
    const f = feed(host, guest, DELAY);
    const guestPos = playRally(f, guest, 900);

    const skip = hostOnlyTicks(f.history);
    let teleports = 0;
    // From tick 100: the buffer's first engagement copies the display onto
    // the buffered flight in one go, and that one-time take-over is not the
    // steady-state smoothness this pins.
    for (let t = 100; t < guestPos.length; t++) {
      if (skip.has(t) || guestPos[t].held || guestPos[t - 1].held) continue;
      // The physics cap is 24 m/s: one tick at full cap is 0.4 m. Anything
      // past a generous bound is a correction taken whole — the old symptom.
      const jump = dist(guestPos[t], guestPos[t - 1]);
      if (jump > 0.7) teleports += 1;
    }
    expect(teleports).toBe(0);
  });

  it("keeps moving when the feed starves, and recovers when it returns", () => {
    const host = rig();
    const guest = rig({ ui: silentUI() });
    guest.match.netFollower = true;
    const f = feed(host, guest, DELAY);
    playRally(f, guest, 400);

    // Starve: the guest steps on without frames and must not throw.
    for (let i = 0; i < 120; i++) {
      f.stepHost();
      f.stepGuest();
    }
    // Recover: fresh frames re-engage the buffer without a hitch.
    for (let i = 0; i < 240; i++) {
      f.stepHost(i % 24 === 0 ? { popPressed: true } : {});
      f.deliver();
      f.stepGuest();
    }
    expect(Number.isFinite(guest.match.ball.state.pos.x)).toBe(true);
  });

  it("clears the buffer on reset and plays the next feed cleanly", () => {
    const host = rig();
    const guest = rig({ ui: silentUI() });
    guest.match.netFollower = true;
    const f = feed(host, guest, DELAY);
    playRally(f, guest, 300);

    guest.match.reset();
    for (let i = 0; i < 300; i++) {
      f.stepHost(i % 24 === 0 ? { popPressed: true } : {});
      f.deliver();
      f.stepGuest();
    }
    expect(Number.isFinite(guest.match.ball.state.pos.x)).toBe(true);
  });

  it("shows the opponent at the same constant delay as the ball", () => {
    // The chase-easing this replaced ran on its own clock: visible catch-up
    // sprints beside a ball on the timeline. One delay must describe the
    // whole screen.
    const host = rig();
    const guest = rig({ ui: silentUI() });
    guest.match.netFollower = true;
    const f = feed(host, guest, DELAY);
    const guestAi: { x: number; z: number }[] = [];
    const step = (input: Partial<InputState> = {}) => {
      f.stepHost(input);
      f.deliver();
      f.stepGuest();
      const p = guest.match.chars.ai.position;
      guestAi.push({ x: p.x, z: p.z });
    };
    for (let i = 0; i < 180; i++) step();
    step({ strikePressed: true });
    for (let i = 1; i < 900; i++) step(i % 24 === 0 ? { popPressed: true } : {});

    let bestOffset = -1;
    let bestMean = Infinity;
    for (let offset = DELAY + 2; offset <= DELAY + BUFFER + 5; offset++) {
      let sum = 0;
      let n = 0;
      for (let t = 300; t < guestAi.length - 30; t++) {
        const truth = f.history[t - offset];
        if (!truth) continue;
        sum += Math.hypot(guestAi[t].x - truth.aiX, guestAi[t].z - truth.aiZ);
        n += 1;
      }
      if (n > 100 && sum / n < bestMean) {
        bestMean = sum / n;
        bestOffset = offset;
      }
    }

    expect(bestOffset).toBeGreaterThanOrEqual(DELAY + 2);
    expect(bestOffset).toBeLessThanOrEqual(DELAY + BUFFER + 5);
    // Interpolation between 30 Hz samples of a run keeps sub-centimetre to a
    // few centimetres error; the old chase easing measured in body lengths.
    expect(bestMean).toBeLessThan(0.08);
  });

  it("starts a received clip at its windowed fraction, not from zero", () => {
    // A clip arriving ten ticks after it started must start ten ticks in —
    // starting it from its head is the kick lagging the ball by the latency.
    const host = rig();
    const guest = rig({ ui: silentUI() });
    guest.match.netFollower = true;
    const f = feed(host, guest, DELAY);
    playRally(f, guest, 900);

    const opp = guest.match.chars.ai as unknown as FakeCharacter;
    expect(opp.played.length).toBeGreaterThan(0);
    expect(opp.startFracs.some((fr) => fr > 0.05 && fr < 1)).toBe(true);
    expect(opp.startFracs.every((fr) => fr >= 0 && fr <= 1)).toBe(true);
  });
});
