// When "mg" was read as "mcg", the row is wrong by a factor of a thousand.
//
// At 6-point, in the condensed face a Supplement Facts panel is set in, "mg"
// and "mcg" differ by one narrow letter. The recogniser confuses them, and
// nothing downstream notices: the row looks complete, parses cleanly, and
// reports an amount a thousand times too large or too small. For vitamin A,
// folate, biotin and B12 — the nutrients dosed in micrograms next to ones
// dosed in milligrams — that is the difference between a sensible dose and
// an alarming one.
//
// THE LABEL ALREADY CONTAINS THE ANSWER. A panel prints both the amount and
// the percentage of the Daily Value, and those two numbers must agree:
//
//     amount / DailyValue * 100 = %DV
//
// So a wrong unit is not a judgement call. It is an arithmetic failure with
// a known cause, and trying the handful of units the recogniser could have
// confused is enough to find which one the label actually printed.
//
// WHAT MAKES THIS SAFE, and these conditions are the whole design:
//
//   - A row that already verifies is never touched. If the arithmetic works,
//     the unit was right, and there is nothing to fix.
//   - A correction is only adopted when EXACTLY ONE alternative verifies.
//     Two candidates means the evidence does not single one out, and a
//     coin-flip dressed up as a repair is worse than an honest mismatch.
//   - A row that cannot be checked at all — no established Daily Value, no
//     printed percentage — is never touched, because there is nothing to
//     check a guess against.
//   - Every correction is recorded with its before and after, and shown.

import { checkRow } from './dailyValues';
import type { PanelRow } from './labelPanelParse';

/**
 * Units a recogniser plausibly confuses, grouped by what they look like.
 *
 * Deliberately not "every unit in the table". `g` and `IU` are not in the
 * mcg/mg group because nothing on a label makes them look alike, and adding
 * them would only create ambiguous cases that get rejected anyway.
 */
const CONFUSABLE_UNITS: readonly (readonly string[])[] = [
  ['mcg', 'mg'],      // one narrow letter apart at 6 point
  ['mg', 'g'],        // a lost leading letter
  ['mcg', 'ug'],      // the same unit written two ways, not a confusion
  ['ug', 'µg'],
];

/** Every unit worth trying instead of this one. */
export function alternativesFor(unit: string): string[] {
  const u = unit.toLowerCase();
  const out = new Set<string>();
  for (const group of CONFUSABLE_UNITS) {
    if (!group.includes(u)) continue;
    for (const other of group) if (other !== u) out.add(other);
  }
  return [...out];
}

export interface UnitCorrection {
  ingredient: string;
  from: string;
  to: string;
  /** What the row claimed before, and what it claims now. */
  was: string;
  now: string;
  why: string;
}

export interface UnitRepairResult {
  rows: PanelRow[];
  corrections: UnitCorrection[];
}

/**
 * Try the confusable units on any row whose arithmetic fails.
 *
 * Returns the rows unchanged plus an empty list when nothing needed fixing,
 * which is the common case on a clean label.
 */
export function repairUnits(rows: readonly PanelRow[]): UnitRepairResult {
  const corrections: UnitCorrection[] = [];

  const out = rows.map((row) => {
    if (row.unit === null || row.amount === null || row.dvPct === null) return row;

    const asRead = checkRow(row.name, row.amount, row.unit, row.dvPct);
    // Only a row that is checkable AND failing is a candidate. A verified
    // row is evidence the unit was right; an uncheckable one gives nothing
    // to test a correction against.
    if (asRead.status !== 'mismatch') return row;

    const winners = alternativesFor(row.unit).filter((alt) =>
      checkRow(row.name, row.amount, alt, row.dvPct).status === 'verified');

    // Exactly one, or leave it alone and let it stand as a mismatch.
    if (winners.length !== 1) return row;

    const to = winners[0]!;
    corrections.push({
      ingredient: row.name,
      from: row.unit,
      to,
      was: `${row.amount} ${row.unit}`,
      now: `${row.amount} ${to}`,
      why: `as read it works out to ${asRead.expectedPct}% but the label prints `
         + `${row.dvPct}%; read as ${to} the two agree`,
    });
    return { ...row, unit: to };
  });

  return { rows: out, corrections };
}
