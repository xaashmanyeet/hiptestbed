#!/bin/bash
# Build the app and put it on the phone. One command, start to finish.
#
#   ./ship.sh
#
# Checks the code, builds a standalone app with the JavaScript baked in,
# copies it to the phone, and opens it. After this the phone needs nothing
# from the Mac -- no server, no hotspot, no cable.

set -e
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

say "1/4  Checking the code for mistakes"
npx tsc --noEmit
echo "     no type errors"

say "2/4  Building the app (this is the slow part, a few minutes)"
LOG="${TMPDIR:-/tmp}/hiptestbed-build.log"
if ! ( cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
        xcodebuild -workspace HIPtestbed.xcworkspace -scheme HIPtestbed \
          -configuration Release -destination 'generic/platform=iOS' \
          -allowProvisioningUpdates build > "$LOG" 2>&1 ); then
  echo "     BUILD FAILED. The real error is usually the last 'error:' line:"
  grep -E '^.*error:' "$LOG" | tail -5 || tail -20 "$LOG"
  echo "     full log: $LOG"
  exit 1
fi
echo "     built"

say "3/4  Copying it to the phone"
./install.sh

say "4/4  Opening it"
UDID=$(xcrun devicectl list devices 2>/dev/null \
       | grep physical | grep -E 'connected|available' \
       | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}' \
       | head -1)
xcrun devicectl device process launch --device "$UDID" com.aashman.hiptestbed > /dev/null
echo "     running. You can unplug the phone now."
