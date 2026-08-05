/**
 * One online match: the wiring between the socket, the remote opponent and the
 * match controller.
 *
 * Both peers experience themselves as the near side with the primary camera,
 * so the guest's world is the host's reflected through the net. Everything
 * crossing the wire passes through `reframe`, which makes that the only place
 * the asymmetry lives — the match, the remote player and the UI all work in
 * local coordinates and never learn which peer they are.
 *
 * Authority is split along the line that matters. The ball is resynchronised by
 * whoever strikes it, because that is latency-sensitive and uncontended. The
 * score is the host's, because two peers disagreeing about a point is worse
 * than a peer waiting a round trip to hear about one.
 */

import type { MatchController, MatchEvent } from "../match";
import type { Side } from "../ball";
import type { NetConnection } from "./connection";
import { RemotePlayer } from "./remote";
import {
  isValidMove,
  isValidStrike,
  reframe,
  vec,
  type GameMessage,
  type PeerRole,
} from "./protocol";

/** Pose updates per second. Well below the simulation rate; smoothing covers the gap. */
const MOVE_HZ = 20;

export interface SessionHandlers {
  /** The opponent has been quiet this long (seconds); the UI may warn. */
  onStale?: (seconds: number) => void;
  /** Authoritative score from the host, for a guest to display. */
  onScore?: (score: { player: number; ai: number; sets: [number, number]; serveOwner: Side }) => void;
}

export class OnlineSession {
  readonly remote = new RemotePlayer();
  private tick = 0;
  private sinceMove = 0;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(
    private conn: NetConnection,
    private match: MatchController,
    readonly role: PeerRole,
    private handlers: SessionHandlers = {}
  ) {
    match.versus = true;
    match.remote = this.remote;
    this.unsubscribe = match.subscribe((e) => this.onMatchEvent(e));
    conn.setHandlers({ onMessage: (msg) => this.onNetMessage(msg) });
  }

  get isHost(): boolean {
    return this.role === "host";
  }

  /**
   * Outbound. Every launch the local player produces is authoritative for the
   * flight that follows, so it goes out immediately rather than on the next
   * pose tick — a strike delayed by up to a frame is a strike the opponent
   * sees late for the whole rally.
   */
  private onMatchEvent(e: MatchEvent): void {
    if (this.disposed) return;

    if (e.type === "ball-launched") {
      // The remote player's own launches arrive from the wire; echoing them
      // back would have each peer re-applying the other's ball.
      if (e.side !== "player") return;
      this.conn.send(
        reframe(
          {
            t: "strike",
            tick: this.tick,
            pos: vec(e.pos),
            vel: vec(e.vel),
            clip: e.clip,
            spin: e.spin,
          },
          this.role
        )
      );
      return;
    }

    // Only the host announces points; a guest's local rule engine is a
    // prediction that the host's message confirms or corrects.
    if (e.type === "point-awarded" && this.isHost) {
      this.conn.send(
        reframe({ t: "point", tick: this.tick, winner: e.winner, reason: e.reason }, this.role)
      );
    }
  }

  /** Inbound. Everything is validated before it can touch the simulation. */
  private onNetMessage(raw: GameMessage): void {
    if (this.disposed) return;
    const msg = reframe(raw, this.role);

    switch (msg.t) {
      case "move":
        if (isValidMove(msg)) this.remote.onMove(msg);
        return;

      case "strike":
        // A NaN here would poison every later step of the ball, so a malformed
        // frame is dropped rather than trusted.
        if (isValidStrike(msg)) this.remote.onStrike(msg, this.match.ball.state, this.tick);
        return;

      case "state":
        if (this.isHost) return; // the host is the source; it never takes one
        this.handlers.onScore?.({
          player: msg.scorePlayer,
          ai: msg.scoreAi,
          sets: [msg.setsPlayer, msg.setsAi],
          serveOwner: msg.serveOwner,
        });
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
    this.tick++;
    this.conn.tick = this.tick;

    this.sinceMove += dt;
    if (this.sinceMove >= 1 / MOVE_HZ) {
      this.sinceMove = 0;
      this.sendPose();
    }

    const silent = this.remote.silentFor();
    if (silent > 1) this.handlers.onStale?.(silent);
  }

  private sendPose(): void {
    const me = this.match.chars.player;
    this.conn.send(
      reframe(
        {
          t: "move",
          tick: this.tick,
          pos: vec(me.position),
          yaw: 0,
          moveX: me.velocity.x,
          moveZ: me.velocity.z,
        },
        this.role
      )
    );
  }

  /** Host only: publish the authoritative score. */
  publishScore(): void {
    if (!this.isHost || this.disposed) return;
    this.conn.send(
      reframe(
        {
          t: "state",
          tick: this.tick,
          scorePlayer: this.match.score.player,
          scoreAi: this.match.score.ai,
          setsPlayer: this.match.sets.player,
          setsAi: this.match.sets.ai,
          serveOwner: this.match.serveOwner,
          phase: this.match.state,
        },
        this.role
      )
    );
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.match.remote = null;
    this.conn.setHandlers({ onMessage: undefined });
  }
}
