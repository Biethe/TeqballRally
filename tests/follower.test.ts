import { describe, expect, it, vi } from "vitest";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CLIPS, SETS_TO_WIN, SIM_DT, WIN_SCORE, clipStartFraction } from "../src/config";
import { stepBall, type BallState } from "../src/ball";
import { AIController, DIFFICULTIES } from "../src/ai";
import { idle, rig, silentUI, type Rig } from "./rig";
import type { MatchEvent } from "../src/match";
import { bodyPartOf } from "../src/character";
import { SERVE_CLOCK_SECONDS } from "../src/match";
import {
  MAX_CATCHUP_TICKS,
  readLoft,
  readStrikeable,
  readTaps,
  readTouches,
  readViewTick,
  reframe,
  type InputMessage,
  type SnapshotMessage,
} from "../src/net/protocol";
import type { InputState } from "../src/input";

/**
 * The guest's ball, played back from delayed snapshots, against the host's
 * own flight as the truth. Two rigs: one driven a tick at a time and sampled
 * the way the session samples, the other fed those samples through a fixed
 * delay — the wire without the socket.
 */

type Frame = Parameters<Rig["match"]["applySnapshot"]>[0];
type BallPos = { x: number; y: number; z: number };

/**
 * Snapshots sampled every 2 host ticks (30 Hz), delivered `delay` ticks late.
 *
 * `jitter` spreads the delivery the way a phone actually receives it: a few
 * ticks of variation and the occasional long gap. A fixed delay is the easy
 * case and hides the two faults this file now pins — the flight stalling at a
 * contact it cannot resolve, and the character teleporting when the host takes
 * its feet — because both are about how long the *next* frame takes to come.
 */
function feed(host: Rig, guest: Rig, delay: number, jitter = 0, lead = 0) {
  let seed = 987654321;
  const spread = () => {
    if (jitter <= 0) return 0;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const r = seed / 0x7fffffff;
    return Math.floor(r * jitter) + (r < 0.08 ? jitter * 3 : 0);
  };
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
        due: tick + delay + spread(),
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
          // The fields the guest predicts its own character from. Left out of
          // this harness for a long time, which meant every test here drove a
          // guest that never ran the reach assist, never leashed, and never
          // handed its feet over — the whole of the prediction path, untested.
          selfLocked: m.lockedState.player,
          // Read field by field. Spreading a Babylon Vector3 copies `_x/_y/_z`
          // and not the accessors, so `{...pos}` is an object with no `x` on
          // it at all — which typechecks nowhere and would have fed this
          // harness an anchor of undefined.
          selfAnchor: m.anchorState.player
            ? {
                x: m.anchorState.player.pos.x,
                y: m.anchorState.player.pos.y,
                z: m.anchorState.player.pos.z,
              }
            : null,
          selfAnchorEta: m.anchorState.player?.eta,
          strikeable:
            m.strikeableSide === null ? null : m.strikeableSide === "player" ? "host" : "guest",
          touches: m.touchCount,
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
      // The lead the session would have measured for this link. Zero is the
      // default only because the older tests here were written against it;
      // a real session always leads, and the pin the ball waits at is sized
      // in exactly that.
      guest.match.applySnapshot(queue.shift()!.frame, lead);
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
function hostOnlyTicks(
  history: (BallPos & { vel: BallPos; held: boolean })[],
  ripple: number
): Set<number> {
  const out = new Set<number>();
  const s: BallState = { pos: new Vector3(0, 0, 0), vel: new Vector3(0, 0, 0) };
  for (let t = 1; t < history.length; t++) {
    const prev = history[t - 1];
    const now = history[t];
    if (prev.held || now.held) {
      out.add(t);
      // Coming out of a hand is a change like any other: the guest is still
      // showing the ball on the palm until the frame that launched it lands.
      if (prev.held && !now.held) for (let i = t - 2; i < t + ripple; i++) out.add(i);
      continue;
    }
    s.pos.set(prev.x, prev.y, prev.z);
    s.vel.set(prev.vel.x, prev.vel.y, prev.vel.z);
    stepBall(s, SIM_DT);
    // Velocity as well as position: a kick replaces the velocity *after* the
    // step that tick, so the ball has not moved anywhere unexpected yet and a
    // position-only check walks straight past the biggest bend there is.
    const moved = Math.hypot(s.pos.x - now.x, s.pos.y - now.y, s.pos.z - now.z);
    const turned = Math.hypot(
      s.vel.x - now.vel.x,
      s.vel.y - now.vel.y,
      s.vel.z - now.vel.z
    );
    if (moved > 0.02 || turned > 0.2) {
      // The host bent physics here. The guest shows the bend only after the
      // frames carrying it have crossed the delay and the buffer, so the
      // ripple reaches well past the bend itself.
      for (let i = t - 2; i < t + ripple; i++) out.add(i);
    }
  }
  return out;
}

const DELAY = 4;
const BUFFER = 6;
/**
 * Ticks after a change to the ball's path that the guest cannot be held to.
 *
 * Reading at the host's instant means a kick, a bounce off a body or a serve
 * leaving the hand is news the guest does not have until the frame carrying it
 * arrives — and then the correction is bled off rather than jumped. The delay
 * plus that decay is the window; outside it the playback is the flight itself.
 */
const RIPPLE = DELAY + 26;

describe("the guest's ball, played back from the feed", { timeout: 15_000 }, () => {
  it("shows the instant the host is playing when the lead matches the route", () => {
    const host = rig();
    const guest = rig({ ui: silentUI() });
    guest.match.netFollower = true;
    // What the session does from the measured round trip: read as far ahead
    // of the newest frame as the frame took to arrive.
    guest.match.setPlaybackLead(DELAY);
    const f = feed(host, guest, DELAY);
    const guestPos = playRally(f, guest, 900);

    const skip = hostOnlyTicks(f.history, RIPPLE);
    // The property: the shown ball agrees with the host's ball *now*, not with
    // where it was a fixed interval ago. Sweep the lag anyway and require the
    // best fit to be no lag at all — that is what makes a touch the joined
    // player times on screen a touch the host can still take.
    let bestOffset = -1;
    let bestMean = Infinity;
    for (let offset = 0; offset <= DELAY + BUFFER + 5; offset++) {
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

    expect(bestOffset).toBe(0);
    // Near-exact agreement outside the ripple windows: the playback is the
    // host's flight itself, at the host's own instant, not an approximation.
    expect(bestMean).toBeLessThan(0.02);
  });

  it("never teleports the ball while it is flying free", () => {
    const host = rig();
    const guest = rig({ ui: silentUI() });
    guest.match.netFollower = true;
    const f = feed(host, guest, DELAY);
    const guestPos = playRally(f, guest, 900);

    const skip = hostOnlyTicks(f.history, RIPPLE);
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


});

/**
 * A guest playing, not just watching.
 *
 * Everything above pins what the joined player *sees*. This pins what they can
 * *do*, which is the half that was broken: the first touch is automatic and
 * always worked, and nothing after it reached the host at all. A phone held
 * upright plays by tapping the court and swiping to kick, and a follower runs
 * no rules — so without the host's possession travelling back, its every tap
 * could only ever be a walk.
 *
 * Both directions of the wire, through the real messages and the real mirror,
 * because the seat swap is where a guest's intent gets lost.
 */
function online(delay: number, portrait: boolean) {
  const host = rig({ ui: silentUI() });
  const guest = rig({ ui: silentUI() });
  host.match.versus = true;
  host.match.netPublish = true;
  guest.match.versus = true;
  guest.match.netFollower = true;
  guest.match.tapSteering = portrait;
  guest.match.portraitControls = portrait;
  guest.match.setPlaybackLead(delay);

  const snaps: { due: number; msg: SnapshotMessage }[] = [];
  const controls: { due: number; msg: InputMessage }[] = [];
  const events: MatchEvent[] = [];
  host.match.subscribe((e) => events.push(e));
  let tick = 0;

  const publish = () => {
    const m = host.match;
    const win = (side: "player" | "ai") => {
      const clip = m.chars[side].currentActionClip;
      const w = m.clipWindow[side];
      return w && w.clip === clip ? w : null;
    };
    const pw = win("player");
    const ow = win("ai");
    const b = m.ball;
    snaps.push({
      due: tick + delay,
      msg: {
        t: "snap",
        tick,
        ballPos: { x: b.state.pos.x, y: b.state.pos.y, z: b.state.pos.z },
        ballVel: { x: b.state.vel.x, y: b.state.vel.y, z: b.state.vel.z },
        ballHeld: b.held,
        hostPos: { x: m.chars.player.position.x, y: 0, z: m.chars.player.position.z },
        guestPos: { x: m.chars.ai.position.x, y: 0, z: m.chars.ai.position.z },
        hostVel: { x: m.chars.player.velocity.x, y: 0, z: m.chars.player.velocity.z },
        guestVel: { x: m.chars.ai.velocity.x, y: 0, z: m.chars.ai.velocity.z },
        hostClip: m.chars.player.currentActionClip,
        guestClip: m.chars.ai.currentActionClip,
        hostClipFrom: pw?.from,
        hostClipTo: pw?.to,
        guestClipFrom: ow?.from,
        guestClipTo: ow?.to,
        hostLocked: m.lockedState.player,
        guestLocked: m.lockedState.ai,
        strikeable: m.strikeableSide === null ? null : m.strikeableSide === "player" ? "host" : "guest",
        touches: m.touchCount,
        score: [m.score.player, m.score.ai],
        sets: [m.sets.player, m.sets.ai],
        serveOwner: m.serveOwner,
        phase: m.state,
      },
    });
  };

  /** The session's own inbound handling, both ways, minus the socket. */
  const applyControls = (msg: InputMessage) => {
    host.match.versusPortrait = msg.portrait === true;
    host.match.versusInput = {
      moveX: msg.moveX,
      moveZ: msg.moveZ,
      strikePressed: host.match.versusInput.strikePressed || msg.strike,
      strikeHeld: msg.hold === true,
      strikePower: typeof msg.power === "number" ? msg.power : 0,
      strikeTaps: readTaps(msg.taps),
      strikeLoft: readLoft(msg.loft),
      popPressed: host.match.versusInput.popPressed || msg.pop,
      confirmPressed: host.match.versusInput.confirmPressed || msg.confirm,
      tapAim: msg.tapAim === true,
    };
  };

  const applySnap = (msg: SnapshotMessage) => {
    guest.match.applySnapshot(
      {
        ballPos: msg.ballPos,
        ballVel: msg.ballVel,
        ballHeld: msg.ballHeld,
        selfPos: msg.hostPos,
        opponentPos: msg.guestPos,
        selfVel: msg.hostVel,
        opponentVel: msg.guestVel,
        selfClip: msg.hostClip,
        opponentClip: msg.guestClip,
        selfClipFrom: msg.hostClipFrom,
        selfClipTo: msg.hostClipTo,
        opponentClipFrom: msg.guestClipFrom,
        opponentClipTo: msg.guestClipTo,
        selfLocked: msg.hostLocked === true,
        strikeable: readStrikeable(msg.strikeable),
        touches: readTouches(msg.touches),
        tick: msg.tick,
        score: msg.score,
        sets: msg.sets,
        serveOwner: msg.serveOwner,
        phase: msg.phase,
      },
      delay
    );
  };

  /** One tick of both peers and the wire between them. */
  const step = (hostInput: Partial<InputState> = {}, guestInput: Partial<InputState> = {}, tapAt?: Vector3) => {
    while (controls.length > 0 && controls[0].due <= tick) applyControls(controls.shift()!.msg);
    host.match.update(SIM_DT, { ...idle, ...hostInput }, () => {});
    tick += 1;
    host.match.drainNet(tick);
    if (tick % 2 === 0) publish();
    while (snaps.length > 0 && snaps[0].due <= tick) {
      applySnap(reframe(snaps.shift()!.msg, "guest"));
    }
    // The guest's own frame: a tap is resolved by the match, exactly as the
    // app does, then whatever the wire can carry of it goes out.
    if (tapAt) guest.match.tapAt(tapAt);
    const frame: InputState = { ...idle, ...guestInput };
    const out = guest.match.resolveFollowerInput(frame);
    guest.match.update(SIM_DT, frame, () => {});
    controls.push({
      due: tick + delay,
      msg: reframe(
        {
          t: "input",
          tick,
          moveX: out.moveX,
          moveZ: out.moveZ,
          strike: out.strikePressed,
          hold: out.strikeHeld,
          power: out.strikePower,
          taps: out.strikeTaps,
          loft: out.strikeLoft,
          pop: out.popPressed,
          confirm: out.confirmPressed,
          portrait,
          tapAim: out.tapAim,
        },
        "guest"
      ),
    });
  };

  return { host, guest, events, step, get tick() { return tick; } };
}

/** Touches the guest's seat took in its longest possession of the run. */
function bestGuestPossession(events: MatchEvent[]): number {
  let best = 0;
  let run = 0;
  for (const e of events) {
    if (e.type === "possession-start") {
      if (e.side === "ai") run = 0;
      continue;
    }
    if (e.type === "touch-committed" && e.side === "ai") best = Math.max(best, ++run);
  }
  return best;
}

describe("a guest playing, both directions of the wire", { timeout: 20_000 }, () => {
  /**
   * Where the guest's court point is, seen from the guest. Its own character
   * is always on the near side, and a set-up is played out in front of it.
   */
  const aheadOf = (g: Rig) =>
    new Vector3(g.match.chars.player.position.x + 0.35, 0, g.match.chars.player.position.z);

  it("lets an upright phone play a set-up and a kick, not just the reception", () => {
    const net = online(DELAY, true);
    for (let i = 0; i < 200; i++) net.step();
    net.step({ strikePressed: true }); // the host serves
    for (let i = 0; i < 1200; i++) {
      // Tap where the ball should be played, the way a thumb does: often
      // enough to be asking, not every single frame.
      net.step({}, {}, i % 6 === 0 ? aheadOf(net.guest) : undefined);
    }

    expect(bestGuestPossession(net.events)).toBeGreaterThanOrEqual(2);
  });

  it("lets a sideways phone do the same through its buttons", () => {
    const net = online(DELAY, false);
    for (let i = 0; i < 200; i++) net.step();
    net.step({ strikePressed: true });
    for (let i = 0; i < 1200; i++) {
      net.step({}, i % 24 === 0 ? { popPressed: true } : {});
    }

    expect(bestGuestPossession(net.events)).toBeGreaterThanOrEqual(2);
  });

  it("reads a guest's serve through the scheme they are actually playing", () => {
    // A portrait swipe says pace with its speed; the landscape scheme says it
    // with a tap count. The host used to assume landscape for the second seat
    // whatever the guest was holding, so a swiped serve found no tap count and
    // fell back to the neutral 0.5 every time.
    const serve = (portrait: boolean, pace: number): number => {
      const r = rig({ ui: silentUI() });
      r.match.versus = true;
      r.match.versusPortrait = portrait;
      r.match.serveOwner = "ai";
      r.step(3); // walk to the service line
      expect(r.match.state).toBe("serve_ready");
      r.match.versusInput.strikePressed = true;
      r.match.versusInput.strikePower = pace;
      r.step(2);
      const launched = r.events.find(
        (e) => e.type === "ball-launched" && e.action === "serve"
      ) as Extract<MatchEvent, { type: "ball-launched" }> | undefined;
      expect(launched).toBeDefined();
      return launched!.vel.length();
    };

    // Upright: the speed of the swipe is the pace of the serve.
    expect(serve(true, 0.95)).toBeGreaterThan(serve(true, 0.05));
    // Sideways: the pace lives in the tap count, and a swipe's number is not
    // it — the same serve either way, which is what a portrait guest used to
    // get whatever they drew.
    expect(serve(false, 0.95)).toBeCloseTo(serve(false, 0.05), 6);
  });

  it("stands the guest still on a tapped placement instead of walking it away", () => {
    // A tapped carry and a walk direction are the same shape on the wire. Read
    // as a walk, the placement marched the guest away from the ball it had
    // just asked to play.
    const travelled = (placing: boolean): number => {
      const r = rig({ ui: silentUI() });
      r.match.versus = true;
      r.match.versusPortrait = true;
      r.step(3); // walk to the service line
      r.step(0.2, { strikePressed: true }); // the host serves
      r.step(1); // the serve clip runs its course and the rally begins
      expect(r.match.state).toBe("rally");
      const before = r.match.chars.ai.position.clone();
      for (let i = 0; i < 20; i++) {
        r.match.versusInput.moveX = 1;
        r.match.versusInput.tapAim = placing;
        r.step(SIM_DT);
      }
      return r.match.chars.ai.position.subtract(before).length();
    };

    expect(travelled(true)).toBeLessThan(travelled(false));
  });

  it("spends a guest's press even when no rally is running to consume it", () => {
    // It used to be cleared only inside the rally branch, so a press made
    // after the ball had landed sat latched through the celebration and the
    // walk back, and fired a touch into the first step of the next point —
    // an animation playing against a ball nobody was near.
    const r = rig({ ui: silentUI() });
    r.match.versus = true;
    expect(r.match.state).toBe("serve_move");
    r.match.versusInput.popPressed = true;
    r.match.versusInput.strikePressed = true;
    r.match.versusInput.tapAim = true;

    r.step(SIM_DT);

    expect(r.match.versusInput.popPressed).toBe(false);
    expect(r.match.versusInput.strikePressed).toBe(false);
    expect(r.match.versusInput.tapAim).toBe(false);
  });

  it("does not serve the next point on a press left over from the last one", () => {
    const r = rig({ ui: silentUI() });
    r.match.versus = true;
    r.match.serveOwner = "ai";
    // Pressed while walking back, long before the serve is even ready.
    r.match.versusInput.strikePressed = true;
    r.step(3);

    expect(r.match.state).toBe("serve_ready");
  });

});

/**
 * Judging a guest's press by the ball they were looking at.
 *
 * A guest's screen is led to the host's present, so it presses at host time V
 * and the host hears about it a trip later. Judging that press against the ball
 * as it is *then* asks a different question from the one the player answered:
 * a few ticks of fall is a whole height band, so the joined player kept meeting
 * a knee ball with a foot and a chest ball with a knee. The second seat used to
 * be handed a silent 15% of extra reach to paper over it.
 */
describe("lag compensation", () => {
  /**
   * Play a rally to a fixed instant, then ask for a set-up — once judged live,
   * once judged `back` ticks ago. Everything before the press is identical, so
   * the only thing that can move the answer is the rewind.
   */
  function setUpAt(steps: number, back: number | null): string | null {
    const r = rig({ ui: silentUI() });
    r.match.versus = true;
    r.match.netPublish = true;
    let tick = 0;
    r.step(3); // walk to the service line
    r.step(0.2, { strikePressed: true }); // the host serves
    for (let i = 0; i < steps; i++) {
      r.step(SIM_DT);
      tick++;
      // What `OnlineSession.step` does on the host, once per simulation step.
      r.match.recordBallAt(tick);
    }
    r.match.versusViewTick = back === null ? null : tick - back;
    r.match.versusInput.popPressed = true;
    r.step(SIM_DT);
    return r.match.chars.ai.currentActionClip;
  }

  it("picks the limb from the ball the guest saw, not the one it has become", () => {
    // At this instant the ball is a little over a metre up and dropping at five
    // metres a second: eight ticks earlier it was knee-high, and now it is at
    // the foot. Same press, same rally, two different touches — which is the
    // whole of the wrong-limb complaint.
    // The instant is the middle of the few ticks where that holds, and it moves
    // with the serve's timing: it was 180 until the serve left on a count of
    // steps rather than on its clip's frames.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(bodyPartOf(setUpAt(178, null) ?? "")).toBe("foot");
    expect(bodyPartOf(setUpAt(178, 8) ?? "")).toBe("knee");
    // And a trip short enough not to cross a band changes nothing.
    expect(bodyPartOf(setUpAt(178, 4) ?? "")).toBe("foot");
  });

  it("takes the automatic first touch against the live ball, since nobody pressed for it", () => {
    // The rewind is for a press. Asked every step whether the ball the guest
    // last saw was in reach, the host answered a round trip and a buffer after
    // the real ball got there, and it had gone. Measured on two real clients
    // over 95 ms each way with nobody on the controls: the host's seat took 7
    // serves of 7, the guest's 0 of 8.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const receives = (back: number | null): boolean => {
      const r = rig({ ui: silentUI() });
      r.match.versus = true;
      r.match.netPublish = true;
      let received = false;
      r.match.subscribe((e) => {
        if (e.type === "touch-committed" && e.side === "ai") received = true;
      });
      r.step(3); // walk to the service line
      r.step(0.2, { strikePressed: true }); // the host serves to the guest's seat
      for (let tick = 1; tick <= 240 && !received; tick++) {
        r.step(SIM_DT);
        r.match.recordBallAt(tick);
        // A guest a round trip and a buffer behind, as a phone link leaves it.
        r.match.versusViewTick = back === null ? null : Math.max(0, tick - back);
      }
      return received;
    };
    expect(receives(null)).toBe(true);
    expect(receives(26)).toBe(true);
  });

  it("judges live for a seat that does not say what it was looking at", () => {
    // A peer too old to stamp its frames, and every local match: the live ball
    // is the one they saw.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(setUpAt(180, null)).toBe(setUpAt(180, 0));
  });

  /**
   * The other half of the same asymmetry. The host does not walk the guest's
   * character on a bare stick — it bends the push onto the contact point and
   * leashes it to the reception zone — so a prediction that skipped the assist
   * regenerated the whole of it every step, and `reconcile` chased a gap it
   * could never close.
   */
  it("predicts with the assist the host is applying, not a bare stick", () => {
    const run = (withAnchor: boolean): number => {
      const r = rig({ ui: silentUI() });
      r.match.versus = true;
      r.match.netFollower = true;
      const at = r.match.chars.player.position;
      // Inside REACH_ASSIST.radius and off to one side of a push up the court,
      // with time to spare — the shape the bend exists for.
      const anchor = withAnchor ? { x: at.x + 0.3, y: 0, z: at.z + 0.4 } : null;
      const frame = (tick: number): Frame => ({
        ballPos: { x: anchor?.x ?? at.x, y: 1.1, z: anchor?.z ?? at.z },
        ballVel: { x: 0, y: -1, z: 0 },
        ballHeld: false,
        selfPos: { x: at.x, z: at.z },
        opponentPos: { x: 3, z: 0 },
        selfVel: { x: 0, z: 0 },
        opponentVel: { x: 0, z: 0 },
        selfClip: null,
        opponentClip: null,
        selfAnchor: anchor,
        selfAnchorEta: 0.6,
        strikeable: "host",
        touches: 0,
        tick,
        score: [0, 0],
        sets: [0, 0],
        serveOwner: "player",
        phase: "rally",
      });
      r.match.applySnapshot(frame(1), 0);
      r.match.applySnapshot(frame(3), 0);
      // Pushing straight up the court, with the ball due off to one side.
      // Read off the velocity rather than the position: the snapshot also
      // reports where the host has this character, and `reconcile` is pulling
      // the drawn position back toward it the whole time. The velocity is the
      // prediction alone.
      for (let i = 0; i < 3; i++) r.step(SIM_DT, { moveX: 1, moveZ: 0 });
      return r.match.chars.player.velocity.z;
    };

    // Nothing to aim at: the push goes where it was pointed and nowhere else.
    expect(Math.abs(run(false))).toBeLessThan(1e-6);
    // With the host's anchor on the wire, the same push bends onto it — the
    // same bend the host is applying to the same character at the same moment.
    expect(run(true)).toBeGreaterThan(0.2);
  });

  it("never rewinds further than the host still remembers", () => {
    // A peer that asks to be judged against a moment the host has forgotten,
    // or one that has not happened, gets the nearest tick it is entitled to.
    expect(readViewTick(500, 500)).toBe(500);
    expect(readViewTick(900, 500)).toBe(500);
    expect(readViewTick(0, 500)).toBe(500 - MAX_CATCHUP_TICKS);
    expect(readViewTick(497, 500)).toBe(497);
    expect(readViewTick(undefined, 500)).toBeUndefined();
    expect(readViewTick(Number.NaN, 500)).toBeUndefined();

    /*
     * And no further back than the link actually costs.
     *
     * The protocol's outside limit is half a second. Honouring a press from
     * that far back means judging it against a ball metres from where either
     * screen still shows it, and the contact then pulls the ball onto the
     * foot — which is a player watching the ball go past them and retrieve
     * itself anyway. A quick link may rewind a little; only a slow one may
     * rewind a lot.
     */
    expect(readViewTick(480, 500, 6)).toBe(494);
    expect(readViewTick(499, 500, 6)).toBe(499);
    // Never past the protocol's own ceiling, whatever a peer claims to need.
    expect(readViewTick(0, 500, 9999)).toBe(500 - MAX_CATCHUP_TICKS);
    expect(readViewTick(480, 500, -5)).toBe(500);
  });
});


/**
 * A serve nobody plays is a match nobody can finish. Against another person
 * the ball has to move, and the last few seconds are counted down so the clock
 * is never a surprise.
 */
/**
 * What the second phone actually looks like on a link that stutters.
 *
 * Both faults here were invisible on a fixed delay and obvious the moment the
 * delivery was allowed to vary the way a phone's really does — which is also
 * why they reached a build.
 */
describe("a guest on a link that stutters", () => {
  it("never teleports the character whose feet the host has just taken", () => {
    /*
     * Prediction has usually drifted by the time a touch starts, and handing
     * over in a single frame put the whole of that drift into one step. Half a
     * metre in one tick, with no stick input at all, which on screen is the
     * player jumping sideways on its own.
     */
    const host = rig();
    const guest = rig();
    guest.match.netFollower = true;
    const f = feed(host, guest, 6, 10, 6);

    let worst = 0;
    let prev = { x: 0, z: 0 };
    for (let i = 0; i < 700; i++) {
      f.stepHost(i === 180 ? { strikePressed: true } : i > 180 && i % 24 === 0 ? { popPressed: true } : {});
      f.deliver();
      f.stepGuest();
      const p = guest.match.chars.player.position;
      if (i >= 200) worst = Math.max(worst, Math.hypot(p.x - prev.x, p.z - prev.z));
      prev = { x: p.x, z: p.z };
    }

    // A character's own top speed is a few metres a second, so anything past
    // about a fifth of a metre in one tick is not movement, it is a jump. The
    // contact lunge is the host's own and arrives at 30 Hz, which is what the
    // remaining headroom is for; before the handover was smoothed this run
    // reached two thirds of a metre.
    expect(worst).toBeLessThan(0.34);
  }, 30_000);
});

describe("the serve clock", () => {
  /** Step to the instant the server is standing ready, where the clock starts. */
  const toServeReady = (r: Rig) => {
    for (let i = 0; i < 900 && r.match.state !== "serve_ready"; i++) r.step(SIM_DT);
    expect(r.match.state).toBe("serve_ready");
  };

  it("gives the point away when nobody serves", () => {
    const r = rig({ ui: silentUI() });
    r.match.versus = true;
    r.match.serveOwner = "player";
    toServeReady(r);

    let waited = 0;
    while (r.match.state === "serve_ready" && waited < SERVE_CLOCK_SECONDS + 4) {
      r.step(SIM_DT);
      waited += SIM_DT;
    }

    expect(r.match.state).toBe("point");
    expect(waited).toBeGreaterThan(SERVE_CLOCK_SECONDS - 0.5);
    expect(waited).toBeLessThan(SERVE_CLOCK_SECONDS + 0.5);
    expect(r.match.score.ai).toBe(1);
    expect(r.match.score.player).toBe(0);
  });

  it("leaves a player alone when there is nobody waiting on them", () => {
    // Solo. The CPU serves on its own beat and has never needed hurrying, and
    // a player pausing to think in front of it is not stalling anybody.
    const r = rig({ ui: silentUI() });
    r.match.serveOwner = "player";
    toServeReady(r);

    r.step(SERVE_CLOCK_SECONDS + 2);

    expect(r.match.state).toBe("serve_ready");
    expect(r.match.score.ai).toBe(0);
  });

  it("counts down the last three seconds and nothing before them", () => {
    const hints: (string | null)[] = [];
    const r = rig({ ui: { ...silentUI(), hint: (t) => hints.push(t) } });
    r.match.versus = true;
    r.match.serveOwner = "player";
    toServeReady(r);
    hints.length = 0;

    while (r.match.state === "serve_ready") r.step(SIM_DT);

    // Each number written once, in order, and only the last three.
    expect(hints.filter((h) => h !== null)).toEqual(["3", "2", "1"]);
  });

  it("stops counting the moment the ball is served", () => {
    const r = rig({ ui: silentUI() });
    r.match.versus = true;
    r.match.serveOwner = "player";
    toServeReady(r);
    r.step(SERVE_CLOCK_SECONDS - 1);
    expect(r.match.state).toBe("serve_ready");
    expect(r.match.serveClockLeft).not.toBeNull();

    r.step(SIM_DT, { strikePressed: true });

    expect(r.match.serveClockLeft).toBeNull();
    expect(r.match.state).not.toBe("serve_ready");
  });
});

/**
 * A rematch restarts this peer the moment it is agreed, for responsiveness,
 * but the host is a trip behind. Whichever peer resets first then spends that
 * trip receiving snapshots that still say the match is over.
 */
describe("the last frames of a finished match", () => {
  const overFrame = (tick: number, phase: string): Frame => ({
    ballPos: { x: 0, y: 1, z: 0 },
    ballVel: { x: 0, y: 0, z: 0 },
    ballHeld: true,
    selfPos: { x: -3, z: 0 },
    opponentPos: { x: 3, z: 0 },
    selfVel: { x: 0, z: 0 },
    opponentVel: { x: 0, z: 0 },
    selfClip: null,
    opponentClip: null,
    tick,
    score: [3, 1],
    sets: phase === "over" ? [2, 0] : [0, 0],
    serveOwner: "player",
    phase,
  });

  it("does not blow the final whistle again over the rematch", () => {
    const ends: string[] = [];
    const r = rig({ ui: { ...silentUI(), onMatchEnd: (w) => ends.push(w) } });
    r.match.versus = true;
    r.match.netFollower = true;

    r.match.applySnapshot(overFrame(1, "over"), 0);
    expect(ends).toEqual(["player"]);

    // Both sides agreed; this peer restarts at once.
    r.match.reset();
    expect(r.match.matchWinner).toBeNull();

    // The host is still a trip behind, sending the match that just ended.
    r.match.applySnapshot(overFrame(3, "over"), 0);
    r.match.applySnapshot(overFrame(5, "over"), 0);

    expect(ends).toEqual(["player"]);
    expect(r.match.matchWinner).toBeNull();
    expect(r.match.score.player).toBe(0);

    // And the moment the host has restarted too, the feed is live again.
    r.match.applySnapshot(overFrame(7, "serve_move"), 0);
    expect(r.match.state).toBe("serve_move");
  });
});


/** The arrow that says which end the serve is coming from. */
describe("the serve marker", () => {
  const marker = () => {
    const m = {
      enabled: false,
      position: new Vector3(),
      rotation: new Vector3(),
      setEnabled(v: boolean) {
        this.enabled = v;
      },
    };
    return m;
  };

  it("hangs over the server through the serve and nowhere else", () => {
    const r = rig({ ui: silentUI() });
    const m = marker();
    r.match.serveMarker = m as unknown as NonNullable<typeof r.match.serveMarker>;
    r.match.serveOwner = "ai";
    r.step(SIM_DT);

    expect(m.enabled).toBe(true);
    expect(m.position.x).toBeCloseTo(r.match.chars.ai.position.x, 6);
    expect(m.position.y).toBeGreaterThan(r.match.chars.ai.position.y + r.match.chars.ai.height);

    // Once the rally is under way it has nothing to say.
    r.step(3);
    r.step(0.2, { strikePressed: true });
    r.step(1.5);
    expect(r.match.state).toBe("rally");
    expect(m.enabled).toBe(false);
  });
});



/**
 * A follower counts no points of its own, and reports them to the server at
 * the final whistle. A win with no points behind it is a result the server
 * refuses as impossible — so a joined player who won could not be paid for it,
 * and neither could their opponent, because one report settles nothing.
 */
describe("what a match was worth", () => {
  it("takes the tally from the host rather than counting none", () => {
    const r = rig({ ui: silentUI() });
    r.match.versus = true;
    r.match.netFollower = true;
    expect(r.match.tally.points.player).toBe(0);

    r.match.applySnapshot(
      {
        ballPos: { x: 0, y: 1, z: 0 },
        ballVel: { x: 0, y: 0, z: 0 },
        ballHeld: true,
        selfPos: { x: -3, z: 0 },
        opponentPos: { x: 3, z: 0 },
        selfVel: { x: 0, z: 0 },
        opponentVel: { x: 0, z: 0 },
        selfClip: null,
        opponentClip: null,
        // Already reframed: [this peer, the opponent].
        tally: [6, 4],
        rallies: 3,
        tick: 1,
        score: [3, 1],
        sets: [2, 0],
        serveOwner: "player",
        phase: "over",
      },
      0
    );

    expect(r.match.tally.points.player).toBe(6);
    expect(r.match.tally.points.ai).toBe(4);
    expect(r.match.tally.longRallies).toBe(3);
  });

  it("swaps the tally with the seats it belongs to", () => {
    // The host counts [host, guest]; each peer reports its own half.
    const wire = {
      t: "snap" as const,
      tick: 1,
      ballPos: { x: 1, y: 1, z: 1 },
      ballVel: { x: 0, y: 0, z: 0 },
      ballHeld: true,
      hostPos: { x: -3, y: 0, z: 0 },
      guestPos: { x: 3, y: 0, z: 0 },
      hostVel: { x: 0, y: 0, z: 0 },
      guestVel: { x: 0, y: 0, z: 0 },
      hostClip: null,
      guestClip: null,
      tally: [6, 4] as [number, number],
      rallies: 3,
      score: [3, 1] as [number, number],
      sets: [2, 0] as [number, number],
      serveOwner: "player" as const,
      phase: "over",
    };

    const seen = reframe(wire, "guest");

    expect(seen.tally).toEqual([4, 6]);
    // The rallies belong to the match, not to a seat.
    expect(seen.rallies).toBe(3);
  });
});

/**
 * The guest playing the host's decisions: two real matches, with every frame
 * and every decision crossing one ordered, delayed link, the way the relay's
 * socket carries them. A message never overtakes one sent before it, so a slow
 * one holds up everything behind it — which is exactly the case the old
 * reorderable harness above could not show.
 */
describe("the guest plays the host's decisions", { timeout: 30_000 }, () => {
  interface Wire {
    host: Rig;
    stepHost(input?: Partial<InputState>): void;
    stepGuest(): void;
    /** The host's ball at the end of each of its ticks. */
    ball: { x: number; y: number; z: number; held: boolean }[];
    /** Both of the host's characters at the end of each of its ticks. */
    bodies: Record<"player" | "ai", { x: number; z: number; busy: boolean }>[];
    /** Every launch the host published, as it published it, and the tick it left on. */
    launches: (Extract<ReturnType<Rig["match"]["takeNetEvents"]>[number], { type: "launch" }> & { sentAt: number })[];
    tick(): number;
  }

  function wire(host: Rig, guest: Rig, delay: number, jitter: () => number, lead: number): Wire {
    host.match.netPublish = true;
    guest.match.netFollower = true;
    // As a session sets up its guest: drawing the host's past from a buffer.
    guest.match.usePlaybackBuffer();
    const cpu = new AIController(host.match, DIFFICULTIES.normal);
    const inFlight: { due: number; apply: () => void }[] = [];
    let lastDue = 0;
    let tick = 0;
    const ball: Wire["ball"] = [];
    const bodies: Wire["bodies"] = [];
    const launches: Wire["launches"] = [];
    const send = (apply: () => void, spread: number) => {
      lastDue = Math.max(lastDue, tick + delay + spread);
      inFlight.push({ due: lastDue, apply });
    };
    return {
      host,
      ball,
      bodies,
      launches,
      tick: () => tick,
      stepHost(input = {}) {
        host.match.update(SIM_DT, { ...idle, ...input }, (dt) => cpu.update(dt));
        tick += 1;
        const spread = jitter();
        host.match.drainNet(tick);
        const m = host.match;
        const b = m.ball;
        ball[tick] = { x: b.state.pos.x, y: b.state.pos.y, z: b.state.pos.z, held: b.held };
        const body = (c: Rig["match"]["chars"]["player"]) => ({ x: c.position.x, z: c.position.z, busy: c.busy });
        bodies[tick] = { player: body(m.chars.player), ai: body(m.chars.ai) };
        for (const e of m.takeNetEvents()) {
          if (e.type === "launch") {
            launches.push({ ...e, sentAt: tick });
            send(() => guest.match.queueLaunch(e), spread);
          } else {
            send(() => guest.match.queueClip(e), spread);
          }
        }
        if (tick % 2 === 0) {
          const frame: Frame = {
            ballPos: { x: b.state.pos.x, y: b.state.pos.y, z: b.state.pos.z },
            ballVel: { x: b.state.vel.x, y: b.state.vel.y, z: b.state.vel.z },
            ballHeld: b.held,
            selfPos: { x: m.chars.player.position.x, z: m.chars.player.position.z },
            opponentPos: { x: m.chars.ai.position.x, z: m.chars.ai.position.z },
            selfVel: { x: m.chars.player.velocity.x, z: m.chars.player.velocity.z },
            opponentVel: { x: m.chars.ai.velocity.x, z: m.chars.ai.velocity.z },
            selfClip: m.chars.player.currentActionClip,
            opponentClip: m.chars.ai.currentActionClip,
            tick,
            score: [m.score.player, m.score.ai],
            sets: [m.sets.player, m.sets.ai],
            serveOwner: m.serveOwner,
            phase: m.state,
          };
          send(() => guest.match.applySnapshot(frame, lead), spread);
        }
        while (inFlight.length > 0 && inFlight[0].due <= tick) inFlight.shift()!.apply();
      },
      stepGuest() {
        guest.match.setPlaybackLead(lead);
        guest.match.update(SIM_DT, idle, () => {});
      },
    };
  }

  /**
   * Rallies with set-ups asked for, stepping both ends together — serving
   * whenever the host's player is the one waiting to, so a lost point is
   * followed by the next one rather than by a match standing still.
   */
  function rally(w: Wire, ticks: number, each: (i: number) => void): void {
    for (let i = 0; i < ticks; i++) {
      const m = w.host.match;
      const serving = m.state === "serve_ready" && m.serveOwner === "player";
      const input = serving && i % 30 === 0 ? { strikePressed: true } : i % 24 === 0 ? { popPressed: true } : {};
      w.stepHost(input);
      w.stepGuest();
      each(i);
    }
  }

  /** The host's ball at a fractional host instant, between its two ticks. */
  const hostBallAt = (w: Wire, at: number) => {
    const a = w.ball[Math.floor(at)];
    const b = w.ball[Math.floor(at) + 1];
    if (!a || !b) return null;
    const f = at - Math.floor(at);
    const l = (p: number, q: number) => p + (q - p) * f;
    return { x: l(a.x, b.x), y: l(a.y, b.y), z: l(a.z, b.z), held: a.held || b.held };
  };

  const seeded = (seed: number, spread: number) => {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return Math.floor((s / 0x7fffffff) * spread);
    };
  };

  it("flies the host's own flight, on the host's ticks", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const host = rig();
    const guest = rig({ ui: silentUI() });
    const delay = 4;
    const w = wire(host, guest, delay, () => 0, delay);
    const drawn: { at: number; x: number; y: number; z: number; d: number }[] = [];
    rally(w, 3600, (i) => {
      if (i < 200) return;
      const at = guest.match.renderTick;
      if (at === null) return;
      const truth = hostBallAt(w, at);
      if (!truth || truth.held || guest.match.ball.held) return;
      const p = guest.match.ball.state.pos;
      drawn.push({ at, x: p.x, y: p.y, z: p.z, d: Math.hypot(p.x - truth.x, p.y - truth.y, p.z - truth.z) });
    });

    // A decision the guest could only hear about after its tick — a toss, a
    // deflection off a body, a touch with less notice than the trip — is
    // replayed and faded in. Those windows are the only place the guest may
    // differ from the host at all.
    // Late includes arriving on its own tick: the guest's flight is always a
    // tick ahead of the instant drawn, so it can draw between the two.
    const late = w.launches.filter((l) => l.tick <= l.sentAt + delay).map((l) => l.tick);
    // From the tick before: a deflection happens inside a host step, and the
    // earliest a decision can take effect is the start of the next one.
    const fading = (at: number) => late.some((t) => at >= t - 1 && at < t + 40);
    const steady = drawn.filter((s) => !fading(s.at));
    expect(steady.length).toBeGreaterThan(600);
    // Everywhere else it is not approximately the host's flight: it is the same
    // `stepBall` from the same decisions, to the centimetre.
    expect(steady.filter((s) => s.d >= 0.01)).toEqual([]);
    // And no decision went missing for a snapshot to catch.
    expect(guest.match.guestBallStats.reanchors).toBe(0);
    // Inside a fade the ball still moves like a ball: no step further than the
    // physics speed cap could carry it, which is what a correction taken whole
    // would be.
    for (let i = 1; i < drawn.length; i++) {
      if (Math.abs(drawn[i].at - drawn[i - 1].at - 1) > 0.1) continue;
      const step = Math.hypot(drawn[i].x - drawn[i - 1].x, drawn[i].y - drawn[i - 1].y, drawn[i].z - drawn[i - 1].z);
      expect(step).toBeLessThan(0.45);
    }
  });

  it("sends each touch as exactly the launch the host then plays", () => {
    // The host decides a kick at commit and fires it at contact. If those two
    // ever differ the guest is flying a flight the host never had.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const host = rig();
    const guest = rig({ ui: silentUI() });
    const w = wire(host, guest, 4, () => 0, 4);
    rally(w, 2400, () => {});

    const kicks = w.launches.filter((l) => l.kick && l.tick <= w.tick());
    expect(kicks.length).toBeGreaterThan(6);
    for (const l of kicks) {
      const s: BallState = {
        pos: new Vector3(l.pos.x, l.pos.y, l.pos.z),
        vel: new Vector3(l.vel.x, l.vel.y, l.vel.z),
      };
      stepBall(s, SIM_DT);
      const truth = w.ball[l.tick];
      expect(Math.hypot(s.pos.x - truth.x, s.pos.y - truth.y, s.pos.z - truth.z)).toBeLessThan(1e-6);
    }
  });

  it("launches every touch with time to bend from the striking limb", () => {
    // The old game teleported the ball onto the live bone at contact, which is
    // a different place on every device; nearly half of all touches committed
    // with the limb a quarter of a metre or more from the ball. Now the flight
    // is bent onto the limb's measured point, and that point is the launch —
    // for every touch with at least one tick left to bend over.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const host = rig();
    const guest = rig({ ui: silentUI() });
    const w = wire(host, guest, 4, () => 0, 4);
    const hm = host.match as unknown as { reachableContact: (...a: unknown[]) => { ticks: number } };
    const decided = hm.reachableContact.bind(host.match);
    const notice: number[] = [];
    hm.reachableContact = (...a: unknown[]) => {
      const r = decided(...a);
      notice.push(r.ticks);
      return r;
    };
    const misses: string[] = [];
    let bent = 0;
    host.match.subscribe((e) => {
      if (e.type !== "ball-launched" || e.action === "serve") return;
      const ticks = notice.shift();
      const limb = host[e.side].clipContactPoint(e.clip);
      if (!limb || ticks === undefined || ticks < 2) return;
      bent += 1;
      const d = Vector3.Distance(limb, e.pos);
      if (d > 0.01) misses.push(`${e.clip} ${d.toFixed(3)}`);
    });
    rally(w, 3600, () => {});
    expect(bent).toBeGreaterThan(20);
    expect(misses).toEqual([]);
  });

  it("follows a host running slower than real time, at its pace, without rewinding", () => {
    // A host that cannot hold its match on real time runs fewer ticks than the
    // guest steps. A clock that assumed one tick a step raced ahead of every
    // frame and was snapped back; measured, sixteen per cent was chaos.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const host = rig();
    const guest = rig({ ui: silentUI() });
    const w = wire(host, guest, 5, seeded(3, 3), 5);
    const clocks: number[] = [];
    let owed = 0;
    for (let i = 0; i < 4200; i++) {
      owed += 0.75;
      while (owed >= 1) {
        owed -= 1;
        const m = w.host.match;
        const serving = m.state === "serve_ready" && m.serveOwner === "player";
        w.stepHost(serving && i % 30 === 0 ? { strikePressed: true } : i % 24 === 0 ? { popPressed: true } : {});
      }
      w.stepGuest();
      const at = guest.match.renderTick;
      if (at !== null) clocks.push(at);
    }
    const settled = clocks.slice(900);
    for (let i = 1; i < settled.length; i++) expect(settled[i]).toBeGreaterThanOrEqual(settled[i - 1]);
    expect(guest.match.followerStats.rate).toBeCloseTo(0.75, 1);
    // And the screen keeps the host's pace: over the settled stretch the clock
    // covers what the host did, not a third more.
    const covered = (settled[settled.length - 1] - settled[0]) / (settled.length - 1);
    expect(covered).toBeGreaterThan(0.7);
    expect(covered).toBeLessThan(0.8);
  });

  it("has every decision in hand before its tick when it draws from a buffer", () => {
    // Drawn a measured interval behind the best-routed frame, a guest hears of
    // a kick, a toss or a deflection before the instant it shows — so nothing
    // is replayed into a flight already drawn, and no clip starts late.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const host = rig();
    const guest = rig({ ui: silentUI() });
    const w = wire(host, guest, 5, seeded(11, 5), 5);
    rally(w, 3600, () => {});
    const stats = guest.match.followerStats;
    expect(w.launches.length).toBeGreaterThan(30);
    expect(stats.lateClips).toBe(0);
    expect(stats.replays).toBe(0);
    expect(stats.reanchors).toBe(0);
  });

  it("keeps a running opponent on the host's position instead of trailing it", () => {
    // The correction onto the timeline used to be all of the motion: a fixed
    // fraction of the gap per step and nothing else, so a player running
    // faster than that fraction covered settled a whole `speed × time` behind
    // the one on the timeline and caught up in a lurch. Measured before the
    // velocity was carried: 37 cm one tick in ten, and 90 at worst.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const host = rig();
    const guest = rig({ ui: silentUI() });
    const w = wire(host, guest, 4, () => 0, 4);
    const drawn: { at: number; x: number; z: number }[] = [];
    rally(w, 2700, (i) => {
      const at = guest.match.renderTick;
      if (i < 300 || at === null) return;
      const p = guest.match.chars.ai.position;
      drawn.push({ at, x: p.x, z: p.z });
    });
    const errors = drawn
      .map((d) => {
        const h = w.bodies[Math.round(d.at)];
        return h ? Math.hypot(d.x - h.ai.x, d.z - h.ai.z) : null;
      })
      .filter((e): e is number => e !== null)
      .sort((a, b) => a - b);
    expect(errors.length).toBeGreaterThan(2000);
    expect(errors[Math.floor(errors.length * 0.5)]).toBeLessThan(0.01);
    expect(errors[Math.floor(errors.length * 0.9)]).toBeLessThan(0.2);
  });

  it("stands a player on the host's spot for the whole of a touch", () => {
    // Mid-touch the host moves a player by the lunge and nothing else, so the
    // spot is known exactly — and a player left wherever a 30 Hz feed had
    // carried it was measured twenty centimetres off for a whole kick, with the
    // ball arriving at the host's foot beside it.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const host = rig();
    const guest = rig({ ui: silentUI() });
    const w = wire(host, guest, 5, seeded(7, 4), 6);
    const drawn: { at: number; side: "player" | "ai"; x: number; z: number }[] = [];
    rally(w, 2700, (i) => {
      const at = guest.match.renderTick;
      if (i < 200 || at === null) return;
      for (const side of ["player", "ai"] as const) {
        const c = guest[side];
        if (c.busy && !c.lunging) drawn.push({ at, side, x: c.position.x, z: c.position.z });
      }
    });
    const settled = drawn.filter((d) => w.bodies[Math.round(d.at)]?.[d.side].busy);
    expect(settled.length).toBeGreaterThan(100);
    for (const d of settled) {
      const h = w.bodies[Math.round(d.at)][d.side];
      expect(Math.hypot(d.x - h.x, d.z - h.z), `${d.side} at ${d.at}`).toBeLessThan(0.03);
    }
  });

  it("takes back a touch published ahead when the point ends before its contact", () => {
    // A kick is sent at commit for the tick its limb will arrive on. If the
    // point is over before then the host never plays it — and a guest left
    // holding it would kick a ball nobody kicked.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const host = rig();
    const guest = rig({ ui: silentUI() });
    const w = wire(host, guest, 2, () => 0, 2);
    let pending: Wire["launches"][number] | null = null;
    for (let i = 0; i < 3000 && !pending; i++) {
      w.stepHost(i === 180 ? { strikePressed: true } : i > 180 && i % 24 === 0 ? { popPressed: true } : {});
      w.stepGuest();
      pending = w.launches.find((l) => l.kick && l.tick > w.tick() + 2) ?? null;
    }
    expect(pending).not.toBeNull();
    // The point ends under the wind-up: whatever rule ended it, the countdown
    // reaches a touch that will not be played.
    (host.match as unknown as { state: string }).state = "point";
    while (w.tick() < pending!.tick + 10) {
      w.stepHost();
      w.stepGuest();
    }

    const word = w.launches.filter((l) => l.tick === pending!.tick);
    expect(word.length).toBe(2);
    expect(word[1].kick).toBe(false);
    // The replacement is the ball as it really was at that tick: no kick in it.
    const s: BallState = {
      pos: new Vector3(word[1].pos.x, word[1].pos.y, word[1].pos.z),
      vel: new Vector3(word[1].vel.x, word[1].vel.y, word[1].vel.z),
    };
    stepBall(s, SIM_DT);
    const truth = w.ball[pending!.tick];
    expect(Math.hypot(s.pos.x - truth.x, s.pos.y - truth.y, s.pos.z - truth.z)).toBeLessThan(1e-6);
    // And the guest, told in time, flies the unkicked ball.
    const at = guest.match.renderTick!;
    const g = guest.match.ball.state.pos;
    const h = hostBallAt(w, at);
    if (!guest.match.ball.held && h && !h.held) {
      expect(Math.hypot(g.x - h.x, g.y - h.y, g.z - h.z)).toBeLessThan(0.05);
    }
  });

  it("lands every contact frame on the tick the host's ball turned, on a jittery link", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const host = rig();
    const guest = rig({ ui: silentUI() });
    /** When a started clip's limb meets the ball, and how long its wind-up had. */
    const contactOf = (at: number, name: string, startFrac: number, speed: number) => {
      const c = CLIPS[name];
      if (!c || c.contact < 0 || c.contact / c.frames <= startFrac) return null;
      const windup = ((c.contact / c.frames - startFrac) * c.frames) / speed;
      return { at: at + windup, windup };
    };
    const hostContacts: { at: number; windup: number }[] = [];
    const guestContacts: { at: number; windup: number }[] = [];
    let hostTick = 0;
    const watch = (r: Rig, clock: () => number, into: typeof hostContacts) => {
      for (const side of ["player", "ai"] as const) {
        const c = r[side];
        const play = c.playAction.bind(c);
        c.playAction = (name, opts = {}) => {
          const ok = play(name, opts);
          // Placed on the clock from its start tick when one is given — which is
          // what a guest does with the host's — not from when it was called.
          // And from the start a character actually uses, head frames floored.
          const from = Math.max(opts.startFrac ?? 0, clipStartFraction(name));
          const contact = ok ? contactOf(opts.startTick ?? clock(), name, from, opts.speed ?? 1) : null;
          if (contact) into.push(contact);
          return ok;
        };
      }
    };
    watch(host, () => hostTick + 1, hostContacts);
    watch(guest, () => guest.match.renderTick ?? NaN, guestContacts);
    // Five ticks there, plus up to four of jitter, and a lead that puts the
    // guest's clock at about the host's.
    const worstTrip = 5 + 4 + 2;
    const w = wire(host, guest, 5, seeded(99, 5), 7);
    rally(w, 3600, () => {
      hostTick = w.tick();
    });

    // No contact is ever shown at the wrong moment: every limb the guest
    // brings to the ball arrives on the tick the host's did, however late the
    // decision was — a late wind-up is hurried or started further in, never
    // slid past its contact.
    expect(guestContacts.length).toBeGreaterThan(10);
    for (const g of guestContacts) {
      expect(hostContacts.some((h) => Math.abs(g.at - h.at) <= 1.01), `guest contact at ${g.at}`).toBe(true);
    }
    // And every touch whose wind-up outlasted the trip is shown. A shorter one
    // was over before anyone could have been told; that is the one thing no
    // design on a real link can put on time.
    const reachable = hostContacts.filter((h) => h.windup > worstTrip);
    expect(reachable.length).toBeGreaterThan(10);
    for (const h of reachable) {
      expect(guestContacts.some((g) => Math.abs(g.at - h.at) <= 1.01), `host contact at ${h.at}`).toBe(true);
    }
  });
});

describe("the end of an online match", () => {
  it("sends the winner's celebration, which no clip table lists", () => {
    // `CLIPS` holds the clips with a contact to time. The match-win
    // celebrations meet no ball and are in no table, and publishing only what
    // the table knew meant a guest's winner stood still at the final whistle.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const host = rig();
    host.player.groups.set("EndOfGameVictory", { from: 0, to: 240 });
    host.ai.groups.set("EndOfGameVictory", { from: 0, to: 240 });
    host.match.netPublish = true;
    const cpu = new AIController(host.match, DIFFICULTIES.normal);
    const m = host.match as unknown as { score: { player: number; ai: number }; sets: { player: number; ai: number } };
    const clips: string[] = [];
    let tick = 0;
    for (let i = 0; i < 20_000 && host.match.state !== "over"; i++) {
      if (i === 10) {
        m.score.player = WIN_SCORE - 1;
        m.score.ai = WIN_SCORE - 1;
        m.sets.player = SETS_TO_WIN - 1;
        m.sets.ai = SETS_TO_WIN - 1;
      }
      const input = i === 180 ? { strikePressed: true } : i > 180 && i % 24 === 0 ? { popPressed: true } : {};
      host.match.update(SIM_DT, { ...idle, ...input }, (dt) => cpu.update(dt));
      tick += 1;
      host.match.drainNet(tick);
    }
    host.match.drainNet(tick + 1);
    for (const e of host.match.takeNetEvents()) if (e.type === "clip" && e.clip) clips.push(e.clip);

    expect(host.match.state).toBe("over");
    const winner = host.match.matchWinner!;
    const celebrated = host[winner].currentActionClip;
    expect(celebrated).toBe("EndOfGameVictory");
    expect(clips).toContain("EndOfGameVictory");
  });
});
