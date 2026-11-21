// Classifications worked out somewhere else, held where the rules can see them.
//
// WHY A CACHE AND NOT A NETWORK CALL. `contentTag` is called synchronously
// from nine places buried inside the parsing core — findColumnBlocks,
// parsePanel, readPack, readIdentity, frameRole and the views. Making it
// await anything would force every one of those to become async, which is a
// rewrite of the parser and the single most reliable way to break this app.
//
// So the work moves without the shape changing. Before parsing starts, every
// distinct line in the capture is sent off in ONE request and classified
// there; the answers are installed here; and `classifyLine` checks this map
// before running its own rules. The function stays synchronous, all nine
// callers are untouched, and a cache miss simply runs the local rules as it
// always did.
//
// It is also faster than what it replaces. Four different modules call
// `contentTag` on the same strings during one parse, each recomputing the
// whole rule list. Now the first call fills the map and the rest read it.
//
// The cache is deliberately global and deliberately replaceable. A scan
// installs its own map and clears it afterwards, so one capture can never
// answer for the next.

import type { Classification } from './labelLineClassification';
import type { PackClassification } from './labelPackClassification';

export interface ClassifyMaps {
  content: Record<string, Classification>;
  pack: Record<string, PackClassification>;
}

/** Where the answers in the cache came from, for the Steps tab and the record. */
export type ClassifiedBy = 'server' | 'local';

let contentCache: Map<string, Classification> | null = null;
let packCache: Map<string, PackClassification> | null = null;
let origin: ClassifiedBy = 'local';

/**
 * Install answers computed elsewhere.
 *
 * Replaces whatever was there. Passing empty maps is how a scan says "the
 * server did not answer, use the local rules" without leaving stale entries
 * from a previous capture behind.
 */
export function installClassifications(maps: ClassifyMaps, from: ClassifiedBy): void {
  contentCache = new Map(Object.entries(maps.content));
  packCache = new Map(Object.entries(maps.pack));
  origin = from;
}

/** Forget everything. Called when a capture finishes, successfully or not. */
export function clearClassifications(): void {
  contentCache = null;
  packCache = null;
  origin = 'local';
}

export const classifiedBy = (): ClassifiedBy => origin;

export const cachedCount = (): number =>
  (contentCache?.size ?? 0) + (packCache?.size ?? 0);

/**
 * Look up a line. `undefined` means "not cached" and the caller runs its own
 * rules — which is the normal path when nothing has been installed at all.
 */
export const cachedContent = (raw: string): Classification | undefined =>
  contentCache?.get(raw);

export const cachedPack = (raw: string): PackClassification | undefined =>
  packCache?.get(raw);
