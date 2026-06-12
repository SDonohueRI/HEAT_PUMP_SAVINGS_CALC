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

/* ---------- Capacity curve helpers ---------- */

function modeledCapacityCurve(cap47Btu) {
  return {
    cap47: Math.round(cap47Btu),
    cap17: Math.round(cap47Btu * 0.65),
    cap5: Math.round(cap47Btu * 0.48),
    modeled: true
  };
}

function capacityAtTemp(tempF, curve) {
  const { cap5, cap17, cap47 } = curve;
  let cap;
  if (tempF <= 5) {
    cap = cap5;
  } else if (tempF < 17) {
    cap = cap5 + (cap17 - cap5) * (tempF - 5) / (17 - 5);
  } else if (tempF < 47) {
    cap = cap17 + (cap47 - cap17) * (tempF - 17) / (47 - 17);
  } else {
    const slope = (cap47 - cap17) / (47 - 17);
    cap = cap47 + slope * (tempF - 47);
    cap = Math.min(cap, cap47 * 1.1);
  }
  return Math.max(cap, 0);
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

    elecRateCents = 11.2,
    gasRateDollars = 1.28,
    oilRateDollars = 4.50,
    rateEscalationPct = 2.5,
    discountRatePct = 3.0,

    existingFuel = "gas",
    afurePct = 80,
    existingHspf = 8.0,
    existingSeer = 13,
    systemAgeYrs = 12,

    designHeatLoadMBH = 42.5,
    designCoolLoadTons = 2.5,
    hasManualJ = true,

    ductSystem = "ducted_unknown",
    ductLeakagePct = null,

    hpHspf2 = 9.5,
    hpSeer2 = 17.5,
    hpMinTempF = -13,
    hpCapTons = 3.0,
    cap17Tons = null,
    cap5Tons = null,
    cop47 = null, cop17 = null, cop5 = null,
    backupType = "electric",

    installedCost = 14500,
    equipmentLifeYrs = 18,

    gridEmissionsLbPerKwh = 0.287
  } = input;

  const station = BIN_TABLES[stationId] || BIN_TABLES.KSEA;
  const elecRate = elecRateCents / 100;
  const afue = afurePct / 100;

  const designHeatBTU = designHeatLoadMBH * 1000;
  const designCoolBTU = designCoolLoadTons * 12000;

  let ductFactor = 1.0;
  let ductLeakUsed = 0;
  if (ductSystem === "ducted_unknown") { ductLeakUsed = 12; ductFactor = 1.12; }
  else if (ductSystem === "ducted_tested") { ductLeakUsed = ductLeakagePct ?? 8; ductFactor = 1 + ductLeakUsed / 100; }
  else if (ductSystem === "partial") { ductLeakUsed = 6; ductFactor = 1.06; }
  else { ductLeakUsed = 0; ductFactor = 1.0; }

  const agePenalty = Math.min(0.10, Math.max(0, (systemAgeYrs - 8) * 0.01));
  const effAfue = afue * (1 - agePenalty);
  const effExistingHspf = existingHspf * (1 - agePenalty);
  const effSeer = existingSeer * (1 - agePenalty * 0.5);

  let curve;
  if (cop47 && cop17 && cop5) {
    curve = { cop47, cop17, cop5, modeled: false };
  } else {
    curve = modeledCopCurve(hpHspf2);
  }

  const hpCap47Btu = hpCapTons * 12000;
  let capCurve;
  if (cap17Tons && cap5Tons) {
    capCurve = {
      cap47: hpCap47Btu,
      cap17: cap17Tons * 12000,
      cap5: cap5Tons * 12000,
      modeled: false
    };
  } else {
    capCurve = modeledCapacityCurve(hpCap47Btu);
  }

  let baseHeatTherms = 0, baseHeatGal = 0, baseHeatKwh = 0, baseCoolKwh = 0;
  let hpHeatKwh = 0, hpCoolKwh = 0;
  let hpBackupLockoutKwh = 0, hpBackupLockoutTherms = 0;
  let hpBackupCapKwh = 0, hpBackupCapTherms = 0;
  const binRows = [];

  for (const { t, h } of station.bins) {
    const hRatio = heatLoadRatio(t, balPointHeatF, designHeatF(designHeatTempF));
    const cRatio = coolLoadRatio(t, balPointCoolF, designCoolTempF);

    const heatLoadBTU = designHeatBTU * hRatio * ductFactor;
    const coolLoadBTU = designCoolBTU * cRatio * ductFactor;

    const heatBTU = heatLoadBTU * h;
    const coolBTU = coolLoadBTU * h;

    let bTherms = 0, bGal = 0, bKwh = 0;
    if (heatBTU > 0) {
      if (existingFuel === "gas") {
        bTherms = heatBTU / (effAfue * BTU_PER_THERM);
        baseHeatTherms += bTherms;
      } else if (existingFuel === "oil") {
        bGal = heatBTU / (effAfue * BTU_PER_GAL_OIL);
        baseHeatGal += bGal;
      } else if (existingFuel === "electric") {
        bKwh = heatBTU / BTU_PER_KWH;
        baseHeatKwh += bKwh;
      } else if (existingFuel === "heatpump") {
        const oldCop = effExistingHspf / 3.412;
        bKwh = heatBTU / (oldCop * BTU_PER_KWH);
        baseHeatKwh += bKwh;
      }
    }

    let bCoolKwh = 0;
    if (coolBTU > 0 && existingSeer > 0) {
      bCoolKwh = coolBTU / (effSeer * 1000);
      baseCoolKwh += bCoolKwh;
    }

    let hpKwh = 0, copUsed = 0, capAtBin = 0;
    let bkLockoutKwh = 0, bkLockoutTherms = 0;
    let bkCapKwh = 0, bkCapTherms = 0;
    if (heatBTU > 0) {
      if (t < hpMinTempF) {
        if (backupType === "dualfuel_gas") {
          bkLockoutTherms = heatBTU / (0.95 * BTU_PER_THERM);
          hpBackupLockoutTherms += bkLockoutTherms;
        } else if (backupType !== "none") {
          bkLockoutKwh = heatBTU / BTU_PER_KWH;
          hpBackupLockoutKwh += bkLockoutKwh;
        }
      } else {
        copUsed = copAt(t, curve);
        capAtBin = capacityAtTemp(t, capCurve);
        const deliveredBTUHr = Math.min(heatLoadBTU, capAtBin);
        const shortfallBTUHr = Math.max(0, heatLoadBTU - capAtBin);
        const deliveredBTU = deliveredBTUHr * h;
        const shortfallBTU = shortfallBTUHr * h;

        hpKwh = deliveredBTU / (copUsed * BTU_PER_KWH);
        hpHeatKwh += hpKwh;

        if (shortfallBTU > 0) {
          if (backupType === "dualfuel_gas") {
            bkCapTherms = shortfallBTU / (0.95 * BTU_PER_THERM);
            hpBackupCapTherms += bkCapTherms;
          } else if (backupType !== "none") {
            bkCapKwh = shortfallBTU / BTU_PER_KWH;
            hpBackupCapKwh += bkCapKwh;
          }
        }
      }
    }

    let hpCKwh = 0;
    if (coolBTU > 0) {
      const derate = t > 85 ? 0.92 : 1.0;
      hpCKwh = coolBTU / (hpSeer2 * derate * 1000);
      hpCoolKwh += hpCKwh;
    }

    binRows.push({
      t, h,
      hRatio: round3(hRatio), cRatio: round3(cRatio),
      heatLoadBTU: Math.round(heatLoadBTU),
      capAtTemp: Math.round(capAtBin),
      copUsed: round2(copUsed),
      baseHeat: round1(bTherms || bGal || bKwh),
      hpHeatKwh: round1(hpKwh),
      hpBackupLockoutKwh: round1(bkLockoutKwh),
      hpBackupCapKwh: round1(bkCapKwh),
      hpBackupLockoutTherms: round1(bkLockoutTherms),
      hpBackupCapTherms: round1(bkCapTherms),
      hpCoolKwh: round1(hpCKwh)
    });
  }

  const hpBackupKwh = hpBackupLockoutKwh + hpBackupCapKwh;
  const hpBackupTherms = hpBackupLockoutTherms + hpBackupCapTherms;

  const baseHeatCost =
      baseHeatTherms * gasRateDollars
    + baseHeatGal * oilRateDollars
    + baseHeatKwh * elecRate;
  const baseCoolCost = baseCoolKwh * elecRate;
  const baseCost = baseHeatCost + baseCoolCost;

  const hpElecKwh = hpHeatKwh + hpBackupKwh + hpCoolKwh;
  const hpCost = hpElecKwh * elecRate + hpBackupTherms * gasRateDollars;

  const annualSavings = baseCost - hpCost;
  const pctSavings = baseCost > 0 ? (annualSavings / baseCost) * 100 : 0;

  const baseSiteKwhEq =
      baseHeatKwh + baseCoolKwh
    + baseHeatTherms * KWH_PER_THERM
    + baseHeatGal * (BTU_PER_GAL_OIL / BTU_PER_KWH);
  const hpSiteKwhEq = hpElecKwh + hpBackupTherms * KWH_PER_THERM;
  const energyReductionKwh = baseSiteKwhEq - hpSiteKwhEq;

  const baseCo2 =
      baseHeatTherms * CO2_LB_PER_THERM
    + baseHeatGal * CO2_LB_PER_GAL
    + (baseHeatKwh + baseCoolKwh) * gridEmissionsLbPerKwh;
  const hpCo2 = hpElecKwh * gridEmissionsLbPerKwh + hpBackupTherms * CO2_LB_PER_THERM;
  const co2ReductionLb = baseCo2 - hpCo2;

  let tier, bandPct;
  if (hasManualJ && !curve.modeled) { tier = "Detailed";  bandPct = 12; }
  else if (hasManualJ && curve.modeled) { tier = "Standard"; bandPct = 18; }
  else { tier = "Indicative"; bandPct = 25; }

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
      capSource: capCurve.modeled ? "Standard degradation" : "Mfr. data sheet",
      curve,
      capCurve,
      gridEmissionsLbPerKwh,
      station: station.label
    },
    binRows,
    raw: {
      baseHeatTherms, baseHeatGal, baseHeatKwh, baseCoolKwh,
      hpHeatKwh, hpBackupKwh, hpBackupTherms, hpCoolKwh, hpElecKwh,
      hpBackupLockoutKwh, hpBackupLockoutTherms,
      hpBackupCapKwh, hpBackupCapTherms,
      capCurve
    }
  };
}

function designHeatF(v){ return v; }
function round1(v){ return Math.round(v * 10) / 10; }
function round2(v){ return Math.round(v * 100) / 100; }
function round3(v){ return Math.round(v * 1000) / 1000; }

if (typeof module !== "undefined" && module.exports) {
  module.exports = { calculate, modeledCopCurve, copAt, modeledCapacityCurve, capacityAtTemp, BIN_TABLES };
}
