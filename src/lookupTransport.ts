// Where the two online lookups actually go.
//
// The scanner reads and understands a label entirely on the phone. Three
// things cannot happen there, because they are somebody else's database:
// searching NIH for a product, fetching one NIH label, and finding PubMed
// papers. Those are the only calls that leave the device.
//
// They now go to an n8n workflow instead of straight to NIH. The reason is
// not speed -- it is slightly slower -- it is that the behaviour of a lookup
// can then be changed in a browser rather than by rebuilding the app in
// Xcode and reinstalling it, and that a key can live server-side when one of
// these services eventually needs one. A private key cannot live in a phone
// app; anyone can pull it back out of the binary.
//
// THE FALLBACK IS THE POINT. Routing through our own server adds a new way
// for the scanner to break: n8n being down, or rate-limited, would take the
// lookups with it. So every call tries n8n first and drops back to calling
// NIH directly if that fails for any reason. An outage degrades the feature
// to exactly today's behaviour instead of removing it.

import { endpoint } from './serverConfig';

/** The n8n workflow "HIP Lookups (scanner)". Empty string disables it. */
export const N8N_BASE = endpoint('/lookup');

/** Short, because a hung proxy must not hold the screen. Direct gets longer. */
const N8N_TIMEOUT_MS = 7000;
const DIRECT_TIMEOUT_MS = 15000;

export type Via = 'n8n' | 'direct';

export interface Transport {
  via: Via;
  /** Why n8n was skipped or failed, when it was. */
  reason: string | null;
}

/** The most recent lookup's route, so the Steps view can say where it went. */
export let lastTransport: Transport = { via: 'direct', reason: 'nothing looked up yet' };

async function getJson(url: string, ms: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try the workflow, fall back to the origin. `directUrl` is the exact call
 * the app made before any of this existed, so the fallback path is the one
 * that has always worked rather than a second, untested one.
 */
export async function lookupJson(n8nPath: string, directUrl: string): Promise<unknown> {
  if (N8N_BASE.length > 0) {
    try {
      const json = await getJson(`${N8N_BASE}${n8nPath}`, N8N_TIMEOUT_MS);
      lastTransport = { via: 'n8n', reason: null };
      return json;
    } catch (e) {
      const why = e instanceof Error ? e.message : 'unknown error';
      lastTransport = {
        via: 'direct',
        reason: `n8n did not answer (${why}), so this went straight to the source`,
      };
    }
  } else {
    lastTransport = { via: 'direct', reason: 'the workflow is switched off in this build' };
  }
  return getJson(directUrl, DIRECT_TIMEOUT_MS);
}
