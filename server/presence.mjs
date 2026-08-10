/**
 * Who is connected right now.
 *
 * A separate module so the relay can write it and the API can read it without
 * either importing the other — the relay owns sockets, the API owns requests,
 * and presence is the one fact they both need.
 *
 * A count rather than a set, because the same player can legitimately have two
 * sockets open for a moment: a phone that reconnects before the old socket's
 * close has been noticed would otherwise mark itself offline on the way in.
 */

/** @type {Map<string, number>} player id → open sockets */
const live = new Map();

export function arrived(id) {
  if (!id) return;
  live.set(id, (live.get(id) ?? 0) + 1);
}

export function left(id) {
  if (!id) return;
  const count = (live.get(id) ?? 0) - 1;
  if (count > 0) live.set(id, count);
  else live.delete(id);
}

export function isOnline(id) {
  return live.has(id);
}

export function onlineCount() {
  return live.size;
}

/** Forget everyone. Only for tests; a running server has sockets to trust. */
export function reset() {
  live.clear();
}
