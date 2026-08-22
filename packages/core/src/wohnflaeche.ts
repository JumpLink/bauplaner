/**
 * Wohnfläche nach der Wohnflächenverordnung (WoFlV) — the legally defined
 * dwelling area housing-subsidy programmes and Mietrecht measure against
 * (angemessene Wohnfläche der Wohnraumförderung, Mietspiegel …). It is NOT the
 * heated floor area: Zubehörräume — Heizungsraum, Keller, Garage, Werkstatt,
 * Waschküche, Bodenraum (§ 2 Abs. 3 Nr. 1) — never count even when they sit
 * inside the thermal envelope, rooms failing Bauordnungsrecht count zero
 * (§ 2 Abs. 3 Nr. 2), low rooms count half between 1 m and 2 m clear height
 * (§ 4 Nr. 1–2), unheated Wintergärten half (§ 4 Nr. 3), balconies/terraces a
 * quarter as a rule (§ 4 Nr. 4), and stairs with more than three risers are cut
 * out of the Grundfläche of the room they pass through (§ 3 Abs. 3).
 *
 * The geometry cannot know any of that — usage is a legal classification, not a
 * shape. So this computation reads *declarations* from the project sidecar
 * ({@link WohnflaecheConfig}) and falls back to conservative defaults: the
 * model's "(unbeheizt)" name convention and obvious Zubehör names exclude a
 * room, everything else counts in full. Every room that was NOT explicitly
 * declared is flagged as an assumption in the report, so the total always says
 * what it still rests on.
 *
 * A per-room `wohnung` assignment splits a building into several dwellings —
 * the Zweifamilienhaus question ("does only the self-used flat count against
 * the limit?") needs per-dwelling sums, not one number for the house.
 */

import { computeFloorAreas } from './floorarea.ts';
import type { HomeData, Level } from './sh3d/types.ts';

/** Fallback when a room's level is missing or carries no height. */
const DEFAULT_LEVEL_HEIGHT_CM = 250;

/** Dwelling key for rooms without an explicit `wohnung` assignment. */
export const DEFAULT_WOHNUNG = 'Wohnung';

/**
 * WoFlV classification of a room.
 *
 * - `wohnflaeche` — counts (§ 2 Abs. 1/2)
 * - `zubehoer` — Zubehörraum, counts zero (§ 2 Abs. 3 Nr. 1)
 * - `nicht-nutzbar` — fails the Bauordnungsrecht requirements for its use,
 *   counts zero (§ 2 Abs. 3 Nr. 2)
 * - `wintergarten` — unheated Wintergarten/Schwimmbad, counts half (§ 4 Nr. 3)
 * - `balkon` — Balkon/Loggia/Dachgarten/Terrasse, counts a quarter as a rule,
 *   at most half (§ 4 Nr. 4; raise via `faktor` where justified)
 */
export type WohnflaecheNutzung = 'wohnflaeche' | 'zubehoer' | 'nicht-nutzbar' | 'wintergarten' | 'balkon';

/** § 4 usage factors. `balkon` is the "in der Regel" quarter. */
export const NUTZUNG_FAKTOR: Record<WohnflaecheNutzung, number> = {
  wohnflaeche: 1,
  zubehoer: 0,
  'nicht-nutzbar': 0,
  wintergarten: 0.5,
  balkon: 0.25,
};

/** Declared WoFlV facts about one room (project sidecar). */
export interface WohnflaecheRaumConfig {
  nutzung?: WohnflaecheNutzung;
  /** Dwelling this room belongs to; {@link DEFAULT_WOHNUNG} when absent. */
  wohnung?: string;
  /**
   * Grundflächen-Abzug in m² (§ 3 Abs. 3): Treppen mit über drei Steigungen
   * samt Absätzen, Schornsteine/Pfeiler > 1,5 m Höhe und > 0,1 m², …
   * Deducted BEFORE the § 4 factors.
   */
  abzugM2?: number;
  /** Share (0..1) of the room with clear height 1–2 m — counted half (§ 4 Nr. 2). */
  anteilUnter2m?: number;
  /** Share (0..1) below 1 m clear height — counted zero (§ 4 Nr. 1). */
  anteilUnter1m?: number;
  /**
   * Explicit usage factor overriding {@link NUTZUNG_FAKTOR} — for the § 4 Nr. 4
   * "höchstens zur Hälfte" balcony cases and comparable justified deviations.
   */
  faktor?: number;
  /** Why the room is classified this way (shows up in the report). */
  note?: string;
}

/**
 * WoFlV declarations for a home, keyed by room id — or, as a fallback for
 * models whose rooms carry no ids, by the exact room name. An id match wins.
 */
export interface WohnflaecheConfig {
  raeume?: Record<string, WohnflaecheRaumConfig>;
}

/** Where a room's classification came from. */
export type WohnflaecheQuelle = 'erklaert' | 'unbeheizt-name' | 'zubehoer-name' | 'standard';

export interface WohnflaecheRow {
  roomId: string;
  name: string;
  levelName: string;
  wohnung: string;
  nutzung: WohnflaecheNutzung;
  quelle: WohnflaecheQuelle;
  /** Room polygon area, m². */
  grundflaecheM2: number;
  /** § 3 Abs. 3 deduction, m². */
  abzugM2: number;
  /** § 4 Nr. 1–2 height factor, 0..1. */
  hoehenFaktor: number;
  /** § 4 usage factor (or the declared override), 0..1. */
  nutzungsFaktor: number;
  /** (Grundfläche − Abzug) × Höhenfaktor × Nutzungsfaktor, m². */
  anrechenbarM2: number;
  note?: string;
}

export interface WohnungSumme {
  wohnung: string;
  anrechenbarM2: number;
  /** Rooms with a counted share (> 0 m²). */
  raumCount: number;
}

export interface WohnflaecheReport {
  rows: WohnflaecheRow[];
  /** Per-dwelling sums, largest first. */
  wohnungen: WohnungSumme[];
  /** Sum over all dwellings, m². */
  gesamtM2: number;
  /** Grundfläche of rooms counting zero (Zubehör, nicht nutzbar), m². */
  ausgeschlossenM2: number;
  /** Rooms classified by default heuristics, not by declaration. */
  angenommenCount: number;
  /**
   * Double-drawn floor area found by {@link computeFloorAreas} — if > 0 the
   * sums above are inflated by up to this amount and the model needs fixing.
   */
  overlapM2: number;
}

/** Obvious Zubehörraum names (§ 2 Abs. 3 Nr. 1) — a default, not a verdict. */
const ZUBEHOER_NAME =
  /(heizung|heizraum|keller|garage|werkstatt|waschküche|waschkueche|trockenraum|bodenraum|dachboden|dachraum|speicher|abstell)/i;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** § 4 Nr. 1–2 factor for a whole room of the given clear height, in cm. */
function heightFactorForLevel(level: Level | undefined): number {
  const h = level && level.height > 0 ? level.height : DEFAULT_LEVEL_HEIGHT_CM;
  if (h >= 200) return 1;
  if (h >= 100) return 0.5;
  return 0;
}

/**
 * Compute the WoFlV Wohnfläche of a home from its room polygons and the
 * project's declarations. Pure; runs on Node and GJS.
 */
export function computeWohnflaeche(home: HomeData, config?: WohnflaecheConfig): WohnflaecheReport {
  const levels = new Map(home.levels.map((l) => [l.id, l]));
  const declared = config?.raeume ?? {};

  const rows: WohnflaecheRow[] = [];
  let angenommen = 0;

  for (const room of home.rooms) {
    const cfg = declared[room.id] ?? declared[room.name];
    let nutzung: WohnflaecheNutzung;
    let quelle: WohnflaecheQuelle;
    if (cfg?.nutzung) {
      nutzung = cfg.nutzung;
      quelle = 'erklaert';
    } else if (/unbeheizt/i.test(room.name)) {
      // The model convention for "outside the dwelling" — Werkstatt, Garage,
      // Dachraum. WoFlV-wise these are Zubehörräume.
      nutzung = 'zubehoer';
      quelle = 'unbeheizt-name';
    } else if (ZUBEHOER_NAME.test(room.name)) {
      nutzung = 'zubehoer';
      quelle = 'zubehoer-name';
    } else {
      nutzung = 'wohnflaeche';
      quelle = 'standard';
    }
    // A declaration without `nutzung` (only wohnung/abzug/…) still counts as
    // reviewed — the room was looked at, the default was confirmed.
    if (cfg) quelle = 'erklaert';
    else angenommen++;

    const level = levels.get(room.level);
    let hoehenFaktor: number;
    if (cfg?.anteilUnter2m !== undefined || cfg?.anteilUnter1m !== undefined) {
      const halb = clamp01(cfg.anteilUnter2m ?? 0);
      const entfaellt = clamp01(cfg.anteilUnter1m ?? 0);
      hoehenFaktor = clamp01(1 - halb - entfaellt) + halb * 0.5;
    } else {
      hoehenFaktor = heightFactorForLevel(level);
    }

    const nutzungsFaktor = cfg?.faktor !== undefined ? clamp01(cfg.faktor) : NUTZUNG_FAKTOR[nutzung];
    const abzugM2 = Math.max(0, cfg?.abzugM2 ?? 0);
    const basis = Math.max(0, room.area - abzugM2);
    const anrechenbarM2 = round2(basis * hoehenFaktor * nutzungsFaktor);

    rows.push({
      roomId: room.id,
      name: room.name,
      levelName: level?.name ?? room.level,
      wohnung: cfg?.wohnung ?? DEFAULT_WOHNUNG,
      nutzung,
      quelle,
      grundflaecheM2: round2(room.area),
      abzugM2: round2(abzugM2),
      hoehenFaktor,
      nutzungsFaktor,
      anrechenbarM2,
      ...(cfg?.note ? { note: cfg.note } : {}),
    });
  }

  const byWohnung = new Map<string, WohnungSumme>();
  let gesamt = 0;
  let ausgeschlossen = 0;
  for (const row of rows) {
    if (row.anrechenbarM2 > 0) {
      gesamt += row.anrechenbarM2;
      const sum = byWohnung.get(row.wohnung) ?? { wohnung: row.wohnung, anrechenbarM2: 0, raumCount: 0 };
      sum.anrechenbarM2 = round2(sum.anrechenbarM2 + row.anrechenbarM2);
      sum.raumCount++;
      byWohnung.set(row.wohnung, sum);
    } else {
      ausgeschlossen += row.grundflaecheM2;
    }
  }

  return {
    rows,
    wohnungen: [...byWohnung.values()].sort((a, b) => b.anrechenbarM2 - a.anrechenbarM2),
    gesamtM2: round2(gesamt),
    ausgeschlossenM2: round2(ausgeschlossen),
    angenommenCount: angenommen,
    overlapM2: computeFloorAreas(home).overlapM2,
  };
}
