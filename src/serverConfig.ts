// Where our server lives, and the fact that it is optional.
//
// Every route that leaves the phone goes through here. Nothing else in the
// app knows the hostname, so a clone of this repository ships with no
// address in it at all: you supply one, or you do without.
//
// Doing without is a supported state, not a broken one. All four transports
// already treat an empty URL as "the workflow is switched off in this build"
// and run their local code instead, so an unconfigured clone still scans
// labels. It loses the server-side classification and the database match,
// and falls back to calling NIH and PubMed directly.
//
// The value comes from EXPO_PUBLIC_HIP_API_BASE in a .env file. Expo bakes
// EXPO_PUBLIC_ variables into the bundle at build time, so this is not a
// secret in the shipped app and must never hold a key. It keeps the address
// out of the source, which is the only thing it is for. Anything that must
// actually stay private belongs behind the server, not in front of it.
//
// See .env.example.

/** Base of the deployed workflow, e.g. https://example.com/webhook/hip/v1 */
const BASE = (process.env.EXPO_PUBLIC_HIP_API_BASE ?? '').trim().replace(/\/+$/, '');

/** False when no server is configured, which every transport handles. */
export const serverConfigured = BASE.length > 0;

/**
 * Full URL for one route, or the empty string when no server is configured.
 * The empty string is the signal each transport already checks for.
 */
export function endpoint(path: string): string {
  return BASE.length === 0 ? '' : `${BASE}${path}`;
}
