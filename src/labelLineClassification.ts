// PASS 1 of classification: look at a line's TEXT only. No geometry.
//
// Ordered rules, first match wins. Reading the list top to bottom tells
// you exactly why any line got the tag it got. No scoring, no model.
//
// A line that no rule claims gets 'unclassified' and KEEPS that tag.
// It is never quietly assigned to the nearest plausible field.
//
// Every rule carries its own explanation and reports the exact substring
// that triggered it. That is the point of this file's shape: a tag you
// cannot audit is a tag you cannot trust, and on a label that feeds health
// data the difference between "matched the regulated wording" and "looked
// a bit like a number" has to survive all the way to the screen.

import { cachedContent } from './classifyCache';
import { levenshtein, squash, tidy } from './labelTextNormalize';

export type LineTag =
  | 'panel-anchor'
  | 'serving-size'
  | 'servings-per-container'
  | 'amount-header'
  | 'dv-header'
  | 'footnote'
  | 'other-ingredients-header'
  | 'ndc'
  | 'gtin'
  | 'count'
  | 'strength'
  | 'manufacturer'
  /* --- added after the originals; see the note above the rules below --- */
  /** A bare "83%" on its own line: a Daily Value cell the recogniser split off. */
  | 'dv-percent'
  /** "(as Cholecalciferol)" — the chemical form, continuing the row above. */
  | 'ingredient-form'
  /** An inactive ingredient: binder, filler, coating, colour. */
  | 'excipient'
  /** "Store in a cool, dry place." */
  | 'storage'
  /** The tamper-evidence sentence 21 CFR 211.132 requires. */
  | 'tamper-seal'
  /** A safety warning or caution. */
  | 'warning'
  /** Allergen wording — "Contains milk", "made in a facility with nuts". */
  | 'allergen'
  /** A lot number or an expiry date. */
  | 'batch'
  /** An address, phone number or website. */
  | 'contact'
  /** "Suggested use: take one tablet daily." */
  | 'directions'
  /** A third-party verification mark — USP, NSF, Informed Sport. */
  | 'certification'
  | 'unclassified';

/** How much the rule's match is worth believing. */
export type Basis =
  /** Wording fixed by federal regulation. The strongest signal on a label. */
  | 'regulated-wording'
  /** A code format defined by a standards body. Shape alone is conclusive. */
  | 'standard-code'
  /** A general shape, e.g. a number next to a unit. Suggestive, not proof. */
  | 'shape'
  /** No rule claimed it. */
  | 'none';

export interface Classification {
  tag: LineTag;
  /** Stable id of the rule that fired, for display and for tests. */
  rule: string;
  basis: Basis;
  /** The exact text that triggered the match, or null when nothing did. */
  evidence: string | null;
  /** Why this rule is allowed to claim a line. Written for a reader. */
  why: string;
}

interface Ctx {
  /** Uppercased, whitespace removed. Survives OCR spacing errors. */
  sq: string;
  /** Uppercased, whitespace collapsed. Keeps word boundaries. */
  td: string;
}

interface Rule {
  rule: string;
  tag: LineTag;
  basis: Basis;
  why: string;
  /** Returns the matched substring, or null. */
  match: (ctx: Ctx) => string | null;
}

const ANCHORS = ['SUPPLEMENTFACTS', 'DRUGFACTS', 'NUTRITIONFACTS'] as const;

/**
 * Inactive ingredients, by name.
 *
 * A list rather than a pattern because excipients have no shared shape —
 * "Silicon Dioxide" and "Croscarmellose Sodium" look like nothing in common.
 * These are the ones that actually appear on supplement labels; the list is
 * meant to grow as real labels show up in testing.
 */
const EXCIPIENTS = new RegExp(
  '\\b('
  + 'MICROCRYSTALLINE CELLULOSE|CELLULOSE GEL|HYPROMELLOSE|METHYLCELLULOSE'
  + '|CROSCARMELLOSE|MAGNESIUM STEARATE|STEARIC ACID|SILICON DIOXIDE|SILICA'
  + '|TITANIUM DIOXIDE|POLYETHYLENE GLYCOL|POLYSORBATE|MALTODEXTRIN'
  + '|MODIFIED FOOD STARCH|DICALCIUM PHOSPHATE|CALCIUM SILICATE'
  + '|VEGETABLE (STEARATE|MAGNESIUM STEARATE|GLYCERIN)|GLYCERIN|SORBITOL'
  + '|CARNAUBA WAX|SHELLAC|GELATIN|SOY LECITHIN|LECITHIN|XANTHAN GUM'
  + '|CITRIC ACID|MALIC ACID|SUCRALOSE|STEVIA|NATURAL FLAVOR|ARTIFICIAL FLAVOR'
  + '|FD&C|ANNATTO|CARMINE|BEET (JUICE|POWDER)|RICE FLOUR|CELLULOSE'
  + ')\\b');
const NDC = /\b\d{4,5}-\d{3,4}-\d{1,2}\b/;
const GTIN = /\b\d{12,14}\b/;
const COUNT = /\b\d+\s*(TABLETS?|CAPSULES?|SOFTGELS?|GUMMIES|CAPLETS?|LOZENGES?|COUNT|CT)\b/;
const STRENGTH = /\b\d+(?:[.,]\d+)?\s*(MCG|MG|G|IU|ML|UG)\b/;
const MAKER = /(DISTRIBUTED BY|MANUFACTURED (FOR|BY)|PACKED BY|MADE (FOR|BY))/;

const prefix = (sq: string, p: string): string | null =>
  sq.startsWith(p) ? p : null;

const firstMatch = (re: RegExp, s: string): string | null => {
  const m = re.exec(s);
  return m === null ? null : m[0];
};

// Order is the algorithm. Regulated wording is checked before any general
// shape, so "Serving Size 2 tablets" is a serving size and not a pack count.
export const RULES: readonly Rule[] = [
  {
    rule: 'panel-anchor',
    tag: 'panel-anchor',
    basis: 'regulated-wording',
    why: '21 CFR 101.36 requires this exact heading above the panel. Matched '
      + 'with a tolerance of 2 characters so a single misread letter still counts.',
    match: ({ sq }) => {
      for (const a of ANCHORS) if (levenshtein(sq, a) <= 2) return a;
      return null;
    },
  },
  {
    rule: 'serving-size',
    tag: 'serving-size',
    basis: 'regulated-wording',
    why: 'Mandated wording. Everything in the panel is "per serving", so this '
      + 'line is what every amount below it is measured against.',
    match: ({ sq }) => prefix(sq, 'SERVINGSIZE'),
  },
  {
    rule: 'servings-per-container',
    tag: 'servings-per-container',
    basis: 'regulated-wording',
    why: 'Mandated wording. Combined with serving size it gives how long a '
      + 'bottle lasts.',
    match: ({ sq }) => prefix(sq, 'SERVINGSPERCONTAINER'),
  },
  {
    rule: 'amount-header',
    tag: 'amount-header',
    basis: 'regulated-wording',
    why: 'Mandated column heading. Finding it locates the left-hand number '
      + 'column — and on a two-table label, there is one of these per table.',
    match: ({ td }) => (/^AMOUNT PER SERVING/.test(td) ? 'Amount Per Serving' : null),
  },
  {
    rule: 'dv-header',
    tag: 'dv-header',
    basis: 'regulated-wording',
    why: 'Mandated column heading. Pairing it with the amount header defines '
      + 'one table’s left and right edge.',
    match: ({ td }) => firstMatch(/^%\s*(DAILY VALUE|DV)\b/, td),
  },
  {
    rule: 'footnote',
    tag: 'footnote',
    basis: 'regulated-wording',
    why: 'The asterisk and the phrase "Daily Value not established" are both '
      + 'regulated. This marks the bottom of the panel.',
    match: ({ sq, td }) => td.startsWith('*')
      ? '*'
      : (sq.includes('DAILYVALUENOTESTABLISHED') ? 'Daily Value not established' : null),
  },
  {
    rule: 'other-ingredients-header',
    tag: 'other-ingredients-header',
    basis: 'regulated-wording',
    why: 'Marks the boundary between nutrients and non-nutrient contents '
      + '(binders, colours, allergens). Everything after it is not a nutrient.',
    match: ({ sq }) => prefix(sq, 'OTHERINGREDIENTS') ?? prefix(sq, 'INACTIVEINGREDIENTS'),
  },
  {
    rule: 'ndc',
    tag: 'ndc',
    basis: 'standard-code',
    why: 'National Drug Code. Its digit grouping is unique enough that the '
      + 'shape alone identifies it.',
    match: ({ td }) => firstMatch(NDC, td),
  },
  {
    rule: 'gtin',
    tag: 'gtin',
    basis: 'standard-code',
    why: 'The barcode number printed as digits. A 12–14 digit run on a '
      + 'package is a product code.',
    match: ({ td }) => firstMatch(GTIN, td.replace(/\s/g, '')),
  },
  {
    rule: 'count',
    tag: 'count',
    basis: 'shape',
    why: 'How many pills are in the bottle. The match must cover at least half '
      + 'the line — without that, the directions "take 1 tablet daily with '
      + 'water" match on "1 tablet" and get read as the pack size.',
    match: ({ td }) => {
      const m = COUNT.exec(td);
      return m !== null && m[0].length >= td.length * 0.5 ? m[0] : null;
    },
  },
  {
    rule: 'strength',
    tag: 'strength',
    basis: 'shape',
    why: 'A number next to a unit of mass. Weak on its own — it says a '
      + 'quantity is present, not what the quantity is of. Geometry decides that.',
    match: ({ td }) => firstMatch(STRENGTH, td),
  },
  {
    rule: 'manufacturer',
    tag: 'manufacturer',
    basis: 'regulated-wording',
    why: 'A label must name a responsible company using one of these set '
      + 'phrases, so the brand can be read off the line that follows.',
    match: ({ td }) => firstMatch(MAKER, td),
  },

  /* ------------------------------------------------------------------- */
  /* Everything below was added after the rules above, and is appended     */
  /* rather than inserted ON PURPOSE. Rules are tried in order, so a new   */
  /* rule placed here can only ever claim a line that was previously       */
  /* `unclassified`. No line that any original rule already claimed can    */
  /* change its tag, which makes this set strictly additive.               */
  /*                                                                       */
  /* It matters more than it looks: labelPack and labelIdentity both treat */
  /* "a rule claimed this line" as "this line is not the product name", so */
  /* every category added here also stops a shelf tag or a warning being   */
  /* read as the product's name.                                           */
  /* ------------------------------------------------------------------- */
  {
    rule: 'dv-percent',
    tag: 'dv-percent',
    basis: 'shape',
    why: 'A percentage alone on a line. On a Supplement Facts panel the only '
      + 'column that prints a bare percentage is % Daily Value, so a line '
      + 'holding nothing else is a DV cell the recogniser split off its row. '
      + 'Twelve of these were unclaimed on the test label.',
    match: ({ td }) => (/^\d{1,4}\s*%$/.test(td) ? td : null),
  },
  {
    rule: 'ingredient-form',
    tag: 'ingredient-form',
    basis: 'regulated-wording',
    why: '21 CFR 101.36 lets a maker name the chemical form in brackets after '
      + 'the nutrient. Wrapped onto its own line it reads as a fragment, but '
      + 'it belongs to the row above and is never a separate ingredient.',
    match: ({ td }) => (/^\((AS|FROM)\s+.+\)$/.test(td) ? td : null),
  },
  {
    rule: 'tamper-seal',
    tag: 'tamper-seal',
    basis: 'regulated-wording',
    why: '21 CFR 211.132 requires a statement telling the buyer not to use the '
      + 'product if the tamper-evident seal is broken. The wording is close to '
      + 'fixed, which makes it recognisable.',
    match: ({ td }) => firstMatch(
      /DO NOT USE.{0,30}(SEAL|SAFETY SEAL|IMPRINTED SEAL).{0,40}(BROKEN|MISSING|TORN)/, td),
  },
  {
    rule: 'allergen',
    tag: 'allergen',
    basis: 'regulated-wording',
    why: 'The Food Allergen Labeling Act fixes the "Contains" declaration, and '
      + '"made in a facility" is the conventional voluntary form beside it.',
    match: ({ td }) => firstMatch(
      /(CONTAINS?:?\s+(MILK|EGG|FISH|SHELLFISH|CRUSTACEAN|TREE NUTS?|PEANUTS?|WHEAT|SOY|SESAME)|MANUFACTURED IN A FACILITY|MADE IN A FACILITY|PROCESSED IN A FACILITY)/,
      td),
  },
  {
    rule: 'storage',
    tag: 'storage',
    basis: 'shape',
    why: 'Storage directions are not regulated wording, but they are highly '
      + 'conventional and never part of the ingredient table.',
    match: ({ td }) => firstMatch(
      /(STORE (AT|IN|TIGHTLY|BELOW)|KEEP (REFRIGERATED|IN A COOL|TIGHTLY CLOSED)|COOL,? DRY PLACE|PROTECT FROM (LIGHT|HEAT|MOISTURE)|DO NOT REFRIGERATE)/,
      td),
  },
  {
    rule: 'warning',
    tag: 'warning',
    basis: 'regulated-wording',
    why: 'Warnings carry their own heading word by convention and by rule — the '
      + 'iron overdose warning in 21 CFR 101.17(e) is mandatory. Tagging them '
      + 'keeps a safety notice out of the ingredient table and out of the '
      + 'candidates for the product name.',
    match: ({ td }) => firstMatch(
      /^(WARNING|CAUTION|ATTENTION)S?\b|KEEP OUT OF (THE )?REACH OF CHILDREN|ACCIDENTAL OVERDOSE|CONSULT (YOUR|A) (PHYSICIAN|DOCTOR|HEALTH)|IF (YOU ARE )?PREGNANT|POISON CONTROL/,
      td),
  },
  {
    rule: 'batch',
    tag: 'batch',
    basis: 'shape',
    why: 'Lot and expiry are printed per-batch, often by a different machine '
      + 'from the rest of the label, and are never product information.',
    match: ({ td }) => firstMatch(
      /\b(LOT|BATCH|EXP|EXPIRES?|EXPIRY|BEST (BY|BEFORE)|USE BY|MFG|MFD)\b\s*[.:#]?/, td),
  },
  {
    rule: 'contact',
    tag: 'contact',
    basis: 'shape',
    why: 'A website, a phone number or a postal address identifies the company, '
      + 'not the product, and should never be mistaken for its name.',
    match: ({ td }) => firstMatch(
      /(WWW\.[A-Z0-9.-]+|[A-Z0-9-]+\.(COM|ORG|NET|CO\.UK)\b|1-8\d\d-\d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b|\b[A-Z]{2}\s+\d{5}(-\d{4})?\b)/,
      td),
  },
  {
    rule: 'directions',
    tag: 'directions',
    basis: 'regulated-wording',
    why: 'How much to take and when. Conventional wording, and the line most '
      + 'often mistaken for a product name because it sits in large type on '
      + 'the back of a pack.',
    match: ({ td }) => firstMatch(
      /^(SUGGESTED USE|DIRECTIONS|RECOMMENDED USE|HOW TO USE|DOSAGE|ADULTS:)\b|\bTAKE \d+|\b(ONE|TWO|THREE|\d+) (TABLETS?|CAPSULES?|SOFTGELS?|GUMMIES|SCOOPS?) (DAILY|PER DAY|A DAY|EACH DAY)/,
      td),
  },
  {
    rule: 'certification',
    tag: 'certification',
    basis: 'shape',
    why: 'A third-party verification mark. It says something real about how '
      + 'the product was tested, and it is not part of the ingredient table.',
    match: ({ td }) => firstMatch(
      /\b(USP (VERIFIED|HAS TESTED|SETS OFFICIAL)|NSF (CERTIFIED|INTERNATIONAL)|INFORMED[- ](SPORT|CHOICE)|NON[- ]GMO PROJECT|CERTIFIED (ORGANIC|VEGAN|GLUTEN[- ]FREE)|THIRD[- ]PARTY TESTED|GMP CERTIFIED)\b/,
      td),
  },
  {
    rule: 'excipient',
    tag: 'excipient',
    basis: 'shape',
    why: 'The inactive ingredients — binders, fillers, coatings, flow agents. '
      + 'They are real ingredients and worth naming, but they are not what the '
      + 'product is sold for, and the "Other ingredients" paragraph wraps '
      + 'across lines so the heading alone does not catch them.',
    match: ({ td }) => firstMatch(EXCIPIENTS, td),
  },
];

const UNCLAIMED: Classification = {
  tag: 'unclassified',
  rule: 'none',
  basis: 'none',
  evidence: null,
  why: 'No rule claimed this line. It stays unknown rather than being assigned '
    + 'to the nearest plausible field. Storage notes, warnings and addresses '
    + 'land here, and that is the correct outcome for them.',
};

/**
 * The full account: the tag, the rule that produced it, and the proof.
 *
 * Consults the override cache first. That cache holds answers produced by
 * the SAME rules running on the server — the node there is generated from
 * this file — so a hit and a miss are indistinguishable in their output.
 * The only difference is which machine did the work, and that is reported
 * separately rather than being inferable from the result.
 */
export function classifyLine(raw: string): Classification {
  const cached = cachedContent(raw);
  if (cached !== undefined) return cached;
  const ctx: Ctx = { sq: squash(raw), td: tidy(raw) };
  for (const r of RULES) {
    const evidence = r.match(ctx);
    if (evidence !== null) {
      return { tag: r.tag, rule: r.rule, basis: r.basis, evidence, why: r.why };
    }
  }
  return UNCLAIMED;
}

/** The tag alone, for callers that do not need the reasoning. */
export function contentTag(raw: string): LineTag {
  return classifyLine(raw).tag;
}
