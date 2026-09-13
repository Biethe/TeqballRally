import { describe, expect, it } from "vitest";
import { EMOTES, EMOTE_COOLDOWN_MS, EMOTE_SHOWN_MS, emoteFor } from "../src/emotes";
import { reframe } from "../src/net/protocol";
import { LANGUAGES, setLanguage, t } from "../src/i18n";

/**
 * The fixed things a player can say.
 *
 * What is worth pinning here is not the wording, which will change, but the
 * three properties that make the feature safe to ship: the ids are stable, the
 * catalogue is the only thing that can be said, and a message is the same
 * message on both screens.
 */

describe("the catalogue", () => {
  it("gives every message its own id", () => {
    // The ids are on the wire. Two entries sharing one means whichever is
    // found first wins, silently, and a player sees a different message from
    // the one that was sent.
    const ids = EMOTES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the ids it has always had", () => {
    // Append-only, and this is the guard. Removing or renaming one makes an
    // older build show nothing where a newer build said something — the wire
    // carries the id, and a build that does not know it has no word for it.
    expect(EMOTES.map((e) => e.id)).toEqual([
      "gl",
      "nice",
      "shot",
      "close",
      "mine",
      "thanks",
      "wp",
      "again",
    ]);
  });

  it("has words for every one of them, in every language", () => {
    // Only the id crosses the wire, so the words are looked up on each side.
    // A catalogue missing a translation shows the key itself, which is worse
    // than showing nothing.
    for (const { id } of LANGUAGES) {
      setLanguage(id);
      for (const emote of EMOTES) {
        expect(t(emote.says)).toBeTruthy();
        expect(t(emote.says)).not.toBe(emote.says);
        expect(emote.emoji.length).toBeGreaterThan(0);
      }
    }
    setLanguage("en");
  });

  it("knows nothing it was not given", () => {
    // The far end is another build, which may be newer. An id this one has
    // never heard of has to come back as nothing rather than as a bubble with
    // no words in it.
    expect(emoteFor("gl")?.emoji).toBeTruthy();
    expect(emoteFor("not-a-message")).toBeNull();
    expect(emoteFor("")).toBeNull();
  });

  it("holds a message on screen longer than it rate-limits the next one", () => {
    // Otherwise a player can have two messages up at once from one sender,
    // and the second replaces the first mid-read.
    expect(EMOTE_SHOWN_MS).toBeGreaterThan(EMOTE_COOLDOWN_MS);
  });
});

describe("crossing the net", () => {
  it("arrives as the same message on the other side", () => {
    // Everything positional is mirrored for the guest, because each peer is
    // the near side of its own screen. A message has no place on the court, so
    // reflecting it would be reflecting nothing — and any change at all here
    // would mean the two players were reading different words.
    const sent = { t: "emote", tick: 12, id: "wp" } as const;

    expect(reframe(sent, "guest")).toEqual(sent);
    expect(reframe(sent, "host")).toEqual(sent);
  });
});
