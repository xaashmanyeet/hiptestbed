// Add the scan/classify and scan/match routes to an n8n workflow JSON.
//
// ADD ONLY, and that is not a slogan. The n8n instance this targets is shared
// and runs dozens of unrelated production workflows. This one already serves
// three lookup routes the app depends on. Every existing node and connection
// is copied through untouched; the nodes this script owns are replaced by
// name if present and appended if not.
//
// ONE RESPONDER PER WEBHOOK. An earlier attempt put two Respond nodes on a
// single webhook branch and every execution failed with a 500. Each route
// here is a straight line: webhook -> code -> respond. Errors are returned
// as a field by the Code node, not by a second responder.
//
//   node tools/patch-classify-workflow.mjs <in.json> <classifier.js> <out.json>

import { readFileSync, writeFileSync } from 'node:fs';

const [inPath, bundlePath, outPath, packPath] = process.argv.slice(2);

// The deployed Code node calls one of our own lookup routes. The address is
// not in this file: it is supplied at deploy time so the repository carries
// no hostname.
const API_BASE = (process.env.HIP_API_BASE ?? '').trim().replace(/\/+$/, '');
if (API_BASE.length === 0) {
  console.error('HIP_API_BASE is not set. Put EXPO_PUBLIC_HIP_API_BASE in .env');
  process.exit(1);
}
const wf = JSON.parse(readFileSync(inPath, 'utf8'));
const classifierCode = readFileSync(bundlePath, 'utf8');
const packCode = packPath === undefined ? null : readFileSync(packPath, 'utf8');

const C_HOOK = 'POST scan/classify';
const C_CODE = 'Classify lines';
const C_RESP = 'Respond classify';
const M_HOOK = 'POST scan/match';
const M_CODE = 'Match product';
const M_RESP = 'Respond match';
const NOTE = 'HIP scanner note';

const nodes = [...wf.nodes];
let packConnections = {};
const upsert = (node) => {
  const at = nodes.findIndex((n) => n.name === node.name);
  // Keep any id and position already on the canvas, so a redeploy does not
  // shuffle a layout the owner has arranged.
  if (at >= 0) nodes[at] = { ...nodes[at], ...node, id: nodes[at].id, position: nodes[at].position };
  else nodes.push(node);
};

const webhook = (id, name, path, y) => ({
  id, name, type: 'n8n-nodes-base.webhook', typeVersion: 2,
  position: [-460, y], webhookId: id,
  parameters: { httpMethod: 'POST', path, responseMode: 'responseNode', options: {} },
});
// `respondWith: 'json'` with a stringified body makes this instance answer
// 422 even though the body is correct — and every transport in the app
// checks res.ok, so a 422 means the phone silently falls back to local
// forever while the server looks fine in a browser. `firstIncomingItem`
// returns the object itself with a 200.
const respond = (id, name, y) => ({
  id, name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1,
  position: [100, y],
  parameters: { respondWith: 'firstIncomingItem', options: {} },
});

/* ------------------------------------------------------------ classify */

upsert(webhook('hip-scan-classify-hook', C_HOOK, 'hip/v1/scan/classify', 900));
upsert({
  id: 'hip-scan-classify-code', name: C_CODE,
  type: 'n8n-nodes-base.code', typeVersion: 2,
  position: [-180, 900],
  parameters: { mode: 'runOnceForAllItems', jsCode: classifierCode },
});
upsert(respond('hip-scan-classify-respond', C_RESP, 900));

/* --------------------------------------------------------------- match */

// Written against the workflow's OWN dsld/search route rather than calling
// NIH directly, so there is one place that knows how to search and one
// place to fix when it changes.
const matchCode = `
// Product matching: search the NIH mirror, score every candidate by how much
// of its ingredient set the photographed label shares, and accept a winner
// only on a clear score AND a clear margin over the runner-up.
//
// The scoring and the thresholds are bundled from the app's own
// compositionMatch.ts, so the server and the phone cannot reach different
// verdicts. Deployed by tools/deploy-classifier.sh.
${readFileSync(new URL('./match-bundle.js', import.meta.url), 'utf8')}

const body = $input.first().json.body ?? $input.first().json;
if (body.envelope !== 1) {
  return [{ json: { error: 'Envelope version ' + body.envelope + ' is not understood; this matcher speaks 1.' } }];
}

const queries = Array.isArray(body.queries) ? body.queries.filter((q) => typeof q === 'string' && q.trim()) : [];
const ingredients = Array.isArray(body.ingredients) ? body.ingredients.filter((i) => typeof i === 'string') : [];

if (queries.length === 0 && ingredients.length === 0) {
  return [{ json: { envelope: 1, winner: null, candidates: [], reason: 'nothing to search on' } }];
}

const seen = new Map();
for (const q of queries.slice(0, 3)) {
  try {
    const res = await this.helpers.httpRequest({
      method: 'GET',
      url: '${API_BASE}/lookup/dsld/search',
      qs: { q, size: 25 },
      json: true,
    });
    // Parsed by the app's own parseSearchHits, bundled above, so the
    // server reads NIH's reply exactly as the phone does.
    for (const h of globalThis.hipParseSearchHits(res)) {
      if (h.id && !seen.has(h.id)) seen.set(h.id, h);
    }
  } catch (e) {
    // One failed query must not lose the others.
  }
}

const candidates = [...seen.values()];

const scored = globalThis.hipScoreByComposition(ingredients, candidates);
const winner = globalThis.hipDecide(scored);
const reason = globalThis.hipDecisionReason(scored);

return [{ json: {
  envelope: 1,
  winner: winner ? {
    id: winner.hit.id, fullName: winner.hit.fullName,
    score: winner.score, shared: winner.shared,
  } : null,
  candidates,
  scored: scored.slice(0, 5).map((s) => ({ id: s.hit.id, score: s.score, shared: s.shared })),
  reason,
} }];
`;

upsert(webhook('hip-scan-match-hook', M_HOOK, 'hip/v1/scan/match', 1120));
upsert({
  id: 'hip-scan-match-code', name: M_CODE,
  type: 'n8n-nodes-base.code', typeVersion: 2,
  position: [-180, 1120],
  parameters: { mode: 'runOnceForAllItems', jsCode: matchCode },
});
upsert(respond('hip-scan-match-respond', M_RESP, 1120));

/* ---------------------------------------------------------- packaging */

// Straight line, one responder, exactly like the other two routes.
if (packCode !== null) {
  const P_HOOK = 'POST scan/pack';
  const P_CODE = 'Read packaging';
  const P_RESP = 'Respond pack';
  upsert(webhook('hip-scan-pack-hook', P_HOOK, 'hip/v1/scan/pack', 1340));
  upsert({
    id: 'hip-scan-pack-code', name: P_CODE,
    type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [-180, 1340],
    parameters: { mode: 'runOnceForAllItems', jsCode: packCode },
  });
  upsert(respond('hip-scan-pack-respond', P_RESP, 1340));
  packConnections = {
    [P_HOOK]: { main: [[{ node: P_CODE, type: 'main', index: 0 }]] },
    [P_CODE]: { main: [[{ node: P_RESP, type: 'main', index: 0 }]] },
  };
}

/* ---------------------------------------------------------- the note */

upsert({
  id: 'hip-scanner-sticky', name: NOTE,
  type: 'n8n-nodes-base.stickyNote', typeVersion: 1,
  position: [-460, 1320],
  parameters: {
    width: 760, height: 260,
    content: [
      '## HIP scanner — classification and product matching',
      '',
      'Used by the HIPtestbed app when it reads a supplement label.',
      '',
      '**POST /webhook/hip/v1/scan/classify**',
      'Body `{ envelope: 1, texts: string[] }`. Returns a tag, the rule that',
      'fired and the evidence for every line. One request per capture.',
      '',
      '**POST /webhook/hip/v1/scan/pack**',
      'Body `{ envelope: 1, pages: OcrPage[] }`. Reads the packaging: name,',
      'brand, variant, who it is for, claims grouped by theme, certifications.',
      'These rules can be tuned here and redeployed with no app rebuild.',
      '',
      '**POST /webhook/hip/v1/scan/match**',
      'Body `{ envelope: 1, queries: string[], ingredients: string[] }`.',
      'Searches the NIH mirror through this workflow\'s own dsld/search route,',
      'scores candidates on shared ingredients, and returns a winner only',
      'above 50% overlap with a 12-point margin.',
      '',
      '**The two Code nodes are GENERATED — do not edit them here.**',
      'Source of truth is `hiptestbed/src/`. Change the rules there, run the',
      'tests, then `./tools/deploy-classifier.sh`. Editing in this canvas',
      'makes the server and the phone disagree about what a label says.',
      '',
      'The app falls back to classifying on the phone whenever these routes',
      'do not answer, so an outage degrades speed, not function.',
    ].join('\n'),
  },
});

/* ------------------------------------------------------- connections */

const connections = { ...wf.connections };
connections[C_HOOK] = { main: [[{ node: C_CODE, type: 'main', index: 0 }]] };
connections[C_CODE] = { main: [[{ node: C_RESP, type: 'main', index: 0 }]] };
connections[M_HOOK] = { main: [[{ node: M_CODE, type: 'main', index: 0 }]] };
connections[M_CODE] = { main: [[{ node: M_RESP, type: 'main', index: 0 }]] };
Object.assign(connections, packConnections);

// The PUT endpoint rejects id, active, tags and shared.
writeFileSync(outPath, JSON.stringify({
  name: wf.name,
  nodes,
  connections,
  settings: wf.settings ?? { executionOrder: 'v1' },
}, null, 2));

console.log(`     ${nodes.length} nodes (${wf.nodes.length} before)`);
console.log('     POST /hip/v1/scan/classify, /scan/match'
  + (packCode === null ? '' : ', /scan/pack'));
