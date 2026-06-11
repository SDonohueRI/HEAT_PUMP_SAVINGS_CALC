const { calculate, modeledCopCurve, copAt, BIN_TABLES } = require("./engine.js");

function hr(){ console.log("─".repeat(70)); }
function fmt(v){ return typeof v === "number" ? v.toLocaleString(undefined,{maximumFractionDigits:1}) : v; }

/* sanity: bin hours sum to 8760 */
const sum = BIN_TABLES.KSEA.bins.reduce((a,b)=>a+b.h,0);
console.log("Bin-hour total (should be 8760):", sum);
if (sum !== 8760) { console.error("!! BIN HOURS DO NOT SUM TO 8760"); process.exit(1); }
hr();

/* COP curve checks */
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

/* Scenario A: gas furnace + AC -> ducted HP, with mfr COP data */
const A = calculate({
  existingFuel: "gas", afurePct: 80, existingSeer: 13, systemAgeYrs: 12,
  designHeatLoadMBH: 42.5, designCoolLoadTons: 2.5, hasManualJ: true,
  ductSystem: "ducted_unknown",
  hpHspf2: 9.5, hpSeer2: 17.5, hpMinTempF: -13,
  cop47: 3.8, cop17: 2.1, cop5: 1.4, backupType: "electric",
  installedCost: 14500, equipmentLifeYrs: 18,
  elecRateCents: 11.2, gasRateDollars: 1.28
});
console.log("SCENARIO A — Gas furnace + AC -> ducted HP (mfr COP)");
console.log("  Tier:", A.tier, "±"+A.bandPct+"%");
console.log("  % energy cost reduction:", A.pctSavings.toFixed(1)+"%");
console.log("  Annual $ savings:", "$"+fmt(A.annualSavings),
            "(range $"+fmt(A.annualSavingsBand.low)+" – $"+fmt(A.annualSavingsBand.high)+")");
console.log("  Energy reduction (kWh-eq):", fmt(A.energyReductionKwh),
            "(range "+fmt(A.energyReductionBand.low)+" – "+fmt(A.energyReductionBand.high)+")");
console.log("  CO2 reduction:", A.co2ReductionTons.toFixed(1), "tons/yr");
console.log("  Baseline cost: $"+fmt(A.baseCost)+"  |  HP cost: $"+fmt(A.hpCost));
console.log("  Simple payback:", A.simplePayback.toFixed(1), "yrs");
console.log("  Lifetime savings: $"+fmt(A.lifetimeSavings)+"  |  NPV: $"+fmt(A.npv));
console.log("  Baseline therms:", fmt(A.raw.baseHeatTherms), " HP elec kWh:", fmt(A.raw.hpElecKwh));
hr();

/* Scenario B: electric resistance -> ductless HP, modeled COP */
const B = calculate({
  existingFuel: "electric", existingSeer: 0, systemAgeYrs: 15,
  designHeatLoadMBH: 38, designCoolLoadTons: 0, hasManualJ: true,
  ductSystem: "ductless",
  hpHspf2: 10.0, hpSeer2: 19, hpMinTempF: -5,
  cop47: null, cop17: null, cop5: null, backupType: "electric",
  installedCost: 9500, equipmentLifeYrs: 18,
  elecRateCents: 11.2
});
console.log("SCENARIO B — Electric resistance -> ductless HP (modeled COP)");
console.log("  Tier:", B.tier, "±"+B.bandPct+"%");
console.log("  % energy cost reduction:", B.pctSavings.toFixed(1)+"%");
console.log("  Annual $ savings:", "$"+fmt(B.annualSavings));
console.log("  Energy reduction (kWh-eq):", fmt(B.energyReductionKwh));
console.log("  Baseline electric heat kWh:", fmt(B.raw.baseHeatKwh),
            " HP heat kWh:", fmt(B.raw.hpHeatKwh));
console.log("  Simple payback:", B.simplePayback.toFixed(1), "yrs");
hr();

/* Scenario C: oil furnace -> ducted HP with dual-fuel backup */
const C = calculate({
  existingFuel: "oil", afurePct: 78, existingSeer: 0, systemAgeYrs: 20,
  designHeatLoadMBH: 55, designCoolLoadTons: 0, hasManualJ: true,
  ductSystem: "ducted_tested", ductLeakagePct: 8,
  hpHspf2: 9.0, hpSeer2: 16, hpMinTempF: 5,
  cop47: 3.5, cop17: 1.9, cop5: 1.2, backupType: "dualfuel_gas",
  installedCost: 16000, equipmentLifeYrs: 18,
  elecRateCents: 11.2, oilRateDollars: 4.50, gasRateDollars: 1.28
});
console.log("SCENARIO C — Oil furnace -> ducted HP + dual-fuel backup");
console.log("  Tier:", C.tier, "±"+C.bandPct+"%");
console.log("  % energy cost reduction:", C.pctSavings.toFixed(1)+"%");
console.log("  Annual $ savings:", "$"+fmt(C.annualSavings));
console.log("  Baseline oil gallons:", fmt(C.raw.baseHeatGal));
console.log("  HP backup therms (below 5F):", fmt(C.raw.hpBackupTherms));
console.log("  Simple payback:", C.simplePayback.toFixed(1), "yrs");
hr();

/* Scenario D: existing heat pump upgrade */
const D = calculate({
  existingFuel: "heatpump", existingHspf: 7.5, existingSeer: 14, systemAgeYrs: 14,
  designHeatLoadMBH: 40, designCoolLoadTons: 3, hasManualJ: true,
  ductSystem: "ducted_unknown",
  hpHspf2: 10.5, hpSeer2: 20, hpMinTempF: -13,
  cop47: 4.1, cop17: 2.4, cop5: 1.6, backupType: "electric",
  installedCost: 13000, equipmentLifeYrs: 18,
  elecRateCents: 11.2
});
console.log("SCENARIO D — Existing heat pump upgrade");
console.log("  Tier:", D.tier, "±"+D.bandPct+"%");
console.log("  % energy cost reduction:", D.pctSavings.toFixed(1)+"%");
console.log("  Annual $ savings:", "$"+fmt(D.annualSavings));
console.log("  Old HP kWh:", fmt(D.raw.baseHeatKwh), " New HP kWh:", fmt(D.raw.hpHeatKwh));
console.log("  Simple payback:", D.simplePayback.toFixed(1), "yrs");
hr();

/* Indicative tier check (no Manual J) */
const E = calculate({
  existingFuel: "gas", afurePct: 80, existingSeer: 13,
  designHeatLoadMBH: 45, designCoolLoadTons: 2.5, hasManualJ: false,
  hpHspf2: 9.5, hpSeer2: 17.5, cop47: null,
  installedCost: 14500
});
console.log("SCENARIO E — No Manual J (indicative tier)");
console.log("  Tier:", E.tier, "±"+E.bandPct+"%  (expect Indicative ±25%)");
hr();

console.log("All scenarios ran without error.");
