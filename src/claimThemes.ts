// Sorting the manufacturer's own claims by what they are about.
//
// The pack already quotes every advertised benefit verbatim and flags the
// ones that stray into disease claims. What it does not do is say what a
// claim is ABOUT, so "supports immune health" and "helps maintain strong
// bones" sit in one undifferentiated list.
//
// WHERE THE LINE IS, because this is health copy and the line matters.
// Grouping someone's own words by topic is description. Saying the product
// achieves any of it would be endorsement, and nothing here does that: no
// theme implies efficacy, no claim is rewritten, the verbatim text is never
// touched, and the existing disease-claim flagging and FDA-disclaimer check
// are untouched. A theme is a filing label, nothing more.
//
// The linkage below is the same kind of thing. When a claim mentions a
// nutrient that the panel also lists, the two are associated so the screen
// can show the claim beside the ingredient actually present. That is a
// statement about what is printed on the label, not about what it does.

import { normaliseIngredient } from './labelTextNormalize';

export type ClaimTheme =
  | 'immune' | 'energy' | 'bone-joint' | 'heart' | 'sleep' | 'digestion'
  | 'cognition' | 'skin-hair-nails' | 'stress' | 'muscle' | 'eye' | 'other';

export const THEME_LABEL: Readonly<Record<ClaimTheme, string>> = {
  immune: 'Immune',
  energy: 'Energy',
  'bone-joint': 'Bone and joint',
  heart: 'Heart',
  sleep: 'Sleep',
  digestion: 'Digestion',
  cognition: 'Cognition',
  'skin-hair-nails': 'Skin, hair and nails',
  stress: 'Stress and mood',
  muscle: 'Muscle',
  eye: 'Eye',
  other: 'Other',
};

/**
 * Words that place a claim in a theme.
 *
 * Plurals are spelled out rather than assumed: "\bBONE\b" does not match
 * "strong bones", which is how half of all bone claims are actually worded.
 *
 * Order matters only for ties; the theme with the most matched words wins,
 * and anything that matches nothing is `other` rather than forced into the
 * nearest bucket. A wrong theme is worse than no theme.
 */
const THEMES: readonly (readonly [ClaimTheme, RegExp])[] = [
  ['immune', /\b(IMMUNE|IMMUNITY|DEFENC?SES?|ANTIOXIDANTS?|FREE RADICALS?)\b/gi],
  ['energy', /\b(ENERGY|METABOLIS[MT]|VITALITY|FATIGUE|CONVERTS? FOOD)\b/gi],
  ['bone-joint', /\b(BONES?|JOINTS?|CARTILAGE|SKELETAL|CALCIUM ABSORPTION|MOBILITY|FLEXIBILITY)\b/gi],
  ['heart', /\b(HEARTS?|CARDIO\w*|CIRCULATION|BLOOD PRESSURE|CHOLESTEROL|VASCULAR)\b/gi],
  ['sleep', /\b(SLEEP|RESTFUL|RELAXATION|CALM|MELATONIN|NIGHT)\b/gi],
  ['digestion', /\b(DIGEST\w*|GUT|PROBIOTIC|PREBIOTIC|BLOAT\w*|REGULARITY|MICROBIOME)\b/gi],
  ['cognition', /\b(BRAINS?|COGNIT\w*|MEMORY|FOCUS|CONCENTRATION|MENTAL|CLARITY|NERVES?)\b/gi],
  ['skin-hair-nails', /\b(SKIN|HAIR|NAILS?|COLLAGEN|COMPLEXION|ELASTICITY)\b/gi],
  ['stress', /\b(STRESS|MOOD|ANXI\w*|ADAPTOGEN|WELL ?BEING|EMOTIONAL)\b/gi],
  ['muscle', /\b(MUSCLES?|STRENGTH|RECOVERY|PROTEIN SYNTHESIS|LEAN MASS|ENDURANCE)\b/gi],
  ['eye', /\b(EYES?|VISION|MACULAR|RETINA|SIGHT|BLUE LIGHT)\b/gi],
];

export interface ThemedClaim {
  theme: ClaimTheme;
  /** The words in the claim that placed it there, so the tag is auditable. */
  matched: string[];
}

/**
 * Which theme a claim belongs to.
 *
 * The claim text itself is never modified — only read.
 */
export function themeFor(claimText: string): ThemedClaim {
  let best: ClaimTheme = 'other';
  let bestHits: string[] = [];

  for (const [theme, re] of THEMES) {
    re.lastIndex = 0;
    const hits = [...claimText.matchAll(re)].map((m) => m[0]);
    if (hits.length > bestHits.length) {
      best = theme;
      bestHits = hits;
    }
  }
  return { theme: best, matched: [...new Set(bestHits.map((h) => h.toLowerCase()))] };
}

/* ------------------------------------------------- claim to ingredient --- */

export interface ClaimLink {
  /** The ingredient as the panel prints it. */
  ingredient: string;
  /** The words in the claim that named it. */
  mentionedAs: string;
}

/**
 * Nutrients a claim names that the panel also lists.
 *
 * Descriptive only: this says "the claim mentions Vitamin C and the panel
 * contains Vitamin C", which is a fact about the printing. It says nothing
 * about whether the one causes the other, and the screen must not either.
 */
export function linkClaimToIngredients(
  claimText: string, ingredientNames: readonly string[],
): ClaimLink[] {
  const claim = ` ${normaliseIngredient(claimText)} `;
  const out: ClaimLink[] = [];
  const seen = new Set<string>();

  for (const raw of ingredientNames) {
    const norm = normaliseIngredient(raw);
    if (norm.length < 4 || seen.has(norm)) continue;
    // Whole-word containment, so "iron" does not match "environment" and
    // "zinc" does not match a longer word that happens to contain it.
    if (!claim.includes(` ${norm} `)) {
      // Also try the first word, since a panel prints "Vitamin C (as
      // Ascorbic Acid)" where a claim just says "Vitamin C".
      const head = norm.split(' ').slice(0, 2).join(' ');
      if (head.length < 4 || !claim.includes(` ${head} `)) continue;
      seen.add(norm);
      out.push({ ingredient: raw, mentionedAs: head });
      continue;
    }
    seen.add(norm);
    out.push({ ingredient: raw, mentionedAs: norm });
  }
  return out;
}
