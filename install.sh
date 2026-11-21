#!/bin/bash
# Installs the standalone Release build onto a connected iPhone.
# No dev server, no hotspot, no Xcode window needed.
#
#   ./install.sh
#
# Plug the phone in and unlock it first.

set -e
cd "$(dirname "$0")"

# Newest build wins. Moving the project folder creates a SECOND DerivedData
# directory, and the old one keeps a stale app in it -- picking the first
# match would quietly install a build from weeks ago.
APP=$(find ~/Library/Developer/Xcode/DerivedData/HIPtestbed-*/Build/Products/Release-iphoneos \
       -maxdepth 1 -name "HIPtestbed.app" 2>/dev/null \
       | while read -r a; do echo "$(stat -f '%m' "$a/main.jsbundle" 2>/dev/null || echo 0) $a"; done \
       | sort -rn | head -1 | cut -d' ' -f2-)

if [ -z "$APP" ]; then
  echo "No Release build found. Build one with:"
  echo "  cd ios && xcodebuild -workspace HIPtestbed.xcworkspace -scheme HIPtestbed \\"
  echo "    -configuration Release -destination 'generic/platform=iOS' -allowProvisioningUpdates build"
  exit 1
fi

if [ ! -f "$APP/main.jsbundle" ]; then
  echo "That build has no embedded JavaScript — it would need a dev server. Rebuild Release."
  exit 1
fi

# Pull the UDID by its shape, not by column position -- device names can
# contain spaces and curly apostrophes, which shift every field after them.
UDID=$(xcrun devicectl list devices 2>/dev/null \
       | grep physical | grep -E 'connected|available' \
       | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}' \
       | head -1)

if [ -z "$UDID" ]; then
  echo "No iPhone connected. Plug it in, unlock it, then run this again."
  xcrun devicectl list devices 2>/dev/null | grep physical || true
  exit 1
fi

echo "Installing $(basename "$APP") to $UDID ..."
xcrun devicectl device install app --device "$UDID" "$APP"
echo ""
echo "Done. Open HIPtestbed on the phone — it runs on its own, no server."
