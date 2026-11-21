// Lookup against the NIH Dietary Supplement Label Database (DSLD).
//
// This is the public API behind the same data HIP mirrors locally. No key,
// no login. It is the authoritative US government record of what is printed
// on a supplement label, which makes it the right thing to match a scanned
// label against.

import { lookupJson } from './lookupTransport';

const BASE = 'https://api.ods.od.nih.gov/dsld/v9';

export interface DsldIngredient {
  name: string;
  category: string;
  group: string;
  notes: string;
}

export interface DsldHit {
  id: string;
  fullName: string;
  brandName: string;
  netContents: string | null;
  offMarket: boolean;
  ingredients: DsldIngredient[];
}

function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

function netContents(v: unknown): string | null {
  if (Array.isArray(v) && v.length > 0) {
    const first = v[0] as Record<string, unknown> | undefined;
    if (first !== undefined) {
      const q = text(first.quantity ?? first.number);
      const u = text(first.unit ?? first.display);
      const joined = `${q} ${u}`.trim();
      return joined.length > 0 ? joined : null;
    }
  }
  const s = text(v);
  return s.length > 0 ? s : null;
}

/**
 * NIH's search reply, as this app understands it.
 *
 * Exported because the n8n matcher bundles THIS function rather than
 * carrying its own copy. The hits are Elasticsearch-shaped — the id is
 * `_id` and everything else hangs off `_source` — and a second hand-written
 * parser that got that subtly wrong would score every candidate at zero
 * while looking like it worked, which is exactly what happened before this
 * was shared.
 */
export function parseSearchHits(body: unknown): DsldHit[] {
  const b = (body ?? {}) as { hits?: unknown[] };
  const hits = Array.isArray(b.hits) ? b.hits : [];

  return hits.map((raw) => {
    const h = raw as Record<string, unknown>;
    const src = (h._source ?? {}) as Record<string, unknown>;
    const ing = Array.isArray(src.allIngredients) ? src.allIngredients : [];
    return {
      id: text(h._id),
      fullName: text(src.fullName) || '(no product name)',
      brandName: text(src.brandName),
      netContents: netContents(src.netContents),
      offMarket: src.offMarket === true || src.offMarket === 1,
      ingredients: ing.map((i) => {
        const o = i as Record<string, unknown>;
        return {
          name: text(o.name),
          category: text(o.category),
          group: text(o.ingredientGroup),
          notes: text(o.notes),
        };
      }),
    };
  });
}

export async function searchDsld(query: string, size = 15): Promise<DsldHit[]> {
  const q = encodeURIComponent(query);
  // The workflow passes NIH's reply through untouched, so the parsing below
  // is the same code on either route.
  return parseSearchHits(await lookupJson(
    `/dsld/search?q=${q}&size=${size}`,
    `${BASE}/search-filter?q=${q}&size=${size}`,
  ));
}

/* ------------------------------------------------- full label by id --- */

import { normaliseUnit, type LabelProduct, type LabelRow } from './product';

interface RawQty {
  quantity?: number; unit?: string;
  dailyValueTargetGroup?: { percent?: number | null; footnote?: string | null }[];
}
interface RawRow {
  name?: string; category?: string; notes?: string;
  quantity?: RawQty[]; nestedRows?: RawRow[];
}

function toRow(r: RawRow, depth: number): LabelRow[] {
  const q = Array.isArray(r.quantity) ? r.quantity[0] : undefined;
  const dvg = Array.isArray(q?.dailyValueTargetGroup) ? q?.dailyValueTargetGroup[0] : undefined;
  const pct = typeof dvg?.percent === 'number' ? dvg.percent : null;

  const self: LabelRow = {
    name: text(r.name) || '(unnamed)',
    amount: typeof q?.quantity === 'number' ? q.quantity : null,
    unit: q?.unit !== undefined ? normaliseUnit(text(q.unit)) : null,
    dvPct: pct,
    // A footnote with no percent is the "*" case: no Daily Value established.
    dvNotEstablished: pct === null && dvg !== undefined,
    indentLevel: depth,
    category: text(r.category) || null,
  };

  const kids = Array.isArray(r.nestedRows) ? r.nestedRows : [];
  return [self, ...kids.flatMap((k) => toRow(k, depth + 1))];
}

/** Statement types worth showing. The rest is barcodes and version codes. */
const KEEP = /directions|precaution|warning|storage|contains|does not contain|statement of identity/i;

export async function fetchDsldLabel(id: string): Promise<LabelProduct> {
  const safe = encodeURIComponent(id);
  const j = (await lookupJson(
    `/dsld/label?id=${safe}`,
    `${BASE}/label/${safe}`,
  )) as Record<string, unknown>;

  const rows = (Array.isArray(j.ingredientRows) ? j.ingredientRows : [])
    .flatMap((r) => toRow(r as RawRow, 0))
    .filter((r) => r.unit !== 'cal');

  const ss = Array.isArray(j.servingSizes) ? (j.servingSizes[0] as Record<string, unknown>) : undefined;
  const servingSize = ss === undefined
    ? null
    : `Serving size ${text(ss.minQuantity)} ${text(ss.unit)}`.trim();

  const oi = (j.otheringredients ?? {}) as Record<string, unknown>;
  const oiList = Array.isArray(oi.ingredients) ? oi.ingredients : [];
  const otherIngredients = oiList.length > 0
    ? oiList.map((x) => text((x as Record<string, unknown>).name)).filter(Boolean).join(', ')
    : (text(oi.text) || null);

  const groups = (Array.isArray(j.userGroups) ? j.userGroups : [])
    .map((g) => text((g as Record<string, unknown>).dailyValueTargetGroupName))
    .filter(Boolean);
  const targets = (Array.isArray(j.targetGroups) ? j.targetGroups : []).map(text).filter(Boolean);

  const statements = (Array.isArray(j.statements) ? j.statements : [])
    .map((x) => {
      const o = x as Record<string, unknown>;
      return { type: text(o.type), text: text(o.notes) };
    })
    .filter((x) => x.text.length > 0 && KEEP.test(x.type));

  return {
    source: 'nih',
    title: text(j.fullName) || '(no product name)',
    brand: text(j.brandName) || null,
    servingSize,
    servingsPerContainer: text(j.servingsPerContainer) || null,
    rows,
    otherIngredients,
    userGroups: [...new Set([...groups, ...targets])],
    statements,
    dsldId: text(j.id) || id,
  };
}
