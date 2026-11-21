# tools

Two scripts that run the app's parsing logic on a Mac, with no phone involved.

Both work because everything except the ~130 lines of Swift is pure
JavaScript: given the same recognised text it produces the same answer
anywhere. The Swift reads pixels; nothing after it knows what a camera is.

## `./tools/test.sh`: the regression suite

300 assertions over the panel parsing, the multi-photo merge, the packaging
reader and the saved-scan format. Run it after any change to `src/`.

The merge cases are built by **damaging a copy of the stored sample label**,
knocking a digit off an amount or deleting a line, so they exercise real
disagreements between two readings rather than hand-written fixtures that can
quietly drift out of step with the parser.

## `./tools/replay.sh`: re-run a scan from the field

```
./tools/replay.sh ~/Downloads/hip-scans-2026-11-09-14-22-31.json
./tools/replay.sh ~/Downloads/hip-scans-2026-11-09-14-22-31.json zinc
```

Takes a bundle exported from the phone's **Scans** tab and replays every scan
in it: what each photograph read on its own, the packaging reading (name,
brand, advertised claims, whether the FDA disclaimer is present), how the
photographs were merged, every row with its amount and percentage and whether
the arithmetic agrees, and any row that came out without a name.

The packaging and panel readings are both *recomputed* rather than read back
from the record, so a fix to the rules shows up immediately on old scans.

This is the point of saving scans at all. A label that fails in a shop can be
reproduced here in seconds, fixed, and replayed to prove the fix worked, and
the file then stays as a permanent test case.

A nameless row in the output is the failure that looks, on the phone, like a
column of numbers with nothing beside them.

## Why the copy-to-a-temp-folder dance

Node requires explicit `.ts` on relative imports; Metro, which bundles the
app, forbids them. The app's source is written for Metro, so both scripts copy
`src/` to a scratch folder, add the extensions, run from there, and delete it.
