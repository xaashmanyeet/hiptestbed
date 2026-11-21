// Bundled into the n8n "Read packaging" Code node by deploy-classifier.sh.
//
// readPack and mergePacks are pure functions over an OcrPage, so they move
// server-side without any of the restructuring classification needed. The
// node is GENERATED from these same files: two copies of the packaging
// rules that could drift is the one failure mode worth designing against,
// because a server and a phone disagreeing about what a label says is
// invisible until someone compares them by hand.

import { mergePacks, readPack } from '../src/labelPack.ts';
import { parsePanel } from '../src/labelPanelParse.ts';
import type { OcrPage } from '../src/labelOcr.ts';

const g = globalThis as Record<string, unknown>;

g.hipReadPack = (body: unknown) => {
  const req = body as { envelope?: number; pages?: unknown };
  if (req.envelope !== 1) {
    return { error: `Envelope version ${String(req.envelope)} is not understood; this reader speaks 1.` };
  }
  if (!Array.isArray(req.pages) || req.pages.length === 0) {
    return { error: 'No pages were supplied.' };
  }

  const pages = req.pages as OcrPage[];
  // The panel rows go in so a claim naming a nutrient can be associated
  // with the one the panel actually lists.
  const readings = pages.map((page) =>
    readPack(page, parsePanel(page).rows.map((r) => r.name)));

  return { envelope: 1, pack: mergePacks(readings), pages: pages.length };
};
