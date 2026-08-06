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
  /** Corner banner flags. */
  flags: Rgb[] | null;
}

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
   * What fills the frame behind everything. The outdoor models have no sky of
   * their own, and against the indoor near-black they read as a court floating
   * in space; a clear colour is the whole fix and costs nothing.
   */
  sky: Rgb;
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
    label: "SPORTS HALL",
    sub: "Indoor court under the roof lights",
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
      crowd: null,
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
  },
  basketball: {
    id: "basketball",
    label: "STREETBALL",
    sub: "Outdoor blacktop under the hoops",
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
      crowd: { rows: 2, colors: CROWD, gap: 1.35, spacing: 0.72, density: 0.72 },
      flags: null,
    },
    sky: [0.42, 0.55, 0.72],
  },
  football: {
    id: "football",
    label: "TOUCHLINE",
    sub: "Out on the pitch with the goals behind",
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
      crowd: { rows: 2, colors: CROWD, gap: 1.6, spacing: 0.78, density: 0.6 },
      flags: [TEQ_ORANGE, TEQ_WHITE],
    },
    sky: [0.5, 0.62, 0.78],
  },
  tennis: {
    id: "tennis",
    label: "CENTRE COURT",
    sub: "Hard court under the floodlights",
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
      crowd: { rows: 2, colors: CROWD, gap: 1.45, spacing: 0.75, density: 0.68 },
      flags: null,
    },
    sky: [0.46, 0.58, 0.75],
  },
};

const STORAGE_KEY = "teqopen.venue";

function isVenueId(v: unknown): v is VenueId {
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

/** URL override, then the remembered choice, then the original sports hall. */
export function resolveVenue(search: string): VenueId {
  return venueFromSearch(search) ?? storedVenue() ?? "gym";
}

export function venueFor(id: VenueId): Venue {
  return VENUES[id];
}
