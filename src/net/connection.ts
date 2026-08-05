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
  type PeerRole,
} from "./protocol";

/**
 * A game message minus its tick, which `send` fills in.
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
  | "closed";

export interface NetHandlers {
  /** A game message from the other peer. Signalling never reaches here. */
  onMessage?: (msg: GameMessage) => void;
  onStateChange?: (state: NetState, detail?: string) => void;
  /** The other player arrived (true) or left (false). */
  onPeer?: (present: boolean) => void;
  /** Fatal: the room was refused, or the socket died. */
  onError?: (reason: string) => void;
}

/** How often to measure the round trip, in ms. */
const PING_INTERVAL_MS = 2000;
const CONNECT_TIMEOUT_MS = 10_000;
const JOIN_TIMEOUT_MS = 10_000;

export class NetConnection {
  private socket: WebSocket | null = null;
  private handlers: NetHandlers;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private state: NetState = "idle";

  /** Simulation tick, set by the game loop; stamped onto outgoing messages. */
  tick = 0;
  role: PeerRole | null = null;
  room: string | null = null;
  /** Smoothed round trip in ms, or null until the first pong. */
  rttMs: number | null = null;

  constructor(
    private url: string,
    handlers: NetHandlers = {}
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
   * Open the socket and claim a seat. Resolves once seated — which is not the
   * same as being ready to play; a host resolves while still alone in the room.
   */
  async join(room: string): Promise<{ role: PeerRole; ready: boolean }> {
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
      this.fail(e instanceof Error ? e.message : "connection failed");
      throw e;
    });

    socket.addEventListener("message", (ev) => this.receive(String(ev.data)));
    socket.addEventListener("close", () => {
      if (this.state !== "closed") this.setState("closed", "disconnected");
      this.teardown();
    });

    this.setState("joining");
    const seated = new Promise<{ role: PeerRole; ready: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("join timed out")), JOIN_TIMEOUT_MS);
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

    socket.send(encode({ t: "join", v: PROTOCOL_VERSION, room }));
    const result = await seated;
    this.room = room;
    this.role = result.role;
    this.setState(result.ready ? "ready" : "waiting");
    this.startPinging();
    return result;
  }

  private pendingJoin: {
    resolve: (v: { role: PeerRole; ready: boolean }) => void;
    reject: (e: Error) => void;
  } | null = null;

  private receive(raw: string): void {
    const msg = decode(raw);
    if (!msg) return;

    switch (msg.t) {
      case "joined":
        this.pendingJoin?.resolve({ role: msg.role, ready: msg.ready });
        this.pendingJoin = null;
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
        this.handlers.onPeer?.(msg.joined);
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
   * Send a game message, stamped with the current tick. Silently dropped when
   * the room is not ready — a strike with nobody to hear it is not an error.
   *
   * The tick is supplied here rather than by the caller so no site can forget
   * it; a message without one cannot be fast-forwarded on arrival.
   */
  send(msg: SendableMessage): void {
    if (this.state !== "ready") return;
    this.rawSend({ ...msg, tick: this.tick });
  }

  private teardown(): void {
    this.stopPinging();
    this.pendingJoin = null;
    this.socket = null;
  }

  close(): void {
    this.stopPinging();
    const socket = this.socket;
    this.socket = null;
    this.setState("closed");
    socket?.close();
  }
}
