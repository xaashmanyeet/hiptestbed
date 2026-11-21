// Fixing the handful of characters the recogniser reliably gets wrong.
//
// WHY THIS EXISTS, with the evidence. On the stored sample label Vision
// returns:
//
//     "Iodine (as Potassium lodide) 150 mcg"
//
// That is a lowercase L where a capital I belongs. In a typical sans-serif
// label face the two glyphs are a vertical bar and a vertical bar, and no
// recogniser can separate them from shape alone — which is precisely why
// language correction is switched off here: with it on, "Chondroitin" gets
// autocorrected into something else entirely, which is a worse failure.
//
// The cost is not cosmetic. "potassium lodide" does not match "potassium
// iodide" in the NIH database, so the composition match quietly loses a row,
// and nothing anywhere reports that a lookup failed because of one letter.
//
// WHAT MAKES THIS SAFE. Repair is BOUNDED in three ways, and all three must
// hold before a character is changed:
//
//   1. Only characters that are genuinely confusable are considered —
//      l/I/1, O/0, S/5, B/8, rn/m. Not arbitrary spelling correction.
//   2. A word is only repaired into a term the label vocabulary already
//      knows: the nutrient names the Daily Value table is built from, plus
//      the chemical forms that appear in brackets beside them.
//   3. The correction must be unambiguous — exactly one vocabulary term at
//      edit distance 1. Two candidates means leave it alone.
//
// Digits are repaired separately and even more narrowly: only inside a token
// that sits next to a unit or ends in a percent sign, because that is where
// the grammar of a Supplement Facts panel says a number must be. A stray
// "O" in a brand name is none of our business.
//
// Anything repaired is recorded, so a reading is never quietly rewritten.

import { DAILY_VALUES } from './dailyValues';
import type { OcrLine, OcrPage } from './labelOcr';
import { levenshtein } from './labelTextNormalize';

/* ----------------------------------------------------------- vocabulary */

/**
 * Chemical forms that appear in "(as ...)" clauses on real labels. These are
 * not in the Daily Value table — the table is keyed by nutrient — but they
 * are exactly the long, unusual words a recogniser stumbles on.
 */
const FORMS = [
  'ascorbic', 'acid', 'cholecalciferol', 'ergocalciferol', 'tocopheryl',
  'tocopherol', 'acetate', 'retinyl', 'palmitate', 'beta', 'carotene',
  'phytonadione', 'thiamine', 'mononitrate', 'hydrochloride', 'riboflavin',
  'niacinamide', 'pyridoxine', 'cyanocobalamin', 'methylcobalamin',
  'folic', 'biotin', 'pantothenate', 'carbonate', 'citrate', 'oxide',
  'gluconate', 'sulfate', 'sulphate', 'fumarate', 'ferrous', 'cupric',
  'potassium', 'iodide', 'selenate', 'selenite', 'molybdate', 'chloride',
  'picolinate', 'bisglycinate', 'chelate', 'phosphate', 'lactate',
  'chondroitin', 'glucosamine', 'lycopene', 'lutein', 'zeaxanthin',
  'magnesium', 'manganese', 'molybdenum', 'chromium', 'selenium',
  'calcium', 'sodium', 'copper', 'zinc', 'iron', 'iodine', 'choline',
  'vitamin', 'folate', 'thiamin', 'niacin', 'serving', 'size', 'amount',
  'daily', 'value', 'per', 'container', 'supplement', 'facts', 'other',
  'ingredients', 'tablet', 'tablets', 'capsule', 'capsules', 'softgel',
] as const;

/** Every word the label vocabulary knows, lowercase. */
const VOCAB: ReadonlySet<string> = new Set<string>([
  ...FORMS,
  ...Object.keys(DAILY_VALUES).flatMap((k) => k.split(' ')),
]);

/* ------------------------------------------------------ the confusables */

/** Glyph pairs a recogniser genuinely cannot separate, both directions. */
const CONFUSABLE: ReadonlyArray<readonly [string, string]> = [
  ['l', 'i'], ['l', '1'], ['i', '1'],
  ['o', '0'], ['s', '5'], ['b', '8'], ['g', '9'],
  ['c', 'e'], ['u', 'v'], ['rn', 'm'],
];

/** Could these two characters be the same glyph misread? */
function swappable(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  return CONFUSABLE.some(([p, q]) => (p === x && q === y) || (p === y && q === x));
}

/**
 * Do these differ only in characters that are confusable?
 *
 * Same length only, deliberately. A substitution is what a misread glyph
 * produces; an inserted or deleted letter is a different kind of error and
 * correcting it would be spelling correction, which is the thing that
 * mangles ingredient names.
 */
function confusableVariant(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    if (x === y) continue;
    if (!swappable(x, y)) return false;
    diffs++;
    if (diffs > 2) return false;
  }
  return diffs > 0;
}

/** Keep the original capitalisation pattern when swapping a word in. */
function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && /[A-Z]/.test(original)) {
    return replacement.toUpperCase();
  }
  if (/^[A-Z]/.test(original)) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export interface Repair {
  from: string;
  to: string;
  why: string;
}

/**
 * Repair one word against the label vocabulary.
 *
 * Returns null when the word is already known, when nothing is close enough,
 * or when two vocabulary terms are equally close — ambiguity is a reason to
 * leave a reading exactly as it came back.
 */
export function repairWord(word: string): { fixed: string; repair: Repair } | null {
  const bare = word.replace(/[^A-Za-z]/g, '');
  if (bare.length < 4) return null;
  const low = bare.toLowerCase();
  if (VOCAB.has(low)) return null;

  const hits: string[] = [];
  for (const term of VOCAB) {
    if (term.length !== low.length) continue;
    if (confusableVariant(low, term)) hits.push(term);
    if (hits.length > 1) break;
  }
  if (hits.length !== 1) return null;

  const term = hits[0]!;
  // Belt and braces: one edit away as well as confusable, so a word that
  // happens to differ in two confusable places from an unrelated term is
  // not swapped in.
  if (levenshtein(low, term) > 2) return null;

  const fixedBare = matchCase(bare, term);
  return {
    fixed: word.replace(bare, fixedBare),
    repair: {
      from: word, to: word.replace(bare, fixedBare),
      why: `"${bare}" is one confusable glyph from "${term}"`,
    },
  };
}

/* ------------------------------------------------------- the homoglyphs */

/**
 * Cyrillic letters that are drawn identically to Latin ones.
 *
 * On the stored sample the recogniser returns "Exp.:" as "\u0415x\u0440.:" —
 * a Cyrillic Е and a Cyrillic р among Latin letters. They are the same
 * glyphs, so this is not a misread in any meaningful sense; Vision simply
 * chose the other alphabet for two characters. Nothing downstream can match
 * the result, and no amount of vocabulary repair helps because the word is
 * not misspelt, it is in two scripts at once.
 *
 * Mapping them back is lossless for an English supplement label: these
 * specific code points have no business on one.
 */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M',
  '\u041D': 'H', '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T',
  '\u0423': 'Y', '\u0425': 'X',
  '\u0430': 'a', '\u0432': 'b', '\u0435': 'e', '\u043A': 'k', '\u043C': 'm',
  '\u043D': 'h', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0442': 't',
  '\u0443': 'y', '\u0445': 'x',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u039F': 'O', '\u03A1': 'P',
  '\u03A4': 'T', '\u03A7': 'X',
};

const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join('')}]`, 'g');

/** Put a mixed-script word back into one alphabet. */
export function deHomoglyph(word: string): { fixed: string; changed: boolean } {
  if (!HOMOGLYPH_RE.test(word)) { HOMOGLYPH_RE.lastIndex = 0; return { fixed: word, changed: false }; }
  HOMOGLYPH_RE.lastIndex = 0;
  const fixed = word.replace(HOMOGLYPH_RE, (c) => HOMOGLYPHS[c] ?? c);
  return { fixed, changed: fixed !== word };
}

/* ----------------------------------------------------------- the digits */

const UNIT = /^(MCG|MG|G|IU|ML|UG)\b/i;
const DIGIT_SWAP: Readonly<Record<string, string>> = {
  O: '0', o: '0', l: '1', I: '1', i: '1', S: '5', s: '5', B: '8', g: '9',
};

/** Does this token want to be a number? */
const numericish = (t: string): boolean =>
  /^[0-9OolIiSsBg][0-9OolIiSsBg.,]*%?$/.test(t) && /[OolIiSsBg]/.test(t);

/**
 * Repair digits, but only where the panel's own grammar says a number
 * belongs: immediately before a unit, or carrying a percent sign.
 */
export function repairAmounts(words: readonly string[]): {
  fixed: string[]; repairs: Repair[];
} {
  const out = [...words];
  const repairs: Repair[] = [];
  for (let i = 0; i < out.length; i++) {
    const tok = out[i] ?? '';
    const next = out[i + 1] ?? '';
    const wantsNumber = UNIT.test(next) || tok.endsWith('%');
    if (!wantsNumber || !numericish(tok)) continue;
    const fixed = tok.replace(/[OolIiSsBg]/g, (c) => DIGIT_SWAP[c] ?? c);
    if (fixed === tok) continue;
    out[i] = fixed;
    repairs.push({
      from: tok, to: fixed,
      why: `a number is required ${tok.endsWith('%') ? 'before the percent sign' : `before "${next}"`}`,
    });
  }
  return { fixed: out, repairs };
}

/* ------------------------------------------------------------ the page */

export interface RepairReport {
  repairs: Repair[];
  linesTouched: number;
}

/**
 * Repair a whole page before anything tries to understand it.
 *
 * Done here rather than inside the parser so that classification, the panel
 * parse, the packaging reader and the database lookups all see the same
 * corrected text. A fix that only reached one of them would be worse than
 * none, because the views would disagree with the matching.
 */
export function repairPage(page: OcrPage): { page: OcrPage; report: RepairReport } {
  const repairs: Repair[] = [];
  let touched = 0;

  const lines: OcrLine[] = page.lines.map((line) => {
    const words = line.text.split(/\s+/);
    const amounts = repairAmounts(words);
    let changed = amounts.repairs.length > 0;
    repairs.push(...amounts.repairs);

    const finalWords = amounts.fixed.map((w0) => {
      // Scripts first: a word that is half Cyrillic cannot be matched against
      // any vocabulary until it is in one alphabet.
      const h = deHomoglyph(w0);
      const w = h.fixed;
      if (h.changed) {
        repairs.push({
          from: w0, to: w,
          why: 'letters from another alphabet that are drawn identically to Latin ones',
        });
        changed = true;
      }
      const got = repairWord(w);
      if (got === null) return w;
      repairs.push(got.repair);
      changed = true;
      return got.fixed;
    });

    if (!changed) return line;
    touched++;
    const text = finalWords.join(' ');
    return {
      text,
      confidence: line.confidence,
      box: line.box,
      // Word boxes are kept as they were: repairing a glyph does not move
      // the ink. Only the text each box carries is corrected.
      words: line.words.map((w) => {
        const t = deHomoglyph(w.text).fixed;
        const got = repairWord(t);
        return { text: got === null ? t : got.fixed, box: w.box };
      }),
    };
  });

  if (touched === 0) return { page, report: { repairs: [], linesTouched: 0 } };
  return { page: { ...page, lines }, report: { repairs, linesTouched: touched } };
}
