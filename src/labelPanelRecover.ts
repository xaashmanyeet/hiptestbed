// Getting a panel out of a photograph that the strict reading gives up on.
//
// WHY THIS EXISTS. A real One A Day carton, photographed square on, perfectly
// legible, 122 lines recognised — and the panel reader returned nothing. The
// recogniser was not at fault and the photograph was not at fault. The column
// headers on that carton are printed STACKED:
//
//     Amount Per      % Daily
//      Serving         Value
//
// Vision returns those as four lines, and the header rules look for
// /^AMOUNT PER SERVING/ and /^% DAILY VALUE/ on a single line. Neither
// matched, so no column block was found, so `parsePanel` returned
// `found: false` with zero rows, and the app had nothing to show for a photo
// anyone can read at a glance. Stacked headings are common — they are what a
// narrow carton does when the column is too thin for the words.
//
// There are two failures there and this module answers both.
//
// 1. STITCH. Lines that are vertically adjacent and horizontally overlapping
//    are tried as one. If "Amount Per" and "Serving" together make a header
//    and neither does alone, they become one line. Nothing else changes.
//
// 2. NEVER RETURN NOTHING. Even with no header at all — a torn label, a
//    cropped photograph, a panel in a language the rules do not cover — the
//    rows are still there on the page and still have the shape of rows. The
//    recovery pass takes the whole page as one block and reads what it can.
//    A row recovered this way is marked as such so nobody mistakes a guess
//    for a reading.
//
// The strict path is unchanged and still runs first. This only ever adds.

import { contentTag } from './labelLineClassification';
import { repairPage } from './labelTextRepair';
import type { OcrBox, OcrLine, OcrPage } from './labelOcr';
import { medianHeight, right } from './labelOcr';
import type { ColumnBlock } from './labelPanelLayout';

/* ------------------------------------------------------------- stitching */

const AMOUNT_HEADER = /^AMOUNT\s*PER\s*SERVING/;
const DV_HEADER = /^%\s*(DAILY\s*VALUE|DV)\b/;
const tidy = (s: string): string => s.toUpperCase().replace(/\s+/g, ' ').trim();

/** Does this text, on its own, already read as a column heading? */
const isHeader = (text: string): boolean => {
  const t = tidy(text);
  return AMOUNT_HEADER.test(t) || DV_HEADER.test(t);
};

const union = (a: OcrBox, b: OcrBox): OcrBox => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(right(a), right(b)) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** Do two boxes share horizontal ground? Stacked words always do. */
function xOverlaps(a: OcrBox, b: OcrBox): boolean {
  const lo = Math.max(a.x, b.x);
  const hi = Math.min(right(a), right(b));
  return hi - lo > Math.min(a.w, b.w) * 0.35;
}

/**
 * Join column headings that the printer wrapped onto two or three lines.
 *
 * Deliberately conservative. A merge happens ONLY when the combined text
 * reads as a heading and the parts do not, so on a label whose headings are
 * printed normally this function returns the page untouched and cannot
 * change any existing behaviour. It will not merge two ingredient rows,
 * because "Vitamin C 120 mg" and "Vitamin D 17.5 mcg" do not combine into
 * anything matching a heading.
 */
export function stitchWrappedHeaders(page: OcrPage): OcrPage {
  const lines = [...page.lines].sort((a, b) => a.box.y - b.box.y);
  const medH = medianHeight(lines);
  const used = new Set<number>();
  const merged = new Map<number, OcrLine>();

  // Candidates are searched for, not taken from the next position in the
  // sort. On a two-table panel both headings are stacked SIDE BY SIDE, so
  // "Amount Per" is followed in y-order by "% Daily", not by its own second
  // line. Looking only at the neighbour finds neither heading.
  const below = (from: OcrLine, fromIdx: number): { line: OcrLine; idx: number } | null => {
    let best: { line: OcrLine; idx: number; dy: number } | null = null;
    for (let j = 0; j < lines.length; j++) {
      if (j === fromIdx || used.has(j)) continue;
      const cand = lines[j];
      if (cand === undefined) continue;
      const gap = cand.box.y - (from.box.y + from.box.h);
      if (gap > medH * 1.2 || gap < -from.box.h * 0.5) continue;
      if (cand.box.y <= from.box.y) continue;
      if (!xOverlaps(from.box, cand.box)) continue;
      if (best === null || gap < best.dy) best = { line: cand, idx: j, dy: gap };
    }
    return best === null ? null : { line: best.line, idx: best.idx };
  };

  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    const a = lines[i];
    if (a === undefined || isHeader(a.text)) continue;

    let acc = a;
    const parts = [i];
    // Up to two more lines, so "Amount" / "Per" / "Serving" also joins.
    for (let k = 0; k < 2; k++) {
      const next = below(acc, parts[parts.length - 1] ?? i);
      if (next === null) break;
      acc = {
        text: `${acc.text} ${next.line.text}`.trim(),
        confidence: acc.confidence,
        box: union(acc.box, next.line.box),
        words: [...acc.words, ...next.line.words],
      };
      parts.push(next.idx);
      if (isHeader(acc.text)) {
        for (const q of parts) used.add(q);
        merged.set(i, acc);
        break;
      }
    }
  }

  if (merged.size === 0) return page;

  const out: OcrLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = merged.get(i);
    if (m !== undefined) { out.push(m); continue; }
    if (used.has(i)) continue;
    const l = lines[i];
    if (l !== undefined) out.push(l);
  }
  return { ...page, lines: out.sort((p2, q) => p2.box.y - q.box.y) };
}

/**
 * Everything that happens to a page before anything tries to understand it:
 * confusable glyphs repaired, wrapped headings rejoined.
 *
 * Applied HERE, at the parse boundary, rather than when the photograph is
 * read. The saved record keeps the recogniser's raw output, which is what
 * makes a failure reproducible months later; the understanding works from
 * the corrected text. Repairing on the way in would quietly rewrite the
 * evidence.
 */
export function preparePage(page: OcrPage): OcrPage {
  return stitchWrappedHeaders(repairPage(page).page);
}

/* ------------------------------------------------------------- recovery */

/** A number with a unit — the thing every ingredient row has. */
const AMOUNT_TOKEN = /\b\d+(?:[.,]\d+)?\s*(MCG|MG|G|IU|ML|UG)\b/;
/** A percentage, which on a panel is the Daily Value column. */
const PCT_TOKEN = /\b\d{1,4}\s*%/;

/**
 * Is this page a Supplement Facts panel even though no header was found?
 *
 * The evidence is the rows themselves. A panel is a column of lines carrying
 * an amount with a unit, and usually a percentage beside it. Three such lines
 * is not a coincidence on a photograph of packaging; one or two could be a
 * net quantity and a serving size.
 */
export function looksLikePanel(page: OcrPage): boolean {
  let amounts = 0;
  let pcts = 0;
  for (const line of page.lines) {
    const t = tidy(line.text);
    if (AMOUNT_TOKEN.test(t)) amounts++;
    if (PCT_TOKEN.test(t)) pcts++;
  }
  return amounts >= 3 || (amounts >= 2 && pcts >= 2);
}

/**
 * One block covering everything on the page.
 *
 * With no headers there is nothing to anchor a real block on, so the fallback
 * is to stop trying to find the table's edges and let the row reader see the
 * whole page. It picks up more than a true block would — a warnings column to
 * the right of the panel will come through as rows with no amounts — and that
 * is the right trade here. A row with no amount is visibly empty and can be
 * ignored by eye; a panel that produced nothing at all cannot be judged.
 *
 * `amountX` is estimated from where the numbers actually are, because the row
 * reader uses it to tell a name from a value.
 */
export function wholePageBlock(page: OcrPage): ColumnBlock {
  let amountX = 1;
  let top = 1;
  for (const line of page.lines) {
    const t = tidy(line.text);
    if (AMOUNT_TOKEN.test(t) || PCT_TOKEN.test(t)) {
      // The leftmost line that carries a number marks roughly where the
      // value columns begin, and the highest one marks the top of the table.
      const words = line.words.filter((w) => /\d/.test(w.text));
      for (const w of words) amountX = Math.min(amountX, w.box.x);
      top = Math.min(top, line.box.y);
    }
  }
  if (amountX >= 1) amountX = 0.5;
  return {
    nameX: 0,
    amountX,
    dvRight: 1,
    // Slightly above the first numeric line, since blockFor wants rows below
    // the block's top edge.
    top: Math.max(0, top - medianHeight(page.lines)),
  };
}

/**
 * Lines worth keeping when recovering without headers.
 *
 * Drops the regulated furniture that is not an ingredient row — the heading,
 * the serving size, the footnote — so the recovered rows are rows.
 */
export function recoverableLines(page: OcrPage): OcrLine[] {
  return page.lines.filter((l) => {
    const tag = contentTag(l.text);
    return tag !== 'panel-anchor' && tag !== 'amount-header' && tag !== 'dv-header'
        && tag !== 'serving-size' && tag !== 'servings-per-container'
        && tag !== 'footnote' && tag !== 'other-ingredients-header';
  });
}
