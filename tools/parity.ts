// Does the deployed classifier agree with the local one, line for line?
//
// This is the acceptance test for generating the n8n node instead of
// hand-writing it. Same source, so any disagreement means the bundling is
// wrong — and a server that classifies labels slightly differently from the
// phone is worse than no server at all, because nothing downstream would
// report the difference.
//
// Run by tools/deploy-classifier.sh immediately after a deploy.

import { readFileSync } from 'node:fs';
import type { OcrPage } from '../src/labelOcr.ts';
import { classifyLine } from '../src/labelLineClassification.ts';
import { classifyPackLine } from '../src/labelPackClassification.ts';

const BASE = (process.env.CLASSIFY_BASE ?? process.env.EXPO_PUBLIC_HIP_API_BASE ?? '')
  .trim().replace(/\/+$/, '');
if (BASE.length === 0) {
  console.error('     parity: no server configured. Set EXPO_PUBLIC_HIP_API_BASE in .env');
  process.exit(1);
}
const URL_ = `${BASE}/scan/classify`;
const page = JSON.parse(
  readFileSync(new URL('../assets/sample-label.json', import.meta.url), 'utf8')) as OcrPage;

const texts = [...new Set(page.lines.map((l) => l.text))];
const res = await fetch(URL_, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ envelope: 1, texts }),
});
if (!res.ok) { console.error(`     parity: server returned HTTP ${res.status}`); process.exit(1); }
const got = await res.json() as {
  content?: Record<string, unknown>; pack?: Record<string, unknown>; error?: string;
};
if (got.error !== undefined) { console.error(`     parity: ${got.error}`); process.exit(1); }

let bad = 0;
for (const t of texts) {
  if (JSON.stringify(classifyLine(t)) !== JSON.stringify(got.content?.[t])) {
    if (bad < 3) console.error(`     DIFFERS (content): ${JSON.stringify(t.slice(0, 50))}`);
    bad++;
  }
  if (JSON.stringify(classifyPackLine(t)) !== JSON.stringify(got.pack?.[t])) {
    if (bad < 3) console.error(`     DIFFERS (pack): ${JSON.stringify(t.slice(0, 50))}`);
    bad++;
  }
}
if (bad > 0) {
  console.error(`     parity FAILED on ${bad} of ${texts.length * 2} comparisons`);
  process.exit(1);
}
console.log(`     parity exact: ${texts.length} lines, both classifiers`);
