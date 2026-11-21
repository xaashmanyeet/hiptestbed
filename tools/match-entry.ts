// Bundled into the n8n "Match product" Code node by deploy-classifier.sh.
// The scoring and thresholds are the app's own, so the phone and the server
// cannot disagree about which product a bottle is.
import {
  scoreByComposition, decide, decisionReason,
} from '../src/compositionMatch.ts';
import { parseSearchHits } from '../src/dsld.ts';

const g = globalThis as Record<string, unknown>;
g.hipScoreByComposition = scoreByComposition;
g.hipDecide = decide;
g.hipDecisionReason = decisionReason;
g.hipParseSearchHits = parseSearchHits;
