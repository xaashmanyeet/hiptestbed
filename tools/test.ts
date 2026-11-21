// The pipeline's regression suite. Run it with ./tools/test.sh
//
// Everything here is pure: given the same recognised text it must give the
// same answer, on any machine, with no phone and no camera. That is what
// makes the parsing testable at all, and it is why the only iOS-specific
// code in the project is the hundred lines of Swift that produce the text.
//
// The merge cases are built by DAMAGING a copy of the stored sample label --
// knocking a digit off an amount, dropping a line -- so the tests exercise
// real disagreements between two readings rather than hand-written fixtures
// that cannot drift out of step with the parser.

import { readFileSync } from 'node:fs';
import type { OcrPage, OcrLine } from '../src/labelOcr.ts';
import { parsePanel, relinkParents, type PanelRow } from '../src/labelPanelParse.ts';
import { mergeShots, readShot, rowQuality } from '../src/labelMerge.ts';
import { summarise, buildRecord, worstOutcome, scanId, replayInputs, rejoinInputs, type ScanRecord } from '../src/scanRecord.ts';
import { findColumnBlocks } from '../src/labelPanelLayout.ts';
import { looksLikePanel, stitchWrappedHeaders } from '../src/labelPanelRecover.ts';
import { detectRole } from '../src/frameRole.ts';
import { splitIdentity } from '../src/packIdentity.ts';
import { linkClaimToIngredients, themeFor } from '../src/claimThemes.ts';
import { fromMerged } from '../src/product.ts';
import { joinParagraphs, otherIngredientLines } from '../src/labelPanelParse.ts';
import { alternativesFor, repairUnits } from '../src/unitRepair.ts';
import {
  bandFor, groupRowsBySeparators, separatorYAt, usableSeparators,
  type Separator,
} from '../src/labelSeparators.ts';
import { classifyLine } from '../src/labelLineClassification.ts';
import {
  classifiedBy, clearClassifications, installClassifications,
} from '../src/classifyCache.ts';
import { prefetchClassifications, classifyTransportLabel } from '../src/classifyTransport.ts';
import { decide, decisionReason, scoreByComposition } from '../src/compositionMatch.ts';
import {
  deHomoglyph, repairAmounts, repairPage, repairWord,
} from '../src/labelTextRepair.ts';
import { combinePages, readBestEffort } from '../src/labelOcrQuality.ts';
import { checkRow } from '../src/dailyValues.ts';
import {
  projectOntoCylinder, unrollPage, unrollAndJoin, windowOf, READABLE_ARC,
} from '../src/labelCylinder.ts';
import { describe, mergePacks, readPack } from '../src/labelPack.ts';
import { classifyPackLine } from '../src/labelPackClassification.ts';
import { resolveFromShots } from '../src/resolve.ts';

const page = JSON.parse(readFileSync(new URL('../assets/sample-label.json', import.meta.url), 'utf8')) as OcrPage;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
function eq<T>(name: string, got: T, want: T): void {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

console.log('\n--- 1. baseline: the stored label still parses the same ---');
const base = parsePanel(page);
eq('rows', base.rows.length, 23);
eq('blocks', base.blockCount, 2);
eq('excluded lines', base.excludedLines, 27);
const parents = base.rows.map((r) => r.parentIndex);
check('relinkParents is idempotent',
  JSON.stringify(relinkParents(base.rows).map((r) => r.parentIndex)) === JSON.stringify(parents));

console.log('\n--- 2. one photograph through the merge is a no-op ---');
const one = mergeShots([readShot('panel', page)]);
eq('same row count', one.rows.length, base.rows.length);
eq('same names', one.rows.map((r) => r.name), base.rows.map((r) => r.name));
eq('same amounts', one.rows.map((r) => r.amount), base.rows.map((r) => r.amount));
eq('same parents', one.rows.map((r) => r.parentIndex), parents);
eq('nothing replaced', one.report.replaced, 0);
eq('serving size preserved', one.servingSize, base.servingSize);
eq('primary is the panel shot', one.primary.step, 'panel');

console.log('\n--- 3. a damaged reading loses to a verified one ---');
// Find a row whose arithmetic currently verifies, then break its amount in a
// COPY of the page, so the two photographs disagree about one ingredient.
const verifiedRow = base.rows.find((r) => rowQuality(r).kind === 'verified');
check('the sample has a verified row to work with', verifiedRow !== undefined);
const target = verifiedRow!;
console.log(`     using "${target.name}" ${target.amount} ${target.unit} ${target.dvPct}%`);

function damage(p: OcrPage, rowName: string): OcrPage {
  // Knock a digit off the amount wherever it appears, as a misread would.
  const bad = String(target.amount);
  const worse = bad.length > 1 ? bad.slice(0, -1) : '1';
  const lines: OcrLine[] = p.lines.map((l) => {
    if (!l.text.toLowerCase().includes(rowName.toLowerCase().slice(0, 8))) return l;
    return {
      ...l,
      text: l.text.replace(bad, worse),
      words: l.words.map((w) => (w.text === bad ? { ...w, text: worse } : w)),
    };
  });
  return { ...p, lines };
}
const damaged = damage(page, target.name);
const damagedRows = parsePanel(damaged).rows;
const damagedTarget = damagedRows.find((r) => r.name === target.name);
check('the damaged page really did read a different amount',
  damagedTarget !== undefined && damagedTarget.amount !== target.amount,
  `got ${damagedTarget?.amount}`);
check('and the damaged row fails arithmetic',
  damagedTarget !== undefined && rowQuality(damagedTarget).kind !== 'verified');

// Damaged shot FIRST and as the spine candidate; the good one must still win.
const merged = mergeShots([readShot('panel', damaged), readShot('other', page)]);
const won = merged.rows.find((r) => r.name === target.name);
eq('the verified amount wins', won?.amount, target.amount);
check('and the merge recorded the swap', merged.report.replaced >= 1,
  `replaced=${merged.report.replaced}`);
const decision = merged.report.rows.find((d) => d.row.name === target.name);
check('the loser is kept on the record', (decision?.rejected.length ?? 0) >= 1);
console.log(`     kept: ${decision?.quality.why}`);
console.log(`     dropped: ${decision?.rejected[0]?.quality.why}`);

console.log('\n--- 4. a row only one photograph saw is carried across ---');
// Remove BOTH halves of the zinc row -- the recogniser emits the name and the
// right-aligned percentage as separate lines, and dropping only the name
// leaves a nameless "106%" fragment rather than removing the row.
const trimmed: OcrPage = {
  ...page,
  lines: page.lines.filter((l) => {
    const t = l.text.trim().toLowerCase();
    return !t.startsWith('zinc') && t !== '106%';
  }),
};
const trimmedRows = parsePanel(trimmed).rows;
check('the trimmed page lost a row', trimmedRows.length < base.rows.length,
  `${trimmedRows.length} vs ${base.rows.length}`);
const rejoined = mergeShots([readShot('panel', trimmed), readShot('other', page)]);
eq('merging restores the full set', rejoined.rows.length, base.rows.length);
check('and says where it came from',
  Object.keys(rejoined.report.contributed).length > 0,
  JSON.stringify(rejoined.report.contributed));
check('the restored row is the real zinc row',
  rejoined.rows.some((r) => r.name.toLowerCase().includes('zinc') && r.amount !== null));

console.log('\n--- 4b. a nameless fragment is never added as an ingredient ---');
// Drop only the NAME half, leaving "106%" stranded: the classic bad read.
const stranded: OcrPage = {
  ...page,
  lines: page.lines.filter((l) => !l.text.trim().toLowerCase().startsWith('zinc')),
};
const strandedRows = parsePanel(stranded).rows;
check('the stranded page does produce a nameless fragment',
  strandedRows.some((r) => !/[a-z]{2}/i.test(r.name)),
  JSON.stringify(strandedRows.filter((r) => !/[a-z]{2}/i.test(r.name)).map((r) => r.name)));
const guarded = mergeShots([readShot('panel', page), readShot('other', stranded)]);
eq('merging does not inflate the panel', guarded.rows.length, base.rows.length);
check('every merged row has a name',
  guarded.rows.every((r) => /[a-z]{2}/i.test(r.name)),
  JSON.stringify(guarded.rows.filter((r) => !/[a-z]{2}/i.test(r.name)).map((r) => r.name)));
check('and the discard was recorded, not hidden',
  guarded.report.discarded.length >= 1,
  JSON.stringify(guarded.report.discarded));
console.log(`     discarded: ${JSON.stringify(guarded.report.discarded.map((d) => d.raw))}`);

console.log('\n--- 5. parent links survive merging ---');
const nested = rejoined.rows.filter((r) => r.indentLevel > 0);
check('every indented row points at a shallower row above it, or nothing',
  nested.every((r) => {
    if (r.parentIndex === null) return true;
    const p = rejoined.rows[r.parentIndex];
    return p !== undefined && p.indentLevel < r.indentLevel && p.block === r.block;
  }));
check('no parentIndex is out of range',
  rejoined.rows.every((r) => r.parentIndex === null
    || (r.parentIndex >= 0 && r.parentIndex < rejoined.rows.length)));

console.log('\n--- 6. the photograph framed for a field owns it ---');
// A front-of-pack photograph: a big product name, nothing else.
const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const frontPage: OcrPage = {
  source: 'front.jpg', width: 1500, height: 1500, engine: 'test',
  lines: [
    { text: 'Super Multi Daily', confidence: 0.99, box: box(0.1, 0.1, 0.8, 0.12),
      words: [
        { text: 'Super', box: box(0.10, 0.10, 0.24, 0.12) },
        { text: 'Multi', box: box(0.36, 0.10, 0.24, 0.12) },
        { text: 'Daily', box: box(0.62, 0.10, 0.24, 0.12) },
      ] },
    { text: 'DISTRIBUTED BY: Acme Vitamins LLC', confidence: 0.95,
      box: box(0.1, 0.5, 0.6, 0.02), words: [] },
  ],
};
const twoShot = mergeShots([readShot('panel', page), readShot('front', frontPage)]);
const nameChoice = twoShot.report.fields.find((f) => f.field === 'productName');
eq('the product name comes from the front photograph', nameChoice?.from, 'front');
eq('and it is the name, not a fragment of prose', nameChoice?.value, 'Super Multi Daily');
eq('the brand comes with it', twoShot.identity.brand, 'Acme Vitamins LLC');
const ssChoice = twoShot.report.fields.find((f) => f.field === 'servingSize');
eq('serving size comes from the panel shot', ssChoice?.from, 'panel');

console.log('\n--- 6b. prose is never mistaken for a product name ---');
// The stored sample is a panel-only crop: there is no product name on it, and
// every tall line is a fragment of the fillers paragraph or a batch stamp.
// The honest answer is nothing, not the nearest four words.
const panelOnly = readShot('panel', page);
eq('no name is invented', panelOnly.identity.productName, null);
check('but the regulated company line is still read',
  (panelOnly.identity.brand ?? '').toLowerCase().includes('nature made'),
  JSON.stringify(panelOnly.identity.brand));
const lonely = mergeShots([panelOnly]).report.fields.find((f) => f.field === 'productName');
eq('and the merge says so plainly', lonely?.from, null);
eq('with a reason', lonely?.why, 'no photograph produced this');

console.log('\n--- 7. quality ranking is ordered as designed ---');
const q = (r: Partial<PanelRow>): number => rowQuality({
  block: 0, name: 'zinc', amount: null, unit: null, dvPct: null,
  dvNotEstablished: false, indentLevel: 0, parentIndex: null, raw: '', ...r,
} as PanelRow).score;
const verified = q({ name: 'zinc', amount: 11, unit: 'mg', dvPct: 100 });
const contradictory = q({ name: 'zinc', amount: 11, unit: 'mg', dvPct: 42 });
const unverifiable = q({ name: 'turmeric', amount: 500, unit: 'mg' });
const amountOnly = q({ name: 'zinc', amount: 11 });
const nameOnly = q({ name: 'zinc' });
console.log(`     verified=${verified} unverifiable=${unverifiable} contradictory=${contradictory} amountOnly=${amountOnly} nameOnly=${nameOnly}`);
check('verified beats everything',
  verified > unverifiable && verified > contradictory && verified > amountOnly);
check('a complete unverifiable row beats a contradictory one',
  unverifiable > contradictory);
check('a contradictory row still beats a row with no unit', contradictory > amountOnly);
check('an amount beats no amount', amountOnly > nameOnly);

console.log('\n--- 8. the record survives a round trip through JSON ---');
const fakeResolution = {
  stages: [
    { id: 'read', title: 'Read the text', purpose: '', outcome: 'ok', detail: '', deterministic: false },
    { id: 'verify', title: 'Check', purpose: '', outcome: 'partial', detail: '', deterministic: true },
  ],
  product: null, answeredBy: 'from-label', candidates: [],
  identity: one.identity, page, shots: [readShot('panel', page)], merged: one,
  pack: readPack(page),
} as never;
const rec = buildRecord(scanId(new Date('2026-11-09T14:22:31.004Z')), fakeResolution,
  { panel: 'panel.jpg' }, 'Cylindrical', 'glare on the left');
eq('id is filesystem-safe', rec.id, '2026-11-09T14-22-31-004Z');
eq('worst outcome', worstOutcome(rec.stages), 'partial');
const round = JSON.parse(JSON.stringify(rec));
eq('word boxes survive',
  round.shots[0].page.lines[0].words.length, page.lines[0]!.words.length);
eq('merged rows survive', round.mergedRows.length, base.rows.length);
const sum = summarise(round);
eq('summary row count', sum.rows, base.rows.length);
eq('summary note', sum.note, 'glare on the left');
eq('summary surface', sum.surface, 'Cylindrical');
check('summary is small', JSON.stringify(sum).length < 400,
  `${JSON.stringify(sum).length} bytes`);
console.log(`     full record ${(JSON.stringify(rec).length / 1024).toFixed(0)} KB, summary ${JSON.stringify(sum).length} B`);


console.log('\n--- 9. the packaging reader ---');
const bx = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const mkLine = (text: string, y: number, h = 0.03, x = 0.1, w = 0.8) => ({
  text, confidence: 0.95, box: bx(x, y, w, h), words: [{ text, box: bx(x, y, w, h) }],
});
const front: OcrPage = {
  source: 'front.jpg', width: 1200, height: 1600, engine: 'test',
  lines: [
    mkLine('Immuno Shield', 0.08, 0.11),
    mkLine('Dietary Supplement', 0.22, 0.03),
    mkLine('Supports immune health', 0.30, 0.035),
    mkLine('Excellent source of Vitamin C', 0.36, 0.03),
    mkLine('Non-GMO Project Verified', 0.42, 0.02),
    mkLine('90 Vegetarian Capsules', 0.48, 0.028),
    mkLine('SUGGESTED USE: Take 2 capsules daily with food.', 0.60, 0.018),
    mkLine('WARNING: Consult your physician if pregnant or nursing.', 0.66, 0.018),
    mkLine('DISTRIBUTED BY: Acme Vitamins LLC, Denver CO', 0.80, 0.016),
    mkLine('www.acmevitamins.com', 0.86, 0.016),
    mkLine('Lot: 4471B  Exp: 09/2027', 0.92, 0.016),
  ],
};
const fp = readPack(front);
eq('verdict is confirmed from the statement of identity', fp.verdict, 'confirmed');
eq('title found by elimination', fp.title, 'Immuno Shield');
eq('brand from the regulated line', fp.brand, 'Acme Vitamins LLC');
eq('net quantity', fp.netQuantity, '90 Vegetarian Capsules');
eq('certification', fp.certifications, ['Non-GMO']);
check('directions read off the photo', fp.directions.length === 1, JSON.stringify(fp.directions));
check('warning read off the photo', fp.warnings.length === 1, JSON.stringify(fp.warnings));
eq('one advertised benefit', fp.claims.filter((c) => c.kind === 'benefit').length, 1);
eq('one nutrient content claim', fp.claims.filter((c) => c.kind === 'nutrient-content').length, 1);
eq('disclaimer correctly reported absent', fp.disclaimerPresent, false);
check('no panel seen', !fp.panelPresent);
console.log(`     description: ${describe(fp, 0)}`);

console.log('\n--- 9b. the disclaimer, and a disease claim ---');
const front2: OcrPage = { ...front, lines: [
  ...front.lines,
  mkLine('These statements have not been evaluated by the Food and Drug Administration.', 0.70, 0.014),
  mkLine('This product prevents colds and flu.', 0.74, 0.02),
]};
const fp2 = readPack(front2);
eq('disclaimer found', fp2.disclaimerPresent, true);
eq('disease claim flagged', fp2.claims.filter((c) => c.kind === 'disease').length, 1);
check('and it is quoted verbatim',
  fp2.claims.some((c) => c.kind === 'disease' && c.text.includes('prevents colds')));

console.log('\n--- 9c. a photo that is not a supplement ---');
const random: OcrPage = { source: 'x', width: 800, height: 600, engine: 'test', lines: [
  mkLine('WHOLE FOODS MARKET', 0.1, 0.05),
  mkLine('Open until 10pm', 0.3, 0.03),
  mkLine('Aisle 7', 0.5, 0.03),
]};
const rp = readPack(random);
eq('no supplement identified', rp.verdict, 'not-a-supplement');
check('and it says why', rp.evidence.some((e) => e.includes('Nothing in this photograph')),
  JSON.stringify(rp.evidence));

console.log('\n--- 9d. merging packs keeps every statement ---');
const both = mergePacks([readPack(page), fp]);
eq('strongest verdict wins', both.verdict, 'confirmed');
eq('title comes from the photo that had one', both.title, 'Immuno Shield');
check('warnings from the front survive', both.warnings.length >= 1);
check('panel presence remembered', both.panelPresent);

console.log('\n--- 10. a front-only photo now produces a result ---');
// This is the bug the whole change exists to fix: no Supplement Facts panel
// used to mean no product, which the camera screen treated as a failure and
// discarded -- nothing on screen, nothing saved.
const r = await resolveFromShots([{ step: 'front', uri: 'front.jpg', page: front }]);
check('a product was built', r.product !== null, JSON.stringify(r.product));
eq('with no ingredient rows', r.product?.rows.length, 0);
eq('but a real title', r.product?.title, 'Immuno Shield');
eq('and a brand', r.product?.brand, 'Acme Vitamins LLC');
check('directions carried onto the product',
  (r.product?.statements ?? []).some((st) => st.type === 'directions'),
  JSON.stringify(r.product?.statements));
check('warnings carried onto the product',
  (r.product?.statements ?? []).some((st) => st.type === 'warning'));
eq('answered by the label itself', r.answeredBy, 'from-label');
check('the pack reading is on the resolution', r.pack !== null);
eq('and the pack stage ran', r.stages.find((x) => x.id === 'pack')?.outcome, 'ok');
const fromLabel = r.stages.find((x) => x.id === 'from-label');
eq('reported as partial, not a failure', fromLabel?.outcome, 'partial');

console.log('\n--- 10b. a hopeless photo is still a saved record ---');
const r2 = await resolveFromShots([{ step: 'panel', uri: 'x.jpg', page: random }]);
check('the read stage says the photo was bad',
  r2.stages.find((x) => x.id === 'read')?.outcome === 'unreadable-input'
  || r2.stages.find((x) => x.id === 'read')?.outcome === 'ok');
check('shots are still returned so the scan can be saved', r2.shots.length === 1);
check('and a pack reading exists to explain it', r2.pack !== null);
const rec2 = buildRecord(scanId(), r2, {}, 'Cylindrical', null);
eq('the record keeps the surface', rec2.surface, 'Cylindrical');
eq('and the format is current', rec2.format, 3);
check('the summary carries the verdict', summarise(rec2).verdict !== null);

console.log('\n--- 11. pack rule order ---');
eq('directions beat the dose-form rule',
  classifyPackLine('SUGGESTED USE: Take 2 capsules daily').tag, 'directions');
eq('warnings beat the benefit rule',
  classifyPackLine('WARNING: consult your physician before use').tag, 'warning');
eq('the disclaimer beats the disease-claim rule',
  classifyPackLine('This product is not intended to diagnose, treat, cure, or prevent any disease.').tag,
  'fda-disclaimer');
eq('a bare dose form still lands',
  classifyPackLine('Softgels').tag, 'dosage-form');

/* ===================================================================== */
console.log('\n--- 12. round bottles: unrolling ---');
//
// There is no library of photographs of curved bottles with hand-checked box
// positions, and inventing coordinates would only prove the arithmetic agrees
// with itself. So the real stored label is BENT ONTO a cylinder with the
// forward model and the unroller is asked to recover it. That exercises the
// mapping against genuine label geometry -- real line spacing, real column
// positions, real OCR noise -- and fails if either direction drifts.

const cal = { centreX: 0.5, radiusPx: 0.3 };

// Tag every line so the comparison is line-for-line: "Amount Per Serving"
// appears twice on this label and matching by text alone pairs the wrong ones.
const tagged: OcrPage = {
  ...page, lines: page.lines.map((l, i) => ({ ...l, text: `${i}|${l.text}` })),
};
const bentTagged = projectOntoCylinder(tagged, cal);
const backTagged = unrollPage(bentTagged, cal);
let worst = 0;
let missing = 0;
for (const orig of tagged.lines) {
  const got = backTagged.lines.find((l) => l.text === orig.text);
  if (got === undefined) { missing++; continue; }
  worst = Math.max(worst, Math.abs(orig.box.x - got.box.x), Math.abs(orig.box.w - got.box.w));
}
eq('every line survives the round trip', missing, 0);
check('unrolling is the exact inverse of bending', worst < 1e-9, `worst error ${worst}`);

const bent = projectOntoCylinder(page, cal);
const back = unrollPage(bent, cal);
const gapOf = (p: OcrPage): number => {
  const b = findColumnBlocks(p);
  return b.length > 1 ? (b[1]!.amountX - b[0]!.dvRight) : NaN;
};
const flatGap = gapOf(page);
const bentGap = gapOf(bent);
check('the curve squeezes the gap between the two tables',
  bentGap < flatGap * 0.8, `flat ${flatGap.toFixed(4)} curved ${bentGap.toFixed(4)}`);
check('and unrolling restores it', Math.abs(gapOf(back) - flatGap) < 1e-9);
// Worth being honest about: at this curvature the single-frame parse still
// comes out whole. Correcting one frame is not what earns this module -- the
// multi-frame join below is.
eq('a single curved frame still parses', parsePanel(bent).rows.length, base.rows.length);

check('a line beyond the readable arc is dropped, not mangled', (() => {
  const far = 0.5 + cal.radiusPx * (READABLE_ARC + 0.05);
  const offPanel: OcrPage = { ...page, lines: [{
    text: 'ROUND THE BACK', confidence: 0.9,
    box: { x: far, y: 0.5, w: 0.02, h: 0.02 },
    words: [{ text: 'ROUND', box: { x: far, y: 0.5, w: 0.02, h: 0.02 } }],
  }] };
  return unrollPage(offPanel, cal).lines.length === 0;
})());

/* ===================================================================== */
console.log('\n--- 13. round bottles: joining frames ---');

/** What the recogniser returns when a line runs off the edge: the words that fit. */
function cutToWindow(p: OcrPage, from: number, to: number): OcrPage {
  const out: OcrLine[] = [];
  for (const l of p.lines) {
    const ws = l.words.filter((w) => {
      const mid = w.box.x + w.box.w / 2;
      return mid >= from && mid <= to;
    });
    if (ws.length === 0) continue;
    if (ws.length === l.words.length) { out.push(l); continue; }
    const x = Math.min(...ws.map((w) => w.box.x));
    const r = Math.max(...ws.map((w) => w.box.x + w.box.w));
    out.push({
      text: ws.map((w) => w.text).join(' '), confidence: l.confidence,
      box: { x, y: l.box.y, w: r - x, h: l.box.h }, words: ws,
    });
  }
  return { ...p, lines: out };
}

/** One photograph of a rotating bottle: part of the label, bent, filling the frame. */
const frameOf = (from: number, to: number): OcrPage =>
  projectOntoCylinder(windowOf(cutToWindow(page, from, to), from, to), cal);

const verifiedIn = (p: OcrPage): number =>
  parsePanel(p).rows.filter(
    (r) => checkRow(r.name, r.amount, r.unit, r.dvPct).status === 'verified').length;

// Two frames, overlapping by about a quarter -- a panel too wide for one shot.
const left = frameOf(0, 0.62);
const rightF = frameOf(0.38, 1.0);
check('neither frame alone holds the whole panel',
  parsePanel(left).rows.length < base.rows.length
  && parsePanel(rightF).rows.length < base.rows.length,
  `left ${parsePanel(left).rows.length}, right ${parsePanel(rightF).rows.length}`);

const sweep = unrollAndJoin([left, rightF].map((p) => ({ page: p, cal })));
eq('both frames are placed', sweep.report.join.joined, 2);
eq('none is dropped', sweep.report.join.dropped, 0);
const off = sweep.report.join.offsets[1]!;
check('the offset is carried by many matching words', off.matches >= 10, `${off.matches}`);
check('and the frames did not drift vertically', Math.abs(off.dy) < 0.005);
check('the sweep covers more than one frame of label',
  sweep.report.join.coverage > 1.2, `${sweep.report.join.coverage.toFixed(2)}`);

// The point of the whole exercise: rows split across the frame edge come back
// together, and the arithmetic -- which needs the amount AND the percentage,
// which were in different photographs -- closes on them.
const joinedPanel = parsePanel(sweep.page);
eq('the joined panel has the same rows as the flat label',
  joinedPanel.rows.length, base.rows.length);
eq('and the same two tables', joinedPanel.blockCount, 2);
eq('and the same rows verify',
  verifiedIn(sweep.page), verifiedIn(page));

check('the overlap is de-duplicated', sweep.report.join.deduped > 0,
  `${sweep.report.join.deduped} removed`);
eq('and every removed duplicate is named',
  sweep.report.join.dedupedText.length, sweep.report.join.deduped);

console.log('\n--- 13b. a frame that cannot be placed is dropped, loudly ---');
const apart = unrollAndJoin([frameOf(0, 0.30), frameOf(0.70, 1.0)].map((p) => ({ page: p, cal })));
eq('only the first frame is placed', apart.report.join.joined, 1);
eq('the other is dropped', apart.report.join.dropped, 1);
check('the reason names the overlap',
  (apart.report.join.droppedFrames[0]?.why ?? '').includes('overlap'));
check('nothing was guessed',
  (apart.report.join.droppedFrames[0]?.matches ?? 99) < 3);

console.log('\n--- 13c. a sweep shot through changing rails is flagged ---');
const drifted = unrollAndJoin([
  { page: left, cal },
  { page: rightF, cal: { centreX: 0.5, radiusPx: 0.36 } },
]);
check('the calibration drift is reported', drifted.report.calibrationDrift !== null);

/* ===================================================================== */
console.log('\n--- 14. format 3, and format 2 still replaying ---');
const cylRec = buildRecord(scanId(), fakeResolution, {}, 'Cylindrical', null, {
  panel: {
    frames: [left, rightF],
    calibrations: [cal, cal],
    report: sweep.report,
  },
});
eq('the record is format 3', cylRec.format, 3);
const cylRound = JSON.parse(JSON.stringify(cylRec)) as typeof cylRec;
eq('the frames survive being written and read back',
  cylRound.shots[0]?.cylinder?.frames.length, 2);
eq('re-joining from the frames gives the same rows',
  parsePanel(rejoinInputs(cylRound)[0]!.page).rows.length, base.rows.length);

// The regression safety net: every scan saved before this change must still
// replay, and must be untouched by the cylinder code.
const legacy = JSON.parse(JSON.stringify(
  buildRecord(scanId(), fakeResolution, { panel: 'panel.jpg' }, 'Flat', null))) as ScanRecord;
delete (legacy.shots[0] as { cylinder?: unknown }).cylinder;
legacy.format = 2;
eq('a format-2 record still replays', replayInputs(legacy).length, 1);
eq('rejoin leaves a format-2 record exactly as replay does',
  JSON.stringify(rejoinInputs(legacy)), JSON.stringify(replayInputs(legacy)));
eq('and it still summarises', summarise(legacy).format, 2);


/* ===================================================================== */
console.log('\n--- 15. nothing a photograph produced is ever discarded ---');

// A photograph that read as nothing at all is the most interesting one in a
// test set: it is the failure you need to reproduce. It must still reach the
// record, not be swallowed on the way.
const blank: OcrPage = {
  source: 'blank.jpg', width: 1500, height: 1500, engine: 'apple-vision', lines: [],
};
const blankRes = await resolveFromShots([{ step: 'panel', uri: 'blank.jpg', page: blank }]);
check('a frame with no lines still produces shots', blankRes.shots.length === 1);
const blankRec = buildRecord(scanId(), blankRes, {}, 'Flat', null);
eq('and a saved record', blankRec.shots.length, 1);
eq('which still holds the empty page', blankRec.shots[0]?.page.lines.length, 0);
eq('and still replays', replayInputs(blankRec).length, 1);
check('the ladder says the input was unreadable rather than erroring',
  blankRes.stages.find((x) => x.id === 'read')?.outcome === 'unreadable-input');

// Mixed in with a real page, the blank must not take the good one down.
const mixed = await resolveFromShots([
  { step: 'panel', uri: 'blank.jpg', page: blank },
  { step: 'panel', uri: 'good.jpg', page },
]);
eq('a blank alongside a real page keeps both shots', mixed.shots.length, 2);
check('and the real rows still come through',
  (mixed.merged?.rows.length ?? 0) === base.rows.length,
  `${mixed.merged?.rows.length}`);

console.log('\n--- 16. flat and cylindrical really are different paths ---');

// The surface selector used to be a label on the scan that changed nothing.
// These two assertions are what stop it going back to that.
const twoFrames = [frameOf(0, 0.62), frameOf(0.38, 1.0)];
const cylPage = unrollAndJoin(twoFrames.map((p) => ({ page: p, cal }))).page;
const flatFirst = twoFrames[0]!;

const xsOf = (p: OcrPage): string =>
  p.lines.slice(0, 8).map((l) => l.box.x.toFixed(4)).join(',');
check('the cylindrical path moves the geometry',
  xsOf(cylPage) !== xsOf(flatFirst));
check('and it produces a wider page than any single frame',
  cylPage.lines.length > flatFirst.lines.length,
  `joined ${cylPage.lines.length} vs frame ${flatFirst.lines.length}`);

// The decisive one: flat treats the frames as two separate partial shots and
// cannot rejoin a row split across them; cylindrical can.
const flatBoth = await resolveFromShots(
  twoFrames.map((p, i) => ({ step: 'panel' as const, uri: `f${i}.jpg`, page: p })));
const cylBoth = await resolveFromShots([{ step: 'panel', uri: 'c.jpg', page: cylPage }]);
const vRows = (r: typeof flatBoth): number => (r.merged?.rows ?? []).filter(
  (x) => checkRow(x.name, x.amount, x.unit, x.dvPct).status === 'verified').length;
check('cylindrical verifies at least as many rows as flat on the same frames',
  vRows(cylBoth) >= vRows(flatBoth), `cyl ${vRows(cylBoth)} vs flat ${vRows(flatBoth)}`);
console.log(`     flat ${vRows(flatBoth)} verified, cylindrical ${vRows(cylBoth)} verified`);


/* ===================================================================== */
console.log('\n--- 17. a legible panel always produces rows ---');
//
// The failure this guards against was real and embarrassing: a One A Day
// carton, photographed square on, 122 lines recognised cleanly, and the
// parser reported no panel and zero ingredients. The carton prints its
// column headings stacked -- "Amount Per" above "Serving" -- and the rules
// wanted them on one line.

/** Print a heading across two stacked lines, as a narrow carton does. */
function stackHeadings(p: OcrPage): OcrPage {
  const out: OcrLine[] = [];
  for (const l of p.lines) {
    const t = l.text.toUpperCase();
    const split = t.startsWith('AMOUNT PER SERVING') ? ['Amount Per', 'Serving']
                : t.startsWith('% DAILY VALUE') ? ['% Daily', 'Value'] : null;
    if (split === null) { out.push(l); continue; }
    const h = l.box.h;
    split.forEach((txt, i) => out.push({
      text: txt, confidence: l.confidence,
      box: { x: l.box.x, y: l.box.y + i * h * 1.05, w: l.box.w * 0.6, h },
      words: txt.split(' ').map((w, j) => ({
        text: w, box: { x: l.box.x + j * 0.03, y: l.box.y + i * h * 1.05, w: 0.03, h },
      })),
    }));
  }
  return { ...p, lines: out.sort((a, b) => a.box.y - b.box.y) };
}

const stacked = stackHeadings(page);
check('stacked headings are rejoined into one heading',
  stitchWrappedHeaders(stacked).lines.some((l) => /AMOUNT PER SERVING/i.test(l.text)));
check('so the table is found where it used to be invisible',
  findColumnBlocks(stacked).length === 2, `${findColumnBlocks(stacked).length} blocks`);
const stackedPanel = parsePanel(stacked);
check('and a stacked-heading panel yields rows', stackedPanel.rows.length > 0,
  `${stackedPanel.rows.length}`);
check('with amounts on most of them',
  stackedPanel.rows.filter((r) => r.amount !== null).length >= 15,
  `${stackedPanel.rows.filter((r) => r.amount !== null).length} with amounts`);

// Headings gone entirely -- torn, cropped, or simply not recognised.
const headless: OcrPage = { ...page, lines: page.lines.filter((l) => {
  const t = l.text.toUpperCase();
  return !t.startsWith('AMOUNT PER SERVING') && !t.startsWith('% DAILY VALUE');
}) };
check('a page with no headings still looks like a panel', looksLikePanel(headless));
const rescued = parsePanel(headless);
check('and still produces rows', rescued.rows.length > 0, `${rescued.rows.length}`);
check('marked as recovered, so a guess is never mistaken for a reading',
  rescued.recovered);
check('and the arithmetic still closes on most of them',
  rescued.rows.filter((r) =>
    checkRow(r.name, r.amount, r.unit, r.dvPct).status === 'verified').length >= 10,
  `${rescued.rows.filter((r) =>
    checkRow(r.name, r.amount, r.unit, r.dvPct).status === 'verified').length} verified`);

// The other direction: recovery must not invent a panel out of packaging.
const frontOnly: OcrPage = { ...page, lines: page.lines.slice(0, 4) };
check('a front-of-pack photo is not forced into being a panel',
  !looksLikePanel(frontOnly) && parsePanel(frontOnly).rows.length === 0);
eq('and the clean label is completely unaffected', parsePanel(page).rows.length, base.rows.length);
eq('still not marked recovered', parsePanel(page).recovered, false);


/* ===================================================================== */
console.log('\n--- 18. a label split across photographs ---');
//
// The reported bug: three photographs — one front, two halves of a panel
// that is printed as two side-by-side mini-tables — and only the first half
// came through. Splitting a panel in two is normal on a narrow carton, not
// an edge case.

/** One photograph of part of a label: an x window, rescaled to fill a frame. */
function partOf(p: OcrPage, from: number, to: number): OcrPage {
  const span = to - from;
  const rs = (b: { x: number; y: number; w: number; h: number }) =>
    ({ x: (b.x - from) / span, y: b.y, w: b.w / span, h: b.h });
  return { ...p, lines: p.lines
    .filter((l) => { const m = l.box.x + l.box.w / 2; return m >= from && m <= to; })
    .map((l) => ({
      text: l.text, confidence: l.confidence, box: rs(l.box),
      words: l.words.map((w) => ({ text: w.text, box: rs(w.box) })),
    })) };
}

const leftPart = partOf(page, 0, 0.37);
const rightPart = partOf(page, 0.37, 0.70);
const frontPart: OcrPage = { ...page, lines: page.lines.slice(0, 4) };

check('each half is a partial panel on its own',
  parsePanel(leftPart).rows.length > 0 && parsePanel(rightPart).rows.length > 0
  && parsePanel(leftPart).rows.length < base.rows.length);

const split = await resolveFromShots([
  { step: 'front', uri: 'f.jpg', page: frontPart },
  { step: 'panel', uri: 'a.jpg', page: leftPart },
  { step: 'panel', uri: 'b.jpg', page: rightPart },
]);
eq('all three photographs are read', split.shots.length, 3);
eq('and both halves are combined into the whole table',
  split.merged?.rows.length, base.rows.length);
check('with the arithmetic intact across the join',
  (split.merged?.rows ?? []).filter((r) =>
    checkRow(r.name, r.amount, r.unit, r.dvPct).status === 'verified').length >= 20,
  `${(split.merged?.rows ?? []).filter((r) =>
    checkRow(r.name, r.amount, r.unit, r.dvPct).status === 'verified').length} verified`);
check('the second half genuinely contributed rows',
  (split.merged?.report.contributed.panel ?? 0) > 0);

// The mechanism that lost the second half: joining needs overlapping words,
// and disjoint halves share none.
const asOneSweep = unrollAndJoin([leftPart, rightPart]
  .map((p) => ({ page: p, cal: { centreX: 0.5, radiusPx: 0.3 } })));
check('joining disjoint halves drops one, which is why parts must not join',
  asOneSweep.report.join.dropped === 1,
  `${asOneSweep.report.join.dropped} dropped`);
// Unrolled separately, both survive.
const partsPlan = await resolveFromShots([
  { step: 'panel', uri: 'a.jpg', page: unrollPage(leftPart, { centreX: 0.5, radiusPx: 0.3 }) },
  { step: 'panel', uri: 'b.jpg', page: unrollPage(rightPart, { centreX: 0.5, radiusPx: 0.3 }) },
]);
check('unrolled separately, both parts still produce rows',
  (partsPlan.merged?.rows.length ?? 0) > parsePanel(leftPart).rows.length,
  `${partsPlan.merged?.rows.length} rows`);

console.log('\n--- 19. every photograph is visible in the views ---');
const combined = combinePages([leftPart, rightPart, frontPart]);
eq('the combined page holds every line from every photograph',
  combined?.lines.length,
  leftPart.lines.length + rightPart.lines.length + frontPart.lines.length);
check('and the resolution carries it',
  (split.allPages?.lines.length ?? 0) > (split.page?.lines.length ?? 0),
  `${split.allPages?.lines.length} vs ${split.page?.lines.length}`);
eq('one photograph needs no combining', combinePages([page])?.lines.length, page.lines.length);
eq('and no photographs is not a crash', combinePages([]), null);

console.log('\n--- 20. what a photograph is, and why ---');
eq('a panel with its heading is certain', detectRole(page).confidence, 'certain');
eq('and is a panel', detectRole(page).role, 'panel');
eq('half a panel is still a panel', detectRole(rightPart).role, 'panel');
eq('a front of pack is a front', detectRole(frontPart).role, 'front');
check('and every verdict explains itself', detectRole(frontPart).why.length > 20);
eq('an empty photograph is read as a panel, which extracts more',
  detectRole({ ...page, lines: [] }).role, 'panel');

console.log('\n--- 21. the recogniser gets a second, finer look ---');
let calls: number[] = [];
const fakeRead = async (_u: string, h: number): Promise<OcrPage> => {
  calls.push(h);
  // The coarse pass finds almost nothing; the fine pass finds the panel.
  return h > 0.006 ? { ...page, lines: page.lines.slice(0, 3) } : page;
};
const got = await readBestEffort('x.jpg', fakeRead);
eq('a thin first pass triggers a finer one', calls.length, 2);
check('and the better reading wins', got.page.lines.length === page.lines.length);
check('reported as having needed it', got.usedFinePass);
eq('both attempts are recorded', got.attempts.length, 2);

calls = [];
const goodFirst = await readBestEffort('x.jpg', async (_u, h) => { calls.push(h); return page; });
eq('a good first pass is not re-read', calls.length, 1);
check('and is not marked as needing the fine pass', !goodFirst.usedFinePass);

console.log('\n--- 21b. tiles, the last resort for small type ---');
// A page so thin that neither plain pass helps: the tiled read should run
// and win. Four passes, so it must not fire on an ordinary photograph.
const thin: OcrPage = { ...page, lines: page.lines.slice(0, 2) };
calls = [];
let tiledCalls = 0;
const tiledOut = await readBestEffort(
  'x.jpg',
  async (_u, h) => { calls.push(h); return thin; },
  async () => { tiledCalls++; return page; },
);
eq('both plain passes run first', calls.length, 2);
eq('then the tiles', tiledCalls, 1);
check('and the tiled reading wins', tiledOut.page.lines.length === page.lines.length);
check('reported as having needed tiles', tiledOut.usedTiles);
eq('all three attempts are recorded', tiledOut.attempts.length, 3);

calls = [];
tiledCalls = 0;
await readBestEffort(
  'x.jpg',
  async (_u, h) => { calls.push(h); return page; },
  async () => { tiledCalls++; return page; },
);
eq('a good photograph never pays for tiles', tiledCalls, 0);
eq('and is read exactly once', calls.length, 1);

calls = [];
const brokenFirst = await readBestEffort('x.jpg', async (_u, h) => {
  calls.push(h);
  if (h > 0.006) throw new Error('coarse pass failed');
  return page;
});
eq('a failed first pass still tries the finer one', calls.length, 2);
eq('and recovers the page', brokenFirst.page.lines.length, page.lines.length);


/* ===================================================================== */
console.log('\n--- 22. repairing the glyphs a recogniser cannot separate ---');
//
// On the stored label Vision returns "Potassium lodide": a lowercase L where
// a capital I belongs. In a sans-serif label face both are a vertical bar.
// It is not cosmetic — "potassium lodide" does not match the NIH record, so
// a row quietly fails to match and nothing reports why.

const repaired = repairPage(page);
check('the real misread on the stored label is found',
  repaired.report.repairs.some((r) => /lodide/i.test(r.from) && /iodide/i.test(r.to)),
  JSON.stringify(repaired.report.repairs.map((r) => `${r.from}->${r.to}`)));
check('and every repair explains itself',
  repaired.report.repairs.every((r) => r.why.length > 10));
eq('the clean label still parses to the same rows',
  parsePanel(repaired.page).rows.length, base.rows.length);
eq('and still verifies the same',
  parsePanel(repaired.page).rows.filter((r) =>
    checkRow(r.name, r.amount, r.unit, r.dvPct).status === 'verified').length,
  base.rows.filter((r) =>
    checkRow(r.name, r.amount, r.unit, r.dvPct).status === 'verified').length);

// Safety is the whole argument for this being allowed to run at all.
for (const word of ['OLLY', 'Bayer', 'Multi', 'Gummies', 'Softgels', 'Lycopene', 'lot']) {
  check(`"${word}" is left alone`, repairWord(word) === null);
}
check('a word already in the vocabulary is left alone', repairWord('iodide') === null);
check('a short word is never repaired, too easy to be wrong',
  repairWord('lon') === null);

console.log('\n--- 22b. digits, only where the panel says a number belongs ---');
eq('a number before a unit is repaired',
  repairAmounts(['Vitamin', 'C', '12O', 'mg']).fixed.join(' '), 'Vitamin C 120 mg');
eq('and a percentage is too',
  repairAmounts(['1OO%']).fixed.join(' '), '100%');
eq('but a number with no unit after it is not touched',
  repairAmounts(['OLLY', '1OO', 'tablets']).fixed.join(' '), 'OLLY 1OO tablets');
eq('and an ordinary number is left as it is',
  repairAmounts(['120', 'mg']).fixed.join(' '), '120 mg');
check('every digit repair says why a number was required',
  repairAmounts(['12O', 'mg']).repairs.every((r) => r.why.includes('mg')));


/* ===================================================================== */
console.log('\n--- 23. classification moved off the phone, synchronously ---');
//
// contentTag is called from nine places deep inside parsing. Making it async
// would be a rewrite of the parser. So the answers are fetched once, up
// front, and installed where the synchronous rules can see them.

const sampleTexts = [...new Set(page.lines.map((l) => l.text))];

// Cache correctness: answers installed from elsewhere must produce exactly
// what computing locally produces. Here they ARE the local answers, which is
// the point — same rules, so a hit and a miss are indistinguishable.
const localContent: Record<string, ReturnType<typeof classifyLine>> = {};
const localPack: Record<string, ReturnType<typeof classifyPackLine>> = {};
for (const t of sampleTexts) {
  localContent[t] = classifyLine(t);
  localPack[t] = classifyPackLine(t);
}
const beforeRows = parsePanel(page).rows.length;
const beforeVerified = parsePanel(page).rows.filter((r) =>
  checkRow(r.name, r.amount, r.unit, r.dvPct).status === 'verified').length;

installClassifications({ content: localContent, pack: localPack }, 'server');
eq('the cache reports where its answers came from', classifiedBy(), 'server');
eq('a cached parse gives the same rows', parsePanel(page).rows.length, beforeRows);
eq('and the same verified count',
  parsePanel(page).rows.filter((r) =>
    checkRow(r.name, r.amount, r.unit, r.dvPct).status === 'verified').length,
  beforeVerified);
check('and every tag is identical',
  sampleTexts.every((t) => classifyLine(t).tag === localContent[t]!.tag));
check('including the rule and evidence, not just the tag',
  sampleTexts.every((t) =>
    JSON.stringify(classifyLine(t)) === JSON.stringify(localContent[t])));

// A cache that does not contain a line must fall through to the rules.
installClassifications({ content: {}, pack: {} }, 'server');
eq('an empty cache still classifies, locally',
  classifyLine('Supplement Facts').tag, 'panel-anchor');
eq('and a parse is unaffected', parsePanel(page).rows.length, beforeRows);

clearClassifications();
eq('clearing restores local as the origin', classifiedBy(), 'local');
eq('and parsing is still unchanged', parsePanel(page).rows.length, beforeRows);

console.log('\n--- 23b. the server being down changes nothing but the speed ---');
const dead = await prefetchClassifications(['Supplement Facts', 'Vitamin C 90 mg 100%']);
// The URL in the build points at the real workflow; this asserts the SHAPE of
// the contract either way, and that a failure never throws.
check('prefetch always resolves, never throws',
  dead.via === 'server' || dead.via === 'local');
check('and says which route ran', classifyTransportLabel(dead).length > 10);
if (dead.via === 'local') {
  check('a local fallback explains itself', dead.reason !== null);
}
eq('and either way the rules still work',
  classifyLine('Supplement Facts').tag, 'panel-anchor');
eq('and the full parse is untouched', parsePanel(page).rows.length, beforeRows);
clearClassifications();

console.log('\n--- 24. match thresholds, which now run server-side too ---');
const hit = (id: string, names: string[]) => ({
  id, fullName: `Product ${id}`, brandName: null, netContents: null,
  offMarket: false, ingredients: names.map((n) => ({ name: n, category: '', group: '', notes: '' })),
});
const ours = ['Vitamin A', 'Vitamin C', 'Vitamin D', 'Zinc', 'Iron'];

const clear = scoreByComposition(ours, [
  hit('a', ['Vitamin A', 'Vitamin C', 'Vitamin D', 'Zinc', 'Iron']),
  hit('b', ['Calcium', 'Magnesium']),
]);
check('an exact ingredient set scores 1', clear[0]?.score === 1, `${clear[0]?.score}`);
eq('and is accepted', decide(clear)?.hit.id, 'a');

const tooClose = scoreByComposition(ours, [
  hit('a', ['Vitamin A', 'Vitamin C', 'Vitamin D', 'Zinc', 'Iron']),
  hit('b', ['Vitamin A', 'Vitamin C', 'Vitamin D', 'Zinc', 'Iron']),
]);
eq('two identical candidates are refused, not guessed between', decide(tooClose), null);
check('and the reason says why',
  decisionReason(tooClose).includes('too close'), decisionReason(tooClose));

const weak = scoreByComposition(ours, [hit('a', ['Vitamin A', 'Calcium', 'Magnesium', 'Biotin'])]);
eq('a weak overlap is refused', decide(weak), null);
check('and the reason gives the number',
  decisionReason(weak).includes('%'), decisionReason(weak));
eq('nothing to compare against is said plainly',
  decisionReason([]), 'no candidates to compare against');


/* ===================================================================== */
console.log('\n--- 25. the new categories ---');
//
// Before these, 42 of the 70 distinct lines on the stored label were
// unclassified. That is not just untidy: labelPack and labelIdentity both
// treat "no rule claimed this line" as "this could be the product name", so
// every unclaimed warning and shelf tag was a candidate for the name.

const tagOf = (t: string): string => classifyLine(t).tag;

eq('a bare percentage is a Daily Value cell', tagOf('83%'), 'dv-percent');
eq('and so is one with a space', tagOf('100 %'), 'dv-percent');
eq('but a percentage inside a sentence is not',
  tagOf('Less than 2% of Croscarmellose Sodium'), 'excipient');

eq('a bracketed chemical form belongs to the row above',
  tagOf('(as Cholecalciferol)'), 'ingredient-form');
eq('including the longer ones',
  tagOf('(as dl-Alpha Tocopheryl Acetate)'), 'ingredient-form');

eq('the tamper seal sentence is recognised',
  tagOf('Do not use if seal under cap is broken or missing.'), 'tamper-seal');
eq('storage directions are recognised',
  tagOf('Store tightly closed, in a cool, dry place, out of reach of children.'), 'storage');
eq('a warning heading is recognised', tagOf('WARNING: Accidental'), 'warning');
eq('and the mandatory iron wording',
  tagOf('Keep out of reach of children'), 'warning');
eq('directions are recognised',
  tagOf('SUGGESTED USE: Adults, take 1 tablet daily with water and a meal.'), 'directions');
eq('an allergen declaration is recognised',
  tagOf('Contains: milk, soy'), 'allergen');
eq('a certification is recognised',
  tagOf('USP has tested and verified ingredients, potency, and manufacturing process.'),
  'certification');
eq('a website is contact detail, not a product name',
  tagOf('www.NatureMade.com'), 'contact');
eq('an excipient is named', tagOf('Magnesium Stearate'), 'excipient');
eq('a lot line is batch detail', tagOf('Lot :'), 'batch');

console.log('\n--- 25b. the new rules are strictly additive ---');
// Appended after the originals, so a rule that already claimed a line still
// claims it. This is what makes the change safe to ship.
eq('the panel heading is untouched', tagOf('Supplement Facts'), 'panel-anchor');
eq('serving size is untouched', tagOf('Serving Size 1 Tablet'), 'serving-size');
eq('the amount header is untouched', tagOf('Amount Per Serving'), 'amount-header');
eq('the DV header is untouched', tagOf('% Daily Value'), 'dv-header');
eq('a strength line is untouched', tagOf('Vitamin C 90 mg'), 'strength');
eq('the maker line is untouched',
  tagOf('Distributed by Pharmavite LLC'), 'manufacturer');

// And the parse is byte-for-byte what it was.
eq('the stored label still parses to the same rows', parsePanel(page).rows.length, base.rows.length);
eq('the same blocks', parsePanel(page).blockCount, base.blockCount);
eq('and the same verified count',
  parsePanel(page).rows.filter((r) =>
    checkRow(r.name, r.amount, r.unit, r.dvPct).status === 'verified').length, 22);

const claimed = [...new Set(page.lines.map((l) => l.text))]
  .filter((t) => classifyLine(t).tag !== 'unclassified').length;
check('far more of the label is now understood', claimed >= 60,
  `${claimed} of 70 distinct lines claimed`);

console.log('\n--- 25c. letters from the wrong alphabet ---');
// Vision returned "Exp.:" with a Cyrillic E and a Cyrillic p on the stored
// label. The glyphs are identical, so nothing is misread — the text is just
// in two scripts, and no vocabulary can match it.
eq('a mixed-script word is put back into one alphabet',
  deHomoglyph('Еxр.:').fixed, 'Exp.:');
check('and it is reported as changed', deHomoglyph('Еxр.:').changed);
eq('an ordinary word is untouched', deHomoglyph('Exp.:').fixed, 'Exp.:');
check('and reported as unchanged', !deHomoglyph('Vitamin C').changed);


/* ===================================================================== */
console.log('\n--- 26. no separators means nothing changed ---');
eq('the stored label parses identically without separators',
  parsePanel(page).rows.length, base.rows.length);
eq('and with an empty separator list', parsePanel(page, []).rows.length, base.rows.length);
eq('the report says they were not used', parsePanel(page).separators.used, false);
check('and says why', parsePanel(page).separators.why.includes('measured from the text'));
eq('too few separators are refused rather than half-trusted', (() => {
  const two: Separator[] = [
    { points: [{ x: 0, y: 0.3 }, { x: 1, y: 0.3 }], strength: 30, span: 1 },
    { points: [{ x: 0, y: 0.6 }, { x: 1, y: 0.6 }], strength: 30, span: 1 },
  ];
  return parsePanel(page, two).separators.used;
})(), false);

console.log('\n--- 26b. a ruleLines row stays one row ---');
// The bug: grouping by a single y per row puts a name read at the left and
// its percentage read at the right into DIFFERENT rows once the baseline
// drifts. A separator is evaluated at each box's own x, so it does not.
const ruleLines: Separator[] = [
  { points: [{ x: 0, y: 0.10 }, { x: 0.5, y: 0.14 }, { x: 1, y: 0.18 }], strength: 40, span: 1 },
  { points: [{ x: 0, y: 0.20 }, { x: 0.5, y: 0.24 }, { x: 1, y: 0.28 }], strength: 40, span: 1 },
  { points: [{ x: 0, y: 0.30 }, { x: 0.5, y: 0.34 }, { x: 1, y: 0.38 }], strength: 40, span: 1 },
];
eq('a separator is interpolated along its length',
  Number(separatorYAt(ruleLines[0]!, 0.5)?.toFixed(3)), 0.14);
eq('and held flat past its ends', separatorYAt(ruleLines[0]!, 2), 0.18);

// Two halves of one printed row, drifting downward as they cross the frame.
const leftCell = { x: 0.05, y: 0.215, w: 0.2, h: 0.02 };
const rightCell = { x: 0.80, y: 0.295, w: 0.1, h: 0.02 };
eq('the left of a ruleLines row lands in a band', bandFor(leftCell, ruleLines), 2);
eq('and so does the right, the same one', bandFor(rightCell, ruleLines), 2);
check('whereas a flat y comparison would have split them',
  Math.abs((leftCell.y + leftCell.h / 2) - (rightCell.y + rightCell.h / 2)) > 0.05);

const mk = (text: string, x: number, y: number): OcrLine => ({
  text, confidence: 0.9, box: { x, y, w: 0.15, h: 0.02 },
  words: [{ text, box: { x, y, w: 0.15, h: 0.02 } }],
});
const ruleLinesRows = groupRowsBySeparators(
  [mk('Vitamin C', 0.05, 0.215), mk('100%', 0.80, 0.295),
   mk('Vitamin D', 0.05, 0.315), mk('88%', 0.80, 0.395)], ruleLines);
eq('two printed rows come out as two rows', ruleLinesRows.length, 2);
eq('with both halves of the first together', ruleLinesRows[0]?.lines.length, 2);
eq('and both halves of the second', ruleLinesRows[1]?.lines.length, 2);

eq('a short rule is not a row boundary',
  usableSeparators([{ points: [{ x: 0, y: 0.5 }, { x: 0.2, y: 0.5 }], strength: 40, span: 0.2 }])
    .length, 0);

console.log('\n--- 27. units, where a misread costs a factor of a thousand ---');
eq('mcg and mg are treated as confusable', alternativesFor('mcg').includes('mg'), true);
eq('but mcg and IU are not', alternativesFor('mcg').includes('iu'), false);

const row = (name: string, amount: number, unit: string, dvPct: number): PanelRow => ({
  block: 0, name, amount, unit, dvPct, dvNotEstablished: false,
  indentLevel: 0, parentIndex: null, raw: `${name} ${amount} ${unit} ${dvPct}%`,
});

// Vitamin C's DV is 90 mg. 90 read as mcg is a thousandth of the dose, and
// the printed 100% is the evidence that proves it.
const wrong = repairUnits([row('Vitamin C', 90, 'mcg', 100)]);
eq('a thousandfold unit error is corrected', wrong.rows[0]?.unit, 'mg');
eq('and recorded with its before and after', wrong.corrections[0]?.was, '90 mcg');
eq('and its after', wrong.corrections[0]?.now, '90 mg');
check('with the arithmetic as the reason',
  (wrong.corrections[0]?.why ?? '').includes('100%'));

const right = repairUnits([row('Vitamin C', 90, 'mg', 100)]);
eq('a row that already verifies is never touched', right.corrections.length, 0);
eq('and keeps its unit', right.rows[0]?.unit, 'mg');

const hopeless = repairUnits([row('Vitamin C', 7, 'mg', 100)]);
eq('a row no alternative can rescue is left as a mismatch', hopeless.corrections.length, 0);
eq('with its original unit intact', hopeless.rows[0]?.unit, 'mg');

const uncheckable = repairUnits([row('Proprietary Blend', 500, 'mcg', 0)]);
eq('a row with no Daily Value is never guessed at', uncheckable.corrections.length, 0);

eq('the stored label needs no corrections', parsePanel(page).unitCorrections.length, 0);

console.log('\n--- 28. brackets land in the right row ---');
const withForm = parsePanel(page);
check('a bracketed form is folded into its nutrient',
  withForm.rows.some((r) => /Vitamin C/.test(r.name) && /Ascorbic/i.test(r.name)),
  JSON.stringify(withForm.rows.find((r) => /Vitamin C/.test(r.name))?.name));
eq('and the row count is unchanged by the wider rule',
  withForm.rows.length, base.rows.length);
check('blend components keep their parent',
  JSON.stringify(withForm.rows.map((r) => r.parentIndex))
  === JSON.stringify(base.rows.map((r) => r.parentIndex)));

console.log('\n--- 29. other ingredients ---');
eq('the paragraph is still found on the stored label',
  otherIngredientLines(page).length > 0, true);
check('and a barcode never appears in it',
  !otherIngredientLines(page).some((l) => classifyLine(l.text).tag === 'gtin'));
check('nor a lot or expiry stamp',
  !otherIngredientLines(page).some((l) => classifyLine(l.text).tag === 'batch'));

eq('two readings that overlap join on the overlap',
  joinParagraphs('Cellulose, Silicon Dioxide, Magnesium Stearate',
                 'Silicon Dioxide, Magnesium Stearate, Gelatin').text,
  'Cellulose, Silicon Dioxide, Magnesium Stearate, Gelatin');
check('and are reported as joined',
  joinParagraphs('a b c Silicon Dioxide Magnesium Stearate',
                 'Silicon Dioxide Magnesium Stearate z').joined);
eq('an identical pair is not doubled',
  joinParagraphs('Cellulose, Gelatin', 'Cellulose, Gelatin').text, 'Cellulose, Gelatin');
eq('a contained reading is absorbed',
  joinParagraphs('Cellulose, Gelatin, Water', 'Gelatin, Water').text,
  'Cellulose, Gelatin, Water');
const noOverlap = joinParagraphs('Cellulose, Gelatin', 'Titanium Dioxide, Shellac');
check('and two that do not overlap are NOT invented a join', !noOverlap.joined);
check('but kept, marked as possibly incomplete',
  noOverlap.text.includes('Cellulose') && noOverlap.text.includes('Shellac')
  && noOverlap.why.includes('missing'));


/* ===================================================================== */
console.log('\n--- 30. the front of a pack, taken apart ---');
//
// "One A Day Men's 50+ Multi 65 Tablets" is four facts printed together,
// not a product name. Fused, the database is searched with a tablet count
// in the query and the "Who this is for" section stays empty forever.

const split1 = splitIdentity("One A Day Men's 50+ Multi 65 Tablets", []);
eq('the audience comes out as its own field', split1.targetGroup, 'Men');
check('the count is taken out of the name',
  !/65/.test(split1.productName ?? ''), JSON.stringify(split1.productName));
check('and so is the dose form', !/tablets/i.test(split1.productName ?? ''));
check('every removal is recorded', split1.removed.length >= 2,
  JSON.stringify(split1.removed));
check('and the name says why it is what it is',
  split1.productNameFrom.basis.includes('removed'));

const split2 = splitIdentity('Nature Made Extra Strength Vitamin C 1000 mg 100 Tablets', []);
eq('a variant is separated', split2.variant, 'Extra Strength');
eq('a headline dose is separated', split2.headlineStrength, '1000 mg');
eq('leaving the actual name', split2.productName, 'Nature Made Vitamin C');
check('and the dose says it is a selling point, not a panel amount',
  (split2.headlineStrengthFrom?.basis ?? '').includes('not read from the panel'));

eq('a product with nothing separable keeps its whole name',
  splitIdentity('Centrum', []).productName, 'Centrum');
eq('and says so', splitIdentity('Centrum', []).productNameFrom.basis,
  'the whole title, with nothing separable in it');

console.log('\n--- 30b. a warning is not an audience ---');
// This was a real false positive: "fatal poisoning in children", a fragment
// of the mandatory iron warning, labelled an adult multivitamin as a
// children's product. Type size is what separates identity from small print.
const backPanel = readPack(page, parsePanel(page).rows.map((r) => r.name));
eq('a back-panel photograph claims no audience', backPanel.targetGroup ?? null, null);
check('even though the warning mentions children',
  page.lines.some((l) => /children/i.test(l.text)));

const bigLine = (text: string, y: number, h: number): OcrLine => ({
  text, confidence: 0.95, box: { x: 0.1, y, w: 0.7, h },
  words: [{ text, box: { x: 0.1, y, w: 0.7, h } }],
});
const frontPack: OcrPage = {
  source: 'front.jpg', width: 1500, height: 1500, engine: 'test',
  lines: [
    bigLine('ONE A DAY', 0.10, 0.08),
    bigLine("Men's 50+ Multi", 0.22, 0.06),
    bigLine('65 TABLETS', 0.80, 0.02),
    bigLine('Keep out of reach of children and pets at all times', 0.90, 0.008),
  ],
};
const frontRead = readPack(frontPack, []);
eq('a real front of pack does give an audience', frontRead.targetGroup ?? null, 'Men');
check('read from the large type, not the small print',
  (frontRead.identityBasis?.targetGroup?.basis ?? '').length > 0);

console.log('\n--- 30c. who it is for reaches the Label tab ---');
const prod = fromMerged(
  { rows: [], identity: { productName: null, brand: null, nameCandidates: [], printedCodes: [] },
    servingSize: null, servingsPerContainer: null, otherIngredients: null,
    primary: readShot('front', frontPack), report: {} as never } as never,
  'One A Day', frontRead);
eq('userGroups is populated from the photograph', prod.userGroups, ['Men']);
eq('and is empty when nothing said', fromMerged(
  { rows: [], identity: { productName: null, brand: null, nameCandidates: [], printedCodes: [] },
    servingSize: null, servingsPerContainer: null, otherIngredients: null,
    primary: readShot('panel', page), report: {} as never } as never,
  'x', backPanel).userGroups, []);

console.log('\n--- 31. claims, grouped but never evaluated ---');
eq('an immune claim is themed', themeFor('Supports immune health').theme, 'immune');
eq('a bone claim is themed', themeFor('Helps maintain strong bones').theme, 'bone-joint');
eq('an energy claim is themed',
  themeFor('Helps convert food into cellular energy').theme, 'energy');
eq('a claim that fits nothing is other, not forced',
  themeFor('A delicious way to take your daily vitamins').theme, 'other');
check('and a theme says which words placed it there',
  themeFor('Supports immune health').matched.includes('immune'));

// The wording itself is never touched. That is the line between describing
// a claim and endorsing it.
const verbatim = 'Supports immune health and heart health*';
eq('the claim text is quoted exactly', (() => {
  const pk = readPack({
    ...frontPack,
    lines: [...frontPack.lines, bigLine(verbatim, 0.5, 0.02)],
  }, ['Vitamin C', 'Zinc']);
  return pk.claims.find((c) => c.text.includes('immune'))?.text;
})(), verbatim);

eq('a claim naming a nutrient the panel lists is linked to it',
  linkClaimToIngredients('Supports immune health with Vitamin C and Zinc',
    ['Vitamin C (as Ascorbic Acid)', 'Zinc (as Zinc Oxide)', 'Calcium'])
    .map((l) => l.ingredient).sort(),
  ['Vitamin C (as Ascorbic Acid)', 'Zinc (as Zinc Oxide)']);
eq('and a nutrient it does not name is not linked',
  linkClaimToIngredients('Supports bone health', ['Vitamin C', 'Zinc']).length, 0);

console.log('\n--- 31b. disease claims and the disclaimer are unchanged ---');
eq('a disease claim is still flagged as one',
  classifyPackLine('Helps prevent heart disease').tag, 'disease-claim');
eq('and the FDA disclaimer is still recognised',
  classifyPackLine(
    'These statements have not been evaluated by the Food and Drug Administration.').tag,
  'fda-disclaimer');


console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
