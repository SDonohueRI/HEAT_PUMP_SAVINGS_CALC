/* ===================================================================
   Heat Pump Energy Savings — Bin-Hour Calculation Engine
   -------------------------------------------------------------------
   Pure functions, no DOM. Identical logic is embedded in index.html
   and mirrored in the Excel export so all three agree.
   =================================================================== */

/* Physical constants */
const BTU_PER_KWH      = 3412;
const BTU_PER_THERM    = 100000;
const BTU_PER_GAL_OIL  = 138500;
const KWH_PER_THERM    = 29.3;
const CO2_LB_PER_THERM = 11.7;
const CO2_LB_PER_GAL   = 22.4;

const BIN_TABLES = {
  KSEA: {
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

function copAt(tempF, curve) {
  const { cop5, cop17, cop47 } = curve;
  let cop;
  if (tempF <= 5) cop = cop5;
  else if (tempF < 17) cop = cop5 + (cop17 - cop5) * (tempF - 5) / 12;
  else if (tempF < 47) cop = cop17 + (cop47 - cop17) * (tempF - 17) / 30;
  else {
    const slope = (cop47 - cop17) / 30;
    cop = cop47 + slope * (tempF - 47);
    cop = Math.min(cop, cop47 * 1.3);
  }
  return Math.max(cop, 1.0);
}

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
  if (tempF <= 5) cap = cap5;
  else if (tempF < 17) cap = cap5 + (cap17 - cap5) * (tempF - 5) / 12;
  else if (tempF < 47) cap = cap17 + (cap47 - cap17) * (tempF - 17) / 30;
  else {
    const slope = (cap47 - cap17) / 30;
    cap = cap47 + slope * (tempF - 47);
    cap = Math.min(cap, cap47 * 1.1);
  }
  return Math.max(cap, 0);
}

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

function buildHeatingPeriods({ heatingSetpointF, internalGainsOffsetF, setbackTempF, setbackHoursPerDay }) {
  const balPointHeatF = heatingSetpointF - internalGainsOffsetF;
  const hasSetback = setbackTempF !== null && setbackTempF !== undefined && setbackTempF < heatingSetpointF;
  if (!hasSetback) {
    return {
      balPointHeatF,
      setbackDepthF: 0,
      setbackHoursPerDay: 0,
      recoveryHoursPerDay: 0,
      occupiedHoursPerDay: 24,
      setbackBalPointHeatF: balPointHeatF,
      hasSetback: false
    };
  }

  const setbackDepthF = heatingSetpointF - setbackTempF;
  const rawSetbackHours = Math.max(0, setbackHoursPerDay || 0);
  const rawRecoveryHours = setbackDepthF * 0.25;
  const cappedSetbackHours = Math.min(24, rawSetbackHours);
  const cappedRecoveryHours = Math.min(rawRecoveryHours, 24 - cappedSetbackHours);
  const occupiedHoursPerDay = Math.max(0, 24 - cappedSetbackHours - cappedRecoveryHours);
  const setbackBalPointHeatF = setbackTempF - internalGainsOffsetF;

  return {
    balPointHeatF,
    setbackDepthF,
    setbackHoursPerDay: cappedSetbackHours,
    recoveryHoursPerDay: cappedRecoveryHours,
    occupiedHoursPerDay,
    setbackBalPointHeatF,
    hasSetback: true
  };
}

function calculate(input) {
  const {
    stationId = "KSEA",
    designHeatTempF = 14,
    designCoolTempF = 89,
    balPointHeatF = 65,
    balPointCoolF = 70,

    heatingSetpointF = 70,
    coolingSetpointF = 75,
    internalGainsOffsetF = 5,
    setbackTempF = null,
    setbackHoursPerDay = 8,

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

  let curve = (cop47 && cop17 && cop5)
    ? { cop47, cop17, cop5, modeled: false }
    : modeledCopCurve(hpHspf2);

  const hpCap47Btu = hpCapTons * 12000;
  let capCurve = (cap17Tons && cap5Tons)
    ? { cap47: hpCap47Btu, cap17: cap17Tons * 12000, cap5: cap5Tons * 12000, modeled: false }
    : modeledCapacityCurve(hpCap47Btu);

  const periods = buildHeatingPeriods({
    heatingSetpointF,
    internalGainsOffsetF,
    setbackTempF,
    setbackHoursPerDay
  });

  const effectiveBalPointHeatF = periods.hasSetback ? periods.balPointHeatF : balPointHeatF;

  let baseHeatTherms = 0, baseHeatGal = 0, baseHeatKwh = 0, baseCoolKwh = 0;
  let hpHeatKwh = 0, hpCoolKwh = 0;
  let hpBackupLockoutKwh = 0, hpBackupLockoutTherms = 0;
  let hpBackupCapKwh = 0, hpBackupCapTherms = 0;
  const binRows = [];

  for (const { t, h } of station.bins) {
    const cRatio = coolLoadRatio(t, balPointCoolF, designCoolTempF);
    const coolLoadBTU = designCoolBTU * cRatio * ductFactor;
    const coolBTU = coolLoadBTU * h;

    const setbackFrac = periods.setbackHoursPerDay / 24;
    const recoveryFrac = periods.recoveryHoursPerDay / 24;
    const occupiedFrac = periods.occupiedHoursPerDay / 24;

    const occupiedLoadBTU = designHeatBTU * heatLoadRatio(t, effectiveBalPointHeatF, designHeatTempF) * ductFactor;
    const setbackLoadBTU = periods.hasSetback
      ? designHeatBTU * heatLoadRatio(t, periods.setbackBalPointHeatF, designHeatTempF) * ductFactor
      : 0;
    const recoveryLoadBTU = periods.hasSetback
      ? designHeatBTU * Math.min(1, heatLoadRatio(t, effectiveBalPointHeatF + periods.setbackDepthF, designHeatTempF)) * ductFactor
      : 0;

    const steadyLoadBTU = periods.hasSetback
      ? (occupiedLoadBTU * occupiedFrac) + (setbackLoadBTU * setbackFrac) + (recoveryLoadBTU * recoveryFrac)
      : designHeatBTU * heatLoadRatio(t, effectiveBalPointHeatF, designHeatTempF) * ductFactor;

    const heatLoadBTU = steadyLoadBTU;
    const heatBTU = heatLoadBTU * h;

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
      hRatio: round3(heatLoadRatio(t, effectiveBalPointHeatF, designHeatTempF)),
      cRatio: round3(cRatio),
      heatLoadBTU: Math.round(heatLoadBTU),
      occupiedLoadBTU: Math.round(occupiedLoadBTU),
      setbackLoadBTU: Math.round(setbackLoadBTU),
      recoveryLoadBTU: Math.round(recoveryLoadBTU),
      setbackHours: round1(h * setbackFrac),
      recoveryHours: round1(h * recoveryFrac),
      occupiedHours: round1(h * occupiedFrac),
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
      balPointHeatF: effectiveBalPointHeatF,
      ductLeakUsed,
      agePenaltyPct: round1(agePenalty * 100),
      copSource: curve.modeled ? "Modeled from HSPF2" : "Mfr. data sheet",
      capSource: capCurve.modeled ? "Standard degradation" : "Mfr. data sheet",
      curve,
      capCurve,
      heatingSetpointF,
      coolingSetpointF,
      internalGainsOffsetF,
      setbackTempF,
      setbackHoursPerDay: periods.setbackHoursPerDay,
      recoveryHoursPerDay: round1(periods.recoveryHoursPerDay),
      occupiedHoursPerDay: round1(periods.occupiedHoursPerDay),
      gridEmissionsLbPerKwh,
      station: station.label
    },
    binRows,
    raw: {
      baseHeatTherms, baseHeatGal, baseHeatKwh, baseCoolKwh,
      hpHeatKwh, hpBackupKwh, hpBackupTherms, hpCoolKwh, hpElecKwh,
      hpBackupLockoutKwh, hpBackupLockoutTherms,
      hpBackupCapKwh, hpBackupCapTherms,
      capCurve,
      periods,
      duct: ductFactor,
      effAfue,
      effSeer,
      curve
    }
  };
}

function designHeatF(v){ return v; }
function round1(v){ return Math.round(v * 10) / 10; }
function round2(v){ return Math.round(v * 100) / 100; }
function round3(v){ return Math.round(v * 1000) / 1000; }

if (typeof module !== "undefined" && module.exports) {
  module.exports = { calculate, modeledCopCurve, copAt, modeledCapacityCurve, capacityAtTemp, BIN_TABLES, buildHeatingPeriods };
}
