// Replay scans exported from the phone, here on the Mac.
//
//   ./tools/replay.sh ~/Downloads/hip-scans-2026-11-09-14-22-31.json
//
// The export contains, for every scan, the complete recognised text with
// every word's position. That is enough to run the entire parsing pipeline
// again without the bottle, the photograph or the phone — which is the whole
// reason the app bothers to save it.
//
// Use it to see exactly where a label went wrong, and to check that a fix
// actually fixed it: run before the change, run after, compare.

import { readFileSync } from 'node:fs';
import { checkRow } from '../src/dailyValues.ts';
import { mergeShots, readShot, rowQuality } from '../src/labelMerge.ts';
import { describe as describePack, mergePacks, readPack } from '../src/labelPack.ts';
import { parsePanel } from '../src/labelPanelParse.ts';
import type { ScanRecord } from '../src/scanRecord.ts';

interface Bundle { count: number; exportedAt: string; scans: ScanRecord[] }

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: replay.sh <exported-bundle.json | single-scan.json>');
  process.exit(2);
}

const raw = JSON.parse(readFileSync(path, 'utf8')) as Bundle | ScanRecord;
const scans: ScanRecord[] = 'scans' in raw ? raw.scans : [raw];
const only = process.argv[3];

console.log(`\n${scans.length} scan${scans.length === 1 ? '' : 's'} in ${path}\n`);

let totalRows = 0, totalVerified = 0, totalMismatch = 0, totalBlank = 0;

for (const rec of scans) {
  if (only !== undefined && !rec.id.includes(only) && !rec.title.toLowerCase().includes(only.toLowerCase())) {
    continue;
  }
  console.log('='.repeat(72));
  console.log(`${rec.title}`);
  console.log(`  ${rec.id}   ${rec.shots.length} photo(s)`
    + `${typeof rec.surface === 'string' ? `   surface: ${rec.surface}` : ''}`
    + `${typeof rec.note === 'string' ? `   note: "${rec.note}"` : ''}`);

  // Per photograph, on its own.
  for (const sh of rec.shots) {
    const page = sh.page;
    const panel = parsePanel(page);
    const words = page.lines.reduce((n, l) => n + l.words.length, 0);
    console.log(`\n  [${sh.step}] ${page.width}x${page.height}  ${page.lines.length} lines, ${words} words`);
    console.log(`           ${panel.blockCount} table(s), ${panel.rows.length} rows, ${panel.excludedLines} lines outside`);
    if (panel.servingSize !== null) console.log(`           ${panel.servingSize}`);
  }

  // The packaging reading: name, claims, regulated statements. Recomputed
  // rather than read from the record, so a fix to the rules shows up here.
  const pack = mergePacks(rec.shots.map((sh) => readPack(sh.page)));
  console.log(`\n  PACKAGING  verdict=${pack.verdict}`);
  console.log(`    ${describePack(pack, rec.mergedRows.length)}`);
  if (pack.claims.length > 0) {
    console.log('    claims:');
    for (const c of pack.claims) console.log(`      [${c.kind}] "${c.text}"`);
    console.log(`    FDA disclaimer: ${pack.disclaimerPresent ? 'present' : 'NOT in frame'}`);
  }
  for (const [label, xs] of [
    ['certifications', pack.certifications], ['directions', pack.directions],
    ['warnings', pack.warnings], ['allergens', pack.allergens],
  ] as const) {
    if (xs.length > 0) console.log(`    ${label}: ${xs.join(' | ')}`);
  }

  // Merged, exactly as the phone does it.
  const merged = mergeShots(rec.shots.map((sh) => readShot(sh.step, sh.page)));
  const rows = merged.rows;
  console.log(`\n  merged: ${rows.length} rows, ${merged.report.replaced} replaced, `
    + `${merged.report.discarded.length} fragments discarded`);

  const blank = rows.filter((r) => !/[a-z]{2}/i.test(r.name));
  let verified = 0, mismatch = 0;
  for (const r of rows) {
    const c = checkRow(r.name, r.amount, r.unit, r.dvPct);
    if (c.status === 'verified') verified++;
    if (c.status === 'mismatch') mismatch++;
    const mark = c.status === 'verified' ? 'ok ' : c.status === 'mismatch' ? 'BAD' : '   ';
    const indent = '  '.repeat(r.indentLevel);
    const amount = r.amount === null ? '—' : `${r.amount} ${r.unit ?? ''}`;
    const pct = r.dvNotEstablished ? '*' : r.dvPct === null ? '—' : `${r.dvPct}%`;
    console.log(`    ${mark} ${indent}${r.name.padEnd(46 - indent.length).slice(0, 46 - indent.length)}`
      + ` ${amount.padStart(12)} ${pct.padStart(6)}   ${rowQuality(r).kind}`);
    if (c.status === 'mismatch') {
      console.log(`        ^ arithmetic says ${c.expectedPct}%, label prints ${c.printedPct}%`);
    }
  }
  if (blank.length > 0) {
    console.log(`\n  ${blank.length} ROW(S) WITH NO NAME — this is the failure that looks like`);
    console.log('  a column of numbers with nothing beside them:');
    for (const b of blank) console.log(`    raw: "${b.raw}"`);
  }
  for (const d of merged.report.discarded) {
    console.log(`  discarded from ${d.from}: "${d.raw}"`);
  }

  totalRows += rows.length; totalVerified += verified;
  totalMismatch += mismatch; totalBlank += blank.length;
  console.log(`\n  ${verified} verified, ${mismatch} disagree, of ${rows.length}`);
}

console.log('\n' + '='.repeat(72));
console.log(`TOTAL  ${totalRows} rows   ${totalVerified} verified   `
  + `${totalMismatch} disagree   ${totalBlank} nameless`);
console.log(totalRows === 0 ? 'Nothing parsed at all.'
  : `${Math.round((totalVerified / totalRows) * 100)}% of rows proved themselves arithmetically.\n`);
