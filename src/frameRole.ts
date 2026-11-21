// What is this photograph OF?
//
// Every capture is some mixture of two things: the Supplement Facts panel,
// which carries the ingredient table, and the front of the pack, which
// carries the name and the brand. They are read by different code and they
// answer different questions, so getting this wrong costs a whole reading.
//
// The earlier version asked one question — did findColumnBlocks find a table
// — and fell back to "panel" otherwise. That is right far more often than it
// is wrong, but it is blind in exactly the cases that matter: a panel whose
// headings did not survive the photograph looks identical to a front of
// pack, and a front of pack carrying a marketing table looks like a panel.
//
// So this weighs several signals instead and SAYS WHY. The reason matters as
// much as the verdict: the person testing the app can see that a photograph
// was called a front because nothing numeric was found, disagree, and
// override it, which is far better than silently guessing at them.

import { contentTag } from './labelLineClassification';
import type { OcrPage } from './labelOcr';
import { findColumnBlocks } from './labelPanelLayout';
import { looksLikePanel } from './labelPanelRecover';

export type FrameRole = 'panel' | 'front';

export interface RoleVerdict {
  role: FrameRole;
  /** 'certain' only when something the law fixes settles it. */
  confidence: 'certain' | 'likely' | 'guess';
  /** Shown next to the photograph, so a wrong call is visible and fixable. */
  why: string;
}

const AMOUNT = /\b\d+(?:[.,]\d+)?\s*(MCG|MG|G|IU|ML|UG)\b/;
const PCT = /\b\d{1,4}\s*%/;
const up = (s: string): string => s.toUpperCase();

/** How tall is the biggest line, as a fraction of the photograph? */
function largestText(page: OcrPage): number {
  let h = 0;
  for (const l of page.lines) h = Math.max(h, l.box.h);
  return h;
}

export function detectRole(page: OcrPage): RoleVerdict {
  if (page.lines.length === 0) {
    // Nothing to go on. Call it a panel, because the panel path extracts
    // strictly more and will simply find nothing, whereas calling it a front
    // would throw away a table if one is faintly there.
    return { role: 'panel', confidence: 'guess', why: 'nothing legible in this photograph' };
  }

  /* ---- things the law fixes, which settle it outright ---- */

  const anchor = page.lines.some((l) => contentTag(l.text) === 'panel-anchor');
  if (anchor) {
    return {
      role: 'panel', confidence: 'certain',
      why: 'carries the "Supplement Facts" heading, which 21 CFR 101.36 requires above the panel',
    };
  }

  const blocks = findColumnBlocks(page).length;
  if (blocks > 0) {
    return {
      role: 'panel', confidence: 'certain',
      why: `${blocks} ingredient table${blocks === 1 ? '' : 's'} found by their column headings`,
    };
  }

  /* ---- the shape of a panel, without its headings ---- */

  let amounts = 0;
  let pcts = 0;
  let serving = false;
  for (const l of page.lines) {
    const t = up(l.text);
    if (AMOUNT.test(t)) amounts++;
    if (PCT.test(t)) pcts++;
    const tag = contentTag(l.text);
    if (tag === 'serving-size' || tag === 'servings-per-container') serving = true;
  }

  if (looksLikePanel(page)) {
    return {
      role: 'panel', confidence: 'likely',
      why: `${amounts} lines carry an amount with a unit`
         + (pcts > 0 ? ` and ${pcts} carry a percentage` : '')
         + ', which is the shape of a panel even though no heading was read',
    };
  }
  if (serving) {
    return {
      role: 'panel', confidence: 'likely',
      why: 'states a serving size, which belongs with the panel',
    };
  }

  /* ---- the shape of a front of pack ---- */

  const big = largestText(page);
  // A front of pack is dominated by the product name. 3.5% of the frame
  // height is large type by the standards of a label photographed close up.
  if (big >= 0.035 && amounts <= 1) {
    return {
      role: 'front', confidence: 'likely',
      why: `the largest text is ${(big * 100).toFixed(1)}% of the frame and almost nothing `
         + 'is numeric, which is how the front of a pack reads',
    };
  }

  if (amounts === 0 && pcts === 0) {
    return {
      role: 'front', confidence: 'guess',
      why: 'no amounts, units or percentages anywhere, so this is not a panel',
    };
  }

  return {
    role: 'panel', confidence: 'guess',
    why: `only ${amounts} amount${amounts === 1 ? '' : 's'} found — read as a panel anyway, `
       + 'since that path extracts more and costs nothing when it is wrong',
  };
}

/** Short label for the chip on each frame. */
export const roleLabel = (r: FrameRole): string => (r === 'panel' ? 'Label' : 'Front');
