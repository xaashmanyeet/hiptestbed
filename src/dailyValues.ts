// The arithmetic self-check.
//
// A Supplement Facts panel is internally redundant: for any nutrient with
// an established Daily Value,
//
//     amount / DailyValue * 100 = %DV
//
// and the Daily Value is a published constant (FDA, 21 CFR 101.9, 2016
// update). So a row read off a photo can be checked against ITSELF. This
// is the only place in the pipeline that can say a transcribed number is
// arithmetically WRONG rather than merely low-confidence.
//
// This makes no medical claim. It does not say a dose is high, low, safe
// or effective. It answers one question: do the two numbers printed on
// this label agree with each other?

export type NutrientKind = 'vitamin' | 'mineral';

export interface DailyValue {
  amount: number;
  unit: 'mcg' | 'mg' | 'g';
  kind: NutrientKind;
  /** Slug on ods.od.nih.gov/factsheets/<slug>-Consumer/ */
  nih: string;
  /** Tolerable Upper Intake Level for adults, in the same unit. null = none set. */
  ul: number | null;
  /** What the nutrient does in the body. Physiological function only —
   *  no claim about treating, preventing or improving anything. */
  role: string;
}

/** FDA Daily Values for adults and children 4+ years. */
export const DAILY_VALUES: Readonly<Record<string, DailyValue>> = {
  'vitamin a': { amount: 900, unit: 'mcg', kind: 'vitamin', ul: 3000, nih: 'VitaminA', role: 'Vision, immune function and cell growth.' },
  'vitamin c': { amount: 90, unit: 'mg', kind: 'vitamin', ul: 2000, nih: 'VitaminC', role: 'Collagen formation and iron absorption.' },
  'vitamin d': { amount: 20, unit: 'mcg', kind: 'vitamin', ul: 100, nih: 'VitaminD', role: 'Helps the body absorb calcium; bone health.' },
  'vitamin e': { amount: 15, unit: 'mg', kind: 'vitamin', ul: 1000, nih: 'VitaminE', role: 'Antioxidant; protects cells from damage.' },
  'vitamin k': { amount: 120, unit: 'mcg', kind: 'vitamin', ul: null, nih: 'VitaminK', role: 'Blood clotting and bone metabolism.' },
  thiamin: { amount: 1.2, unit: 'mg', kind: 'vitamin', ul: null, nih: 'Thiamin', role: 'Converts food into energy.' },
  riboflavin: { amount: 1.3, unit: 'mg', kind: 'vitamin', ul: null, nih: 'Riboflavin', role: 'Energy production and cell function.' },
  niacin: { amount: 16, unit: 'mg', kind: 'vitamin', ul: 35, nih: 'Niacin', role: 'Energy metabolism; skin and nerve function.' },
  'vitamin b6': { amount: 1.7, unit: 'mg', kind: 'vitamin', ul: 100, nih: 'VitaminB6', role: 'Protein metabolism and brain development.' },
  folate: { amount: 400, unit: 'mcg', kind: 'vitamin', ul: 1000, nih: 'Folate', role: 'Cell division and DNA formation.' },
  'vitamin b12': { amount: 2.4, unit: 'mcg', kind: 'vitamin', ul: null, nih: 'VitaminB12', role: 'Red blood cell formation and nerve function.' },
  biotin: { amount: 30, unit: 'mcg', kind: 'vitamin', ul: null, nih: 'Biotin', role: 'Metabolism of fats, carbohydrates and protein.' },
  'pantothenic acid': { amount: 5, unit: 'mg', kind: 'vitamin', ul: null, nih: 'PantothenicAcid', role: 'Converts food into energy.' },
  choline: { amount: 550, unit: 'mg', kind: 'vitamin', ul: 3500, nih: 'Choline', role: 'Cell structure and nerve signalling.' },
  calcium: { amount: 1300, unit: 'mg', kind: 'mineral', ul: 2500, nih: 'Calcium', role: 'Bone and tooth structure; muscle and nerve function.' },
  iron: { amount: 18, unit: 'mg', kind: 'mineral', ul: 45, nih: 'Iron', role: 'Carries oxygen in the blood.' },
  phosphorus: { amount: 1250, unit: 'mg', kind: 'mineral', ul: 4000, nih: 'Phosphorus', role: 'Bone structure and energy storage.' },
  iodine: { amount: 150, unit: 'mcg', kind: 'mineral', ul: 1100, nih: 'Iodine', role: 'Thyroid hormone production.' },
  magnesium: { amount: 420, unit: 'mg', kind: 'mineral', ul: 350, nih: 'Magnesium', role: 'Muscle and nerve function; energy production.' },
  zinc: { amount: 11, unit: 'mg', kind: 'mineral', ul: 40, nih: 'Zinc', role: 'Immune function and wound healing.' },
  selenium: { amount: 55, unit: 'mcg', kind: 'mineral', ul: 400, nih: 'Selenium', role: 'Antioxidant; thyroid function.' },
  copper: { amount: 0.9, unit: 'mg', kind: 'mineral', ul: 10, nih: 'Copper', role: 'Energy production and iron metabolism.' },
  manganese: { amount: 2.3, unit: 'mg', kind: 'mineral', ul: 11, nih: 'Manganese', role: 'Bone formation and metabolism.' },
  chromium: { amount: 35, unit: 'mcg', kind: 'mineral', ul: null, nih: 'Chromium', role: 'Helps insulin work in the body.' },
  molybdenum: { amount: 45, unit: 'mcg', kind: 'mineral', ul: 2000, nih: 'Molybdenum', role: 'Enzyme function for processing certain compounds.' },
  chloride: { amount: 2300, unit: 'mg', kind: 'mineral', ul: 3600, nih: 'Chloride', role: 'Fluid balance and digestion.' },
  potassium: { amount: 4700, unit: 'mg', kind: 'mineral', ul: null, nih: 'Potassium', role: 'Fluid balance, nerve signals, muscle contraction.' },
  sodium: { amount: 2300, unit: 'mg', kind: 'mineral', ul: null, nih: 'Sodium', role: 'Fluid balance and nerve function.' },
};

/**
 * Reduce a label name to the nutrient it names.
 * "Vitamin D3 (as Cholecalciferol)" -> "vitamin d"
 * The chemical form in brackets is the manufacturer's choice; the Daily
 * Value attaches to the nutrient, not the form.
 */
export function resolveNutrient(name: string): string | null {
  let n = name
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')          // drop "(as ...)" clauses
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // D3 and D2 are both vitamin D; B-vitamin numbers stay meaningful.
  n = n.replace(/^vitamin d\d$/, 'vitamin d');
  n = n.replace(/^vitamin k\d$/, 'vitamin k');
  n = n.replace(/^vitamin a\b.*$/, 'vitamin a');
  n = n.replace(/^vitamin c\b.*$/, 'vitamin c');
  n = n.replace(/^vitamin e\b.*$/, 'vitamin e');
  n = n.replace(/^folic acid$/, 'folate');
  n = n.replace(/^thiamine$/, 'thiamin');

  if (DAILY_VALUES[n] !== undefined) return n;
  // Last resort: the first word often names the mineral ("iron", "zinc").
  const first = n.split(' ')[0];
  if (first !== undefined && DAILY_VALUES[first] !== undefined) return first;
  return null;
}

const TO_MCG: Readonly<Record<string, number>> = { mcg: 1, ug: 1, mg: 1000, g: 1000000 };

export type CheckStatus = 'verified' | 'mismatch' | 'no-daily-value' | 'not-enough-data';

export interface DailyValueCheck {
  status: CheckStatus;
  nutrient: string | null;
  /** What the percentage should be, given the amount we read. */
  expectedPct: number | null;
  /** What the label printed. */
  printedPct: number | null;
}

/** Does the printed percentage agree with the printed amount? */
export function checkRow(
  name: string,
  amount: number | null,
  unit: string | null,
  printedPct: number | null,
): DailyValueCheck {
  const nutrient = resolveNutrient(name);
  if (nutrient === null) {
    return { status: 'no-daily-value', nutrient: null, expectedPct: null, printedPct };
  }
  const dv = DAILY_VALUES[nutrient]!;

  if (amount === null || unit === null || printedPct === null) {
    return { status: 'not-enough-data', nutrient, expectedPct: null, printedPct };
  }

  const labelFactor = TO_MCG[unit.toLowerCase()];
  const dvFactor = TO_MCG[dv.unit];
  if (labelFactor === undefined || dvFactor === undefined) {
    return { status: 'not-enough-data', nutrient, expectedPct: null, printedPct };
  }

  const expected = (amount * labelFactor) / (dv.amount * dvFactor) * 100;
  // 5% relative tolerance absorbs the rounding every label does.
  const agrees = Math.abs(expected - printedPct) <= Math.max(printedPct * 0.05, 1);

  return {
    status: agrees ? 'verified' : 'mismatch',
    nutrient,
    expectedPct: Math.round(expected),
    printedPct,
  };
}


export const NIH_FACTSHEET_BASE = 'https://ods.od.nih.gov/factsheets/';
export const NIH_FACTSHEET_INDEX = 'https://ods.od.nih.gov/factsheets/list-all/';

export function nihUrl(nutrient: string): string {
  const dv = DAILY_VALUES[nutrient];
  return dv === undefined
    ? NIH_FACTSHEET_INDEX
    : `${NIH_FACTSHEET_BASE}${dv.nih}-Consumer/`;
}
