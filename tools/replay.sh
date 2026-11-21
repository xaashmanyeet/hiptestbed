#!/bin/bash
# Replay scans exported from the phone.
#
#   ./tools/replay.sh ~/Downloads/hip-scans-2026-11-09-14-22-31.json
#   ./tools/replay.sh <file> zinc          # only scans matching "zinc"
#
# Node needs explicit .ts extensions on imports and the app's source omits
# them (Metro, the app's bundler, does not care). So the source is copied to
# a scratch folder with the extensions added, and run from there. The copy is
# thrown away afterwards.
set -e
cd "$(dirname "$0")/.."

if [ -z "$1" ]; then
  echo "usage: ./tools/replay.sh <exported-bundle.json> [filter]"
  exit 2
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src" "$WORK/tools"
cp src/*.ts "$WORK/src/"
cp tools/replay.ts "$WORK/tools/"
perl -pi -e "s{(from '\./[A-Za-z]+)'}{\$1.ts'}g" "$WORK/src"/*.ts

node --experimental-strip-types --no-warnings "$WORK/tools/replay.ts" "$@"
