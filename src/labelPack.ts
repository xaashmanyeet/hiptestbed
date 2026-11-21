// Everything the packaging says, assembled from one photograph.
//
// The panel parser answers "what is in it". This answers "what is it, who
// made it, what is it sold as, and what is it allowed to claim" — and it has
// to work when there is no panel in frame at all, because a photograph of the
// front of a bottle is a perfectly reasonable thing to take.
//
// TWO JOBS THE PANEL PARSER CANNOT DO.
//
// 1. Decide whether this is even a supplement. The panel's existence proves
//    it. Without a panel the evidence is weaker and has to be reported as
//    weaker: "Dietary Supplement" printed on the front is near-conclusive
//    (21 CFR 101.3(g) requires it), a certification mark plus a dose form is
//    suggestive, and a photograph of a shelf is neither.
//
// 2. Find the product name. There is no rule for a name — a name is whatever
//    the maker chose, and it matches no pattern by definition. What is
//    reliable is TYPOGRAPHY: it is the largest text on the front. So the name
//    is found by elimination — classify everything that CAN be claimed by a
//    rule, then take the biggest thing left standing.
//
// ON CLAIMS. They are quoted, categorised by the grammar of the wording, and
// paired with whether the FDA disclaimer the law requires alongside them is
// present. Nothing here evaluates whether a claim is true, and nothing
// ranks products by them.

import type { OcrBox, OcrLine, OcrPage } from './labelOcr';
import { contentTag } from './labelLineClassification';
import { linkClaimToIngredients, themeFor, type ClaimLink, type ClaimTheme } from './claimThemes';
import { splitIdentity, type Provenance } from './packIdentity';
import { blockFor, findColumnBlocks } from './labelPanelLayout';
import { otherIngredientLines } from './labelPanelParse';
import {
  classifyPackLine, type PackClassification, type PackTag,
} from './labelPackClassification';

export interface PackLine {
  text: string;
  box: OcrBox;
  insidePanel: boolean;
  c: PackClassification;
}

export interface PackClaim {
  /** The maker's wording, verbatim. Never rewritten. */
  text: string;
  kind: 'benefit' | 'nutrient-content' | 'disease';
  /** The substring that put it in that category. */
  trigger: string;
  /**
   * What the claim is about. A filing label on the maker's own words —
   * it says nothing about whether the claim is true, and the app still
   * evaluates nothing.
   */
  theme: ClaimTheme;
  /** The words that placed it in that theme, so the tag is auditable. */
  themeMatched: string[];
  /**
   * Nutrients the claim names that the panel also lists.
   *
   * Descriptive: "this claim mentions Vitamin C and the panel contains
   * Vitamin C". Not a statement that one produces the other.
   */
  mentions: ClaimLink[];
}

/** How sure we are this photograph is of a dietary supplement. */
export type SupplementVerdict = 'confirmed' | 'likely' | 'unclear' | 'not-a-supplement';

export interface PackReading {
  verdict: SupplementVerdict;
  /** Plain-language reasons for the verdict, strongest first. */
  evidence: string[];

  title: string | null;
  /** How the title was arrived at, since it is never from a rule. */
  titleBasis: string;
  brand: string | null;

  /* --- added: the title taken apart, all optional and additive --- */
  /** The name with strength, count, form, variant and audience removed. */
  productName?: string | null;
  /** "Extra Strength", "High Potency". */
  variant?: string | null;
  /** Men, Women, Children, Prenatal, 50+, Seniors. */
  targetGroup?: string | null;
  /** A dose printed on the front as a selling point, not a panel amount. */
  headlineStrength?: string | null;
  /** Why each of the above says what it says. */
  identityBasis?: {
    productName: Provenance;
    variant: Provenance | null;
    targetGroup: Provenance | null;
    headlineStrength: Provenance | null;
    removed: string[];
  };

  statementOfIdentity: string | null;
  netQuantity: string | null;
  dosageForm: string | null;
  flavour: string | null;

  /** Advertised benefits, in the maker's own words. */
  claims: PackClaim[];
  disclaimerPresent: boolean;
  disclaimerText: string | null;

  certifications: string[];
  directions: string[];
  warnings: string[];
  allergens: string[];
  freeFrom: string[];
  storage: string[];
  origin: string[];
  contact: string[];
  batch: string[];

  lines: PackLine[];
  /** Lines outside the panel that a rule claimed. */
  claimed: number;
  /** Lines outside the panel altogether. */
  outsidePanel: number;
  panelPresent: boolean;
}

const clean = (s: string): string =>
  s.replace(/[®™©]/g, '').replace(/\s{2,}/g, ' ').trim();

/** Prose, a stamp, or a fragment — none of which is a product name. */
function couldBeName(l: OcrLine, text: string): boolean {
  if (text.length < 3) return false;
  // Rotated text gets a tall narrow box and would win on height alone.
  if (l.box.h > l.box.w) return false;
  if (text.split(/\s+/).length > 6) return false;
  if (/[,;:]$/.test(text)) return false;
  if (/^[a-z]/.test(text)) return false;
  if (text.includes('%')) return false;
  if (/^[\d\s.\-/]+$/.test(text)) return false;
  return true;
}

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)];

/**
 * Everything the packaging says, panel or no panel.
 *
 * `ingredientNames` are the rows the panel parser already produced, passed
 * in rather than re-parsed here: it avoids parsing the same page twice and
 * keeps this module from depending on the parser. Omitted, claims simply
 * carry no ingredient links, which is what a front-only photograph should
 * produce anyway.
 */
export function readPack(
  page: OcrPage, ingredientNames: readonly string[] = [],
): PackReading {
  const blocks = findColumnBlocks(page);
  const panelPresent = blocks.length > 0;
  const fillers = new Set(otherIngredientLines(page).map((l) => l.text));

  const lines: PackLine[] = page.lines.map((l) => ({
    text: l.text,
    box: l.box,
    insidePanel: blockFor(l.box, blocks) !== null,
    c: classifyPackLine(l.text),
  }));

  // Only consider text outside the ingredient tables. Inside them, the panel
  // parser is authoritative and these rules would double-claim its rows.
  const outside = lines.filter((l) => !l.insidePanel);
  const pick = (tag: PackTag): PackLine[] => outside.filter((l) => l.c.tag === tag);
  const texts = (tag: PackTag): string[] =>
    uniq(pick(tag).map((l) => clean(l.text)).filter((t) => t.length > 0));

  /* ---------------------------------------------------------- the name --- */

  const nameCandidates = page.lines
    .filter((l) => {
      if (blockFor(l.box, blocks) !== null) return false;
      if (fillers.has(l.text)) return false;
      // Anything a rule could claim is, by definition, not the name.
      if (classifyPackLine(l.text).tag !== 'unclassified') return false;
      if (contentTag(l.text) !== 'unclassified') return false;
      return couldBeName(l, clean(l.text));
    })
    .sort((a, b) => b.box.h - a.box.h);

  const title = nameCandidates[0] === undefined ? null : clean(nameCandidates[0].text);
  const titleBasis = title === null
    ? 'Nothing on this photograph looked like a product name. Every large line '
      + 'was claimed by a rule, was printed sideways, or reads as a sentence.'
    : `Largest text that no rule could claim, ${
        (nameCandidates[0]!.box.h * 100).toFixed(1)}% of the image tall`
      + `${nameCandidates.length > 1 ? `, ahead of ${nameCandidates.length - 1} other candidates` : ''}.`;

  /* --------------------------------------------------------- the brand --- */

  let brand: string | null = null;
  for (const l of page.lines) {
    if (contentTag(l.text) !== 'manufacturer') continue;
    const cut = clean(l.text.replace(
      /^.*?(distributed by|manufactured (for|by)|packed by|made (for|by))[:\s]*/i, ''));
    const head = cut.split(/[,|]/)[0]?.trim() ?? '';
    if (head.length > 0) { brand = head; break; }
  }
  if (brand === null) {
    const web = texts('contact').find((t) => /\./.test(t));
    if (web !== undefined) {
      brand = web.replace(/^WWW\./i, '').replace(/\.(com|net|org).*$/i, '');
    }
  }
  if (brand === null && nameCandidates.length > 1) {
    brand = clean(nameCandidates[1]!.text);
  }

  /* --------------------------------------------------------- the claims --- */

  // The verbatim text, the existing kind, and now a theme and any
  // ingredients the claim names. The wording is never altered and the
  // disease-claim category is exactly as before.
  const panelNames = ingredientNames;
  const withTheme = (text: string, kind: PackClaim['kind'], trigger: string): PackClaim => {
    const t = themeFor(text);
    return {
      text, kind, trigger,
      theme: t.theme,
      themeMatched: t.matched,
      mentions: linkClaimToIngredients(text, panelNames),
    };
  };

  const claims: PackClaim[] = [
    ...pick('structure-function-claim').map((l) =>
      withTheme(clean(l.text), 'benefit', l.c.evidence ?? '')),
    ...pick('nutrient-content-claim').map((l) =>
      withTheme(clean(l.text), 'nutrient-content', l.c.evidence ?? '')),
    ...pick('disease-claim').map((l) =>
      withTheme(clean(l.text), 'disease', l.c.evidence ?? '')),
  ];

  // The title taken apart. Runs on the title the reader already chose plus
  // the other lines outside the panel, because an audience is often printed
  // on its own line rather than inside the name.
  // Only lines that could plausibly BE identity. A warning is not a
  // product name and must not be mined for one: searching every line for an
  // audience found "children" inside the mandatory iron warning and
  // labelled an adult multivitamin as a children's product. The tags that
  // say what each line is have already been computed, so use them rather
  // than guessing from shape.
  const IDENTITY_OK = new Set(['unclassified', 'statement-of-identity', 'flavour']);
  //
  // Tags alone were not enough: "fatal poisoning in children" is a fragment
  // of the wrapped iron warning that no rule claims, and it put an adult
  // multivitamin in the Children category. The signal that actually
  // separates identity from small print is TYPE SIZE — a product's audience
  // is printed large, beside the name, and warning text never is.
  const tallest = Math.max(0, ...outside.map((l) => l.box.h));
  const identityLines = outside
    .filter((l) => IDENTITY_OK.has(l.c.tag))
    .filter((l) => {
      const t = contentTag(l.text);
      return t === 'unclassified' || t === 'strength' || t === 'count';
    })
    .filter((l) => tallest > 0 && l.box.h >= tallest * 0.6);
  const split = splitIdentity(title, identityLines.map((l) => ({
    text: l.text, confidence: null, box: l.box, words: [],
  })));

  const disclaimerLines = pick('fda-disclaimer');
  const disclaimerPresent = disclaimerLines.length > 0;
  const disclaimerText = disclaimerLines.length === 0
    ? null
    : disclaimerLines.map((l) => clean(l.text)).join(' ');

  const statementOfIdentity = texts('statement-of-identity')[0] ?? null;
  const certifications = texts('certification')
    .map((t) => pick('certification').find((l) => clean(l.text) === t)?.c.evidence ?? t);

  /* -------------------------------------------------------- the verdict --- */

  const evidence: string[] = [];
  let verdict: SupplementVerdict;

  if (panelPresent) {
    evidence.push('A Supplement Facts panel is in frame, with both regulated column headings.');
  }
  if (statementOfIdentity !== null) {
    evidence.push('The words "Dietary Supplement" are printed on it, which 21 CFR 101.3(g) requires.');
  }
  if (disclaimerPresent) {
    evidence.push('The FDA disclaimer required alongside a benefit claim is present.');
  }

  if (panelPresent || statementOfIdentity !== null) {
    verdict = 'confirmed';
  } else {
    // No regulated proof. Count the softer signals.
    const soft: string[] = [];
    if (uniq(certifications).length > 0) {
      soft.push(`Carries ${uniq(certifications).join(', ')}.`);
    }
    if (texts('dosage-form')[0] !== undefined || texts('net-quantity')[0] !== undefined) {
      soft.push('Sold in a dose form and count, the way a supplement is.');
    }
    if (claims.some((c) => c.kind === 'benefit')) {
      soft.push('Makes a structure/function claim, the kind only a supplement or food makes.');
    }
    if (pick('directions').length > 0) {
      soft.push('Carries directions for taking it.');
    }
    evidence.push(...soft);
    verdict = soft.length >= 2 ? 'likely' : soft.length === 1 ? 'unclear' : 'not-a-supplement';
    if (verdict === 'not-a-supplement') {
      evidence.push('Nothing in this photograph identifies it as a supplement. '
        + 'It may be the wrong side of the pack, or not a supplement at all.');
    } else {
      evidence.push('No panel and no "Dietary Supplement" wording in frame, so this '
        + 'is inference from the packaging rather than proof.');
    }
  }

  return {
    verdict,
    evidence,
    title,
    titleBasis,
    brand,
    productName: split.productName,
    variant: split.variant,
    targetGroup: split.targetGroup,
    headlineStrength: split.headlineStrength,
    identityBasis: {
      productName: split.productNameFrom,
      variant: split.variantFrom,
      targetGroup: split.targetGroupFrom,
      headlineStrength: split.headlineStrengthFrom,
      removed: split.removed,
    },
    statementOfIdentity,
    netQuantity: texts('net-quantity')[0] ?? null,
    dosageForm: pick('dosage-form')[0]?.c.evidence ?? null,
    flavour: texts('flavour')[0] ?? null,
    claims,
    disclaimerPresent,
    disclaimerText,
    certifications: uniq(certifications),
    directions: texts('directions'),
    warnings: texts('warning'),
    allergens: texts('allergen'),
    freeFrom: texts('free-from'),
    storage: texts('storage'),
    origin: texts('origin'),
    contact: texts('contact'),
    batch: texts('batch'),
    lines,
    claimed: outside.filter((l) => l.c.tag !== 'unclassified').length,
    outsidePanel: outside.length,
    panelPresent,
  };
}

/**
 * Merge pack readings from several photographs. Same principle as the panel
 * merge: the photograph framed for the front owns the name, lists are unioned
 * because a warning seen on one side is still a warning, and the strongest
 * verdict wins because evidence does not stop being evidence.
 */
const RANK: Readonly<Record<SupplementVerdict, number>> = {
  confirmed: 3, likely: 2, unclear: 1, 'not-a-supplement': 0,
};

export function mergePacks(packs: readonly PackReading[]): PackReading {
  if (packs.length === 0) throw new Error('mergePacks needs at least one reading');
  if (packs.length === 1) return packs[0]!;

  const best = [...packs].sort((a, b) => RANK[b.verdict] - RANK[a.verdict])[0]!;
  const withTitle = packs.find((p) => p.title !== null);
  const cat = (f: (p: PackReading) => readonly string[]): string[] =>
    uniq(packs.flatMap((p) => f(p)));

  return {
    verdict: best.verdict,
    evidence: cat((p) => p.evidence),
    title: withTitle?.title ?? null,
    titleBasis: withTitle?.titleBasis ?? best.titleBasis,
    brand: packs.find((p) => p.brand !== null)?.brand ?? null,
    productName: packs.find((p) => (p.productName ?? null) !== null)?.productName ?? null,
    variant: packs.find((p) => (p.variant ?? null) !== null)?.variant ?? null,
    targetGroup: packs.find((p) => (p.targetGroup ?? null) !== null)?.targetGroup ?? null,
    headlineStrength:
      packs.find((p) => (p.headlineStrength ?? null) !== null)?.headlineStrength ?? null,
    identityBasis: packs.find((p) => p.identityBasis !== undefined)?.identityBasis,
    statementOfIdentity: packs.find((p) => p.statementOfIdentity !== null)?.statementOfIdentity ?? null,
    netQuantity: packs.find((p) => p.netQuantity !== null)?.netQuantity ?? null,
    dosageForm: packs.find((p) => p.dosageForm !== null)?.dosageForm ?? null,
    flavour: packs.find((p) => p.flavour !== null)?.flavour ?? null,
    claims: packs.flatMap((p) => p.claims)
      .filter((c, i, a) => a.findIndex((x) => x.text === c.text) === i),
    disclaimerPresent: packs.some((p) => p.disclaimerPresent),
    disclaimerText: packs.find((p) => p.disclaimerText !== null)?.disclaimerText ?? null,
    certifications: cat((p) => p.certifications),
    directions: cat((p) => p.directions),
    warnings: cat((p) => p.warnings),
    allergens: cat((p) => p.allergens),
    freeFrom: cat((p) => p.freeFrom),
    storage: cat((p) => p.storage),
    origin: cat((p) => p.origin),
    contact: cat((p) => p.contact),
    batch: cat((p) => p.batch),
    lines: packs.flatMap((p) => p.lines),
    claimed: packs.reduce((n, p) => n + p.claimed, 0),
    outsidePanel: packs.reduce((n, p) => n + p.outsidePanel, 0),
    panelPresent: packs.some((p) => p.panelPresent),
  };
}

/**
 * A one-paragraph description assembled ONLY from fields read off the label.
 * No generated prose: every clause is something the packaging actually says,
 * so there is nothing here for the app to be wrong about beyond the reading
 * itself.
 */
export function describe(pack: PackReading, rowCount: number): string {
  const bits: string[] = [];
  const name = pack.title ?? 'This product';
  const maker = pack.brand === null ? '' : ` from ${pack.brand}`;
  const form = pack.dosageForm === null ? '' : ` ${pack.dosageForm.toLowerCase()}`;

  bits.push(pack.statementOfIdentity !== null
    ? `${name}${maker} is labelled a dietary supplement${form === '' ? '' : `, sold as${form}`}.`
    : `${name}${maker}${form === '' ? '' : `, sold as${form}`}.`);

  if (pack.netQuantity !== null) bits.push(`The pack states ${pack.netQuantity.toLowerCase()}.`);
  if (rowCount > 0) bits.push(`${rowCount} ingredients were read from its Supplement Facts panel.`);
  if (pack.certifications.length > 0) bits.push(`It carries ${pack.certifications.join(', ')}.`);
  if (pack.flavour !== null) bits.push(`Flavour: ${pack.flavour.toLowerCase()}.`);

  const benefits = pack.claims.filter((c) => c.kind === 'benefit').length;
  if (benefits > 0) {
    bits.push(`${benefits} advertised benefit${benefits === 1 ? ' is' : 's are'} printed on it`
      + `${pack.disclaimerPresent
        ? ', alongside the FDA disclaimer the law requires.'
        : ' — but the FDA disclaimer that must accompany them is not in frame.'}`);
  }
  return bits.join(' ');
}
