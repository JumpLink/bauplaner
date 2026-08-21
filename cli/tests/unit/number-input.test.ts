import { describe, it, expect } from '@gjsify/unit';

import { parseGermanNumber } from '@bauplaner/core';

export default async () => {
  await describe('parseGermanNumber', async () => {
    await it('reads a German amount with thousands dot and decimal comma', async () => {
      // The bug this exists for: `12.500,00` used to come out as 12.5 — a €12 500 quote stored as
      // €12.50, silently, with no error anywhere.
      expect(parseGermanNumber('12.500,00')).toBe(12500);
      expect(parseGermanNumber('1.234.567,89')).toBe(1234567.89);
      expect(parseGermanNumber('1234,56')).toBe(1234.56);
    });

    await it('treats a lone dot as grouping only when the whole number is grouped', async () => {
      expect(parseGermanNumber('12.500')).toBe(12500);
      expect(parseGermanNumber('1.234.567')).toBe(1234567);
      // Not grouping — two digits after the dot cannot be a thousands group.
      expect(parseGermanNumber('1.50')).toBe(1.5);
      expect(parseGermanNumber('0.5')).toBe(0.5);
    });

    await it('takes the rightmost separator as the decimal one, so English notation works too', async () => {
      expect(parseGermanNumber('1,234.56')).toBe(1234.56);
      expect(parseGermanNumber('1.234,56')).toBe(1234.56);
    });

    await it('keeps the sign and ignores currency and copied whitespace', async () => {
      expect(parseGermanNumber('-1.500,50')).toBe(-1500.5);
      expect(parseGermanNumber('+42')).toBe(42);
      expect(parseGermanNumber(' 1 234,5 ')).toBe(1234.5);
      expect(parseGermanNumber('12.500,00 €')).toBe(12500);
      // Narrow no-break space, as a spreadsheet copies it.
      expect(parseGermanNumber('1 234,5')).toBe(1234.5);
    });

    await it('refuses anything that is not a whole number, instead of half-reading it', async () => {
      // parseFloat stopped at the first thing it did not understand and returned a number anyway.
      expect(parseGermanNumber('12abc')).toBe(null);
      expect(parseGermanNumber('1,2,3')).toBe(null);
      expect(parseGermanNumber('')).toBe(null);
      expect(parseGermanNumber('   ')).toBe(null);
      expect(parseGermanNumber('-')).toBe(null);
      expect(parseGermanNumber('abc')).toBe(null);
      expect(parseGermanNumber('1.23.456')).toBe(null);
    });

    await it('reads plain integers and zero', async () => {
      expect(parseGermanNumber('0')).toBe(0);
      expect(parseGermanNumber('0,00')).toBe(0);
      expect(parseGermanNumber('7')).toBe(7);
    });
  });
};
