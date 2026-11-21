// Who made it and what it is called.
//
// None of this is printed in a regulated place, so unlike the panel there is
// no exact wording to anchor on. What there IS, reliably, is TYPOGRAPHY: the
// product name is the largest text on the front, and the regulated
// "Distributed by" line names the company. Both are read from geometry and
// both are treated as LOW confidence — they are used to build a search query,
// never asserted as fact.

import type { OcrLine, OcrPage } from './labelOcr';
import { contentTag } from './labelLineClassification';
import { blockFor, findColumnBlocks } from './labelPanelLayout';
import { otherIngredientLines } from './labelPanelParse';

export interface LabelIdentity {
  productName: string | null;
  brand: string | null;
  /** Everything we could plausibly search on, largest text first. */
  nameCandidates: string[];
  printedCodes: string[];
}

const JUNK = new RegExp(
  '^(dietary supplement|supplement facts|gluten free|new|item|made in|www\\.|\\d+$'
  // Regulated notices that are not the product's name, however large they print.
  + '|allergen warning|warning|caution|keep out of reach|these statements'
  + '|manufactured (for|by)|distributed by|percent daily values'
  // Batch stamps print large and are not words, so font size alone loves them.
  + '|exp\\b|exp\\.|lot\\b|lot ?:|best (before|by)|use by)',
  'i',
);

/**
 * Is this a piece of a SENTENCE rather than a name?
 *
 * The fillers paragraph, the warnings and the directions are all prose, and a
 * recogniser hands them over one printed line at a time — so a four-word
 * fragment like "2% of Croscarmellose Sodium," arrives looking structurally
 * identical to a four-word product name. These three tests are what a person
 * uses without thinking: a product name does not trail off in a comma, does
 * not begin mid-sentence in lower case, and does not contain a percentage.
 */
function isProseFragment(t: string): boolean {
  if (/[,;:]$/.test(t)) return true;
  if (/^[a-z]/.test(t)) return true;
  if (t.includes('%')) return true;
  return false;
}

function clean(s: string): string {
  return s.replace(/[®™©]/g, '').replace(/\s{2,}/g, ' ').trim();
}

export function readIdentity(page: OcrPage): LabelIdentity {
  const blocks = findColumnBlocks(page);
  // The fillers paragraph is outside the panel box by law, so it reaches this
  // function looking like front-of-label text. Rule it out by identity, not
  // by guessing from its wording.
  const fillers = new Set(otherIngredientLines(page).map((l) => l.text));

  // Front-of-label text: outside every ingredient table, and not panel wording.
  const front: OcrLine[] = page.lines.filter((l) => {
    if (blockFor(l.box, blocks) !== null) return false;
    const tag = contentTag(l.text);
    if (tag !== 'unclassified' && tag !== 'count') return false;
    if (fillers.has(l.text)) return false;
    const t = clean(l.text);
    if (t.length < 3 || JUNK.test(t)) return false;
    if (isProseFragment(t)) return false;
    // Reject text printed SIDEWAYS. Allergen and legal notices are routinely
    // set vertically up the edge of a wrap-around label; rotated text gets a
    // tall, narrow box, so on height alone it beats the real product name.
    if (l.box.h > l.box.w) return false;
    // A product name is a name, not a paragraph. The vertical notices that
    // survive the test above are long; real names are a few words.
    if (t.split(/\s+/).length > 6) return false;
    return true;
  });

  // Typography does the work: biggest text wins.
  const bySize = [...front].sort((a, b) => b.box.h - a.box.h);
  const nameCandidates = bySize
    .slice(0, 6)
    .map((l) => clean(l.text))
    .filter((t) => t.length >= 3);

  const productName = nameCandidates[0] ?? null;

  // The regulated company line beats any guess from font size.
  let brand: string | null = null;
  for (const l of page.lines) {
    if (contentTag(l.text) !== 'manufacturer') continue;
    brand = clean(l.text.replace(/^.*?(distributed by|manufactured (for|by)|packed by|made (for|by))[:\s]*/i, ''))
      .split(/[,|]/)[0]!
      .trim();
    if (brand.length > 0) break;
  }
  // Failing that, the second-largest line near the top is usually the brand.
  if (brand === null || brand.length === 0) {
    const near = bySize.find((l) => clean(l.text) !== productName && l.box.y < 0.4);
    brand = near !== undefined ? clean(near.text) : null;
  }

  const printedCodes = page.lines
    .filter((l) => { const t = contentTag(l.text); return t === 'gtin' || t === 'ndc'; })
    .map((l) => l.text.replace(/\D/g, ''))
    .filter((t) => t.length >= 8);

  return { productName, brand, nameCandidates, printedCodes };
}

/**
 * At most two queries, brand-and-name then name-only. Never an open-ended
 * search: every query costs a round trip and a vague one degrades quietly.
 */
export function searchQueries(id: LabelIdentity): string[] {
  const out: string[] = [];
  if (id.brand !== null && id.productName !== null) out.push(`${id.brand} ${id.productName}`);
  if (id.productName !== null) out.push(id.productName);
  else if (id.brand !== null) out.push(id.brand);
  return [...new Set(out)].slice(0, 2);
}
