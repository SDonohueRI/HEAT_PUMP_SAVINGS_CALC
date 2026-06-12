const { calculate, modeledCopCurve, copAt, modeledCapacityCurve, capacityAtTemp, BIN_TABLES, buildHeatingPeriods } = require("./engine.js");

function hr(){ console.log("─".repeat(70)); }
function fmt(v){ return typeof v === "number" ? v.toLocaleString(undefined,{maximumFractionDigits:1}) : v; }

const sum = BIN_TABLES.KSEA.bins.reduce((a,b)=>a+b.h,0);
console.log("Bin-hour total (should be 8760):", sum);
if (sum !== 8760) { console.error("!! BIN HOURS DO NOT SUM TO 8760"); process.exit(1); }
hr();

const curve = modeledCopCurve(9.5);
console.log("Modeled COP curve from HSPF2 9.5:", curve);
console.log("COP at 47F:", copAt(47, curve).toFixed(2));
console.log("COP at 30F:", copAt(30, curve).toFixed(2));
console.log("COP at 17F:", copAt(17, curve).toFixed(2));
console.log("COP at 5F :", copAt(5, curve).toFixed(2));
console.log("COP at -5F:", copAt(-5, curve).toFixed(2), "(floored at 1.0)");
console.log("Monotonic increasing with temp:",
  [copAt(0,curve),copAt(10,curve),copAt(20,curve),copAt(35,curve),copAt(47,curve)]
    .every((v,i,a)=> i===0 || v>=a[i-1]));
hr();

const capCurve = modeledCapacityCurve(36000);
console.log("Modeled capacity curve from 3 tons:", capCurve);
console.log("Cap at 47F:", capacityAtTemp(47, capCurve), "(should be 36000)");
console.log("Cap at 17F:", capacityAtTemp(17, capCurve), "(should be 23400)");
console.log("Cap at 5F :", capacityAtTemp(5, capCurve), "(should be 17280)");
console.log("Cap at 30F:", capacityAtTemp(30, capCurve));
console.log("Cap at 60F:", capacityAtTemp(60, capCurve), "(should be ≤ 39600 = 110%)");
hr();

const periods = buildHeatingPeriods({ heatingSetpointF: 70, internalGainsOffsetF: 5, setbackTempF: 62, setbackHoursPerDay: 8 });
console.log("Setback period builder (70F setpoint, 62F setback, 8 hrs/day):", periods);
console.log("Daily hours sum to 24:", (periods.setbackHoursPerDay + periods.recoveryHoursPerDay + periods.occupiedHoursPerDay).toFixed(2));
hr();

const A = calculate({
  existingFuel: "gas", afurePct: 80, existingSeer: 13, systemAgeYrs: 12,
  designHeatLoadMBH: 42.5, designCoolLoadTons: 2.5, hasManualJ: true,
  ductSystem: "ducted_unknown",
  hpHspf2: 9.5, hpSeer2: 17.5, hpMinTempF: -13, hpCapTons: 3.0,
  heatingSetpointF: 70, internalGainsOffsetF: 5, setbackTempF: null,
  cop47: 3.8, cop17: 2.1, cop5: 1.4, backupType: "electric",
  installedCost: 14500, equipmentLifeYrs: 18,
  elecRateCents: 11.2, gasRateDollars: 1.28
});
console.log("SCENARIO A — Gas furnace + AC -> ducted HP (mfr COP)");
console.log("  Tier:", A.tier, "±"+A.bandPct+"%");
console.log("  % energy cost reduction:", A.pctSavings.toFixed(1)+"%");
console.log("  Annual $ savings:", "$"+fmt(A.annualSavings));
console.log("  Baseline therms:", fmt(A.raw.baseHeatTherms), " HP elec kWh:", fmt(A.raw.hpElecKwh));
console.log("  Backup capacity kWh:", fmt(A.raw.hpBackupCapKwh));
hr();

const B = calculate({
  existingFuel: "electric", existingSeer: 0, systemAgeYrs: 15,
  designHeatLoadMBH: 38, designCoolLoadTons: 0, hasManualJ: true,
  ductSystem: "ductless",
  hpHspf2: 10.0, hpSeer2: 19, hpMinTempF: -5, hpCapTons: 3.0,
  heatingSetpointF: 70, internalGainsOffsetF: 5, setbackTempF: null,
  cop47: null, cop17: null, cop5: null, backupType: "electric",
  installedCost: 9500, equipmentLifeYrs: 18,
  elecRateCents: 11.2
});
console.log("SCENARIO B — Electric resistance -> ductless HP (modeled COP)");
console.log("  Tier:", B.tier, "±"+B.bandPct+"%");
console.log("  % energy cost reduction:", B.pctSavings.toFixed(1)+"%");
console.log("  Annual $ savings:", "$"+fmt(B.annualSavings));
hr();

const C = calculate({
  existingFuel: "oil", afurePct: 78, existingSeer: 0, systemAgeYrs: 20,
  designHeatLoadMBH: 55, designCoolLoadTons: 0, hasManualJ: true,
  ductSystem: "ducted_tested", ductLeakagePct: 8,
  hpHspf2: 9.0, hpSeer2: 16, hpMinTempF: 5, hpCapTons: 3.0,
  heatingSetpointF: 70, internalGainsOffsetF: 5, setbackTempF: null,
  cop47: 3.5, cop17: 1.9, cop5: 1.2, backupType: "dualfuel_gas",
  installedCost: 16000, equipmentLifeYrs: 18,
  elecRateCents: 11.2, oilRateDollars: 4.50, gasRateDollars: 1.28
});
console.log("SCENARIO C — Oil furnace -> ducted HP + dual-fuel backup");
console.log("  HP backup therms (lockout):", fmt(C.raw.hpBackupLockoutTherms));
console.log("  HP backup therms (capacity):", fmt(C.raw.hpBackupCapTherms));
hr();

const D = calculate({
  existingFuel: "heatpump", existingHspf: 7.5, existingSeer: 14, systemAgeYrs: 14,
  designHeatLoadMBH: 40, designCoolLoadTons: 3, hasManualJ: true,
  ductSystem: "ducted_unknown",
  hpHspf2: 10.5, hpSeer2: 20, hpMinTempF: -13, hpCapTons: 3.0,
  heatingSetpointF: 70, internalGainsOffsetF: 5, setbackTempF: null,
  cop47: 4.1, cop17: 2.4, cop5: 1.6, backupType: "electric",
  installedCost: 13000, equipmentLifeYrs: 18,
  elecRateCents: 11.2
});
console.log("SCENARIO D — Existing heat pump upgrade");
console.log("  Annual $ savings:", "$"+fmt(D.annualSavings));
hr();

const E = calculate({
  existingFuel: "gas", afurePct: 80, existingSeer: 13,
  designHeatLoadMBH: 45, designCoolLoadTons: 2.5, hasManualJ: false,
  hpHspf2: 9.5, hpSeer2: 17.5, hpCapTons: 3.0, cop47: null,
  heatingSetpointF: 70, internalGainsOffsetF: 5, setbackTempF: null,
  installedCost: 14500
});
console.log("SCENARIO E — No Manual J (indicative tier)");
console.log("  Tier:", E.tier, "±"+E.bandPct+"%  (expect Indicative ±25%)");
hr();

const F = calculate({
  existingFuel: "gas", afurePct: 80, existingSeer: 13, systemAgeYrs: 12,
  designHeatLoadMBH: 55, designCoolLoadTons: 2.5, hasManualJ: true,
  ductSystem: "ducted_unknown",
  hpHspf2: 9.5, hpSeer2: 17.5, hpMinTempF: -13, hpCapTons: 2.0,
  heatingSetpointF: 70, internalGainsOffsetF: 5, setbackTempF: null,
  cop47: 3.8, cop17: 2.1, cop5: 1.4, backupType: "electric",
  installedCost: 14500, equipmentLifeYrs: 18,
  elecRateCents: 11.2, gasRateDollars: 1.28
});
console.log("SCENARIO F — Undersized HP (2 tons for 55 MBH load)");
console.log("  Backup capacity kWh:", fmt(F.raw.hpBackupCapKwh));
console.log("  Total backup kWh:", fmt(F.raw.hpBackupKwh));
hr();

const G = calculate({
  existingFuel: "gas", afurePct: 80, existingSeer: 13, systemAgeYrs: 12,
  designHeatLoadMBH: 42.5, designCoolLoadTons: 2.5, hasManualJ: true,
  ductSystem: "ducted_unknown",
  hpHspf2: 9.5, hpSeer2: 17.5, hpMinTempF: -13, hpCapTons: 3.0,
  heatingSetpointF: 70, internalGainsOffsetF: 5, setbackTempF: null,
  cop47: 3.8, cop17: 2.1, cop5: 1.4, backupType: "electric",
  installedCost: 14500, equipmentLifeYrs: 18,
  elecRateCents: 11.2, gasRateDollars: 1.28
});
console.log("SCENARIO G — Properly sized HP (regression check vs Scenario A)");
console.log("  Backup capacity kWh:", fmt(G.raw.hpBackupCapKwh));
console.log("  Annual savings match A?", Math.abs(G.annualSavings - A.annualSavings) < 1 ? "YES" : "NO — check capacity curve");
hr();

const H = calculate({
  existingFuel: "gas", afurePct: 80, existingSeer: 13, systemAgeYrs: 12,
  designHeatLoadMBH: 42.5, designCoolLoadTons: 2.5, hasManualJ: true,
  ductSystem: "ducted_unknown",
  hpHspf2: 9.5, hpSeer2: 17.5, hpMinTempF: -13, hpCapTons: 3.0,
  heatingSetpointF: 70, internalGainsOffsetF: 5, setbackTempF: 62, setbackHoursPerDay: 8,
  cop47: 3.8, cop17: 2.1, cop5: 1.4, backupType: "electric",
  installedCost: 14500, equipmentLifeYrs: 18,
  elecRateCents: 11.2, gasRateDollars: 1.28
});
console.log("SCENARIO H — Same as A with 62F setback for 8 hrs/day");
console.log("  Annual savings:", "$"+fmt(H.annualSavings));
console.log("  HP annual cost higher than no setback?", H.hpCost > A.hpCost ? "YES" : "NO — investigate");
console.log("  Savings lower than no setback?", H.annualSavings < A.annualSavings ? "YES" : "NO — investigate");
console.log("  Recovery hrs/day:", H.assumptions.recoveryHoursPerDay);
hr();

const I = calculate({
  existingFuel: "gas", afurePct: 80, existingSeer: 13, systemAgeYrs: 12,
  designHeatLoadMBH: 42.5, designCoolLoadTons: 2.5, hasManualJ: true,
  ductSystem: "ducted_unknown",
  hpHspf2: 9.5, hpSeer2: 17.5, hpMinTempF: -13, hpCapTons: 3.0,
  heatingSetpointF: 70, internalGainsOffsetF: 5, setbackTempF: 70, setbackHoursPerDay: 8,
  cop47: 3.8, cop17: 2.1, cop5: 1.4, backupType: "electric",
  installedCost: 14500, equipmentLifeYrs: 18,
  elecRateCents: 11.2, gasRateDollars: 1.28
});
console.log("SCENARIO I — Setback temp equals occupied setpoint (should behave like no setback)");
console.log("  Annual savings match A?", Math.abs(I.annualSavings - A.annualSavings) < 1 ? "YES" : "NO — investigate");
hr();

console.log("All scenarios ran without error.");
