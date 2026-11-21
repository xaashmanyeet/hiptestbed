// Asking the server to read the packaging, and coping when it won't.
//
// The third of these, and deliberately the same shape as the other two:
// short timeout, fall back to the code that is still here, say which ran.
// A fourth pattern would be a fourth thing to debug at 2am.
//
// Pack reading is a better fit for the server than classification was. It
// is already at the end of the pipeline, nothing synchronous waits on it,
// and its rules — what counts as a claim, which theme it belongs to, how a
// product name is split from a variant — are the ones most likely to need
// tuning against real packaging. Server-side they can be changed in a
// browser and redeployed without an app build.

import type { OcrPage } from './labelOcr';
import type { PackReading } from './labelPack';
import { endpoint } from './serverConfig';

export const PACK_URL = endpoint('/scan/pack');

/** Pages are large; 8s is enough for a cold node and short enough to feel. */
const TIMEOUT_MS = 8000;

export interface PackTransport {
  via: 'server' | 'local';
  reason: string | null;
  pages: number;
  ms: number;
}

export let lastPackTransport: PackTransport = {
  via: 'local', reason: 'nothing read yet', pages: 0, ms: 0,
};

export function packTransportLabel(t: PackTransport): string {
  return t.via === 'server'
    ? `Packaging read on the server — ${t.pages} photograph${t.pages === 1 ? '' : 's'} in ${t.ms} ms.`
    : `Packaging read on this phone${t.reason === null ? '' : ` — ${t.reason}`}.`;
}

/**
 * Read the packaging remotely.
 *
 * Returns null on any failure, which is the caller's signal to run the
 * local `readPack`/`mergePacks` exactly as before. Never throws: the
 * packaging reading is a part of a scan, not the whole of it, and losing
 * the scan because this leg failed would be the worse bug.
 */
export async function tryServerPack(
  pages: readonly OcrPage[],
): Promise<PackReading | null> {
  const started = Date.now();
  const settle = (t: Omit<PackTransport, 'ms'>): void => {
    lastPackTransport = { ...t, ms: Date.now() - started };
  };

  if (PACK_URL.length === 0 || pages.length === 0) {
    settle({ via: 'local', reason: 'nothing to read', pages: pages.length });
    return null;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); }, TIMEOUT_MS);
  try {
    const res = await fetch(PACK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelope: 1, pages }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body = (await res.json()) as { pack?: PackReading; error?: string };
    if (typeof body.error === 'string') throw new Error(body.error);
    if (body.pack === undefined || !Array.isArray(body.pack.lines)) {
      throw new Error('the server sent no packaging reading');
    }
    settle({ via: 'server', reason: null, pages: pages.length });
    return body.pack;
  } catch (e) {
    const why = e instanceof Error ? e.message : 'unknown error';
    settle({
      via: 'local',
      reason: `n8n did not answer (${why}), so the rules ran here instead`,
      pages: pages.length,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
