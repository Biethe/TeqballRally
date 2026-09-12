/**
 * One online match: the wiring between the socket and the match controller.
 *
 * Both peers experience themselves as the near side with the primary camera,
 * so the guest's world is the host's reflected through the net. Everything
 * crossing the wire passes through `reframe`, which makes that the only place
 * the asymmetry lives — the match and the UI work in local coordinates and
 * never learn which peer they are.
 *
 * The host runs the only match. The guest sends what its controls are doing and
 * renders the frames it is sent, running no rules of its own — two rule engines
 * fed by different inputs disagree within a single rally, which is exactly what
 * an earlier design of this did.
 */

import type { MatchController } from "../match";
import type { InputState } from "../input";
import type { Side } from "../ball";
import type { NetConnection } from "./connection";
import { TickAge } from "./sync";
import {
  isValidFx,
  isValidInput,
  readLoft,
  readStrikeable,
  readTaps,
  readTouches,
  readViewTick,
  isValidPause,
  isValidRematch,
  isValidSnapshot,
  isScorePair,
  reframe,
  vec,
  type GameMessage,
  type PeerRole,
} from "./protocol";

/**
 * Authoritative frames per second. Guests play the ball back from a buffer
 * of them.
 *
 * 30 rather than 20: a launch or a steer that happens between two frames can
 * only be shown with the frames' resolution, so the coarser the grid the
 * larger the visible kink when it arrives. A frame is a couple of hundred
 * bytes; the extra third of the traffic buys a third off every one of those
 * kinks.
 */
const SNAPSHOT_HZ = 30;

/**
 * Jitter margin added to the measured lead, in ticks, at most.
 *
 * The lead wants to be the transport delay and nothing more, but a link whose
 * delay wanders would leave the guest reading a moment the frames have not
 * reached, which reads as a stall. A couple of ticks of headroom absorbs the
 * ordinary wander; past that the correction handles it, because leading too
 * far is a worse trade than a small tail.
 */
const LEAD_JITTER_CAP_TICKS = 3;

/**
 * Silence long enough to call the opponent absent.
 *
 * Traffic flows every step or every 50 ms, so a second of nothing is already
 * abnormal; two gives a hiccup room to recover without the player seeing a
 * warning for a blip that fixed itself.
 */
export const ABSENT_AFTER_SECONDS = 2;

/**
 * How long an absent opponent has to come back before forfeiting.
 *
 * Counted from the moment absence is detected, so a walkout costs the waiting
 * player about twelve seconds in the worst case rather than stranding them in
 * a match that can never end.
 */
export const DISCONNECT_GRACE_SECONDS = 10;

/**
 * How long a pause request waits for an answer before giving up.
 *
 * An opponent who has put the phone down should not leave the asker staring at
 * a dialog, so silence becomes a decline rather than an open question.
 */
export const PAUSE_REQUEST_TIMEOUT_SECONDS = 15;

/**
 * How long a rematch request waits for an answer before giving up.
 *
 * Same reading as the pause: silence is a decline, and the asker is returned
 * to the result screen rather than left standing in front of a question.
 */
export const REMATCH_REQUEST_TIMEOUT_SECONDS = 15;

/**
 * Where a pause negotiation stands.
 *
 * "asking" and "asked" are the two sides of the same moment, kept apart
 * because only one of them may answer and only the other may withdraw.
 */
export type PauseState = "none" | "asking" | "asked" | "paused";

/**
 * Where a rematch negotiation stands.
 *
 * No fourth state: completion starts the new match at once, so there is
 * nothing to sit in. Both peers act on the same completed transition.
 */
export type RematchState = "none" | "asking" | "asked";

export interface SessionHandlers {
  /**
   * The opponent is missing; `secondsLeft` counts down to a forfeit. Called
   * every step while absent, so the UI can show a live countdown.
   */
  onOpponentAbsent?: (secondsLeft: number) => void;
  /** The opponent came back before the grace ran out. */
  onOpponentReturned?: () => void;
  /** The grace expired. The local player wins by default; fired once. */
  onOpponentForfeit?: () => void;
  /** Authoritative score from the host, for a guest to display. */
  onScore?: (score: { player: number; ai: number; sets: [number, number]; serveOwner: Side }) => void;
  /** The pause negotiation moved. `state` is what to show now. */
  onPauseState?: (state: PauseState, detail?: string) => void;
  /** The rematch negotiation moved. `state` is what to show now. */
  onRematchState?: (state: RematchState, detail?: string) => void;
  /**
   * The rematch was agreed on both sides. Fired exactly once; both peers
   * reset their match on it, and the relay mints a fresh match id for the
   * new one.
   */
  onRematch?: () => void;
  /** The relay minted a fresh match id for both seats (the new match's name). */
  onMatchId?: (id: string) => void;
}

export class OnlineSession {
  private tick = 0;
  private sinceMove = 0;
  private disposed = false;
  private peerPresent = true;
  /**
   * Seconds since any traffic arrived from the opponent.
   *
   * Owned here rather than by anything inside the match, whose clocks only
   * advance during a rally — an opponent who walks out between points would
   * otherwise never be noticed at all.
   */
  private sinceMessage = 0;
  /** Seconds the opponent has been absent, or 0 while they are present. */
  private absentFor = 0;
  /** A forfeit is announced once; the match cannot be won twice. */
  private forfeited = false;
  /**
   * Whether a pause may be asked for at all. Private games only: in a quick
   * match the opponent is a stranger, and a pause is then a way to stall.
   */
  pauseAllowed = false;
  private pause: PauseState = "none";
  private pauseWait = 0;
  /** The rematch negotiation, from the end screen. */
  private rematch: RematchState = "none";
  private rematchWait = 0;
  /**
   * True once the current rematch's reset has run, so a second signal
   * (`newmatch` arriving after the local agreement) cannot reset twice.
   */
  private rematchStarted = false;
  /** Guest presses awaiting a simulation step on the host. */
  private pendingGuest = { strike: false, pop: false, confirm: false };
  /** Guest: the age of each arriving snapshot, measured off its tick stamp. */
  private snapAge = new TickAge();
  /** Latest jitter reading from `snapAge`: age above the best route seen. */
  private snapJitter = 0;
  /** Guest: this frame's controls, latched until sent. */
  private localInput: InputState = {
    moveX: 0,
    moveZ: 0,
    strikePressed: false,
    strikeHeld: false,
    strikePower: 0,
    popPressed: false,
    confirmPressed: false,
  };

  constructor(
    private conn: NetConnection,
    private match: MatchController,
    readonly role: PeerRole,
    private handlers: SessionHandlers = {}
  ) {
    match.versus = true;
    // The host publishes clip windows and contact events alongside snapshots;
    // a guest has nothing to publish.
    if (this.isHost) match.netPublish = true;
    conn.setHandlers({
      onMessage: (msg) => this.onNetMessage(msg),
      // The relay broadcasts the fresh match id to both seats. Driving the
      // reset from it (rather than the direct `accept` packet) means a dropped
      // accept can never leave one player stranded on the result screen while
      // the other is already playing.
      onMatchId: (id) => this.onRelayMatchId(id),
      // A clean disconnect is reported by the relay; silence is noticed by the
      // step loop. Either starts the same countdown. A rematch left hanging in
      // the air is simply closed — there is nobody to play it with.
      onPeer: (present) => {
        this.peerPresent = present;
        if (!present && this.rematch !== "none") {
          this.setRematch("none", "Your opponent left");
        }
      },
    });
  }

  get isHost(): boolean {
    return this.role === "host";
  }

  /** True while the match should not advance on either peer. */
  get isPaused(): boolean {
    return this.pause === "paused";
  }

  get pauseState(): PauseState {
    return this.pause;
  }

  private setPause(next: PauseState, detail?: string): void {
    if (this.pause === next) return;
    this.pause = next;
    this.pauseWait = 0;
    this.handlers.onPauseState?.(next, detail);
  }

  /** Ask the opponent to pause. Ignored if a negotiation is already running. */
  requestPause(): void {
    if (!this.pauseAllowed || this.disposed || this.pause !== "none") return;
    this.conn.send({ t: "pause", action: "request" });
    this.setPause("asking");
  }

  /** Answer an opponent's request. */
  respondToPause(accept: boolean): void {
    if (this.pause !== "asked") return;
    this.conn.send({ t: "pause", action: accept ? "accept" : "decline" });
    this.setPause(accept ? "paused" : "none");
  }

  /** End a pause. Either player may, so neither can hold the other hostage. */
  resume(): void {
    if (this.pause !== "paused") return;
    this.conn.send({ t: "pause", action: "resume" });
    this.setPause("none");
  }

  private onPauseMessage(action: "request" | "accept" | "decline" | "resume"): void {
    switch (action) {
      case "request":
        // A request arriving mid-negotiation is answered by the state it finds:
        // already paused means yes, anything else means the two crossed and the
        // asker's own request stands.
        if (this.pause === "paused") this.conn.send({ t: "pause", action: "accept" });
        else if (this.pause === "none") this.setPause("asked");
        return;
      case "accept":
        if (this.pause === "asking") this.setPause("paused");
        return;
      case "decline":
        if (this.pause === "asking") this.setPause("none", "Your opponent declined");
        return;
      case "resume":
        if (this.pause === "paused") this.setPause("none");
        return;
    }
  }

  private setRematch(next: RematchState, detail?: string): void {
    if (this.rematch === next) return;
    this.rematch = next;
    this.rematchWait = 0;
    // A fresh negotiation can lead to another rematch; let the next `newmatch`
    // drive a new reset rather than being ignored by the `started` guard.
    if (next === "asking" || next === "asked") this.rematchStarted = false;
    this.handlers.onRematchState?.(next, detail);
  }

  get rematchState(): RematchState {
    return this.rematch;
  }

  /**
   * Ask for another match, from the end screen. Allowed in quick matches too:
   * both players already agreed to be paired, and the stall the pause gate
   * exists for does not apply to a match that has already ended.
   */
  requestRematch(): void {
    if (this.disposed) return;
    // Pressing REMATCH while the opponent is already asking is an answer.
    if (this.rematch === "asked") {
      this.respondToRematch(true);
      return;
    }
    if (this.rematch !== "none") return;
    if (!this.peerPresent) {
      this.setRematch("none", "Your opponent left");
      return;
    }
    // A rematch restarts a finished match; during play the button means nothing.
    if (this.match.matchWinner === null && this.match.state !== "over") return;
    this.conn.send({ t: "rematch", action: "request" });
    this.setRematch("asking");
  }

  /** Answer an opponent's rematch request. */
  respondToRematch(accept: boolean): void {
    if (this.rematch !== "asked") return;
    this.conn.send({ t: "rematch", action: accept ? "accept" : "decline" });
    if (accept) this.beginRematch();
    else this.setRematch("none");
  }

  private onRematchMessage(action: "request" | "accept" | "decline"): void {
    switch (action) {
      case "request":
        // Two players pressing REMATCH at once is an agreement, not a race:
        // answer the crossing request and start.
        if (this.rematch === "asking") {
          this.conn.send({ t: "rematch", action: "accept" });
          this.beginRematch();
        } else if (
          this.rematch === "none" &&
          (this.match.matchWinner !== null || this.match.state === "over")
        ) {
          this.setRematch("asked");
        }
        return;
      case "accept":
        if (this.rematch === "asking") this.beginRematch();
        return;
      case "decline":
        if (this.rematch === "asking") this.setRematch("none", "Your opponent declined");
        return;
    }
  }

  /**
   * Both sides agreed; the new match starts now. The host asks the relay for
   * the fresh match id, and the reset itself is driven by the relay's
   * `newmatch` broadcast (see `onRelayMatchId`) so it reaches both seats
   * reliably — not from the `accept` packet, which a single dropped frame can
   * lose and leave one player on the result screen.
   */
  private beginRematch(): void {
    if (this.rematch !== "asking" && this.rematch !== "asked") return;
    this.setRematch("none");
    if (this.isHost) this.conn.newMatch();
    // Restart this peer at once for responsiveness. The `newmatch` that
    // follows re-drives both seats idempotently, so neither can miss it.
    this.startRematch();
  }

  /**
   * Run the actual match reset on both peers.
   *
   * Called locally from `beginRematch` for immediacy and by `onRelayMatchId`
   * when the relay's `newmatch` arrives — the broadcast form is what makes the
   * restart survive a dropped `accept` packet. The `rematchStarted` guard
   * makes the second call a no-op.
   */
  private startRematch(): void {
    if (this.rematchStarted) return;
    // Only a finished match is being replayed; a stray call mid-play is ignored.
    if (this.match.matchWinner === null && this.match.state !== "over") return;
    this.rematchStarted = true;
    this.pendingGuest = { strike: false, pop: false, confirm: false };
    this.localInput = {
      ...this.localInput,
      strikePressed: false,
      strikeHeld: false,
      popPressed: false,
      confirmPressed: false,
    };
    // The last input of the old match may still be sitting on the second
    // seat; its presses belong to a match that has ended.
    this.match.versusInput = {
      ...this.match.versusInput,
      strikePressed: false,
      strikeHeld: false,
      strikePower: 0,
      popPressed: false,
      confirmPressed: false,
    };
    this.handlers.onRematch?.();
  }

  /** The relay minted a fresh match id for both seats — the reliable restart. */
  private onRelayMatchId(id: string): void {
    this.handlers.onMatchId?.(id);
    this.startRematch();
  }

  /** Inbound. Everything is validated before it can touch the simulation. */
  private onNetMessage(raw: GameMessage): void {
    if (this.disposed) return;
    // Any frame at all proves the opponent is still there.
    this.sinceMessage = 0;
    const msg = reframe(raw, this.role);

    switch (msg.t) {
      // Host: the guest's controls. Fed into the same field a second local
      // controller would drive, so online reuses the tested split-screen path
      // rather than a parallel one.
      case "input": {
        if (!this.isHost || !isValidInput(msg)) return;
        // Which scheme the guest is playing with, so the host reads their axes
        // as the thing they meant. Absent means an older peer, and landscape.
        this.match.versusPortrait = msg.portrait === true;
        // The instant their screen was showing when they pressed. The reach
        // test and the limb choice are read there rather than here, so a
        // press means what the player meant by it. Undefined for a peer too
        // old to say, and the match then judges live as it used to.
        this.match.versusViewTick = readViewTick(msg.viewTick, this.tick) ?? null;
        this.match.versusInput = {
          moveX: msg.moveX,
          moveZ: msg.moveZ,
          // Presses latch until a simulation step consumes them, for the same
          // reason local input does: the guest's frame rate is not ours.
          strikePressed: this.pendingGuest.strike || msg.strike,
          // A held kick is a level, not a press: it is never latched, and an
          // older peer that does not send it simply never charges one.
          strikeHeld: msg.hold === true,
          strikePower: typeof msg.power === "number" ? msg.power : 0,
          strikeTaps: readTaps(msg.taps),
          strikeLoft: readLoft(msg.loft),
          popPressed: this.pendingGuest.pop || msg.pop,
          confirmPressed: this.pendingGuest.confirm || msg.confirm,
          tapAim: msg.tapAim === true,
        };
        this.pendingGuest.strike = this.match.versusInput.strikePressed;
        this.pendingGuest.pop = this.match.versusInput.popPressed;
        this.pendingGuest.confirm = this.match.versusInput.confirmPressed;
        return;
      }

      // Guest: the authoritative frame. Already reflected and seat-swapped by
      // reframe, so it is in this peer's own coordinates.
      case "snap": {
        if (this.isHost || !isValidSnapshot(msg)) return;
        // How old this frame already is. Two measures, because neither is
        // enough alone: the round trip gives the route's absolute delay, and
        // the estimator — which calibrates out the peers' unrelated clock
        // origins — gives how far this particular frame ran behind the best
        // route it has seen. The match carries everything in the frame forward
        // by the total, so the ball and both players are drawn at the same
        // instant rather than the ball being shown half a trip in the past.
        this.snapJitter = this.snapAge.observe(this.tick - msg.tick);
        const lead = this.leadTicks();
        this.match.applySnapshot({
          ballPos: msg.ballPos,
          ballVel: msg.ballVel,
          ballHeld: msg.ballHeld,
          // After reframe, hostPos is this peer and guestPos is the opponent.
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
          selfClipSeq: msg.hostClipSeq,
          opponentClipSeq: msg.guestClipSeq,
          selfLocked: msg.hostLocked === true,
          // After reframe, hostAnchor is this peer's own.
          selfAnchor: msg.hostAnchor ?? null,
          selfAnchorEta: msg.hostAnchorEta,
          // After reframe these are already in this peer's seat names.
          strikeable: readStrikeable(msg.strikeable),
          touches: readTouches(msg.touches),
          serveClock: typeof msg.serveClock === "number" ? msg.serveClock : undefined,
          tally: isScorePair(msg.tally) ? msg.tally : undefined,
          rallies: Number.isFinite(msg.rallies) ? msg.rallies : undefined,
          tick: msg.tick,
          score: msg.score,
          sets: msg.sets,
          serveOwner: msg.serveOwner,
          phase: msg.phase,
        }, lead);
        this.handlers.onScore?.({
          player: msg.score[0],
          ai: msg.score[1],
          sets: msg.sets,
          serveOwner: msg.serveOwner,
        });
        return;
      }

      // Guest: a contact to play when the playback clock reaches its tick.
      case "fx": {
        if (this.isHost || !isValidFx(msg)) return;
        this.match.queueFx({ tick: msg.tick, kind: msg.kind });
        return;
      }

      case "pause":
        if (isValidPause(msg)) this.onPauseMessage(msg.action);
        return;

      case "rematch":
        if (isValidRematch(msg)) this.onRematchMessage(msg.action);
        return;

      default:
        return;
    }
  }

  /**
   * Advance one simulation step. Called from the fixed-step loop so the tick
   * stamped on outgoing messages is the same clock the receiver fast-forwards
   * against.
   */
  step(dt: number): void {
    if (this.disposed) return;
    // Frozen during a negotiated pause, on both peers at once, so the tick
    // stays the one time base: snapshots, clip windows and fx events are all
    // stamped in it, and the match stands still while it does.
    if (!this.isPaused) this.tick++;
    this.conn.tick = this.tick;

    if (this.isHost) {
      // Where the ball is on this tick, kept so a guest's press can be judged
      // against the moment it was made rather than the moment it landed here.
      this.match.recordBallAt(this.tick);
      // What the sim produced this step — contact events and clip starts —
      // leaves stamped in this step's tick, beside the snapshots.
      for (const fx of this.match.drainNet(this.tick)) {
        this.conn.send(reframe({ t: "fx", tick: this.tick, kind: fx.kind, pos: fx.pos }, this.role));
      }
      // The host holds the only match, so it publishes; the guest has nothing
      // authoritative to say beyond what its controls are doing.
      this.sinceMove += dt;
      if (this.sinceMove >= 1 / SNAPSHOT_HZ) {
        this.sinceMove = 0;
        this.sendSnapshot();
      }
      // Presses handed to the match this step are spent.
      this.pendingGuest = { strike: false, pop: false, confirm: false };
    } else {
      // Every step, because the route can change under a phone that is
      // walking between cells.
      this.match.setPlaybackLead(this.leadTicks());
      this.sendInput();
    }

    // Traffic keeps flowing while paused, so a pause is never mistaken for a
    // disconnect and an opponent who really does vanish is still noticed.
    if (this.pause === "asking") {
      this.pauseWait += dt;
      if (this.pauseWait > PAUSE_REQUEST_TIMEOUT_SECONDS) {
        this.setPause("none", "No answer from your opponent");
      }
    }
    // An unanswered rematch request returns the asker to the result screen.
    if (this.rematch === "asking") {
      this.rematchWait += dt;
      if (this.rematchWait > REMATCH_REQUEST_TIMEOUT_SECONDS) {
        this.setRematch("none", "No answer from your opponent");
      }
    }

    this.trackPresence(dt);
  }

  /**
   * How far behind the host this peer's newest frame already is, in ticks.
   *
   * Half the round trip, plus the snapshot grid the newest frame sits on, plus
   * a little headroom for a link whose delay wanders. `latencyTicks` is the
   * absolute measure and has to be the base: `snapAge` reports age *above the
   * best route it has seen*, so on a steady link it reads near zero however
   * far away the host is.
   *
   * Both the screen's lead and the reconcile target are read off this, so the
   * character being corrected and the ball beside it describe one instant.
   */
  private leadTicks(): number {
    return this.conn.latencyTicks + 1 + Math.min(LEAD_JITTER_CAP_TICKS, this.snapJitter);
  }

  /** Guest: the local player's controls, every step. */
  private sendInput(): void {
    const held = this.localInput;
    this.conn.send(
      reframe(
        {
          t: "input",
          tick: this.tick,
          // The host instant this screen was showing, so the press is judged
          // against the ball the player was looking at rather than the one a
          // trip later. Undefined before the first frame arrives.
          viewTick: this.match.renderTick ?? undefined,
          moveX: held.moveX,
          moveZ: held.moveZ,
          strike: held.strikePressed,
          hold: held.strikeHeld,
          power: held.strikePower,
          taps: held.strikeTaps,
          loft: held.strikeLoft,
          pop: held.popPressed,
          confirm: held.confirmPressed,
          // Read off the match rather than latched with the presses: the
          // scheme is a property of how this phone is being held right now,
          // and a player who turns the device mid-rally has to be understood
          // from the next frame on.
          portrait: this.match.tapSteering,
          tapAim: held.tapAim,
        },
        this.role
      )
    );
    // Edges are sent once; axes persist until the next frame overwrites them.
    this.localInput = {
      ...held,
      strikePressed: false,
      strikePower: 0,
      strikeTaps: undefined,
      strikeLoft: undefined,
      popPressed: false,
      confirmPressed: false,
      tapAim: undefined,
    };
  }

  /**
   * Guest: record this step's controls for sending. Called by the game loop
   * with the same input the local match would have used, so a press is never
   * observed by one and missed by the other.
   */
  setLocalInput(input: InputState): void {
    this.localInput = {
      moveX: input.moveX,
      moveZ: input.moveZ,
      strikePressed: this.localInput.strikePressed || input.strikePressed,
      strikeHeld: input.strikeHeld,
      strikePower: input.strikePressed ? input.strikePower : this.localInput.strikePower,
      strikeTaps: input.strikePressed ? input.strikeTaps : this.localInput.strikeTaps,
      strikeLoft: input.strikePressed ? input.strikeLoft : this.localInput.strikeLoft,
      popPressed: this.localInput.popPressed || input.popPressed,
      confirmPressed: this.localInput.confirmPressed || input.confirmPressed,
      // Travels with the axes it describes, not with the presses: it says what
      // this frame's numbers mean.
      tapAim: input.tapAim,
    };
  }

  /** Host: publish the whole authoritative frame in one message. */
  private sendSnapshot(): void {
    const ball = this.match.ball;
    // A window only describes the clip currently playing; a stale window from
    // the previous action must not ride out beside a different clip.
    const win = (side: "player" | "ai") => {
      const clip = this.match.chars[side].currentActionClip;
      const w = this.match.clipWindow[side];
      return w && w.clip === clip ? w : null;
    };
    const hostWin = win("player");
    const guestWin = win("ai");
    const anchorOf = (side: "player" | "ai") => {
      const a = this.match.anchorState[side];
      return a ? vec(a.pos) : null;
    };
    this.conn.send(
      reframe(
        {
          t: "snap",
          tick: this.tick,
          ballPos: vec(ball.state.pos),
          ballVel: vec(ball.state.vel),
          ballHeld: ball.held,
          hostPos: vec(this.match.chars.player.position),
          guestPos: vec(this.match.chars.ai.position),
          hostVel: vec(this.match.chars.player.velocity),
          guestVel: vec(this.match.chars.ai.velocity),
          hostClip: this.match.chars.player.currentActionClip,
          guestClip: this.match.chars.ai.currentActionClip,
          hostClipFrom: hostWin?.from,
          hostClipTo: hostWin?.to,
          guestClipFrom: guestWin?.from,
          guestClipTo: guestWin?.to,
          hostClipSeq: hostWin?.seq,
          guestClipSeq: guestWin?.seq,
          hostLocked: this.match.lockedState.player,
          guestLocked: this.match.lockedState.ai,
          // Where each seat's assist is pulling, so a predicted character can
          // be pulled the same way instead of walking on a bare stick.
          hostAnchor: anchorOf("player"),
          hostAnchorEta: this.match.anchorState.player?.eta,
          guestAnchor: anchorOf("ai"),
          guestAnchorEta: this.match.anchorState.ai?.eta,
          // Possession, in the host's seat names. The guest needs it to know
          // whether a tap on the court means "play the ball" or "walk there".
          strikeable:
            this.match.strikeableSide === null
              ? null
              : this.match.strikeableSide === "player"
                ? "host"
                : "guest",
          touches: this.match.touchCount,
          serveClock: this.match.serveClockLeft ?? undefined,
          score: [this.match.score.player, this.match.score.ai],
          // What the match is worth, which only the side running the rules can
          // count. Without it a guest reports a win it cannot prove.
          tally: [this.match.tally.points.player, this.match.tally.points.ai],
          rallies: this.match.tally.longRallies,
          sets: [this.match.sets.player, this.match.sets.ai],
          serveOwner: this.match.serveOwner,
          phase: this.match.state,
        },
        this.role
      )
    );
  }

  /**
   * Watch for an opponent who has stopped playing, and forfeit the match to
   * the local player once the grace period runs out. Without this a walkout
   * leaves the other player in a match that can never end.
   */
  private trackPresence(dt: number): void {
    if (this.forfeited) return;
    this.sinceMessage += dt;
    // A finished match is finished on both screens: an opponent who walks out
    // of the result screen is not an opponent who walked out of the match, and
    // awarding a walkover here would hand the loser a win they lost.
    if (this.match.matchWinner !== null) return;
    // Our own socket is down and being retried. Nothing can arrive through it,
    // so the silence says nothing about the opponent — and awarding ourselves
    // the match because our phone changed network would be a walkover claimed
    // by the player who actually left. The clock is held, not reset: if the
    // retries run out the connection fails on its own terms.
    if (this.conn.isReconnecting) return;
    const absent = !this.peerPresent || this.sinceMessage > ABSENT_AFTER_SECONDS;

    if (!absent) {
      if (this.absentFor > 0) {
        this.absentFor = 0;
        this.handlers.onOpponentReturned?.();
      }
      return;
    }

    this.absentFor += dt;
    const left = Math.max(0, DISCONNECT_GRACE_SECONDS - this.absentFor);
    this.handlers.onOpponentAbsent?.(left);
    if (left <= 0) {
      this.forfeited = true;
      this.handlers.onOpponentForfeit?.();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.conn.setHandlers({ onMessage: undefined });
  }
}
