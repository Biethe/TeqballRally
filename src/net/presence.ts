import {
  PROTOCOL_VERSION,
  decode,
  encode,
  isValidCalloutGone,
  isValidInvited,
  type PeerIdentity,
} from "./protocol";
import { relayUrl } from "./endpoint";

/**
 * The connection a player holds while the app is open.
 *
 * Not a match connection. `NetConnection` exists for the length of one game
 * and owns a seat in a room; this owns nothing, joins nothing and is silent
 * almost all the time. Its whole job is to be *reachable*: a friend cannot be
 * asked to play unless something is listening on their behalf, and until now
 * nothing was listening except during a match, which is precisely when nobody
 * needs asking.
 *
 * It is also what makes the green dot on the friends list mean anything. The
 * server counts presence from identified sockets, so before this a friend read
 * as online only while they were already looking for a game.
 *
 * Deliberately cheap to lose. Everything it carries is an invitation to do
 * something *now*, so an invite that arrives at a socket which has just died
 * is an invite worth dropping rather than queueing — the asker is told the
 * friend is not there, which is true, and asks again. That is why this retries
 * quietly for as long as the app is open and never reports a failure: there is
 * nothing here for a player to act on.
 */

/** How long to wait between attempts, growing, then holding at the last. */
const BACKOFF_MS = [1000, 3000, 8000, 20000, 45000];

export interface PresenceHandlers {
  /**
   * Somebody has asked for a game and is sitting in `room` waiting.
   *
   * `open` separates a friend asking by name from a stranger calling out to
   * everybody. The first has earned an interruption; the second has earned a
   * notice that can be ignored, and showing them the same way would make the
   * second one feel like the first.
   */
  onInvited?: (from: PeerIdentity, room: string, open: boolean) => void;
  /** That game is taken, or its caller gave up. Stop offering it. */
  onCalloutGone?: (room: string) => void;
  /** An invite this player sent came back unanswered or refused. */
  onReply?: (answer: "declined" | "gone", who: string | null) => void;
  /** The connection came up or went down; drives the friends list's dot. */
  onConnected?: (up: boolean) => void;
}

export class PresenceLink {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `url` defaults to the build's own relay, which is what every caller in the
   * game wants. It is a parameter at all so a test can point one of these at a
   * server it started itself — `NetConnection` has taken its URL this way from
   * the beginning, and a presence link that could not be aimed anywhere was
   * the reason the callout had no end-to-end test.
   */
  constructor(
    private token: string,
    private handlers: PresenceHandlers = {},
    private url: string = relayUrl()
  ) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Open it, and keep it open until `close`. */
  start(): void {
    this.closed = false;
    this.open();
  }

  /**
   * Ask a friend to play, in a room this peer has already taken a seat in.
   *
   * Silently dropped when the link is down, which is the honest outcome: an
   * invite is an offer to play right now, and one that waits for a socket to
   * come back is an offer to play at some unspecified past moment.
   */
  invite(friendId: string, room: string): void {
    this.send({ t: "invite", to: friendId, room });
  }

  /**
   * Ask everybody who is around, rather than one friend by name.
   *
   * Same shape as `invite`: the room already exists and this peer is already
   * sitting in it, so all that crosses is where to come. Dropped when the link
   * is down, for the same reason an invite is — it is an offer to play right
   * now, and one that waits for a socket is an offer to play at some
   * unspecified past moment.
   */
  callout(room: string): void {
    this.send({ t: "callout", v: PROTOCOL_VERSION, room });
  }

  /** Turn one down, so whoever asked is told rather than left waiting. */
  decline(friendId: string): void {
    this.send({ t: "invite-reply", to: friendId, answer: "declined" });
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private send(msg: Parameters<typeof encode>[0]): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encode(msg));
  }

  private open(): void {
    if (this.closed || this.socket) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      // A build with no reachable relay. Nothing to report and nothing to
      // retry against.
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.attempt = 0;
      // Identifying is the whole handshake. The relay reads the account off
      // the token and marks them present; there is no room to ask for.
      socket.send(encode({ t: "hello", v: PROTOCOL_VERSION, token: this.token }));
      this.handlers.onConnected?.(true);
    });
    socket.addEventListener("message", (ev) => this.receive(String(ev.data)));
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      this.handlers.onConnected?.(false);
      this.retry();
    });
    socket.addEventListener("error", () => socket.close());
  }

  private receive(raw: string): void {
    const msg = decode(raw);
    if (!msg) return;
    if (isValidInvited(msg)) {
      this.handlers.onInvited?.(msg.from, msg.room, msg.open === true);
      return;
    }
    if (isValidCalloutGone(msg)) {
      this.handlers.onCalloutGone?.(msg.room);
      return;
    }
    if (msg.t === "invite-reply") {
      const answer = msg.answer === "declined" ? "declined" : "gone";
      this.handlers.onReply?.(answer, typeof msg.who === "string" ? msg.who : null);
    }
  }

  private retry(): void {
    if (this.closed || this.timer !== null) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, wait);
  }
}
