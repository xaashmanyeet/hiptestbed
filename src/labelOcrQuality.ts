// Getting the most out of the recogniser, without touching the recogniser.
//
// Apple Vision takes a `minimumTextHeight`: the smallest text, as a fraction
// of the image, that it will bother looking for. It is a speed control. Set
// it high and a Supplement Facts panel's 6-point type is skipped entirely;
// set it low and every photograph pays for a slow search it usually does not
// need.
//
// So do not choose. Read once at the normal setting, and when that comes
// back thin — few lines, or nothing that looks like a panel — read again
// looking for smaller text and keep whichever attempt found more. A good
// photograph costs one pass, exactly as before. A hard one costs two and
// often becomes readable.
//
// This is also why no photograph can come back with "nothing" without having
// genuinely been tried twice, which matters for a test rig: an empty result
// should mean the label was unreadable, not that the reader gave up early.

import type { OcrPage } from './labelOcr';
import { looksLikePanel } from './labelPanelRecover';

/** Vision's default-ish setting. Fast, and enough for ordinary packaging. */
export const NORMAL_TEXT_HEIGHT = 0.008;
/** Half that: slower, and the difference between reading 6-point type or not. */
export const FINE_TEXT_HEIGHT = 0.004;

/** Below this a page is thin enough to be worth a second, finer look. */
const THIN_LINES = 25;

export interface ReadAttempt {
  minimumTextHeight: number;
  lines: number;
  words: number;
}

export interface BestEffortRead {
  page: OcrPage;
  attempts: ReadAttempt[];
  /** True when the finer pass was run and won. */
  usedFinePass: boolean;
  /** True when the image had to be read in tiles before it gave up its text. */
  usedTiles: boolean;
}

const wordsIn = (p: OcrPage): number =>
  p.lines.reduce((n, l) => n + l.words.length, 0);

const describe = (p: OcrPage, h: number): ReadAttempt =>
  ({ minimumTextHeight: h, lines: p.lines.length, words: wordsIn(p) });

/**
 * Is this reading good enough to stop at?
 *
 * Two ways to be satisfied: plenty of lines came back, or the page already
 * looks like a panel. The second matters because a cropped photograph of
 * just the table is legitimately short, and re-reading it finer would only
 * cost time.
 */
const goodEnough = (p: OcrPage): boolean =>
  p.lines.length >= THIN_LINES || looksLikePanel(p);

/**
 * Read a photograph as well as this device can.
 *
 * `read` is the recogniser, injected so this is testable without a phone.
 */
export async function readBestEffort(
  uri: string,
  read: (uri: string, minimumTextHeight: number) => Promise<OcrPage>,
  readTiled?: (uri: string, minimumTextHeight: number) => Promise<OcrPage>,
): Promise<BestEffortRead> {
  const attempts: ReadAttempt[] = [];

  let first: OcrPage | null = null;
  try {
    first = await read(uri, NORMAL_TEXT_HEIGHT);
    attempts.push(describe(first, NORMAL_TEXT_HEIGHT));
  } catch {
    // Swallowed on purpose: the finer pass below may still succeed, and a
    // thrown first attempt is not a reason to give up on the photograph.
    attempts.push({ minimumTextHeight: NORMAL_TEXT_HEIGHT, lines: 0, words: 0 });
  }

  if (first !== null && goodEnough(first)) {
    return { page: first, attempts, usedFinePass: false, usedTiles: false };
  }

  let fine: OcrPage | null = null;
  try {
    fine = await read(uri, FINE_TEXT_HEIGHT);
    attempts.push(describe(fine, FINE_TEXT_HEIGHT));
  } catch {
    attempts.push({ minimumTextHeight: FINE_TEXT_HEIGHT, lines: 0, words: 0 });
  }

  if (first === null && fine === null && readTiled === undefined) {
    throw new Error('the recogniser failed on both attempts');
  }

  // More lines wins, with a tie going to the finer pass since it saw at
  // least as much and may have resolved small type the first pass merged.
  let best: OcrPage | null = first;
  let usedFinePass = false;
  if (fine !== null && (best === null || fine.lines.length >= best.lines.length)) {
    best = fine;
    usedFinePass = true;
  }

  // Last resort: read the photograph in quarters. The same type is twice as
  // tall relative to a quarter-sized tile, which is often the difference
  // between a panel being read and being called unreadable. Four passes, so
  // only when everything cheaper has already come back thin.
  if (readTiled !== undefined && (best === null || !goodEnough(best))) {
    try {
      const tiled = await readTiled(uri, FINE_TEXT_HEIGHT);
      attempts.push(describe(tiled, FINE_TEXT_HEIGHT));
      if (best === null || tiled.lines.length > best.lines.length) {
        return { page: tiled, attempts, usedFinePass, usedTiles: true };
      }
    } catch {
      attempts.push({ minimumTextHeight: FINE_TEXT_HEIGHT, lines: 0, words: 0 });
    }
  }

  if (best === null) throw new Error('the recogniser failed on every attempt');
  return { page: best, attempts, usedFinePass, usedTiles: false };
}

/**
 * One page holding every line from every photograph.
 *
 * The line and rule views used to be handed `merged.primary.page` — ONE
 * photograph. Take three photographs of a label and two of them were
 * invisible in those views, which is indefensible in an app whose job is to
 * let someone judge what the recogniser read. This stacks them instead, so
 * every line from every photograph is listed, in capture order.
 *
 * y is offset per page so lines never collide, and the boxes stay usable for
 * anything that draws them.
 */
export function combinePages(pages: readonly OcrPage[]): OcrPage | null {
  const real = pages.filter((p) => p.lines.length > 0);
  if (real.length === 0) return pages[0] ?? null;
  if (real.length === 1) return real[0]!;

  const lines = real.flatMap((p, i) =>
    p.lines.map((l) => ({
      text: l.text,
      confidence: l.confidence,
      box: { x: l.box.x, y: i + l.box.y, w: l.box.w, h: l.box.h },
      words: l.words.map((w) => ({
        text: w.text,
        box: { x: w.box.x, y: i + w.box.y, w: w.box.w, h: w.box.h },
      })),
    })),
  );
  const first = real[0]!;
  return {
    source: `${real.length} photographs`,
    width: first.width,
    height: first.height * real.length,
    engine: first.engine,
    lines,
  };
}
