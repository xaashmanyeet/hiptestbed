#!/bin/bash
# Run the pipeline's regression suite.
#
#   ./tools/test.sh
#
# Same copy-and-add-extensions dance as replay.sh: Node needs explicit .ts
# on imports, Metro does not, and the app's source is written for Metro.
set -e
cd "$(dirname "$0")/.."

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src" "$WORK/tools" "$WORK/assets" "$WORK/modules/hip-text-recognition"
cp src/*.ts "$WORK/src/"
cp tools/test.ts "$WORK/tools/"
cp assets/sample-label.json "$WORK/assets/"
perl -pi -e "s{(from '\./[A-Za-z]+)'}{\$1.ts'}g" "$WORK/src"/*.ts

# resolve.ts imports the native recogniser, which needs a real iOS build. Every
# test supplies an already-read page, so a stub that refuses to read is enough
# and keeps the ladder itself under test.
cat > "$WORK/modules/hip-text-recognition/index.ts" <<'STUB'
import type { OcrPage } from '../../src/labelOcr.ts';
export const textRecognitionAvailable = (): boolean => true;
export async function recognizeText(_uri: string): Promise<OcrPage> {
  throw new Error('stub: tests supply pages directly');
}
STUB
perl -pi -e "s{'\.\./modules/hip-text-recognition'}{'../modules/hip-text-recognition/index.ts'}g" "$WORK/src/resolve.ts"

node --experimental-strip-types --no-warnings "$WORK/tools/test.ts"
