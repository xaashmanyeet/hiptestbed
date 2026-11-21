// Merging several photographs of one bottle into a single reading.
//
// WHY THIS EXISTS. One photograph cannot hold everything. The Supplement
// Facts panel, the "Other ingredients" paragraph and the brand name are on
// different faces of a bottle, and on a curved surface the text at the edges
// of the frame distorts past what any recogniser can read while the middle
// stays sharp. So the app asks for a short sequence of photographs and has to
// combine them.
//
// THE HARD PART IS NOT COMBINING, IT IS DISAGREEING. Two photographs will
// often both produce a row called "Vitamin C" with different numbers. Taking
// the last one, or the first one, or the longest one, is arbitrary: a blurred
// front-of-pack shot would be allowed to overwrite a clean panel reading.
//
// What makes a principled choice possible is the arithmetic self-check. For
// any nutrient with an established Daily Value the label prints BOTH the
// amount and the percentage, and
//
//     amount / DailyValue * 100 = %DV
//
// must hold. A row whose arithmetic works is not merely more confident, it is
// internally consistent — two independently printed numbers agree. That is
// evidence, not a heuristic, and it beats a row from any other photograph
// regardless of which step produced it.
//
// Where no arithmetic is available (a herbal with no Daily Value, a product
// name) the rule falls back to completeness and to which photograph was
// ASKED for that field, and every rejected alternative is recorded so a
// person can see what was discarded rather than having to trust it.

import { checkRow } from './dailyValues';
import type { LabelIdentity } from './labelIdentity';
import { readIdentity } from './labelIdentity';
import type { Separator } from './labelSeparators';
import type { OcrPage } from './labelOcr';
import { parsePanel, relinkParents, type PanelRow, type ParsedPanel } from './labelPanelParse';
import { normaliseIngredient } from './labelTextNormalize';

/* ------------------------------------------------------------- the steps */

export type CaptureStep = 'panel' | 'other' | 'front';

export interface StepSpec {
  step: CaptureStep;
  title: string;
  /** Shown over the viewfinder. */
  instruction: string;
  /** What this photograph is the authority on when photographs disagree. */
  provides: string;
  /** The panel shot is the only one the rest of the pipeline cannot do without. */
  required: boolean;
}

export const CAPTURE_STEPS: readonly StepSpec[] = [
  {
    step: 'panel',
    title: 'Supplement Facts',
    instruction: 'Fill the frame with the Supplement Facts panel, square on.',
    provides: 'the ingredient rows, serving size and servings per container',
    required: true,
  },
  {
    step: 'other',
    title: 'Other ingredients',
    instruction: 'Now the "Other ingredients" paragraph and any warnings.',
    provides: 'the fillers paragraph, which the law prints outside the panel',
    required: false,
  },
  {
    step: 'front',
    title: 'Front of pack',
    instruction: 'Now the front, so the product name and brand can be read.',
    provides: 'the product name and brand used to search the NIH database',
    required: false,
  },
];

export const stepSpec = (step: CaptureStep): StepSpec =>
  CAPTURE_STEPS.find((c) => c.step === step) ?? CAPTURE_STEPS[0]!;

/* ------------------------------------------------------- one photograph */

export interface ShotReading {
  step: CaptureStep;
  page: OcrPage;
  panel: ParsedPanel;
  identity: LabelIdentity;
}

/**
 * Everything derivable from a single photograph, before any merging.
 *
 * `seps` are the printed rules found on that photograph, when the detector
 * ran. Optional, so every existing caller and test is unchanged and a page
 * with no separator information parses exactly as it did before.
 */
export function readShot(
  step: CaptureStep, page: OcrPage, seps: readonly Separator[] = [],
): ShotReading {
  return { step, page, panel: parsePanel(page, seps), identity: readIdentity(page) };
}

/* ------------------------------------------------------- how good a row is */

export type RowQualityKind =
  | 'verified'              // the arithmetic proves the two printed numbers agree
  | 'complete-unverifiable' // name, amount and unit read; nothing to check against
  | 'contradictory'         // everything read, but the arithmetic disagrees
  | 'amount-only'           // a number, but no unit to interpret it with
  | 'name-only';            // a name and nothing else

export interface RowQuality {
  score: number;
  kind: RowQualityKind;
  why: string;
}

/**
 * The ranking that decides conflicts. The gap between `verified` and
 * everything else is deliberately enormous: arithmetic agreement is the only
 * signal in this whole pipeline that can PROVE a transcription, and it should
 * never lose to a row that merely looks tidier.
 */
export function rowQuality(r: PanelRow): RowQuality {
  const complete = r.amount !== null && r.unit !== null;
  const check = checkRow(r.name, r.amount, r.unit, r.dvPct);

  if (check.status === 'verified') {
    return {
      score: 100,
      kind: 'verified',
      why: `${r.amount} ${r.unit} works out to the printed ${r.dvPct}%`,
    };
  }
  if (check.status === 'mismatch') {
    return {
      score: 45,
      kind: 'contradictory',
      why: `reads as ${check.expectedPct}% but the label prints ${check.printedPct}%`,
    };
  }
  if (complete) {
    return {
      score: r.dvNotEstablished ? 62 : 60,
      kind: 'complete-unverifiable',
      why: r.dvNotEstablished
        ? 'amount read; no Daily Value established, which is normal for a blend'
        : 'amount and unit read; no published Daily Value to check it against',
    };
  }
  if (r.amount !== null) {
    return { score: 35, kind: 'amount-only', why: 'a number with no unit beside it' };
  }
  return {
    score: r.name.trim().length > 0 ? 15 : 5,
    kind: 'name-only',
    why: 'no amount was read on this row',
  };
}

/* ------------------------------------------------------------- the merge */

export interface RowAlternative {
  from: CaptureStep;
  quality: RowQuality;
  raw: string;
}

export interface RowDecision {
  row: PanelRow;
  from: CaptureStep;
  quality: RowQuality;
  /** Readings of the same ingredient that lost, and why. */
  rejected: RowAlternative[];
}

export type MergeField =
  | 'servingSize' | 'servingsPerContainer' | 'otherIngredients' | 'productName' | 'brand';

export interface FieldChoice {
  field: MergeField;
  value: string | null;
  from: CaptureStep | null;
  why: string;
  rejected: { from: CaptureStep; value: string }[];
}

export interface DiscardedRow {
  from: CaptureStep;
  raw: string;
  why: string;
}

export interface ShotSummary {
  step: CaptureStep;
  lines: number;
  words: number;
  rows: number;
  verified: number;
}

export interface MergeReport {
  shots: ShotSummary[];
  rows: RowDecision[];
  fields: FieldChoice[];
  /** Rows where a later photograph beat the first reading. */
  replaced: number;
  /** Rows only one photograph saw at all. */
  contributed: Partial<Record<CaptureStep, number>>;
  /** Fragments a later photograph offered that were not ingredients. */
  discarded: DiscardedRow[];
}

export interface MergedLabel {
  rows: PanelRow[];
  identity: LabelIdentity;
  servingSize: string | null;
  servingsPerContainer: string | null;
  otherIngredients: string | null;
  /** The photograph the rest of the pipeline treats as "the label". */
  primary: ShotReading;
  report: MergeReport;
}

/** Which photograph is the authority on a field when readings differ. */
const OWNER: Readonly<Record<MergeField, CaptureStep>> = {
  servingSize: 'panel',
  servingsPerContainer: 'panel',
  otherIngredients: 'other',
  productName: 'front',
  brand: 'front',
};

const FIELD_LABEL: Readonly<Record<MergeField, string>> = {
  servingSize: 'Serving size',
  servingsPerContainer: 'Servings per container',
  otherIngredients: 'Other ingredients',
  productName: 'Product name',
  brand: 'Brand',
};

export const fieldLabel = (f: MergeField): string => FIELD_LABEL[f];

function valueOf(shot: ShotReading, field: MergeField): string | null {
  switch (field) {
    case 'servingSize': return shot.panel.servingSize;
    case 'servingsPerContainer': return shot.panel.servingsPerContainer;
    case 'otherIngredients': return shot.panel.otherIngredients;
    case 'productName': return shot.identity.productName;
    case 'brand': return shot.identity.brand;
  }
}

function chooseField(shots: readonly ShotReading[], field: MergeField): FieldChoice {
  const having = shots
    .map((sh) => ({ from: sh.step, value: valueOf(sh, field) }))
    .filter((x): x is { from: CaptureStep; value: string } =>
      typeof x.value === 'string' && x.value.trim().length > 0);

  if (having.length === 0) {
    return { field, value: null, from: null, why: 'no photograph produced this', rejected: [] };
  }

  const owner = OWNER[field];
  const owned = having.find((x) => x.from === owner);
  // The photograph that was ASKED for this field wins, if it produced anything.
  // Otherwise the fullest reading, which on a partially-obscured line is the
  // one that saw more of it.
  const winner = owned ?? [...having].sort((a, b) => b.value.length - a.value.length)[0]!;

  const rejected = having.filter((x) => x !== winner && x.value !== winner.value);
  return {
    field,
    value: winner.value,
    from: winner.from,
    why: owned !== undefined
      ? `taken from the ${stepSpec(owner).title.toLowerCase()} photograph, which was framed for it`
      : `the ${stepSpec(winner.from).title.toLowerCase()} photograph gave the fullest reading`,
    rejected,
  };
}

/**
 * Can this be ADDED as an ingredient the other photographs missed?
 *
 * Only if it has a name. A row reading "106%" is the right-hand half of a row
 * whose name the recogniser dropped — real on the label, but not something
 * that can be listed as an ingredient, and appending it would put a nameless
 * entry in the rebuilt panel next to the proper row from another photograph.
 * An amount alone is not enough: an ingredient you cannot name is not an
 * ingredient, it is debris.
 *
 * This guards ADDING only. A row already in the spine is left exactly as a
 * single photograph would have produced it, so the one-photograph path is
 * byte-for-byte what it was before merging existed.
 */
const nameable = (r: PanelRow): boolean => /[a-z]{2}/i.test(r.name);

/** Rows with no usable name cannot be matched across photographs; keep them apart. */
const keyFor = (r: PanelRow, step: CaptureStep, i: number): string => {
  const k = normaliseIngredient(r.name);
  return k.length > 2 ? k : `\u0000${step}:${i}`;
};

/**
 * Combine the readings. One photograph in is a valid call and returns that
 * reading unchanged — the single-shot path runs through this same code, so
 * there is no second, untested route through the app.
 */
export function mergeShots(shots: readonly ShotReading[]): MergedLabel {
  if (shots.length === 0) throw new Error('mergeShots needs at least one photograph');

  // One photograph supplies the RUNNING ORDER and the rest only fill it in,
  // because a Supplement Facts panel is printed in a deliberate order that a
  // merge must not scramble.
  //
  // That photograph is the one framed for the panel, not simply the one that
  // produced the most rows: a front-of-pack shot that happens to catch a
  // marketing table, or a blurred panel read twice over, can produce more
  // rows than the real thing. Row count only decides it when no panel shot
  // read anything.
  const byRows = [...shots].sort((a, b) => b.panel.rows.length - a.panel.rows.length);
  const panelShot = shots.find((sh) => sh.step === 'panel');
  const spine = panelShot !== undefined && panelShot.panel.rows.length > 0
    ? panelShot
    : byRows[0]!;
  const primary = panelShot ?? spine;

  const decisions: RowDecision[] = [];
  const indexByKey = new Map<string, number>();

  spine.panel.rows.forEach((row, i) => {
    const key = keyFor(row, spine.step, i);
    indexByKey.set(key, decisions.length);
    decisions.push({ row, from: spine.step, quality: rowQuality(row), rejected: [] });
  });

  // Block numbers are per-photograph. Shifting the ones that arrive later
  // keeps a row appended from another shot from being adopted as a component
  // of an unrelated blend when parents are relinked below.
  let blockOffset = Math.max(0, ...spine.panel.rows.map((r) => r.block)) + 1;
  let replaced = 0;
  const contributed: Partial<Record<CaptureStep, number>> = {};
  const discarded: DiscardedRow[] = [];

  for (const shot of shots) {
    if (shot === spine) continue;
    let added = 0;
    shot.panel.rows.forEach((row, i) => {
      const key = keyFor(row, shot.step, i);
      const at = indexByKey.get(key);
      const quality = rowQuality(row);

      if (at === undefined) {
        if (!nameable(row)) {
          discarded.push({
            from: shot.step, raw: row.raw,
            why: 'no ingredient name, so it cannot be added as a row of its own',
          });
          return;
        }
        indexByKey.set(key, decisions.length);
        decisions.push({
          row: { ...row, block: row.block + blockOffset, parentIndex: null },
          from: shot.step, quality, rejected: [],
        });
        added++;
        return;
      }

      const held = decisions[at]!;
      if (quality.score > held.quality.score) {
        // Keep the spine's POSITION and indent, which came from the panel's
        // own geometry, and take only the content that scored better.
        held.rejected.push({ from: held.from, quality: held.quality, raw: held.row.raw });
        decisions[at] = {
          row: { ...row, block: held.row.block, indentLevel: held.row.indentLevel, parentIndex: null },
          from: shot.step,
          quality,
          rejected: held.rejected,
        };
        replaced++;
      } else {
        held.rejected.push({ from: shot.step, quality, raw: row.raw });
      }
    });
    if (added > 0) contributed[shot.step] = added;
    blockOffset += Math.max(0, ...shot.panel.rows.map((r) => r.block)) + 1;
  }

  // parentIndex pointed into each photograph's own row list and is meaningless
  // now. Recompute it from indent depth, exactly as a single panel does.
  const rows = relinkParents(decisions.map((d) => d.row));
  rows.forEach((r, i) => { decisions[i]!.row = r; });

  const fields: MergeField[] =
    ['servingSize', 'servingsPerContainer', 'otherIngredients', 'productName', 'brand'];
  const choices = fields.map((f) => chooseField(shots, f));
  const pick = (f: MergeField): string | null =>
    choices.find((c) => c.field === f)?.value ?? null;

  const identity: LabelIdentity = {
    productName: pick('productName'),
    brand: pick('brand'),
    nameCandidates: [...new Set(shots.flatMap((sh) => sh.identity.nameCandidates))],
    printedCodes: [...new Set(shots.flatMap((sh) => sh.identity.printedCodes))],
  };

  const summaries: ShotSummary[] = shots.map((sh) => ({
    step: sh.step,
    lines: sh.page.lines.length,
    words: sh.page.lines.reduce((n, l) => n + l.words.length, 0),
    rows: sh.panel.rows.length,
    verified: sh.panel.rows.filter((r) => rowQuality(r).kind === 'verified').length,
  }));

  return {
    rows,
    identity,
    servingSize: pick('servingSize'),
    servingsPerContainer: pick('servingsPerContainer'),
    otherIngredients: pick('otherIngredients'),
    primary,
    report: {
      shots: summaries, rows: decisions, fields: choices,
      replaced, contributed, discarded,
    },
  };
}
