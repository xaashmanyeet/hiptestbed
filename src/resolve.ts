// The resolution ladder.
//
// Each rung is tried in order, from most certain to least, and every rung
// records WHAT IT DID and WHY IT STOPPED. A rung that fails for want of input
// is not the same as one that ran correctly and found nothing, and the two
// must never be shown to a person as the same thing: telling someone their
// product is unknown when we never actually asked is the failure mode this
// whole structure exists to prevent.
//
// Nothing here guesses, and nothing auto-confirms. The last word is a human's.
//
// ONE PHOTOGRAPH OR SEVERAL. The ladder takes a list of photographs, each
// tagged with what it was framed for. A single panel shot is a list of one
// and goes down exactly the same path, so there is no second, less-tested
// route through the app.

import type { OcrPage } from './labelOcr';
import { contentTag } from './labelLineClassification';
import { findColumnBlocks } from './labelPanelLayout';
import {
  mergeShots, readShot,
  type CaptureStep, type MergedLabel, type ShotReading,
} from './labelMerge';
import { searchQueries, type LabelIdentity } from './labelIdentity';
import { mergePacks, readPack, type PackReading } from './labelPack';
import { checkRow } from './dailyValues';
import { searchDsld, fetchDsldLabel, type DsldHit } from './dsld';
import { lastTransport } from './lookupTransport';
import { fromMerged, type LabelProduct } from './product';
import { recognizeText, textRecognitionAvailable } from '../modules/hip-text-recognition';

export { normaliseIngredient } from './labelTextNormalize';
import { combinePages } from './labelOcrQuality';
import { joinParagraphs } from './labelPanelParse';
import type { Separator } from './labelSeparators';
import { lastPackTransport, packTransportLabel, tryServerPack } from './packTransport';
import { decide, scoreByComposition } from './compositionMatch';
import { classifyTransportLabel, prefetchClassifications } from './classifyTransport';
import { tryServerMatch, type ServerMatch } from './matchTransport';
import { normaliseIngredient } from './labelTextNormalize';

export type Outcome =
  | 'ok'                      // the rung answered
  | 'partial'                 // it produced something incomplete, on purpose
  | 'not-attempted'           // its precondition was absent
  | 'unreadable-input'        // the input is not the kind of thing it reads
  | 'infrastructure-failure'  // the call itself failed: network, timeout
  | 'genuine-no-match'        // it ran correctly and found nothing
  | 'needs-human';            // only a person can settle it

export type StageId =
  | 'read' | 'classify' | 'pack' | 'panel' | 'merge' | 'verify'
  | 'identity' | 'name-match' | 'composition-match'
  | 'from-label' | 'assisted' | 'confirm';

export interface Stage {
  id: StageId;
  title: string;
  /** What this rung is for, in one line. */
  purpose: string;
  outcome: Outcome;
  detail: string;
  /** Deterministic = same input, same answer, always. */
  deterministic: boolean;
}

/** One photograph on its way in: already read, or still just a file path. */
export interface CaptureInput {
  step: CaptureStep;
  uri: string;
  /** Supplied when the capture screen already recognised it, to avoid reading twice. */
  page?: OcrPage;
  /** The printed rules found on this photograph, when the detector ran. */
  separators?: readonly Separator[];
}

export interface Resolution {
  stages: Stage[];
  product: LabelProduct | null;
  answeredBy: StageId | null;
  candidates: DsldHit[];
  identity: LabelIdentity | null;
  /** The photograph treated as "the label" for identity purposes. */
  page: OcrPage | null;
  /**
   * Every photograph's lines in one page, for the line and rule views.
   *
   * Those views used to be handed a single photograph, so on a three-shot
   * capture two of them were invisible — unacceptable in an app whose job
   * is to show what was actually read.
   */
  allPages: OcrPage | null;
  /** Every photograph that was read, in capture order. */
  shots: ShotReading[];
  /** Null when nothing could be read at all. */
  merged: MergedLabel | null;
  /** Everything the packaging says, panel or no panel. */
  pack: PackReading | null;
  /**
   * Which machine classified the lines, and why if it was not the server.
   * Carried so exported test data says where each result came from — a
   * fallback nobody notices is a server outage nobody notices.
   */
  classifiedOn: 'server' | 'local';
}

/* ------------------------------------------------- composition matching --- */

// Moved to compositionMatch.ts so the identical code can run on the server.
// Re-exported here so every existing caller and test is untouched.
export {
  scoreByComposition, decide, decisionReason,
  ACCEPT_SCORE, ACCEPT_MARGIN, type CompositionScore,
} from './compositionMatch';

// Below these a read is not a bad panel, it is a bad photograph.
const MIN_PLAUSIBLE_LINES = 5;
const MIN_PLAUSIBLE_WORDS = 12;

/* ----------------------------------------------------------- the ladder --- */

const stage = (
  id: StageId, title: string, purpose: string,
  outcome: Outcome, detail: string, deterministic: boolean,
): Stage => ({ id, title, purpose, outcome, detail, deterministic });

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** One photograph of the Supplement Facts panel — the ordinary case. */
export async function resolveFromPhoto(uri: string): Promise<Resolution> {
  return resolveFromShots([{ step: 'panel', uri }]);
}

export async function resolveFromShots(inputs: readonly CaptureInput[]): Promise<Resolution> {
  const stages: Stage[] = [];
  const empty = (shots: ShotReading[] = []): Resolution => ({
    stages, product: null, answeredBy: null, candidates: [],
    identity: null, page: shots[0]?.page ?? null,
    allPages: combinePages(shots.map((sh) => sh.page)), shots, merged: null,
    classifiedOn: 'local',
    pack: shots.length > 0 ? mergePacks(shots.map((sh) => readPack(sh.page))) : null,
  });

  /* 1 — read ------------------------------------------------------------- */
  if (inputs.length === 0) {
    stages.push(stage('read', 'Read the text', 'Apple Vision, on this device',
      'not-attempted', 'No photograph was supplied.', false));
    return empty();
  }
  // An already-recognised photograph needs no native module; only a fresh
  // file path does.
  if (!textRecognitionAvailable() && inputs.some((i) => i.page === undefined)) {
    stages.push(stage('read', 'Read the text', 'Apple Vision, on this device',
      'not-attempted', 'This build has no native text recognition.', false));
    return empty();
  }

  // READ EVERY PHOTOGRAPH FIRST, THEN CLASSIFY, THEN PARSE.
  //
  // The order matters and it is the only structural change the server-side
  // classification needed. Parsing calls contentTag synchronously from nine
  // places, so the answers have to already be in hand before the first parse
  // begins — which means one batched request here rather than a network call
  // buried inside the rules.
  const read: { step: CaptureStep; page: OcrPage; seps: readonly Separator[] }[] = [];
  const failures: string[] = [];
  for (const input of inputs) {
    const seps = input.separators ?? [];
    if (input.page !== undefined) {
      read.push({ step: input.step, page: input.page, seps });
      continue;
    }
    try {
      read.push({ step: input.step, page: await recognizeText(input.uri), seps });
    } catch (e) {
      failures.push(`${input.step}: ${e instanceof Error ? e.message : 'the reader failed'}`);
    }
  }

  // One request for every distinct line across every frame. Falls back to
  // the local rules on any failure, and says which happened.
  const transport = await prefetchClassifications(
    read.flatMap((r) => r.page.lines.map((l) => l.text)));

  const shots: ShotReading[] = read.map((r) => readShot(r.step, r.page, r.seps));

  if (shots.length === 0) {
    stages.push(stage('read', 'Read the text', 'Apple Vision, on this device',
      'infrastructure-failure', failures.join('; ') || 'The reader failed.', false));
    return empty();
  }

  const totalLines = shots.reduce((n, sh) => n + sh.page.lines.length, 0);
  const totalWords = shots.reduce(
    (n, sh) => n + sh.page.lines.reduce((m, l) => m + l.words.length, 0), 0);

  // A thin read is a bad photograph, not a bad panel, and saying so here is
  // kinder than letting it fail three rungs later with a message blaming the
  // panel. But it is NOT a reason to stop: whatever few words came back are
  // still worth classifying, showing and saving. A scan that produced nothing
  // useful is exactly the scan worth keeping, because it is the one that needs
  // diagnosing.
  const thin = totalLines < MIN_PLAUSIBLE_LINES || totalWords < MIN_PLAUSIBLE_WORDS;

  stages.push(stage('read', 'Read the text', 'Apple Vision, on this device',
    thin ? 'unreadable-input' : failures.length > 0 ? 'partial' : 'ok',
    thin
      ? `Only ${plural(totalLines, 'line')} and ${plural(totalWords, 'word')} came back`
        + `${shots.length > 1 ? ` across ${plural(shots.length, 'photograph')}` : ''}. `
        + 'A panel has dozens. Hold the phone square to the label, fill the frame, '
        + 'and avoid glare.'
      : `${plural(shots.length, 'photograph')}, ${plural(totalLines, 'line')}, `
        + `${plural(totalWords, 'word')}, nothing left the phone.`
        + (failures.length > 0 ? ` Could not read ${failures.join('; ')}.` : ''),
    false));

  /* 2 — classify --------------------------------------------------------- */
  const claimed = shots.reduce(
    (n, sh) => n + sh.page.lines.filter((l) => contentTag(l.text) !== 'unclassified').length, 0);
  stages.push(stage('classify', 'Identify each line', 'Rules on regulated wording and patterns',
    'ok',
    `${claimed} of ${totalLines} lines claimed by a rule. `
    + classifyTransportLabel(transport),
    true));

  /* 3 — the packaging ----------------------------------------------------- */
  // The panel rows are handed to the packaging reader so a claim that names
  // a nutrient can be associated with the one actually listed. Descriptive
  // linkage only — it says the two appear on the same label, nothing more.
  // Tried on the server, which runs these same rules from the same source.
  // On any failure the local reading below runs unchanged.
  const servedPack = await tryServerPack(shots.map((sh) => sh.page));
  const pack = servedPack ?? mergePacks(shots.map((sh) =>
    readPack(sh.page, sh.panel.rows.map((r) => r.name))));
  const benefitCount = pack.claims.filter((c) => c.kind === 'benefit').length;
  stages.push(stage('pack', 'Read the packaging',
    'Name, claims and regulated statements outside the panel',
    pack.verdict === 'not-a-supplement' ? 'genuine-no-match'
      : pack.verdict === 'confirmed' ? 'ok' : 'partial',
    `${packTransportLabel(lastPackTransport)} `
    + `${pack.claimed} of ${pack.outsidePanel} lines outside the panel claimed by a rule. `
    + `${pack.title === null ? 'No product name found' : `Name: ${pack.title}`}`
    + `${pack.brand === null ? '' : ` · ${pack.brand}`}. `
    + `${benefitCount} advertised benefit${benefitCount === 1 ? '' : 's'}`
    + `${benefitCount > 0 && !pack.disclaimerPresent
        ? ', with the required FDA disclaimer NOT in frame' : ''}. `
    + `Supplement: ${pack.verdict}.`,
    true));

  /* 4 — panel ------------------------------------------------------------ */
  const withPanel = shots.filter((sh) => sh.panel.found);
  const blockCount = shots.reduce((n, sh) => n + findColumnBlocks(sh.page).length, 0);
  const rowsSeen = shots.reduce((n, sh) => n + sh.panel.rows.length, 0);
  const excluded = shots.reduce((n, sh) => n + sh.panel.excludedLines, 0);

  if (withPanel.length === 0) {
    stages.push(stage('panel', 'Rebuild the panel', 'Find the tables, then the rows',
      'unreadable-input',
      'No "Amount Per Serving" and "% Daily Value" pair in any photograph, '
      + 'so this is not a standard Supplement Facts panel.',
      true));
  } else {
    // Say whether the label's own printed rules decided the rows, or whether
    // they were measured from the text. The two behave differently on a
    // curved bottle and the difference should not be invisible.
    const sepNote = shots.map((sh) => sh.panel.separators).find((r) => r.used)
      ?? shots[0]?.panel.separators;
    const units = shots.flatMap((sh) => sh.panel.unitCorrections);
    stages.push(stage('panel', 'Rebuild the panel', 'Find the tables, then the rows',
      rowsSeen > 0 ? 'ok' : 'genuine-no-match',
      `${plural(blockCount, 'table')}, ${plural(rowsSeen, 'row')}, `
      + `${plural(excluded, 'line')} outside the panel.`
      + (sepNote === undefined ? '' : ` ${sepNote.why}.`)
      + (units.length === 0
        ? ''
        : ` ${plural(units.length, 'unit')} corrected: `
          + `${units.map((u) => `${u.ingredient} ${u.was} → ${u.now}`).join('; ')}.`),
      true));
  }

  /* 5 — merge ------------------------------------------------------------ */
  const merged = mergeShots(shots);

  // The "Other ingredients" paragraph often runs across two photographs,
  // and mergeShots picks ONE reading per field — correct for a serving size,
  // wrong for a paragraph, where the second frame holds the end of a
  // sentence the first one started. Joined here rather than inside the
  // merge, so the arbitration that settles every other field is untouched.
  let paragraphNote: string | null = null;
  const paragraphs = shots
    .map((sh) => sh.panel.otherIngredients)
    .filter((t): t is string => t !== null && t.trim().length > 0);
  if (paragraphs.length > 1) {
    let acc = paragraphs[0]!;
    let allJoined = true;
    for (const next of paragraphs.slice(1)) {
      const got = joinParagraphs(acc, next);
      acc = got.text;
      if (!got.joined) allJoined = false;
      paragraphNote = got.why;
    }
    merged.otherIngredients = acc;
    if (!allJoined) {
      paragraphNote = 'the other-ingredients readings did not overlap, '
        + 'so part of the paragraph may be missing';
    }
  }
  const panelRows = merged.rows;

  if (shots.length === 1) {
    stages.push(stage('merge', 'Combine the photographs',
      'Settle disagreements between pictures of the same bottle',
      'not-attempted', 'Only one photograph, so there is nothing to reconcile.', true));
  } else {
    const contributed = Object.entries(merged.report.contributed)
      .map(([step, n]) => `${n} only seen in the ${step} shot`);
    const fieldConflicts = merged.report.fields.filter((f) => f.rejected.length > 0).length;
    stages.push(stage('merge', 'Combine the photographs',
      'Settle disagreements between pictures of the same bottle',
      'ok',
      `${plural(shots.length, 'photograph')} merged into ${plural(panelRows.length, 'row')}. `
      + `${merged.report.replaced} replaced because another photograph's reading `
      + `passed the arithmetic check and the first did not`
      + (contributed.length > 0 ? `; ${contributed.join(', ')}` : '')
      + (fieldConflicts > 0 ? `; ${plural(fieldConflicts, 'field')} disagreed` : '')
      + '.',
      true));
  }

  /* 6 — verify ----------------------------------------------------------- */
  const checks = panelRows.map((r) => checkRow(r.name, r.amount, r.unit, r.dvPct));
  const verified = checks.filter((c) => c.status === 'verified').length;
  const mismatch = checks.filter((c) => c.status === 'mismatch').length;
  stages.push(stage('verify', 'Check the arithmetic', 'Amount against the published Daily Value',
    panelRows.length === 0 ? 'not-attempted' : mismatch > 0 ? 'partial' : 'ok',
    panelRows.length === 0
      ? 'No rows to check.'
      : `${verified} verified, ${mismatch} disagree, of ${panelRows.length}.`, true));

  /* 7 — identity --------------------------------------------------------- */
  // The pack reader finds the name by eliminating everything a rule can claim,
  // which is strictly more evidence than font size alone. Prefer it.
  const identity: LabelIdentity = {
    ...merged.identity,
    productName: pack.title ?? merged.identity.productName,
    brand: pack.brand ?? merged.identity.brand,
  };
  const queries = searchQueries(identity);
  stages.push(stage('identity', 'Work out what it is called', 'Largest text, and the "distributed by" line',
    queries.length === 0 ? 'genuine-no-match' : 'ok',
    queries.length === 0
      ? 'Nothing on the front of the label looked like a product name.'
      : `${identity.productName ?? 'unknown product'} · ${identity.brand ?? 'unknown brand'}`,
    true));

  /* 8 — name match ------------------------------------------------------- */
  //
  // Tried on the server first: it searches and scores in one request, where
  // the phone would search, score, then fetch. On any failure the original
  // path below runs untouched, so an outage costs a round trip, not a match.
  let candidates: DsldHit[] = [];
  const served: ServerMatch | null = queries.length === 0
    ? null
    : await tryServerMatch(queries, panelRows.map((r) => r.name));

  if (served !== null) {
    candidates = served.candidates;
    stages.push(stage('name-match', 'Search by name', 'The NIH label database',
      candidates.length > 0 ? 'ok' : 'genuine-no-match',
      (candidates.length > 0
        ? `${candidates.length} candidates for "${queries[0]}".`
        : `Nothing in the database matched "${queries[0]}".`)
      + ` Searched and scored on the server in ${served.ms} ms.`, true));
  } else if (queries.length === 0) {
    stages.push(stage('name-match', 'Search by name', 'The NIH label database',
      'not-attempted', 'No name to search with.', true));
  } else {
    try {
      for (const q of queries) {
        candidates = [...candidates, ...(await searchDsld(q, 12))];
        if (candidates.length >= 12) break;
      }
      const seen = new Set<string>();
      candidates = candidates.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)));
      // Say which route the lookup took. When the workflow is unreachable the
      // app silently falls back, and silent fallbacks are how you end up not
      // knowing your server has been down for a week.
      const via = lastTransport.via === 'n8n'
        ? ' Via the n8n workflow.'
        : ` Direct to NIH — ${lastTransport.reason ?? 'workflow not used'}.`;
      stages.push(stage('name-match', 'Search by name', 'The NIH label database',
        candidates.length > 0 ? 'ok' : 'genuine-no-match',
        (candidates.length > 0
          ? `${candidates.length} candidates for "${queries[0]}".`
          : `Nothing in the database matched "${queries[0]}".`) + via, true));
    } catch (e) {
      stages.push(stage('name-match', 'Search by name', 'The NIH label database',
        'infrastructure-failure',
        e instanceof Error ? e.message : 'The database could not be reached.', true));
    }
  }

  /* 9 — composition match ------------------------------------------------ */
  let answeredBy: StageId | null = null;
  let product: LabelProduct | null = null;

  if (candidates.length === 0 || panelRows.length === 0) {
    stages.push(stage('composition-match', 'Match the ingredient set',
      'Compare what is in it, not what it is called',
      'not-attempted',
      candidates.length === 0 ? 'No candidates to compare against.' : 'No ingredients read to compare.',
      true));
  } else {
    // The server already scored these with the same code and the same
    // thresholds, so its verdict is taken rather than recomputed. Scoring
    // again here would be identical work for an identical answer.
    const scores = served !== null && served.winner !== null
      ? [{
          hit: candidates.find((c) => c.id === served.winner!.id) ?? candidates[0]!,
          score: served.winner.score,
          shared: served.winner.shared,
        }]
      : scoreByComposition(panelRows.map((r) => r.name), candidates);
    const winner = served !== null
      ? (served.winner === null ? null : scores[0] ?? null)
      : decide(scores);
    const top = scores[0];
    if (winner !== null) {
      try {
        product = await fetchDsldLabel(winner.hit.id);
        answeredBy = 'composition-match';
        stages.push(stage('composition-match', 'Match the ingredient set',
          'Compare what is in it, not what it is called', 'ok',
          `${winner.hit.fullName} — ${winner.shared} ingredients in common, ` +
          `${Math.round(winner.score * 100)}% overlap.`, true));
      } catch {
        stages.push(stage('composition-match', 'Match the ingredient set',
          'Compare what is in it, not what it is called', 'infrastructure-failure',
          'Matched, but the full record could not be fetched.', true));
      }
    } else {
      stages.push(stage('composition-match', 'Match the ingredient set',
        'Compare what is in it, not what it is called', 'needs-human',
        top === undefined
          ? 'No candidate shared enough ingredients.'
          : `Best was ${Math.round(top.score * 100)}% overlap — below the bar, or too close to the runner-up. ` +
            'A person should choose.', true));
    }
  }

  /* 10 — build from the label itself -------------------------------------- */
  // Anything at all that a person could look at. A front-of-pack photograph
  // has no ingredient rows and is still a useful reading: a name, a brand, the
  // claims, the directions. Refusing to build a product from it was why such a
  // photograph used to vanish without trace.
  const packHasContent = pack.claimed > 0 || pack.title !== null || pack.brand !== null;

  if (product === null && (panelRows.length > 0 || packHasContent)) {
    // A panel-only photograph often has no product name on it at all. The
    // regulated "Distributed by" line is still there, and a saved scan listed
    // under its brand is far more use later than a list of "Scanned label".
    const title = identity.productName
      ?? (identity.brand !== null ? `${identity.brand} (name not on this photo)` : 'Scanned label');
    product = fromMerged(merged, title, pack);
    answeredBy = 'from-label';
    stages.push(stage('from-label', 'Build it from the label', 'Use what is printed, flagged as such',
      panelRows.length > 0 ? 'ok' : 'partial',
      panelRows.length > 0
        ? `${plural(panelRows.length, 'ingredient')} taken straight from the photograph`
          + `${shots.length > 1 ? 's' : ''}.`
        : 'No ingredient panel in frame, so this is built from the packaging alone '
          + '— name, brand, claims and the printed statements.', true));
  } else if (product === null) {
    stages.push(stage('from-label', 'Build it from the label', 'Use what is printed, flagged as such',
      'genuine-no-match',
      'Nothing on this photograph could be read as a label: no panel, no name, '
      + 'and no regulated statement.', true));
  }

  /* 11 — assisted -------------------------------------------------------- */
  stages.push(stage('assisted', 'Ask a model', 'Last resort, for what rules could not settle',
    'not-attempted',
    'Deliberately not wired up. A model would need a server-side key, and its output ' +
    'would feed a search, never be stored as fact.', false));

  /* 12 — confirm --------------------------------------------------------- */
  stages.push(stage('confirm', 'You confirm', 'Nothing is saved until a person says so',
    product === null ? 'not-attempted' : 'needs-human',
    product === null ? 'Nothing to confirm.' : 'Review the rebuilt label and accept or correct it.',
    true));

  return {
    stages, product, answeredBy, candidates, identity,
    page: merged.primary.page,
    allPages: combinePages(shots.map((sh) => sh.page)), shots, merged, pack,
    classifiedOn: transport.via,
  };
}
