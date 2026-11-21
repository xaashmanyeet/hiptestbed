// Asking the server to classify a capture's lines, and coping when it won't.
//
// Mirrors lookupTransport.ts deliberately: same base, same try-then-fall-back
// shape, same "say which route ran" reporting. Three lookups already work
// this way and there is no reason for a fourth pattern.
//
// THE FALLBACK IS THE WHOLE POINT. Classification is not an optional extra —
// nothing downstream works without it — so routing it through a server adds
// a brand new way for the scanner to stop working. Every failure here lands
// back on the local rules, which are still present, still tested, and still
// the same code the server is running. An outage costs speed, not function.
//
// And it says so. A silent fallback is how a team discovers in March that
// the server has been down since January.

import { installClassifications, type ClassifyMaps } from './classifyCache';
import { endpoint } from './serverConfig';
import type { Classification } from './labelLineClassification';
import type { PackClassification } from './labelPackClassification';

/** The "HIP Lookups (scanner)" workflow. Empty string disables the route. */
export const CLASSIFY_URL = endpoint('/scan/classify');

/** Short: this sits between the shutter and the result, so it must not hang. */
const TIMEOUT_MS = 6000;

export interface ClassifyTransport {
  via: 'server' | 'local';
  /** Why the server was skipped or failed, when it was. */
  reason: string | null;
  /** How many distinct lines were classified. */
  lines: number;
  ms: number;
}

export let lastClassifyTransport: ClassifyTransport = {
  via: 'local', reason: 'nothing classified yet', lines: 0, ms: 0,
};

/** What the Steps tab prints. */
export function classifyTransportLabel(t: ClassifyTransport): string {
  return t.via === 'server'
    ? `Classified on the server — ${t.lines} distinct lines in ${t.ms} ms.`
    : `Classified on this phone${t.reason === null ? '' : ` — ${t.reason}`}.`;
}

interface Reply {
  envelope?: number;
  content?: Record<string, Classification>;
  pack?: Record<string, PackClassification>;
  error?: string;
}

/**
 * Classify every distinct line of a capture in one request, and install the
 * answers where the synchronous rules can find them.
 *
 * Returns whether it worked. The caller carries on either way: an empty
 * cache simply means `classifyLine` runs its own rules, exactly as it did
 * before any of this existed.
 */
export async function prefetchClassifications(
  texts: readonly string[],
): Promise<ClassifyTransport> {
  const started = Date.now();
  const distinct = [...new Set(texts)].filter((t) => t.trim().length > 0);

  const settle = (t: Omit<ClassifyTransport, 'ms'>): ClassifyTransport => {
    lastClassifyTransport = { ...t, ms: Date.now() - started };
    return lastClassifyTransport;
  };

  // Nothing to do, and no reason to make a network call to say so.
  if (distinct.length === 0) {
    installClassifications({ content: {}, pack: {} }, 'local');
    return settle({ via: 'local', reason: 'no lines to classify', lines: 0 });
  }
  if (CLASSIFY_URL.length === 0) {
    installClassifications({ content: {}, pack: {} }, 'local');
    return settle({ via: 'local', reason: 'the workflow is switched off in this build', lines: 0 });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, TIMEOUT_MS);
  try {
    const res = await fetch(CLASSIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelope: 1, texts: distinct }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as Reply;
    if (typeof body.error === 'string') throw new Error(body.error);
    if (body.content === undefined || body.pack === undefined) {
      throw new Error('the server sent no classifications');
    }

    const maps: ClassifyMaps = { content: body.content, pack: body.pack };
    installClassifications(maps, 'server');
    return settle({ via: 'server', reason: null, lines: Object.keys(body.content).length });
  } catch (e) {
    // Clear rather than leave a half-filled map: a partial cache would make
    // some lines server-classified and some local, which is harder to reason
    // about than simply doing all of them here.
    installClassifications({ content: {}, pack: {} }, 'local');
    const why = e instanceof Error ? e.message : 'unknown error';
    return settle({
      via: 'local',
      reason: `n8n did not answer (${why}), so the rules ran here instead`,
      lines: 0,
    });
  } finally {
    clearTimeout(timer);
  }
}
