/**
 * Venues: a backdrop model paired with a procedural court that suits it.
 *
 * The court the game is *played* on is always procedural — the floor, the
 * three lines and the perimeter boards are built in `buildCourt`. A venue only
 * decides what that court looks like and what stands around it, so adding a
 * venue is a palette plus a GLB, never a change to how the game plays.
 *
 * Nothing here touches gameplay. The bounds players move inside (`COURT.minX`,
 * `maxX`, `maxZ` in `config.ts`) and `GROUND_Y` are the same in every venue,
 * which is what lets two peers on different venues share one simulation: the
 * host and the guest can be looking at a basketball hall and a football
 * stadium and still agree on every position.
 */

import type { IntroSweep } from "./intro";

export type VenueId = "gym" | "basketball" | "football" | "tennis";

export const VENUE_IDS: VenueId[] = ["gym", "basketball", "football", "tennis"];

/**
 * Where a player without the entitlement lands.
 *
 * The two open-air grounds (The Park and The Baseline) are free, so the game a
 * player is given for nothing is a whole game rather than a demo.
 * The Coliseum and The Cage are premium venues.
 * It has to be one of the free ones, or a new install opens on a locked door.
 */
export const DEFAULT_VENUE: VenueId = "football";

/** An RGB triple in 0..1, kept plain so this module stays free of Babylon. */
export type Rgb = readonly [number, number, number];

export interface ArenaModel {
  /** File under `assets/models/Arena/`. */
  file: string;
  /** The model's longest horizontal side is scaled to this many metres. */
  span: number;
  /** Shift along the table axis (+x = toward the far side). */
  offsetX: number;
  /** Raise/lower the whole model; 0 puts its lowest point on the ground. */
  offsetY: number;
  /** Shift laterally (+z = to the controlled player's left). */
  offsetZ: number;
  /** Radians about the vertical axis, to line the model's court up with ours. */
  rotationY: number;
  /**
   * Scenery to drop, named by the material it uses. For things that sit in the
   * way rather than around: the tennis court's own net stands at x = 0,
   * exactly the plane the ball crosses, and reading the ball through it is
   * worse than not having it.
   *
   * By material rather than by mesh because the compression pass merges the
   * model down to one mesh per material — mesh names do not survive that,
   * material names do (`gltfpack -km`).
   */
  hideMaterials?: string[];
}

export interface CourtStyle {
  /**
   * Where the players stand.
   *
   * "own" paints a floor slab in `floor`. "venue" leaves the backdrop's own
   * surface — blacktop, grass, hard court — showing through and draws only the
   * lines on it, which is what makes three venues look like three places
   * rather than one court with three wallpapers. A "venue" court still falls
   * back to painting `floor` when the backdrop is not loaded, so the LOW tier
   * is never left standing on nothing.
   */
  surface: "own" | "venue";
  /** "oval" fits a gymnasium's rounded side band; "rect" is the classic court. */
  shape: "oval" | "rect";
  /** Low perimeter boards. Off where the ribbon of lit boards replaces them. */
  boards: boolean;
  /**
   * Who draws the line the table stands on.
   *
   * "own" paints it. "venue" leaves it to the backdrop's own centre line —
   * basketball and football courts already have one, painted right where the
   * teqball net goes, and a second line on top of it is just a brighter stripe
   * in the middle of theirs. The two coincide to within a centimetre, so this
   * is only ever about which one you can see.
   */
  centreLine: "own" | "venue";
  /** Floor half-extent along the table axis, in metres. */
  halfLen: number;
  /** Floor half-extent across, in metres. */
  halfWid: number;
  floor: Rgb;
  line: Rgb;
  board: Rgb;
}

/**
 * Procedural set dressing, built in `environment.ts` rather than downloaded.
 *
 * This is what turns an empty sports ground into a match: the ring of lit
 * boards a teqball court actually sits inside, and a crowd close enough to be
 * part of the picture. Every field is optional per venue, and the whole lot is
 * skipped on the tier that skips the backdrop.
 */
export interface Dressing {
  /** Ring of lit sponsor boards around the court. */
  ribbon: {
    /** Cycled panel by panel around the ring. */
    colors: Rgb[];
    /** How many panels make up the ring. */
    panels: number;
    height: number;
    /** Distance beyond the court's edge. */
    inset: number;
  } | null;
  /** Rows of onlookers standing behind the ring, along both long sides. */
  crowd: {
    rows: number;
    /** Shirt colours, picked per person. */
    colors: Rgb[];
    /** Gap between the court edge and the first row. */
    gap: number;
    /** Distance between neighbours, and between rows. */
    spacing: number;
    /** 0..1 — how much of each row is occupied. Gaps stop it reading as a fence. */
    density: number;
  } | null;
  /**
   * Seated figures on benches the venue model already contains.
   *
   * Positions are measured out of the model rather than guessed: the three
   * outdoor grounds share a template with eight benches, and the numbers below
   * are their centres in metres.
   */
  benches: {
    /** Bench centres, [x, z] in metres. */
    seats: [number, number][];
    /** How many people a full bench holds. */
    perBench: number;
    /** Distance between neighbours along a bench. */
    spacing: number;
    /** Seat surface height above the ground. */
    height: number;
    /** 0..1 — how full the benches are. */
    density: number;
  } | null;
  /**
   * A bowl of bleachers: concentric elliptical rows rising as they go back.
   * For a venue whose own seating is modelled as bare rings with nobody in it.
   */
  tiers: {
    /** Colour of the deck this builds for people to sit on. */
    deck: Rgb;
    rows: number;
    /** First row's radii, in metres. */
    radiusX: number;
    radiusZ: number;
    /** How much further back and higher each row sits. */
    step: number;
    rise: number;
    /** Height of the first row above the ground. */
    lift: number;
    /** Distance between neighbours along a row. */
    spacing: number;
    /** 0..1 — how full the bowl is. */
    density: number;
  } | null;
  /** Corner banner flags. */
  flags: Rgb[] | null;
}

/**
 * What surrounds the venue, built procedurally in `surroundings.ts`.
 *
 * The arena models are a fenced site with sky beyond the fence, which reads as
 * a diorama however good the court is. This is the world it stands in.
 */
/**
 * A tiling texture, by name under `assets/textures/`, and how much real
 * surface one tile covers.
 *
 * The metres matter as much as the image: a tile scaled wrong reads as a
 * pattern rather than a material, and the two failure modes look completely
 * different — too large and the ground is smeared, too small and it shimmers
 * into noise at distance.
 */
export interface Tile {
  name: string;
  /** Metres of world covered by one repeat. */
  metres: number;
}

export interface Surrounds {
  kind: "city" | "park" | "beach";
  /** Ground beyond the venue's own site. */
  ground: Rgb;
  /** Horizon colour: the sky's low band and the fog both take it. */
  horizon: Rgb;
  /** Exponential fog density. Distance is mostly this. */
  haze: number;
  /** How many buildings, trees or palms. */
  count: number;
  /** Main tones — wall colours, or trunk and leaf. */
  palette: Rgb[];
  /** Secondary: roofs, hedges, sea. */
  accent: Rgb;
  /** The bright one: lit windows, foam. */
  lit: Rgb;
  /** City only: fraction of windows with a light on. */
  litFraction: number;
  /** Ground beyond the site. Falls back to flat `ground` colour if absent. */
  groundTile?: Tile;
  /** Building walls, or nothing for the venues without buildings. */
  wallTile?: Tile;
  /** The sea, on the beach. */
  accentTile?: Tile;
}

/**
 * The eight benches in the outdoor template, measured from the model: four a
 * side, at z = -6.68 and z = +6.75, with their seat surface 0.31 m up.
 */
const OUTDOOR_BENCHES = {
  seats: [
    [-4.53, -6.68],
    [-2.74, -6.68],
    [2.79, -6.68],
    [4.58, -6.68],
    [-4.53, 6.75],
    [-2.74, 6.75],
    [2.79, 6.75],
    [4.58, 6.75],
  ] as [number, number][],
  perBench: 3,
  spacing: 0.5,
  height: 0.31,
  density: 0.75,
};

export interface Venue {
  id: VenueId;
  label: string;
  sub: string;
  /** null renders the court alone — also what every tier without `arena` gets. */
  arena: ArenaModel | null;
  court: CourtStyle;
  dressing: Dressing;
  /**
   * How wide the pre-match establishing shot opens. Omitted means the open-air
   * default; a venue with a roof has to name one that stays under it.
   */
  sweep?: IntroSweep;
  /**
   * What fills the frame behind everything. With `surrounds` this is the
   * zenith of the sky dome; without it, a flat clear colour.
   */
  sky: Rgb;
  /** The world outside the fence. null leaves the venue on its own. */
  surrounds: Surrounds | null;
  /**
   * Whether the Teqie Pro entitlement is needed to play here.
   *
   * Deliberately a property of the venue rather than a list kept somewhere
   * else: what is for sale is then visible at the point the venue is defined,
   * and adding a venue forces the question to be answered.
   */
  premium: boolean;
}

/**
 * The three outdoor models are one export family sharing a scene template, and
 * they are authored in metres: a 28.8 x 20.3 m site with a 20.8 x 12.2 m
 * playing surface whose top sits 0.6 m above the model's lowest point. So they
 * take the same three numbers — `span` at the model's own extent to keep 1:1
 * scale, and `offsetY` of -0.6 to land that surface exactly on `GROUND_Y`
 * instead of the site's foundation. Only the palette and the boards differ.
 *
 * The indoor gym has no such structure and keeps its hand-tuned numbers.
 */
const OUTDOOR = { span: 28.8, offsetX: 0, offsetY: -0.6, offsetZ: 0, rotationY: 0 };

/**
 * A 16 x 10.4 m court fits inside the outdoor playing surface with room to
 * spare on all four sides, and comfortably clears the movement bounds
 * (`COURT.maxX` 6.8, `maxZ` 4.6) that every venue shares.
 */
const OUTDOOR_COURT = { shape: "rect", halfLen: 8, halfWid: 5.2 } as const;

/** Teqball's own competition colours, for the board ring every venue carries. */
const TEQ_ORANGE: Rgb = [0.96, 0.35, 0.05];
const TEQ_RED: Rgb = [0.78, 0.11, 0.13];
const TEQ_WHITE: Rgb = [0.93, 0.93, 0.95];

/** A crowd is a crowd: mixed shirts read better than a themed block. */
const CROWD: Rgb[] = [
  [0.62, 0.24, 0.22],
  [0.2, 0.3, 0.5],
  [0.68, 0.6, 0.3],
  [0.72, 0.72, 0.74],
  [0.26, 0.42, 0.32],
  [0.3, 0.24, 0.36],
];

export const VENUES: Record<VenueId, Venue> = {
  gym: {
    id: "gym",
    label: "THE COLISEUM",
    sub: "Ten thousand seats, and all of them yours",
    premium: true,
    arena: {
      file: "indoor_arena_inside_out_improved_version.glb",
      span: 55,
      offsetX: -0.45,
      offsetY: -0.05,
      offsetZ: -1.2,
      rotationY: 0,
    },
    court: {
      surface: "own",
      shape: "oval",
      boards: false, // the ribbon is the boards here
      centreLine: "own",
      halfLen: 9,
      halfWid: 6.7,
      floor: [0.13, 0.22, 0.38],
      line: [0.92, 0.93, 0.95],
      board: [0.93, 0.42, 0.08],
    },
    // The gym already has its own seating bowl, so no stands: only the board
    // ring the model does not have, following the court's ellipse.
    dressing: {
      ribbon: { colors: [TEQ_ORANGE, TEQ_RED, TEQ_WHITE], panels: 72, height: 0.62, inset: 0.2 },
      // A courtside row, and behind it a stand this builds itself.
      //
      // Seating people on the hall's own bowl needs a rake that is not in the
      // model — its rows are bare concentric rings — so the stand is
      // constructed instead, just outside the board ring. The venue's own bowl
      // rises behind it, which is what stops the crowd being lost in it.
      // Courtside rows, and no built stand.
      //
      // `tiers` constructs its own decks so it needs no rake from the model,
      // and it still does not work here: the hall's shell occupies the floor
      // immediately outside the court, so a stand placed close enough to be
      // seen intersects it and one placed clear of it is lost among the
      // model's own seating. Three attempts, three failures — the courtside
      // rows are what actually reads.
      crowd: { rows: 2, colors: CROWD, gap: 0.9, spacing: 1.05, density: 0.66 },
      benches: null,
      tiers: null,
      flags: null,
    },
    // A level swing around the court, and nothing else. Everything about this
    // venue is enclosed: pulling back leaves the bowl, and lifting runs into
    // the roof trusses — two earlier attempts opened on the outside of the
    // dome and inside a wall respectively. Staying at the play camera's own
    // height is the one line through the hall known to be clear, because the
    // game is played looking along it.
    sweep: { radius: 2, height: 0, swing: 1.35, boundX: 13, boundZ: 5.6 },
    sky: [0.045, 0.05, 0.09],
    // Indoors: there is no outside to build, and the hall's own shell is what
    // you see in every direction.
    surrounds: null,
  },
  basketball: {
    id: "basketball",
    label: "THE CAGE",
    sub: "Blacktop, chain-link and no excuses",
    premium: true,
    arena: { file: "Basketball.glb", ...OUTDOOR },
    court: {
      surface: "venue",
      ...OUTDOOR_COURT,
      boards: false,
      centreLine: "venue", // the halfway line under the hoops is already there
      floor: [0.38, 0.2, 0.14], // the court's own varnished boards, if it is skipped
      line: [0.96, 0.95, 0.92],
      board: [0.24, 0.27, 0.33],
    },
    dressing: {
      ribbon: { colors: [TEQ_ORANGE, [0.1, 0.12, 0.16], TEQ_WHITE], panels: 44, height: 0.6, inset: 0.25 },
      crowd: { rows: 3, colors: CROWD, gap: 1.5, spacing: 1.15, density: 0.62 },
      benches: OUTDOOR_BENCHES,
      tiers: null,
      flags: null,
    },
    sky: [0.24, 0.42, 0.74],
    // A city block at dusk: the lit windows are what sell it, and they cost
    // one merged mesh.
    surrounds: {
      kind: "city",
      ground: [0.24, 0.24, 0.26],
      horizon: [0.62, 0.6, 0.66],
      haze: 0.0026,
      count: 34,
      palette: [
        [0.62, 0.56, 0.5],
        [0.52, 0.48, 0.47],
        [0.68, 0.6, 0.52],
        [0.46, 0.46, 0.5],
      ],
      accent: [0.22, 0.22, 0.24],
      lit: [1, 0.88, 0.62],
      litFraction: 0.42,
      groundTile: { name: "asphalt", metres: 6 },
      // 2.5 m per repeat puts a brick course at roughly 6 cm on a typical
      // facade. The first pass used 8 m and the bricks came out a metre tall.
      wallTile: { name: "brick", metres: 2.5 },
    },
  },
  football: {
    id: "football",
    label: "THE PARK",
    sub: "Cut grass, long shadows, nobody watching",
    premium: false,
    arena: { file: "Soccer.glb", ...OUTDOOR },
    // No boards: a pitch has touchlines, not barriers, and the goals already
    // frame the ends.
    court: {
      surface: "venue",
      ...OUTDOOR_COURT,
      boards: false,
      centreLine: "venue", // the pitch's halfway line runs through the table
      floor: [0.16, 0.34, 0.16],
      line: [0.95, 0.97, 0.95],
      board: [0.9, 0.9, 0.92],
    },
    // Flags rather than stands: a touchline is somewhere you stand and watch,
    // and the goals already fill both ends of the frame.
    dressing: {
      ribbon: { colors: [TEQ_RED, TEQ_WHITE, [0.12, 0.35, 0.18]], panels: 44, height: 0.55, inset: 0.3 },
      crowd: { rows: 3, colors: CROWD, gap: 1.7, spacing: 1.2, density: 0.55 },
      benches: OUTDOOR_BENCHES,
      tiers: null,
      flags: [TEQ_ORANGE, TEQ_WHITE],
    },
    sky: [0.3, 0.5, 0.82],
    // Parkland: trees and a hedge line, so the pitch sits in something.
    surrounds: {
      kind: "park",
      ground: [0.29, 0.42, 0.22],
      horizon: [0.72, 0.79, 0.82],
      haze: 0.0021,
      count: 46,
      palette: [
        [0.31, 0.23, 0.16],
        [0.22, 0.38, 0.18],
      ],
      accent: [0.19, 0.33, 0.17],
      lit: [0.85, 0.9, 0.8],
      litFraction: 0,
      groundTile: { name: "grass", metres: 5 },
    },
  },
  tennis: {
    id: "tennis",
    label: "THE BASELINE",
    sub: "Floodlit hard court, whites optional",
    premium: false,
    // Mat.3 and Mat.4 are the tennis net's cord and tape, used by nothing else
    // in the model. It stands across the middle of the court, at exactly the
    // height and plane the ball is played through.
    arena: { file: "Tennis.glb", ...OUTDOOR, hideMaterials: ["Mat.3", "Mat.4"] },
    court: {
      surface: "venue",
      ...OUTDOOR_COURT,
      boards: false,
      // A tennis court's cross line is the net, and the net is gone, so this
      // one draws its own.
      centreLine: "own",
      floor: [0.24, 0.45, 0.62],
      line: [0.97, 0.97, 0.97],
      board: [0.1, 0.3, 0.22],
    },
    dressing: {
      ribbon: { colors: [[0.06, 0.3, 0.2], TEQ_WHITE, [0.1, 0.4, 0.28]], panels: 44, height: 0.58, inset: 0.28 },
      crowd: { rows: 3, colors: CROWD, gap: 1.55, spacing: 1.15, density: 0.6 },
      benches: OUTDOOR_BENCHES,
      tiers: null,
      flags: null,
    },
    sky: [0.22, 0.48, 0.8],
    // A coast: sand, a shoreline to the north and palms around the court.
    surrounds: {
      kind: "beach",
      ground: [0.82, 0.74, 0.56],
      horizon: [0.78, 0.85, 0.88],
      haze: 0.0018,
      count: 26,
      palette: [
        [0.42, 0.32, 0.2],
        [0.2, 0.42, 0.24],
      ],
      accent: [0.08, 0.4, 0.5],
      lit: [0.95, 0.97, 0.96],
      litFraction: 0,
      groundTile: { name: "sand", metres: 5 },
      accentTile: { name: "water", metres: 14 },
    },
  },
};

const STORAGE_KEY = "teqopen.venue";

export function isVenueId(v: unknown): v is VenueId {
  return typeof v === "string" && (VENUE_IDS as string[]).includes(v);
}

/** A `?venue=` override, or null when the URL asks for nothing. */
export function venueFromSearch(search: string): VenueId | null {
  const v = new URLSearchParams(search).get("venue");
  return isVenueId(v) ? v : null;
}

export function storedVenue(): VenueId | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isVenueId(v) ? v : null;
  } catch {
    return null; // private mode / storage disabled
  }
}

export function storeVenue(id: VenueId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Not remembering the choice is not worth failing a match over.
  }
}

/** URL override, then the remembered choice, then the free default. */
export function resolveVenue(search: string): VenueId {
  return venueFromSearch(search) ?? storedVenue() ?? DEFAULT_VENUE;
}

export function venueFor(id: VenueId): Venue {
  return VENUES[id];
}

/** Whether playing here needs the entitlement. */
export function isPremiumVenue(id: string): boolean {
  return isVenueId(id) ? VENUES[id].premium : false;
}

/**
 * The venue a player may actually be sent to.
 *
 * Applied to a *remembered* choice rather than to a chosen one, which is the
 * case that matters: a subscription lapses between sessions, and the venue
 * saved last month must not quietly stay unlocked. A player picking a venue
 * now goes through the paywall in the picker instead.
 *
 * Pure, and takes `pro` as an argument rather than importing `purchases`, so
 * this module stays free of the SDK and the rule stays testable without a store.
 */
export function permittedVenue(
  id: VenueId,
  pro: boolean = false,
  career?: { unlockedAssets?: string[]; best?: number }
): VenueId {
  if (!isPremiumVenue(id)) return id;
  if (pro) return id;
  if (career?.unlockedAssets?.includes(id)) return id;
  if (id === "basketball" && (career?.best ?? 0) >= 450) return id;
  return DEFAULT_VENUE;
}
