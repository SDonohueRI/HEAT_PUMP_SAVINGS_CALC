/* ===================================================================
   Heat Pump Energy Savings — Bin-Hour Calculation Engine
   -------------------------------------------------------------------
   Pure functions, no DOM. Identical logic is embedded in index.html
   and mirrored in the Excel export so all three agree.
   =================================================================== */

/* Physical constants */
const BTU_PER_KWH      = 3412;      // BTU per kWh
const BTU_PER_THERM    = 100000;    // BTU per therm (gas)
const BTU_PER_GAL_OIL  = 138500;    // BTU per gallon (heating oil)
const KWH_PER_THERM    = 29.3;      // kWh-equivalent of one therm (site energy)
const CO2_LB_PER_THERM = 11.7;      // lb CO2 per therm of natural gas
const CO2_LB_PER_GAL   = 22.4;      // lb CO2 per gallon of heating oil

/* ---------- Representative TMY3 bin tables (hours/yr, sum = 8760) ----------
   Keyed by station id. Midpoints in 5F bins. Sample ships with Sea-Tac
   (PSE territory). Additional stations slot in here later. */
const BIN_TABLES = {
  KSEA: { // Seattle-Tacoma Intl — marine 4C
    label: "Sea-Tac (KSEA)",
    bins: [
      { t: 12, h: 5 },   { t: 17, h: 15 },  { t: 22, h: 40 },
      { t: 27, h: 110 }, { t: 32, h: 280 }, { t: 37, h: 620 },
      { t: 42, h: 1150 },{ t: 47, h: 1580 },{ t: 52, h: 1560 },
      { t: 57, h: 1280 },{ t: 62, h: 950 }, { t: 67, h: 560 },
      { t: 72, h: 320 }, { t: 77, h: 175 }, { t: 82, h: 85 },
      { t: 87, h: 25 },  { t: 92, h: 5 }
    ]
  }
};

/* ---------- COP curve helpers ---------- */

/* Build a 3-point COP curve from HSPF2 when manufacturer data is absent.
   HSPF2 (BTU/Wh) / 3.412 = seasonal COP. The 47F rated point sits above
   the seasonal average; 17F and 5F fall off. Parametric, documented. */
function modeledCopCurve(hspf2) {
  const seasonalCop = hspf2 / 3.412;
  const cop47 = seasonalCop * 1.25;
  return {
    cop47: round2(cop47),
    cop17: round2(cop47 * 0.62),
    cop5:  round2(cop47 * 0.45),
    modeled: true
  };
}

/* Interpolate/extrapolate COP at an arbitrary outdoor temperature from the
   three anchor points (5, 17, 47 F). Floored at 1.0 (never worse than
   resistance). Above 47F, extend gently using the 17->47 slope. */
function copAt(tempF, curve) {
  const { cop5, cop17, cop47 } = curve;
  let cop;
  if (tempF <= 5) {
    cop = cop5;
  } else if (tempF < 17) {
    cop = cop5 + (cop17 - cop5) * (tempF - 5) / (17 - 5);
  } else if (tempF < 47) {
    cop = cop17 + (cop47 - cop17) * (tempF - 17) / (47 - 17);
  } else {
    const slope = (cop47 - cop17) / (47 - 17);
    cop = cop47 + slope * (tempF - 47);
    cop = Math.min(cop, cop47 * 1.3); // cap mild high-temp extrapolation
  }
  return Math.max(cop, 1.0);
}

/* ---------- Load model ----------
   Linear bin load ratio between balance point (zero load) and design temp
   (full design load). Standard ACCA-style bin approach. */
function heatLoadRatio(tempF, balPointF, designHeatF) {
  if (tempF >= balPointF) return 0;
  const denom = balPointF - designHeatF;
  if (denom <= 0) return 0;
  return Math.max(0, (balPointF - tempF) / denom);
}
function coolLoadRatio(tempF, balCoolF, designCoolF) {
  if (tempF <= balCoolF) return 0;
  const denom = designCoolF - balCoolF;
  if (denom <= 0) return 0;
  return Math.max(0, (tempF - balCoolF) / denom);
}

/* ---------- Main calculation ---------- */
function calculate(input) {
  const {
    stationId = "KSEA",
    designHeatTempF = 14,
    designCoolTempF = 89,
    balPointHeatF = 65,
    balPointCoolF = 70,

    elecRateCents = 11.2,    // cents/kWh
    gasRateDollars = 1.28,   // $/therm
    oilRateDollars = 4.50,   // $/gal
    rateEscalationPct = 2.5,
    discountRatePct = 3.0,

    existingFuel = "gas",    // gas | electric | oil | heatpump
    afurePct = 80,           // furnace AFUE %
    existingHspf = 8.0,      // for existing-heat-pump baseline
    existingSeer = 13,       // existing AC SEER (0/blank = no cooling)
    systemAgeYrs = 12,

    designHeatLoadMBH = 42.5,// Manual J heating design load (MBH = kBTU/hr)
    designCoolLoadTons = 2.5,// Manual J cooling design load (tons)
    hasManualJ = true,

    ductSystem = "ducted_unknown", // ducted_unknown | ducted_tested | ductless | partial
    ductLeakagePct = null,         // used when ducted_tested

    hpHspf2 = 9.5,
    hpSeer2 = 17.5,
    hpMinTempF = -13,
    cop47 = null, cop17 = null, cop5 = null, // blank => modeled
    backupType = "electric",  // electric | dualfuel_gas | none

    installedCost = 14500,
    equipmentLifeYrs = 18,

    gridEmissionsLbPerKwh = 0.287
  } = input;

  const station = BIN_TABLES[stationId] || BIN_TABLES.KSEA;
  const elecRate = elecRateCents / 100;     // $/kWh
  const afue = afurePct / 100;

  /* Design loads to BTU/hr */
  const designHeatBTU = designHeatLoadMBH * 1000;      // MBH -> BTU/hr
  const designCoolBTU = designCoolLoadTons * 12000;    // tons -> BTU/hr

  /* Effective duct loss multiplier applied to delivered load (ducted only) */
  let ductFactor = 1.0;
  let ductLeakUsed = 0;
  if (ductSystem === "ducted_unknown") { ductLeakUsed = 12; ductFactor = 1.12; }
  else if (ductSystem === "ducted_tested") { ductLeakUsed = ductLeakagePct ?? 8; ductFactor = 1 + ductLeakUsed / 100; }
  else if (ductSystem === "partial") { ductLeakUsed = 6; ductFactor = 1.06; }
  else { ductLeakUsed = 0; ductFactor = 1.0; } // ductless

  /* Age penalty: older equipment underperforms its rating */
  const agePenalty = Math.min(0.10, Math.max(0, (systemAgeYrs - 8) * 0.01)); // up to -10%
  const effAfue = afue * (1 - agePenalty);
  const effExistingHspf = existingHspf * (1 - agePenalty);
  const effSeer = existingSeer * (1 - agePenalty * 0.5);

  /* COP curve for the proposed heat pump */
  let curve;
  if (cop47 && cop17 && cop5) {
    curve = { cop47, cop17, cop5, modeled: false };
  } else {
    curve = modeledCopCurve(hpHspf2);
  }

  /* Accumulators */
  let baseHeatTherms = 0, baseHeatGal = 0, baseHeatKwh = 0, baseCoolKwh = 0;
  let hpHeatKwh = 0, hpBackupKwh = 0, hpBackupTherms = 0, hpCoolKwh = 0;
  const binRows = [];

  for (const { t, h } of station.bins) {
    const hRatio = heatLoadRatio(t, balPointHeatF, designHeatF(designHeatTempF));
    const cRatio = coolLoadRatio(t, balPointCoolF, designCoolTempF);

    const heatLoadBTU = designHeatBTU * hRatio * ductFactor; // BTU/hr delivered
    const coolLoadBTU = designCoolBTU * cRatio * ductFactor;

    const heatBTU = heatLoadBTU * h; // BTU over the bin's hours
    const coolBTU = coolLoadBTU * h;

    /* ----- Baseline heating energy ----- */
    let bTherms = 0, bGal = 0, bKwh = 0;
    if (heatBTU > 0) {
      if (existingFuel === "gas") {
        bTherms = heatBTU / (effAfue * BTU_PER_THERM);
        baseHeatTherms += bTherms;
      } else if (existingFuel === "oil") {
        bGal = heatBTU / (effAfue * BTU_PER_GAL_OIL);
        baseHeatGal += bGal;
      } else if (existingFuel === "electric") {
        bKwh = heatBTU / (1.0 * BTU_PER_KWH);
        baseHeatKwh += bKwh;
      } else if (existingFuel === "heatpump") {
        const oldCop = effExistingHspf / 3.412;
        bKwh = heatBTU / (oldCop * BTU_PER_KWH);
        baseHeatKwh += bKwh;
      }
    }

    /* ----- Baseline cooling energy ----- */
    let bCoolKwh = 0;
    if (coolBTU > 0 && existingSeer > 0) {
      bCoolKwh = coolBTU / (effSeer * 1000);
      baseCoolKwh += bCoolKwh;
    }

    /* ----- Heat pump heating energy ----- */
    let hpKwh = 0, hpBkKwh = 0, hpBkTherms = 0, copUsed = 0;
    if (heatBTU > 0) {
      if (t < hpMinTempF) {
        // below min operating temp: all load to backup
        if (backupType === "dualfuel_gas") {
          hpBkTherms = heatBTU / (0.95 * BTU_PER_THERM);
          hpBackupTherms += hpBkTherms;
        } else {
          hpBkKwh = heatBTU / (1.0 * BTU_PER_KWH);
          hpBackupKwh += hpBkKwh;
        }
      } else {
        copUsed = copAt(t, curve);
        hpKwh = heatBTU / (copUsed * BTU_PER_KWH);
        hpHeatKwh += hpKwh;
      }
    }

    /* ----- Heat pump cooling energy ----- */
    let hpCKwh = 0;
    if (coolBTU > 0) {
      // mild high-temp derate above 85F
      const derate = t > 85 ? 0.92 : 1.0;
      hpCKwh = coolBTU / (hpSeer2 * derate * 1000);
      hpCoolKwh += hpCKwh;
    }

    binRows.push({
      t, h,
      hRatio: round3(hRatio), cRatio: round3(cRatio),
      heatLoadBTU: Math.round(heatLoadBTU),
      copUsed: round2(copUsed),
      baseHeat: round1(bTherms || bGal || bKwh),
      hpHeatKwh: round1(hpKwh + hpBkKwh),
      hpCoolKwh: round1(hpCKwh)
    });
  }

  /* ----- Baseline annual cost ----- */
  const baseHeatCost =
      baseHeatTherms * gasRateDollars
    + baseHeatGal * oilRateDollars
    + baseHeatKwh * elecRate;
  const baseCoolCost = baseCoolKwh * elecRate;
  const baseCost = baseHeatCost + baseCoolCost;

  /* ----- Heat pump annual cost ----- */
  const hpElecKwh = hpHeatKwh + hpBackupKwh + hpCoolKwh;
  const hpCost = hpElecKwh * elecRate + hpBackupTherms * gasRateDollars;

  /* ----- Savings ----- */
  const annualSavings = baseCost - hpCost;
  const pctSavings = baseCost > 0 ? (annualSavings / baseCost) * 100 : 0;

  /* ----- Energy reduction (site kWh-equivalent, always meaningful) ----- */
  const baseSiteKwhEq =
      baseHeatKwh + baseCoolKwh
    + baseHeatTherms * KWH_PER_THERM
    + baseHeatGal * (BTU_PER_GAL_OIL / BTU_PER_KWH);
  const hpSiteKwhEq = hpElecKwh + hpBackupTherms * KWH_PER_THERM;
  const energyReductionKwh = baseSiteKwhEq - hpSiteKwhEq;

  /* ----- CO2 ----- */
  const baseCo2 =
      baseHeatTherms * CO2_LB_PER_THERM
    + baseHeatGal * CO2_LB_PER_GAL
    + (baseHeatKwh + baseCoolKwh) * gridEmissionsLbPerKwh;
  const hpCo2 = hpElecKwh * gridEmissionsLbPerKwh + hpBackupTherms * CO2_LB_PER_THERM;
  const co2ReductionLb = baseCo2 - hpCo2;

  /* ----- Accuracy tier & confidence band ----- */
  let tier, bandPct;
  if (hasManualJ && !curve.modeled) { tier = "Detailed";  bandPct = 12; }
  else if (hasManualJ && curve.modeled) { tier = "Standard"; bandPct = 18; }
  else { tier = "Indicative"; bandPct = 25; }

  /* ----- Financials ----- */
  const simplePayback = annualSavings > 0 ? installedCost / annualSavings : Infinity;
  const esc = rateEscalationPct / 100;
  const disc = discountRatePct / 100;
  let lifetimeSavings = 0, npv = -installedCost;
  for (let yr = 1; yr <= equipmentLifeYrs; yr++) {
    const yrSavings = annualSavings * Math.pow(1 + esc, yr - 1);
    lifetimeSavings += yrSavings;
    npv += yrSavings / Math.pow(1 + disc, yr);
  }

  const band = (v) => ({
    low: v * (1 - bandPct / 100),
    high: v * (1 + bandPct / 100)
  });

  return {
    tier, bandPct,
    pctSavings,
    annualSavings, annualSavingsBand: band(annualSavings),
    energyReductionKwh, energyReductionBand: band(energyReductionKwh),
    co2ReductionLb, co2ReductionTons: co2ReductionLb / 2000,
    baseCost, hpCost,
    baseSiteKwhEq, hpSiteKwhEq,
    simplePayback, lifetimeSavings, npv,
    assumptions: {
      balPointHeatF, ductLeakUsed,
      agePenaltyPct: round1(agePenalty * 100),
      copSource: curve.modeled ? "Modeled from HSPF2" : "Mfr. data sheet",
      curve,
      gridEmissionsLbPerKwh,
      station: station.label
    },
    binRows,
    raw: {
      baseHeatTherms, baseHeatGal, baseHeatKwh, baseCoolKwh,
      hpHeatKwh, hpBackupKwh, hpBackupTherms, hpCoolKwh, hpElecKwh
    }
  };
}

/* design heat temp passthrough (kept as fn for clarity in load ratio call) */
function designHeatF(v){ return v; }

/* rounding helpers */
function round1(v){ return Math.round(v * 10) / 10; }
function round2(v){ return Math.round(v * 100) / 100; }
function round3(v){ return Math.round(v * 1000) / 1000; }

/* export for node testing; ignored in browser */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { calculate, modeledCopCurve, copAt, BIN_TABLES };
}
