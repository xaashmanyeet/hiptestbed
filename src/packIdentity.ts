// Taking the front of a pack apart into the things it actually says.
//
// A front-of-pack photograph currently produces one run-on title. "One A Day
// Men's 50+ Multi 65 Tablets" is read as the product's name, when it is in
// fact a brand, a target group, a name, and a count — four separate facts
// printed together because that is how packaging is designed, not because
// they are one string.
//
// Keeping them fused costs real things. The database search is handed a
// query with a tablet count in it. The Label tab has a "Who this is for"
// section that has always been empty from a photograph, because nothing
// ever extracted a target group. And a name with "Extra Strength" welded on
// will not match the same product without it.
//
// NOTHING HERE ASSERTS ANYTHING. Every field records which signal produced
// it and how much that signal is worth, in the same spirit as the existing
// `titleBasis`. A reading that cannot say why it believes something has no
// business being shown as fact.

import type { OcrLine } from './labelOcr';

/** Where a field came from, so nothing is asserted without a reason. */
export interface Provenance {
  basis: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface SplitIdentity {
  /** The name with the other four facts removed. */
  productName: string | null;
  productNameFrom: Provenance;
  /** "Extra Strength", "High Potency". */
  variant: string | null;
  variantFrom: Provenance | null;
  /** Men, Women, Kids, Prenatal, 50+. */
  targetGroup: string | null;
  targetGroupFrom: Provenance | null;
  /** A dose printed on the front as a selling point — "1000 mg". */
  headlineStrength: string | null;
  headlineStrengthFrom: Provenance | null;
  /** What was taken out of the title, so the removal is auditable. */
  removed: string[];
}

/* -------------------------------------------------------------- vocabulary */

const VARIANTS = [
  'extra strength', 'maximum strength', 'max strength', 'high potency',
  'advanced', 'complete', 'original', 'plus', 'max', 'ultra', 'premium',
  'timed release', 'extended release', 'slow release', 'rapid release',
  'chewable', 'sugar free', 'once daily', 'one daily',
] as const;

/**
 * Who the product is sold for.
 *
 * Deliberately a short, concrete list. "Men's" and "Women's" are on half the
 * multivitamins in a shop and "Prenatal" is a genuine clinical distinction;
 * inventing finer categories from packaging adjectives would be reading
 * meaning into marketing.
 */
const TARGETS: readonly (readonly [RegExp, string])[] = [
  [/\bPRENATAL\b/i, 'Prenatal'],
  [/\b(MEN'?S?|FOR MEN)\b/i, 'Men'],
  [/\b(WOMEN'?S?|FOR WOMEN)\b/i, 'Women'],
  [/\b(KIDS?|CHILDREN'?S?|TODDLER)\b/i, 'Children'],
  [/\bTEENS?\b/i, 'Teens'],
  [/\b(\d{2})\s*\+/, '50+'],
  [/\b(SENIOR|MATURE|ADULTS? 50)\b/i, 'Seniors'],
];

/** A dose printed large on the front, not a panel amount. */
const HEADLINE = /\b(\d{1,5}(?:[.,]\d+)?)\s*(MG|MCG|G|IU|BILLION|CFU)\b/i;

/** Counts and forms — they have their own fields and do not belong in a name. */
const COUNT_FORM = new RegExp(
  '\\b\\d{1,4}\\s*(TABLETS?|CAPSULES?|SOFTGELS?|GUMMIES|GUMMIE?S?|CAPLETS?'
  + '|LOZENGES?|PACKETS?|SERVINGS?|COUNT|CT|SCOOPS?|CHEWS?)\\b', 'i');

const BARE_FORM = new RegExp(
  '\\b(TABLETS?|CAPSULES?|SOFTGELS?|GUMMIES|CAPLETS?|LOZENGES?|POWDER|LIQUID'
  + '|CHEWABLES?|MULTIVITAMIN/MULTIMINERAL SUPPLEMENT|DIETARY SUPPLEMENT)\\b', 'i');

const tidy = (s: string): string =>
  s.replace(/[®™©]/g, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s,·|-]+|[\s,·|-]+$/g, '').trim();

/* ----------------------------------------------------------------- the work */

/**
 * Pull the separable facts out of a title.
 *
 * Works on the title the existing reader already chose, plus the other
 * front-of-pack lines, because a target group is often printed on its own
 * line above or below the name rather than inside it.
 */
export function splitIdentity(
  title: string | null, frontLines: readonly OcrLine[],
): SplitIdentity {
  const none: Provenance = { basis: 'nothing on the pack said', confidence: 'low' };
  const removed: string[] = [];
  let rest = title === null ? '' : tidy(title);

  // ONLY NAME-LIKE TEXT. Searching every line on the pack for an audience
  // found "Children" in "Keep out of reach of children" — the mandatory
  // iron warning, on a product for adults. A target group is printed as
  // part of the product's identity, in short text near the name, not
  // buried in a safety sentence, so the search is restricted to lines that
  // could plausibly be identity. Getting this wrong mislabels who a
  // product is for, which is worse than leaving the field empty.
  const haystack = [title ?? '', ...frontLines
    .map((l) => l.text)
    .filter((t) => t.split(/\s+/).length <= 7 && !/[.;]/.test(t))]
    .join(' \u0000 ');

  /* --- variant --- */
  let variant: string | null = null;
  let variantFrom: Provenance | null = null;
  for (const v of VARIANTS) {
    const re = new RegExp(`\\b${v.replace(/ /g, '\\s+')}\\b`, 'i');
    const inTitle = re.exec(rest);
    if (inTitle !== null) {
      variant = tidy(inTitle[0]);
      variantFrom = { basis: `printed in the product name as "${variant}"`, confidence: 'high' };
      rest = tidy(rest.replace(re, ' '));
      removed.push(variant);
      break;
    }
    const anywhere = re.exec(haystack);
    if (anywhere !== null && variant === null) {
      variant = tidy(anywhere[0]);
      variantFrom = { basis: `printed on the pack as "${variant}"`, confidence: 'medium' };
      break;
    }
  }

  /* --- target group --- */
  let targetGroup: string | null = null;
  let targetGroupFrom: Provenance | null = null;
  for (const [re, label] of TARGETS) {
    const inTitle = re.exec(rest);
    if (inTitle !== null) {
      targetGroup = label;
      targetGroupFrom = {
        basis: `the name says "${tidy(inTitle[0])}"`, confidence: 'high',
      };
      rest = tidy(rest.replace(re, ' '));
      removed.push(tidy(inTitle[0]));
      break;
    }
  }
  if (targetGroup === null) {
    for (const [re, label] of TARGETS) {
      const anywhere = re.exec(haystack);
      if (anywhere === null) continue;
      targetGroup = label;
      targetGroupFrom = {
        basis: `the pack says "${tidy(anywhere[0])}" elsewhere on the front`,
        confidence: 'medium',
      };
      break;
    }
  }

  /* --- headline strength --- */
  let headlineStrength: string | null = null;
  let headlineStrengthFrom: Provenance | null = null;
  const strengthInTitle = HEADLINE.exec(rest);
  if (strengthInTitle !== null) {
    headlineStrength = tidy(strengthInTitle[0]);
    headlineStrengthFrom = {
      basis: 'printed in the product name as a selling point, not read from the panel',
      confidence: 'high',
    };
    rest = tidy(rest.replace(HEADLINE, ' '));
    removed.push(headlineStrength);
  }

  /* --- counts and bare dose forms, which have their own fields --- */
  const count = COUNT_FORM.exec(rest);
  if (count !== null) {
    removed.push(tidy(count[0]));
    rest = tidy(rest.replace(COUNT_FORM, ' '));
  }
  const form = BARE_FORM.exec(rest);
  if (form !== null && tidy(rest.replace(BARE_FORM, ' ')).length >= 3) {
    removed.push(tidy(form[0]));
    rest = tidy(rest.replace(BARE_FORM, ' '));
  }

  const productName = rest.length >= 2 ? rest : title;
  return {
    productName,
    productNameFrom: title === null
      ? none
      : removed.length === 0
        ? { basis: 'the whole title, with nothing separable in it', confidence: 'medium' }
        : {
            basis: `the title with ${removed.length} separable `
                 + `${removed.length === 1 ? 'fact' : 'facts'} removed: ${removed.join(', ')}`,
            confidence: 'medium',
          },
    variant,
    variantFrom,
    targetGroup,
    targetGroupFrom,
    headlineStrength,
    headlineStrengthFrom,
    removed,
  };
}
