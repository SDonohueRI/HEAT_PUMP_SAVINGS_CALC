# Heat Pump Energy Savings Estimator — Staging Build

A client-side tool for HVAC contractors to estimate customer energy savings from
ducted or ductless heat pump installations, using the **bin-hour method** against
TMY3 weather data.

**No data is stored on any server.** All calculation runs in the browser. Estimates
are saved locally (JSON download) or exported as PDF / Excel on the contractor's own machine.

---

## What's in this repo

| File | Purpose |
|------|---------|
| `index.html` | The complete calculator — self-contained single page. This is what you deploy. |
| `engine.js` | Standalone copy of the calculation engine (pure functions, no DOM). For Node testing and reference. |
| `test.js` | Test harness validating five scenarios against the engine. Run with `node test.js`. |
| `README.md` | This file. |

The calculation logic in `index.html` is **identical** to `engine.js`. The standalone
engine exists so the math can be unit-tested in Node and audited independently of the UI.

---

## Deploying to GitHub Pages

1. Create a new repository (or use an existing one) and push these files to it.
   Only `index.html` is strictly required for the live site; the rest is for testing/reference.

2. In the repository, go to **Settings → Pages**.

3. Under **Build and deployment → Source**, select **Deploy from a branch**.

4. Choose the branch (e.g. `main`) and folder **`/ (root)`**, then **Save**.

5. Wait ~1 minute. Your tool will be live at:
   `https://<your-username>.github.io/<repo-name>/`

That's it — no build step, no framework, no dependencies to install.

### If you want the calculator in a subfolder
If `index.html` lives in e.g. `/calculator/`, the URL becomes
`https://<your-username>.github.io/<repo-name>/calculator/`. GitHub Pages serves
`index.html` automatically from any folder.

---

## One external dependency

The Excel export uses **SheetJS**, loaded from a CDN:

```
https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
```

Everything else — the calculation engine, UI, JSON save/load, and PDF (print) export —
works with **zero external dependencies and fully offline**. If the CDN is unreachable,
the Excel button shows a friendly message and the rest of the tool keeps working.

> For a fully self-hosted build with no external calls, download `xlsx.full.min.js`,
> commit it to the repo, and change the `<script src=...>` tag in `index.html` to point
> at the local copy. Adds ~900 KB to the repo but removes the CDN dependency.

---

## Calculation method (summary)

- **Bin-hour model.** The year is split into 5°F temperature bins (TMY3 hours per bin).
  Heating/cooling load and heat-pump COP are evaluated bin-by-bin, then summed — far more
  accurate than degree-day shortcuts.
- **COP handling, three tiers:**
  1. Manufacturer / NEEP cold-climate COP at 47/17/5°F → **Detailed, ±12%**
  2. Modeled COP curve derived from HSPF2 → **Standard, ±18%**
  3. No Manual J loads entered → **Indicative, ±25%**
  The active tier is shown live as a badge and widens/narrows the confidence range.
- **Outputs:** annual kWh-equivalent reduction (headline), % energy-cost savings,
  annual $ savings (as a range), CO₂ reduction, simple payback, and lifetime NPV.

### Current staging limitations (by design)
- Bundled climate data covers **one TMY3 station (Sea-Tac / KSEA)** as a representative
  sample. Additional stations are a later phase.
- The default **65°F balance point** is editable but produces slightly conservative
  (high) annual heating estimates. Contractors enter actual Manual J loads, which is the
  dominant accuracy driver.
- The Excel workbook models **electric-resistance backup**; the web tool handles
  dual-fuel precisely. Full Excel parity for dual-fuel + cooling high-temp derate is a
  later phase.
- Utility rebate stacking (PSE, HEAR, etc.) is **not** in this build — energy savings
  first, rebates layered on later.

---

## Running the tests

```bash
node test.js
```

Expected: all five scenarios run without error, the COP curve is reported monotonic
increasing, and tier assignment matches expectations (e.g. Scenario E → Indicative ±25%).
