// Classification for EVERYTHING THAT IS NOT THE SUPPLEMENT FACTS PANEL.
//
// WHY A SECOND RULE SET. The panel is a table whose every word is fixed by
// 21 CFR 101.36, which is what makes it readable by rule. The rest of the
// packaging is the opposite: it is marketing, written freely, and its job is
// to persuade. There is no column geometry to lean on and no mandated
// wording for most of it.
//
// But not none. Four things on the front ARE regulated, and they are the
// anchors this file is built on:
//   - "Dietary Supplement", the statement of identity          21 CFR 101.3(g)
//   - the net quantity of contents                             21 CFR 101.105
//   - the "has not been evaluated by the FDA" disclaimer       21 CFR 101.93(b)
//   - the defined nutrient content terms, e.g. "excellent
//     source of", which mean something specific and measurable 21 CFR 101.54
//
// Everything else is claimed on shape alone and labelled as such.
//
// ON BENEFIT CLAIMS. This file finds them and quotes them. It does not
// evaluate them, rank them, or repeat them as fact. A supplement may make a
// "structure/function" claim ("supports immune health") only if it also
// carries the FDA disclaimer; it may NOT claim to treat, cure or prevent a
// disease. So the useful, honest thing the app can do is: show the maker's
// words verbatim, say which category the wording falls into, and report
// whether the disclaimer the law pairs with it is actually present. That is
// a statement about the LABEL, never about the product or anyone's health.

import { cachedPack } from './classifyCache';
import { squash, tidy } from './labelTextNormalize';

export type PackTag =
  | 'statement-of-identity'
  | 'net-quantity'
  | 'fda-disclaimer'
  | 'nutrient-content-claim'
  | 'structure-function-claim'
  | 'disease-claim'
  | 'certification'
  | 'directions'
  | 'warning'
  | 'allergen'
  | 'storage'
  | 'dosage-form'
  | 'flavour'
  | 'origin'
  | 'contact'
  | 'batch'
  | 'free-from'
  | 'unclassified';

export type PackBasis = 'regulated-wording' | 'defined-term' | 'shape' | 'none';

export interface PackClassification {
  tag: PackTag;
  rule: string;
  basis: PackBasis;
  evidence: string | null;
  why: string;
}

interface Ctx { sq: string; td: string; raw: string }

interface PackRule {
  rule: string;
  tag: PackTag;
  basis: PackBasis;
  why: string;
  match: (ctx: Ctx) => string | null;
}

const first = (re: RegExp, s: string): string | null => {
  const m = re.exec(s);
  return m === null ? null : m[0];
};

/** The disclaimer, which labels print with wildly varying line breaks. */
const DISCLAIMER_KEYS = [
  'NOTBEENEVALUATEDBYTHEFOODANDDRUGADMINISTRATION',
  'NOTBEENEVALUATEDBYTHEFDA',
  'NOTINTENDEDTODIAGNOSETREATCUREORPREVENTANYDISEASE',
  'NOTINTENDEDTODIAGNOSE',
];

const CERTS: readonly [RegExp, string][] = [
  [/\bUSP\s*(VERIFIED)?\b/, 'USP'],
  [/\bNSF\b/, 'NSF'],
  [/NON[- ]?GMO/, 'Non-GMO'],
  [/\bUSDA\b.*ORGANIC|ORGANIC\b.*\bUSDA\b/, 'USDA Organic'],
  [/CERTIFIED ORGANIC/, 'Certified organic'],
  [/GLUTEN[- ]?FREE/, 'Gluten free'],
  [/CERTIFIED VEGAN/, 'Certified Vegan'],
  [/\bKOSHER\b/, 'Kosher'],
  [/\bHALAL\b/, 'Halal'],
  [/\bC?GMP\b/, 'GMP facility'],
  [/THIRD[- ]?PARTY TESTED|3RD[- ]?PARTY TESTED/, 'Third-party tested'],
  [/INFORMED[- ]?(SPORT|CHOICE)/, 'Informed Sport'],
];

/** Verbs that make a structure/function claim. Not a judgement, a grammar. */
const SF = new RegExp(
  '\\b(SUPPORTS?|SUPPORTING|PROMOTES?|HELPS? (TO )?(MAINTAIN|SUPPORT|PROMOTE)'
  + '|HELPS?\\b|MAINTAINS?|CONTRIBUTES? TO|AIDS?\\b|BOOSTS?|ENHANCES?'
  + '|IMPROVES?|BUILDS?|REPLENISHES?|NOURISHES?|FUELS?|RESTORES?)\\b',
);

/** Wording that crosses from a permitted claim into a drug claim. */
const DISEASE = new RegExp(
  '\\b(TREATS?|TREATING|CURES?|PREVENTS?|PREVENTING|HEALS?'
  + '|REDUCES? THE RISK OF|REDUCES? RISK OF|PROTECTS? AGAINST'
  + '|FIGHTS? (OFF )?(DISEASE|INFECTION|CANCER)|REVERSES?'
  + '|ALLEVIATES?|RELIEVES?|REMEDY FOR|THERAPY FOR)\\b',
);

/** Defined terms with a legal threshold behind them. */
const NCC = new RegExp(
  '\\b(EXCELLENT SOURCE OF|GOOD SOURCE OF|HIGH IN|RICH IN|MORE THAN \\d+% OF'
  + '|\\d+% OF (THE|YOUR) DAILY VALUE|FORTIFIED WITH|ENRICHED WITH'
  + '|LOW SODIUM|SUGAR[- ]?FREE|FAT[- ]?FREE|CALORIE[- ]?FREE)\\b',
);

// "90 Vegetarian Capsules", "120 Easy-Swallow Tablets": the count and the dose
// form are routinely separated by a descriptor, so allow up to two words
// between them. Without this the whole statement goes unmatched.
const NET_QTY = new RegExp(
  '\\b\\d+\\s*(?:[A-Z][A-Z-]*\\s+){0,2}(TABLETS?|CAPSULES?|SOFTGELS?|GUMMIES|GUMMY'
  + '|CAPLETS?|LOZENGES?|PACKETS?|SACHETS?|SERVINGS?|COUNT|CT|OZ|FL OZ|G|KG|ML|L)\\b',
);

const FORM = new RegExp(
  '\\b(TABLETS?|CAPSULES?|SOFTGELS?|GUMMIES|GUMMY|CAPLETS?|LOZENGES?|POWDER'
  + '|LIQUID|DROPS?|CHEWABLES?|EFFERVESCENT|SPRAY|SUBLINGUAL)\\b',
);

export const PACK_RULES: readonly PackRule[] = [
  {
    rule: 'fda-disclaimer',
    tag: 'fda-disclaimer',
    basis: 'regulated-wording',
    why: 'The exact disclaimer 21 CFR 101.93(b) requires on any label that '
      + 'makes a structure/function claim. Finding it is how the app can say '
      + 'whether the claims printed here carry the statement the law pairs '
      + 'them with. Matched on fragments because labels break it across lines.',
    match: ({ sq }) => DISCLAIMER_KEYS.find((k) => sq.includes(k)) ?? null,
  },
  {
    rule: 'statement-of-identity',
    tag: 'statement-of-identity',
    basis: 'regulated-wording',
    why: '21 CFR 101.3(g) requires the words "dietary supplement" on the front. '
      + 'It is the single most reliable confirmation that this photograph is a '
      + 'supplement at all, rather than a food or a medicine.',
    match: ({ sq }) => (sq.includes('DIETARYSUPPLEMENT') ? 'Dietary Supplement' : null),
  },
  {
    rule: 'net-quantity',
    tag: 'net-quantity',
    basis: 'regulated-wording',
    why: '21 CFR 101.105 requires the quantity of contents on the front panel. '
      + 'The match must cover much of the line, so the directions "take 2 '
      + 'capsules daily" are not read as the size of the bottle.',
    match: ({ td }) => {
      const m = NET_QTY.exec(td);
      return m !== null && m[0].length >= td.length * 0.45 ? m[0] : null;
    },
  },
  {
    rule: 'allergen',
    tag: 'allergen',
    basis: 'regulated-wording',
    why: 'The Food Allergen Labeling Act requires a "Contains" statement for '
      + 'the major allergens, and shared-facility warnings follow a set form. '
      + 'The most safety-relevant text on the whole package.',
    match: ({ td }) => first(
      /\b(CONTAINS|ALLERGEN|MANUFACTURED (IN|ON) (A|SHARED)|PROCESSED IN A FACILITY|MAY CONTAIN)\b/, td),
  },
  {
    rule: 'warning',
    tag: 'warning',
    basis: 'regulated-wording',
    why: 'Set phrases that appear on supplement labels by convention and, for '
      + 'iron-containing products, by requirement. Kept separate from '
      + 'directions because the two must never be shown merged.',
    match: ({ td }) => first(
      /\b(WARNING|CAUTION|KEEP OUT OF (THE )?REACH|DO NOT USE IF|CONSULT (YOUR|A) (PHYSICIAN|DOCTOR|HEALTHCARE)|IF (YOU ARE )?PREGNANT|NURSING|ACCIDENTAL OVERDOSE|DISCONTINUE USE)\b/, td),
  },
  {
    rule: 'directions',
    tag: 'directions',
    basis: 'regulated-wording',
    why: 'How the maker says to take it. Needed to make sense of the panel at '
      + 'all, because every amount in it is "per serving" and this is what '
      + 'defines a serving in practice.',
    match: ({ td }) => first(
      /\b(SUGGESTED USE|DIRECTIONS|RECOMMENDED USE|HOW TO USE|AS A DIETARY SUPPLEMENT|TAKE \d|ADULTS,? TAKE)\b/, td),
  },
  {
    rule: 'nutrient-content-claim',
    tag: 'nutrient-content-claim',
    basis: 'defined-term',
    why: 'These phrases are not marketing adjectives — 21 CFR 101.54 attaches a '
      + 'measurable threshold to each one. "Excellent source" means at least '
      + '20% of the Daily Value per serving, so the claim can be checked '
      + 'against the panel rather than taken on trust.',
    match: ({ td }) => first(NCC, td),
  },
  {
    rule: 'certification',
    tag: 'certification',
    basis: 'defined-term',
    why: 'Marks belonging to a named certifier or standards body. Each one is '
      + 'a specific audited scheme rather than a free-text adjective, so the '
      + 'presence of the mark is checkable.',
    match: ({ td }) => {
      for (const [re, name] of CERTS) if (re.test(td)) return name;
      return null;
    },
  },
  {
    rule: 'disease-claim',
    tag: 'disease-claim',
    basis: 'shape',
    why: 'Wording of this kind claims an effect on a disease. A dietary '
      + 'supplement may not make that claim; only an approved drug may. Worth '
      + 'surfacing for exactly that reason — it is a fact about what the '
      + 'packaging says, and the app draws no conclusion about the product.',
    match: ({ td }) => first(DISEASE, td),
  },
  {
    rule: 'structure-function-claim',
    tag: 'structure-function-claim',
    basis: 'shape',
    why: 'A claim about an effect on the body’s structure or function, '
      + 'recognised by its verb rather than its subject. Permitted, but only '
      + 'alongside the FDA disclaimer — which is why both are detected.',
    match: ({ td }) => first(SF, td),
  },
  {
    rule: 'free-from',
    tag: 'free-from',
    basis: 'shape',
    why: 'A statement about what is NOT in it. Kept apart from certifications '
      + 'because nobody audits it: "Certified Vegan" is a scheme with a '
      + 'certifier behind it, a bare "Vegetarian" printed on a bottle is the '
      + 'manufacturer\u2019s own word for it.',
    match: ({ td }) => first(
      /\b(NO ARTIFICIAL|FREE OF|FREE FROM|WITHOUT ARTIFICIAL|NO ADDED|PRESERVATIVE[- ]?FREE|DAIRY[- ]?FREE|SOY[- ]?FREE|NUT[- ]?FREE|VEGAN|VEGETARIAN)\b/, td),
  },
  {
    rule: 'storage',
    tag: 'storage',
    basis: 'shape',
    why: 'Storage and tamper-evidence notes. Claimed so they stop competing '
      + 'with the product name for attention, since they often print large.',
    match: ({ td }) => first(
      /\b(STORE (IN|AT)|KEEP (IN A|TIGHTLY)|DO NOT USE IF (SEAL|SAFETY)|PROTECT FROM (LIGHT|HEAT)|REFRIGERATE)\b/, td),
  },
  {
    rule: 'origin',
    tag: 'origin',
    basis: 'shape',
    why: 'Where it was made. Set phrasing, and useful context when a product '
      + 'cannot be found in a US database.',
    match: ({ td }) => first(
      /\b(MADE IN|PRODUCT OF|MANUFACTURED IN|ASSEMBLED IN|IMPORTED (BY|FROM))\b/, td),
  },
  {
    rule: 'contact',
    tag: 'contact',
    basis: 'shape',
    why: 'A website, phone number or address. Identifies the responsible '
      + 'company when the regulated "Distributed by" line is not in frame.',
    match: ({ td, raw }) => first(/WWW\.[A-Z0-9.-]+|[A-Z0-9-]+\.(COM|NET|ORG)\b/, td)
      ?? first(/\b1?[-\s]?\d{3}[-\s]\d{3}[-\s]\d{4}\b/, raw),
  },
  {
    rule: 'batch',
    tag: 'batch',
    basis: 'shape',
    why: 'Lot and expiry stamps. Printed, not part of the artwork, and often '
      + 'the largest text in frame — so claiming them keeps them out of the '
      + 'running for the product name.',
    match: ({ td }) => first(
      /\b(LOT|BATCH|EXP|EXPIRES?|BEST (BEFORE|BY)|USE BY|MFG)\b\.?:?/, td),
  },
  {
    rule: 'flavour',
    tag: 'flavour',
    basis: 'shape',
    why: 'Flavour and sweetener wording. Not a benefit, and not part of the '
      + 'name, though it is usually printed as though it were both.',
    match: ({ td }) => first(
      /\b([A-Z ]{3,20} FLAVou?RED?|NATURAL(LY)? FLAVou?R|ARTIFICIAL(LY)? FLAVou?R|UNFLAVOU?RED)\b/, td),
  },
  {
    rule: 'dosage-form',
    tag: 'dosage-form',
    basis: 'shape',
    why: 'What physical form it comes in. Weakest rule in the set and last on '
      + 'purpose: the same words appear inside directions, warnings and the '
      + 'net quantity, all of which are matched before this is reached.',
    match: ({ td }) => first(FORM, td),
  },
];

const UNCLAIMED: PackClassification = {
  tag: 'unclassified',
  rule: 'none',
  basis: 'none',
  evidence: null,
  why: 'No rule claimed this line. On the front of a package that is common '
    + 'and expected — the product name itself lands here, because a name is '
    + 'whatever the maker chose and matches no pattern. Typography finds it '
    + 'instead.',
};

/** Same override cache as the content classifier, for the same reason. */
export function classifyPackLine(raw: string): PackClassification {
  const cached = cachedPack(raw);
  if (cached !== undefined) return cached;
  const ctx: Ctx = { sq: squash(raw), td: tidy(raw), raw };
  for (const r of PACK_RULES) {
    const evidence = r.match(ctx);
    if (evidence !== null) {
      return { tag: r.tag, rule: r.rule, basis: r.basis, evidence, why: r.why };
    }
  }
  return UNCLAIMED;
}

export const packTag = (raw: string): PackTag => classifyPackLine(raw).tag;

/** Human wording for each tag, for the screen. */
export const PACK_TAG_LABEL: Readonly<Record<PackTag, string>> = {
  'statement-of-identity': 'Statement of identity',
  'net-quantity': 'Net quantity',
  'fda-disclaimer': 'FDA disclaimer',
  'nutrient-content-claim': 'Nutrient content claim',
  'structure-function-claim': 'Advertised benefit',
  'disease-claim': 'Disease claim',
  certification: 'Certification',
  directions: 'Directions',
  warning: 'Warning',
  allergen: 'Allergen statement',
  storage: 'Storage',
  'dosage-form': 'Form',
  flavour: 'Flavour',
  origin: 'Origin',
  contact: 'Contact',
  batch: 'Lot or expiry',
  'free-from': 'Free-from claim',
  unclassified: 'Unclaimed',
};
