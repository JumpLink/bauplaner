/** CLI formatting helpers. */

/** Format a euro amount with German separators (1.234,56 €). */
export function fmtEur(n: number): string {
  const [int, frac] = Math.abs(n).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '-' : ''}${grouped},${frac} €`;
}
