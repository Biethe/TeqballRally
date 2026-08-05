import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BALLS,
  CHARACTERS,
  CLIPS,
  COURT,
  GROUND_Y,
  KICK_LOFT,
  KICK_POWER,
  KICK_SPEED_CAP,
  MAX_TOUCHES,
  SERVE_POWER,
  SERVE_X,
  SETS_TO_WIN,
  TABLE,
  WIN_SCORE,
  contactDelaySeconds,
  contactFraction,
  tableSurfaceY,
  tossFraction,
  windupStartFraction,
} from "../src/config";

describe("tableSurfaceY", () => {
  it("matches the rulebook heights at the net and the table ends", () => {
    expect(tableSurfaceY(0)).toBeCloseTo(GROUND_Y + TABLE.hCenter, 10);
    expect(tableSurfaceY(TABLE.halfLen)).toBeCloseTo(GROUND_Y + TABLE.hEnd, 10);
    expect(tableSurfaceY(-TABLE.halfLen)).toBeCloseTo(GROUND_Y + TABLE.hEnd, 10);
  });

  it("is a symmetric dome that falls away from the net", () => {
    for (const x of [0.25, 0.5, 1.0, 1.4]) {
      expect(tableSurfaceY(x)).toBeCloseTo(tableSurfaceY(-x), 10);
      expect(tableSurfaceY(x)).toBeLessThan(tableSurfaceY(0));
    }
    expect(tableSurfaceY(1.4)).toBeLessThan(tableSurfaceY(0.7));
  });

  it("keeps the whole surface below the net tape", () => {
    expect(GROUND_Y + TABLE.hCenter).toBeLessThan(GROUND_Y + TABLE.netTop);
  });
});

describe("clip timing helpers", () => {
  it("expresses the contact frame as a fraction of the clip", () => {
    // RightFootKick: contact on frame 23 of 75.
    expect(contactFraction("RightFootKick")).toBeCloseTo(23 / 75, 10);
    expect(contactFraction("LeftFootKick")).toBeCloseTo(40 / 85, 10);
  });

  it("returns 0 for clips with no contact and for unknown clips", () => {
    expect(contactFraction("Idle")).toBe(0);
    expect(contactFraction("Celebration1")).toBe(0);
    expect(contactFraction("NoSuchClip")).toBe(0);
  });

  it("expresses the toss frame as a fraction, and 0 for non-serves", () => {
    expect(tossFraction("ServeRightFoot")).toBeCloseTo(44 / 120, 10);
    expect(tossFraction("RightFootKick")).toBe(0);
    expect(tossFraction("NoSuchClip")).toBe(0);
  });

  it("keeps the toss strictly before the contact on every serve", () => {
    for (const [name, info] of Object.entries(CLIPS)) {
      if (info.toss === undefined) continue;
      expect(info.toss, `${name} toss`).toBeLessThan(info.contact);
    }
  });

  it("round-trips windupStartFraction through contactDelaySeconds", () => {
    // The start fraction is chosen so contact lands `lead` seconds later; the
    // delay helper must recover that same lead.
    for (const clip of ["RightFootKick", "CenterHeadKick", "BackflipLeftFoot"]) {
      for (const speed of [0.8, 1, 1.5]) {
        const lead = 0.22;
        const start = windupStartFraction(clip, speed, lead);
        expect(contactDelaySeconds(clip, speed, start), `${clip} @ ${speed}`).toBeCloseTo(lead, 10);
      }
    }
  });

  it("clamps the start fraction at 0 when the lead exceeds the wind-up", () => {
    // RightHeadKick contacts on frame 16, so a 1 s lead cannot fit before it.
    expect(windupStartFraction("RightHeadKick", 1, 1)).toBe(0);
    // From frame 0 the delay is then the clip's full pre-contact time.
    expect(contactDelaySeconds("RightHeadKick", 1, 0)).toBeCloseTo(16 / 60, 10);
  });

  it("plays the wind-up faster at higher animation speed", () => {
    const slow = contactDelaySeconds("RightFootKick", 0.5, 0);
    const fast = contactDelaySeconds("RightFootKick", 2, 0);

    expect(fast).toBeLessThan(slow);
    expect(slow / fast).toBeCloseTo(4, 6);
  });

  it("never reports a negative delay", () => {
    // A start fraction past the contact frame would otherwise go negative.
    expect(contactDelaySeconds("RightFootKick", 1, 0.99)).toBe(0);
  });

  it("returns 0 for clips that never touch the ball", () => {
    expect(windupStartFraction("Idle", 1, 0.2)).toBe(0);
    expect(contactDelaySeconds("Idle", 1, 0)).toBe(0);
  });
});

describe("CLIPS mirrors Animation.txt", () => {
  // Animation.txt is the authored source for the rig's frame numbers and says
  // the runtime copy lives in src/config.ts. Parse it and hold the two in sync.
  const doc = readFileSync(fileURLToPath(new URL("../Animation.txt", import.meta.url)), "utf8");

  const documented = new Map<string, { contact: number; toss?: number; frames: number }>();
  for (const line of doc.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    // Leading and trailing pipes produce empty first/last cells.
    if (cells.length < 4 || cells[0] !== "") continue;
    const [, name, ...rest] = cells.slice(0, -1);
    if (name === "Animation" || name.startsWith("---")) continue;
    const num = (cell: string) => (cell === "—" ? -1 : Number(cell));
    if (rest.length === 2) {
      documented.set(name, { contact: num(rest[0]), frames: num(rest[1]) });
    } else if (rest.length === 3) {
      documented.set(name, { toss: num(rest[0]), contact: num(rest[1]), frames: num(rest[2]) });
    }
  }

  it("parses every documented clip", () => {
    expect(documented.size).toBe(27);
  });

  it("has the same clip names in both files", () => {
    expect(Object.keys(CLIPS).sort()).toEqual([...documented.keys()].sort());
  });

  it("has the same frame numbers in both files", () => {
    for (const [name, info] of documented) {
      expect(CLIPS[name], name).toEqual(info);
    }
  });
});

describe("CLIPS", () => {
  it("keeps every contact frame inside its clip", () => {
    for (const [name, info] of Object.entries(CLIPS)) {
      expect(info.frames, `${name} frames`).toBeGreaterThan(0);
      expect(info.contact, `${name} contact`).toBeLessThanOrEqual(info.frames);
      if (info.contact >= 0) expect(info.contact, `${name} contact`).toBeGreaterThan(0);
    }
  });

  it("has an entry for every clip the tuning tables reference", () => {
    const referenced = [
      ...Object.keys(SERVE_POWER),
      ...Object.keys(KICK_POWER),
      ...Object.keys(KICK_SPEED_CAP),
      ...Object.keys(KICK_LOFT),
    ];
    for (const clip of referenced) {
      expect(CLIPS[clip], clip).toBeDefined();
    }
  });

  it("gives every strike clip a contact frame", () => {
    for (const clip of Object.keys(KICK_POWER)) {
      expect(CLIPS[clip].contact, clip).toBeGreaterThan(0);
    }
  });

  it("gives every serve clip a toss frame", () => {
    for (const clip of Object.keys(SERVE_POWER)) {
      expect(CLIPS[clip].toss, clip).toBeGreaterThan(0);
    }
  });
});

describe("kick tuning tables", () => {
  it("uses positive multipliers everywhere", () => {
    for (const [clip, v] of Object.entries({ ...KICK_POWER, ...KICK_LOFT, ...SERVE_POWER })) {
      expect(v, clip).toBeGreaterThan(0);
    }
  });

  it("keeps every speed cap under the ball's own hard limit", () => {
    // ball.ts clamps at 20 m/s; a cap above that could never be reached.
    for (const [clip, cap] of Object.entries(KICK_SPEED_CAP)) {
      expect(cap, clip).toBeGreaterThan(0);
      expect(cap, clip).toBeLessThanOrEqual(20);
    }
  });

  it("ranks the documented shot hierarchy: backflip > foot volley > head > chest", () => {
    expect(KICK_POWER.BackflipRightFoot).toBeGreaterThan(KICK_POWER.RightFootKick);
    expect(KICK_POWER.RightFootKick).toBeGreaterThan(KICK_POWER.CenterHeadKick);
    expect(KICK_POWER.CenterHeadKick).toBeGreaterThan(KICK_POWER.ChestKick);

    expect(KICK_SPEED_CAP.BackflipRightFoot).toBeGreaterThan(KICK_SPEED_CAP.RightFootKick);
    expect(KICK_SPEED_CAP.RightFootKick).toBeGreaterThan(KICK_SPEED_CAP.CenterHeadKick);
    expect(KICK_SPEED_CAP.CenterHeadKick).toBeGreaterThan(KICK_SPEED_CAP.ChestKick);
  });

  it("mirrors left and right variants of the same shot", () => {
    const pairs: [string, string][] = [
      ["LeftFootKick", "RightFootKick"],
      ["BackflipLeftFoot", "BackflipRightFoot"],
      ["LeftHeadKick", "RightHeadKick"],
      ["LeftKneeReception", "RightKneeReception"],
      ["InnerLeftFootReception", "InnerRightFootReception"],
    ];
    for (const [left, right] of pairs) {
      expect(KICK_POWER[left], left).toBe(KICK_POWER[right]);
      expect(KICK_SPEED_CAP[left], left).toBe(KICK_SPEED_CAP[right]);
      expect(KICK_LOFT[left]).toBe(KICK_LOFT[right]);
    }
    expect(SERVE_POWER.ServeLeftFoot).toBe(SERVE_POWER.ServeRightFoot);
    expect(SERVE_POWER.HeadServeLeft).toBe(SERVE_POWER.HeadServeRight);
  });

  it("lofts the soft touches and drills the foot volleys", () => {
    expect(KICK_LOFT.InnerRightFootReception).toBeGreaterThan(1);
    expect(KICK_LOFT.RightKneeReception).toBeGreaterThan(1);
    expect(KICK_LOFT.RightFootKick).toBeLessThan(1);
  });

  it("serves harder off the foot than off the head", () => {
    expect(SERVE_POWER.ServeRightFoot).toBeGreaterThan(SERVE_POWER.HeadServeRight);
  });
});

describe("court and match rules", () => {
  it("keeps players behind the table and inside the floor", () => {
    expect(COURT.minX).toBeGreaterThan(TABLE.halfLen);
    expect(COURT.maxX).toBeGreaterThan(COURT.minX);
    expect(COURT.maxX).toBeLessThan(COURT.floorHalfLen);
    expect(COURT.maxZ).toBeLessThan(COURT.floorHalfWid);
  });

  it("puts the serve spot inside the movement bounds", () => {
    expect(SERVE_X).toBeGreaterThan(COURT.minX);
    expect(SERVE_X).toBeLessThan(COURT.maxX);
  });

  it("uses the FITEQ best-of-three scoring", () => {
    expect(WIN_SCORE).toBe(12);
    expect(SETS_TO_WIN).toBe(2);
    expect(MAX_TOUCHES).toBe(3);
  });

  it("keeps the net posts inside the table width", () => {
    expect(TABLE.netHalfWidth).toBeGreaterThan(TABLE.halfWid);
    expect(TABLE.halfLen).toBeCloseTo(TABLE.length / 2, 10);
    expect(TABLE.halfWid).toBeCloseTo(TABLE.width / 2, 10);
  });

  it("derives the table curvature from its own heights", () => {
    expect(TABLE.curveK).toBeCloseTo((TABLE.hCenter - TABLE.hEnd) / (TABLE.halfLen * TABLE.halfLen), 10);
  });
});

describe("CHARACTERS", () => {
  it("has unique ids and labels", () => {
    expect(new Set(CHARACTERS.map((c) => c.id)).size).toBe(CHARACTERS.length);
    expect(new Set(CHARACTERS.map((c) => c.label)).size).toBe(CHARACTERS.length);
  });

  it("gives every player plausible traits", () => {
    for (const c of CHARACTERS) {
      expect(c.height, c.label).toBeGreaterThan(1.5);
      expect(c.height, c.label).toBeLessThan(2.1);
      expect(c.speed, c.label).toBeGreaterThan(0);
      expect(c.power, c.label).toBeGreaterThan(0);
      expect(c.precision, c.label).toBeGreaterThan(0);
      expect(["left", "right", "both"]).toContain(c.strongFoot);
      expect(["none", "strong", "both"]).toContain(c.backflips);
    }
  });

  it("matches the documented identities", () => {
    const byLabel = Object.fromEntries(CHARACTERS.map((c) => [c.label, c]));

    // ENGLAND — the powerhouse: tallest, strongest, slowest, no flips.
    expect(byLabel.ENGLAND.power).toBe(Math.max(...CHARACTERS.map((c) => c.power)));
    expect(byLabel.ENGLAND.height).toBe(Math.max(...CHARACTERS.map((c) => c.height)));
    expect(byLabel.ENGLAND.speed).toBe(Math.min(...CHARACTERS.map((c) => c.speed)));
    expect(byLabel.ENGLAND.backflips).toBe("none");

    // BRAZIL — the acrobat: quickest, flips off either foot.
    expect(byLabel.BRAZIL.speed).toBe(Math.max(...CHARACTERS.map((c) => c.speed)));
    expect(byLabel.BRAZIL.backflips).toBe("both");

    // SPAIN — the technician: most precise, softest ball, two-footed.
    expect(byLabel.SPAIN.precision).toBe(Math.max(...CHARACTERS.map((c) => c.precision)));
    expect(byLabel.SPAIN.power).toBe(Math.min(...CHARACTERS.map((c) => c.power)));
    expect(byLabel.SPAIN.strongFoot).toBe("both");

    // FRANCE — the lefty all-rounder: flips off the strong foot only.
    expect(byLabel.FRANCE.strongFoot).toBe("left");
    expect(byLabel.FRANCE.backflips).toBe("strong");
  });
});

describe("BALLS", () => {
  it("has unique ids and labels", () => {
    expect(new Set(BALLS.map((b) => b.id)).size).toBe(BALLS.length);
    expect(new Set(BALLS.map((b) => b.label)).size).toBe(BALLS.length);
  });
});
