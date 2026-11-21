// Matching a label to a database record by what is IN it.
//
// Extracted from resolve.ts unchanged so the same code can run on the server.
// Nothing here touches the network, the filesystem or React, which is what
// makes it safe to bundle into an n8n Code node — and bundling the real
// functions is the only way the phone and the server can be guaranteed to
// reach the same verdict. A hand-typed second copy would drift, and drift
// here means two machines disagreeing about which product a bottle is.
//
// resolve.ts re-exports these, so every existing caller and every existing
// test is untouched.

import type { DsldHit } from './dsld';
import { normaliseIngredient } from './labelTextNormalize';

export interface CompositionScore { hit: DsldHit; score: number; shared: number }

/**
 * Match on the ingredient set rather than the name. A 23-ingredient panel is
 * a near-unique fingerprint, and comparing two sets of strings is arithmetic —
 * no judgement, no model, same answer every time.
 */
export function scoreByComposition(ours: string[], hits: readonly DsldHit[]): CompositionScore[] {
  const mine = new Set(ours.map(normaliseIngredient).filter((s) => s.length > 2));
  if (mine.size === 0) return [];

  return hits
    .map((hit) => {
      const theirs = new Set(
        hit.ingredients.map((i) => normaliseIngredient(i.name)).filter((s) => s.length > 2),
      );
      if (theirs.size === 0) return { hit, score: 0, shared: 0 };
      let shared = 0;
      for (const n of mine) if (theirs.has(n)) shared++;
      const union = mine.size + theirs.size - shared;
      return { hit, score: union === 0 ? 0 : shared / union, shared };
    })
    .sort((a, b) => b.score - a.score);
}

/** Accept a single match only on a clear score AND a clear margin over the runner-up. */
export const ACCEPT_SCORE = 0.5;
export const ACCEPT_MARGIN = 0.12;

export function decide(scores: readonly CompositionScore[]): CompositionScore | null {
  const top = scores[0];
  if (top === undefined || top.score < ACCEPT_SCORE) return null;
  const second = scores[1];
  if (second !== undefined && top.score - second.score < ACCEPT_MARGIN) return null;
  return top;
}

/** Why a decision went the way it did, for the Steps tab and the record. */
export function decisionReason(scores: readonly CompositionScore[]): string {
  const top = scores[0];
  if (top === undefined) return 'no candidates to compare against';
  if (top.score < ACCEPT_SCORE) {
    return `best overlap was ${(top.score * 100).toFixed(0)}%, below the ${
      ACCEPT_SCORE * 100}% a match needs`;
  }
  const second = scores[1];
  if (second !== undefined && top.score - second.score < ACCEPT_MARGIN) {
    return `top two are ${(top.score * 100).toFixed(0)}% and ${
      (second.score * 100).toFixed(0)}% — too close to choose between`;
  }
  return `${top.shared} ingredients shared, ${(top.score * 100).toFixed(0)}% overlap`;
}
