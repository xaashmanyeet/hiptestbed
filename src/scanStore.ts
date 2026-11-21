// Writing scans to the phone, and getting them off it.
//
// WHERE THINGS LIVE. An iOS app can only see its own folder. Inside it,
// the cache directory is deletable by the system whenever storage runs low,
// and the document directory is not — it survives until the app is deleted.
// Scans go in the document directory, because a scan that evaporates when
// the phone fills up is no use as a test case.
//
// Layout, one folder per scan:
//
//   <documents>/hip-scans/2026-11-09T14-22-31-004Z/
//       scan.json        the whole record, including every word box
//       summary.json     a few hundred bytes, so the list screen is instant
//       panel.jpg        the photographs, kept because the camera's own
//       other.jpg        temporary folder is emptied by iOS without warning
//       front.jpg
//
// Export writes ONE file containing every record and hands it to the iOS
// share sheet. One file, one AirDrop, and it lands on a Mac as something a
// script can replay directly.
//
// The whole module degrades to "off" if the native filesystem module is not
// present, exactly as the text recogniser does, so a build without it shows
// a disabled button instead of crashing on launch.

import type { CaptureStep } from './labelMerge';
import {
  SCAN_FORMAT, type ScanRecord, type ScanSummary, summarise,
} from './scanRecord';

interface FsFile {
  uri: string;
  exists: boolean;
  size: number;
  write: (content: string) => Promise<void>;
  textSync: () => string;
  text: () => Promise<string>;
  delete: () => void;
  create: (options?: { intermediates?: boolean; overwrite?: boolean }) => void;
  copy: (destination: unknown) => Promise<void>;
}
interface FsDirectory {
  uri: string;
  exists: boolean;
  name: string;
  create: (o?: { intermediates?: boolean; idempotent?: boolean }) => void;
  list: () => (FsFile | FsDirectory)[];
  delete: () => void;
}
interface FsModule {
  Paths: { document: FsDirectory; cache: FsDirectory };
  File: new (...parts: unknown[]) => FsFile;
  Directory: new (...parts: unknown[]) => FsDirectory;
}
interface ShareModule {
  isAvailableAsync: () => Promise<boolean>;
  shareAsync: (url: string, options?: { mimeType?: string; dialogTitle?: string; UTI?: string }) => Promise<void>;
}

let fs: FsModule | null = null;
let share: ShareModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  fs = require('expo-file-system') as FsModule;
} catch { fs = null; }
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  share = require('expo-sharing') as ShareModule;
} catch { share = null; }

export const storageAvailable = (): boolean => fs !== null;
export const sharingAvailable = (): boolean => share !== null;

const ROOT = 'hip-scans';

/**
 * Oldest scans are pruned past this. Each is a few hundred kilobytes of JSON
 * plus up to three photographs, so the cap is about what a tester generates
 * in several long field sessions, and it stops the app quietly eating the
 * phone's storage.
 */
export const MAX_SCANS = 200;

function root(): FsDirectory {
  if (fs === null) throw new Error('No filesystem in this build');
  const dir = new fs.Directory(fs.Paths.document, ROOT);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

const isDirectory = (e: FsFile | FsDirectory): e is FsDirectory =>
  (e as FsDirectory).list !== undefined;

/** Scan folders, newest first. The id is an ISO timestamp, so sorting is free. */
function scanDirs(): FsDirectory[] {
  if (fs === null) return [];
  const dir = root();
  return dir.list()
    .filter(isDirectory)
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

export interface SavePhoto { step: CaptureStep; uri: string }

export interface SaveResult {
  id: string;
  /** Names of the photographs actually copied in, keyed by step. */
  photos: Partial<Record<CaptureStep, string>>;
  bytes: number;
}

/**
 * Copy the photographs in FIRST, then write the record that names them. The
 * record is the index; writing it last means a scan folder is never pointing
 * at a photograph that failed to copy.
 */
export async function savePhotos(
  id: string, photos: readonly SavePhoto[],
): Promise<Partial<Record<CaptureStep, string>>> {
  if (fs === null) return {};
  const dir = new fs.Directory(root(), id);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });

  const out: Partial<Record<CaptureStep, string>> = {};
  for (const p of photos) {
    const name = `${p.step}.jpg`;
    try {
      const source = new fs.File(p.uri);
      if (!source.exists) continue;
      const target = new fs.File(dir, name);
      if (target.exists) target.delete();
      await source.copy(target);
      out[p.step] = name;
    } catch {
      // A photograph that will not copy is not worth losing the reading over.
      // The OcrPage inside the record is the part that matters.
    }
  }
  return out;
}

export async function saveScan(rec: ScanRecord): Promise<SaveResult | null> {
  if (fs === null) return null;
  const dir = new fs.Directory(root(), rec.id);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });

  const body = JSON.stringify(rec);
  const main = new fs.File(dir, 'scan.json');
  if (main.exists) main.delete();
  main.create({ overwrite: true });
  await main.write(body);

  const sum = new fs.File(dir, 'summary.json');
  if (sum.exists) sum.delete();
  sum.create({ overwrite: true });
  await sum.write(JSON.stringify(summarise(rec)));

  prune();
  const photos: Partial<Record<CaptureStep, string>> = {};
  for (const sh of rec.shots) if (sh.photo !== null) photos[sh.step] = sh.photo;
  return { id: rec.id, photos, bytes: body.length };
}

function prune(): void {
  const dirs = scanDirs();
  for (const d of dirs.slice(MAX_SCANS)) {
    try { d.delete(); } catch { /* a folder we cannot delete is not fatal */ }
  }
}

export function listScans(): ScanSummary[] {
  if (fs === null) return [];
  const out: ScanSummary[] = [];
  for (const d of scanDirs()) {
    try {
      const sum = new fs.File(d, 'summary.json');
      if (!sum.exists) continue;
      const parsed = JSON.parse(sum.textSync()) as ScanSummary;
      // A record written by an older build has a different shape. Showing half
      // of one is worse than not showing it.
      if (parsed.format !== SCAN_FORMAT) continue;
      out.push(parsed);
    } catch {
      // A corrupt summary should hide one scan, not break the whole list.
    }
  }
  return out;
}

export async function readScan(id: string): Promise<ScanRecord | null> {
  if (fs === null) return null;
  try {
    const file = new fs.File(new fs.Directory(root(), id), 'scan.json');
    if (!file.exists) return null;
    const rec = JSON.parse(await file.text()) as ScanRecord;
    return rec.format === SCAN_FORMAT ? rec : null;
  } catch { return null; }
}

/** The on-disk path of a kept photograph, for showing it back on screen. */
export function photoUri(id: string, name: string): string | null {
  if (fs === null) return null;
  try {
    const file = new fs.File(new fs.Directory(root(), id), name);
    return file.exists ? file.uri : null;
  } catch { return null; }
}

export function deleteScan(id: string): void {
  if (fs === null) return;
  try { new fs.Directory(root(), id).delete(); } catch { /* already gone */ }
}

export function deleteAll(): void {
  if (fs === null) return;
  for (const d of scanDirs()) {
    try { d.delete(); } catch { /* keep going */ }
  }
}

export interface ExportBundle {
  format: number;
  exportedAt: string;
  app: string;
  count: number;
  scans: ScanRecord[];
}

/**
 * Records in one file. JSON rather than anything cleverer because the point
 * is that a script on a laptop can read it with no library at all.
 *
 * `ids` narrows it to a chosen few. The bundle is the same shape either way,
 * so whatever reads an export of everything reads an export of three without
 * knowing the difference — which matters, because a test run is usually a
 * handful of scans rather than the whole phone.
 */
export async function exportAll(
  appVersion: string, ids?: readonly string[],
): Promise<{ uri: string; count: number } | null> {
  if (fs === null) return null;
  const wanted = ids === undefined ? null : new Set(ids);
  const scans: ScanRecord[] = [];
  for (const sum of listScans()) {
    if (wanted !== null && !wanted.has(sum.id)) continue;
    const rec = await readScan(sum.id);
    if (rec !== null) scans.push(rec);
  }
  if (scans.length === 0) return null;

  const bundle: ExportBundle = {
    format: SCAN_FORMAT,
    exportedAt: new Date().toISOString(),
    app: appVersion,
    count: scans.length,
    scans,
  };

  // The cache directory, not documents: this file is a copy made for one
  // share and has no reason to survive.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = new fs.File(fs.Paths.cache, `hip-scans-${stamp}.json`);
  if (file.exists) file.delete();
  file.create({ overwrite: true });
  await file.write(JSON.stringify(bundle));
  return { uri: file.uri, count: scans.length };
}

export async function exportOne(id: string): Promise<{ uri: string } | null> {
  if (fs === null) return null;
  const rec = await readScan(id);
  if (rec === null) return null;
  const file = new fs.File(fs.Paths.cache, `hip-scan-${id}.json`);
  if (file.exists) file.delete();
  file.create({ overwrite: true });
  await file.write(JSON.stringify(rec));
  return { uri: file.uri };
}

export async function shareFile(uri: string, dialogTitle: string): Promise<void> {
  if (share === null) throw new Error('Sharing is not available in this build');
  if (!(await share.isAvailableAsync())) throw new Error('This device cannot share files');
  await share.shareAsync(uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle });
}

/** Rough total, so the Scans tab can say what it is costing in storage. */
export function storageUsed(): number {
  if (fs === null) return 0;
  let total = 0;
  for (const d of scanDirs()) {
    try {
      for (const e of d.list()) if (!isDirectory(e)) total += e.size;
    } catch { /* skip */ }
  }
  return total;
}
