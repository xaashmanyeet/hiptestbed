// Text tidying. Two different normalisations, because two different jobs.

/** Uppercase, drop everything but letters, digits and %. For matching fixed phrases. */
export const squash = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9%]/g, '');

/** Uppercase, collapse runs of whitespace. For patterns where spacing matters. */
export const tidy = (s: string): string => s.toUpperCase().replace(/\s+/g, ' ').trim();

/**
 * Edit distance: how many single-character insert/delete/replace steps turn a into b.
 * Needed because OCR garbles things. "SUPPLERNENT FACTS" is 2 away from the real
 * heading, and an exact-match check would miss the panel entirely.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = new Array<number>(b.length + 1).fill(0);
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = curr;
  }
  return prev[b.length] ?? 0;
}

/**
 * "Vitamin D3 (as Cholecalciferol)" -> "vitamin d3". The chemical form in
 * brackets is the maker's choice and varies between two printings of the same
 * product, so it is dropped. Used to decide whether two readings — from two
 * photographs, or from a photograph and a database record — are the same
 * ingredient.
 */
export function normaliseIngredient(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
