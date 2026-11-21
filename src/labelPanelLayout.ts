// PASS 2a: find the COLUMN BLOCKS before doing anything with rows.
//
// WHY THIS EXISTS. A multivitamin panel is often printed as two
// side-by-side tables. On the Nature Made test label, "Vitamin A 750 mcg"
// and "Biotin 30 mcg" sit at the SAME height but belong to different
// tables. Grouping by vertical position alone fuses them into nonsense.
//
// A block is defined by its own pair of column headers:
//     "Amount Per Serving"  ... "% Daily Value"
// The DV header's RIGHT edge is where percentages end — they are
// right-aligned to it, exactly, which makes it a reliable anchor.
//
// The LEFT edge is NOT the amount header's left edge. "Amount Per Serving"
// is a heading over the AMOUNT column, which sits well to the right of the
// ingredient names. Using it as the boundary silently excluded every name
// on any label where the heading is right-aligned over its numbers --
// amounts and percentages survived, names vanished.
//
// Instead: the first block starts at the panel's own left edge, which the
// regulated lines ("Supplement Facts", "Serving Size") mark by law, and
// each later block starts where the previous one's DV column ended.
//
// Anything outside every block is not panel content. That one rule also
// excludes the warnings column and the "Other ingredients" paragraph,
// which on this label sit to the RIGHT of the panel rather than below it.

import { contentTag } from './labelLineClassification';
import type { OcrBox, OcrLine, OcrPage } from './labelOcr';
import { right } from './labelOcr';
import { preparePage } from './labelPanelRecover';

export interface ColumnBlock {
  /** Left edge of this block's ingredient-name column. */
  nameX: number;
  /** Left edge of the amount heading, i.e. roughly where numbers begin. */
  amountX: number;
  /** Right edge of this block's % Daily Value column. */
  dvRight: number;
  /** Top of the header row; panel rows start below it. */
  top: number;
}

const PAD = 0.02;

export function findColumnBlocks(input: OcrPage): ColumnBlock[] {
  // A narrow carton prints "Amount Per / Serving" on two lines, and the
  // heading rules want one. Joining those back up before looking is the
  // difference between finding this table and declaring the photograph
  // panel-free. On a label with ordinary headings this is a no-op.
  const page = preparePage(input);
  const amounts: OcrLine[] = [];
  const dvs: OcrLine[] = [];
  for (const line of page.lines) {
    const tag = contentTag(line.text);
    if (tag === 'amount-header') amounts.push(line);
    if (tag === 'dv-header') dvs.push(line);
  }

  // The panel's own left edge, from lines whose wording the law fixes and
  // which are printed flush with it.
  let panelLeft: number | null = null;
  for (const line of page.lines) {
    const tag = contentTag(line.text);
    if (tag !== 'panel-anchor' && tag !== 'serving-size'
        && tag !== 'servings-per-container') continue;
    panelLeft = panelLeft === null ? line.box.x : Math.min(panelLeft, line.box.x);
  }

  const paired: { amountX: number; dvRight: number; top: number }[] = [];
  for (const a of amounts) {
    const partner = dvs
      .filter((d) => Math.abs(d.box.y - a.box.y) < Math.max(a.box.h, d.box.h) * 1.5
                  && d.box.x > a.box.x)
      .sort((p, q) => p.box.x - q.box.x)[0];
    if (partner === undefined) continue;
    paired.push({ amountX: a.box.x, dvRight: right(partner.box), top: a.box.y });
  }
  paired.sort((p, q) => p.amountX - q.amountX);

  const blocks: ColumnBlock[] = [];
  paired.forEach((b, i) => {
    const prev = i > 0 ? paired[i - 1] : undefined;
    // Left edge: for the first table the panel's own edge; for a table to the
    // right of another, wherever that one's percentages stopped.
    const left = prev !== undefined
      ? prev.dvRight + PAD
      : (panelLeft !== null ? Math.min(panelLeft, b.amountX) : b.amountX);
    blocks.push({ nameX: left, amountX: b.amountX, dvRight: b.dvRight, top: b.top });
  });
  return blocks;
}

/** Which block does this box live in? null means "not panel content". */
export function blockFor(box: OcrBox, blocks: readonly ColumnBlock[]): number | null {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b === undefined) continue;
    if (box.y > b.top && box.x >= b.nameX - PAD && right(box) <= b.dvRight + PAD) return i;
  }
  return null;
}
