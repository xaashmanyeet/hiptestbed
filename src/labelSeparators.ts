// Using the lines the label itself prints to decide where a row ends.
//
// WHY THIS BEATS MEASURING THE TEXT. Grouping lines into rows by vertical
// position needs a tolerance, and a tolerance is a guess about how far
// apart two rows are. On a bottle the baseline drifts across the frame, so
// a row read at the left edge and the same row read at the right edge sit
// at different heights — and any fixed tolerance eventually puts a value in
// the wrong row. That is the "took the number from the row beneath" bug.
//
// A Supplement Facts panel does not leave this to be inferred. 21 CFR
// 101.36 requires the panel to be ruled: a hairline between nutrients and
// heavier bars between sections. The label is stating, in ink, where every
// row boundary is. And on a curved bottle the rule bends exactly as the
// text does, so it stays correct where a straight line would not.
//
// The trick that makes it curvature-proof is in `bandFor`: a box is tested
// against the separator's height AT THAT BOX'S OWN X. A name on the left
// and its percentage on the right are each compared with the boundary where
// they actually sit, so a bent row still reads as one row.
//
// This is strictly an improvement on top of what exists. When a photograph
// yields too few separators to trust — a label with no rules, a bad angle,
// a dark bottle — the caller falls back to the measured grouping and the
// result is exactly what it is today.

import type { OcrBox, OcrLine } from './labelOcr';
import { centreY } from './labelOcr';

export interface SeparatorPoint { x: number; y: number }

export interface Separator {
  /** Left to right across the image, normalised 0..1, origin top-left. */
  points: SeparatorPoint[];
  /** How dark the rule is against its surroundings. */
  strength: number;
  /** Fraction of the image width it spans. */
  span: number;
}

/**
 * Below this a "separator" is more likely a row of dense text or the edge of
 * a photograph than a printed rule.
 */
export const MIN_SPAN = 0.6;
/** Fewer than this and the measured grouping is the safer bet. */
export const MIN_USABLE = 3;

/**
 * The separator's height at a given x, interpolating between its points and
 * holding flat beyond its ends.
 */
export function separatorYAt(sep: Separator, x: number): number | null {
  const pts = sep.points;
  if (pts.length === 0) return null;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (x <= first.x) return first.y;
  if (x >= last.x) return last.y;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (x > b.x) continue;
    const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
    return a.y + (b.y - a.y) * t;
  }
  return last.y;
}

/** Separators worth using, ordered top to bottom at the middle of the image. */
export function usableSeparators(seps: readonly Separator[]): Separator[] {
  return seps
    .filter((s) => s.span >= MIN_SPAN && s.points.length >= 2)
    .sort((a, b) => (separatorYAt(a, 0.5) ?? 0) - (separatorYAt(b, 0.5) ?? 0));
}

/**
 * Which band between consecutive separators this box sits in.
 *
 * Measured at the box's CENTRE X, which is the whole point: two boxes on the
 * same printed row are compared against the boundary where each of them
 * actually is, not against one height for the whole width.
 *
 * Returns the index of the band, counting from the top. A box above every
 * separator is band 0.
 */
export function bandFor(box: OcrBox, seps: readonly Separator[]): number {
  const x = box.x + box.w / 2;
  const y = centreY(box);
  let band = 0;
  for (const sep of seps) {
    const sy = separatorYAt(sep, x);
    if (sy === null) continue;
    if (y > sy) band++;
  }
  return band;
}

/**
 * Sort lines into rows using the printed rules.
 *
 * Returns the same shape the measured grouping returns, so the caller can
 * swap one for the other without knowing which ran.
 */
export function groupRowsBySeparators(
  lines: readonly OcrLine[], seps: readonly Separator[],
): { lines: OcrLine[] }[] {
  const usable = usableSeparators(seps);
  if (usable.length < MIN_USABLE) return [];

  const bands = new Map<number, OcrLine[]>();
  for (const line of lines) {
    const b = bandFor(line.box, usable);
    const got = bands.get(b);
    if (got === undefined) bands.set(b, [line]);
    else got.push(line);
  }

  return [...bands.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ls]) => ({ lines: ls.sort((p, q) => p.box.x - q.box.x) }));
}

/** What the grouping did, for the Steps tab and the saved record. */
export interface SeparatorReport {
  /** Separators the detector returned. */
  found: number;
  /** How many were long and strong enough to use. */
  usable: number;
  /** Whether the printed rules actually decided the rows. */
  used: boolean;
  why: string;
}

export function describeSeparators(
  seps: readonly Separator[], used: boolean,
): SeparatorReport {
  const usable = usableSeparators(seps).length;
  return {
    found: seps.length,
    usable,
    used,
    why: used
      ? `${usable} printed rules decided the row boundaries, so a bent row stays one row`
      : usable === 0
        ? 'no printed rules were found, so rows were measured from the text'
        : `only ${usable} printed rules were found, below the ${MIN_USABLE} needed `
          + 'to trust them, so rows were measured from the text',
  };
}
