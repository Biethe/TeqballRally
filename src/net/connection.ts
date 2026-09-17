/**
 * Client half of the match relay.
 *
 * Owns the socket, the room handshake and the round-trip estimate, and hands
 * decoded game messages to a listener. It deliberately knows nothing about the
 * match: `MatchController` reaches it through the `ball-launched` event and a
 * small inbound API, so neither side depends on the other's internals.
 *
 * `tick` is set by the caller once per simulation step. Every outgoing message
 * is stamped with it, which is what lets the receiver fast-forward a late
 * packet to the present (see `applyStrike` in ./protocol).
 */

import {
  PROTOCOL_VERSION,
  decode,
  encode,
  type GameMessage,
  type NetMessage,
  type PeerIdentity,
  type PeerRole,
} from "./protocol";

/**
 * A game message minus its tick, which `send` fills in when the message does
 * not name one.
 *
 * The conditional is what makes this distribute across the union: a plain
 * `Omit<GameMessage, "tick">` collapses to the keys every variant shares,
 * which is almost nothing, and would reject every real message.
 */
type WithoutTick<T> = T extends unknown ? Omit<T, "tick"> & { tick?: number } : never;
export type SendableMessage = WithoutTick<GameMessage>;

export type NetState =
  | "idle"
  | "connecting"
  /** Socket open, room handshake in flight. */
  | "joining"
  /** Seated, waiting for the other player to arrive. */
  | "waiting"
  /** Both seats filled — the match can run. */
  | "ready"
  /** The socket dropped mid-match and the seat is being reclaimed. */
  | "reconnecting"
  | "closed";

export interface NetHandlers {
  /** A game message from the other peer. Signalling never reaches here. */
  onMessage?: (msg: GameMessage) => void;
  onStateChange?: (state: NetState, detail?: string) => void;
  /** The other player arrived (true) or left (false). */
  onPeer?: (present: boolean, who?: PeerIdentity | null, matchId?: string | null) => void;
  /** Quick match only: still waiting, with this many players ahead. */
  onQueued?: (ahead: number) => void;
  /** The socket dropped and the seat is being reclaimed; `attempt` is 1-based. */
  onReconnecting?: (attempt: number, of: number) => void;
  /** The seat was reclaimed and play can continue. */
  onReconnected?: () => void;
  /** The relay minted a fresh match id (a rematch began). */
  onMatchId?: (id: string) => void;
  /** Fatal: the room was refused, or the socket died. */
  onError?: (reason: string) => void;
}

/** How often to measure the round trip, in ms. */
const PING_INTERVAL_MS = 2000;
/**
 * How long to wait for the socket to open.
 *
 * Generous, because the relay is allowed to be asleep. A container host that
 * scales to zero takes the better part of a minute to answer the first
 * connection, and a ten-second deadline turned "your first online game of the
 * day" into "online play is broken".
 */
const CONNECT_TIMEOUT_MS = 45_000;
const JOIN_TIMEOUT_MS = 10_000;

/**
 * How hard to try to get back into a match after the socket drops.
 *
 * This is the difference between a phone game and a desktop one. A handover
 * from Wi-Fi to cellular, a lift, a tunnel, a notification that backgrounds
 * the tab for a moment — a mobile socket dies for a few seconds all the time,
 * and none of those should cost somebody the match they were winning.
 *
 * The relay makes this possible without knowing about it: a closed socket
 * frees its seat but the room survives while the other player still holds
 * theirs, so rejoining by the same code lands in the same room, against the
 * same opponent. Six attempts over roughly twenty seconds, which comfortably
 * outlasts a handover and stops well short of a player who has actually gone.
 */
const RECONNECT_TRIES = 6;
const RECONNECT_BACKOFF_MS = [400, 900, 1800, 3000, 5000, 8000];
/**
 * Waiting for a stranger is not the same as waiting for a server. Quick match
 * gets a long deadline because an empty queue is a normal state, not a fault —
 * `onQueued` keeps the UI honest about it in the meantime.
 */
const JOIN_TIMEOUT_MS_QUEUE = 180_000;

export class NetConnection {
  private socket: WebSocket | null = null;
  private handlers: NetHandlers;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private state: NetState = "idle";

  /** Simulation tick, set by the game loop; stamped onto outgoing messages. */
  tick = 0;
  role: PeerRole | null = null;
  room: string | null = null;
  /** The relay's name for the match, once both seats are filled. */
  matchId: string | null = null;
  /** Smoothed round trip in ms, or null until the first pong. */
  rttMs: number | null = null;

  /**
   * @param token The account this seat plays from, so the relay can tell the
   * opponent who they are up against. Optional: a player without one is shown
   * as a guest, which is the same game.
   */
  constructor(
    private url: string,
    handlers: NetHandlers = {},
    private token?: string
  ) {
    this.handlers = handlers;
  }

  get status(): NetState {
    return this.state;
  }

  /**
   * Attach or replace handlers after construction. The lobby owns the socket
   * before a match exists, so the session takes over the message handler once
   * it does, without reconnecting.
   */
  setHandlers(next: Partial<NetHandlers>): void {
    this.handlers = { ...this.handlers, ...next };
  }

  /** Half the round trip, in simulation ticks — the age of an arriving message. */
  get latencyTicks(): number {
    if (this.rttMs === null) return 0;
    return Math.round((this.rttMs / 2 / 1000) * 60);
  }

  private setState(state: NetState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onStateChange?.(state, detail);
  }

  private fail(reason: string): void {
    this.setState("closed", reason);
    this.handlers.onError?.(reason);
    this.teardown();
  }

  /**
   * Open the socket and claim a seat in a named room. Resolves once seated —
   * which is not the same as being ready to play; a host resolves while still
   * alone in the room.
   */
  join(room: string): Promise<{ role: PeerRole; ready: boolean }> {
    return this.handshake({ t: "join", v: PROTOCOL_VERSION, room, token: this.token });
  }

  /**
   * Ask to be paired with whoever else is waiting. Resolves only once an
   * opponent has been found, which may be a long wait — `onQueued` reports the
   * position meanwhile so the UI can say something truthful.
   */
  quickMatch(): Promise<{ role: PeerRole; ready: boolean }> {
    return this.handshake(
      { t: "queue", v: PROTOCOL_VERSION, token: this.token },
      JOIN_TIMEOUT_MS_QUEUE
    );
  }

  /** Stop waiting for a pairing, keeping the socket for another attempt. */
  cancelQueue(): void {
    this.rawSend({ t: "cancel" });
    this.pendingJoin?.reject(new Error("cancelled"));
    this.pendingJoin = null;
  }

  /**
   * Host: a rematch was agreed. Ask the relay to mint a fresh match id for
   * the same room; the relay answers both seats, and this connection adopts
   * the id when it arrives.
   */
  newMatch(): void {
    this.rawSend({ t: "newmatch" });
  }

  /**
   * True while a dropped socket is being retried.
   *
   * The session asks, so it can hold the forfeit clock: a player who is
   * fighting their way back onto the network has not walked out, and awarding
   * the match against them while they do is the worst possible reading of a
   * tunnel.
   */
  get isReconnecting(): boolean {
    return this.reconnecting;
  }

  private async handshake(
    opening: NetMessage,
    timeoutMs = JOIN_TIMEOUT_MS,
    /** A retry reports through `onReconnecting` rather than failing the match. */
    quiet = false
  ): Promise<{ role: PeerRole; ready: boolean }> {
    if (this.socket) throw new Error("already connected");
    this.setState("connecting");

    const socket = new WebSocket(this.url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connection timed out")), CONNECT_TIMEOUT_MS);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("could not reach the server"));
        },
        { once: true }
      );
    }).catch((e: unknown) => {
      this.teardown();
      if (!quiet) this.fail(e instanceof Error ? e.message : "connection failed");
      throw e;
    });

    socket.addEventListener("message", (ev) => this.receive(String(ev.data)));
    socket.addEventListener("close", () => {
      this.teardown();
      // A seat that was live in a room is worth trying to take back; anything
      // else — a deliberate leave, a lobby that never seated — is just closed.
      if (this.deliberate || this.room === null || this.state === "closed") {
        if (this.state !== "closed") this.setState("closed", "disconnected");
        return;
      }
      void this.reclaimSeat();
    });

    this.setState("joining");
    const seated = new Promise<{ role: PeerRole; ready: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out finding a game")), timeoutMs);
      this.pendingJoin = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });

    socket.send(encode(opening));
    const result = await seated;
    this.role = result.role;
    this.setState(result.ready ? "ready" : "waiting");
    this.startPinging();
    return result;
  }

  private pendingJoin: {
    resolve: (v: { role: PeerRole; ready: boolean }) => void;
    reject: (e: Error) => void;
  } | null = null;

  /** Set by `close()`, so a leave the player asked for is never retried. */
  private deliberate = false;
  private reconnecting = false;

  /**
   * Take the seat back after the socket dropped.
   *
   * Rejoining by the same room code is all it takes: the relay frees a closed
   * socket's seat but keeps the room while the opponent still holds theirs, so
   * the same code lands in the same room against the same person. The room is
   * kept rather than re-derived because for a quick match the player never
   * knew the code — the relay minted it and named it in the `joined` frame.
   */
  private async reclaimSeat(): Promise<void> {
    if (this.reconnecting || this.room === null) return;
    this.reconnecting = true;
    const room = this.room;
    this.setState("reconnecting", "connection lost");
    for (let attempt = 1; attempt <= RECONNECT_TRIES; attempt++) {
      this.handlers.onReconnecting?.(attempt, RECONNECT_TRIES);
      await new Promise((r) => setTimeout(r, RECONNECT_BACKOFF_MS[attempt - 1]));
      if (this.deliberate) break;
      try {
        await this.handshake(
          { t: "join", v: PROTOCOL_VERSION, room, token: this.token },
          JOIN_TIMEOUT_MS,
          true
        );
        this.reconnecting = false;
        this.handlers.onReconnected?.();
        return;
      } catch {
        // Out of attempts is the only failure that matters; every other one
        // is a phone still looking for a network.
      }
    }
    this.reconnecting = false;
    if (!this.deliberate) this.fail("lost connection");
  }

  private receive(raw: string): void {
    const msg = decode(raw);
    if (!msg) return;

    switch (msg.t) {
      case "joined":
        this.room = msg.room;
        this.pendingJoin?.resolve({ role: msg.role, ready: msg.ready });
        this.pendingJoin = null;
        return;

      // Still waiting for an opponent. Not a resolution: the promise settles
      // only when a pairing actually happens.
      case "queued":
        this.setState("waiting", `queued, ${msg.ahead} ahead`);
        this.handlers.onQueued?.(msg.ahead);
        return;

      case "error": {
        const reason = msg.reason;
        if (this.pendingJoin) {
          this.pendingJoin.reject(new Error(reason));
          this.pendingJoin = null;
        }
        this.fail(reason);
        return;
      }

      case "peer":
        this.setState(msg.joined ? "ready" : "waiting");
        if (msg.match) this.matchId = msg.match;
        this.handlers.onPeer?.(msg.joined, msg.who ?? null, this.matchId);
        return;

      // The rematch got its name: adopt it, so this match's result is never
      // reported against the previous match's id.
      case "newmatch":
        if (typeof msg.match === "string") {
          this.matchId = msg.match;
          this.handlers.onMatchId?.(msg.match);
        }
        return;

      // Answer the peer's clock probe. Their `sent` is echoed untouched so only
      // they interpret it — the two devices never need synchronised clocks.
      case "ping":
        this.rawSend({ t: "pong", sent: msg.sent, tick: this.tick });
        return;

      case "pong":
        this.observeRtt(Date.now() - msg.sent);
        return;

      default:
        this.handlers.onMessage?.(msg as GameMessage);
    }
  }

  /** Exponential smoothing: one delayed packet should not move the estimate far. */
  private observeRtt(sample: number): void {
    if (!Number.isFinite(sample) || sample < 0) return;
    this.rttMs = this.rttMs === null ? sample : this.rttMs * 0.8 + sample * 0.2;
  }

  private startPinging(): void {
    this.stopPinging();
    this.pingTimer = setInterval(() => {
      this.rawSend({ t: "ping", sent: Date.now(), tick: this.tick });
    }, PING_INTERVAL_MS);
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private rawSend(msg: NetMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encode(msg));
  }

  /**
   * Send a game message, stamped with the current tick unless it names its
   * own. Silently dropped when the room is not ready — a strike with nobody to
   * hear it is not an error.
   *
   * The tick is supplied here rather than by the caller so no site can forget
   * it; a message without one cannot be fast-forwarded on arrival.
   *
   * A decision names its own, and it is not the tick it leaves on: a kick is
   * published when the swing starts, for the tick the limb arrives. This used
   * to stamp over it, so every kick reached the guest dated the moment it was
   * sent — the guest turned the ball a whole wind-up early and a snapshot
   * dragged it back, which on the phones was a re-anchor for nearly every
   * touch. The tests never saw it, because every fake connection in them
   * passes messages through untouched.
   */
  send(msg: SendableMessage): void {
    if (this.state !== "ready") return;
    this.rawSend({ ...msg, tick: msg.tick ?? this.tick });
  }

  private teardown(): void {
    this.stopPinging();
    this.pendingJoin = null;
    this.socket = null;
  }

  close(): void {
    // Flagged before the socket goes, so its own close handler does not read
    // a deliberate leave as a drop and start chasing the room again.
    this.deliberate = true;
    this.stopPinging();
    const socket = this.socket;
    this.socket = null;
    this.room = null;
    this.setState("closed");
    socket?.close();
  }
}
