// PASS 2b: turn positioned text into an ingredient table.
//
// ORDER OF OPERATIONS, and why each step is where it is:
//   1. find the column blocks            (same y != same row, see labelPanelLayout)
//   2. drop everything outside them      (kills warnings + other-ingredients column)
//   3. group each block's lines into rows by vertical centre
//   4. work out indent LEVELS from the left edges, per block
//   5. split name / amount / unit using WORD boxes, not the line string
//   6. attach the % daily value, which arrives in four different ways
//   7. fold "(as Ascorbic Acid)" continuation lines into the row above
//   8. link indented rows to the blend they sit under
//
// Nothing here guesses. A row we cannot read keeps nulls and keeps its
// raw text, so a human can see exactly what was on the label.

import type { OcrLine, OcrPage } from './labelOcr';
import { centreY, medianHeight, right } from './labelOcr';
import { contentTag } from './labelLineClassification';
import {
  looksLikePanel, preparePage, recoverableLines, wholePageBlock,
} from './labelPanelRecover';
import { blockFor, findColumnBlocks, type ColumnBlock } from './labelPanelLayout';
import { repairUnits, type UnitCorrection } from './unitRepair';
import {
  MIN_USABLE, describeSeparators, groupRowsBySeparators, usableSeparators,
  type Separator, type SeparatorReport,
} from './labelSeparators';

const NUM = /^\d+(?:[.,]\d+)?$/;
// A unit, optionally with the %DV glued straight onto it — real OCR output
// on the test label includes "mcg111%" with no space.
// Accepts the punctuation real labels carry — "mg.", "mcg)", "µg" — and the
// %DV sometimes glued straight on with no space, as in real OCR output
// ("mcg111%"). MICROGRAM covers the µ sign, which squash() strips to nothing
// and tidy() leaves alone.
const UNIT = /^(MCG|MG|G|IU|ML|UG|µG|MCGS|MGS)[.,]?(?:(\d+)%)?[).,]?$/;
const PCT = /^(\d+)%$/;

export interface PanelRow {
  block: number;
  name: string;
  amount: number | null;
  unit: string | null;
  dvPct: number | null;
  /** True when the DV cell held "*", i.e. no Daily Value is established. */
  dvNotEstablished: boolean;
  /** 0 = top level. 1+ = indented under the row above. */
  indentLevel: number;
  /** Index into rows[] of the blend this sits under, or null at top level. */
  parentIndex: number | null;
  raw: string;
}

export interface ParsedPanel {
  found: boolean;
  /** True when the rows came from the no-header fallback, not a real table. */
  recovered: boolean;
  /** Units the arithmetic proved were misread, with before and after. */
  unitCorrections: UnitCorrection[];
  /** Whether the label's own printed rules decided the row boundaries. */
  separators: SeparatorReport;
  servingSize: string | null;
  servingsPerContainer: string | null;
  blockCount: number;
  rows: PanelRow[];
  otherIngredients: string | null;
  /** Lines that sat outside every column block — warnings, footer, etc. */
  excludedLines: number;
}

interface Group { lines: OcrLine[] }

/**
 * Sort lines into rows by vertical position.
 *
 * THE ANCHOR MOVES. The original compared each line against the FIRST line
 * already in the group, and that anchor never updated however many lines
 * joined. On a flat label it hardly matters. On a bottle, where the baseline
 * drifts a little across the frame, each row's first line is measured at one
 * edge and later lines at the other, so the comparison slowly walks off the
 * row — and a row picks up the value belonging to the row beneath it.
 *
 * Comparing against the group's running mean instead lets the group follow
 * the drift. On a flat label the mean of near-identical values is those
 * values, so nothing changes; on a curved one it tracks the baseline.
 */
function groupRows(lines: OcrLine[], tol: number): Group[] {
  const sorted = [...lines].sort((a, b) => centreY(a.box) - centreY(b.box));
  const groups: Group[] = [];
  let runningMean = 0;
  for (const line of sorted) {
    const last = groups[groups.length - 1];
    const y = centreY(line.box);
    if (last !== undefined && Math.abs(y - runningMean) <= tol) {
      last.lines.push(line);
      runningMean += (y - runningMean) / last.lines.length;
      continue;
    }
    groups.push({ lines: [line] });
    runningMean = y;
  }
  return groups;
}

/**
 * Is this row really the tail of the one above it?
 *
 * "(as Ascorbic Acid)" on its own line continues the row above. The original
 * test required the line to start with a bracket AND carry no amount and no
 * percentage, which was too narrow in both directions: a wrapped form often
 * carries the dose that belongs to its row, and a line can continue an
 * unclosed bracket without opening with one.
 *
 * THE DISTINCTION THAT MUST SURVIVE is a blend component. Those are indented
 * under their blend, they do NOT begin with a bracket, and folding one into
 * its parent would destroy the nesting 21 CFR 101.36(c) requires the label
 * to show. So an indented line is never a continuation, whatever else it
 * looks like.
 */
function isContinuation(
  row: PanelRow, prev: PanelRow | undefined, block: number,
): prev is PanelRow {
  if (prev === undefined || prev.block !== block) return false;
  // A blend component. Indentation is the whole signal; leave it alone.
  if (row.indentLevel > 0 && !row.name.trimStart().startsWith('(')) return false;

  const name = row.name.trim();
  if (name.length === 0) return false;

  // Wholly bracketed, on its own line.
  const wholly = /^\(.*\)$/.test(name);
  // Opens a bracket and does not close it, or closes one the row above left
  // open — either way the two lines are one parenthetical.
  const opens = name.startsWith('(') && !name.includes(')');
  const closes = !name.startsWith('(') && name.includes(')') && !name.includes('(')
    && /\([^)]*$/.test(prev.name);

  return wholly || opens || closes;
}

/**
 * The distinct left edges used inside one block, in order. A blend header
 * sits at stop 0 and its components at stop 1 — indentation is required by
 * 21 CFR 101.36(c), so measuring it is how nesting is recovered.
 */
function indentStops(xs: readonly number[], tol: number): number[] {
  const stops: number[] = [];
  for (const x of [...new Set(xs)].sort((a, b) => a - b)) {
    const last = stops[stops.length - 1];
    if (last === undefined || x - last > tol) stops.push(x);
  }
  return stops;
}

function levelFor(x: number, stops: readonly number[], tol: number): number {
  let level = 0;
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    if (s !== undefined && x >= s - tol) level = i;
  }
  return level;
}

// "2,250" is two thousand two hundred and fifty, not 2.25. A comma followed by
// exactly three digits is a thousands separator; anything else is a decimal
// comma, which European labels do use. Getting this wrong is a 1000x error on
// exactly the nutrients printed in the thousands -- vitamin A, folate, biotin.
function parseAmount(raw: string): number {
  const t = raw.trim();
  const cleaned = /,\d{3}\b/.test(t)
    ? t.replace(/,(?=\d{3}\b)/g, '')
    : t.replace(',', '.');
  return Number(cleaned);
}

function readRow(
  group: Group, block: ColumnBlock, blockIndex: number,
  stops: readonly number[], tol: number,
): PanelRow {
  const ordered = [...group.lines].sort((a, b) => a.box.x - b.box.x);
  const head = ordered[0]!;
  const raw = ordered.map((l) => l.text).join(' ');

  let amount: number | null = null;
  let unit: string | null = null;
  let dvPct: number | null = null;
  let name = head.text.trim();

  // 5. first number-then-unit pair, left to right. On
  //    "Vitamin D3 25 mcg (1000 IU)" that takes 25 mcg and leaves the
  //    parenthetical alternate measure alone.
  // Scan EVERY line in the row, not just the leftmost. Dotted leader lines
  // ("Vitamin C .......... 60 mg") make the recogniser emit the name and the
  // amount as two separate reads, so the number is often in a sibling line.
  outer: for (const line of ordered) {
    const words = line.words;
    for (let i = 0; i < words.length - 1; i++) {
      const a = words[i]!;
      const b = words[i + 1]!;
      if (!NUM.test(a.text)) continue;
      const m = UNIT.exec(b.text.toUpperCase());
      if (m === null) continue;
      amount = parseAmount(a.text);
      unit = (m[1] ?? '').toLowerCase();
      if (m[2] !== undefined) dvPct = Number(m[2]);
      // The name is whatever preceded the number, on whichever line held it.
      const before = words.slice(0, i).map((w) => w.text).join(' ').trim();
      name = line === head
        ? before
        : (before.length > 0 ? `${head.text.trim()} ${before}` : head.text.trim());
      break outer;
    }
  }

  // Dotted leaders and stray punctuation end up glued to the name.
  name = name.replace(/[.\u2024\u2026\s]{2,}$/g, '').replace(/\s{2,}/g, ' ').trim();

  // A lone number with no unit, sitting in the amount column, is still an amount.
  if (amount === null) {
    for (const line of ordered) {
      if (line === head) continue;
      const m = /^(\d+(?:[.,]\d+)?)\s*$/.exec(line.text.trim());
      if (m !== null) { amount = parseAmount(m[1]!); break; }
    }
  }

  // 6a. %DV as the last word of this line
  if (dvPct === null) {
    const lastWord = head.words[head.words.length - 1];
    if (lastWord !== undefined) {
      const m = PCT.exec(lastWord.text);
      if (m !== null && Math.abs(right(lastWord.box) - block.dvRight) < 0.03) {
        dvPct = Number(m[1]);
      }
    }
  }
  // 6b. %DV as its own right-aligned line
  if (dvPct === null) {
    for (const l of ordered.slice(1)) {
      const m = PCT.exec(l.text.trim());
      if (m !== null) { dvPct = Number(m[1]); break; }
    }
  }
  // 6c. "*" in the DV column: no Daily Value established. Normal on blends.
  const dvNotEstablished = dvPct === null && ordered.some(
    (l) => /^[*†]$/.test(l.text.trim()) && Math.abs(right(l.box) - block.dvRight) < 0.05,
  );

  return {
    block: blockIndex, name, amount, unit, dvPct, dvNotEstablished,
    indentLevel: levelFor(head.box.x, stops, tol), parentIndex: null, raw,
  };
}

/**
 * An indented row belongs to the nearest row above it, in the same block, at
 * a shallower indent. That is the blend it is a component of.
 *
 * Exported because MERGING several photographs reorders rows, which silently
 * invalidates every parentIndex — they are positions in a list, and the list
 * changed. Recomputing from indent depth is the only safe thing to do, and it
 * has to be the same code that a single panel uses or the two paths can
 * disagree about what belongs to what.
 */
/**
 * The "Other ingredients" paragraph, as the LINES that make it up.
 *
 * By law this paragraph sits outside the Supplement Facts box, which means it
 * is also outside every column block — so to anything that reasons about the
 * panel it looks exactly like front-of-label text. That matters beyond the
 * panel parser: whatever hunts for the product name has to know these lines
 * are a sentence about cellulose and not the name of the product.
 *
 * Found by the regulated header, then by what is printed beneath it at the
 * same left margin, which is what a paragraph is.
 */
/**
 * The "Other ingredients" paragraph — the fillers, binders and coatings the
 * law puts OUTSIDE the panel box.
 *
 * Three things went wrong with the original, which took every line below
 * the header within 5% of its left edge:
 *
 *   ISOLATION. A paragraph set in small type down the side of a pack, or
 *   wrapped into a second column, does not stay at one x. Following it by
 *   reading order and proximity catches those; the x test only caught the
 *   easy case.
 *
 *   KNOWING WHERE IT STOPS. Nothing ended the paragraph, so a warning, the
 *   maker's address and a barcode printed underneath all got swept in. It
 *   now stops at the first line another rule claims, and at a vertical gap
 *   too large to be the next line of the same paragraph.
 *
 *   CONTAMINATION. Barcodes, lot stamps and expiry dates were ending up in
 *   the ingredient list. Those already have tags; they are now excluded by
 *   tag rather than hoped against.
 */
export function otherIngredientLines(page: OcrPage): OcrLine[] {
  const byReading = [...page.lines].sort((a, b) =>
    (Math.abs(a.box.y - b.box.y) > Math.max(a.box.h, b.box.h) * 0.5
      ? a.box.y - b.box.y
      : a.box.x - b.box.x));

  const at = byReading.findIndex((l) => contentTag(l.text) === 'other-ingredients-header');
  if (at < 0) return [];
  const anchor = byReading[at]!;

  // Tags that mean "this line is something else, the paragraph ended here".
  // Everything in this list is printed near the ingredients and used to be
  // swallowed by them.
  const ENDS = new Set([
    'gtin', 'ndc', 'batch', 'contact', 'manufacturer', 'warning', 'storage',
    'tamper-seal', 'allergen', 'directions', 'certification', 'panel-anchor',
    'serving-size', 'servings-per-container', 'amount-header', 'dv-header',
  ]);

  const out: OcrLine[] = [anchor];
  let prev = anchor;
  const gapLimit = Math.max(anchor.box.h * 2.2, 0.02);

  for (let i = at + 1; i < byReading.length; i++) {
    const line = byReading[i]!;
    if (line.box.y < prev.box.y - prev.box.h) continue;
    // A jump down the page means a different piece of text, not the next
    // line of this paragraph.
    if (line.box.y - (prev.box.y + prev.box.h) > gapLimit) break;
    if (ENDS.has(contentTag(line.text))) break;
    out.push(line);
    prev = line;
  }
  return out;
}

/**
 * Join two readings of the same paragraph without repeating the overlap.
 *
 * When a paragraph spans two photographs the frames overlap, so simple
 * concatenation prints the middle of it twice. The longest run of words
 * that ends one reading and begins the other is where they meet.
 *
 * When no overlap is found the two are kept separate and marked, rather
 * than joined on a guess — an invented join reads perfectly and is wrong.
 */
export function joinParagraphs(
  a: string, b: string,
): { text: string; joined: boolean; why: string } {
  const A = a.trim();
  const B = b.trim();
  if (A.length === 0) return { text: B, joined: true, why: 'only one reading' };
  if (B.length === 0) return { text: A, joined: true, why: 'only one reading' };
  if (A === B) return { text: A, joined: true, why: 'both readings were identical' };
  if (A.includes(B)) return { text: A, joined: true, why: 'the second is contained in the first' };
  if (B.includes(A)) return { text: B, joined: true, why: 'the first is contained in the second' };

  const aw = A.split(/\s+/);
  const bw = B.split(/\s+/);
  const norm = (w: string): string => w.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Longest run of words that is both a tail of A and a head of B. Three
  // words minimum: one or two coincide too easily in a list of chemicals.
  for (let n = Math.min(aw.length, bw.length); n >= 3; n--) {
    const tail = aw.slice(aw.length - n).map(norm).join(' ');
    const head = bw.slice(0, n).map(norm).join(' ');
    if (tail.length > 0 && tail === head) {
      // Keep the SECOND reading's copy of the overlapping words. They carry
      // the punctuation that leads into what follows — a comma at the join
      // is lost if the first reading's version wins, turning "Stearate,
      // Gelatin" into "Stearate Gelatin".
      return {
        text: [...aw.slice(0, aw.length - n), ...bw].join(' '),
        joined: true,
        why: `the two readings share ${n} words where they meet`,
      };
    }
  }

  return {
    text: `${A} … ${B}`,
    joined: false,
    why: 'the two readings do not overlap, so part of the paragraph may be missing',
  };
}

export function relinkParents(rows: readonly PanelRow[]): PanelRow[] {
  const out = rows.map((r) => ({ ...r, parentIndex: null as number | null }));
  for (let i = 0; i < out.length; i++) {
    const r = out[i]!;
    if (r.indentLevel === 0) continue;
    for (let j = i - 1; j >= 0; j--) {
      const c = out[j]!;
      if (c.block !== r.block) break;
      if (c.indentLevel < r.indentLevel) { r.parentIndex = j; break; }
    }
  }
  return out;
}

export function parsePanel(input: OcrPage, seps: readonly Separator[] = []): ParsedPanel {
  const page = preparePage(input);
  const strict = findColumnBlocks(page);
  const medH = medianHeight(page.lines);

  // NEVER RETURN NOTHING WHEN THERE IS SOMETHING TO READ.
  //
  // The strict reader needs both column headings to find a table. When they
  // are missing — torn, cropped, too small, printed in a way no rule covers
  // — the rows are still on the page and still look like rows. Rather than
  // report a panel-free photograph, take the whole page as one block and
  // read what is there. `recovered` says which path produced these rows, so
  // a best-effort reading is never mistaken for a clean one.
  const recovered = strict.length === 0 && looksLikePanel(page);
  const blocks = recovered ? [wholePageBlock(page)] : strict;

  let servingSize: string | null = null;
  let servingsPerContainer: string | null = null;
  let otherHeader: OcrLine | null = null;
  for (const line of page.lines) {
    const tag = contentTag(line.text);
    if (tag === 'serving-size' && servingSize === null) servingSize = line.text.trim();
    if (tag === 'servings-per-container' && servingsPerContainer === null) {
      servingsPerContainer = line.text.trim();
    }
    if (tag === 'other-ingredients-header' && otherHeader === null) otherHeader = line;
  }

  if (blocks.length === 0) {
    return {
      found: false, recovered: false, unitCorrections: [],
      separators: describeSeparators(seps, false),
      servingSize, servingsPerContainer, blockCount: 0,
      rows: [], otherIngredients: null, excludedLines: page.lines.length,
    };
  }

  // 2. assign every line to a block, or to nothing
  // The label's own rules beat any tolerance measured from the text, but
  // only when there are enough of them to be believed. Below that the
  // measured grouping runs exactly as it does today.
  const useSeps = usableSeparators(seps).length >= MIN_USABLE;

  const build = (bs: readonly ColumnBlock[], source: readonly OcrLine[]) => {
  const perBlock: OcrLine[][] = bs.map(() => []);
  let excluded = 0;
  for (const line of source) {
    const tag = contentTag(line.text);
    if (tag === 'amount-header' || tag === 'dv-header' || tag === 'panel-anchor') continue;
    const idx = blockFor(line.box, bs);
    if (idx === null) { excluded++; continue; }
    perBlock[idx]!.push(line);
  }

  const rows: PanelRow[] = [];
  const indentTol = medH * 0.4;
  bs.forEach((block, bi) => {
    const grouped = useSeps
      ? groupRowsBySeparators(perBlock[bi]!, seps)
      : groupRows(perBlock[bi]!, medH * 0.6);
    // 4. indent stops are per block: a two-column panel has two name columns.
    const headXs = grouped.map((g) =>
      Math.min(...g.lines.map((l) => l.box.x)));
    const stops = indentStops(headXs, indentTol);

    for (const g of grouped) {
      const parsed = readRow(g, block, bi, stops, indentTol);
      const prev = rows[rows.length - 1];
      if (isContinuation(parsed, prev, bi)) {
        prev!.name = `${prev!.name} ${parsed.name}`.trim();
        prev!.raw = `${prev!.raw} ${parsed.raw}`.trim();
        // A continuation may carry the amount its own row was missing —
        // "(as Ascorbic Acid) 60 mg" is one row, printed on two lines, and
        // dropping the 60 mg because it arrived on the second of them is
        // how an ingredient ends up with no dose.
        if (prev!.amount === null && parsed.amount !== null) {
          prev!.amount = parsed.amount;
          prev!.unit = parsed.unit;
        }
        if (prev!.dvPct === null && parsed.dvPct !== null) prev!.dvPct = parsed.dvPct;
        if (!prev!.dvNotEstablished && parsed.dvNotEstablished) prev!.dvNotEstablished = true;
        continue;
      }
      if (parsed.name === '' && parsed.amount === null) continue;
      rows.push(parsed);
    }
  });

  return { rows: relinkParents(rows), excluded };
  };

  // 8. Read it both ways when the strict reading came back with no numbers.
  //
  // A table whose edges were found but whose values all landed outside them
  // is worse than no table: it reports rows with no amounts, which cannot be
  // checked and cannot be judged. When that happens the whole-page fallback
  // usually does better, so both are read and the one that actually
  // extracted amounts wins. Counting amounts rather than rows on purpose —
  // a row without a number is not worth having.
  const withAmount = (rs: readonly PanelRow[]): number =>
    rs.filter((r) => r.amount !== null).length;

  let got = build(blocks, recovered ? recoverableLines(page) : page.lines);
  let usedRecovery = recovered;
  if (withAmount(got.rows) === 0 && looksLikePanel(page)) {
    const alt = build([wholePageBlock(page)], recoverableLines(page));
    if (withAmount(alt.rows) > withAmount(got.rows)) { got = alt; usedRecovery = true; }
  }
  // A unit the recogniser got wrong is a thousandfold error that parses
  // cleanly, so it is caught here by the one thing on the label that can
  // prove it: the printed percentage.
  const repaired = repairUnits(got.rows);
  const linked = repaired.rows;
  const excluded = got.excluded;

  // Bonus: the fillers paragraph, which lives OUTSIDE the panel box by law.
  const otherLines = otherIngredientLines(page);
  const joined = otherLines
    .map((l, i) => (i === 0 ? l.text.replace(/^OTHER INGREDIENTS:?/i, '') : l.text).trim())
    .filter((t) => t.length > 0)
    .join(' ');
  const otherIngredients = joined.length > 0 ? joined : null;

  return {
    found: true, recovered: usedRecovery,
    unitCorrections: repaired.corrections,
    separators: describeSeparators(seps, useSeps),
    servingSize, servingsPerContainer,
    blockCount: usedRecovery ? 1 : blocks.length, rows: linked, otherIngredients, excludedLines: excluded,
  };
}
