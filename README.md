# HIP label scanner

An iPhone app that reads a supplement label from a photo and tells you what is
actually in the bottle.

Point the camera at a Supplement Facts panel, take a picture, and you get back
the product name, the brand, every ingredient with its amount and percent daily
value, and a note on anything that looks wrong. It works on flat boxes and on
curved bottles, where the text bends away from the camera.

This is a testbed, not a shipping product. It exists to find out how well a
phone can read these labels on its own.

## How it works, briefly

1. **Read the pixels.** Apple's Vision framework finds every word in the photo
   and reports where it sits on the page. This happens on the phone. The photo
   never leaves the device.

2. **Find the panel.** Supplement Facts panels have a fixed shape set by FDA
   rules: a heading, a serving size, then two columns of numbers under
   "Amount Per Serving" and "% Daily Value". The app looks for those headings
   and uses them to work out where the columns are.

3. **Group words into rows.** Words sitting at roughly the same height belong to
   the same ingredient. Printed rule lines on the label help here, especially on
   bottles where the rows curve.

4. **Check the arithmetic.** If a label says 90 mg of vitamin C and 100% daily
   value, those two numbers have to agree, because the daily value for vitamin C
   is 90 mg. When they do not agree, something was misread. This is the only
   step that can actually prove the app wrong rather than just guess, so it
   drives most of the error correction.

5. **Merge several photos.** You can take more than one picture. Each row gets a
   quality score, and readings that pass the arithmetic check beat readings that
   do not. A curved bottle usually needs three shots to get the whole panel.

6. **Look it up.** The recognised text goes to a server, which matches it
   against the NIH Dietary Supplement Label Database and pulls related research
   from PubMed. Text only, never photos.

## Running it yourself

You need a Mac, Xcode, and a real iPhone. The simulator has no useful camera.

```
git clone https://github.com/xaashmanyeet/hiptestbed.git
cd hiptestbed
npm install
cd ios && pod install && cd ..
cp .env.example .env
```

`.env` holds the address of the server that does classification and database
matching. Leave it empty and the app still scans labels on the phone, calling
NIH and PubMed directly instead. See `.env.example`.

Plug in an iPhone, unlock it, then:

```
./ship.sh
```

That checks the code, builds the app, copies it to the phone and opens it. It
takes a few minutes the first time. After that the app runs on its own with no
cable and no server on your Mac.

If you have already built once and just want to reinstall, `./install.sh` skips
the build.

The first launch will fail with a signing error until you open
`ios/HIPtestbed.xcworkspace` in Xcode, pick your own Apple ID under Signing, and
change the bundle identifier to something unique to you. Apple will not let two
people ship the same identifier.

## Using the app

The **Scan** tab has two modes. Simple takes one photo. Guided walks you through
several, telling you which part of the bottle to point at next. Pick the surface
first: flat, cylindrical, or other.

Results appear under **Label**. The other tabs are for debugging: **Steps**
shows what each photo contributed, **Lines** shows the raw recognised text,
**Rules** shows which rule matched which line.

**Scans** keeps every scan you have taken and can export them all as a single
file. That file is the useful part. A label that fails in a shop can be sent to
the Mac and replayed against the code until it reads correctly:

```
./tools/replay.sh ~/Downloads/hip-scans-2026-11-21.json
```

## The code

Everything except about 130 lines of Swift is plain TypeScript, which means the
whole pipeline can be run and tested on a Mac with no phone involved.

```
App.tsx                         the entire user interface
src/                            the pipeline, one file per job
modules/hip-text-recognition/   the Swift that talks to Apple Vision
tools/                          test and replay scripts
```

The files in `src/` are named after what they do. `labelOcr.ts` defines the
shape of recognised text and is the boundary between reading pixels and
understanding them. `labelPanelParse.ts` turns words into rows.
`dailyValues.ts` holds the FDA numbers and does the arithmetic check.
`labelCylinder.ts` handles curved bottles. `resolve.ts` ties it together.

## Tests

```
./tools/test.sh
```

300 assertions, no phone needed. Run it after touching anything in `src/`.

Some of the merge tests work by taking a known-good label and deliberately
damaging a copy of it, knocking a digit off an amount or deleting a line. That
way they test real disagreements between two readings instead of fixtures that
drift out of date.

## What runs where

Reading the photo and working out the geometry happens on the phone, because it
needs the image and because it should work without a signal. Everything after
that is text, so it can run anywhere.

Classification, database matching and research lookup run on an n8n server. Its
address is not in this repository. It comes from `EXPO_PUBLIC_HIP_API_BASE` in
your own `.env`, and every route falls back to calling the public NIH and
PubMed endpoints directly when no server is set or the server is unreachable.

## Limits

This reads labels. It does not give medical advice, and it will not tell you
whether a supplement is safe, effective, or a good idea. Those questions are
deliberately out of scope.

Accuracy on flat panels is good. Curved bottles are harder and are the main
thing still being worked on.
