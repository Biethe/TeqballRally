/** Types for the HTTP API. See the note in `store.d.mts`. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PlayerStore } from "./store.mjs";

/**
 * Handle an `/api/...` request. Resolves false when the path is not ours, so
 * the relay can fall through to its own routes.
 */
export declare function handleApi(
  store: PlayerStore,
  req: IncomingMessage,
  res: ServerResponse,
  now?: Date
): Promise<boolean>;

export declare function sweepRateLimits(now?: number): void;
