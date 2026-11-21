// One shape that both sources map into: a photographed label, or a record
// pulled from the NIH database. Everything downstream — the rebuilt panel,
// the arithmetic check, the reference notes — reads only this.

import type { MergedLabel } from './labelMerge';
import type { PackReading } from './labelPack';
import type { OcrPage } from './labelOcr';
import { parsePanel, type PanelRow } from './labelPanelParse';

export interface LabelRow {
  name: string;
  amount: number | null;
  unit: string | null;
  dvPct: number | null;
  dvNotEstablished: boolean;
  indentLevel: number;
  /** The source's own classification, when it has one. NIH supplies this. */
  category: string | null;
}

export interface LabelStatement { type: string; text: string }

export interface LabelProduct {
  source: 'photo' | 'nih';
  title: string;
  brand: string | null;
  servingSize: string | null;
  servingsPerContainer: string | null;
  rows: LabelRow[];
  otherIngredients: string | null;
  /** Who the label says it is for. */
  userGroups: string[];
  /** The manufacturer's own printed text: directions, warnings, allergens. */
  statements: LabelStatement[];
  dsldId: string | null;
}

const toLabelRow = (r: PanelRow): LabelRow => ({
  name: r.name,
  amount: r.amount,
  unit: r.unit,
  dvPct: r.dvPct,
  dvNotEstablished: r.dvNotEstablished,
  indentLevel: r.indentLevel,
  category: null,
});

export function fromPhoto(page: OcrPage, title: string): LabelProduct {
  const panel = parsePanel(page);
  return {
    source: 'photo',
    title,
    brand: null,
    servingSize: panel.servingSize,
    servingsPerContainer: panel.servingsPerContainer,
    rows: panel.rows.map(toLabelRow),
    otherIngredients: panel.otherIngredients,
    userGroups: [],
    statements: [],
    dsldId: null,
  };
}

/**
 * The same shape, built from SEVERAL photographs instead of one. Each field
 * has already been argued over in labelMerge; this only carries the winners
 * across. Still `source: 'photo'` — however many pictures were taken, nothing
 * here came from anywhere but the bottle.
 */
export function fromMerged(
  merged: MergedLabel, title: string, pack?: PackReading,
): LabelProduct {
  // The directions, warnings and allergen statements used to arrive only from
  // the NIH database, so a photographed label showed empty sections for text
  // that was plainly visible in the picture. These come off the packaging now.
  const statements: LabelStatement[] = pack === undefined ? [] : [
    ...pack.directions.map((text) => ({ type: 'directions', text })),
    ...pack.warnings.map((text) => ({ type: 'warning', text })),
    ...pack.allergens.map((text) => ({ type: 'contains', text })),
    ...pack.storage.map((text) => ({ type: 'storage', text })),
  ];

  return {
    source: 'photo',
    title,
    brand: pack?.brand ?? merged.identity.brand,
    servingSize: merged.servingSize,
    servingsPerContainer: merged.servingsPerContainer,
    rows: merged.rows.map(toLabelRow),
    otherIngredients: merged.otherIngredients,
    // "Who this is for" has always been empty from a photograph, because
    // nothing read a target group off the front. It does now, so the
    // section the Label tab already has can finally be filled from a
    // picture rather than only from the database.
    userGroups: pack?.targetGroup == null ? [] : [pack.targetGroup],
    statements,
    dsldId: null,
  };
}

const UNIT: Readonly<Record<string, string>> = {
  'microgram(s)': 'mcg', 'milligram(s)': 'mg', 'gram(s)': 'g',
  'iu': 'IU', 'calorie(s)': 'cal', 'milliliter(s)': 'mL',
};

export function normaliseUnit(raw: string): string {
  return UNIT[raw.toLowerCase().trim()] ?? raw;
}
