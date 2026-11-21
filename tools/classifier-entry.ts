// The entry point that becomes the n8n classification Code node.
//
// GENERATED, NEVER HAND-WRITTEN. Re-typing 613 lines of classification rules
// into a browser would create a second copy of them, and the moment the two
// drift the server and the phone disagree about what a label says — silently,
// with no test able to catch it. Bundling the real files makes them identical
// by construction and keeps the existing suite meaningful for both.
//
// These three modules import nothing but each other, so the bundle is pure:
// no React, no native calls, no filesystem.

import { classifyLine } from '../src/labelLineClassification.ts';
import { classifyPackLine } from '../src/labelPackClassification.ts';

const g = globalThis as Record<string, unknown>;

/**
 * Classify a batch of distinct line strings.
 *
 * A batch rather than one call per line, because a capture holds a few
 * hundred lines and the round trip, not the work, is the expense.
 */
g.hipClassifyTexts = (body: unknown) => {
  const req = body as { envelope?: number; texts?: unknown };
  if (req.envelope !== 1) {
    return { error: `Envelope version ${String(req.envelope)} is not understood; this parser speaks 1.` };
  }
  if (!Array.isArray(req.texts)) return { error: 'No texts were supplied.' };

  const content: Record<string, unknown> = {};
  const pack: Record<string, unknown> = {};
  for (const t of req.texts) {
    if (typeof t !== 'string') continue;
    content[t] = classifyLine(t);
    pack[t] = classifyPackLine(t);
  }
  return { envelope: 1, content, pack, count: Object.keys(content).length };
};
