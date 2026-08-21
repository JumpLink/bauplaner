/**
 * Reading a number the way a German keyboard types it.
 *
 * The Kosten dialog parsed an amount as `text.replace(',', '.')` and then stripped everything that
 * was not a digit, a dot or a minus. On `12.500,00` — a perfectly ordinary way to write a quote for
 * twelve and a half thousand euro — that produces `12.500.00`, and `parseFloat` stops at the second
 * dot: the €12 500 quote was silently stored as **€12.50**, three orders of magnitude out, with no
 * error and no clue in the UI. The Dokumentation view had the same bug for meter readings.
 *
 * `parseFloat` also stops at the first thing it does not understand, so `12abc` came out as 12 and
 * `1,2,3` as 1.2 — garbage accepted as data. Here anything that is not entirely a number is
 * rejected, which is what lets the caller mark the field red instead of storing a wrong value.
 */

/**
 * Parse a decimal number written in German (or plain English) notation.
 *
 * Returns `null` for anything that is not a complete number — empty, letters, two decimal
 * separators, a stray sign. Never returns NaN or a partial parse.
 *
 * Which separator is the decimal one:
 *   - Both `.` and `,` present → the RIGHTMOST is the decimal separator (`1.234,56` and `1,234.56`
 *     both read as 1234.56). Notation stays whatever the writer used.
 *   - Only `,` → decimal separator (`1234,5` → 1234.5).
 *   - Only `.` → decimal separator, UNLESS it groups thousands (`12.500` → 12500, `1.234.567` →
 *     1234567). The grouping pattern is exactly three digits per group, which is what makes it
 *     distinguishable; `1.50` therefore stays 1.5.
 * Spaces (including the narrow no-break space of a copied amount) and `€` are ignored.
 */
export function parseGermanNumber(input: string): number | null {
    //   no-break,   narrow no-break — both come along when an amount is copied from a
    // spreadsheet or a PDF, and both look exactly like a normal space.
    let s = input.replace(/[\s  €]/g, '');
    if (s === '') return null;

    let sign = 1;
    if (s.startsWith('-')) {
        sign = -1;
        s = s.slice(1);
    } else if (s.startsWith('+')) {
        s = s.slice(1);
    }
    if (s === '') return null;

    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    let decimalAt = -1;
    if (lastDot >= 0 && lastComma >= 0) {
        decimalAt = Math.max(lastDot, lastComma);
    } else if (lastComma >= 0) {
        decimalAt = lastComma;
    } else if (lastDot >= 0) {
        // A single dot: thousands grouping only when the whole string IS grouped notation.
        decimalAt = /^\d{1,3}(\.\d{3})+$/.test(s) ? -1 : lastDot;
    }

    const whole = decimalAt >= 0 ? s.slice(0, decimalAt) : s;
    const fraction = decimalAt >= 0 ? s.slice(decimalAt + 1) : '';

    // Every remaining separator in the whole part must be a group separator, and the fraction must
    // be plain digits. This is the check that rejects `1,2,3` and `12abc` instead of half-reading them.
    const groupless = whole.replace(/[.,]/g, '');
    if (!/^\d*$/.test(groupless) || !/^\d*$/.test(fraction)) return null;
    if (groupless === '' && fraction === '') return null;
    if (/[.,]/.test(whole) && !/^\d{1,3}([.,]\d{3})+$/.test(whole)) return null;

    const value = Number(`${groupless || '0'}.${fraction || '0'}`);
    return Number.isFinite(value) ? sign * value : null;
}
