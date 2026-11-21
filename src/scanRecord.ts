// What gets written to disk for every scan, and why it is this and not less.
//
// The temptation is to save the RESULT — the rebuilt panel, the rows, the
// verdict. That is the useless half. When a scan goes wrong the result only
// tells you THAT it went wrong; the raw recognised text, with every word's
// position, is what lets the failure be reproduced away from the phone and
// fixed. Diagnosing one bad label by reconstructing it from a screenshot took
// the better part of an hour. The same bug, with this file in hand, is a
// couple of minutes, and the file then stays as a permanent test case.
//
// So the record holds, for every photograph taken:
//   - the full OcrPage: every line, every word, every bounding box
//   - what the parser made of it, per photograph and after merging
//   - every rung of the ladder and what it said
//
// It is deliberately a plain JSON object with no classes and no references,
// so it survives JSON.stringify/parse unchanged and can be replayed by any
// program on any machine.

import type { CylinderCalibration, CylinderReport } from './labelCylinder';
import { unrollAndJoin } from './labelCylinder';
import type { DailyValueCheck } from './dailyValues';
import { checkRow } from './dailyValues';
import type { LabelIdentity } from './labelIdentity';
import type { CaptureStep, MergeReport } from './labelMerge';
import type { OcrPage } from './labelOcr';
import type { PackReading, SupplementVerdict } from './labelPack';
import type { PanelRow } from './labelPanelParse';
import type { LabelProduct } from './product';
import type { Outcome, Resolution, Stage, StageId } from './resolve';

/** Bumped whenever the shape changes, so an old file is never misread as new.
 *  2 added the packaging reading and the surface field. A version-1 record has
 *  no `pack`, so rather than render half of one it is ignored and pruned.
 *  3 added `cylinder` on a shot, for a panel assembled from several frames of
 *  a round bottle. The field is optional and nothing reads it unless it is
 *  there, so a version-2 record replays through this code unchanged — which
 *  it must, because those records are the regression suite for everything
 *  else in the pipeline. */
export const SCAN_FORMAT = 3;

/**
 * The frames behind a panel shot that was assembled from a round bottle.
 *
 * The JOINED page is stored on the shot as usual, so every existing reader —
 * the line views, the rule views, replayInputs — carries on working without
 * knowing a cylinder was involved. What is kept here is the input to that
 * join: the raw per-frame readings and the calibration they were shot
 * through. Without them a bad join could only be looked at, never re-run, and
 * re-running it against changed code is the entire point of saving scans.
 */
export interface CylinderRecord {
  frames: OcrPage[];
  calibrations: CylinderCalibration[];
  report: CylinderReport;
}

export interface ScanShotRecord {
  step: CaptureStep;
  /** File name of the photograph inside this scan's folder, when it was kept. */
  photo: string | null;
  /** The raw reading. This is the field that makes the record worth keeping. */
  page: OcrPage;
  /** What this photograph alone produced, before merging. */
  rows: PanelRow[];
  identity: LabelIdentity;
  /** Present only when this shot was assembled from a sweep round a bottle. */
  cylinder?: CylinderRecord | null;
}

export interface ScanRecord {
  format: number;
  id: string;
  capturedAt: string;
  engine: string;
  title: string;
  shots: ScanShotRecord[];
  stages: Stage[];
  answeredBy: StageId | null;
  merge: MergeReport | null;
  mergedRows: PanelRow[];
  /** Name, claims and regulated statements from outside the panel. */
  pack: PackReading | null;
  checks: DailyValueCheck[];
  product: LabelProduct | null;
  /** What the photographed surface was: flat, curved, or something else. */
  surface: string | null;
  /** Free text, when the surface was "other". */
  note: string | null;
  /**
   * Which machine classified the lines.
   *
   * Optional and additive, so SCAN_FORMAT stays at 3 and every existing
   * record still replays — but exported test data now says whether a result
   * came from the server or from the phone, which is the difference between
   * measuring the pipeline and guessing at it.
   */
  classifiedOn?: 'server' | 'local';
}

/** The cheap part, written separately so listing scans does not parse megabytes. */
export interface ScanSummary {
  format: number;
  id: string;
  capturedAt: string;
  title: string;
  shots: number;
  /** File name of a photograph to show in the list, when one was kept. */
  thumb: string | null;
  lines: number;
  rows: number;
  verified: number;
  mismatched: number;
  /** The worst outcome any rung reported — what went wrong, at a glance. */
  worstOutcome: Outcome;
  answeredBy: StageId | null;
  surface: string | null;
  note: string | null;
  /** How sure the reading is that this is a supplement at all. */
  verdict: SupplementVerdict | null;
  claims: number;
}

/** Sortable, filesystem-safe, and unique to the millisecond. */
export function scanId(when: Date = new Date()): string {
  return when.toISOString().replace(/[:.]/g, '-');
}

const SEVERITY: Readonly<Record<Outcome, number>> = {
  'infrastructure-failure': 6,
  'unreadable-input': 5,
  'genuine-no-match': 4,
  'needs-human': 3,
  partial: 2,
  'not-attempted': 1,
  ok: 0,
};

export function worstOutcome(stages: readonly Stage[]): Outcome {
  let worst: Outcome = 'ok';
  for (const st of stages) if (SEVERITY[st.outcome] > SEVERITY[worst]) worst = st.outcome;
  return worst;
}

export function buildRecord(
  id: string,
  resolution: Resolution,
  photos: Partial<Record<CaptureStep, string>>,
  surface: string | null = null,
  note: string | null = null,
  cylinders: Partial<Record<CaptureStep, CylinderRecord>> = {},
): ScanRecord {
  const rows = resolution.merged?.rows ?? [];
  return {
    format: SCAN_FORMAT,
    id,
    capturedAt: new Date().toISOString(),
    engine: resolution.page?.engine ?? 'unknown',
    title: resolution.product?.title
      ?? resolution.pack?.title
      ?? resolution.identity?.productName
      ?? resolution.pack?.brand
      ?? 'Unnamed scan',
    shots: resolution.shots.map((sh) => ({
      step: sh.step,
      photo: photos[sh.step] ?? null,
      page: sh.page,
      rows: sh.panel.rows,
      identity: sh.identity,
      cylinder: cylinders[sh.step] ?? null,
    })),
    stages: resolution.stages,
    answeredBy: resolution.answeredBy,
    merge: resolution.merged?.report ?? null,
    mergedRows: rows,
    checks: rows.map((r) => checkRow(r.name, r.amount, r.unit, r.dvPct)),
    pack: resolution.pack,
    product: resolution.product,
    surface,
    note,
    classifiedOn: resolution.classifiedOn,
  };
}

export function summarise(rec: ScanRecord): ScanSummary {
  return {
    format: rec.format,
    id: rec.id,
    capturedAt: rec.capturedAt,
    title: rec.title,
    shots: rec.shots.length,
    thumb: rec.shots.find((sh) => sh.photo !== null)?.photo ?? null,
    lines: rec.shots.reduce((n, sh) => n + sh.page.lines.length, 0),
    rows: rec.mergedRows.length,
    verified: rec.checks.filter((c) => c.status === 'verified').length,
    mismatched: rec.checks.filter((c) => c.status === 'mismatch').length,
    worstOutcome: worstOutcome(rec.stages),
    answeredBy: rec.answeredBy,
    surface: rec.surface,
    note: rec.note,
    verdict: rec.pack?.verdict ?? null,
    claims: rec.pack?.claims.length ?? 0,
  };
}

/**
 * Turn a saved record back into the input the ladder takes, so a scan from
 * the field can be replayed — on the phone, or by a script on a laptop —
 * without the bottle, the photograph, or the camera.
 */
export function replayInputs(rec: ScanRecord): { step: CaptureStep; uri: string; page: OcrPage }[] {
  return rec.shots.map((sh) => ({ step: sh.step, uri: sh.photo ?? '', page: sh.page }));
}

/**
 * Replay a round-bottle scan from its FRAMES rather than its stored result.
 *
 * replayInputs above hands back the page the phone produced, which is the
 * right thing for every other purpose: it reproduces the scan exactly as it
 * happened. But it also freezes the join. When the unrolling or the offset
 * solve changes, the question worth asking is whether the same frames now
 * come out better, and only re-running the join can answer it.
 *
 * A record with no cylinder data — every version-2 record, and every flat
 * scan since — comes back identical to replayInputs.
 */
export function rejoinInputs(rec: ScanRecord): { step: CaptureStep; uri: string; page: OcrPage }[] {
  return rec.shots.map((sh) => {
    const cyl = sh.cylinder;
    if (cyl === undefined || cyl === null || cyl.frames.length === 0) {
      return { step: sh.step, uri: sh.photo ?? '', page: sh.page };
    }
    const frames = cyl.frames.map((page, i) => ({
      page,
      cal: cyl.calibrations[i] ?? cyl.calibrations[0] ?? { centreX: 0.5, radiusPx: 0.3 },
    }));
    return { step: sh.step, uri: sh.photo ?? '', page: unrollAndJoin(frames).page };
  });
}
