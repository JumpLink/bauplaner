/**
 * Preset build-ups (natural, diffusion-open) for the components of the heated
 * envelope, a one-call assessment (U-value + Tauwasser + GEG) over
 * {@link computeAssembly}, and a U-value → color scale for the 3D model. Lets the
 * app assign an assembly to walls and colour them by thermal quality, and lets a
 * budget price a component from the material stock.
 */

import { computeAssembly, type BauteilArt, type LayerSpec } from './bauphysik.ts';
import type { BegBauteil } from './foerderung.ts';
import { checkGeg } from './geg.ts';

/**
 * Heat-flow direction per component — the surface resistances differ, so the
 * same layers give a different U-value on a wall and on a ceiling.
 *
 * Derived here rather than stored on each preset: two fields that must agree are
 * two fields that eventually do not. Windows and doors are bought as products
 * and have no layer stack; they map to `wall` only so the type is total.
 */
export const BAUTEIL_ART: Record<BegBauteil, BauteilArt> = {
  aussenwand: 'wall',
  dach: 'roof',
  'oberste-geschossdecke': 'roof',
  kellerdecke: 'floor',
  fenster: 'wall',
  haustuer: 'wall',
};

export interface AssemblyPreset {
  key: string;
  name: string;
  /**
   * Which component the build-up is dimensioned for. It decides the heat-flow
   * direction ({@link BAUTEIL_ART}) and the BEG threshold the U-value is held
   * against — and it is what keeps a ceiling build-up out of a wall picker.
   */
  bauteil: BegBauteil;
  /** Layers inside → outside. */
  layers: LayerSpec[];
  /**
   * System material that is not a thermal layer, per m² — adhesive, dowels,
   * reinforcing mesh, top coat, scaffolding, fixings. **Labour is deliberately
   * excluded**: this planner assumes Eigenleistung, and a wage rate is the one
   * number that differs most between builders. Add it explicitly when you give
   * the work out.
   */
  zusatzkostenProM2?: number;
  /** Where {@link zusatzkostenProM2} comes from. */
  zusatzkostenQuelle?: string;
  /** Constraints and caveats that belong to this build-up, not to the material. */
  hinweise?: string[];
}

const WDVS_ZUSATZ_QUELLE =
  'Kleber/Dübel/Armiergewebe/Oberputz ≈ 30 €/m² + Gerüst ≈ 15 €/m² (Richtwert, ' +
  'ohne Lohn — Eigenleistung unterstellt)';
const INNEN_ZUSATZ_QUELLE =
  'Unterkonstruktion/Befestigung/Armierung ≈ 15 €/m² (Richtwert, ohne Lohn)';

/** The existing solid-brick wall every retrofit preset below builds on. */
const BESTAND_ZIEGEL: LayerSpec = {
  materialKey: 'vollziegel',
  thicknessM: 0.365,
  bestand: true,
};
/** The existing exterior render — kept under interior insulation, stripped under a façade. */
const BESTAND_AUSSENPUTZ: LayerSpec = {
  materialKey: 'kalkzementputz',
  thicknessM: 0.02,
  bestand: true,
};

/**
 * Build-ups per component, keyed by {@link AssemblyPreset.bauteil}. Read the ones
 * for a component with {@link presetsFor} — the bare array mixes components and
 * is only meant for "everything the tool knows".
 *
 * For a solid-brick exterior wall of ~1900 they span the real decision space: do
 * nothing, insulate inside, insulate outside, or combine both.
 *
 * The `-eps-` and `-mineralwolle-` entries are **benchmarks, not
 * recommendations**: they are dimensioned to the same U-value as the wood-fibre
 * façade so the comparison isolates the one thing that differs — the material
 * and its Ökobilanz.
 *
 * Exterior thicknesses are chosen to clear the BEG-EM threshold of U ≤ 0,20
 * W/(m²·K); 16 cm of wood fibre lands at 0,211 and misses it, which is exactly
 * the kind of near-miss `varianten.ts` prices in.
 */
export const PRESET_ASSEMBLIES: AssemblyPreset[] = [
  {
    key: 'bestand-vollziegel-365',
    bauteil: 'aussenwand',
    name: 'Bestand: Vollziegel 36,5 cm',
    layers: [
      { materialKey: 'kalkputz', thicknessM: 0.015, bestand: true },
      BESTAND_ZIEGEL,
      BESTAND_AUSSENPUTZ,
    ],
  },
  {
    key: 'innendaemmung-holzfaser-60',
    bauteil: 'aussenwand',
    name: 'Innendämmung: 6 cm Holzfaser',
    layers: [
      { materialKey: 'lehmputz', thicknessM: 0.015 },
      { materialKey: 'holzfaser', thicknessM: 0.06 },
      BESTAND_ZIEGEL,
      BESTAND_AUSSENPUTZ,
    ],
    zusatzkostenProM2: 15,
    zusatzkostenQuelle: INNEN_ZUSATZ_QUELLE,
    hinweise: ['Fassade bleibt unverändert — die Option, wenn das Ortsbild bindet.'],
  },
  {
    key: 'innendaemmung-holzfaser-100-lehmplatte',
    bauteil: 'aussenwand',
    name: 'Innendämmung: 10 cm Holzfaser + Lehmbauplatte',
    layers: [
      { materialKey: 'lehmputz', thicknessM: 0.01 },
      { materialKey: 'lehmbauplatte', thicknessM: 0.022 },
      { materialKey: 'holzfaser', thicknessM: 0.1 },
      BESTAND_ZIEGEL,
      BESTAND_AUSSENPUTZ,
    ],
    zusatzkostenProM2: 15,
    zusatzkostenQuelle: INNEN_ZUSATZ_QUELLE,
    hinweise: [
      'Fensterlaibungen sind der kritische Punkt jeder Innendämmung — dort bleibt die ' +
        'Wärmebrücke und muss kapillaraktiv eingebunden werden.',
    ],
  },
  {
    key: 'aussendaemmung-holzfaser-160',
    bauteil: 'aussenwand',
    name: 'Außendämmung: 16 cm Holzfaser',
    layers: [BESTAND_ZIEGEL, { materialKey: 'holzfaser', thicknessM: 0.16 }, { materialKey: 'kalkputz', thicknessM: 0.02 }],
    zusatzkostenProM2: 45,
    zusatzkostenQuelle: WDVS_ZUSATZ_QUELLE,
    hinweise: ['Verfehlt den BEG-Grenzwert von U ≤ 0,20 knapp — 2 cm mehr entscheiden über die Förderung.'],
  },
  {
    key: 'aussendaemmung-holzfaser-180',
    bauteil: 'aussenwand',
    name: 'Außendämmung: 18 cm Holzfaser',
    layers: [BESTAND_ZIEGEL, { materialKey: 'holzfaser', thicknessM: 0.18 }, { materialKey: 'kalkputz', thicknessM: 0.02 }],
    zusatzkostenProM2: 45,
    zusatzkostenQuelle: WDVS_ZUSATZ_QUELLE,
    hinweise: [
      'Dachüberstand muss die Dämmstärke aufnehmen, sonst Traufe verlängern.',
      'Sockel-/Spritzwasserbereich braucht ein feuchteunempfindliches Material (Schaumglas).',
    ],
  },
  {
    key: 'aussendaemmung-eps-150',
    bauteil: 'aussenwand',
    name: 'Außendämmung: 15 cm EPS (Vergleichsmaßstab)',
    layers: [BESTAND_ZIEGEL, { materialKey: 'eps', thicknessM: 0.15 }, { materialKey: 'kalkzementputz', thicknessM: 0.02 }],
    zusatzkostenProM2: 45,
    zusatzkostenQuelle: WDVS_ZUSATZ_QUELLE,
    hinweise: [
      'Nur als Vergleich geführt: µ 40 macht die Wand dampfbremsend. Auf feuchtebelastetem ' +
        'Altbau-Mauerwerk ist genau das die Schadensursache, aus der der Ruf der Außendämmung stammt.',
    ],
  },
  {
    key: 'aussendaemmung-mineralwolle-150',
    bauteil: 'aussenwand',
    name: 'Außendämmung: 15 cm Mineralwolle (Vergleichsmaßstab)',
    layers: [BESTAND_ZIEGEL, { materialKey: 'mineralwolle', thicknessM: 0.15 }, { materialKey: 'kalkputz', thicknessM: 0.02 }],
    zusatzkostenProM2: 45,
    zusatzkostenQuelle: WDVS_ZUSATZ_QUELLE,
    hinweise: ['Diffusionsoffen (µ 1), aber nicht kapillaraktiv und nicht nachwachsend.'],
  },
  {
    key: 'kombi-aussen-180-innen-wandheizung',
    bauteil: 'aussenwand',
    name: 'Kombination: 18 cm Holzfaser außen + Wandheizung in Lehm innen',
    zusatzkostenProM2: 55,
    zusatzkostenQuelle: `${WDVS_ZUSATZ_QUELLE}; + 10 €/m² innen für Träger/Befestigung`,
    hinweise: [
      'Die Wandheizung selbst (Rohr, Verteiler, Regelung) ist ein eigenes Gewerk und hier NICHT eingerechnet.',
      'Dachüberstand und Sockelanschluss wie bei der reinen Außendämmung.',
    ],
    // A wall heating on an exterior wall needs an insulating layer BEHIND the
    // pipes or it heats the street. With the thermal envelope carried outside,
    // that interior layer can stay thin — it decouples the heating, it does not
    // have to insulate, which is what keeps the masonry warm and the moisture
    // risk of interior insulation off the table.
    layers: [
      { materialKey: 'lehmputz', thicknessM: 0.03 },
      { materialKey: 'holzfaser', thicknessM: 0.04 },
      BESTAND_ZIEGEL,
      { materialKey: 'holzfaser', thicknessM: 0.18 },
      { materialKey: 'kalkputz', thicknessM: 0.02 },
    ],
  },

  // — Decke gegen unbeheizt / Boden —
  //
  // Both carry ONLY the layers that get added. The existing deck is left out
  // rather than guessed: the model does not know whether it is a Holzbalken-,
  // a Kappen- or a Betondecke, and a `bestand` layer invented here would raise
  // R and *lower* the U-value — i.e. promise a BEG threshold on a fiction. Left
  // out, the assessment understates the deck, which errs towards "does not
  // qualify" and can only be corrected by measuring the real one.
  {
    key: 'geschossdecke-holzfaserflex-300',
    bauteil: 'oberste-geschossdecke',
    name: 'Oberste Geschossdecke: 30 cm Holzfaser-Flex (nicht begehbar)',
    layers: [{ materialKey: 'holzfaserflex', thicknessM: 0.3 }],
    zusatzkostenProM2: 10,
    zusatzkostenQuelle: 'Rieselschutz/Randstreifen ≈ 10 €/m² (Richtwert, ohne Lohn)',
    hinweise: [
      'Der Dachboden ist danach NICHT begehbar. Eine lastverteilende Lage (Lattung + Platte) ' +
        'kommt als eigenes Gewerk dazu und ist hier nicht eingerechnet.',
      'Die Bestandsdecke ist thermisch nicht angerechnet — der U-Wert ist damit konservativ.',
    ],
  },
  {
    key: 'kellerdecke-holzfaser-160',
    bauteil: 'kellerdecke',
    name: 'Kellerdecke: 16 cm Holzfaser von unten',
    layers: [{ materialKey: 'holzfaser', thicknessM: 0.16 }],
    zusatzkostenProM2: 8,
    zusatzkostenQuelle: 'Dübel/Befestigung ≈ 8 €/m² (Richtwert, ohne Lohn)',
    hinweise: [
      'Die lichte Höhe im Keller sinkt um die Dämmstärke — Leitungen, Kellertüren und ' +
        'Treppenantritt vorher prüfen.',
      'Die Bestandsdecke ist thermisch nicht angerechnet — der U-Wert ist damit konservativ.',
    ],
  },

  // — Boden gegen Erdreich: Kriechraum-Ersatz —
  //
  // For the old-house floor that is nothing but boards on joists over 40–60 cm
  // of air: take the boards out, fill the void with compacted foam-glass gravel
  // (insulating AND capillary-breaking in one layer), finish with rammed earth
  // or boards on top. The gravel layers carry `verdichtung: 1.3` — the loose
  // purchase volume per m³ installed — so the budget prices what actually gets
  // delivered. All three build-ups clear the BEG floor threshold (U ≤ 0,25).
  {
    key: 'boden-schaumglas-stampflehm-400',
    bauteil: 'kellerdecke',
    name: 'Boden gegen Erdreich: 40 cm Schaumglasschotter + 10 cm Stampflehm (Finish)',
    layers: [
      { materialKey: 'stampflehm', thicknessM: 0.1 },
      { materialKey: 'schaumglasschotter', thicknessM: 0.4, verdichtung: 1.3 },
    ],
    zusatzkostenProM2: 5,
    zusatzkostenQuelle:
      'Geotextil-Trennlage unter/über der Schüttung + Randstreifen ≈ 5 €/m² (Richtwert, ohne Lohn)',
    hinweise: [
      'Ersetzt den Bestandsboden: Dielen + Lagerhölzer ausbauen, Planum herstellen — Ausbau und ' +
        'Entsorgung sind hier nicht eingerechnet.',
      'Schaumglasschotter wird ~1,3:1 verdichtet — die Kalkulation rechnet das lose Bestellvolumen ' +
        'bereits ein; ab ~30 m³ lose liefern lassen (deutlich unter dem Big-Bag-Preis).',
      'Der Stampflehm ist Speichermasse und fertige Oberfläche (geölt/gewachst), keine Dämmung — ' +
        'den U-Wert macht die Schüttung.',
      'Die Schüttung ist kapillarbrechend — sie ersetzt die fehlende Abdichtung gegen aufsteigende ' +
        'Feuchte unter dem Boden.',
    ],
  },
  {
    key: 'boden-schaumglas-stampflehm-diele',
    bauteil: 'kellerdecke',
    name: 'Boden gegen Erdreich: 40 cm Schaumglasschotter + 8 cm Stampflehm + Diele',
    layers: [
      { materialKey: 'diele', thicknessM: 0.028 },
      { materialKey: 'stampflehm', thicknessM: 0.08 },
      { materialKey: 'schaumglasschotter', thicknessM: 0.4, verdichtung: 1.3 },
    ],
    zusatzkostenProM2: 8,
    zusatzkostenQuelle:
      'Geotextil + Randstreifen ≈ 5 €/m² + Lagerhölzer/Befestigung der Dielung ≈ 3 €/m² (Richtwert, ohne Lohn)',
    hinweise: [
      'Ersetzt den Bestandsboden: Dielen + Lagerhölzer ausbauen, Planum herstellen — Ausbau und ' +
        'Entsorgung sind hier nicht eingerechnet.',
      'Schaumglasschotter wird ~1,3:1 verdichtet — die Kalkulation rechnet das lose Bestellvolumen ' +
        'bereits ein; ab ~30 m³ lose liefern lassen (deutlich unter dem Big-Bag-Preis).',
      'Brauchbare Bestandsdielen können wiederverlegt werden — dann entfällt die Dielen-Position.',
    ],
  },
  {
    key: 'boden-schaumglas-fbh-stampflehm-400',
    bauteil: 'kellerdecke',
    name: 'Boden gegen Erdreich: 40 cm Schaumglasschotter + Fußbodenheizung in 12 cm Stampflehm',
    layers: [
      { materialKey: 'stampflehm', thicknessM: 0.12 },
      { materialKey: 'schaumglasschotter', thicknessM: 0.4, verdichtung: 1.3 },
    ],
    zusatzkostenProM2: 30,
    zusatzkostenQuelle:
      'FBH-Rohr + Befestigung/Tackersystem ≈ 25 €/m² Material + Geotextil/Randstreifen ≈ 5 €/m² ' +
      '(Richtwert, ohne Lohn)',
    hinweise: [
      'Ersetzt den Bestandsboden: Dielen + Lagerhölzer ausbauen, Planum herstellen — Ausbau und ' +
        'Entsorgung sind hier nicht eingerechnet.',
      'Schaumglasschotter wird ~1,3:1 verdichtet — die Kalkulation rechnet das lose Bestellvolumen ' +
        'bereits ein; ab ~30 m³ lose liefern lassen (deutlich unter dem Big-Bag-Preis).',
      'Verteiler, Regelung und hydraulischer Abgleich sind ein eigenes Gewerk und hier NICHT ' +
        'eingerechnet — wie bei der Wandheizung im Kombi-Wandaufbau.',
      'Niedrige Vorlauftemperatur: passt zu Wärmepumpe; der Lehm macht den Boden träge — er ' +
        'speichert lange und reagiert langsam.',
      'Dämmung liegt UNTER der Heizschicht — die Wärme geht in den Raum, nicht ins Erdreich; die ' +
        'Aufteilung Dämmung/Heizestrich entspricht dem Prinzip des Kombi-Wandaufbaus.',
    ],
  },
];

export function presetByKey(key: string): AssemblyPreset | undefined {
  return PRESET_ASSEMBLIES.find((p) => p.key === key);
}

/**
 * The build-ups dimensioned for one component.
 *
 * Every surface that offers a choice of build-ups means *this*, not "all
 * presets" — a wall picker that lists a Kellerdecke, or a variant comparison
 * that ranks one against a façade, is comparing components that do not share a
 * threshold, a heat-flow direction or an area.
 */
export function presetsFor(bauteil: BegBauteil): AssemblyPreset[] {
  return PRESET_ASSEMBLIES.filter((p) => p.bauteil === bauteil);
}

export interface AssemblyAssessment {
  /** Thermal transmittance (W/(m²·K)). */
  U: number;
  /** Total thermal resistance (m²·K/W). */
  RTotal: number;
  /** Condensation risk in the Glaser screening. */
  tauwasser: boolean;
  /** GEG Anlage 7 maximum U-value. */
  gegMaxU: number;
  /** Whether U ≤ the GEG maximum. */
  gegPass: boolean;
}

/** One-call U-value + Tauwasser + GEG assessment of a layer stack. */
export function assessAssembly(layers: LayerSpec[], art: BauteilArt = 'wall'): AssemblyAssessment {
  const a = computeAssembly(layers, { art });
  const g = checkGeg(art, a.U);
  return { U: a.U, RTotal: a.RTotal, tauwasser: a.tauwasser, gegMaxU: g.maxU, gegPass: g.pass };
}

const lerp = (a: number, b: number, x: number): number => Math.round(a + (b - a) * x);

/**
 * Domain of the {@link uValueColor} heat scale, in W/(m²·K): green at `min`
 * (well insulated) → red at `max` (poor). Shared source of truth for the colour
 * ramp and any legend that visualises it.
 */
export const U_VALUE_SCALE = { min: 0.15, max: 0.8 } as const;

/**
 * Map a U-value to a heat-scale colour (good insulation = green → bad = red),
 * as a 0xRRGGBB integer for three.js. Anchors: {@link U_VALUE_SCALE}.min green,
 * midpoint yellow, ≥ {@link U_VALUE_SCALE}.max red.
 */
export function uValueColor(U: number): number {
  const t = Math.max(0, Math.min(1, (U - U_VALUE_SCALE.min) / (U_VALUE_SCALE.max - U_VALUE_SCALE.min)));
  let r: number;
  let g: number;
  let b: number;
  if (t < 0.5) {
    const x = t / 0.5; // green (0x4caf50) → yellow (0xffc107)
    r = lerp(0x4c, 0xff, x);
    g = lerp(0xaf, 0xc1, x);
    b = lerp(0x50, 0x07, x);
  } else {
    const x = (t - 0.5) / 0.5; // yellow → red (0xf44336)
    r = lerp(0xff, 0xf4, x);
    g = lerp(0xc1, 0x43, x);
    b = lerp(0x07, 0x36, x);
  }
  return (r << 16) | (g << 8) | b;
}
