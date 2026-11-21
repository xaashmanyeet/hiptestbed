import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Image, Linking, Pressable, ScrollView, StyleSheet,
  Text, TextInput, View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { StatusBar } from 'expo-status-bar';

import type { OcrPage } from './src/labelOcr';
import { classifyLine, contentTag, RULES } from './src/labelLineClassification';
import type { Basis } from './src/labelLineClassification';
import { findColumnBlocks, type ColumnBlock } from './src/labelPanelLayout';
import { parsePanel } from './src/labelPanelParse';
import { DAILY_VALUES, checkRow, nihUrl, type DailyValueCheck } from './src/dailyValues';
import { searchDsld, fetchDsldLabel, type DsldHit } from './src/dsld';
import { papersFor, pubmedUrl, type Paper } from './src/pubmed';
import { fromPhoto, type LabelProduct, type LabelRow } from './src/product';
import {
  resolveFromShots, type CaptureInput, type Resolution, type Stage, type Outcome,
} from './src/resolve';
import {
  CAPTURE_STEPS, readShot, stepSpec,
  type CaptureStep, type MergeReport,
} from './src/labelMerge';
import {
  describe, readPack, type PackClaim, type PackReading, type SupplementVerdict,
} from './src/labelPack';
import { PACK_TAG_LABEL } from './src/labelPackClassification';
import {
  buildRecord, replayInputs, scanId,
  type CylinderRecord, type ScanRecord, type ScanSummary,
} from './src/scanRecord';
import {
  unrollAndJoin, unrollPage, READABLE_ARC,
  type CylinderCalibration, type CylinderFrame, type CylinderReport,
} from './src/labelCylinder';
import { detectRole, roleLabel, type FrameRole, type RoleVerdict } from './src/frameRole';
import { readBestEffort } from './src/labelOcrQuality';
import {
  deleteScan, exportAll, exportOne, listScans, photoUri, readScan,
  savePhotos, saveScan, shareFile, sharingAvailable, storageAvailable, storageUsed,
} from './src/scanStore';
import {
  detectSeparators, recognizeText, recognizeTiled, textRecognitionAvailable,
} from './modules/hip-text-recognition';
import type { Separator } from './src/labelSeparators';
import sampleJson from './assets/sample-label.json';

const APP_VERSION = '0.2.0';

const sample = sampleJson as unknown as OcrPage;
const SAMPLE_PRODUCT = fromPhoto(sample, 'Multivitamin (photographed label)');
const SAMPLE_PACK = readPack(sample);

/** Shown when a photograph yielded nothing at all, so the Label tab never
 *  displays the previous scan's panel beside the new scan's packaging. */
const NOTHING_READ: LabelProduct = {
  source: 'photo', title: 'Nothing readable in that photo', brand: null,
  servingSize: null, servingsPerContainer: null, rows: [], otherIngredients: null,
  userGroups: [], statements: [], dsldId: null,
};

type Tab = 'label' | 'steps' | 'lines' | 'rules' | 'scans' | 'find' | 'scan';

// Insertion order IS the order of the bar below, which reads the keys of this
// object. Keep them in the order they should appear on screen.
const TAB_TITLE: Record<Tab, string> = {
  label: 'Label', scan: 'Scan', scans: 'Scans', find: 'Find',
  lines: 'Lines', steps: 'Steps', rules: 'Rules',
};

export default function App() {
  const [tab, setTab] = useState<Tab>('label');
  const [product, setProduct] = useState<LabelProduct>(SAMPLE_PRODUCT);
  const [pack, setPack] = useState<PackReading | null>(SAMPLE_PACK);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  // Bumped whenever a scan is saved or deleted, so the Scans tab reloads from
  // disk rather than showing a list that is quietly out of date.
  const [scanEpoch, setScanEpoch] = useState(0);

  const use = (p: LabelProduct) => { setProduct(p); setPack(null); setTab('label'); };
  const useResolution = (r: Resolution) => {
    setResolution(r);
    setPack(r.pack);
    // Always replace the product, even with the placeholder. Leaving the old
    // one in place would pair the previous scan's panel with this scan's
    // packaging on the same screen.
    setProduct(r.product ?? NOTHING_READ);
    // And always land on the Label tab. A front-of-pack photograph has no
    // ingredient rows but does have a name, a brand and the claims; sending
    // that to a diagnostics tab is why a scan appeared to do nothing at all.
    setTab('label');
    setScanEpoch((n) => n + 1);
  };

  return (
    <View style={s.app}>
      <StatusBar style="light" />
      <View style={s.header}>
        <Text style={s.appTitle} numberOfLines={1}>{product.title}</Text>
        <View style={s.subRow}>
          <Text style={s.appSub}>
            {product.source === 'photo' ? 'From a photographed label' : 'From the NIH database'}
            {' · '}{product.rows.length} ingredients
          </Text>
          {product.source !== 'photo' && (
            <Pressable onPress={() => setProduct(SAMPLE_PRODUCT)}>
              <Text style={s.resetChip}>back to my scan</Text>
            </Pressable>
          )}
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.tabStrip}
        contentContainerStyle={s.tabs}
      >
        {(Object.keys(TAB_TITLE) as Tab[]).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[s.tab, tab === t && s.tabOn]}>
            <Text style={[s.tabText, tab === t && s.tabTextOn]}>{TAB_TITLE[t]}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {tab === 'label' && <LabelView product={product} pack={pack} />}
      {tab === 'steps' && <StepsView resolution={resolution} />}
      {tab === 'lines' && <LinesView page={resolution?.allPages ?? resolution?.page ?? sample} />}
      {tab === 'rules' && <ClassifyView page={resolution?.allPages ?? resolution?.page ?? sample} />}
      {tab === 'scans' && (
        <ScansView epoch={scanEpoch} onChanged={() => setScanEpoch((n) => n + 1)}
                   onOpen={useResolution} />
      )}
      {tab === 'find' && <FindView onPick={use} />}
      {tab === 'scan' && <CameraTab onResolved={useResolution} />}
    </View>
  );
}


/* ------------------------------------------------- why each line got its tag */

// How far a rule's match is worth trusting, shown as a colour so the
// proportion of a label read from regulated wording is visible at a glance.
const BASIS: Readonly<Record<Basis, { label: string; colour: string; note: string }>> = {
  'regulated-wording': {
    label: 'regulated wording',
    colour: '#1D9E75',
    note: 'Text the law fixes. Cannot mean anything else.',
  },
  'standard-code': {
    label: 'standard code',
    colour: '#378ADD',
    note: 'A code format from a standards body. The shape is conclusive.',
  },
  shape: {
    label: 'shape only',
    colour: '#EF9F27',
    note: 'A pattern, e.g. a number beside a unit. Suggestive — geometry decides the rest.',
  },
  none: {
    label: 'unclaimed',
    colour: '#39404B',
    note: 'No rule matched. Left unknown on purpose.',
  },
};

function BasisPill({ basis }: { basis: Basis }) {
  const b = BASIS[basis];
  return (
    <View style={[s.basisPill, { borderColor: b.colour }]}>
      <View style={[s.legendDot, { backgroundColor: b.colour }]} />
      <Text style={[s.basisPillText, { color: b.colour }]}>{b.label}</Text>
    </View>
  );
}

/**
 * Type any line off any bottle and watch the rules run on it.
 *
 * The classifier is currently proven only against labels that happen to be to
 * hand. This makes the question "which rule fired on this line, and why?"
 * answerable standing in a shop aisle, instead of needing a test harness on a
 * laptop. It is only possible because the rules are an ARRAY OF DATA that the
 * screen renders and the pipeline executes — there is no second copy to drift.
 */
function RuleProbe() {
  const [probe, setProbe] = useState('');
  const text = probe.trim();
  const result = text.length > 0 ? classifyLine(probe) : null;
  const index = result === null ? -1 : RULES.findIndex((r) => r.rule === result.rule);
  const claimed = result !== null && result.tag !== 'unclassified';

  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>Try a line</Text>
      <Text style={s.cardNote}>
        Type anything printed on a bottle. It runs through the same twelve rules,
        in the same order, as every line of a real scan.
      </Text>
      <TextInput
        value={probe}
        onChangeText={setProbe}
        style={s.input}
        placeholder="e.g. Vitamin D3 (as Cholecalciferol) 25 mcg 125%"
        placeholderTextColor="#6F7680"
        autoCorrect={false}
        autoCapitalize="none"
        multiline
      />
      <View style={s.probeChips}>
        {['Supplement Facts', 'Serving Size: 2 tablets', 'Zinc 11 mg 100%',
          'Take 1 tablet daily with water', 'OTHER INGREDIENTS: cellulose',
          '0 3 0 0 7 4 1 2 3 4 5 6'].map((ex) => (
          <Pressable key={ex} onPress={() => setProbe(ex)} style={s.probeChip}>
            <Text style={s.probeChipText} numberOfLines={1}>{ex}</Text>
          </Pressable>
        ))}
      </View>

      {result === null ? (
        <Text style={s.evidence}>Nothing typed yet.</Text>
      ) : (
        <View style={s.probeResult}>
          <View style={s.ruleMetaRowFlush}>
            <Text style={claimed ? s.pill : s.pillMuted}>{result.tag}</Text>
            <BasisPill basis={result.basis} />
          </View>
          {claimed ? (
            <>
              <Text style={s.probeRule}>
                rule {index + 1} of {RULES.length}: {result.rule}
              </Text>
              {result.evidence !== null && (
                <Text style={s.evidence}>matched on "{result.evidence}"</Text>
              )}
              <Text style={s.ruleWhyFlush}>{result.why}</Text>
              <Text style={s.evidence}>
                {index === 0
                  ? 'It was the first rule tried.'
                  : `${index} earlier rule${index === 1 ? '' : 's'} were tried first and did not match.`}
              </Text>
            </>
          ) : (
            <>
              <Text style={s.probeRule}>
                All {RULES.length} rules were tried. None claimed it.
              </Text>
              <Text style={s.ruleWhyFlush}>
                That is the correct answer for most of a label — storage notes,
                addresses, marketing. A line is only tagged when something about
                it cannot mean anything else. If this line SHOULD have been
                claimed, the rule list above is where to look.
              </Text>
            </>
          )}
        </View>
      )}
    </View>
  );
}

function ClassifyView({ page }: { page: OcrPage }) {
  const [openRule, setOpenRule] = useState<string | null>(null);

  const read = useMemo(
    () => page.lines.map((l) => ({ text: l.text, c: classifyLine(l.text) })),
    [page],
  );

  const byBasis = useMemo(() => {
    const m = new Map<Basis, number>();
    for (const r of read) m.set(r.c.basis, (m.get(r.c.basis) ?? 0) + 1);
    return m;
  }, [read]);

  const firedCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of read) m.set(r.c.rule, (m.get(r.c.rule) ?? 0) + 1);
    return m;
  }, [read]);

  const total = read.length;
  const hard = (byBasis.get('regulated-wording') ?? 0) + (byBasis.get('standard-code') ?? 0);

  return (
    <ScrollView
      style={s.scroll}
      contentContainerStyle={{ paddingBottom: 48 }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={s.card}>
        <Text style={s.cardTitle}>How a line gets its tag</Text>
        <Text style={s.cardNote}>
          Twelve rules, tried strictly in order. The first one that matches wins and
          the rest are never consulted. There is no scoring and no model, so the
          answer to “why did this line get that tag” is always a single rule
          you can read.
        </Text>
        <Text style={s.cardNote}>
          Order is the whole algorithm. Wording the law fixes is tested before any
          general pattern — that is what keeps “Serving Size 2 tablets”
          from being read as the number of pills in the bottle.
        </Text>
      </View>

      <RuleProbe />

      <View style={s.card}>
        <Text style={s.cardTitle}>What this label was read from</Text>
        <Text style={s.cardNote}>
          {hard} of {total} lines were claimed by regulated wording or a standard code
          rather than by a guessable pattern. That ratio is the honest measure of how
          much of this reading rests on something that cannot mean anything else.
        </Text>
        {(['regulated-wording', 'standard-code', 'shape', 'none'] as Basis[]).map((b) => {
          const n = byBasis.get(b) ?? 0;
          const pct = Math.round((n / Math.max(total, 1)) * 100);
          return (
            <View key={b} style={s.basisRow}>
              <View style={s.basisHead}>
                <View style={[s.legendDot, { backgroundColor: BASIS[b].colour }]} />
                <Text style={s.basisName}>{BASIS[b].label}</Text>
                <Text style={s.statValue}>{n}</Text>
              </View>
              <View style={s.barTrack}>
                <View style={[s.barFill, { width: `${pct}%`, backgroundColor: BASIS[b].colour }]} />
              </View>
              <Text style={s.evidence}>{BASIS[b].note}</Text>
            </View>
          );
        })}
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>The rules, in the order they run</Text>
        <Text style={s.cardNote}>
          Tap any rule to see why it is allowed to claim a line. The count is how many
          lines on this label it caught.
        </Text>
        {RULES.map((r, i) => {
          const n = firedCount.get(r.rule) ?? 0;
          const open = openRule === r.rule;
          return (
            <Pressable
              key={r.rule}
              onPress={() => setOpenRule(open ? null : r.rule)}
              style={[s.ruleRow, n > 0 && s.ruleRowFired]}
            >
              <View style={s.ruleHeadRow}>
                <Text style={s.ruleIndex}>{i + 1}</Text>
                <Text style={[s.ruleName, n === 0 && s.dim]} numberOfLines={1}>{r.rule}</Text>
                {n > 0 && <Text style={s.countChip}>{n}</Text>}
              </View>
              <View style={s.ruleMetaRow}>
                <BasisPill basis={r.basis} />
                {n === 0 && <Text style={s.evidence}>did not fire here</Text>}
              </View>
              {open && <Text style={s.ruleWhy}>{r.why}</Text>}
            </Pressable>
          );
        })}
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Every line, and what matched</Text>
        <Text style={s.cardNote}>
          The exact text that triggered the rule is quoted. If a tag looks wrong, this
          shows which rule to fix.
        </Text>
        {read.map((r, i) => (
          <View key={i} style={s.classRow}>
            <Text style={s.lineText} numberOfLines={2}>{r.text}</Text>
            <View style={s.ruleMetaRow}>
              <Text style={r.c.tag === 'unclassified' ? s.pillMuted : s.pill}>{r.c.tag}</Text>
              <BasisPill basis={r.c.basis} />
            </View>
            {r.c.evidence !== null && (
              <Text style={s.evidence}>matched “{r.c.evidence}”</Text>
            )}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/* ----------------------------------------------------------- the label */

const VERDICT: Readonly<Record<SupplementVerdict, { label: string; style: 'ok' | 'warn' | 'bad' }>> = {
  confirmed: { label: 'confirmed supplement', style: 'ok' },
  likely: { label: 'likely a supplement', style: 'warn' },
  unclear: { label: 'unclear', style: 'warn' },
  'not-a-supplement': { label: 'not identified as a supplement', style: 'bad' },
};

const CLAIM_KIND: Readonly<Record<PackClaim['kind'], string>> = {
  benefit: PACK_TAG_LABEL['structure-function-claim'],
  'nutrient-content': PACK_TAG_LABEL['nutrient-content-claim'],
  disease: PACK_TAG_LABEL['disease-claim'],
};

/**
 * The general reading: what the product is, who makes it, and what it is sold
 * as. Shown above the panel because it answers the first question a person
 * actually has, and because it is all a front-of-pack photograph can give.
 */
function PackSummary({ pack, rowCount }: { pack: PackReading; rowCount: number }) {
  const v = VERDICT[pack.verdict];
  const benefits = pack.claims.filter((c) => c.kind === 'benefit');
  const nutrientClaims = pack.claims.filter((c) => c.kind === 'nutrient-content');
  const diseaseClaims = pack.claims.filter((c) => c.kind === 'disease');

  return (
    <>
      <View style={s.card}>
        <View style={s.tagHead}>
          <Text style={s.cardTitle}>What this is</Text>
          <Text style={[
            s.pill,
            v.style === 'ok' ? s.pillOk : v.style === 'warn' ? s.pillWarn : s.pillBad,
          ]}>{v.label}</Text>
        </View>

        <Text style={s.packName} numberOfLines={2}>
          {pack.title ?? 'Product name not read'}
        </Text>
        <Text style={s.cardNote}>{describe(pack, rowCount)}</Text>

        {pack.brand !== null && <Stat label="Brand" value={pack.brand} />}
        {pack.dosageForm !== null && <Stat label="Form" value={pack.dosageForm.toLowerCase()} />}
        {pack.netQuantity !== null && <Stat label="Net quantity" value={pack.netQuantity.toLowerCase()} />}
        {pack.flavour !== null && <Stat label="Flavour" value={pack.flavour.toLowerCase()} />}
        {pack.certifications.length > 0 && (
          <Stat label="Certifications" value={pack.certifications.join(', ')} />
        )}
        {pack.origin.length > 0 && <Stat label="Origin" value={pack.origin[0]!} />}

        <Text style={s.evidence}>{pack.titleBasis}</Text>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Why we think that</Text>
        <Text style={s.cardNote}>
          A Supplement Facts panel, or the words "Dietary Supplement", settle it
          outright — both are required by regulation. Anything else is inference
          from the packaging and is labelled as such.
        </Text>
        {pack.evidence.length === 0
          ? <Bullet text="Nothing on this photograph identified it either way." />
          : pack.evidence.map((e, i) => <Bullet key={i} text={e} />)}
        <Stat label="Lines outside the panel" value={String(pack.outsidePanel)} />
        <Stat label="Claimed by a rule" value={`${pack.claimed} of ${pack.outsidePanel}`} />
      </View>

      {(benefits.length > 0 || nutrientClaims.length > 0) && (
        <View style={s.card}>
          <Text style={s.cardTitle}>Advertised benefits</Text>
          <Text style={s.cardNote}>
            The manufacturer's own words, quoted exactly as printed. This app does
            not assess whether any of them are true, and nothing here is health
            advice.
          </Text>

          {benefits.map((c, i) => (
            <View key={`b${i}`} style={s.claimRow}>
              <Text style={s.claimText}>“{c.text}”</Text>
              <Text style={s.evidence}>
                read as a benefit claim because of the word “{c.trigger.toLowerCase()}”
              </Text>
            </View>
          ))}

          {nutrientClaims.map((c, i) => (
            <View key={`n${i}`} style={s.claimRow}>
              <Text style={s.claimText}>“{c.text}”</Text>
              <Text style={s.evidence}>
                “{c.trigger.toLowerCase()}” is a term defined in 21 CFR 101.54 with a
                measurable threshold, so it can be checked against the panel
              </Text>
            </View>
          ))}

          <View style={benefits.length > 0 && !pack.disclaimerPresent
            ? s.disclaimerBad : s.disclaimerOk}>
            <Text style={pack.disclaimerPresent ? s.okText2 : s.bad}>
              {pack.disclaimerPresent
                ? 'The FDA disclaimer is printed on this label.'
                : 'The FDA disclaimer is not in frame.'}
            </Text>
            <Text style={s.evidence}>
              {pack.disclaimerPresent
                ? pack.disclaimerText ?? ''
                : '21 CFR 101.93(b) requires a label making a benefit claim to also carry '
                  + '"These statements have not been evaluated by the Food and Drug '
                  + 'Administration." It may be printed on a side of the pack that was '
                  + 'not photographed.'}
            </Text>
          </View>
        </View>
      )}

      {diseaseClaims.length > 0 && (
        <View style={[s.card, s.cardBad]}>
          <Text style={s.cardTitle}>Wording that claims an effect on disease</Text>
          <Text style={s.cardNote}>
            A dietary supplement may not claim to treat, cure or prevent a disease —
            only an approved drug may. This is an observation about what the packaging
            says, quoted verbatim. It is not a judgement about the product.
          </Text>
          {diseaseClaims.map((c, i) => (
            <View key={i} style={s.claimRow}>
              <Text style={s.claimText}>“{c.text}”</Text>
              <Text style={s.evidence}>triggered by “{c.trigger.toLowerCase()}”</Text>
            </View>
          ))}
        </View>
      )}
    </>
  );
}

interface Enriched { row: LabelRow; check: DailyValueCheck }

function LabelView({ product, pack }: { product: LabelProduct; pack: PackReading | null }) {
  const rows: Enriched[] = useMemo(
    () => product.rows.map((row) => ({
      row, check: checkRow(row.name, row.amount, row.unit, row.dvPct),
    })),
    [product],
  );

  // Prefer the source's own classification; fall back to our nutrient table.
  const kindOf = (e: Enriched): string => {
    const c = e.row.category;
    if (typeof c === 'string' && c.trim().length > 0 && c !== 'other') return c.trim();
    return e.check.nutrient === null ? 'other' : DAILY_VALUES[e.check.nutrient]?.kind ?? 'other';
  };

  const order = ['vitamin', 'mineral', 'fat', 'protein', 'carbohydrate', 'other'];
  const label: Record<string, string> = {
    vitamin: 'Vitamins', mineral: 'Minerals', fat: 'Fats',
    protein: 'Protein', carbohydrate: 'Carbohydrate', other: 'Other',
  };
  const seen = [...new Set(rows.map(kindOf))]
    .sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
  const titleFor = (k: string): string =>
    label[k] ?? (k.length > 0 ? k.charAt(0).toUpperCase() + k.slice(1) : 'Other');
  const groups: [string, Enriched[]][] = seen.map((k) => [
    titleFor(k), rows.filter((e) => kindOf(e) === k),
  ]);

  const verified = rows.filter((e) => e.check.status === 'verified').length;
  const mismatched = rows.filter((e) => e.check.status === 'mismatch').length;

  const overUl = rows.filter((e) => {
    const n = e.check.nutrient;
    if (n === null || e.row.amount === null) return false;
    const dv = DAILY_VALUES[n];
    if (dv?.ul == null || e.row.unit !== dv.unit) return false;
    return e.row.amount > dv.ul;
  });

  const forms = rows
    .map((e) => {
      const m = /\(as ([^)]+)\)/i.exec(e.row.name);
      return m === null ? null : `${e.row.name.replace(/\s*\(as [^)]+\)/i, '').trim()} — ${m[1]}`;
    })
    .filter((x): x is string => x !== null);

  const noAmount = rows.filter((e) => e.row.amount === null).length;
  const noPct = rows.filter((e) => e.row.dvPct === null && !e.row.dvNotEstablished).length;
  const unknownNutrient = rows.filter((e) => e.check.nutrient === null).length;
  const gaps = [
    noAmount > 0 ? `${noAmount} rows had no readable amount.` : null,
    noPct > 0 ? `${noPct} rows had no percentage to check against.` : null,
    unknownNutrient > 0 ? `${unknownNutrient} ingredients are not in the Daily Value table, so they could not be checked.` : null,
  ].filter((x): x is string => x !== null);

  const nutrients = rows
    .map((e) => e.check.nutrient)
    .filter((n): n is string => n !== null)
    .filter((n, i, a) => a.indexOf(n) === i);

  return (
    <ScrollView contentContainerStyle={s.scroll}>
      {pack !== null && <PackSummary pack={pack} rowCount={rows.length} />}

      {rows.length === 0 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>
            {pack !== null && pack.claimed > 0
              ? 'No Supplement Facts panel in this photo'
              : 'Almost nothing could be read'}
          </Text>
          <Note text={pack !== null && pack.claimed > 0
            ? "Everything above was read from the packaging itself. To get the ingredient table as well, photograph the Supplement Facts panel square on and filling the frame — the Scan tab's guided mode asks for it as the first shot."
            : 'The photograph was saved anyway, with whatever text came back, so it can be looked at later. The Steps tab says which stage stopped and why. Usually this means the panel was too small in frame, at too steep an angle, or lost to glare.'} />
        </View>
      )}

      {/* ---- the panel, styled like the printed article ---- */}
      {rows.length > 0 && <View style={s.panel}>
        <Text style={s.panelTitle}>Supplement Facts</Text>
        <View style={s.ruleHeavy} />
        <Text style={s.panelMeta}>{product.servingSize ?? 'Serving size not read'}</Text>
        {product.servingsPerContainer !== null && (
          <Text style={s.panelMeta}>Servings per container {product.servingsPerContainer}</Text>
        )}
        <View style={s.ruleThick} />

        <View style={s.headRow}>
          <Text style={[s.pName, s.headText]}>Ingredient</Text>
          <Text style={[s.pAmountCol, s.headText]}>Amount</Text>
          <Text style={[s.pDv, s.headText]}>% DV</Text>
          <Text style={s.pBadge} />
        </View>
        <View style={s.ruleThick} />

        {groups.map(([title, list]) =>
          list.length === 0 ? null : (
            <View key={title}>
              <Text style={s.sectionLabel}>{title.toUpperCase()}</Text>
              {list.map(({ row, check }, i) => (
                <View key={i}>
                  <View style={s.pRow}>
                    <Text style={[s.pName, row.indentLevel > 0 && s.pIndent]} numberOfLines={2}>
                      {row.indentLevel > 0 ? ' ' : ''}{row.name}
                      {row.amount !== null && (
                        <Text style={s.pAmount}>  {row.amount} {row.unit ?? ''}</Text>
                      )}
                    </Text>
                    <Text style={s.pDv}>
                      {row.dvNotEstablished ? '*' : row.dvPct !== null ? `${row.dvPct}%` : '—'}
                    </Text>
                    <Text style={[
                      s.pBadge,
                      check.status === 'verified' && s.okText,
                      check.status === 'mismatch' && s.badText,
                    ]}>
                      {check.status === 'verified' ? '✓' : check.status === 'mismatch' ? '!' : ''}
                    </Text>
                  </View>
                  {check.status === 'mismatch' && (
                    <Text style={s.pMismatch}>
                      {row.amount} {row.unit} works out to {check.expectedPct}%, label says {check.printedPct}%
                    </Text>
                  )}
                  <View style={s.ruleThin} />
                </View>
              ))}
            </View>
          ))}

        <Text style={s.panelFoot}>
          * Daily Value not established.   {'✓'} amount and percentage agree.
        </Text>

        {product.otherIngredients !== null && (
          <>
            <View style={s.ruleThick} />
            <Text style={s.panelOtherTitle}>Other ingredients</Text>
            <Text style={s.panelOther}>{product.otherIngredients}</Text>
          </>
        )}
      </View>}

      {rows.length > 0 && (
        <Text style={s.checkLine}>
          <Text style={s.ok}>{verified} rows verified</Text>
          {mismatched > 0 && <Text style={s.bad}>  ·  {mismatched} disagree</Text>}
          <Text style={s.dim}>  ·  of {rows.length}</Text>
        </Text>
      )}

      {/* ---- everything underneath ---- */}
      <Info title="Who this is for">
        {product.userGroups.length > 0
          ? product.userGroups.map((g, i) => <Bullet key={i} text={g} />)
          : <Note text="The photographed label did not state a target group. Find this product under Find to pull the manufacturer's own wording." />}
      </Info>

      {overUl.length > 0 && (
        <Info title="Above the upper intake level" tone="bad">
          <Note text="These amounts exceed the Tolerable Upper Intake Level set for adults by the NIH. That is a quantity comparison, not medical advice." />
          {overUl.map((e, i) => {
            const dv = DAILY_VALUES[e.check.nutrient!]!;
            return <Bullet key={i} text={`${e.row.name}: ${e.row.amount} ${e.row.unit} — upper level is ${dv.ul} ${dv.unit}`} />;
          })}
        </Info>
      )}

      <StatementBlock product={product} match={/directions|usage/i} title="How the maker says to take it" />
      <StatementBlock product={product} match={/precaution|warning/i} title="Warnings printed on the label" tone="bad" />
      <StatementBlock product={product} match={/contains/i} title="Contains / does not contain" />

      <Info title="At a glance">
        <Stat label="Ingredients listed" value={String(rows.length)} />
        <Stat label="Amounts that check out" value={`${verified} of ${rows.length}`} />
        <Stat label="At or above 100% of the Daily Value"
              value={String(rows.filter((e) => (e.row.dvPct ?? 0) >= 100).length)} />
        <Stat label="Above the upper intake level"
              value={overUl.length === 0 ? 'none' : String(overUl.length)} />
        {product.servingsPerContainer !== null && (
          <Stat label="Servings in the container" value={product.servingsPerContainer} />
        )}
      </Info>

      {forms.length > 0 && (
        <Info title="Chemical forms used">
          <Note text="The same nutrient comes in different forms, and the maker has to print which one. Taken straight from the label." />
          {forms.map((f, i) => <Bullet key={i} text={f} />)}
        </Info>
      )}

      <Info title="What could not be read">
        {gaps.length === 0
          ? <Bullet text="Every row produced a name, an amount and a percentage." />
          : gaps.map((g, i) => <Bullet key={i} text={g} />)}
      </Info>

      <Research nutrients={nutrients.slice(0, 4)} />

      <Info title="Where this came from">
        <Bullet text={product.source === 'photo'
          ? 'Read from a photograph of the bottle, on the phone.'
          : `NIH Dietary Supplement Label Database, record ${product.dsldId ?? 'unknown'}.`} />
        <Bullet text="Daily Values and upper intake levels: FDA 21 CFR 101.9 and the NIH Office of Dietary Supplements." />
        <Bullet text="No AI was used to read, classify or check anything on this page." />
      </Info>

      {nutrients.length > 0 && (
        <Info title="What each nutrient does">
          <Note text="Daily Values come from FDA regulation (21 CFR 101.9). Descriptions are each nutrient's role in the body, from the NIH Office of Dietary Supplements. Nothing here claims a supplement treats or prevents anything." />
          {nutrients.map((n) => {
            const dv = DAILY_VALUES[n];
            if (dv === undefined) return null;
            return (
              <View key={n} style={s.refRow}>
                <Text style={s.refName}>
                  {n.replace(/\b\w/g, (c) => c.toUpperCase())}
                  <Text style={s.dim}>   DV {dv.amount} {dv.unit}
                    {dv.ul !== null ? `   upper ${dv.ul} ${dv.unit}` : '   no upper limit set'}</Text>
                </Text>
                <Text style={s.refRole}>{dv.role}</Text>
                <Pressable onPress={() => void Linking.openURL(nihUrl(n))}>
                  <Text style={s.link}>NIH fact sheet {'↗'}</Text>
                </Pressable>
              </View>
            );
          })}
        </Info>
      )}
    </ScrollView>
  );
}

function Research({ nutrients }: { nutrients: string[] }) {
  const [data, setData] = useState<Record<string, Paper[]>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setBusy(true); setErr(null);
    try {
      const out: Record<string, Paper[]> = {};
      for (const n of nutrients) out[n] = await papersFor(n, 2);
      setData(out);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not reach PubMed');
    } finally { setBusy(false); }
  };

  if (nutrients.length === 0) return null;
  const loaded = Object.keys(data).length > 0;

  return (
    <Info title="What the research covers">
      <Note text="Live from PubMed, the US National Library of Medicine index. Systematic reviews and meta-analyses only — the top of the evidence hierarchy. Titles are shown as published; the app draws no conclusion from them." />
      {!loaded && (
        <Pressable style={s.button} onPress={() => void load()} disabled={busy}>
          <Text style={s.buttonText}>
            {busy ? 'Searching PubMed…' : `Find studies on ${nutrients.length} nutrients`}
          </Text>
        </Pressable>
      )}
      {err !== null && <Text style={s.bad}>{err}</Text>}
      {Object.entries(data).map(([n, papers]) => (
        <View key={n} style={s.refRow}>
          <Text style={s.refName}>{n.replace(/\b\w/g, (c) => c.toUpperCase())}</Text>
          {papers.length === 0 && <Text style={s.dim}>No reviews indexed.</Text>}
          {papers.map((pp) => (
            <Pressable key={pp.pmid} onPress={() => void Linking.openURL(pubmedUrl(pp.pmid))}>
              <Text style={s.paperTitle}>{pp.title}</Text>
              <Text style={s.paperMeta}>
                {pp.journal}{pp.year !== '' ? `, ${pp.year}` : ''}
                {pp.types.includes('Meta-Analysis') ? '  ·  meta-analysis' : ''}
                {'  ·  PMID ' + pp.pmid}
              </Text>
            </Pressable>
          ))}
        </View>
      ))}
    </Info>
  );
}

function StatementBlock(
  { product, match, title, tone }:
  { product: LabelProduct; match: RegExp; title: string; tone?: 'bad' },
) {
  const hits = product.statements.filter((st) => match.test(st.type));
  if (hits.length === 0) return null;
  return (
    <Info title={title} tone={tone}>
      <Note text="The manufacturer's own printed words, from the NIH label record." />
      {hits.map((st, i) => <Bullet key={i} text={st.text} />)}
    </Info>
  );
}

const Info = ({ title, children, tone }: { title: string; children: React.ReactNode; tone?: 'bad' }) => (
  <View style={[s.card, tone === 'bad' && s.cardBad]}>
    <Text style={s.cardTitle}>{title}</Text>
    {children}
  </View>
);
const Bullet = ({ text }: { text: string }) => (
  <View style={s.bulletRow}>
    <Text style={s.bulletDot}>{'•'}</Text>
    <Text style={s.bulletText}>{text}</Text>
  </View>
);
const Legend = ({ colour, text }: { colour: string; text: string }) => (
  <View style={s.legendItem}>
    <View style={[s.legendDot, { backgroundColor: colour }]} />
    <Text style={s.dim}>{text}</Text>
  </View>
);
const Stat = ({ label, value }: { label: string; value: string }) => (
  <View style={s.statRow}>
    <Text style={s.statLabel}>{label}</Text>
    <Text style={s.statValue}>{value}</Text>
  </View>
);
const Note = ({ text }: { text: string }) => <Text style={s.cardNote}>{text}</Text>;

/* ----------------------------------------------------------- the steps */

const OUTCOME_LABEL: Record<Outcome, string> = {
  ok: 'answered',
  partial: 'partly',
  'not-attempted': 'not attempted',
  'unreadable-input': 'could not read',
  'infrastructure-failure': 'call failed',
  'genuine-no-match': 'no match',
  'needs-human': 'needs you',
};

function outcomeStyle(o: Outcome) {
  if (o === 'ok') return s.pillOk;
  if (o === 'partial' || o === 'needs-human') return s.pillWarn;
  if (o === 'infrastructure-failure' || o === 'unreadable-input') return s.pillBad;
  return s.pillMuted;
}

function StepsView({ resolution }: { resolution: Resolution | null }) {
  if (resolution === null) {
    return (
      <ScrollView contentContainerStyle={s.scroll}>
        <View style={s.card}>
          <Text style={s.cardTitle}>Nothing scanned yet</Text>
          <Note text="Scan a label and every step of the process shows up here — what each rung did, what it produced, and why it stopped." />
        </View>
      </ScrollView>
    );
  }

  const { stages, answeredBy } = resolution;
  const det = stages.filter((x) => x.deterministic).length;

  return (
    <ScrollView contentContainerStyle={s.scroll}>
      <View style={s.card}>
        <Text style={s.cardTitle}>How this was resolved</Text>
        <Note text={`${det} of ${stages.length} steps give the same answer every time. The rest are marked.`} />
        {answeredBy !== null && (
          <Text style={s.ok}>
            Answered by: {stages.find((x) => x.id === answeredBy)?.title ?? answeredBy}
          </Text>
        )}
      </View>

      {stages.map((st, i) => (
        <View key={st.id} style={[s.card, st.id === answeredBy && s.cardAnswered]}>
          <View style={s.tagHead}>
            <Text style={s.cardTitle}>{i + 1}. {st.title}</Text>
            <Text style={[s.pill, outcomeStyle(st.outcome)]}>{OUTCOME_LABEL[st.outcome]}</Text>
          </View>
          <Text style={s.cardNote}>{st.purpose}</Text>
          <Text style={s.bulletText}>{st.detail}</Text>
          <Text style={s.evidence}>
            {st.deterministic ? 'same input, same answer, always' : 'not deterministic — result is memoised'}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

/* ----------------------------------------------------------- the lines */

const TAG_BLURB: Record<string, string> = {
  'panel-anchor': 'The Supplement Facts heading. Everything below it is the panel.',
  'serving-size': 'What counts as one serving.',
  'servings-per-container': 'How many servings in the bottle.',
  'amount-header': 'Column heading. Two of these means two side-by-side tables.',
  'dv-header': 'Column heading for the percentage column.',
  'strength': 'Contains a number and a unit, so it carries an amount.',
  'manufacturer': 'Who makes or distributes it.',
  'other-ingredients-header': 'Start of the fillers list.',
  'count': 'How many tablets or capsules.',
  'ndc': 'A prescription drug code.',
  'gtin': 'A barcode printed as digits.',
  footnote: 'The asterisk note under the panel.',
  unclassified: 'No rule claimed these. Shown, never guessed at.',
};

const EVIDENCE: Record<string, string> = {
  'panel-anchor': 'exact wording required by 21 CFR 101.36',
  'serving-size': 'exact wording required by regulation',
  'servings-per-container': 'exact wording required by regulation',
  'amount-header': 'exact column heading required by regulation',
  'dv-header': 'exact column heading required by regulation',
  footnote: 'the asterisk convention required by regulation',
  'other-ingredients-header': 'exact wording required by regulation',
  strength: 'pattern: a number followed by a unit',
  count: 'pattern: a number followed by a dose form',
  ndc: 'pattern: digits-dash-digits-dash-digits',
  gtin: 'pattern: 12 to 14 straight digits',
  manufacturer: 'phrase: distributed by, manufactured for',
  unclassified: 'no rule matched',
};

/** The parts a Supplement Facts panel is legally required to carry. */
const REQUIRED: { tag: string; label: string }[] = [
  { tag: 'panel-anchor', label: '"Supplement Facts" heading' },
  { tag: 'serving-size', label: 'Serving size' },
  { tag: 'servings-per-container', label: 'Servings per container' },
  { tag: 'amount-header', label: '"Amount Per Serving" column' },
  { tag: 'dv-header', label: '"% Daily Value" column' },
  { tag: 'other-ingredients-header', label: 'Other ingredients list' },
];

/** Signatures of a bad read. Each one is a real failure mode, not a guess. */
function misreadReasons(line: string): string[] {
  const out: string[] = [];
  if (/[^\x00-\x7F]/.test(line)) {
    out.push('contains characters outside the English alphabet');
  }
  if (/\b(?:mcg|mg|iu|g|ml)\d/i.test(line)) {
    out.push('a number is stuck to a unit with no space');
  }
  if (/\b[a-z]{1,2}\d{2,}/i.test(line) && !/\d{4}/.test(line)) {
    out.push('letters and digits run together');
  }
  if (line.trim().length <= 2) out.push('too short to be meaningful on its own');
  return out;
}

const AMOUNT = /(\d+(?:[.,]\d+)?)\s*(mcg|mg|g|IU|mL)\b/gi;

const FAMILIES: { name: string; blurb: string; tags: string[] }[] = [
  {
    name: 'Structure of the panel',
    blurb: 'Wording the law requires on every label. These tell us where the panel starts, ends, and how its columns are arranged.',
    tags: ['panel-anchor', 'serving-size', 'servings-per-container', 'amount-header', 'dv-header', 'footnote', 'other-ingredients-header'],
  },
  {
    name: 'The contents',
    blurb: 'Lines carrying an actual quantity — an ingredient and how much of it, or how many tablets are in the bottle.',
    tags: ['strength', 'count'],
  },
  {
    name: 'Identifying the product',
    blurb: 'Who made it and the codes that can be looked up in a database.',
    tags: ['manufacturer', 'ndc', 'gtin'],
  },
  {
    name: 'Not claimed by any rule',
    blurb: 'Storage notes, warnings, addresses. Left as unknown on purpose — never guessed at.',
    tags: ['unclassified'],
  },
];

function LinesView({ page }: { page: OcrPage }) {
  const byTag = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const l of page.lines) {
      const t = contentTag(l.text);
      m.set(t, [...(m.get(t) ?? []), l.text]);
    }
    return m;
  }, [page]);

  const total = page.lines.length;
  const unclaimed = byTag.get('unclassified')?.length ?? 0;
  const claimed = total - unclaimed;
  const pct = Math.round((claimed / Math.max(total, 1)) * 100);

  const blocks = useMemo(() => findColumnBlocks(page), [page]);
  const words = page.lines.reduce((n, l) => n + l.words.length, 0);
  const heights = page.lines.map((l) => l.box.h).sort((a, b) => a - b);
  const smallest = heights[0] ?? 0;
  const largest = heights[heights.length - 1] ?? 0;
  const tallest = [...page.lines].sort((a, b) => b.box.h - a.box.h)[0];
  const maker = (byTag.get('manufacturer') ?? [])[0] ?? null;

  const suspect = page.lines
    .map((l) => ({ text: l.text, reasons: misreadReasons(l.text) }))
    .filter((x) => x.reasons.length > 0);

  const amounts = useMemo(() => {
    const seen: string[] = [];
    for (const l of page.lines) {
      for (const m of l.text.matchAll(AMOUNT)) seen.push(`${m[1]} ${m[2]!.toLowerCase()}`);
    }
    return seen;
  }, [page]);

  const units = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of amounts) {
      const u = a.split(' ')[1] ?? '';
      m.set(u, (m.get(u) ?? 0) + 1);
    }
    return [...m.entries()].sort((x, y) => y[1] - x[1]);
  }, [amounts]);

  const coverage = page.lines.reduce((n, l) => n + l.box.w * l.box.h, 0);
  const serving = (byTag.get('serving-size') ?? [])[0] ?? null;

  return (
    <ScrollView contentContainerStyle={s.scroll}>
      <View style={s.card}>
        <Text style={s.cardTitle}>How the text was read</Text>
        <View style={s.barTrack}>
          <View style={[s.barFill, { width: `${pct}%` }]} />
        </View>
        <Text style={s.cardNote}>
          {claimed} of {total} lines identified by rule — {pct}%. No AI, no guessing.
          The rules work because a Supplement Facts panel is a format set by law.
        </Text>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>This scan</Text>
        <Stat label="Photo size" value={`${page.width} × ${page.height}`} />
        <Stat label="Lines of text" value={String(total)} />
        <Stat label="Individual words" value={String(words)} />
        <Stat label="Largest text on the label"
              value={tallest !== undefined ? `"${tallest.text.slice(0, 22)}"` : '—'} />
        <Stat label="Smallest text read"
              value={`${(smallest * page.height).toFixed(0)} px tall`} />
        <Stat label="Biggest to smallest"
              value={smallest > 0 ? `${(largest / smallest).toFixed(1)}×` : '—'} />
        {serving !== null && <Stat label="Serving" value={serving.replace(/^Serving Size\s*/i, '')} />}
        {maker !== null && <Stat label="Distributed by" value={maker.replace(/^DISTRIBUTED BY:\s*/i, '').slice(0, 24)} />}
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Required parts, found or missing</Text>
        <Text style={s.cardNote}>
          A Supplement Facts panel must carry these by law (21 CFR 101.36). Finding
          them is how we know we are looking at a panel at all.
        </Text>
        {REQUIRED.map((r) => {
          const hit = (byTag.get(r.tag) ?? []).length > 0;
          return (
            <View key={r.tag} style={s.statRow}>
              <Text style={s.statLabel}>{r.label}</Text>
              <Text style={hit ? s.okText2 : s.dim}>{hit ? '✓ found' : 'not found'}</Text>
            </View>
          );
        })}
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Panel layout</Text>
        <Text style={s.cardNote}>
          {blocks.length === 0
            ? 'No column headers paired up, so this is not a standard panel layout.'
            : blocks.length === 1
              ? 'One table of ingredients.'
              : `${blocks.length} tables printed side by side. Lines at the same height belong to different tables — grouping by height alone would merge them into nonsense.`}
        </Text>
        {blocks.map((b: ColumnBlock, i: number) => (
          <Stat key={i} label={`Table ${i + 1}`}
                value={`names from ${(b.nameX * 100).toFixed(0)}%, %DV ends ${(b.dvRight * 100).toFixed(0)}%`} />
        ))}
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Numbers pulled off the label</Text>
        <Text style={s.cardNote}>
          Every amount the reader found, with the mix of units. A panel that uses
          four different units is four chances to convert something wrongly.
        </Text>
        <Stat label="Amounts found" value={String(amounts.length)} />
        {units.map(([u, n]) => <Stat key={u} label={`in ${u}`} value={String(n)} />)}
        <Stat label="Share of the photo that is text"
              value={`${(coverage * 100).toFixed(1)}%`} />
      </View>

      <View style={[s.card, suspect.length > 0 && s.cardBad]}>
        <Text style={s.cardTitle}>Lines worth a second look</Text>
        <Text style={s.cardNote}>
          Flagged by signature, not by confidence score. These are the shapes a
          misread leaves behind — the reader does not know it got them wrong.
        </Text>
        {suspect.length === 0
          ? <Bullet text="Nothing on this label tripped a misread signature." />
          : suspect.map((x, i) => (
              <View key={i} style={s.statRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.famLine} numberOfLines={1}>{x.text}</Text>
                  <Text style={s.evidence}>{x.reasons.join('; ')}</Text>
                </View>
              </View>
            ))}
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Where each kind sat on the label</Text>
        <Text style={s.cardNote}>
          Every line in its real position on the photograph. Position is half the
          work — it is how two side-by-side tables get told apart.
        </Text>
        <View style={s.map}>
          {page.lines.map((l, i) => {
            const fam = FAMILIES.find((f) => f.tags.includes(contentTag(l.text)));
            const colour = fam === undefined || fam.tags[0] === 'unclassified'
              ? '#39404B'
              : fam.name.startsWith('Structure') ? '#EF9F27'
              : fam.name.startsWith('The contents') ? '#1D9E75' : '#378ADD';
            return (
              <View key={i} style={{
                position: 'absolute',
                left: `${l.box.x * 100}%`, top: `${l.box.y * 100}%`,
                width: `${Math.max(l.box.w, 0.01) * 100}%`,
                height: `${Math.max(l.box.h, 0.006) * 100}%`,
                backgroundColor: colour, borderRadius: 1,
              }} />
            );
          })}
        </View>
        <View style={s.legendRow}>
          <Legend colour="#EF9F27" text="structure" />
          <Legend colour="#1D9E75" text="contents" />
          <Legend colour="#378ADD" text="identifiers" />
          <Legend colour="#39404B" text="unmatched" />
        </View>
      </View>

      {FAMILIES.map((fam) => {
        const present = fam.tags
          .map((t) => [t, byTag.get(t) ?? []] as const)
          .filter(([, v]) => v.length > 0);
        if (present.length === 0) return null;
        const count = present.reduce((n, [, v]) => n + v.length, 0);
        const dim = fam.tags[0] === 'unclassified';
        return (
          <View key={fam.name} style={[s.card, dim && s.cardDim]}>
            <View style={s.tagHead}>
              <Text style={s.cardTitle}>{fam.name}</Text>
              <Text style={s.countChip}>{count}</Text>
            </View>
            <Text style={s.cardNote}>{fam.blurb}</Text>
            {present.map(([tag, lines]) => (
              <View key={tag} style={s.famBlock}>
                <Text style={[s.pill, dim && s.pillMuted]}>{tag}</Text>
                {EVIDENCE[tag] !== undefined && (
                  <Text style={s.evidence}>matched by {EVIDENCE[tag]}</Text>
                )}
                {lines.slice(0, dim ? 4 : 8).map((t, i) => (
                  <Text key={i} style={s.famLine} numberOfLines={1}>{t}</Text>
                ))}
                {lines.length > (dim ? 4 : 8) && (
                  <Text style={s.dim}>and {lines.length - (dim ? 4 : 8)} more</Text>
                )}
              </View>
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
}

/* ------------------------------------------------------------ find tab */

function FindView({ onPick }: { onPick: (p: LabelProduct) => void }) {
  const [q, setQ] = useState('Nature Made Multi');
  const [hits, setHits] = useState<DsldHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setErr(null);
    try { setHits(await searchDsld(q.trim())); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Search failed'); setHits(null); }
    finally { setBusy(false); }
  };

  const open = async (id: string) => {
    setLoadingId(id); setErr(null);
    try { onPick(await fetchDsldLabel(id)); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not load that label'); }
    finally { setLoadingId(null); }
  };

  return (
    <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
      <View style={s.card}>
        <Text style={s.cardTitle}>Find a supplement</Text>
        <Note text="Searches the live NIH Dietary Supplement Label Database — the same source HIP mirrors. Pick one and its label is rebuilt on the Label tab." />
        <TextInput
          value={q} onChangeText={setQ} style={s.input}
          placeholder="Brand and product name" placeholderTextColor="#6F7680"
          autoCorrect={false} returnKeyType="search" onSubmitEditing={() => void run()}
        />
        <Pressable style={s.button} onPress={() => void run()} disabled={busy}>
          <Text style={s.buttonText}>{busy ? 'Searching…' : 'Search'}</Text>
        </Pressable>
        {err !== null && <Text style={s.bad}>{err}</Text>}
      </View>

      {hits !== null && hits.length === 0 && (
        <View style={s.card}><Text style={s.bulletText}>No products matched.</Text></View>
      )}

      {(hits ?? []).map((h) => (
        <Pressable key={h.id} style={s.card} onPress={() => void open(h.id)}>
          <Text style={s.refName}>{h.fullName}</Text>
          <Text style={s.cardNote}>
            {h.brandName}{h.netContents !== null ? `  ·  ${h.netContents}` : ''}
            {h.offMarket ? '  ·  off market' : ''}
          </Text>
          <Text style={loadingId === h.id ? s.ok : s.dim}>
            {loadingId === h.id
              ? 'Loading label…'
              : `${h.ingredients.length} ingredients · tap to rebuild this label`}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/* ---------------------------------------------------------- camera tab */

/* ------------------------------------------------- what a surface means */
//
// The surface is NOT a label on the scan any more. It picks the geometry
// path, and that is the only honest reason to ask the question: a selector
// that changes nothing is worse than no selector, because it invites the
// person to believe they told the app something useful.
//
// Mode and surface are deliberately ORTHOGONAL. Mode is how many photographs
// you are offered; surface is what is done with them. Folding "round bottle"
// into the mode list, as an earlier build did, is what made this confusing:
// it put one question in two places and left them free to disagree.

const SURFACES = [
  { key: 'flat', label: 'Flat',
    hint: 'Read each photograph as it is.' },
  { key: 'cylindrical', label: 'Cylindrical',
    hint: 'Unroll the curve and join the frames into one panel.' },
  { key: 'other', label: 'Other',
    hint: 'Read as flat, and tag the scan so it can be filtered later.' },
] as const;
type SurfaceKey = (typeof SURFACES)[number]['key'];

/**
 * Where the guide rails sit, as a fraction of the frame's width.
 *
 * The person fits the bottle between the rails, and in doing so says where
 * its axis is and how wide it appears — the whole calibration the unrolling
 * needs, without segmenting the bottle out of the image. Fixed rails also
 * put every frame on the same scale, which is what lets frames be placed
 * against each other at all.
 *
 * Hardcoded for now. Draggable rails are the right answer and are the next
 * change to make here.
 */
const RAILS: CylinderCalibration = { centreX: 0.5, radiusPx: 0.3 };

type CaptureMode = 'simple' | 'guided';

const MODES: { key: CaptureMode; label: string; hint: string }[] = [
  { key: 'simple', label: 'Simple',
    hint: 'One photograph of the label, and the front of the pack if you want it.' },
  { key: 'guided', label: 'Guided',
    hint: 'The same, plus as many more photographs of the label as you like.' },
];

/**
 * In Guided, what the extra label photographs ARE.
 *
 * This is not a cosmetic distinction and getting it wrong is what broke the
 * three-photograph case. Two photographs of the same label overlap almost
 * completely; two photographs of HALVES of a label overlap barely at all.
 * Code that assumes the first and is handed the second throws the second
 * photograph away — which is exactly what happened, because the cylindrical
 * path tries to place frames against each other by matching shared words and
 * has nothing to match on when the halves are disjoint.
 *
 * Panels split into two side-by-side mini-tables are common; on a narrow
 * carton it is the normal layout.
 */
type Coverage = 'repeat' | 'parts';

const COVERAGES: { key: Coverage; label: string; hint: string }[] = [
  { key: 'repeat', label: 'Same label again',
    hint: 'Every photograph shows the whole label. Readings of a row are '
        + 'compared and the one whose arithmetic checks out wins.' },
  { key: 'parts', label: 'Label in parts',
    hint: 'Each photograph shows a different part of the label. Every part is '
        + 'read on its own and the rows are added together.' },
];

/** One photograph taken or imported during a capture. */
interface Frame {
  uri: string;
  page: OcrPage;
  /** The hairlines the label prints between its rows, when any were found. */
  separators: Separator[];
  /** What it is being treated as. The person can change this. */
  role: FrameRole;
  /** What detection said, kept so an override is visible as an override. */
  autoRole: FrameRole;
  /** Why detection said it, shown under the frame. */
  verdict: RoleVerdict;
  /** True when the recogniser needed its slower, finer pass. */
  fine: boolean;
}

/**
 * Write the scan to disk. Deliberately swallows its own failures: a scan that
 * could not be saved is still a scan the person in front of the phone wants
 * to see, and losing the result because the filesystem complained would be
 * the worse bug by far.
 */
async function persistScan(
  r: Resolution,
  frames: readonly Frame[],
  surface: string,
  note: string,
  cylinder: CylinderRecord | null,
): Promise<string | null> {
  if (!storageAvailable()) return null;
  try {
    const id = scanId();
    // savePhotos keys files by step, so only the first photograph of each
    // role can have a file of its own. Every page is kept in the record
    // regardless, and the page is the part that matters.
    const seen = new Set<CaptureStep>();
    const first: { step: CaptureStep; uri: string }[] = [];
    for (const f of frames) {
      if (seen.has(f.role)) continue;
      seen.add(f.role);
      first.push({ step: f.role, uri: f.uri });
    }
    const photos = await savePhotos(id, first);
    const cylinders: Partial<Record<CaptureStep, CylinderRecord>> = {};
    if (cylinder !== null) cylinders.panel = cylinder;
    const rec = buildRecord(id, r, photos, surface,
      note.trim().length > 0 ? note.trim() : null, cylinders);
    await saveScan(rec);
    return id;
  } catch {
    return null;
  }
}

/**
 * Turn the photographs into the shots the ladder takes.
 *
 * This is the only place the surface and coverage choices bite, and
 * everything downstream — readShot, parsePanel, mergeShots — is untouched
 * and never learns which path was taken.
 *
 * The four combinations, and why they differ:
 *
 *   flat + anything      every photograph is its own shot. mergeShots unions
 *                        rows with new names and arbitrates between repeats,
 *                        which is already correct for both coverages.
 *
 *   cylindrical + repeat the frames overlap, so they are unrolled and JOINED
 *                        into one synthetic flat page. This needs shared
 *                        words between frames and is the right thing for a
 *                        sweep round a bottle.
 *
 *   cylindrical + parts  the frames do NOT overlap, so joining them is
 *                        impossible and attempting it discards every frame
 *                        after the first. Each is unrolled ON ITS OWN and
 *                        becomes its own shot. This is the bug fix: three
 *                        photographs used to produce one photograph's rows.
 */
interface Plan { inputs: CaptureInput[]; cylinder: CylinderRecord | null; note: string }

/**
 * How much a plan actually got out of the photographs.
 *
 * Verified rows first, because arithmetic agreement is the only signal here
 * that can PROVE a transcription — a row whose amount and printed percentage
 * agree was read correctly. Then rows carrying an amount, then rows at all.
 */
function scorePlan(plan: Plan): number {
  let verified = 0;
  let withAmount = 0;
  let rows = 0;
  for (const input of plan.inputs) {
    if (input.page === undefined) continue;
    for (const r of parsePanel(input.page).rows) {
      rows++;
      if (r.amount !== null) withAmount++;
      if (checkRow(r.name, r.amount, r.unit, r.dvPct).status === 'verified') verified++;
    }
  }
  return verified * 10000 + withAmount * 100 + rows;
}

/**
 * Choose the geometry, then check it helped.
 *
 * The surface selector says what the person believes they photographed, and
 * it should be taken seriously — but unrolling a FLAT label as though it
 * were curved actively damages it, and on a test rig the wrong chip should
 * never produce a worse reading than the right one would. So the plain
 * reading is always computed too, and whichever actually extracted more
 * wins. Cylindrical still differs wherever it genuinely helps; it just
 * cannot make things worse any more.
 */
function planShots(
  frames: readonly Frame[], surface: SurfaceKey, coverage: Coverage,
): Plan {
  const chosen = planFor(frames, surface, coverage);
  if (surface !== 'cylindrical') return chosen;

  const plain = planFor(frames, 'flat', coverage);
  if (scorePlan(plain) > scorePlan(chosen)) {
    return {
      ...plain,
      note: `${plain.note || 'read as flat'} — unrolling found less on these `
          + 'photographs, so the plain reading was kept',
    };
  }
  return chosen;
}

function planFor(
  frames: readonly Frame[], surface: SurfaceKey, coverage: Coverage,
): Plan {
  const panels = frames.filter((f) => f.role === 'panel');
  const fronts = frames.filter((f) => f.role === 'front');
  const asInput = (f: Frame): CaptureInput =>
    ({ step: f.role, uri: f.uri, page: f.page, separators: f.separators });

  if (surface !== 'cylindrical' || panels.length === 0) {
    return {
      inputs: frames.map(asInput),
      cylinder: null,
      note: panels.length > 1
        ? `${panels.length} label photographs read separately, rows combined`
        : '',
    };
  }

  // Curved, and each photograph is a different part: unroll each one so its
  // own curvature is corrected, but do not try to place them against each
  // other. There is nothing to place them with.
  if (coverage === 'parts') {
    // Unrolling moves the text, so the separators found on the raw frame no
    // longer line up with it. Dropped rather than warped: a row boundary in
    // the wrong place is worse than none, and the measured grouping is a
    // working fallback.
    const flattened = panels.map((f) => ({
      ...f, page: unrollPage(f.page, RAILS), separators: [],
    }));
    return {
      inputs: [...flattened.map(asInput), ...fronts.map(asInput)],
      cylinder: {
        frames: panels.map((f) => f.page),
        calibrations: panels.map(() => RAILS),
        report: {
          frames: panels.length,
          unroll: [],
          join: {
            joined: panels.length, dropped: 0, offsets: [], droppedFrames: [],
            coverage: panels.length, deduped: 0, dedupedText: [],
          },
          calibrationDrift: null,
        },
      },
      note: `${panels.length} parts unrolled separately, rows combined`,
    };
  }

  const got = unrollAndJoin(panels.map((f) => ({ page: f.page, cal: RAILS })));
  const join = got.report.join;

  // A frame the join could not place is NOT thrown away. It goes in as an
  // independent panel shot, so whatever rows it holds still reach mergeShots
  // and still reach the saved record.
  const unplaced = join.droppedFrames
    .map((d) => panels[d.frame])
    .filter((f): f is Frame => f !== undefined);

  const inputs: CaptureInput[] = [
    { step: 'panel', uri: panels[0]?.uri ?? '', page: got.page },
    ...unplaced.map(asInput),
    ...fronts.map(asInput),
  ];

  const lost = got.report.unroll.reduce((n, u) => n + u.dropped, 0);
  return {
    inputs,
    cylinder: {
      frames: panels.map((f) => f.page),
      calibrations: panels.map(() => RAILS),
      report: got.report,
    },
    note: `${join.joined} of ${panels.length} frames joined`
        + (join.dropped > 0 ? `, ${join.dropped} kept separately` : '')
        + (join.deduped > 0 ? `, ${join.deduped} duplicate lines removed` : '')
        + (lost > 0 ? `, ${lost} lines past the readable arc` : ''),
  };
}

function CameraTab({ onResolved }: { onResolved: (r: Resolution) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const ref = useRef<CameraView>(null);
  const [mode, setMode] = useState<CaptureMode>('simple');
  const [frames, setFrames] = useState<Frame[]>([]);
  const [stage, setStage] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [surface, setSurface] = useState<SurfaceKey>('flat');
  const [coverage, setCoverage] = useState<Coverage>('repeat');
  const [note, setNote] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const locked = useRef(false);

  // A detected barcode is a NOTE, not a state change. It must never touch
  // `stage`: stage disables the shutter, and a label with a barcode in frame
  // re-triggers this constantly, which left the button permanently dead.
  const onBarcode = ({ data }: { data: string }) => {
    if (locked.current) return;
    locked.current = true;
    setCode(data);
    setTimeout(() => { locked.current = false; }, 2600);
  };

  const panels = frames.filter((f) => f.role === 'panel').length;
  const fronts = frames.filter((f) => f.role === 'front').length;
  // Simple is one label photo plus an optional front. Guided is the same with
  // no ceiling on extra label photos.
  const canAddLabel = mode === 'guided' || panels === 0;

  /** A live preview of what the surface choice will do, before committing. */
  const preview = useMemo(() => {
    if (frames.length === 0) return null;
    const plan = planShots(frames, surface, coverage);
    return { shots: plan.inputs.length, note: plan.note };
  }, [frames, surface, coverage]);

  const shoot = async (): Promise<{
    uri: string; page: OcrPage; separators: Separator[]; fine: boolean;
  }> => {
    // THROW rather than return null. `stage` being set is what disables every
    // button, so a quiet early return here left the screen locked with no way
    // out. Every caller already has a catch that clears it on a timer.
    if (ref.current === null) throw new Error('Camera is not ready yet.');
    // quality 1 on purpose: Supplement Facts type is ~6 point, and JPEG
    // compression smears exactly the thin strokes the recogniser needs.
    const photo = await ref.current.takePictureAsync({ quality: 1, skipProcessing: false });
    if (photo === undefined) throw new Error('The camera returned no photo.');
    // Two passes when the first is thin, so 6-point panel type gets a proper
    // look before the photograph is written off as unreadable.
    const got = await readBestEffort(photo.uri, recognizeText, recognizeTiled);
    // The printed rules, looked for alongside the text. Never fatal: an
    // empty list simply means rows are measured from the text as before.
    const seps = await detectSeparators(photo.uri);
    return {
      uri: photo.uri, page: got.page, separators: seps,
      fine: got.usedFinePass || got.usedTiles,
    };
  };

  /**
   * Add a photograph. NOTHING IS EVER REFUSED HERE.
   *
   * An earlier build dropped a frame when it found no "Supplement Facts"
   * heading, and dropped another when it would not overlap its predecessor.
   * Both threw away a photograph the person had taken and the recogniser had
   * already read — the exact opposite of what a test rig is for. A frame with
   * nothing legible on it at all is still kept, still shown, and still saved,
   * because a photograph that produced nothing is the most interesting one in
   * the set.
   */
  const addFrame = (
    uri: string, page: OcrPage, fine: boolean, separators: Separator[] = [],
  ): Frame => {
    const verdict = detectRole(page);
    const f: Frame = {
      uri, page, separators, role: verdict.role, autoRole: verdict.role, verdict, fine,
    };
    setFrames((prev) => [...prev, f]);
    return f;
  };

  const say = (msg: string, ms = 2600): void => {
    setFlash(msg);
    setTimeout(() => setFlash(null), ms);
  };

  const describeFrame = (f: Frame, n: number): string => {
    if (f.page.lines.length === 0) {
      return `Photo ${n}: nothing legible — kept anyway so it can be diagnosed`;
    }
    const rows = readShot(f.role, f.page).panel.rows.length;
    return `Photo ${n} read as ${roleLabel(f.role).toLowerCase()}: `
         + `${f.page.lines.length} lines`
         + (rows > 0 ? `, ${rows} rows` : '')
         + (f.fine ? ' (needed the fine pass)' : '');
  };

  const capture = async () => {
    setStage('Reading this photograph on the device…');
    try {
      const got = await shoot();
      const f = addFrame(got.uri, got.page, got.fine, got.separators);
      setStage(null);
      say(describeFrame(f, frames.length + 1), 3000);
    } catch (e) {
      setStage(e instanceof Error ? e.message : 'Could not take that photo');
      setTimeout(() => setStage(null), 3200);
    }
  };

  /** Bring in photographs already on the phone — the whole test set at once. */
  const pickFromLibrary = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setStage('Photo access was declined.'); return; }
    // quality 1 here too: a re-compressed pick is a worse read for no reason.
    const res = await ImagePicker.launchImageLibraryAsync({
      quality: 1, allowsMultipleSelection: true, selectionLimit: 12,
    });
    if (res.canceled || res.assets.length === 0) return;

    const added: Frame[] = [];
    for (let i = 0; i < res.assets.length; i++) {
      const asset = res.assets[i];
      if (asset === undefined) continue;
      setStage(`Reading photograph ${i + 1} of ${res.assets.length}…`);
      try {
        const got = await readBestEffort(asset.uri, recognizeText, recognizeTiled);
        const verdict = detectRole(got.page);
        added.push({
          uri: asset.uri, page: got.page, separators: await detectSeparators(asset.uri),
          role: verdict.role,
          autoRole: verdict.role, verdict, fine: got.usedFinePass || got.usedTiles,
        });
      } catch {
        // Even a photograph the recogniser refused is kept, with an empty
        // page, so the set that was imported matches the set on screen.
        const empty: OcrPage = {
          source: asset.uri, width: 0, height: 0, engine: 'unread', lines: [],
        };
        added.push({
          uri: asset.uri, page: empty, separators: [], role: 'panel', autoRole: 'panel',
          verdict: detectRole(empty), fine: false,
        });
      }
    }
    setFrames((prev) => [...prev, ...added]);
    setStage(null);
    const read = added.filter((f) => f.page.lines.length > 0).length;
    say(`Imported ${added.length} photograph${added.length === 1 ? '' : 's'}, `
      + `${read} with text`, 3200);
  };

  const finish = async () => {
    if (frames.length === 0) { setStage('Nothing photographed yet.'); return; }
    const plan = planShots(frames, surface, coverage);
    setStage(frames.length > 1
      ? `Combining ${frames.length} photographs…`
      : 'Reading the label on this device…');
    try {
      const r = await resolveFromShots(plan.inputs);

      // SAVE FIRST, ALWAYS. The scan most worth keeping is the one that went
      // wrong, and this is where it used to be thrown away: the old code
      // returned here on a bad read, before saving and before showing
      // anything, so a failed scan left no trace on screen or on disk.
      const surfaceLabel = surface === 'other' && note.trim().length > 0
        ? `other: ${note.trim()}`
        : SURFACES.find((x) => x.key === surface)?.label ?? 'flat';
      await persistScan(r, frames, surfaceLabel, note, plan.cylinder);

      const rows = r.merged?.rows.length ?? 0;
      const verified = (r.merged?.rows ?? []).filter(
        (x) => checkRow(x.name, x.amount, x.unit, x.dvPct).status === 'verified').length;
      setStage(null);
      say(
        rows > 0
          ? `${rows} ingredients, ${verified} verified`
          : r.pack !== null && r.pack.claimed > 0
            ? `No panel in frame — read ${r.pack.claimed} lines off the packaging`
            : 'Almost nothing readable — saved so it can be diagnosed',
        3200);
      setFrames([]); setNote('');
      onResolved(r);
    } catch (e) {
      setStage(e instanceof Error ? e.message : 'Could not read that photo');
      setTimeout(() => setStage(null), 3200);
    }
  };

  if (!permission) return <View style={s.center}><ActivityIndicator /></View>;

  const busy = stage !== null;

  return (
    <View style={s.cameraWrap}>
      {permission.granted
        ? <CameraView
            ref={ref}
            style={s.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e'] }}
            onBarcodeScanned={onBarcode}
          />
        : (
          <View style={s.center}>
            <Text style={s.bulletText}>The camera needs your permission.</Text>
            <Pressable style={s.button} onPress={() => void requestPermission()}>
              <Text style={s.buttonText}>Allow camera</Text>
            </Pressable>
          </View>
        )}

      {/* The rails are the calibration, so they are drawn where the maths
          expects them: RAILS.centreX +/- RAILS.radiusPx of the frame width.
          Shown only for the surface that uses them. */}
      {surface === 'cylindrical' && permission.granted && (
        <View style={s.railWrap} pointerEvents="none">
          <View style={[s.rail, { left: `${(RAILS.centreX - RAILS.radiusPx) * 100}%` }]} />
          <View style={[s.rail, { left: `${(RAILS.centreX + RAILS.radiusPx) * 100}%` }]} />
          <View style={[s.railAxis, { left: `${RAILS.centreX * 100}%` }]} />
          <View style={[s.railArc, {
            left: `${(RAILS.centreX - RAILS.radiusPx * READABLE_ARC) * 100}%`,
            width: `${RAILS.radiusPx * READABLE_ARC * 200}%`,
          }]} />
        </View>
      )}

      {busy && (
        <View style={s.overlay}>
          <ActivityIndicator color="#5DCAA5" />
          <Text style={s.overlayText}>{stage}</Text>
        </View>
      )}
      {!busy && flash !== null && (
        <View style={s.flash}><Text style={s.flashText}>{flash}</Text></View>
      )}

      <ScrollView
        style={s.cameraBar}
        contentContainerStyle={s.cameraBarInner}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.modeRow}>
          {MODES.map((m) => (
            <Pressable
              key={m.key}
              onPress={() => setMode(m.key)}
              style={[s.modeChip, mode === m.key && s.modeChipOn]}
            >
              <Text style={[s.modeChipText, mode === m.key && s.modeChipTextOn]}>
                {m.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={s.surfaceRow}>
          {SURFACES.map((x) => (
            <Pressable
              key={x.key}
              onPress={() => setSurface(x.key)}
              style={[s.surfaceChip, surface === x.key && s.surfaceChipOn]}
            >
              <Text style={[s.surfaceChipText, surface === x.key && s.surfaceChipTextOn]}>
                {x.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {mode === 'guided' && (
          <View style={s.surfaceRow}>
            {COVERAGES.map((c) => (
              <Pressable
                key={c.key}
                onPress={() => setCoverage(c.key)}
                style={[s.surfaceChip, coverage === c.key && s.surfaceChipOn]}
              >
                <Text style={[s.surfaceChipText, coverage === c.key && s.surfaceChipTextOn]}
                      numberOfLines={1}>
                  {c.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        <Text style={s.cameraNote}>
          {MODES.find((m) => m.key === mode)?.hint}
          {'  '}
          {SURFACES.find((x) => x.key === surface)?.hint}
          {mode === 'guided' ? `  ${COVERAGES.find((c) => c.key === coverage)?.hint}` : ''}
        </Text>
        {surface === 'cylindrical' && (
          <Text style={s.evidence}>
            Stand the bottle on a table and fit it between the lines, then move
            the phone around it. Each photograph is unrolled and the frames are
            joined into one panel.
          </Text>
        )}

        {surface === 'other' && (
          <TextInput
            value={note}
            onChangeText={setNote}
            style={s.noteInput}
            placeholder="What surface? e.g. sachet, blister pack, box"
            placeholderTextColor="#6F7680"
            autoCorrect={false}
          />
        )}

        {/* Every photograph taken, what it was read as, and a tap to correct
            it. Detection is good, not infallible, and the override is cheaper
            than making the person re-shoot. */}
        {frames.length > 0 && (
          <View style={s.sweepBox}>
            <View style={s.subRow}>
              <Text style={s.statLabel}>
                {panels} label · {fronts} front
                {preview !== null ? ` · ${preview.shots} shot${preview.shots === 1 ? '' : 's'}` : ''}
              </Text>
              <Pressable onPress={() => setFrames([])} disabled={busy}>
                <Text style={s.resetChip}>Clear</Text>
              </Pressable>
            </View>
            {frames.map((f, i) => (
              <View key={`${f.uri}-${i}`} style={s.frameRow}>
                <View style={s.subRow}>
                  <Text style={s.statLabel} numberOfLines={1}>
                    {i + 1}. {f.page.lines.length} lines
                    {f.page.lines.length === 0 ? ' — nothing legible' : ''}
                    {f.fine ? ' · fine pass' : ''}
                  </Text>
                  <Pressable
                    onPress={() => setFrames((prev) => prev.map((x, j) =>
                      j === i ? { ...x, role: x.role === 'panel' ? 'front' : 'panel' } : x))}
                    disabled={busy}
                  >
                    <Text style={s.resetChip}>{roleLabel(f.role)}</Text>
                  </Pressable>
                </View>
                {/* The reason, so a wrong call is visible rather than silent. */}
                <Text style={s.evidence} numberOfLines={2}>
                  {f.role === f.autoRole
                    ? `${f.verdict.confidence}: ${f.verdict.why}`
                    : `you set this to ${roleLabel(f.role)} — detection said `
                      + `${roleLabel(f.autoRole)} because ${f.verdict.why}`}
                </Text>
              </View>
            ))}
            {preview !== null && preview.note.length > 0 && (
              <Text style={s.evidence}>{preview.note}</Text>
            )}
          </View>
        )}

        <View style={s.cameraRow}>
          <Pressable
            style={[s.button, s.half, (busy || !canAddLabel) && s.buttonOff]}
            onPress={() => void capture()}
            disabled={busy || !canAddLabel || !permission.granted}
          >
            <Text style={s.buttonText}>
              {panels === 0 ? 'Photograph the label'
                : canAddLabel ? `Add label photo ${panels + 1}`
                : 'Label photographed'}
            </Text>
          </Pressable>
          <Pressable
            style={[s.button, s.buttonAlt, s.half, busy && s.buttonOff]}
            onPress={() => void pickFromLibrary()}
            disabled={busy}
          >
            <Text style={s.buttonText}>Choose photos</Text>
          </Pressable>
        </View>

        <Pressable
          style={[s.button, s.buttonAlt, busy && s.buttonOff]}
          onPress={() => void capture()}
          disabled={busy || !permission.granted}
        >
          <Text style={s.buttonText}>
            {fronts === 0 ? 'Photograph the front (optional)' : 'Another photo'}
          </Text>
        </Pressable>

        <Pressable
          style={[s.button, (busy || frames.length === 0) && s.buttonOff]}
          onPress={() => void finish()}
          disabled={busy || frames.length === 0}
        >
          <Text style={s.buttonText}>
            {frames.length === 0
              ? 'Read the label — nothing photographed yet'
              : `Read ${frames.length} photograph${frames.length === 1 ? '' : 's'}`}
          </Text>
        </Pressable>

        <Text style={s.evidence}>
          {code !== null ? `Barcode ${code} detected.  ` : ''}
          {storageAvailable()
            ? 'Every scan is saved on this phone with its raw reading, so a bad one can be reproduced later.'
            : 'This build cannot save scans — results will be lost when the app closes.'}
        </Text>
      </ScrollView>
    </View>
  );
}

/* ----------------------------------------------------------- scans tab */

const BYTES = (n: number): string =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

const WHEN = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

function ScansView(
  { epoch, onChanged, onOpen }:
  { epoch: number; onChanged: () => void; onOpen: (r: Resolution) => void },
) {
  const [rows, setRows] = useState<ScanSummary[]>([]);
  const [used, setUsed] = useState(0);
  const [open, setOpen] = useState<ScanRecord | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Null means ordinary browsing. A Set — even an empty one — means the list
  // is in selection mode, so "selecting none" stays a real state rather than
  // silently dropping back out of the mode under the person's finger.
  const [picked, setPicked] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!storageAvailable()) return;
    setRows(listScans());
    setUsed(storageUsed());
  }, [epoch]);

  const refresh = () => { setRows(listScans()); setUsed(storageUsed()); onChanged(); };

  const selecting = picked !== null;
  const chosen = picked?.size ?? 0;

  const toggle = (id: string): void => setPicked((prev) => {
    const next = new Set(prev ?? []);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /**
   * Delete everything selected, after asking.
   *
   * Asking is not ceremony here. A scan is the only copy of a photograph
   * someone walked into a shop to take, and the whole point of keeping them
   * is that the bad ones are reproducible later. An undo would be better
   * still, but a confirmation that names the count is the honest minimum.
   */
  const deletePicked = (): void => {
    if (picked === null || picked.size === 0) return;
    const ids = [...picked];
    const many = ids.length === 1 ? 'this scan' : `these ${ids.length} scans`;
    Alert.alert(
      `Delete ${ids.length === 1 ? 'scan' : `${ids.length} scans`}?`,
      `The photographs and the recognised text in ${many} will be removed from `
      + 'this phone. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            let failed = 0;
            for (const id of ids) {
              try { deleteScan(id); } catch { failed++; }
            }
            setPicked(null);
            refresh();
            setErr(failed > 0
              ? `${failed} scan${failed === 1 ? '' : 's'} could not be deleted.`
              : null);
          },
        },
      ],
    );
  };

  const doExportAll = async (ids?: readonly string[]) => {
    setBusy(ids === undefined ? 'Bundling every scan…' : `Bundling ${ids.length} scans…`);
    setErr(null);
    try {
      const out = await exportAll(APP_VERSION, ids);
      if (out === null) { setErr('There is nothing saved to export yet.'); return; }
      await shareFile(out.uri, `${out.count} HIP scans`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not export');
    } finally { setBusy(null); }
  };

  const doExportOne = async (id: string) => {
    setBusy('Preparing that scan…'); setErr(null);
    try {
      const out = await exportOne(id);
      if (out === null) { setErr('That scan could not be read back.'); return; }
      await shareFile(out.uri, 'HIP scan');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not export');
    } finally { setBusy(null); }
  };

  const replay = async (rec: ScanRecord) => {
    setBusy('Replaying the stored reading…'); setErr(null);
    try {
      onOpen(await resolveFromShots(replayInputs(rec)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not replay that scan');
    } finally { setBusy(null); }
  };

  if (!storageAvailable()) {
    return (
      <ScrollView contentContainerStyle={s.scroll}>
        <View style={[s.card, s.cardBad]}>
          <Text style={s.cardTitle}>Saving is not available in this build</Text>
          <Note text="The native filesystem module is missing, so scans exist only while the app is open. A full native build restores this." />
        </View>
      </ScrollView>
    );
  }

  if (open !== null) {
    return (
      <ScanDetail
        rec={open}
        busy={busy}
        onBack={() => setOpen(null)}
        onReplay={() => void replay(open)}
        onExport={() => void doExportOne(open.id)}
        onDelete={() => { deleteScan(open.id); setOpen(null); refresh(); }}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={s.scroll}>
      <View style={s.card}>
        <Text style={s.cardTitle}>Saved scans</Text>
        <Text style={s.cardNote}>
          Every scan is written to this phone with the full recognised text — every
          line, every word, every position on the photograph. That is what makes a
          failure in a shop reproducible on a laptop afterwards, instead of being an
          anecdote.
        </Text>
        <Stat label="Scans kept" value={String(rows.length)} />
        <Stat label="Storage used" value={BYTES(used)} />

        {selecting ? (
          <>
            <View style={s.subRow}>
              <Text style={s.statValue}>
                {chosen === 0 ? 'Select scans to delete' : `${chosen} selected`}
              </Text>
              <Pressable
                onPress={() => setPicked(chosen === rows.length
                  ? new Set()
                  : new Set(rows.map((r) => r.id)))}
              >
                <Text style={s.resetChip}>
                  {chosen === rows.length && rows.length > 0 ? 'Deselect all' : 'Select all'}
                </Text>
              </Pressable>
            </View>
            <View style={s.cameraRow}>
              <Pressable
                style={[s.button, s.half, (busy !== null || chosen === 0) && s.buttonOff]}
                onPress={() => void doExportAll([...(picked ?? [])])}
                disabled={busy !== null || chosen === 0}
              >
                <Text style={s.buttonText}>
                  {chosen === 0 ? 'Export' : `Export ${chosen}`}
                </Text>
              </Pressable>
              <Pressable
                style={[s.button, s.half, s.buttonDanger, chosen === 0 && s.buttonOff]}
                onPress={deletePicked}
                disabled={chosen === 0}
              >
                <Text style={s.buttonText}>
                  {chosen === 0 ? 'Delete' : `Delete ${chosen}`}
                </Text>
              </Pressable>
            </View>
            <Pressable style={[s.button, s.buttonAlt]} onPress={() => setPicked(null)}>
              <Text style={s.buttonText}>Cancel</Text>
            </Pressable>
          </>
        ) : (
          <View style={s.cameraRow}>
            <Pressable
              style={[s.button, s.half, (busy !== null || rows.length === 0) && s.buttonOff]}
              onPress={() => void doExportAll()}
              disabled={busy !== null || rows.length === 0}
            >
              <Text style={s.buttonText}>
                {busy ?? (rows.length === 0 ? 'Nothing to export' : `Export all ${rows.length}`)}
              </Text>
            </Pressable>
            <Pressable
              style={[s.button, s.buttonAlt, s.half, rows.length === 0 && s.buttonOff]}
              onPress={() => setPicked(new Set())}
              disabled={rows.length === 0}
            >
              <Text style={s.buttonText}>Select</Text>
            </Pressable>
          </View>
        )}
        {!sharingAvailable() && (
          <Text style={s.evidence}>Sharing is unavailable in this build.</Text>
        )}
        {err !== null && <Text style={s.bad}>{err}</Text>}
      </View>

      {rows.length === 0 && (
        <View style={s.card}>
          <Text style={s.bulletText}>No scans saved yet. Take one on the Scan tab.</Text>
        </View>
      )}

      {rows.map((r) => {
        const on = picked?.has(r.id) === true;
        return (
        <Pressable
          key={r.id}
          style={[s.card, on && s.cardPicked]}
          // Long press is how a list like this is expected to start selecting,
          // and it means the mode can be reached without aiming at a button.
          onLongPress={() => { if (!selecting) setPicked(new Set([r.id])); }}
          onPress={() => {
            if (selecting) { toggle(r.id); return; }
            void readScan(r.id).then((rec) => { if (rec !== null) setOpen(rec); });
          }}
        >
          <View style={s.tagHead}>
            {selecting && (
              <Text style={[s.tick, on && s.tickOn]}>{on ? '✓' : ''}</Text>
            )}
            <Text style={s.refName} numberOfLines={1}>{r.title}</Text>
            <Text style={[s.pill, outcomeStyle(r.worstOutcome)]}>
              {OUTCOME_LABEL[r.worstOutcome]}
            </Text>
          </View>
          <View style={s.scanRow}>
            {(() => {
              const uri = r.thumb === null ? null : photoUri(r.id, r.thumb);
              return uri === null
                ? <View style={[s.shotThumb, s.shotThumbEmpty]}><Text style={s.dim}>no photo</Text></View>
                : <Image source={{ uri }} style={s.shotThumb} resizeMode="cover" />;
            })()}
            <View style={{ flex: 1 }}>
              <Text style={s.cardNote}>{WHEN(r.capturedAt)}</Text>
              <Text style={s.bulletText}>
                {r.shots} photo{r.shots === 1 ? '' : 's'}  ·  {r.lines} lines  ·  {r.rows} rows
              </Text>
              <Text style={s.bulletText}>
                <Text style={r.verified > 0 ? s.ok : s.dim}>{r.verified} verified</Text>
                {r.mismatched > 0 && <Text style={s.bad}>  ·  {r.mismatched} disagree</Text>}
                {r.claims > 0 && <Text style={s.dim}>  ·  {r.claims} claims</Text>}
              </Text>
              {r.verdict !== null && (
                <Text style={s.evidence}>
                  {VERDICT[r.verdict].label}
                  {r.surface !== null ? `  ·  ${r.surface}` : ''}
                </Text>
              )}
            </View>
          </View>
          {r.note !== null && <Text style={s.evidence}>"{r.note}"</Text>}
        </Pressable>
        );
      })}
    </ScrollView>
  );
}

function ScanDetail(
  { rec, busy, onBack, onReplay, onExport, onDelete }:
  {
    rec: ScanRecord; busy: string | null; onBack: () => void;
    onReplay: () => void; onExport: () => void; onDelete: () => void;
  },
) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const verified = rec.checks.filter((c) => c.status === 'verified').length;
  const mismatched = rec.checks.filter((c) => c.status === 'mismatch').length;

  return (
    <ScrollView contentContainerStyle={s.scroll}>
      <Pressable onPress={onBack} style={s.card}>
        <Text style={s.link}>{'←'} All scans</Text>
        <Text style={s.cardTitle}>{rec.title}</Text>
        <Text style={s.cardNote}>{WHEN(rec.capturedAt)}  ·  format {rec.format}  ·  {rec.engine}</Text>
        {rec.surface !== null && <Text style={s.bulletText}>Surface: {rec.surface}</Text>}
        {rec.note !== null && <Text style={s.bulletText}>"{rec.note}"</Text>}
      </Pressable>

      <View style={s.card}>
        <Text style={s.cardTitle}>What was captured</Text>
        {rec.shots.map((sh) => {
          const uri = sh.photo === null ? null : photoUri(rec.id, sh.photo);
          return (
            <View key={sh.step} style={s.shotRow}>
              {uri !== null
                ? <Image source={{ uri }} style={s.shotThumb} resizeMode="cover" />
                : <View style={[s.shotThumb, s.shotThumbEmpty]}>
                    <Text style={s.dim}>no photo</Text>
                  </View>}
              <View style={{ flex: 1 }}>
                <Text style={s.refName}>{stepSpec(sh.step).title}</Text>
                <Text style={s.bulletText}>
                  {sh.page.lines.length} lines  ·  {sh.rows.length} rows read on its own
                </Text>
                <Text style={s.evidence}>
                  {sh.page.width} × {sh.page.height}
                  {sh.identity.productName !== null ? `  ·  "${sh.identity.productName}"` : ''}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      {rec.shots.some((sh) => sh.photo === null) && (
        <View style={s.card}>
          <Text style={s.evidence}>
            A photograph could not be copied into this scan's folder, so there is no
            image to show. The reading itself is unaffected — the recognised text,
            with every word's position, is stored and can still be replayed.
          </Text>
        </View>
      )}

      {rec.pack !== null && <PackSummary pack={rec.pack} rowCount={rec.mergedRows.length} />}

      {rec.merge !== null && rec.shots.length > 1 && (
        <MergeView report={rec.merge} />
      )}

      <View style={s.card}>
        <Text style={s.cardTitle}>Result</Text>
        <Stat label="Ingredient rows" value={String(rec.mergedRows.length)} />
        <Stat label="Arithmetic verified" value={`${verified} of ${rec.mergedRows.length}`} />
        <Stat label="Disagreements" value={String(mismatched)} />
        <Stat label="Answered by" value={rec.answeredBy ?? 'nothing'} />
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Every rung, as it ran</Text>
        {rec.stages.map((st, i) => (
          <View key={st.id} style={s.classRow}>
            <View style={s.tagHead}>
              <Text style={s.famLine}>{i + 1}. {st.title}</Text>
              <Text style={[s.pill, outcomeStyle(st.outcome)]}>{OUTCOME_LABEL[st.outcome]}</Text>
            </View>
            <Text style={s.evidence}>{st.detail}</Text>
          </View>
        ))}
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Do something with it</Text>
        <Text style={s.cardNote}>
          Replaying runs the stored reading back through the whole pipeline without
          the bottle or the camera. If the result changes after a fix, the fix worked.
        </Text>
        <Pressable style={[s.button, busy !== null && s.buttonOff]}
                   onPress={onReplay} disabled={busy !== null}>
          <Text style={s.buttonText}>{busy ?? 'Replay this reading'}</Text>
        </Pressable>
        <View style={{ height: 8 }} />
        <Pressable style={[s.button, s.buttonAlt, busy !== null && s.buttonOff]}
                   onPress={onExport} disabled={busy !== null}>
          <Text style={s.buttonText}>Send this scan off the phone</Text>
        </Pressable>
        <View style={{ height: 8 }} />
        <Pressable
          style={[s.button, s.buttonDanger]}
          onPress={() => { if (confirmDelete) onDelete(); else setConfirmDelete(true); }}
        >
          <Text style={s.buttonText}>
            {confirmDelete ? 'Tap again to delete for good' : 'Delete this scan'}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function MergeView({ report }: { report: MergeReport }) {
  const conflicts = report.rows.filter((d) => d.rejected.length > 0);
  const fieldConflicts = report.fields.filter((f) => f.rejected.length > 0);

  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>How the photographs were combined</Text>
      <Text style={s.cardNote}>
        Where two photographs disagreed about a row, the one whose amount and
        percentage agree arithmetically wins — that is two independently printed
        numbers checking each other, not a guess about which picture looked better.
      </Text>
      {report.shots.map((sh) => (
        <Stat key={sh.step} label={stepSpec(sh.step).title}
              value={`${sh.rows} rows, ${sh.verified} verified`} />
      ))}
      <Stat label="Rows replaced by a better reading" value={String(report.replaced)} />
      <Stat label="Fragments discarded" value={String(report.discarded.length)} />

      {conflicts.length > 0 && (
        <View style={s.famBlock}>
          <Text style={s.refName}>Rows the photographs disagreed on</Text>
          {conflicts.slice(0, 12).map((d, i) => (
            <View key={i} style={s.classRow}>
              <Text style={s.famLine} numberOfLines={1}>{d.row.name}</Text>
              <Text style={s.okText2}>kept from {stepSpec(d.from).title}: {d.quality.why}</Text>
              {d.rejected.map((rj, j) => (
                <Text key={j} style={s.evidence}>
                  dropped from {stepSpec(rj.from).title}: {rj.quality.why}
                </Text>
              ))}
            </View>
          ))}
        </View>
      )}

      {fieldConflicts.length > 0 && (
        <View style={s.famBlock}>
          <Text style={s.refName}>Other fields that disagreed</Text>
          {fieldConflicts.map((f) => (
            <View key={f.field} style={s.classRow}>
              <Text style={s.famLine}>{f.field}</Text>
              <Text style={s.okText2} numberOfLines={2}>{f.value}</Text>
              <Text style={s.evidence}>{f.why}</Text>
            </View>
          ))}
        </View>
      )}

      {report.discarded.length > 0 && (
        <View style={s.famBlock}>
          <Text style={s.refName}>Discarded fragments</Text>
          <Text style={s.cardNote}>
            Text another photograph offered that is not an ingredient — usually half
            a row whose name the recogniser lost. Shown rather than silently dropped.
          </Text>
          {report.discarded.slice(0, 8).map((d, i) => (
            <Text key={i} style={s.evidence}>
              {stepSpec(d.from).title}: "{d.raw}" — {d.why}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

/* --------------------------------------------------------------- style */

const INK = '#111111';
const s = StyleSheet.create({
  tabStrip: { flexGrow: 0, flexShrink: 0 },
  packName: { color: '#FFFFFF', fontSize: 20, fontWeight: '600', marginBottom: 6 },
  claimRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2A2F38',
    paddingTop: 9, marginTop: 9 },
  claimText: { color: '#E6EBF1', fontSize: 14, lineHeight: 20 },
  disclaimerOk: { marginTop: 12, padding: 10, borderRadius: 8, backgroundColor: '#132620' },
  disclaimerBad: { marginTop: 12, padding: 10, borderRadius: 8, backgroundColor: '#2A1717' },
  surfaceRow: { flexDirection: 'row', gap: 6 },
  surfaceChip: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center',
    backgroundColor: '#1D2027', borderWidth: 1, borderColor: 'transparent' },
  surfaceChipOn: { borderColor: '#1D9E75', backgroundColor: '#15241F' },
  surfaceChipText: { color: '#9AA0AA', fontSize: 12, fontWeight: '600' },
  surfaceChipTextOn: { color: '#FFFFFF' },
  probeChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  probeChip: { backgroundColor: '#0F1115', borderRadius: 999, paddingHorizontal: 10,
    paddingVertical: 5, borderWidth: StyleSheet.hairlineWidth, borderColor: '#2A2F38',
    maxWidth: '100%' },
  probeChipText: { color: '#9AA5B1', fontSize: 11 },
  probeResult: { borderTopWidth: 1, borderTopColor: '#23282F', paddingTop: 10, gap: 4 },
  ruleMetaRowFlush: { flexDirection: 'row', alignItems: 'center', gap: 8,
    flexWrap: 'wrap', marginBottom: 4 },
  probeRule: { color: '#E6EBF1', fontSize: 13, fontWeight: '600' },
  ruleWhyFlush: { color: '#9AA5B1', fontSize: 12, lineHeight: 17, marginTop: 4 },
  flash: { position: 'absolute', left: 16, right: 16, top: '8%', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10,
    backgroundColor: 'rgba(29,158,117,0.92)' },
  flashText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  cameraBarInner: { padding: 16, gap: 10 },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeChip: { flex: 1, paddingVertical: 8, borderRadius: 999, alignItems: 'center',
    backgroundColor: '#1D2027' },
  modeChipOn: { backgroundColor: '#2A2F38', borderWidth: 1, borderColor: '#1D9E75' },
  modeChipText: { color: '#8A919C', fontSize: 12, fontWeight: '600' },
  modeChipTextOn: { color: '#FFFFFF' },
  stepStrip: { flexDirection: 'row', gap: 6 },
  stepChip: { flex: 1, paddingVertical: 7, paddingHorizontal: 8, borderRadius: 8,
    backgroundColor: '#1D2027', borderWidth: 1, borderColor: 'transparent' },
  stepChipOn: { borderColor: '#1D9E75' },
  stepChipDone: { backgroundColor: '#15241F' },
  stepChipText: { color: '#9AA0AA', fontSize: 11, fontWeight: '700' },
  stepChipTextOn: { color: '#FFFFFF' },
  stepChipSub: { color: '#6F7680', fontSize: 10, marginTop: 1 },
  noteInput: { backgroundColor: '#0F1115', color: '#FFFFFF', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 13,
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#2A2F38' },
  buttonOff: { opacity: 0.45 },
  buttonDanger: { backgroundColor: '#5A2222' },
  shotRow: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2A2F38' },
  shotThumb: { width: 54, height: 72, borderRadius: 6, backgroundColor: '#000000' },
  shotThumbEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#1D2027' },
  scanRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 4 },
  basisPill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1,
    borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  basisPillText: { fontSize: 10, fontWeight: '600', letterSpacing: 0.2 },
  basisRow: { marginTop: 12 },
  basisHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 5 },
  basisName: { flex: 1, color: '#C9D1DB', fontSize: 12, fontWeight: '600' },
  ruleRow: { borderTopWidth: 1, borderTopColor: '#23282F', paddingVertical: 9 },
  ruleRowFired: { backgroundColor: '#161C22' },
  ruleHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ruleIndex: { color: '#5C6673', fontSize: 11, width: 16, fontVariant: ['tabular-nums'] },
  ruleName: { flex: 1, color: '#E6EBF1', fontSize: 13, fontWeight: '600' },
  ruleMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5,
    flexWrap: 'wrap', paddingLeft: 24 },
  ruleWhy: { color: '#9AA5B1', fontSize: 12, lineHeight: 17, marginTop: 8, paddingLeft: 24 },
  classRow: { borderTopWidth: 1, borderTopColor: '#23282F', paddingVertical: 9 },
  app: { flex: 1, backgroundColor: '#0F1115' },
  header: { paddingTop: 62, paddingHorizontal: 18, paddingBottom: 8 },
  appTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '600' },
  appSub: { color: '#9FE1CB', fontSize: 12, marginTop: 3 },
  tabs: { flexDirection: 'row', paddingHorizontal: 14, gap: 6, paddingBottom: 10 },
  tab: { paddingVertical: 7, paddingHorizontal: 14, borderRadius: 999, backgroundColor: '#1D2027' },
  tabOn: { backgroundColor: '#1D9E75' },
  tabText: { color: '#9AA0AA', fontSize: 13, fontWeight: '500' },
  tabTextOn: { color: '#FFFFFF' },
  scroll: { padding: 14, paddingBottom: 60, gap: 12 },

  panel: { backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: INK, padding: 12 },
  panelTitle: { color: INK, fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  panelMeta: { color: INK, fontSize: 13 },
  ruleHeavy: { height: 9, backgroundColor: INK, marginVertical: 5 },
  ruleThick: { height: 4, backgroundColor: INK, marginVertical: 5 },
  ruleThin: { height: StyleSheet.hairlineWidth, backgroundColor: '#9A9A9A' },
  headRow: { flexDirection: 'row', alignItems: 'center' },
  headText: { fontWeight: '800' },
  sectionLabel: { color: '#555', fontSize: 10, fontWeight: '800', letterSpacing: 1, marginTop: 10, marginBottom: 2 },
  pRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 6 },
  pName: { color: INK, fontSize: 14, flex: 1 },
  // Tabular figures so decimal points and digit counts line up down the
  // column; right-aligned for the same reason.
  pAmountCol: {
    color: INK, fontSize: 14, fontWeight: '700', minWidth: 78,
    textAlign: 'right', paddingLeft: 8,
    fontVariant: ['tabular-nums'],
  },
  pIndent: { color: '#444' },
  pAmount: { fontWeight: '700' },
  pDv: {
    color: INK, fontSize: 14, fontWeight: '700', minWidth: 52,
    textAlign: 'right', fontVariant: ['tabular-nums'],
  },
  pBadge: { width: 22, textAlign: 'right', fontSize: 14, fontWeight: '800', color: 'transparent' },
  okText: { color: '#0F6E56' },
  badText: { color: '#A32D2D' },
  pMismatch: { color: '#A32D2D', fontSize: 11, paddingBottom: 5 },
  panelFoot: { color: '#555', fontSize: 11, marginTop: 8 },
  panelOtherTitle: { color: INK, fontSize: 13, fontWeight: '800' },
  panelOther: { color: '#333', fontSize: 12, lineHeight: 17, marginTop: 2 },

  checkLine: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  ok: { color: '#5DCAA5' }, bad: { color: '#F09595' },
  dim: { color: '#6F7680', fontWeight: '400', fontSize: 12 },

  card: { backgroundColor: '#171A20', borderRadius: 12, padding: 14 },
  cardBad: { borderWidth: StyleSheet.hairlineWidth, borderColor: '#A32D2D' },
  cardTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '600', marginBottom: 6 },
  cardNote: { color: '#8A919C', fontSize: 12, lineHeight: 17, marginBottom: 8 },
  bulletRow: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  bulletDot: { color: '#5DCAA5', fontSize: 14, lineHeight: 19 },
  bulletText: { color: '#D7DBE0', fontSize: 13, lineHeight: 19, flex: 1 },

  refRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2A2F38', paddingTop: 10, marginTop: 10 },
  refName: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  refRole: { color: '#B9BFC7', fontSize: 13, marginTop: 3, lineHeight: 18 },
  link: { color: '#85B7EB', fontSize: 12, marginTop: 5 },

  lineRow: { flexDirection: 'row', gap: 10, paddingVertical: 6, alignItems: 'flex-start' },
  pill: {
    color: '#0F1115', backgroundColor: '#9FE1CB', fontSize: 10, fontWeight: '600',
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4, overflow: 'hidden',
    minWidth: 92, textAlign: 'center',
  },
  pillMuted: { backgroundColor: '#2A2F38', color: '#8A919C' },
  pillOk: { backgroundColor: '#9FE1CB', color: '#04342C' },
  pillWarn: { backgroundColor: '#FAC775', color: '#412402' },
  pillBad: { backgroundColor: '#F7C1C1', color: '#501313' },
  cardAnswered: { borderWidth: 1, borderColor: '#1D9E75' },
  lineText: { color: '#D7DBE0', fontSize: 13, flex: 1 },

  input: {
    backgroundColor: '#0F1115', color: '#FFFFFF', borderRadius: 8, padding: 12,
    fontSize: 15, marginBottom: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: '#2A2F38',
  },
  button: { backgroundColor: '#1D9E75', paddingVertical: 13, borderRadius: 10, alignItems: 'center' },
  buttonAlt: { backgroundColor: '#2A2F38' },
  half: { flex: 1 },
  buttonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },

  cardPicked: { borderWidth: 1, borderColor: '#1D9E75', backgroundColor: '#15241F' },
  tick: {
    width: 22, height: 22, borderRadius: 11, marginRight: 8,
    borderWidth: 1.5, borderColor: '#4A515B', color: '#0F1115',
    textAlign: 'center', lineHeight: 20, fontSize: 13, fontWeight: '900',
    overflow: 'hidden',
  },
  tickOn: { backgroundColor: '#1D9E75', borderColor: '#1D9E75', color: '#FFFFFF' },

  cameraWrap: { flex: 1 },
  camera: { flex: 1, backgroundColor: '#000000' },
  // The guide rails. Drawn under the control bar, which paints over them
  // because it is rendered after this and has a solid background.
  railWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  rail: { position: 'absolute', top: 0, bottom: 0, width: 2,
    backgroundColor: 'rgba(93,202,165,0.95)' },
  railAxis: { position: 'absolute', top: 0, bottom: 0, width: 1,
    backgroundColor: 'rgba(93,202,165,0.35)' },
  // The band that is square enough to the camera to be worth reading.
  railArc: { position: 'absolute', top: 0, bottom: 0,
    backgroundColor: 'rgba(93,202,165,0.07)' },
  sweepBox: { backgroundColor: '#15181D', borderRadius: 10, padding: 12, gap: 6 },
  frameRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2A2F38',
    paddingTop: 6, gap: 2 },
  cameraBar: { flexGrow: 0, flexShrink: 0, maxHeight: '52%', backgroundColor: '#0F1115' },
  cameraRow: { flexDirection: 'row', gap: 10 },
  cameraNote: { color: '#8A919C', fontSize: 12, textAlign: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  cardDim: { opacity: 0.72 },
  tagHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  overlay: {
    position: 'absolute', left: 0, right: 0, top: '42%', alignItems: 'center',
    gap: 12, paddingVertical: 20, backgroundColor: 'rgba(15,17,21,0.82)',
  },
  overlayText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  subRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2A2F38' },
  statLabel: { color: '#A6ADB6', fontSize: 13, flex: 1 },
  statValue: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  barTrack: { height: 8, borderRadius: 999, backgroundColor: '#2A2F38', overflow: 'hidden', marginBottom: 10 },
  barFill: { height: 8, backgroundColor: '#1D9E75' },
  countChip: { color: '#0F1115', backgroundColor: '#9FE1CB', fontSize: 11, fontWeight: '700',
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: 'hidden' },
  famBlock: { marginTop: 10, gap: 3 },
  famLine: { color: '#C6CBD2', fontSize: 12, lineHeight: 17 },
  dvCell: { minWidth: 56, alignItems: 'flex-end' },
  dvTrack: { width: 48, height: 4, borderRadius: 999, backgroundColor: '#DDDDDD', marginTop: 3, overflow: 'hidden' },
  dvFill: { height: 4, backgroundColor: '#1D9E75' },
  dvFillOver: { backgroundColor: '#BA7517' },
  paperTitle: { color: '#D7DBE0', fontSize: 13, lineHeight: 18, marginTop: 8 },
  paperMeta: { color: '#85B7EB', fontSize: 11, marginTop: 2 },
  map: { width: '100%', aspectRatio: 1, backgroundColor: '#0F1115', borderRadius: 8,
    position: 'relative', overflow: 'hidden', marginBottom: 10 },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 9, height: 9, borderRadius: 2 },
  okText2: { color: '#5DCAA5', fontSize: 13, fontWeight: '600' },
  evidence: { color: '#8A919C', fontSize: 11, fontStyle: 'italic', marginTop: 2 },
  resetChip: {
    color: '#9FE1CB', fontSize: 11, fontWeight: '600', backgroundColor: '#1D2027',
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, overflow: 'hidden',
  },
});
