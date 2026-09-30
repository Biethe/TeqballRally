import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RATING_KEYS, rating, totalPower } from "../src/ratings";
import { MAX_SPEED } from "../src/ball";
import {
  BALLS,
  CAMERA,
  CHARACTERS,
  CLIPS,
  COURT,
  GROUND_Y,
  KICK_LOFT,
  KICK_POWER,
  KICK_SPEED_CAP,
  KICK_SPEED_CAP_DEFAULT,
  BALL_PACE,
  MAX_TOUCHES,
  PLAYER_REACH,
  PLAY_BOX,
  SERVE_POWER,
  SERVE_EVERY,
  SERVE_X,
  SETS_TO_WIN,
  SPAWN,
  TABLE,
  TABLE_CLEARANCE,
  WIN_SCORE,
  clearTable,
  contactDelaySeconds,
  kitForCharacter,
  onTableFootprint,
  portraitCameraShot,
  contactFraction,
  tableSurfaceY,
  tossFraction,
  windupStartFraction,
} from "../src/config";
import { VENUE_IDS, venueFor } from "../src/venue";

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
    // RightFootKick: contact on frame 30 of 75.
    expect(contactFraction("RightFootKick")).toBeCloseTo(30 / 75, 10);
    expect(contactFraction("LeftFootKick")).toBeCloseTo(38 / 85, 10);
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
    // RightHeadKick contacts on frame 15, so a 1 s lead cannot fit before it.
    expect(windupStartFraction("RightHeadKick", 1, 1)).toBe(0);
    // From frame 0 the delay is then the clip's full pre-contact time.
    expect(contactDelaySeconds("RightHeadKick", 1, 0)).toBeCloseTo(15 / 60, 10);
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

describe("CLIPS mirrors tests/Animation.txt", () => {
  // tests/Animation.txt is the authored source for the rig's frame numbers and says
  // the runtime copy lives in src/config.ts. Parse it and hold the two in sync.
  const doc = readFileSync(fileURLToPath(new URL("./Animation.txt", import.meta.url)), "utf8");

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
    expect(documented.size).toBe(31);
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
  it("lets players reach the middle line", () => {
    // They used to be held behind the table *end*, nearly two metres off the
    // net, which put the whole front of the court out of reach and made the
    // shots taken from there impossible to play.
    expect(COURT.minX).toBeLessThan(TABLE.halfLen);
    expect(COURT.minX).toBeGreaterThan(0);
    expect(COURT.maxX).toBeGreaterThan(COURT.minX);
  });

  it("keeps them off the table while they are up there", () => {
    // The table is a hole in the half, not a wall across it.
    expect(onTableFootprint(0.5, 0)).toBe(true);
    expect(onTableFootprint(TABLE.halfLen + TABLE_CLEARANCE + 0.1, 0)).toBe(false);
    expect(onTableFootprint(0.5, TABLE.halfWid + TABLE_CLEARANCE + 0.1)).toBe(false);
  });

  it("pushes a player out of the table the short way", () => {
    // Alongside it they are moved sideways, so a run down the side of the
    // table stays a run down the side of the table.
    const beside = clearTable(0.5, TABLE.halfWid);
    expect(Math.abs(beside.z)).toBeGreaterThan(TABLE.halfWid);
    expect(beside.x).toBeCloseTo(0.5);

    // At the end of it they are moved back behind the end.
    const ahead = clearTable(TABLE.halfLen, 0.1);
    expect(Math.abs(ahead.x)).toBeGreaterThan(TABLE.halfLen);

    // Dead centre has no side to be pushed to, and must still resolve.
    const centre = clearTable(0, 0);
    expect(onTableFootprint(centre.x, centre.z)).toBe(false);
  });

  it("leaves a position that was never on the table alone", () => {
    const clear = clearTable(4, 2);
    expect(clear).toEqual({ x: 4, z: 2 });
  });

  // Movement bounds are shared by every venue, so a venue whose floor is
  // smaller than them would let players run off the edge of its court.
  it("gives every venue a floor the players cannot run off", () => {
    for (const id of VENUE_IDS) {
      const { court } = venueFor(id);
      expect(court.halfLen, `${id} floor length`).toBeGreaterThan(COURT.maxX);
      expect(court.halfWid, `${id} floor width`).toBeGreaterThan(COURT.maxZ);
    }
  });

  it("names a distinct arena file for each venue that has one", () => {
    const files = VENUE_IDS.map((id) => venueFor(id).arena?.file).filter((f) => f !== undefined);
    expect(new Set(files).size).toBe(files.length);
  });

  it("puts the serve spot inside the movement bounds", () => {
    expect(SERVE_X).toBeGreaterThan(COURT.minX);
    expect(SERVE_X).toBeLessThan(COURT.maxX);
  });

  // The table is drawn oversized on purpose (see TABLE_SCALE), and everything
  // measured against it has to grow with it. These used to be bare metres, so
  // enlarging the table quietly walked the players into their own table end.
  it("scales the standing room with the table", () => {
    // The clearance keeping a player out of the table is what has to grow with
    // it now, since the bound itself is the middle line.
    expect(TABLE_CLEARANCE).toBeGreaterThan(0);
    expect(SPAWN.x).toBeGreaterThan(TABLE.halfLen);
    expect(SERVE_X).toBeGreaterThan(SPAWN.x);
    // Still an arena, not a corridor: there is court left behind the server.
    expect(COURT.maxX - SERVE_X).toBeGreaterThan(1);
  });

  // The portrait lens is pinned horizontally, so its field of view is literally
  // how wide the shot is — and the shot is narrowest in world units exactly
  // where the near player stands. Tighten it for a bigger picture of the table
  // and the player chasing a wide ball leaves their own frame.
  it("keeps the near player inside the portrait frame at full stretch", () => {
    const { back, fov } = CAMERA.portrait;
    // Along-axis distance from the camera to a player standing at the spawn.
    const toNearPlayer = back;
    const visibleHalfWidth = toNearPlayer * Math.tan(fov / 2);
    // Anywhere they can be while playing a ball that landed on the play box's
    // far sideline, plus the stride that takes them there.
    const needed = PLAY_BOX.halfWid + PLAYER_REACH * 0.5;

    expect(visibleHalfWidth).toBeGreaterThan(needed);
  });

  it("uses a short best-of-three, sized for a phone", () => {
    expect(WIN_SCORE).toBe(3);
    expect(SETS_TO_WIN).toBe(2);
    expect(MAX_TOUCHES).toBe(3);
    // The serve has to change hands inside a set, or whoever serves first
    // serves the whole thing.
    expect(SERVE_EVERY).toBeLessThan(WIN_SCORE);
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
  it("keeps the official shirt and shorts colours with the player in every screen", () => {
    const france = CHARACTERS.find((character) => character.id === "FrenchPlayer");
    const england = CHARACTERS.find((character) => character.id === "EnglishPlayer");
    expect(france).toBeDefined();
    expect(england).toBeDefined();

    expect(kitForCharacter(france!, { name: "Jules", number: "7", crest: "shield" })).toMatchObject({
      colour: "white",
      shortsColor: "navy",
      shortsCrestColor: "royal",
    });
    expect(kitForCharacter(england!, { name: "Alex", number: "10", crest: "disc" })).toMatchObject({
      name: "Alex",
      number: "10",
      crest: "disc",
      colour: "white",
      shirtFabricColor: "royal",
      shortsColor: "white",
      shortsFabricColor: "navy",
    });
    expect(kitForCharacter(england!, { name: "", number: "", crest: "none" })).toMatchObject({
      number: "10",
      crest: "shield",
      colour: "white",
      shirtFabricColor: "royal",
      shortsColor: "white",
      shortsFabricColor: "navy",
      shortsCrestColor: "white",
    });
  });

  it("has unique ids and labels", () => {
    expect(new Set(CHARACTERS.map((c) => c.id)).size).toBe(CHARACTERS.length);
    expect(new Set(CHARACTERS.map((c) => c.label)).size).toBe(CHARACTERS.length);
  });

  it("gives every player a distinct showcase MenuPose animation", () => {
    const poses = CHARACTERS.map((c) => c.menuPose);
    expect(poses.every((p) => typeof p === "string" && p.length > 0)).toBe(true);
    expect(new Set(poses).size).toBe(CHARACTERS.length);
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

    // ENGLAND — the powerhouse: tallest, strongest, best serve, heaviest on
    // his feet, and no flips.
    expect(byLabel.ENGLAND.power).toBe(Math.max(...CHARACTERS.map((c) => c.power)));
    expect(byLabel.ENGLAND.height).toBe(Math.max(...CHARACTERS.map((c) => c.height)));
    expect(byLabel.ENGLAND.serve).toBe(Math.max(...CHARACTERS.map((c) => c.serve)));
    expect(byLabel.ENGLAND.agility).toBe(Math.min(...CHARACTERS.map((c) => c.agility)));
    expect(byLabel.ENGLAND.backflips).toBe("none");

    // SPAIN — the technician at the top of the ladder: quickest, most precise,
    // takes it earliest, two-footed so either foot can flip.
    expect(byLabel.SPAIN.speed).toBe(Math.max(...CHARACTERS.map((c) => c.speed)));
    expect(byLabel.SPAIN.precision).toBe(Math.max(...CHARACTERS.map((c) => c.precision)));
    expect(byLabel.SPAIN.volley).toBe(Math.max(...CHARACTERS.map((c) => c.volley)));
    expect(byLabel.SPAIN.strongFoot).toBe("both");
    expect(byLabel.SPAIN.backflips).toBe("both");

    // FRANCE — the lefty all-rounder: flips off the strong foot only.
    expect(byLabel.FRANCE.strongFoot).toBe("left");
    expect(byLabel.FRANCE.backflips).toBe("strong");
  });

  /**
   * The roster is a ladder, and this is the whole of that claim.
   *
   * Every character unlocks above the one before it and has to be plainly
   * better than it — that is what the trophies are being spent on. A roster
   * that drifts back toward four equals gives a player nothing to want, and it
   * drifts one trait at a time, which is exactly the kind of change nobody
   * notices until the career stops meaning anything.
   */
  it("gets better at every rung, and the card says so", () => {
    const totals = CHARACTERS.map((c) => totalPower(c));
    for (let i = 1; i < CHARACTERS.length; i++) {
      expect(totals[i], `${CHARACTERS[i].label} vs ${CHARACTERS[i - 1].label}`).toBeGreaterThan(
        totals[i - 1]
      );
    }
  });

  it("still gives each of them a shape rather than one number four times", () => {
    // Better overall, not better at everything: the rung above has to give
    // something up, or the four of them are one character at four prices.
    for (let i = 1; i < CHARACTERS.length; i++) {
      const below = CHARACTERS[i - 1];
      const above = CHARACTERS[i];
      const traitsGivenUp = RATING_KEYS.filter((key) => rating(above, key) < rating(below, key));
      expect(traitsGivenUp.length, `${above.label} is strictly better than ${below.label}`)
        .toBeGreaterThan(0);
    }
  });
});

describe("BALLS", () => {
  it("has unique ids and labels", () => {
    expect(new Set(BALLS.map((b) => b.id)).size).toBe(BALLS.length);
    expect(new Set(BALLS.map((b) => b.label)).size).toBe(BALLS.length);
  });
});

describe("the portrait camera follows the player", () => {
  /**
   * Why this exists: the portrait lens is pinned horizontally, so the visible
   * width is proportional to the distance from the camera and the shot narrows
   * towards the near end. A player deep in their own half is about a metre
   * from either edge of frame — and since the half now runs all the way to the
   * middle line, they cover far more of it than a fixed camera can hold.
   *
   * Two movements, and both are needed. Panning keeps the player in shot;
   * dollying back keeps the court in it. Panning alone cannot do the second,
   * because at the back of the half the whole frame is narrower than the table.
   */
  const baseX = -SPAWN.x - CAMERA.portrait.back;
  const spawn = -SPAWN.x;
  // Along the sight line, not across the ground: the camera is 6.6 m up, and
  // the frame's width at a point is set by how far the lens is from it. This
  // is the whole reason the shot fits inside a venue at all.
  const halfWidthAt = (playerX: number, camX: number) =>
    Math.hypot(playerX - camX, CAMERA.portrait.height) * Math.tan(CAMERA.portrait.fov / 2);

  it("stays put while the player is comfortably in shot", () => {
    expect(portraitCameraShot(spawn, 0, baseX)).toEqual({ x: baseX, z: 0 });
    expect(portraitCameraShot(spawn, 0.4, baseX).z).toBe(0);
  });

  it("slides only as far as it must to bring them back in", () => {
    // A camera welded to the player slides the world under a figure that never
    // moves, which is harder to read and worse to look at.
    const { z } = portraitCameraShot(spawn, 3, baseX);

    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(3);
  });

  it("keeps the player in frame anywhere on the half", () => {
    // The case that was actually broken, and swept over the *whole* half
    // rather than the play area: a player can walk anywhere their side of the
    // court allows, and an earlier version of this test that only checked
    // where the ball goes passed while the browser showed them off screen.
    for (let x = -COURT.maxX; x <= -COURT.minX; x += 0.2) {
      for (let z = -COURT.maxZ; z <= COURT.maxZ; z += 0.2) {
        const shot = portraitCameraShot(x, z, baseX);
        const fromCentre = Math.abs(z - shot.z);
        expect(fromCentre, `player at (${x.toFixed(2)}, ${z.toFixed(2)})`).toBeLessThanOrEqual(
          halfWidthAt(x, shot.x)
        );
      }
    }
  });

  it("never loses the table either, from anywhere on the half", () => {
    // Both at once, which is the whole reason the camera dollies rather than
    // only panning: at the back of the half the frame is barely three metres
    // across, so catching a wide player by sliding sideways would push the
    // court out of the opposite edge.
    for (let x = -COURT.maxX; x <= -COURT.minX; x += 0.2) {
      for (let z = -COURT.maxZ; z <= COURT.maxZ; z += 0.4) {
        const shot = portraitCameraShot(x, z, baseX);
        const edge = Math.abs(shot.z) + TABLE.halfWid;
        expect(edge, `player at (${x.toFixed(2)}, ${z})`).toBeLessThanOrEqual(
          halfWidthAt(x, shot.x) + 1e-9
        );
      }
    }
  });

  it("never moves along the court axis, from anywhere on the half", () => {
    // The camera used to dolly backwards to fit a wide player and the table in
    // one shot, and it went as far as x = -20.2 to do it. The outdoor venues
    // are a 28.8 m site, so that is 5.8 m *outside* the fence — the lens ended
    // up behind the scenery, filming the court through it. The distance is now
    // solved once for the worst case, and nothing may add to it.
    for (let x = -COURT.maxX; x <= -COURT.minX; x += 0.1) {
      for (let z = -COURT.maxZ; z <= COURT.maxZ; z += 0.5) {
        expect(portraitCameraShot(x, z, baseX).x).toBe(baseX);
      }
    }
  });

  it("stays inside the venue it is filming", () => {
    // Every venue puts something solid a few metres past the end of the play
    // area — stands in the sports hall, a goal on the pitch, a backboard on the
    // blacktop. Solving the framing with distance instead of height put the
    // lens at -13.7, which is behind all of them: the sports hall shot came
    // back showing the underside of the roof and no court at all.
    expect(Math.abs(baseX)).toBeLessThan(COURT.maxX + 3);
  });

  it("is symmetric", () => {
    expect(portraitCameraShot(spawn, -3, baseX).z).toBe(-portraitCameraShot(spawn, 3, baseX).z);
  });
});

describe("the speed ceiling", () => {
  it("leaves room for the hardest shot any clip is allowed", () => {
    // The clamp in `stepBall` is a safety rail, not a tuning knob, so no clip's
    // cap may sit above it. The backflip's did — 18 * 1.26 = 22.68 against a
    // ceiling of 20 — and the clamp scaled the shot back *after* the net had
    // been checked against the full velocity, so the hardest shot in the game
    // landed short and could clip a tape it was solved to clear.
    const fastest = Math.max(...Object.values(KICK_SPEED_CAP), KICK_SPEED_CAP_DEFAULT);

    expect(fastest * BALL_PACE).toBeLessThanOrEqual(MAX_SPEED);
  });
});
