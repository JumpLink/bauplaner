/**
 * Rule-based screening for the cause of a damp wall (Feuchte-Diagnose).
 *
 * This is a **transparent heuristic** to narrow down likely causes and point to
 * suitable (diffusion-open) measures — not a substitute for on-site moisture
 * measurement (Darr-/CM-Messung) or a building surveyor. Each observation adds
 * weighted evidence to one or more causes; scores are then normalised so the
 * most likely cause reads 100 %.
 */

export type Cause =
  | 'aufsteigend' // rising damp (missing/failed horizontal barrier)
  | 'aufstauend_seitlich' // lateral / below-grade water ingress
  | 'kondensat' // surface/interstitial condensation
  | 'leitung' // pipe / roof / gutter leak
  | 'schlagregen' // driving rain through the façade
  | 'neubaufeuchte'; // residual construction moisture

export type Location = 'keller' | 'sockel' | 'wohnraum' | 'dach';

export interface FeuchteObservation {
  /** Where the dampness shows. */
  location?: Location;
  /** How high the dampness rises above the floor (cm). */
  riseHeightCm?: number;
  /** Affected wall is earth-facing / below ground. */
  belowGrade?: boolean;
  /** Worse during/after rain or high water table. */
  weatherCorrelated?: boolean;
  /** Worse in the heating season (winter). */
  worseInHeatingSeason?: boolean;
  /** Salt efflorescence / a horizontal tide-line is visible. */
  saltEfflorescence?: boolean;
  /** Mould in corners / behind furniture / on cold spots. */
  mouldCorners?: boolean;
  /** Dampness appeared suddenly. */
  suddenOnset?: boolean;
  /** Close to a pipe, roof or gutter. */
  nearPipeOrRoof?: boolean;
  /** On the weather-facing façade (driving-rain side). */
  weatherSideFacade?: boolean;
  /** Measured indoor relative humidity (%). */
  indoorHumidityPct?: number;
  /** Recent construction / wet trades on this wall. */
  recentConstruction?: boolean;
}

export interface CauseScore {
  cause: Cause;
  label: string;
  /** Relative confidence 0..1 (top cause = 1). */
  confidence: number;
  /** Raw weighted score before normalisation. */
  raw: number;
  /** Observations that support this cause. */
  evidence: string[];
  /** Recommended, diffusion-open-minded measures. */
  measures: string[];
}

export interface FeuchteDiagnosis {
  causes: CauseScore[];
  note: string;
}

export const CAUSE_LABELS: Record<Cause, string> = {
  aufsteigend: 'Aufsteigende Feuchte (fehlende/defekte Horizontalsperre)',
  aufstauend_seitlich: 'Seitlich eindringendes / aufstauendes Wasser (erdberührt)',
  kondensat: 'Kondensat / Tauwasser (Oberfläche oder im Aufbau)',
  leitung: 'Defekte Leitung / Dach / Regenrinne',
  schlagregen: 'Schlagregen durch die Fassade',
  neubaufeuchte: 'Neubau-/Baurestfeuchte',
};

const MEASURES: Record<Cause, string[]> = {
  aufsteigend: [
    'Nachträgliche Horizontalsperre (Injektion oder Mauersägeverfahren) — eine Vertikalabdichtung allein stoppt aufsteigende Feuchte NICHT.',
    'Sockel diffusionsoffen sanieren (Kalk-/Sanierputz), Salzbelastung berücksichtigen.',
    'Feuchte- und Salzmessung zur Bestätigung.',
  ],
  aufstauend_seitlich: [
    'Erdberührte Vertikalabdichtung der Wand (Lastfall „aufstauendes Sickerwasser") — vgl. `lehmgraben`-Kommando (DERNOTON/Lehm).',
    'Wasser vom Haus wegführen: Gefälle, Rohr/Dränage zum Vorfluter (Wettern) — Verockerungsrisiko im eisenhaltigen Boden beachten.',
    'Kein dampfdichter Innenanstrich auf der feuchten Wand (Feuchtefalle).',
  ],
  kondensat: [
    'Wärmebrücke/Dämmung verbessern (U-Wert erhöhen) — Aufbau mit `bauteil` prüfen (Glaser/Tauwasser).',
    'Feuchtelast senken und gezielt lüften; diffusionsoffene Innenoberflächen (Kalk-/Lehmputz).',
    'Keine dampfdichte Sperre an der falschen Stelle einbauen.',
  ],
  leitung: [
    'Leitung/Dach/Regenrinne prüfen und instand setzen; ggf. Leckortung beauftragen.',
    'Erst nach Trocknung wieder verschließen.',
  ],
  schlagregen: [
    'Fassade/Fugen instand setzen, diffusionsoffenen Schlagregenschutz vorsehen (z. B. Kalkputzsystem).',
    'Bei Innendämmung WTA-konform planen (Tauwasser prüfen: `bauteil`).',
  ],
  neubaufeuchte: [
    'Austrocknung abwarten/unterstützen (heizen, lüften), erst danach dampfbremsend schließen.',
  ],
};

interface Rule {
  when: (o: FeuchteObservation) => boolean;
  points: number;
  evidence: string;
}

const RULES: Record<Cause, Rule[]> = {
  aufsteigend: [
    { when: (o) => o.location === 'sockel' || o.location === 'keller', points: 2, evidence: 'Feuchte im Sockel-/Kellerbereich' },
    { when: (o) => o.riseHeightCm != null && o.riseHeightCm >= 20 && o.riseHeightCm <= 150, points: 2, evidence: 'gleichmäßiger Feuchtehorizont bis ~1–1,5 m' },
    { when: (o) => o.saltEfflorescence === true, points: 3, evidence: 'Salzausblühungen / Feuchterand' },
    { when: (o) => o.weatherCorrelated === false, points: 1, evidence: 'unabhängig vom Wetter vorhanden' },
    { when: (o) => o.mouldCorners === true, points: -1, evidence: '' },
  ],
  aufstauend_seitlich: [
    { when: (o) => o.belowGrade === true, points: 3, evidence: 'erdberührte / unter Gelände liegende Wand' },
    { when: (o) => o.location === 'keller', points: 2, evidence: 'Kellerwand betroffen' },
    { when: (o) => o.weatherCorrelated === true, points: 2, evidence: 'schlimmer bei Regen / hohem Wasserstand' },
    { when: (o) => o.worseInHeatingSeason === false, points: 1, evidence: 'nicht an die Heizsaison gekoppelt' },
  ],
  kondensat: [
    { when: (o) => o.mouldCorners === true, points: 3, evidence: 'Schimmel in Ecken / hinter Möbeln' },
    { when: (o) => o.worseInHeatingSeason === true, points: 2, evidence: 'schlimmer in der Heizsaison' },
    { when: (o) => o.indoorHumidityPct != null && o.indoorHumidityPct >= 60, points: 2, evidence: 'hohe Raumluftfeuchte (≥ 60 %)' },
    { when: (o) => o.location === 'wohnraum', points: 1, evidence: 'im beheizten Wohnraum' },
    { when: (o) => o.saltEfflorescence === true, points: -1, evidence: '' },
  ],
  leitung: [
    { when: (o) => o.suddenOnset === true, points: 3, evidence: 'plötzliches Auftreten' },
    { when: (o) => o.nearPipeOrRoof === true, points: 3, evidence: 'in der Nähe von Leitung/Dach/Rinne' },
    { when: (o) => o.weatherCorrelated === false && o.worseInHeatingSeason === false, points: 1, evidence: 'weder wetter- noch saisonabhängig' },
  ],
  schlagregen: [
    { when: (o) => o.weatherSideFacade === true, points: 3, evidence: 'wetterzugewandte Fassade (Schlagregenseite)' },
    { when: (o) => o.weatherCorrelated === true, points: 2, evidence: 'schlimmer bei Regen' },
    { when: (o) => o.location === 'wohnraum' || o.location === 'sockel', points: 1, evidence: 'oberhalb Gelände betroffen' },
  ],
  neubaufeuchte: [
    { when: (o) => o.recentConstruction === true, points: 4, evidence: 'kürzlich verbaute Feuchte (Nassprozesse)' },
  ],
};

const ALL_CAUSES = Object.keys(RULES) as Cause[];

/**
 * Screen the likely causes of a damp wall from a set of observations.
 *
 * @param obs Observed signs (all optional; more input → sharper ranking).
 * @returns Ranked causes (confidence 0..1, evidence, measures) plus a disclaimer.
 */
export function diagnoseFeuchte(obs: FeuchteObservation): FeuchteDiagnosis {
  const scored: CauseScore[] = ALL_CAUSES.map((cause) => {
    const evidence: string[] = [];
    let raw = 0;
    for (const rule of RULES[cause]) {
      if (rule.when(obs)) {
        raw += rule.points;
        if (rule.evidence) evidence.push(rule.evidence);
      }
    }
    return {
      cause,
      label: CAUSE_LABELS[cause],
      confidence: 0,
      raw: Math.max(0, raw),
      evidence,
      measures: MEASURES[cause],
    };
  });

  const maxRaw = Math.max(0, ...scored.map((s) => s.raw));
  for (const s of scored) {
    s.confidence = maxRaw > 0 ? Math.round((s.raw / maxRaw) * 100) / 100 : 0;
  }

  const causes = scored
    .filter((s) => s.raw > 0)
    .sort((a, b) => b.raw - a.raw);

  return {
    causes,
    note: 'Heuristisches Screening — ersetzt keine Feuchtemessung (Darr-/CM-Methode) oder Bausachverständigen. Grundsatz: diffusionsoffen bleiben, keine Feuchtefalle schaffen.',
  };
}
