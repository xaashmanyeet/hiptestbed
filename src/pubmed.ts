// Real citations from PubMed, the US National Library of Medicine index.
//
// WHAT THIS DOES AND DOES NOT DO. It fetches papers that exist, with their
// real identifiers, and shows the title, journal, year and study type. It
// draws no conclusion from them and makes no claim that a supplement works.
// Deciding what a body of evidence means is a clinician's job, not an app's.
//
// The query is deliberately biased toward the top of the evidence hierarchy —
// systematic reviews and meta-analyses — rather than single studies, because
// one paper proves very little on its own.

import { lookupJson, N8N_BASE } from './lookupTransport';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

export interface Paper {
  pmid: string;
  title: string;
  journal: string;
  year: string;
  types: string[];
}

export const pubmedUrl = (pmid: string): string =>
  `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

/**
 * Turn PubMed's two payloads into citations. Shared deliberately: the
 * workflow route and the direct route produce the same two pieces, so they
 * must produce the same papers from them.
 */
function toPapers(ids: readonly string[], result: Record<string, unknown>): Paper[] {
  return ids.flatMap((id) => {
    const r = result[id] as Record<string, unknown> | undefined;
    if (r === undefined) return [];
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    return [{
      pmid: id,
      title: str(r.title).replace(/\.$/, ''),
      journal: str(r.fulljournalname) || str(r.source),
      year: str(r.pubdate).slice(0, 4),
      types: Array.isArray(r.pubtype) ? r.pubtype.map(str).filter(Boolean) : [],
    }];
  });
}

export async function papersFor(nutrient: string, limit = 3): Promise<Paper[]> {
  const term =
    `${nutrient} supplementation AND ` +
    `(systematic review[pt] OR meta-analysis[pt])`;

  // PubMed needs two calls: ids first, then the citations for those ids. The
  // workflow does both server-side, so over n8n this is one round trip from
  // the phone instead of two.
  if (N8N_BASE.length > 0) {
    try {
      const body = (await lookupJson(
        `/pubmed?nutrient=${encodeURIComponent(nutrient)}&limit=${limit}`,
        '',
      )) as { ids?: string[]; result?: Record<string, unknown> };
      return toPapers(body.ids ?? [], body.result ?? {});
    } catch {
      // Fall through to the two-call path below.
    }
  }

  const sUrl = `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance`
    + `&retmax=${limit}&term=${encodeURIComponent(term)}`;
  const sRes = await fetch(sUrl);
  if (!sRes.ok) throw new Error(`PubMed search failed (${sRes.status})`);
  const sBody = (await sRes.json()) as { esearchresult?: { idlist?: string[] } };
  const ids = sBody.esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];

  const dUrl = `${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`;
  const dRes = await fetch(dUrl);
  if (!dRes.ok) throw new Error(`PubMed summary failed (${dRes.status})`);
  const dBody = (await dRes.json()) as { result?: Record<string, unknown> };
  return toPapers(ids, dBody.result ?? {});
}
