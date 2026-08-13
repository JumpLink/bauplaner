/** CLI formatting helpers. */

// German number formatting lives in the kernel (`@bauplaner/report`), so the
// CLI tables, the Adwaita views and the exported PDF all round and separate the
// same way. Re-exported here because every adapter file already imports it from
// this module.
export { fmtEur, fmtEur0, fmtJahre, fmtNum, fmtProzent } from '@bauplaner/report';

/**
 * Escape text for a Pango-markup context. Adwaita row titles/subtitles are
 * markup, so dynamic text (a cost label like "Drainage & Erdarbeiten") must be
 * escaped or a bare "&"/"<" aborts parsing and renders a blank label.
 */
export function escapeMarkup(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Today, ISO. **The only clock in the CLI.** The kernel takes every date as an
 * argument so its results are reproducible; the adapter is where "now" is
 * allowed to enter, and it enters exactly here — once, for every command that
 * needs a default application date.
 */
export function heute(): string {
  const d = new Date();
  const zwei = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${zwei(d.getMonth() + 1)}-${zwei(d.getDate())}`;
}

/**
 * A non-negative number, or an error that names the option the user typed.
 *
 * yargs turns `--kosten abc` into `NaN` without complaint. The kernel rejects it
 * too, but by the name of its own field — and someone who wrote `--kosten` should
 * not have to map that back from `fachunternehmenEur`.
 */
export function zahl(wert: number, option: string): number {
  if (!Number.isFinite(wert)) throw new Error(`${option} muss eine Zahl sein.`);
  if (wert < 0) throw new Error(`${option} darf nicht negativ sein (war: ${wert}).`);
  return wert;
}

/** Break a long note into terminal-width lines, continuation lines indented. */
export function absatz(text: string, praefix: string, einzug: string, breite = 70): void {
  const worte = text.split(/\s+/);
  const zeilen: string[] = [];
  let aktuell = '';
  for (const wort of worte) {
    if (aktuell === '') aktuell = wort;
    else if (`${aktuell} ${wort}`.length + einzug.length <= breite) aktuell += ` ${wort}`;
    else {
      zeilen.push(aktuell);
      aktuell = wort;
    }
  }
  if (aktuell !== '') zeilen.push(aktuell);
  zeilen.forEach((z, i) => console.log(`${i === 0 ? praefix : einzug}${z}`));
}
