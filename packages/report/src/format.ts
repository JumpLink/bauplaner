/**
 * German number presentation, shared by every surface that shows a figure —
 * the CLI tables, the Adwaita views and the exported PDF.
 *
 * It lives in the kernel rather than in an adapter because a U-value printed as
 * `0.191` next to a euro amount reads as a different number to the person the
 * document is written for, and that must not depend on which surface rendered
 * it.
 */

/**
 * Format a number German-style: comma as the decimal mark, dot as the thousands
 * separator.
 *
 * @param n The value.
 * @param digits Decimal places (default 2).
 */
export function fmtNum(n: number, digits = 2): string {
  const [int, frac] = Math.abs(n).toFixed(digits).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '-' : ''}${grouped}${frac ? `,${frac}` : ''}`;
}

/** Format a euro amount with German separators (`1.234,56 €`). */
export function fmtEur(n: number): string {
  return `${fmtNum(n, 2)} €`;
}

/** Format a euro amount to whole euros — for headline figures where cents are noise. */
export function fmtEur0(n: number): string {
  return `${fmtNum(n, 0)} €`;
}

/**
 * Format a 0..1 share as whole percent.
 *
 * @param fraction The share, 0..1.
 */
export function fmtProzent(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

/** Format a number of years, or an em dash when there is none. */
export function fmtJahre(jahre: number | null): string {
  return jahre != null ? `${fmtNum(jahre, 1)} Jahre` : '—';
}
