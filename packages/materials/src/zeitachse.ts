/**
 * The time axis of the funding rules — dated values as validity spans.
 *
 * Most of what BEG EM pays is not a constant but a *step function of the
 * application date*: the heat-generator ceiling shrinks every six months, the
 * heat-pump base rate halves in 2027, the Klimageschwindigkeits-Bonus melts away
 * in four steps. Written as plain constants, every value in the file is silently
 * wrong on some date — and the wrongness is invisible, because the number still
 * looks authoritative.
 *
 * So a dated value is a **list of validity spans**, each carrying where it comes
 * from and when that source was read, and it is read through a `…Am(datum)`
 * selector. Three things follow, and all three are the point:
 *
 * 1. **Nothing is overwritten.** Amending the rules appends a span; the old one
 *    stays and keeps answering for old dates, so a plan drafted last year can
 *    still be reproduced.
 * 2. **The step dates are data**, not prose in a comment — which is what makes
 *    {@link stichtageAus} (and with it "what does waiting cost") possible at all.
 * 3. **Provenance travels with the value**, the same discipline the material
 *    stock uses for prices (`price.source` / `price.retrievedAt` in
 *    `materials.ts`): a figure without a Fundstelle cannot be re-checked.
 *
 * **The kernel never reads a clock.** Every function here takes the date as an
 * argument; the adapter (CLI, app) is the only place allowed to ask what day it
 * is — the same rule `@bauplaner/report`'s `grundriss.ts` states for the cover
 * date. Tests are therefore reproducible without freezing time.
 *
 * Dates are ISO `YYYY-MM-DD` strings throughout and compared as strings, which
 * is exact for that format. The two places that need real day arithmetic use an
 * explicit civil-calendar conversion instead of `Date`, so the clock-freedom is
 * visible in the code rather than merely asserted.
 *
 * Only values that actually move live here. The envelope figures (base rate,
 * iSFP bonus, the 30 000/60 000 € ceilings) have not changed and stay plain
 * constants in `foerderung.ts` — putting a stable value on a time axis costs
 * every reader a lookup and buys nothing.
 */

/**
 * State of the rules encoded in this package: which Richtlinie/Merkblatt was
 * read, and when it was transcribed. Both matter and they are not the same
 * date — the Richtlinie is what the law says, `eingepflegtAm` is when a human
 * last compared this code against it.
 *
 * The BEG was re-issued from scratch on 21.07.2026. It will happen again, and a
 * calculator that quietly keeps answering with superseded rates is worse than
 * one that refuses: the number looks exactly as trustworthy as before. Hence
 * {@link regelstandWarnung}, which the adapters print.
 */
export const BEG_REGELSTAND = {
  /** Date of the BEG-EM Förderrichtlinie this package encodes. */
  richtlinie: '2026-07-17',
  /** In force from — everything here answers for dates at or after this. */
  inKraftAb: '2026-07-21',
  /** Stated end of the Richtlinie's validity. */
  gueltigBis: '2030-12-31',
  /** When these rules were last read from the source and written down here. */
  eingepflegtAm: '2026-08-13',
} as const;

/**
 * How far past {@link BEG_REGELSTAND}.eingepflegtAm a requested date may lie
 * before the adapters warn. Three months is roughly the interval at which BEG
 * rates and ceilings have actually moved; the point is not precision but that
 * silence stops being the default answer.
 */
export const REGELSTAND_WARNUNG_TAGE = 90;

/** One validity span of a dated value. */
export interface Gueltigkeitsspanne<T> {
  /** ISO date the value takes effect, inclusive. */
  gueltigAb: string;
  /** ISO date the value stops applying, inclusive; open-ended when absent. */
  gueltigBis?: string;
  wert: T;
  /** Fundstelle: Richtlinie/Merkblatt plus the number the value is stated in. */
  quelle: string;
  /** When that source was read — same discipline as a material price. */
  abgerufenAm: string;
}

/** A dated value: its spans, oldest first, non-overlapping. */
export type Zeitreihe<T> = readonly Gueltigkeitsspanne<T>[];

/**
 * One dated value as it appears in the deadline list: the series plus what to
 * call it and how to render one of its values.
 *
 * A registry of these is what lets a new dated rule show up in "was ändert sich
 * wann" by being declared, rather than by someone remembering to extend a second
 * list — the second list is the one that goes stale.
 */
export interface ZeitreiheEintrag {
  /** Stable id, e.g. `heizung-hoechstbetrag`. */
  id: string;
  /** What the value is, in plain German. */
  name: string;
  reihe: Zeitreihe<number>;
  /** Renders one value for the change log (`28.000 €`, `30 %`, `16 %-Punkte`). */
  format: (wert: number) => string;
}

/** One rule changing on a Stichtag. */
export interface Aenderung {
  /** Id of the series that changes, or of a project-specific threshold. */
  reihe: string;
  name: string;
  /** Rendered change (`28.000 € → 27.250 €`) — worded once, for every surface. */
  text: string;
  quelle: string;
  /** Old / new value, where the change comes from a time series. */
  vorher?: number;
  nachher?: number;
}

/** A date on which at least one rule changes. */
export interface Stichtag {
  /** ISO date the changes take effect, inclusive. */
  datum: string;
  aenderungen: Aenderung[];
}

const ISO_DATUM = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether a string is a well-formed ISO `YYYY-MM-DD` date. */
export function istIsoDatum(s: string): boolean {
  const m = ISO_DATUM.exec(s);
  if (!m) return false;
  const monat = Number(m[2]);
  const tag = Number(m[3]);
  return monat >= 1 && monat <= 12 && tag >= 1 && tag <= tageImMonat(Number(m[1]), monat);
}

function parseIso(datum: string): [number, number, number] {
  const m = ISO_DATUM.exec(datum);
  if (!m || !istIsoDatum(datum)) {
    throw new Error(`Datum muss ISO YYYY-MM-DD sein (war: "${datum}")`);
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function istSchaltjahr(jahr: number): boolean {
  return (jahr % 4 === 0 && jahr % 100 !== 0) || jahr % 400 === 0;
}

function tageImMonat(jahr: number, monat: number): number {
  if (monat === 2) return istSchaltjahr(jahr) ? 29 : 28;
  return monat === 4 || monat === 6 || monat === 9 || monat === 11 ? 30 : 31;
}

function iso(jahr: number, monat: number, tag: number): string {
  return `${String(jahr).padStart(4, '0')}-${String(monat).padStart(2, '0')}-${String(tag).padStart(2, '0')}`;
}

/**
 * Days since 1970-01-01 for a civil date — Howard Hinnant's `days_from_civil`,
 * exact for the whole proleptic Gregorian calendar.
 *
 * Written out rather than delegated to `Date` so that "this module never reads
 * the clock" is something a reader can *see*: there is no clock in reach.
 */
function tageSeitEpoche(datum: string): number {
  const [j0, m, t] = parseIso(datum);
  const jahr = m <= 2 ? j0 - 1 : j0;
  const aera = Math.floor(jahr / 400);
  const jahrDerAera = jahr - aera * 400; // [0, 399]
  const tagDesJahres = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + t - 1; // [0, 365]
  const tagDerAera = jahrDerAera * 365 + Math.floor(jahrDerAera / 4) - Math.floor(jahrDerAera / 100) + tagDesJahres;
  return aera * 146097 + tagDerAera - 719468;
}

/** Whole days from `von` to `bis` — negative when `bis` is earlier. */
export function tageZwischen(von: string, bis: string): number {
  return tageSeitEpoche(bis) - tageSeitEpoche(von);
}

/**
 * Shift a date by whole years, clamping the day to the target month (29.02 +
 * 1 year → 28.02). Used for age thresholds such as the 20 years a gas heating
 * must have run before its replacement earns the Klimageschwindigkeits-Bonus.
 */
export function plusJahre(datum: string, jahre: number): string {
  const [j, m, t] = parseIso(datum);
  const zielJahr = j + jahre;
  return iso(zielJahr, m, Math.min(t, tageImMonat(zielJahr, m)));
}

/** `2026-07-21` → `21.07.2026`, the way a German document writes a date. */
export function formatDatum(datum: string): string {
  const [j, m, t] = parseIso(datum);
  return `${String(t).padStart(2, '0')}.${String(m).padStart(2, '0')}.${j}`;
}

/** The span that covers `datum`, or `undefined` outside the modelled range. */
export function spanneAm<T>(reihe: Zeitreihe<T>, datum: string): Gueltigkeitsspanne<T> | undefined {
  parseIso(datum); // reject a malformed date here, not silently as "no span"
  return reihe.find((s) => datum >= s.gueltigAb && (s.gueltigBis === undefined || datum <= s.gueltigBis));
}

/**
 * The value in force on `datum`, or `undefined` outside the modelled range.
 *
 * Deliberately *not* clamped to the nearest span: answering a 2019 question with
 * 2026 rates is the exact failure this module exists to prevent. Callers decide
 * what an out-of-range date means and say so out loud.
 */
export function wertAm<T>(reihe: Zeitreihe<T>, datum: string): T | undefined {
  return spanneAm(reihe, datum)?.wert;
}

/**
 * Structural problems of a series: unsorted spans, overlaps, gaps, malformed
 * dates. Not called at runtime — a test walks every registered series through
 * it, so a mistyped `gueltigAb` fails the suite instead of quietly shadowing a
 * later span.
 */
export function pruefeZeitreihe<T>(reihe: Zeitreihe<T>): string[] {
  const probleme: string[] = [];
  reihe.forEach((s, i) => {
    if (!istIsoDatum(s.gueltigAb)) probleme.push(`Spanne ${i}: gueltigAb "${s.gueltigAb}" ist kein ISO-Datum`);
    if (s.gueltigBis !== undefined && !istIsoDatum(s.gueltigBis)) {
      probleme.push(`Spanne ${i}: gueltigBis "${s.gueltigBis}" ist kein ISO-Datum`);
    }
    if (!istIsoDatum(s.abgerufenAm)) probleme.push(`Spanne ${i}: abgerufenAm "${s.abgerufenAm}" ist kein ISO-Datum`);
    if (s.quelle.trim() === '') probleme.push(`Spanne ${i}: quelle fehlt`);
    if (s.gueltigBis !== undefined && s.gueltigBis < s.gueltigAb) {
      probleme.push(`Spanne ${i}: gueltigBis liegt vor gueltigAb`);
    }
    if (i > 0) {
      const vor = reihe[i - 1];
      if (s.gueltigAb <= vor.gueltigAb) probleme.push(`Spanne ${i}: nicht chronologisch sortiert`);
      if (vor.gueltigBis === undefined) probleme.push(`Spanne ${i - 1}: offenes Ende, aber es folgt eine Spanne`);
      else if (tageZwischen(vor.gueltigBis, s.gueltigAb) !== 1) {
        probleme.push(`Spanne ${i}: Lücke oder Überlappung zu Spanne ${i - 1}`);
      }
    }
  });
  return probleme;
}

/**
 * German thousands/decimal separators for the change-log labels.
 *
 * Deliberately private: `fmtNum` / `fmtEur` in `@bauplaner/report` are the
 * shared formatters, but that package depends on this one, so importing them
 * would close a cycle. This is a handful of labels, not a second public
 * formatting API — figures a surface renders itself still go through `fmtEur`.
 */
function zahl(n: number, stellen = 0): string {
  const [ganz, bruch] = Math.abs(n).toFixed(stellen).split('.');
  const gruppiert = ganz.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '-' : ''}${gruppiert}${bruch ? `,${bruch}` : ''}`;
}

/** `28000` → `28.000 €`. For the change log; surfaces use `fmtEur`. */
export function formatEuro(n: number): string {
  return `${zahl(n)} €`;
}

/** `30` → `30 %`. The series store whole percent, as the Richtlinie states them. */
export function formatProzent(n: number): string {
  return `${zahl(n)} %`;
}

/** `16` → `16 %-Punkte` — a bonus adds *points* to a rate, it is not a rate. */
export function formatPunkte(n: number): string {
  return `${zahl(n)} %-Punkte`;
}

/**
 * Every date in `(nach, bis]` on which one of the registered series changes,
 * with the old and new values spelled out.
 *
 * Half-open at the start on purpose: a step that takes effect *on* `nach` is
 * already priced into the answer for that day and is not something still ahead.
 *
 * @param eintraege The dated values to scan.
 * @param nach Exclusive lower bound — usually the application date being planned.
 * @param bis Inclusive upper bound.
 */
export function stichtageAus(eintraege: readonly ZeitreiheEintrag[], nach: string, bis: string): Stichtag[] {
  parseIso(nach);
  parseIso(bis);
  const nachDatum = new Map<string, Aenderung[]>();

  for (const e of eintraege) {
    e.reihe.forEach((spanne, i) => {
      // The first span is where the modelled range begins, not a change.
      if (i === 0) return;
      if (spanne.gueltigAb <= nach || spanne.gueltigAb > bis) return;
      const vorher = e.reihe[i - 1].wert;
      const liste = nachDatum.get(spanne.gueltigAb) ?? [];
      liste.push({
        reihe: e.id,
        name: e.name,
        text: `${e.name}: ${e.format(vorher)} → ${e.format(spanne.wert)}`,
        quelle: spanne.quelle,
        vorher,
        nachher: spanne.wert,
      });
      nachDatum.set(spanne.gueltigAb, liste);
    });
  }

  return [...nachDatum.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([datum, aenderungen]) => ({ datum, aenderungen }));
}

/**
 * Warn when `datum` lies more than {@link REGELSTAND_WARNUNG_TAGE} days past the
 * day these rules were last checked against their source — `null` when it does
 * not.
 *
 * The reference is `eingepflegtAm`, not the Richtlinie's own date: what ages is
 * not the law, it is the transcription. A Richtlinie from July that somebody
 * verified in August is trustworthy for longer than one verified the day it
 * appeared.
 *
 * Pure, so the kernel stays clock-free — the adapter passes the date it is
 * computing for and prints the result.
 */
export function regelstandWarnung(datum: string): string | null {
  const tage = tageZwischen(BEG_REGELSTAND.eingepflegtAm, datum);
  if (tage <= REGELSTAND_WARNUNG_TAGE) return null;
  return (
    `Regelstand: Die Förderregeln stammen aus der BEG-EM-Richtlinie vom ` +
    `${formatDatum(BEG_REGELSTAND.richtlinie)}, eingepflegt am ` +
    `${formatDatum(BEG_REGELSTAND.eingepflegtAm)} — das gerechnete Datum ` +
    `${formatDatum(datum)} liegt ${zahl(tage)} Tage danach. Sätze, Boni und ` +
    `Höchstbeträge vor der Antragstellung gegen die aktuelle Fassung prüfen.`
  );
}
