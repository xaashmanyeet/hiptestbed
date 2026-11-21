// Reading a Supplement Facts panel off a round bottle.
//
// WHY THIS EXISTS. A 40mm supplement bottle has a circumference of about
// 126mm, and only the middle ~60 degrees of that is square enough to the
// camera to be read — roughly 21mm of label. A Supplement Facts panel is
// wider than that. So on a narrow bottle the panel genuinely cannot fit in
// one photograph, however good the camera is. More than one frame is not a
// refinement here, it is the only way the panel can be read at all.
//
// THE GEOMETRY IS SIMPLER THAN IT LOOKS. For a bottle standing with its axis
// vertical, photographed from roughly panel height, the curve distorts ONLY
// the x axis. Horizontal rules of text stay horizontal and straight; they are
// just squeezed together towards the edges of the bottle, by cos(theta).
// Lines bow only when the phone is pitched up or down, or the bottle is
// leaning. So:
//
//   - grouping rows by y already works on a curved bottle, untouched
//   - what breaks is findColumnBlocks, which anchors a table on the exact
//     right-alignment of the "% Daily Value" column, and cos(theta) squeezing
//     destroys exactly that
//   - therefore the correction is ONE-DIMENSIONAL: a scalar remap of x.
//     Not a homography, not a mesh warp, not a dewarped image.
//
// WHAT THIS MODULE DOES. It converts each frame's x coordinates into position
// ALONG THE UNROLLED LABEL, then places several frames in that one shared
// coordinate system. The result is a single ordinary OcrPage that looks, to
// everything downstream, exactly like a flat photograph of a wide label.
// parsePanel, findColumnBlocks and mergeShots are not modified and do not
// know a cylinder was involved.
//
// WHY NOT STITCH PIXELS. Because we do not have to. The arithmetic runs on a
// few hundred boxes instead of several megapixels, needs no image resampling,
// no feature detection and no new native dependency.
//
// WHY THIS IS WORTH DOING AT ALL, rather than just handing both frames to
// mergeShots. mergeShots arbitrates between photographs that each saw a WHOLE
// row. On a narrow bottle a row splits: "Vitamin C" is legible in one frame
// and its "100%" only in the next. That is two partial rows, neither of which
// can be arithmetic-checked, and no amount of text matching can join them,
// because the thing that relates them is not their text — it is where they
// sit. Position can do it. Once the frames share a coordinate system the row
// is contiguous again and the existing arithmetic self-check works on it
// unmodified.

import type { OcrBox, OcrLine, OcrPage, OcrWord } from './labelOcr';
import { centreY, right } from './labelOcr';
import { normaliseIngredient } from './labelTextNormalize';

/* ------------------------------------------------------------ calibration */

/**
 * Where the bottle is in the frame, in normalised 0..1 frame coordinates.
 *
 * This comes from the capture screen's guide rails, which the person fits the
 * bottle between. That is not hand-holding dressed up as a feature: the rail
 * positions ARE the measurement. Asking someone to line a bottle up inside two
 * vertical marks is how we avoid needing to segment the bottle out of the
 * image, which would be a far larger and far less reliable piece of work.
 */
export interface CylinderCalibration {
  /** x of the bottle's axis — the rails' midpoint. */
  centreX: number;
  /** Half the bottle's apparent width — half the gap between the rails. */
  radiusPx: number;
}

/**
 * Past this fraction of the apparent radius the surface is turning away too
 * steeply to read: asin's slope runs away, a millimetre of label becomes a
 * pixel, and the recogniser has usually given up anyway. 0.9 is about 64
 * degrees off centre.
 */
export const READABLE_ARC = 0.9;

/** The widest half-angle we accept, in radians. */
const MAX_THETA = Math.asin(READABLE_ARC);

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/* -------------------------------------------------------------- unrolling */

export interface UnrollReport {
  /** Lines carried through to the unrolled page. */
  kept: number;
  /** Lines whose centre lay outside the readable arc. */
  dropped: number;
  /** The text of every dropped line, so nothing vanishes silently. */
  droppedText: readonly string[];
  /** Lines kept, but with one edge clamped to the arc limit. */
  clamped: number;
}

/**
 * Map one image x to position along the unrolled label.
 *
 * Looking straight at a cylinder, a point an angle theta around from the
 * centre line appears at sin(theta) of the radius. Running that backwards
 * recovers the angle, and radius * angle is arc length — distance along the
 * label if you peeled it off and flattened it.
 *
 * Scaling by radiusPx rather than using the bare angle is deliberate: it makes
 * the derivative exactly 1 at the centre line, so the middle of the frame —
 * the part that was never distorted — comes through completely unchanged, and
 * widths stay comparable with the heights, which are left alone.
 */
const arc = (x: number, cal: CylinderCalibration): number =>
  cal.radiusPx * Math.asin(clamp((x - cal.centreX) / cal.radiusPx, -1, 1));

/**
 * The full arc a frame can hold, used to renormalise back into 0..1.
 *
 * THIS MUST NOT DEPEND ON THE CONTENT. The obvious thing — scale each frame to
 * fit whatever text it happened to contain — silently gives every frame its
 * own scale, and then the offset between two frames is not a constant any
 * more and joinUnrolled cannot solve for it. The extent is a property of the
 * calibration, so two frames shot through the same guide rails come out on
 * exactly the same scale.
 */
const extentOf = (cal: CylinderCalibration): number => 2 * cal.radiusPx * MAX_THETA;

/** Where x lands in the unrolled frame's own 0..1 span. */
function place(x: number, cal: CylinderCalibration): number {
  const half = cal.radiusPx * MAX_THETA;
  return (arc(x, cal) + half) / extentOf(cal);
}

/** How far off the centre line a point is, as a fraction of the radius. */
const offAxis = (x: number, cal: CylinderCalibration): number =>
  Math.abs((x - cal.centreX) / cal.radiusPx);

/**
 * Remap one box. Both edges go through the mapping SEPARATELY and the width
 * is the difference between them.
 *
 * Mapping the centre and keeping the old width would be the natural-looking
 * mistake and it defeats the whole exercise: a word near the edge of the
 * bottle is squeezed, so it must come out WIDER than it went in. Preserving
 * its width preserves the distortion we are here to remove.
 */
function unrollBox(box: OcrBox, cal: CylinderCalibration): { box: OcrBox; clamped: boolean } {
  const l = box.x;
  const r = right(box);
  const clamped = offAxis(l, cal) > READABLE_ARC || offAxis(r, cal) > READABLE_ARC;
  const lc = clamp(l, cal.centreX - cal.radiusPx * READABLE_ARC,
                      cal.centreX + cal.radiusPx * READABLE_ARC);
  const rc = clamp(r, cal.centreX - cal.radiusPx * READABLE_ARC,
                      cal.centreX + cal.radiusPx * READABLE_ARC);
  const ul = place(lc, cal);
  const ur = place(rc, cal);
  return {
    box: { x: ul, y: box.y, w: Math.max(0, ur - ul), h: box.h },
    clamped,
  };
}

function unrollWord(word: OcrWord, cal: CylinderCalibration): OcrWord {
  return { text: word.text, box: unrollBox(word.box, cal).box };
}

/**
 * Flatten one curved frame.
 *
 * y and h are untouched throughout, because the cylinder does not move them.
 */
export function unrollPageDetailed(
  page: OcrPage,
  cal: CylinderCalibration,
): { page: OcrPage; report: UnrollReport } {
  const lines: OcrLine[] = [];
  const droppedText: string[] = [];
  let clamped = 0;

  for (const line of page.lines) {
    // Judge the LINE by its centre. Judging it by its edges would throw away
    // every full-width row on the panel, since a row that spans the readable
    // arc necessarily has its ends at the limit.
    const mid = line.box.x + line.box.w / 2;
    if (offAxis(mid, cal) > READABLE_ARC) {
      droppedText.push(line.text);
      continue;
    }
    const got = unrollBox(line.box, cal);
    if (got.clamped) clamped++;
    lines.push({
      text: line.text,
      confidence: line.confidence,
      box: got.box,
      words: line.words
        .filter((w) => offAxis(w.box.x + w.box.w / 2, cal) <= READABLE_ARC)
        .map((w) => unrollWord(w, cal)),
    });
  }

  lines.sort((a, b) => {
    const tol = Math.max(a.box.h, b.box.h) * 0.5;
    return Math.abs(a.box.y - b.box.y) > tol ? a.box.y - b.box.y : a.box.x - b.box.x;
  });

  return {
    page: { ...page, lines },
    report: { kept: lines.length, dropped: droppedText.length, droppedText, clamped },
  };
}

/** The plain form named in the design. Same work, report discarded. */
export function unrollPage(page: OcrPage, cal: CylinderCalibration): OcrPage {
  return unrollPageDetailed(page, cal).page;
}

/* ----------------------------------------------------------- the offsets */

export interface FrameOffset {
  /** Index of the frame this describes. */
  frame: number;
  /** Shift along the unrolled label that places it beside its predecessor. */
  du: number;
  /** Vertical shift, for when the phone drifted up or down between frames. */
  dy: number;
  /** How many independently matched lines voted for this offset. */
  matches: number;
}

export interface DroppedFrame {
  frame: number;
  why: string;
  /** How many text matches were found, when too few was the reason. */
  matches: number;
}

export interface JoinReport {
  /** Frames successfully placed, including the first. */
  joined: number;
  /** Frames that could not be placed. */
  dropped: number;
  offsets: readonly FrameOffset[];
  droppedFrames: readonly DroppedFrame[];
  /**
   * How much label the joined frames span, measured in single-frame widths.
   * 1 means one frame's worth of arc; 2.4 means the frames between them cover
   * nearly two and a half frames of label.
   */
  coverage: number;
  /** Duplicate readings removed where frames overlapped. */
  deduped: number;
  /** The text of each removed duplicate, so the merge is auditable. */
  dedupedText: readonly string[];
}

/** Offsets closer than this in u are the same offset. ~4% of a frame. */
const DU_TOL = 0.04;
/** Offsets closer than this in y are the same offset. */
const DY_TOL = 0.02;
/** Short strings match by accident. "mg" is on every row. */
const MIN_MATCH_LEN = 4;
/**
 * Below this, a placement is a guess, and a guess here is worse than a gap.
 * Two, as the design called for. Three was tried and dropped frames that
 * were perfectly placeable, and a dropped frame is a photograph someone
 * took being thrown away — a worse failure than an occasional wrong offset,
 * which the cluster vote catches anyway.
 */
const MIN_MATCHES = 2;

interface Candidate { du: number; dy: number }

/**
 * Work out what shift places frame b beside frame a.
 *
 * MATCHING IS PER WORD, NOT PER LINE, and that is the whole trick. The
 * obvious thing is to look for lines whose text appears in both frames, and
 * it fails on exactly the frames we care about: a line lying across the edge
 * of a frame is only PARTLY in it, so the recogniser returns "Vitamin C 90"
 * in one and "90 mg 100%" in the next. As text those two share nothing a
 * string comparison can see, and the overlap — the one thing the solve
 * depends on — comes out empty. Measured on the stored label, line matching
 * found zero pairs across a realistic overlap.
 *
 * A word is atomic. It is either in the frame or it is not, and when it is,
 * it is the same word in both. So words match where lines cannot.
 *
 * The cost is that single words repeat — a label says "mg" twenty times — so
 * individual pairs are often wrong. That is handled by not trusting any one
 * of them: the answer is the shift that the largest group of pairs agrees on,
 * a cheap RANSAC, which a scattering of wrong matches cannot move.
 */
function solveOffset(a: OcrPage, b: OcrPage): { du: number; dy: number; matches: number } {
  const byText = new Map<string, OcrWord[]>();
  for (const line of a.lines) {
    for (const word of line.words) {
      const key = normaliseIngredient(word.text);
      if (key.length < MIN_MATCH_LEN) continue;
      const bucket = byText.get(key);
      if (bucket === undefined) byText.set(key, [word]);
      else bucket.push(word);
    }
  }

  const candidates: Candidate[] = [];
  for (const line of b.lines) {
    for (const word of line.words) {
      const key = normaliseIngredient(word.text);
      if (key.length < MIN_MATCH_LEN) continue;
      for (const other of byText.get(key) ?? []) {
        candidates.push({
          du: other.box.x - word.box.x,
          dy: centreY(other.box) - centreY(word.box),
        });
      }
    }
  }
  if (candidates.length === 0) return { du: 0, dy: 0, matches: 0 };

  // Largest cluster wins; its median is the answer. Median rather than mean
  // so one bad pair inside the cluster cannot drag the whole frame sideways.
  let best: Candidate[] = [];
  for (const seed of candidates) {
    const near = candidates.filter(
      (c) => Math.abs(c.du - seed.du) <= DU_TOL && Math.abs(c.dy - seed.dy) <= DY_TOL);
    if (near.length > best.length) best = near;
  }
  const median = (xs: number[]): number => {
    const s = [...xs].sort((p, q) => p - q);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1
      ? (s[mid] ?? 0)
      : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
  };
  return {
    du: median(best.map((c) => c.du)),
    dy: median(best.map((c) => c.dy)),
    matches: best.length,
  };
}

/* ------------------------------------------------------------ the joining */

interface Placed {
  line: OcrLine;
  frame: number;
  /**
   * How near the middle of its own frame this line was read, 0 at the centre
   * line and 0.5 at the edge. The middle of a frame is the part the curve
   * never touched, so when two frames both saw a row, the one that saw it
   * nearer its centre saw it better.
   */
  centrality: number;
}

const shift = (box: OcrBox, du: number, dy: number): OcrBox =>
  ({ x: box.x + du, y: box.y + dy, w: box.w, h: box.h });

/** How much of the shorter of two spans lies inside the longer. */
function overlapRatio(a: OcrBox, b: OcrBox): number {
  const lo = Math.max(a.x, b.x);
  const hi = Math.min(right(a), right(b));
  const shorter = Math.min(a.w, b.w);
  return shorter <= 0 ? 0 : Math.max(0, hi - lo) / shorter;
}

/**
 * Are these two readings of the same piece of label?
 *
 * Same line of text (their heights overlap), substantially the same span, and
 * saying compatible things — one text containing the other covers the case
 * where a frame edge truncated one of them.
 */
function sameReading(a: OcrLine, b: OcrLine): boolean {
  const yTol = Math.min(a.box.h, b.box.h) * 0.6;
  if (Math.abs(centreY(a.box) - centreY(b.box)) > yTol) return false;
  if (overlapRatio(a.box, b.box) < 0.5) return false;
  const ta = normaliseIngredient(a.text);
  const tb = normaliseIngredient(b.text);
  if (ta.length === 0 || tb.length === 0) return false;
  return ta === tb || ta.includes(tb) || tb.includes(ta);
}

/**
 * Put several unrolled frames into one coordinate system and return them as a
 * single page.
 *
 * Frames are chained: each is placed against the last one that was placed
 * successfully, because overlap is with the neighbour. A frame that cannot be
 * placed is dropped and the next is tried against the same anchor, so one bad
 * photograph in the middle of a sweep does not take the rest of the sweep
 * down with it.
 */
export function joinUnrolled(
  pages: readonly OcrPage[],
): { page: OcrPage; report: JoinReport } {
  const first = pages[0];
  if (first === undefined) {
    return {
      page: { source: 'cylinder', width: 0, height: 0, engine: 'cylinder-join', lines: [] },
      report: {
        joined: 0, dropped: 0, offsets: [], droppedFrames: [],
        coverage: 0, deduped: 0, dedupedText: [],
      },
    };
  }

  const placed: Placed[] = [];
  const offsets: FrameOffset[] = [];
  const droppedFrames: DroppedFrame[] = [];

  const take = (page: OcrPage, frame: number, du: number, dy: number): void => {
    for (const line of page.lines) {
      placed.push({
        line: { ...line, box: shift(line.box, du, dy),
                words: line.words.map((w) => ({ ...w, box: shift(w.box, du, dy) })) },
        frame,
        centrality: Math.abs(line.box.x + line.box.w / 2 - 0.5),
      });
    }
  };

  take(first, 0, 0, 0);
  offsets.push({ frame: 0, du: 0, dy: 0, matches: 0 });

  let anchor = first;
  let anchorDu = 0;
  let anchorDy = 0;

  for (let i = 1; i < pages.length; i++) {
    const page = pages[i];
    if (page === undefined) continue;
    const got = solveOffset(anchor, page);
    if (got.matches < MIN_MATCHES) {
      droppedFrames.push({
        frame: i,
        why: `only ${got.matches} line${got.matches === 1 ? '' : 's'} matched the previous frame; `
           + `${MIN_MATCHES} are needed to place it. Rotate less between frames so they overlap.`,
        matches: got.matches,
      });
      continue;
    }
    const du = anchorDu + got.du;
    const dy = anchorDy + got.dy;
    take(page, i, du, dy);
    offsets.push({ frame: i, du, dy, matches: got.matches });
    anchor = page;
    anchorDu = du;
    anchorDy = dy;
  }

  /* --- overlapping frames saw the same rows twice; keep the better look --- */
  //
  // This step is not optional. Two copies of "Vitamin C 90 mg 100%" at nearly
  // the same place would be grouped into ONE row by parsePanel, which sorts
  // lines into rows by y — and that row's text would be doubled, so it would
  // parse into nonsense. The overlap that makes joining possible is also what
  // makes de-duplication necessary.
  // Matching the duplicates by TEXT would fail for the same reason the offset
  // solve could not use lines: the frame edge cuts a line in half, so the two
  // copies are "Vitamin C 90" and "90 mg 100%" and no string comparison pairs
  // them. They are recognised by WHERE THEY ARE — same height, overlapping
  // horizontal span — and the more complete reading is the one kept.
  //
  // Text is still consulted, as a guard: two readings must say compatible
  // things before being treated as one. Otherwise two genuinely different
  // ingredients that happen to sit close together could be collapsed.
  placed.sort((a, b) =>
    b.line.words.length - a.line.words.length || a.centrality - b.centrality);
  const kept: Placed[] = [];
  const dedupedText: string[] = [];
  for (const cand of placed) {
    const dup = kept.find((k) => sameReading(k.line, cand.line));
    if (dup === undefined) kept.push(cand);
    else dedupedText.push(cand.line.text);
  }

  /* ------------------------- renormalise the whole thing back into 0..1 --- */
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of kept) {
    lo = Math.min(lo, p.line.box.x);
    hi = Math.max(hi, right(p.line.box));
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) { lo = 0; hi = 1; }
  const span = hi - lo;

  let yLo = Infinity;
  for (const p of kept) yLo = Math.min(yLo, p.line.box.y);
  // Only pull y back into range if a frame's dy pushed it off the top; the
  // vertical scale must not change, or row heights stop meaning anything.
  const yFix = Number.isFinite(yLo) && yLo < 0 ? -yLo : 0;

  const rescale = (box: OcrBox): OcrBox => ({
    x: (box.x - lo) / span,
    y: box.y + yFix,
    w: box.w / span,
    h: box.h,
  });

  const lines = kept
    .map((p) => ({
      text: p.line.text,
      confidence: p.line.confidence,
      box: rescale(p.line.box),
      words: p.line.words.map((w) => ({ text: w.text, box: rescale(w.box) })),
    }))
    .sort((a, b) => {
      const tol = Math.max(a.box.h, b.box.h) * 0.5;
      return Math.abs(a.box.y - b.box.y) > tol ? a.box.y - b.box.y : a.box.x - b.box.x;
    });

  return {
    page: {
      source: first.source,
      width: first.width,
      height: first.height,
      engine: `${first.engine}+cylinder`,
      lines,
    },
    report: {
      joined: offsets.length,
      dropped: droppedFrames.length,
      offsets,
      droppedFrames,
      coverage: span,
      deduped: dedupedText.length,
      dedupedText,
    },
  };
}

/* ------------------------------------------------------- the whole sweep */

export interface CylinderFrame {
  page: OcrPage;
  cal: CylinderCalibration;
}

export interface CylinderReport {
  frames: number;
  unroll: readonly UnrollReport[];
  join: JoinReport;
  /**
   * Set when the frames were not all shot through the same guide rails. The
   * unrolled scale is a function of the calibration, so a changed radius means
   * two frames are on different scales and the offset between them is not a
   * constant. The join may still work; it is less trustworthy.
   */
  calibrationDrift: string | null;
}

/** How much the apparent radius may vary across a sweep before we say so. */
const CAL_DRIFT_TOL = 0.05;

/**
 * The whole cylindrical read: flatten every frame, then place them together.
 * This is what the capture screen calls.
 */
export function unrollAndJoin(
  frames: readonly CylinderFrame[],
): { page: OcrPage; report: CylinderReport } {
  const unrolled: OcrPage[] = [];
  const unrollReports: UnrollReport[] = [];
  for (const f of frames) {
    const got = unrollPageDetailed(f.page, f.cal);
    unrolled.push(got.page);
    unrollReports.push(got.report);
  }

  let drift: string | null = null;
  const radii = frames.map((f) => f.cal.radiusPx);
  const rLo = Math.min(...radii);
  const rHi = Math.max(...radii);
  if (radii.length > 1 && rLo > 0 && (rHi - rLo) / rLo > CAL_DRIFT_TOL) {
    drift = `the bottle's apparent width changed by ${Math.round(((rHi - rLo) / rLo) * 100)}% `
          + 'across the sweep, so the frames are not all on the same scale';
  }

  const joined = joinUnrolled(unrolled);
  return {
    page: joined.page,
    report: {
      frames: frames.length,
      unroll: unrollReports,
      join: joined.report,
      calibrationDrift: drift,
    },
  };
}

/* ------------------------------------------------------ the forward model */

/**
 * Wrap a flat page back onto a cylinder. The exact inverse of unrollPage.
 *
 * This exists for the tests. There is no library of real photographs of
 * curved bottles with hand-checked coordinates, and inventing box positions by
 * hand would only test that the arithmetic matches itself. Projecting a REAL
 * recognised page onto a cylinder and asking unrollPage to recover it tests
 * the mapping against genuine label geometry — real line spacing, real column
 * positions, real OCR noise — and the test fails if either direction drifts.
 *
 * It is not used by the app.
 */
export function projectOntoCylinder(page: OcrPage, cal: CylinderCalibration): OcrPage {
  const half = cal.radiusPx * MAX_THETA;
  const toImage = (u: number): number => {
    const theta = (u * extentOf(cal) - half) / cal.radiusPx;
    return cal.centreX + cal.radiusPx * Math.sin(theta);
  };
  const bend = (box: OcrBox): OcrBox => {
    const l = toImage(box.x);
    const r = toImage(right(box));
    return { x: l, y: box.y, w: Math.max(0, r - l), h: box.h };
  };
  return {
    ...page,
    lines: page.lines.map((line) => ({
      text: line.text,
      confidence: line.confidence,
      box: bend(line.box),
      words: line.words.map((w) => ({ text: w.text, box: bend(w.box) })),
    })),
  };
}

/**
 * Cut a page down to a window of the label and rescale that window to fill
 * 0..1, which is what one photograph of a rotating bottle actually sees.
 * Also for the tests.
 */
export function windowOf(page: OcrPage, from: number, to: number): OcrPage {
  const span = to - from;
  const rescale = (box: OcrBox): OcrBox =>
    ({ x: (box.x - from) / span, y: box.y, w: box.w / span, h: box.h });
  return {
    ...page,
    lines: page.lines
      .filter((l) => {
        const mid = l.box.x + l.box.w / 2;
        return mid >= from && mid <= to;
      })
      .map((l) => ({
        text: l.text,
        confidence: l.confidence,
        box: rescale(l.box),
        words: l.words.map((w) => ({ text: w.text, box: rescale(w.box) })),
      })),
  };
}
