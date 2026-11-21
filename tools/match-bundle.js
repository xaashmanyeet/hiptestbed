(() => {
  // ../../../../../../../private/var/folders/4z/16lnjj9d3s373_x7_t_2w8qc0000gn/T/tmp.d8LeOL3d1X/src/labelTextNormalize.ts
  function normaliseIngredient(name) {
    return name.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  }

  // ../../../../../../../private/var/folders/4z/16lnjj9d3s373_x7_t_2w8qc0000gn/T/tmp.d8LeOL3d1X/src/compositionMatch.ts
  function scoreByComposition(ours, hits) {
    const mine = new Set(ours.map(normaliseIngredient).filter((s) => s.length > 2));
    if (mine.size === 0) return [];
    return hits.map((hit) => {
      const theirs = new Set(
        hit.ingredients.map((i) => normaliseIngredient(i.name)).filter((s) => s.length > 2)
      );
      if (theirs.size === 0) return { hit, score: 0, shared: 0 };
      let shared = 0;
      for (const n of mine) if (theirs.has(n)) shared++;
      const union = mine.size + theirs.size - shared;
      return { hit, score: union === 0 ? 0 : shared / union, shared };
    }).sort((a, b) => b.score - a.score);
  }
  var ACCEPT_SCORE = 0.5;
  var ACCEPT_MARGIN = 0.12;
  function decide(scores) {
    const top = scores[0];
    if (top === void 0 || top.score < ACCEPT_SCORE) return null;
    const second = scores[1];
    if (second !== void 0 && top.score - second.score < ACCEPT_MARGIN) return null;
    return top;
  }
  function decisionReason(scores) {
    const top = scores[0];
    if (top === void 0) return "no candidates to compare against";
    if (top.score < ACCEPT_SCORE) {
      return `best overlap was ${(top.score * 100).toFixed(0)}%, below the ${ACCEPT_SCORE * 100}% a match needs`;
    }
    const second = scores[1];
    if (second !== void 0 && top.score - second.score < ACCEPT_MARGIN) {
      return `top two are ${(top.score * 100).toFixed(0)}% and ${(second.score * 100).toFixed(0)}% \u2014 too close to choose between`;
    }
    return `${top.shared} ingredients shared, ${(top.score * 100).toFixed(0)}% overlap`;
  }

  // ../../../../../../../private/var/folders/4z/16lnjj9d3s373_x7_t_2w8qc0000gn/T/tmp.d8LeOL3d1X/src/labelLineClassification.ts
  var EXCIPIENTS = new RegExp(
    "\\b(MICROCRYSTALLINE CELLULOSE|CELLULOSE GEL|HYPROMELLOSE|METHYLCELLULOSE|CROSCARMELLOSE|MAGNESIUM STEARATE|STEARIC ACID|SILICON DIOXIDE|SILICA|TITANIUM DIOXIDE|POLYETHYLENE GLYCOL|POLYSORBATE|MALTODEXTRIN|MODIFIED FOOD STARCH|DICALCIUM PHOSPHATE|CALCIUM SILICATE|VEGETABLE (STEARATE|MAGNESIUM STEARATE|GLYCERIN)|GLYCERIN|SORBITOL|CARNAUBA WAX|SHELLAC|GELATIN|SOY LECITHIN|LECITHIN|XANTHAN GUM|CITRIC ACID|MALIC ACID|SUCRALOSE|STEVIA|NATURAL FLAVOR|ARTIFICIAL FLAVOR|FD&C|ANNATTO|CARMINE|BEET (JUICE|POWDER)|RICE FLOUR|CELLULOSE)\\b"
  );

  // ../../../../../../../private/var/folders/4z/16lnjj9d3s373_x7_t_2w8qc0000gn/T/tmp.d8LeOL3d1X/src/dailyValues.ts
  var DAILY_VALUES = {
    "vitamin a": { amount: 900, unit: "mcg", kind: "vitamin", ul: 3e3, nih: "VitaminA", role: "Vision, immune function and cell growth." },
    "vitamin c": { amount: 90, unit: "mg", kind: "vitamin", ul: 2e3, nih: "VitaminC", role: "Collagen formation and iron absorption." },
    "vitamin d": { amount: 20, unit: "mcg", kind: "vitamin", ul: 100, nih: "VitaminD", role: "Helps the body absorb calcium; bone health." },
    "vitamin e": { amount: 15, unit: "mg", kind: "vitamin", ul: 1e3, nih: "VitaminE", role: "Antioxidant; protects cells from damage." },
    "vitamin k": { amount: 120, unit: "mcg", kind: "vitamin", ul: null, nih: "VitaminK", role: "Blood clotting and bone metabolism." },
    thiamin: { amount: 1.2, unit: "mg", kind: "vitamin", ul: null, nih: "Thiamin", role: "Converts food into energy." },
    riboflavin: { amount: 1.3, unit: "mg", kind: "vitamin", ul: null, nih: "Riboflavin", role: "Energy production and cell function." },
    niacin: { amount: 16, unit: "mg", kind: "vitamin", ul: 35, nih: "Niacin", role: "Energy metabolism; skin and nerve function." },
    "vitamin b6": { amount: 1.7, unit: "mg", kind: "vitamin", ul: 100, nih: "VitaminB6", role: "Protein metabolism and brain development." },
    folate: { amount: 400, unit: "mcg", kind: "vitamin", ul: 1e3, nih: "Folate", role: "Cell division and DNA formation." },
    "vitamin b12": { amount: 2.4, unit: "mcg", kind: "vitamin", ul: null, nih: "VitaminB12", role: "Red blood cell formation and nerve function." },
    biotin: { amount: 30, unit: "mcg", kind: "vitamin", ul: null, nih: "Biotin", role: "Metabolism of fats, carbohydrates and protein." },
    "pantothenic acid": { amount: 5, unit: "mg", kind: "vitamin", ul: null, nih: "PantothenicAcid", role: "Converts food into energy." },
    choline: { amount: 550, unit: "mg", kind: "vitamin", ul: 3500, nih: "Choline", role: "Cell structure and nerve signalling." },
    calcium: { amount: 1300, unit: "mg", kind: "mineral", ul: 2500, nih: "Calcium", role: "Bone and tooth structure; muscle and nerve function." },
    iron: { amount: 18, unit: "mg", kind: "mineral", ul: 45, nih: "Iron", role: "Carries oxygen in the blood." },
    phosphorus: { amount: 1250, unit: "mg", kind: "mineral", ul: 4e3, nih: "Phosphorus", role: "Bone structure and energy storage." },
    iodine: { amount: 150, unit: "mcg", kind: "mineral", ul: 1100, nih: "Iodine", role: "Thyroid hormone production." },
    magnesium: { amount: 420, unit: "mg", kind: "mineral", ul: 350, nih: "Magnesium", role: "Muscle and nerve function; energy production." },
    zinc: { amount: 11, unit: "mg", kind: "mineral", ul: 40, nih: "Zinc", role: "Immune function and wound healing." },
    selenium: { amount: 55, unit: "mcg", kind: "mineral", ul: 400, nih: "Selenium", role: "Antioxidant; thyroid function." },
    copper: { amount: 0.9, unit: "mg", kind: "mineral", ul: 10, nih: "Copper", role: "Energy production and iron metabolism." },
    manganese: { amount: 2.3, unit: "mg", kind: "mineral", ul: 11, nih: "Manganese", role: "Bone formation and metabolism." },
    chromium: { amount: 35, unit: "mcg", kind: "mineral", ul: null, nih: "Chromium", role: "Helps insulin work in the body." },
    molybdenum: { amount: 45, unit: "mcg", kind: "mineral", ul: 2e3, nih: "Molybdenum", role: "Enzyme function for processing certain compounds." },
    chloride: { amount: 2300, unit: "mg", kind: "mineral", ul: 3600, nih: "Chloride", role: "Fluid balance and digestion." },
    potassium: { amount: 4700, unit: "mg", kind: "mineral", ul: null, nih: "Potassium", role: "Fluid balance, nerve signals, muscle contraction." },
    sodium: { amount: 2300, unit: "mg", kind: "mineral", ul: null, nih: "Sodium", role: "Fluid balance and nerve function." }
  };

  // ../../../../../../../private/var/folders/4z/16lnjj9d3s373_x7_t_2w8qc0000gn/T/tmp.d8LeOL3d1X/src/labelTextRepair.ts
  var FORMS = [
    "ascorbic",
    "acid",
    "cholecalciferol",
    "ergocalciferol",
    "tocopheryl",
    "tocopherol",
    "acetate",
    "retinyl",
    "palmitate",
    "beta",
    "carotene",
    "phytonadione",
    "thiamine",
    "mononitrate",
    "hydrochloride",
    "riboflavin",
    "niacinamide",
    "pyridoxine",
    "cyanocobalamin",
    "methylcobalamin",
    "folic",
    "biotin",
    "pantothenate",
    "carbonate",
    "citrate",
    "oxide",
    "gluconate",
    "sulfate",
    "sulphate",
    "fumarate",
    "ferrous",
    "cupric",
    "potassium",
    "iodide",
    "selenate",
    "selenite",
    "molybdate",
    "chloride",
    "picolinate",
    "bisglycinate",
    "chelate",
    "phosphate",
    "lactate",
    "chondroitin",
    "glucosamine",
    "lycopene",
    "lutein",
    "zeaxanthin",
    "magnesium",
    "manganese",
    "molybdenum",
    "chromium",
    "selenium",
    "calcium",
    "sodium",
    "copper",
    "zinc",
    "iron",
    "iodine",
    "choline",
    "vitamin",
    "folate",
    "thiamin",
    "niacin",
    "serving",
    "size",
    "amount",
    "daily",
    "value",
    "per",
    "container",
    "supplement",
    "facts",
    "other",
    "ingredients",
    "tablet",
    "tablets",
    "capsule",
    "capsules",
    "softgel"
  ];
  var VOCAB = /* @__PURE__ */ new Set([
    ...FORMS,
    ...Object.keys(DAILY_VALUES).flatMap((k) => k.split(" "))
  ]);
  var HOMOGLYPHS = {
    "\u0410": "A",
    "\u0412": "B",
    "\u0415": "E",
    "\u041A": "K",
    "\u041C": "M",
    "\u041D": "H",
    "\u041E": "O",
    "\u0420": "P",
    "\u0421": "C",
    "\u0422": "T",
    "\u0423": "Y",
    "\u0425": "X",
    "\u0430": "a",
    "\u0432": "b",
    "\u0435": "e",
    "\u043A": "k",
    "\u043C": "m",
    "\u043D": "h",
    "\u043E": "o",
    "\u0440": "p",
    "\u0441": "c",
    "\u0442": "t",
    "\u0443": "y",
    "\u0445": "x",
    "\u0391": "A",
    "\u0392": "B",
    "\u0395": "E",
    "\u039F": "O",
    "\u03A1": "P",
    "\u03A4": "T",
    "\u03A7": "X"
  };
  var HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join("")}]`, "g");

  // ../../../../../../../private/var/folders/4z/16lnjj9d3s373_x7_t_2w8qc0000gn/T/tmp.d8LeOL3d1X/src/dsld.ts
  function text(v) {
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    return "";
  }
  function netContents(v) {
    if (Array.isArray(v) && v.length > 0) {
      const first = v[0];
      if (first !== void 0) {
        const q = text(first.quantity ?? first.number);
        const u = text(first.unit ?? first.display);
        const joined = `${q} ${u}`.trim();
        return joined.length > 0 ? joined : null;
      }
    }
    const s = text(v);
    return s.length > 0 ? s : null;
  }
  function parseSearchHits(body) {
    const b = body ?? {};
    const hits = Array.isArray(b.hits) ? b.hits : [];
    return hits.map((raw) => {
      const h = raw;
      const src = h._source ?? {};
      const ing = Array.isArray(src.allIngredients) ? src.allIngredients : [];
      return {
        id: text(h._id),
        fullName: text(src.fullName) || "(no product name)",
        brandName: text(src.brandName),
        netContents: netContents(src.netContents),
        offMarket: src.offMarket === true || src.offMarket === 1,
        ingredients: ing.map((i) => {
          const o = i;
          return {
            name: text(o.name),
            category: text(o.category),
            group: text(o.ingredientGroup),
            notes: text(o.notes)
          };
        })
      };
    });
  }

  // ../../../../../../../private/var/folders/4z/16lnjj9d3s373_x7_t_2w8qc0000gn/T/tmp.d8LeOL3d1X/tools/match-entry.ts
  var g = globalThis;
  g.hipScoreByComposition = scoreByComposition;
  g.hipDecide = decide;
  g.hipDecisionReason = decisionReason;
  g.hipParseSearchHits = parseSearchHits;
})();
