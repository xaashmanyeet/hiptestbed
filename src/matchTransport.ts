// Asking the server to find the product, and coping when it won't.
//
// Unlike classification, this half was already asynchronous and already sat
// at the END of the ladder — nothing in the parsing pipeline calls it — so
// moving it needs no restructuring at all. It is also a round trip saved:
// today the phone searches NIH, scores the candidates locally, then fetches
// the winner's full label. Now the search and the scoring happen in one
// place, next to each other.
//
// The scoring and the two thresholds are bundled from compositionMatch.ts,
// the same file the phone uses, so the server cannot reach a different
// verdict. If this route is unreachable the caller runs exactly the code it
// ran before, which is still present and still tested.

import type { DsldHit } from './dsld';
import { endpoint } from './serverConfig';

export const MATCH_URL = endpoint('/scan/match');

/** Longer than classify: this one searches a database behind it. */
const TIMEOUT_MS = 10000;

export interface ServerMatch {
  candidates: DsldHit[];
  /** Null when nothing cleared both thresholds. */
  winner: { id: string; fullName: string; score: number; shared: number } | null;
  /** Why the decision went the way it did, in words. */
  reason: string;
  ms: number;
}

export interface MatchTransport {
  via: 'server' | 'local';
  reason: string | null;
}

export let lastMatchTransport: MatchTransport = {
  via: 'local', reason: 'nothing matched yet',
};

interface Reply {
  envelope?: number;
  candidates?: DsldHit[];
  winner?: ServerMatch['winner'];
  reason?: string;
  error?: string;
}

/**
 * Search and score in one request.
 *
 * Returns null on any failure, which is the caller's signal to do it the old
 * way. Never throws: a matching problem must not take down a scan that has
 * already read the label successfully.
 */
export async function tryServerMatch(
  queries: readonly string[],
  ingredients: readonly string[],
): Promise<ServerMatch | null> {
  const started = Date.now();
  if (MATCH_URL.length === 0 || queries.length === 0) {
    lastMatchTransport = { via: 'local', reason: 'no name to search with' };
    return null;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, TIMEOUT_MS);
  try {
    const res = await fetch(MATCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelope: 1, queries: [...queries], ingredients: [...ingredients] }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as Reply;
    if (typeof body.error === 'string') throw new Error(body.error);
    if (!Array.isArray(body.candidates)) throw new Error('the server sent no candidates');

    lastMatchTransport = { via: 'server', reason: null };
    return {
      candidates: body.candidates,
      winner: body.winner ?? null,
      reason: body.reason ?? '',
      ms: Date.now() - started,
    };
  } catch (e) {
    const why = e instanceof Error ? e.message : 'unknown error';
    lastMatchTransport = {
      via: 'local',
      reason: `n8n did not answer (${why}), so the search ran from the phone`,
    };
    return null;
  } finally {
    clearTimeout(timer);
  }
}
