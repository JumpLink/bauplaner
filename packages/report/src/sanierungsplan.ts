/**
 * Build the Sanierungsplan document from computed domain results.
 *
 * This is the whole report as a pure function: screenings, roadmap and variant
 * comparison in, a {@link ReportDoc} out. No I/O, no cairo, no clock — the date
 * is passed in, so the same inputs always produce the same document and a test
 * can assert on it.
 *
 * The document is written for a reader who is *not* going to check the building
 * physics: a bank, a Finanzberater, a Förderstelle. So every section leads with
 * the number that decides something (Eigenanteil, Förderung, Amortisation) and
 * keeps the derivation available underneath it — and the last page states, in
 * plain words, what this is not.
 */

import {
  COST_CATEGORY_LABEL,
  COST_STATUS_LABEL,
  type CostCategory,
  type CostStatus,
  type Envelope,
} from '@bauplaner/core';
import {
  computeAmortisation,
  computeFoerderung,
  computeRoadmap,
  ENERGIEKLASSEN,
  KATEGORIE_FARBE,
  KLASSE_FARBE,
  klassePosition,
  BEG_FOERDERFAEHIG,
  getMaterial,
  type EnergyScreening,
  type Massnahmenpaket,
  type VariantenErgebnis,
  type VergleichErgebnis,
} from '@bauplaner/materials';

import { fmtEur, fmtEur0, fmtJahre, fmtNum, fmtProzent } from './format.ts';
import type { Block, Cell, Kpi, ReportDoc, ScaleMarker, VariantCard } from './model.ts';
import { COLOR, VERLUST_FARBE, type Tone } from './theme.ts';

/** A recorded cost position, as the project stores it. */
export interface KostenPosition {
  label: string;
  net: number;
  category: string;
  status: string;
  date?: string;
}

/** The whole-building part of the report. Omit it for a component-only plan. */
export interface GebaeudeTeil {
  envelope: Envelope;
  /** Pre-retrofit baseline (every wall at the Bestand U). */
  start: EnergyScreening;
  /** Current state (walls at their assigned build-up). */
  heute: EnergyScreening;
  /** Fully retrofitted target. */
  ziel: EnergyScreening;
  /** Whether the iSFP bonus is assumed (+5 percentage points). */
  isfpBonus?: boolean;
  /** Whether the DIY-capable packages are done in Eigenleistung. */
  eigenleistung?: boolean;
  /** Quotes and planned positions already recorded in the project. */
  kosten?: KostenPosition[];
}

export interface SanierungsplanInput {
  /** Object / project name for the cover. */
  name: string;
  /** Formatted date — passed in so the builder stays free of a clock. */
  datum: string;
  ort?: string;
  verfasser?: string;
  gebaeude?: GebaeudeTeil;
  /** The component decision (usually the exterior wall). */
  wand?: VergleichErgebnis;
  /** Extra notes appended to the assumptions page. */
  hinweise?: string[];
}

const RISIKO_TONE: Record<string, Tone> = { gering: 'ok', mittel: 'warn', hoch: 'bad' };
const RISIKO_TEXT: Record<string, string> = {
  gering: 'Feuchte: geringes Risiko',
  mittel: 'Feuchte: mittleres Risiko',
  hoch: 'Feuchte: hohes Risiko',
};
/** Same verdict, one word — for the overview table's narrow column. */
const RISIKO_KURZ: Record<string, string> = { gering: 'gering', mittel: 'mittel', hoch: 'hoch' };

const cell = (text: string, extra: Partial<Cell> = {}): Cell => ({ text, ...extra });

/**
 * The Fahrplan's own share is the figure a lender actually finances, so it
 * drives the KPI row, the amortisation and the closing summary alike.
 */
function fahrplanZahlen(g: GebaeudeTeil): {
  pakete: Massnahmenpaket[];
  kosten: number;
  foerderung: number;
  eigenanteil: number;
} {
  const lossShares = Object.fromEntries(g.heute.shares.map((s) => [s.kind, s.fraction]));
  const roadmap = computeRoadmap(g.envelope, {
    foerderung: true,
    isfpBonus: g.isfpBonus ?? true,
    eigenleistung: g.eigenleistung ?? false,
    lossShares,
  });
  return {
    pakete: roadmap.pakete,
    kosten: roadmap.totalKostenEur,
    foerderung: roadmap.totalFoerderungEur,
    eigenanteil: roadmap.totalEigenanteilEur,
  };
}

/** Kennzahlen row 1 — where the building stands energetically. */
function energieKpis(g: GebaeudeTeil): Kpi[] {
  return [
    {
      caption: 'Endenergie heute',
      value: String(g.heute.endenergieKwhM2a),
      unit: 'kWh/m²a',
      badge: { text: g.heute.energieklasse, color: KLASSE_FARBE[g.heute.energieklasse] },
      sub: 'Screening, kein Energieausweis',
    },
    {
      caption: 'nach Vollsanierung',
      value: String(g.ziel.endenergieKwhM2a),
      unit: 'kWh/m²a',
      badge: { text: g.ziel.energieklasse, color: KLASSE_FARBE[g.ziel.energieklasse] },
      tone: 'ok',
      sub: `${fmtProzent(1 - g.ziel.endenergieKwhM2a / Math.max(g.heute.endenergieKwhM2a, 1))} weniger als heute`,
    },
    {
      caption: 'CO₂-Ausstoß heute',
      value: fmtNum(g.heute.co2TonsYear, 1),
      unit: 't/Jahr',
      sub: `Zielzustand ${fmtNum(g.ziel.co2TonsYear, 1)} t/Jahr`,
    },
    {
      caption: 'Beheizte Fläche',
      value: fmtNum(g.envelope.heatedFloorAreaM2, 0),
      unit: 'm²',
      sub: `${fmtNum(g.envelope.wallAreaM2, 0)} m² Außenwand · ${fmtNum(g.envelope.roofAreaM2, 0)} m² Dach`,
    },
  ];
}

/** Kennzahlen row 2 — what it costs and what comes back. */
function geldKpis(g: GebaeudeTeil): Kpi[] {
  const f = fahrplanZahlen(g);
  const a = computeAmortisation({
    endenergieHeuteKwhM2a: g.heute.endenergieKwhM2a,
    endenergieZielKwhM2a: g.ziel.endenergieKwhM2a,
    heatedFloorAreaM2: g.envelope.heatedFloorAreaM2,
    eigenanteilEur: f.eigenanteil,
  });
  return [
    {
      caption: 'Investition gesamt',
      value: fmtEur0(f.kosten),
      sub: 'alle Maßnahmenpakete, netto',
    },
    {
      caption: 'Förderung (BEG)',
      value: fmtEur0(f.foerderung),
      tone: 'accent',
      sub: `Einzelmaßnahmen${g.isfpBonus ?? true ? ' inkl. iSFP-Bonus' : ''}`,
    },
    {
      caption: 'Eigenanteil',
      value: fmtEur0(f.eigenanteil),
      tone: 'warn',
      sub: 'zu finanzierender Betrag',
    },
    {
      caption: 'Ersparnis pro Jahr',
      value: fmtEur0(a.ersparnisProJahrEur),
      tone: 'ok',
      sub: a.jahre != null ? `Amortisation ≈ ${fmtJahre(a.jahre)}` : 'keine Ersparnis im Screening',
    },
  ];
}

/** The A+…H scale with Start / Heute / Ziel markers. */
function skalaBlock(g: GebaeudeTeil): Block {
  const markers: ScaleMarker[] = [
    {
      label: `Heute ${g.heute.endenergieKwhM2a}`,
      position: klassePosition(g.heute.endenergieKwhM2a),
      color: '#e66100',
      below: true,
    },
    {
      label: `Ziel ${g.ziel.endenergieKwhM2a}`,
      position: klassePosition(g.ziel.endenergieKwhM2a),
      color: COLOR.ok,
      below: true,
    },
  ];
  // Only worth a third marker once some walls are already retrofitted.
  if (Math.abs(g.start.endenergieKwhM2a - g.heute.endenergieKwhM2a) > 2) {
    markers.push({
      label: `Start ${g.start.endenergieKwhM2a}`,
      position: klassePosition(g.start.endenergieKwhM2a),
      color: COLOR.faint,
      below: false,
    });
  }
  return {
    kind: 'scale',
    title: 'Energetische Einordnung',
    description:
      'Endenergiebedarf auf der Energieausweis-Skala — jedes Maßnahmenpaket schiebt den Marker nach links.',
    bands: ENERGIEKLASSEN.map((k) => ({ label: k, color: KLASSE_FARBE[k] })),
    markers,
  };
}

/** Maßnahmenpakete as a table, iSFP order, with the totals row. */
function fahrplanBlock(g: GebaeudeTeil): Block {
  const f = fahrplanZahlen(g);
  return {
    kind: 'table',
    title: 'Maßnahmenfahrplan',
    description:
      'Reihenfolge nach iSFP-Logik: erst die Hülle dichten und dämmen, die Anlagentechnik zuletzt — ' +
      'eine Wärmepumpe in einem ungedämmten Haus wird zu groß und zu teuer ausgelegt.',
    columns: [
      { label: '', flex: 0.5, align: 'right' },
      { label: 'Maßnahmenpaket', flex: 5 },
      { label: 'Bezug', flex: 1.6, align: 'right' },
      { label: 'Kosten', flex: 2, align: 'right' },
      { label: 'Förderung', flex: 2, align: 'right' },
      { label: 'Eigenanteil', flex: 2, align: 'right' },
    ],
    rows: f.pakete.map((p) => [
      cell(String(p.nr), { tone: 'dim' }),
      cell(p.eigenleistung ? `${p.title} (Eigenleistung)` : p.title),
      cell(p.areaM2 > 0 ? `${fmtNum(p.areaM2, 0)} m²` : 'pauschal', { tone: 'dim' }),
      cell(fmtEur0(p.kostenEur)),
      cell(p.foerderungEur > 0 ? fmtEur0(p.foerderungEur) : '—', {
        tone: p.foerderungEur > 0 ? 'accent' : 'dim',
      }),
      cell(fmtEur0(p.eigenanteilEur)),
    ]),
    total: [
      cell(''),
      cell('Summe'),
      cell(''),
      cell(fmtEur0(f.kosten)),
      cell(fmtEur0(f.foerderung), { tone: 'accent' }),
      cell(fmtEur0(f.eigenanteil)),
    ],
  };
}

/** Heizkosten heute vs. Zielzustand, and what the own share pays back. */
function wirtschaftlichkeitBlock(g: GebaeudeTeil): Block {
  const f = fahrplanZahlen(g);
  const a = computeAmortisation({
    endenergieHeuteKwhM2a: g.heute.endenergieKwhM2a,
    endenergieZielKwhM2a: g.ziel.endenergieKwhM2a,
    heatedFloorAreaM2: g.envelope.heatedFloorAreaM2,
    eigenanteilEur: f.eigenanteil,
  });
  return {
    kind: 'rows',
    title: 'Wirtschaftlichkeit',
    description: 'Energiekosten heute gegen den sanierten Zielzustand, und wie lange der Eigenanteil braucht.',
    rows: [
      { label: 'Energiekosten heute', value: `${fmtEur(a.kostenHeuteEur)} / Jahr` },
      { label: 'Energiekosten nach Sanierung', value: `${fmtEur(a.kostenZielEur)} / Jahr`, tone: 'ok' },
      { label: 'Jährliche Ersparnis', value: `${fmtEur(a.ersparnisProJahrEur)} / Jahr`, tone: 'ok' },
      { label: 'Investition (netto)', value: fmtEur(f.kosten) },
      {
        label: 'abzüglich Förderung',
        value: `− ${fmtEur(f.foerderung)}`,
        tone: 'accent',
        indent: true,
        sub: 'BEG-Einzelmaßnahmen Gebäudehülle, Antrag vor Beauftragung',
      },
      { label: 'Eigenanteil', value: fmtEur(f.eigenanteil), strong: true },
      { label: 'Amortisation des Eigenanteils', value: fmtJahre(a.jahre), strong: true },
    ],
  };
}

/** Quotes and planned positions already recorded in the project. */
function kostenBlock(positionen: KostenPosition[], isfpBonus: boolean): Block[] {
  if (positionen.length === 0) return [];
  const summe = positionen.reduce((s, p) => s + p.net, 0);
  const foerderfaehig = positionen
    .filter((p) => BEG_FOERDERFAEHIG.includes(p.category))
    .reduce((s, p) => s + p.net, 0);
  const foerder = computeFoerderung(foerderfaehig, { isfpBonus });
  return [
    {
      kind: 'table',
      title: 'Erfasste Angebote und Kostenpositionen',
      description:
        'Konkret vorliegende Zahlen — im Unterschied zum Fahrplan oben, der aus Flächen und ' +
        'Richtwerten hochgerechnet ist.',
      columns: [
        { label: 'Position', flex: 5 },
        { label: 'Gewerk', flex: 2 },
        { label: 'Status', flex: 2 },
        { label: 'Netto', flex: 2, align: 'right' },
      ],
      rows: positionen.map((p) => [
        cell(p.label),
        cell(COST_CATEGORY_LABEL[p.category as CostCategory] ?? p.category, { tone: 'dim' }),
        cell(COST_STATUS_LABEL[p.status as CostStatus] ?? p.status, { tone: 'dim' }),
        cell(fmtEur(p.net)),
      ]),
      total: [cell('Summe'), cell(''), cell(''), cell(fmtEur(summe))],
    },
    {
      kind: 'rows',
      rows: [
        { label: 'davon BEG-förderfähig', value: fmtEur(foerderfaehig), sub: 'Dämmung, Fassade, Abdichtung' },
        {
          label: `Förderung bei ${fmtProzent(foerder.rate)}`,
          value: fmtEur(foerder.foerderung),
          tone: 'accent',
        },
      ],
    },
  ];
}

/** One build-up as a card: the strip, the chips, the four verdicts, the caveats. */
function variantCard(v: VariantenErgebnis, istReferenz: boolean): VariantCard {
  const chips: { text: string; tone: Tone }[] = [
    { text: RISIKO_TEXT[v.feuchte.risiko] ?? v.feuchte.risiko, tone: RISIKO_TONE[v.feuchte.risiko] ?? 'neutral' },
  ];
  if (!istReferenz) {
    chips.push(
      v.begPass
        ? { text: `BEG-förderfähig (U ≤ ${fmtNum(v.begMaxU, 2)})`, tone: 'ok' }
        : { text: `verfehlt U ≤ ${fmtNum(v.begMaxU, 2)} — keine Förderung`, tone: 'bad' },
    );
    chips.push({
      text: `Dämmung ${fmtProzent(v.feuchte.daemmungAussenAnteil)} außerhalb des Mauerwerks`,
      tone: v.feuchte.daemmungAussenAnteil >= 0.8 ? 'ok' : 'dim',
    });
    if (v.oekobilanz.gwpNettoKg <= 0) {
      chips.push({ text: 'speichert mehr CO₂, als die Herstellung freisetzt', tone: 'ok' });
    }
  }

  const metrics = istReferenz
    ? [
        { label: 'U-Wert', value: `${fmtNum(v.U, 3)} W/(m²·K)` },
        { label: 'Heizkosten', value: `${fmtEur(v.heizkostenEurA)} / Jahr` },
        { label: 'CO₂ Betrieb', value: `${fmtNum(v.co2KgA, 0)} kg / Jahr` },
      ]
    : [
        { label: 'U-Wert', value: `${fmtNum(v.U, 3)} W/(m²·K)`, tone: v.begPass ? ('ok' as Tone) : ('warn' as Tone) },
        { label: 'Investition netto', value: fmtEur0(v.investitionNet) },
        {
          label: `− Förderung (${fmtProzent(v.foerderquote)})`,
          value: fmtEur0(v.foerderung),
          tone: (v.foerderung > 0 ? 'accent' : 'dim') as Tone,
        },
        { label: 'Eigenanteil', value: fmtEur0(v.eigenanteil), tone: 'warn' as Tone },
        { label: 'spart pro Jahr', value: `${fmtEur0(v.ersparnisEurA)} · ${fmtNum(v.ersparnisCo2KgA, 0)} kg CO₂`, tone: 'ok' as Tone },
        { label: 'Amortisation', value: fmtJahre(v.amortisationJahre) },
        {
          label: 'Graues CO₂ (netto, A1–A3)',
          value: `${fmtNum(v.oekobilanz.gwpNettoKg, 0)} kg`,
          tone: (v.oekobilanz.gwpNettoKg <= 0 ? 'ok' : 'neutral') as Tone,
        },
        { label: 'Aufbau innen / außen', value: `${fmtNum(v.aufbauInnenM * 100, 0)} / ${fmtNum(v.aufbauAussenM * 100, 0)} cm` },
      ];

  const notizen = [...v.hinweise];
  // A layer with no price makes its variant look cheaper than it is, which would
  // quietly bias the ranking. Say so rather than hide it.
  if (v.ohnePreis.length > 0) {
    notizen.push(`Ohne hinterlegten Preis, Investition daher zu niedrig: ${v.ohnePreis.join(', ')}.`);
  }

  return {
    rank: istReferenz ? '—' : String(v.rang ?? '—'),
    name: istReferenz ? `Ausgangslage — ${v.name}` : v.name,
    headline: istReferenz
      ? `${fmtEur(v.heizkostenEurA)}/Jahr Heizkosten · ${fmtNum(v.co2KgA, 0)} kg CO₂/Jahr`
      : `Eigenanteil ${fmtEur0(v.eigenanteil)} · spart ${fmtEur0(v.ersparnisEurA)}/Jahr · ${fmtJahre(v.amortisationJahre)}`,
    badge: { text: `U ${fmtNum(v.U, 2)}`, tone: istReferenz ? 'dim' : v.begPass ? 'ok' : 'warn' },
    best: !istReferenz && v.rang === 1,
    chips,
    metrics,
    layers: v.layers.map((l) => ({
      name: l.name,
      cm: l.thicknessM * 100,
      color: KATEGORIE_FARBE[getMaterial(l.key).category],
      bestand: l.bestand === true,
    })),
    notes: notizen,
  };
}

/**
 * The component decision: first the ranking at a glance, then one card per
 * build-up.
 *
 * The overview table exists for the reader who will not go through eight cards —
 * a lender wants the Eigenanteil column and the payback column, and everything
 * else is the justification they can check if they want to. The weighting is
 * stated in the section description rather than in a callout of its own, so it
 * cannot get orphaned onto a page by itself.
 */
function variantenBloecke(wand: VergleichErgebnis): Block[] {
  const g = wand.gewichtung;
  const zeile = (v: VariantenErgebnis, istReferenz: boolean): Cell[] => [
    cell(istReferenz ? '—' : String(v.rang ?? ''), { tone: 'dim' }),
    cell(istReferenz ? `Ausgangslage — ${v.name}` : v.name, { strong: !istReferenz && v.rang === 1 }),
    cell(fmtNum(v.U, 3)),
    cell(RISIKO_KURZ[v.feuchte.risiko] ?? v.feuchte.risiko, { tone: RISIKO_TONE[v.feuchte.risiko] }),
    cell(istReferenz ? '—' : v.begPass ? 'ja' : 'nein', {
      tone: istReferenz ? 'dim' : v.begPass ? 'ok' : 'bad',
    }),
    cell(istReferenz ? '—' : fmtEur0(v.eigenanteil)),
    cell(istReferenz ? '—' : fmtEur0(v.ersparnisEurA), { tone: istReferenz ? 'dim' : 'ok' }),
    cell(istReferenz ? '—' : fmtJahre(v.amortisationJahre)),
  ];

  return [
    {
      kind: 'table',
      title: 'Entscheidung Außenwand',
      description:
        `Aufbauten innen → außen, gerechnet für ${fmtNum(wand.areaM2, 0)} m² Außenwandfläche und ` +
        'bewertet auf Feuchte (DIN 4108-3), Energie, Eigenanteil nach Förderung und Ökobilanz. ' +
        `Gewichtet mit Kosten ${fmtProzent(g.kosten)} · Energie ${fmtProzent(g.energie)} · ` +
        `Ökologie ${fmtProzent(g.oekologie)} · Feuchterisiko ${fmtProzent(g.feuchte)}; jedes Kriterium ` +
        'über das Vergleichsfeld auf 0…1 normiert. Wer anders gewichtet, bekommt eine andere ' +
        'Reihenfolge — deshalb stehen die Einzelwerte darunter.',
      columns: [
        { label: '#', flex: 0.5, align: 'right' },
        { label: 'Aufbau', flex: 4.7 },
        { label: 'U-Wert', flex: 1.4, align: 'right' },
        { label: 'Feuchte', flex: 1.4 },
        { label: 'BEG', flex: 0.8 },
        { label: 'Eigenanteil', flex: 2, align: 'right' },
        { label: 'spart/Jahr', flex: 2, align: 'right' },
        { label: 'Amortisation', flex: 2.2, align: 'right' },
      ],
      rows: [zeile(wand.referenz, true), ...wand.varianten.map((v) => zeile(v, false))],
    },
    {
      kind: 'variants',
      title: 'Die Aufbauten im Einzelnen',
      description:
        'Schichtdicken in cm, innen → außen; der schraffierte Teil ist Bestand und geht in keine ' +
        'Kosten- oder CO₂-Zahl ein.',
      items: [variantCard(wand.referenz, true), ...wand.varianten.map((v) => variantCard(v, false))],
    },
  ];
}

/** What this document is not — the last page, and the most important one. */
function annahmenBlock(input: SanierungsplanInput): Block {
  const paragraphs = [
    'Dieser Plan ist ein Screening auf Basis der erfassten Gebäudegeometrie und veröffentlichter ' +
      'Richtwerte. Er ersetzt weder einen individuellen Sanierungsfahrplan (iSFP) eines ' +
      'Energieeffizienz-Experten noch ein Angebot eines ausführenden Betriebs.',
    'Der Wärmebedarf ist über Heizgradstunden abgeschätzt, nicht über eine Bilanz nach DIN V 18599. ' +
      'Die Feuchtebewertung folgt dem Glaser-Verfahren nach DIN 4108-3; dieses Verfahren kennt ' +
      'keinen Kapillartransport, weshalb kapillaraktive Aufbauten auf dem Papier schlechter ' +
      'abschneiden, als sie sich in der Wand verhalten. Wo das den Ausschlag gibt, ist es an der ' +
      'Variante vermerkt und gehört vor der Ausführung durch eine hygrothermische Simulation geprüft.',
    'Die Ökobilanz umfasst die Herstellung (Module A1–A3) und trennt fossiles von biogenem CO₂; ' +
      'Transport, Einbau, Nutzung und Rückbau sind nicht enthalten.',
    'Materialpreise sind Richtwerte ohne Lohn — die Aufbauten unterstellen Eigenleistung. ' +
      'Fördersätze bilden die BEG-Einzelmaßnahmen zum Stand der Erstellung ab; maßgeblich ist ' +
      'allein der Zuwendungsbescheid, und der Antrag muss vor Beauftragung gestellt sein.',
  ];
  if (input.hinweise && input.hinweise.length > 0) paragraphs.push(...input.hinweise);
  return {
    kind: 'prose',
    title: 'Annahmen und Vorbehalte',
    description: 'Was in diesen Zahlen steckt — und was nicht.',
    paragraphs,
  };
}

/**
 * Assemble the Sanierungsplan.
 *
 * @param input Object metadata plus whichever parts are available: the
 *   whole-building screening, the component comparison, or both.
 * @returns The document, ready for {@link renderReportPdf}.
 */
export function buildSanierungsplan(input: SanierungsplanInput): ReportDoc {
  const blocks: Block[] = [];
  const g = input.gebaeude;

  if (g) {
    blocks.push({ kind: 'kpis', title: 'Kennzahlen', items: [...energieKpis(g), ...geldKpis(g)] });
    blocks.push(skalaBlock(g));
    blocks.push({
      kind: 'bars',
      title: 'Wo die Wärme entweicht',
      description: 'Anteile am Transmissions- und Lüftungsverlust im heutigen Zustand.',
      items: g.heute.shares.map((s) => ({
        label: s.label,
        value: fmtProzent(s.fraction),
        fraction: s.fraction,
        color: VERLUST_FARBE[s.kind] ?? COLOR.accent,
      })),
    });
    blocks.push({ kind: 'pagebreak' });
    blocks.push(fahrplanBlock(g));
    blocks.push(wirtschaftlichkeitBlock(g));
    blocks.push(...kostenBlock(g.kosten ?? [], g.isfpBonus ?? true));
    blocks.push({
      kind: 'callout',
      tone: 'warn',
      title: 'Der Fahrplan ist hochgerechnet, nicht angeboten',
      text:
        'Die Paketkosten entstehen aus Fläche × Richtwert je Gewerk. Sie taugen zur Reihenfolge und ' +
        'zur Größenordnung der Finanzierung, nicht zur Beauftragung. Belastbar wird eine Position ' +
        'erst mit einem Angebot — erfasste Angebote stehen oben getrennt ausgewiesen.',
    });
  }

  if (input.wand) {
    if (g) blocks.push({ kind: 'pagebreak' });
    blocks.push(...variantenBloecke(input.wand));
  }

  blocks.push({ kind: 'pagebreak' });
  blocks.push(annahmenBlock(input));

  const meta = [
    { label: 'Objekt', value: input.ort ? `${input.name}, ${input.ort}` : input.name },
    { label: 'Stand', value: input.datum },
  ];
  if (input.verfasser) meta.push({ label: 'Erstellt von', value: input.verfasser });

  return {
    title: 'Sanierungsplan',
    subtitle: input.name,
    lead:
      'Energetische Einordnung, Maßnahmenfahrplan und Bauteilentscheidung für die ökologische ' +
      'Sanierung — als Grundlage für das Finanzierungsgespräch.',
    meta,
    blocks,
    footer: `Sanierungsplan ${input.name} · Screening, kein Nachweis · Stand ${input.datum}`,
  };
}
