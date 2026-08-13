import { describe, it, expect } from '@gjsify/unit';

import {
  BEG_REGELSTAND,
  BEG_ZEITREIHEN,
  computeHeizungsfoerderung,
  computeKostenDesWartens,
  einkommensBonusPunkte,
  formatDatum,
  HEIZUNG_ZEITREIHEN,
  heizungsHoechstbetragAm,
  istIsoDatum,
  klimageschwindigkeitsBonusPunkteAm,
  massgeblichesEinkommen,
  plusJahre,
  pruefeKlimageschwindigkeitsBonus,
  pruefeZeitreihe,
  regelstandWarnung,
  stichtageAus,
  tageZwischen,
  waermepumpeGrundfoerderungPunkteAm,
  wertAm,
  type BonusPosten,
  type HeizungsfoerderungInput,
  type HeizungsfoerderungResult,
} from '@bauplaner/materials';

/** Synthetic base case: a heat pump, invoiced by a Fachunternehmen, nothing else. */
function vorhaben(over: Partial<HeizungsfoerderungInput> = {}): HeizungsfoerderungInput {
  return { antragsdatum: '2026-08-13', fachunternehmenEur: 20_000, ...over };
}

/** Points of one bonus; -1 when the result does not carry it at all. */
function bonus(r: HeizungsfoerderungResult, id: BonusPosten['id']): number {
  return r.boni.find((b) => b.id === id)?.punkte ?? -1;
}

export default async () => {
  await describe('zeitachse', async () => {
    await it('selects the span that covers a date and nothing outside it', async () => {
      // 28.000 € holds through 31.01.2027 and drops the next day.
      expect(heizungsHoechstbetragAm('2026-07-21')).toBe(28_000);
      expect(heizungsHoechstbetragAm('2027-01-31')).toBe(28_000);
      expect(heizungsHoechstbetragAm('2027-02-01')).toBe(27_250);
      // Before the Richtlinie came into force nothing is modelled — and the
      // series says so instead of answering with the nearest value.
      expect(wertAm(BEG_ZEITREIHEN[0].reihe, '2026-07-20')).toBe(undefined);
    });

    await it('steps the Höchstbetrag down every six months to the 22.000 € floor', async () => {
      const erwartet: [string, number][] = [
        ['2027-02-01', 27_250],
        ['2027-08-01', 26_500],
        ['2028-02-01', 25_750],
        ['2028-08-01', 25_000],
        ['2029-02-01', 24_250],
        ['2029-08-01', 23_500],
        ['2030-02-01', 22_750],
        ['2030-08-01', 22_000],
      ];
      for (const [datum, wert] of erwartet) expect(heizungsHoechstbetragAm(datum)).toBe(wert);
      // The last span is open-ended: the floor holds, it does not run out.
      expect(heizungsHoechstbetragAm('2030-12-31')).toBe(22_000);
      expect(heizungsHoechstbetragAm('2031-06-01')).toBe(22_000);
    });

    await it('keeps every registered series sorted, gapless and sourced', async () => {
      // The structural guard the deadline list depends on: one bad `gueltigAb`
      // would shadow a later span and silently pay the wrong rate.
      for (const eintrag of BEG_ZEITREIHEN) {
        expect(`${eintrag.id}: ${pruefeZeitreihe(eintrag.reihe).join('; ')}`).toBe(`${eintrag.id}: `);
      }
    });

    await it('lists a step that lies ahead, not one already in force', async () => {
      // 01.01.2027 is when the heat-pump rate halves and both new boni start.
      const ab2026 = stichtageAus(BEG_ZEITREIHEN, '2026-12-01', '2027-01-31');
      expect(ab2026.length).toBe(1);
      expect(ab2026[0].datum).toBe('2027-01-01');
      expect(ab2026[0].aenderungen.length).toBe(3);
      // Same date as the lower bound: already priced in, so not a deadline.
      expect(stichtageAus(BEG_ZEITREIHEN, '2027-01-01', '2027-01-31').length).toBe(0);
    });

    await it('does civil-date arithmetic without a clock', async () => {
      expect(tageZwischen('2026-08-13', '2026-11-11')).toBe(90);
      expect(tageZwischen('2026-11-11', '2026-08-13')).toBe(-90);
      expect(plusJahre('2007-06-01', 20)).toBe('2027-06-01');
      // 29.02 has no counterpart in a non-leap year; the day clamps.
      expect(plusJahre('2004-02-29', 21)).toBe('2025-02-28');
      expect(formatDatum('2026-07-21')).toBe('21.07.2026');
      expect(istIsoDatum('2026-02-30')).toBe(false);
      expect(istIsoDatum('2026-13-01')).toBe(false);
      expect(istIsoDatum('2028-02-29')).toBe(true);
    });

    await it('warns once a date outruns the day the rules were transcribed', async () => {
      expect(regelstandWarnung(BEG_REGELSTAND.eingepflegtAm)).toBe(null);
      expect(regelstandWarnung('2026-11-11')).toBe(null); // exactly 90 days
      const spaet = regelstandWarnung('2026-11-12');
      expect(spaet != null).toBe(true);
      expect((spaet ?? '').includes('91 Tage')).toBe(true);
    });
  });

  await describe('heizungsfoerderung — Grundförderung', async () => {
    await it('pays 30 % for a heat pump on 31.12.2026 and 15 % on 01.01.2027', async () => {
      expect(waermepumpeGrundfoerderungPunkteAm('2026-12-31')).toBe(30);
      expect(waermepumpeGrundfoerderungPunkteAm('2027-01-01')).toBe(15);
      const vor = computeHeizungsfoerderung(vorhaben({ antragsdatum: '2026-12-31' }));
      expect(vor.grundfoerderungPunkte).toBe(30);
      expect(vor.foerderungEur).toBe(6000); // 20.000 × 30 %
      const nach = computeHeizungsfoerderung(vorhaben({ antragsdatum: '2027-01-01' }));
      expect(nach.grundfoerderungPunkte).toBe(15);
      expect(nach.foerderungEur).toBe(3000);
    });

    await it('cuts only Nr. 5.3 c in 2027 — the other letters stay at 30 %', async () => {
      const andere = computeHeizungsfoerderung(vorhaben({ antragsdatum: '2027-01-01', massnahme: '5.3a' }));
      expect(andere.grundfoerderungPunkte).toBe(30);
      expect(andere.foerderungEur).toBe(6000);
    });

    await it('caps the basis at the Höchstbetrag and reports what fell off', async () => {
      const r = computeHeizungsfoerderung(vorhaben({ fachunternehmenEur: 40_000 }));
      expect(r.bemessungsgrundlageEur).toBe(28_000);
      expect(r.ueberHoechstbetragEur).toBe(12_000);
      expect(r.foerderungEur).toBe(8400); // 28.000 × 30 %
      expect(r.eigenanteilEur).toBe(31_600); // the full 40.000 was still paid
    });
  });

  await describe('heizungsfoerderung — Einkommens-Bonus', async () => {
    await it('reads „bis" as inclusive and „über" as exclusive at every step', async () => {
      expect(einkommensBonusPunkte(30_000)).toBe(40);
      expect(einkommensBonusPunkte(30_000.01)).toBe(30);
      expect(einkommensBonusPunkte(40_000)).toBe(30);
      expect(einkommensBonusPunkte(40_000.01)).toBe(10);
      expect(einkommensBonusPunkte(50_000)).toBe(10);
      expect(einkommensBonusPunkte(50_000.01)).toBe(0);
    });

    await it('lets the Familienzuschlag tip a household into the next tier', async () => {
      // 39.000 € is a 30-point household; minus the flat 10.000 € it is a
      // 40-point one — and that also moves the ceiling from 70 % to 80 %.
      expect(massgeblichesEinkommen(39_000, 0)).toBe(39_000);
      expect(massgeblichesEinkommen(39_000, 1)).toBe(29_000);
      const ohneKind = computeHeizungsfoerderung(
        vorhaben({ haushaltsEinkommenEur: 39_000, altanlage: { typ: 'oel', funktionstuechtig: true } }),
      );
      expect(bonus(ohneKind, 'einkommen')).toBe(30);
      expect(ohneKind.deckelPunkte).toBe(70);
      expect(ohneKind.foerderungEur).toBe(14_000); // 30+16+30 = 76 → gedeckelt auf 70

      const mitKind = computeHeizungsfoerderung(
        vorhaben({ haushaltsEinkommenEur: 39_000, kinderUnter18: 1, altanlage: { typ: 'oel', funktionstuechtig: true } }),
      );
      expect(bonus(mitKind, 'einkommen')).toBe(40);
      expect(mitKind.deckelPunkte).toBe(80);
      expect(mitKind.foerderungEur).toBe(16_000); // 30+16+40 = 86 → gedeckelt auf 80
    });

    await it('grants the Familienzuschlag once, however many children there are', async () => {
      const eins = computeHeizungsfoerderung(vorhaben({ haushaltsEinkommenEur: 39_000, kinderUnter18: 1 }));
      const zwei = computeHeizungsfoerderung(vorhaben({ haushaltsEinkommenEur: 39_000, kinderUnter18: 2 }));
      expect(massgeblichesEinkommen(39_000, 4)).toBe(29_000);
      expect(zwei.massgeblichesEinkommenEur).toBe(eins.massgeblichesEinkommenEur);
      expect(zwei.foerderungEur).toBe(eins.foerderungEur);
    });

    await it('withholds the bonus without self-occupation, whatever the income', async () => {
      const vermietet = computeHeizungsfoerderung(vorhaben({ haushaltsEinkommenEur: 20_000, selbstnutzend: false }));
      expect(bonus(vermietet, 'einkommen')).toBe(0);
      expect(vermietet.deckelPunkte).toBe(70);
    });
  });

  await describe('heizungsfoerderung — Deckel', async () => {
    await it('caps the stack at 80 % for a low income', async () => {
      const r = computeHeizungsfoerderung(
        vorhaben({ haushaltsEinkommenEur: 25_000, altanlage: { typ: 'oel', funktionstuechtig: true } }),
      );
      expect(r.satzVorDeckelPunkte).toBe(86); // 30 Grund + 16 Klima + 40 Einkommen
      expect(r.deckelPunkte).toBe(80);
      expect(r.deckelWirksam).toBe(true);
      expect(r.satz).toBe(0.8);
      expect(r.foerderungEur).toBe(16_000);
    });

    await it('caps at 70 % once the income is above 30.000 €', async () => {
      // 2027: Grundförderung 15 + Wertschöpfung 15 + Klima 12 + Einkommen 30 = 72.
      const r = computeHeizungsfoerderung(
        vorhaben({
          antragsdatum: '2027-03-01',
          haushaltsEinkommenEur: 35_000,
          wertschoepfungsBonus: true,
          altanlage: { typ: 'oel', funktionstuechtig: true },
        }),
      );
      expect(r.satzVorDeckelPunkte).toBe(72);
      expect(r.deckelPunkte).toBe(70);
      expect(r.deckelWirksam).toBe(true);
      expect(r.foerderungEur).toBe(14_000);
    });
  });

  await describe('heizungsfoerderung — Klimageschwindigkeits-Bonus', async () => {
    await it('denies it to a gas heating that has not run 20 years yet', async () => {
      const r = computeHeizungsfoerderung(
        vorhaben({ altanlage: { typ: 'gas', funktionstuechtig: true, inbetriebnahme: '2012' } }),
      );
      expect(bonus(r, 'klimageschwindigkeit')).toBe(0);
      expect(r.foerderungEur).toBe(6000); // Grundförderung allein
      const pruefung = pruefeKlimageschwindigkeitsBonus(
        { typ: 'gas', funktionstuechtig: true, inbetriebnahme: '2012' },
        '2026-08-13',
      );
      expect(pruefung.erfuellt).toBe(false);
      expect((pruefung.grund ?? '').includes('20 Jahre')).toBe(true);
    });

    await it('grants it to an oil heating at any age', async () => {
      const r = computeHeizungsfoerderung(vorhaben({ altanlage: { typ: 'oel', funktionstuechtig: true } }));
      expect(bonus(r, 'klimageschwindigkeit')).toBe(16);
      expect(r.foerderungEur).toBe(9200); // 20.000 × 46 %
    });

    await it('denies it for a broken old plant — the bonus pays for replacing early', async () => {
      const r = computeHeizungsfoerderung(vorhaben({ altanlage: { typ: 'oel', funktionstuechtig: false } }));
      expect(bonus(r, 'klimageschwindigkeit')).toBe(0);
      expect(r.foerderungEur).toBe(6000);
    });

    await it('denies it without professional removal and disposal', async () => {
      const r = computeHeizungsfoerderung(
        vorhaben({ altanlage: { typ: 'oel', funktionstuechtig: true, demontageUndEntsorgung: false } }),
      );
      expect(bonus(r, 'klimageschwindigkeit')).toBe(0);
    });

    await it('melts the bonus away in four steps and drops it after 01.08.2028', async () => {
      expect(klimageschwindigkeitsBonusPunkteAm('2026-08-13')).toBe(16);
      expect(klimageschwindigkeitsBonusPunkteAm('2027-02-01')).toBe(12);
      expect(klimageschwindigkeitsBonusPunkteAm('2027-08-01')).toBe(8);
      expect(klimageschwindigkeitsBonusPunkteAm('2028-02-01')).toBe(4);
      expect(klimageschwindigkeitsBonusPunkteAm('2028-08-01')).toBe(0);
      // Conditions met, date too late: the bonus is 0, not withheld on merit.
      const spaet = computeHeizungsfoerderung(
        vorhaben({ antragsdatum: '2028-08-01', altanlage: { typ: 'oel', funktionstuechtig: true } }),
      );
      expect(bonus(spaet, 'klimageschwindigkeit')).toBe(0);
      expect(pruefeKlimageschwindigkeitsBonus({ typ: 'oel', funktionstuechtig: true }, '2028-08-01').erfuellt).toBe(true);
    });
  });

  await describe('heizungsfoerderung — Ausschlüsse und Eigenleistung', async () => {
    await it('funds an Eigenbau/Prototyp with nothing at all, and says why', async () => {
      const r = computeHeizungsfoerderung(
        vorhaben({ fachunternehmenEur: 30_000, eigenbau: true, haushaltsEinkommenEur: 20_000 }),
      );
      expect(r.foerderfaehig).toBe(false);
      expect(r.foerderungEur).toBe(0);
      expect(r.satz).toBe(0);
      expect(r.eigenanteilEur).toBe(30_000);
      expect(r.hinweise.some((h) => h.includes('Eigenbauanlage'))).toBe(true);
    });

    await it('excludes a used plant just as completely', async () => {
      const r = computeHeizungsfoerderung(vorhaben({ gebraucht: true }));
      expect(r.foerderfaehig).toBe(false);
      expect(r.foerderungEur).toBe(0);
      expect(r.hinweise.some((h) => h.includes('gebrauchte Anlage'))).toBe(true);
    });

    await it('counts only material in Eigenleistung, and both parts in Teilvergabe', async () => {
      const eigen = computeHeizungsfoerderung(
        vorhaben({ ausfuehrung: 'eigenleistung', fachunternehmenEur: 0, materialEigenleistungEur: 8000 }),
      );
      expect(eigen.bemessungsgrundlageEur).toBe(8000);
      expect(eigen.foerderungEur).toBe(2400);
      expect(eigen.hinweise.some((h) => h.includes('Nr. 8.2'))).toBe(true);

      const teil = computeHeizungsfoerderung(
        vorhaben({ ausfuehrung: 'teilvergabe', fachunternehmenEur: 15_000, materialEigenleistungEur: 5000 }),
      );
      expect(teil.bemessungsgrundlageEur).toBe(20_000);
      expect(teil.foerderungEur).toBe(6000);

      // Declared as fully contracted out: own material is not part of the basis.
      const fach = computeHeizungsfoerderung(vorhaben({ fachunternehmenEur: 15_000, materialEigenleistungEur: 5000 }));
      expect(fach.bemessungsgrundlageEur).toBe(15_000);
      expect(fach.foerderungEur).toBe(4500);
    });
  });

  await describe('heizungsfoerderung — Wertschöpfungs-Bonus', async () => {
    await it('stays off unless it is asked for, and never before Q1 2027', async () => {
      const nichtGefragt = computeHeizungsfoerderung(vorhaben({ antragsdatum: '2027-03-01' }));
      expect(bonus(nichtGefragt, 'wertschoepfung')).toBe(0);
      const zuFrueh = computeHeizungsfoerderung(vorhaben({ wertschoepfungsBonus: true }));
      expect(bonus(zuFrueh, 'wertschoepfung')).toBe(0);
    });

    await it('hands the heat pump back what 2027 took, and flags the open conditions', async () => {
      const r = computeHeizungsfoerderung(vorhaben({ antragsdatum: '2027-03-01', wertschoepfungsBonus: true }));
      expect(r.grundfoerderungPunkte).toBe(15);
      expect(bonus(r, 'wertschoepfung')).toBe(15);
      expect(r.satzVorDeckelPunkte).toBe(30); // back where 2026 was
      expect(r.hinweise.some((h) => h.includes('nicht veröffentlicht'))).toBe(true);
    });

    await it('never reaches a measure other than Nr. 5.3 c', async () => {
      const r = computeHeizungsfoerderung(
        vorhaben({ antragsdatum: '2027-03-01', massnahme: '5.3f', wertschoepfungsBonus: true }),
      );
      expect(bonus(r, 'wertschoepfung')).toBe(0);
    });
  });

  await describe('kosten des wartens', async () => {
    await it('prices a step that falls between two application dates', async () => {
      // 01.01.2027 halves the heat-pump rate; the Höchstbetrag holds until 31.01.
      const w = computeKostenDesWartens(vorhaben({ antragsdatum: '2026-12-01' }), '2027-01-31');
      expect(w.foerderungVonEur).toBe(6000);
      expect(w.foerderungBisEur).toBe(3000);
      expect(w.kostenDesWartensEur).toBe(3000);
      expect(w.stichtage.length).toBe(1);
      expect(w.stichtage[0].datum).toBe('2027-01-01');
      expect(w.stichtage[0].foerderungEur).toBe(3000);
      expect(w.stichtage[0].kostenDesWartensEur).toBe(3000);
      expect(w.stichtage[0].aenderungen.some((a) => a.text.includes('30 % → 15 %'))).toBe(true);
    });

    await it('lists every step in the window, oldest first', async () => {
      const w = computeKostenDesWartens(vorhaben({ antragsdatum: '2026-12-01' }), '2027-03-01');
      expect(w.stichtage.map((s) => s.datum).join(',')).toBe('2027-01-01,2027-02-01');
      // 01.02.2027 moves both the ceiling and the Klimageschwindigkeits-Bonus.
      expect(w.stichtage[1].aenderungen.length).toBe(2);
    });

    await it('leaves out an envelope rule the heating figure cannot follow', async () => {
      // The WPB bonus (Nr. 5.1 a) changes on 01.01.2027 and is in the full
      // registry, but it moves no euro in this table — so it must not appear
      // next to one.
      const w = computeKostenDesWartens(vorhaben({ antragsdatum: '2026-12-01' }), '2027-01-31');
      expect(w.stichtage[0].aenderungen.some((a) => a.reihe === 'wpb-bonus')).toBe(false);
      expect(BEG_ZEITREIHEN.some((e) => e.id === 'wpb-bonus')).toBe(true); // still registered
      expect(HEIZUNG_ZEITREIHEN.some((e) => e.id === 'wpb-bonus')).toBe(false);
    });

    await it('reports the date each amount was really computed for', async () => {
      // 2020 is before the Richtlinie; the subsidy is the one for 21.07.2026,
      // so that is the date the row must carry.
      const w = computeKostenDesWartens(vorhaben({ antragsdatum: '2020-01-01' }), '2027-06-01');
      expect(w.vonDatum).toBe('2026-07-21');
      expect(w.foerderungVonEur).toBe(6000); // 30 % — the 2026 rate, as labelled
    });

    await it('shows waiting paying off when the old plant comes of age', async () => {
      // A gas heating from 2007 turns 20 on 31.12.2027 (an unknown month reads
      // as the year's last day), which unlocks 8 further points.
      const input = vorhaben({
        antragsdatum: '2027-09-01',
        altanlage: { typ: 'gas', funktionstuechtig: true, inbetriebnahme: '2007' },
      });
      const w = computeKostenDesWartens(input, '2028-01-15');
      expect(w.foerderungVonEur).toBe(3000); // 15 % — the plant is 19
      expect(w.foerderungBisEur).toBe(4600); // 15 + 8 = 23 %
      expect(w.kostenDesWartensEur).toBe(-1600); // negative: waiting earns
      expect(w.stichtage.length).toBe(1);
      expect(w.stichtage[0].datum).toBe('2027-12-31');
      expect(w.stichtage[0].aenderungen[0].reihe).toBe('altanlage-mindestalter');
    });

    await it('stays quiet about a plant that comes of age after the bonus died', async () => {
      // Commissioned 2009 → 20 years on 31.12.2029, by which time the
      // Klimageschwindigkeits-Bonus has been gone since 01.08.2028. Announcing
      // it as reachable would put "ab hier erreichbar" on a row that costs money.
      const w = computeKostenDesWartens(
        vorhaben({
          antragsdatum: '2029-06-01',
          altanlage: { typ: 'gas', funktionstuechtig: true, inbetriebnahme: '2009' },
        }),
        '2030-06-01',
      );
      expect(w.stichtage.some((s) => s.aenderungen.some((a) => a.reihe === 'altanlage-mindestalter'))).toBe(false);
    });
  });

  await describe('eingabepruefung', async () => {
    /** Runs `fn` and returns its error message, or '' when it did not throw. */
    function fehler(fn: () => unknown): string {
      try {
        fn();
        return '';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    }

    await it('refuses a cost that is not a number instead of reporting NaN €', async () => {
      expect(fehler(() => computeHeizungsfoerderung(vorhaben({ fachunternehmenEur: Number.NaN }))).length > 0).toBe(true);
      expect(fehler(() => computeHeizungsfoerderung(vorhaben({ fachunternehmenEur: -5000 }))).includes('negativ')).toBe(true);
    });

    await it('refuses a negative income rather than paying the top bonus for it', async () => {
      // Clamping -35.000 € to 0 would answer a typo with 40 bonus points and
      // the 80 % ceiling — the most generous result the Richtlinie has.
      expect(fehler(() => computeHeizungsfoerderung(vorhaben({ haushaltsEinkommenEur: -35_000 }))).includes('negativ')).toBe(true);
    });

    await it('refuses a malformed application date before comparing it', async () => {
      // 'abc' > '2030-12-31' as strings, so an unchecked date would silently
      // take the after-expiry branch.
      expect(fehler(() => computeHeizungsfoerderung(vorhaben({ antragsdatum: 'abc' }))).includes('antragsdatum')).toBe(true);
    });

    await it('refuses to leave four-digit years, which string order depends on', async () => {
      // '10019-12-31' < '2026-08-13' as strings — a plant from the year 9999
      // would otherwise pass the 20-year test.
      expect(fehler(() => plusJahre('9999-12-31', 20)).includes('9999')).toBe(true);
      expect(plusJahre('1979-12-31', 20)).toBe('1999-12-31');
    });

    await it('reports a broken series instead of dying on it', async () => {
      // pruefeZeitreihe exists to catch malformed dates; it must not throw on one.
      const kaputt = [
        { gueltigAb: '2026-01-01', gueltigBis: '2026-13-31', wert: 1, quelle: 'x', abgerufenAm: '2026-08-13' },
        { gueltigAb: '2027-01-01', wert: 2, quelle: 'x', abgerufenAm: '2026-08-13' },
      ];
      const probleme = pruefeZeitreihe(kaputt);
      expect(probleme.some((p) => p.includes('gueltigBis'))).toBe(true);
    });
  });
};
