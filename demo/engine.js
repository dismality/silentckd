// SilentCKD pattern engine: turns a clinic export into model inputs and finds patterns in it.
// Pure logic (no DOM), shared by the website and the Node verification script.
(function (root) {
  const S = root.SilentCKD || require("./model.js");

  // ---------- input schema: what a clinic CSV can contain
  const FIELDS = [
    { key: "patient_id", label: "Patient ID", type: "id", syn: ["patientid", "id", "mrn", "patient", "patientnumber", "recordid"] },
    { key: "age", label: "Age", unit: "years", required: true, min: 18, max: 110, syn: ["age", "ageyrs", "ageyears"] },
    { key: "sex", label: "Sex", type: "sex", required: true, syn: ["sex", "gender"] },
    { key: "systolic_bp", label: "Systolic BP", unit: "mmHg", min: 70, max: 260, syn: ["systolicbp", "sbp", "systolic", "sysbp", "bpsystolic"] },
    { key: "diastolic_bp", label: "Diastolic BP", unit: "mmHg", min: 30, max: 150, syn: ["diastolicbp", "dbp", "diastolic", "diabp", "bpdiastolic"] },
    { key: "bmi", label: "BMI", unit: "kg/m²", min: 12, max: 80, syn: ["bmi", "bodymassindex"] },
    { key: "waist_cm", label: "Waist", unit: "cm", min: 40, max: 200, syn: ["waistcm", "waist", "waistcircumference"] },
    { key: "diagnosed_diabetes", label: "Diagnosed diabetes", type: "bool", syn: ["diagnoseddiabetes", "diabetes", "dm", "t2dm", "diabetic"] },
    { key: "diabetes_years", label: "Years with diabetes", unit: "years", min: 0, max: 80, syn: ["diabetesyears", "diabetesduration", "yearswithdiabetes"] },
    { key: "hba1c_percent", label: "HbA1c", unit: "%", min: 3.5, max: 18, fix: "hba1c", syn: ["hba1cpercent", "hba1c", "a1c", "hemoglobina1c", "hba1cpct", "glycatedhemoglobin"] },
    { key: "on_insulin", label: "On insulin", type: "bool", syn: ["oninsulin", "insulin"] },
    { key: "on_diabetes_pills", label: "On diabetes pills", type: "bool", syn: ["ondiabetespills", "diabetespills", "oralhypoglycemics", "oraldiabetesmeds"] },
    { key: "diagnosed_hypertension", label: "Diagnosed hypertension", type: "bool", syn: ["diagnosedhypertension", "hypertension", "htn"] },
    { key: "on_bp_meds", label: "On BP medication", type: "bool", syn: ["onbpmeds", "bpmeds", "antihypertensive", "antihypertensives", "bpmedication"] },
    { key: "high_cholesterol", label: "High cholesterol", type: "bool", syn: ["highcholesterol", "hyperlipidemia", "dyslipidemia"] },
    { key: "on_cholesterol_meds", label: "On cholesterol medication", type: "bool", syn: ["oncholesterolmeds", "statin", "statins", "lipidmeds", "cholesterolmeds"] },
    { key: "heart_disease_or_stroke", label: "Heart disease or stroke", type: "bool", syn: ["heartdiseaseorstroke", "cvd", "cvdhistory", "ascvd", "heartdisease"] },
    { key: "current_smoker", label: "Current smoker", type: "bool", syn: ["currentsmoker", "smoker", "smoking"] },
    { key: "creatinine_mg_dl", label: "Creatinine", unit: "mg/dL", required: true, min: 0.2, max: 15, fix: "creatinine", syn: ["creatininemgdl", "creatinine", "creat", "scr", "serumcreatinine"] },
    { key: "uric_acid", label: "Uric acid", unit: "mg/dL", min: 1, max: 15, syn: ["uricacid", "urate"] },
    { key: "albumin_g_dl", label: "Albumin", unit: "g/dL", min: 1.5, max: 6.5, fix: "albumin", syn: ["albumingdl", "albumin", "serumalbumin"] },
    { key: "bun", label: "Urea nitrogen", unit: "mg/dL", min: 2, max: 150, syn: ["bun", "ureanitrogen", "bloodureanitrogen"] },
    { key: "potassium", label: "Potassium", unit: "mmol/L", min: 2, max: 8, syn: ["potassium", "k"] },
    { key: "triglycerides", label: "Triglycerides", unit: "mg/dL", min: 20, max: 3000, syn: ["triglycerides", "tg", "trigs"] },
    { key: "total_cholesterol", label: "Total cholesterol", unit: "mg/dL", min: 60, max: 600, syn: ["totalcholesterol", "cholesterol", "tc", "chol"] },
    { key: "hdl", label: "HDL", unit: "mg/dL", min: 5, max: 200, syn: ["hdl", "hdlc", "hdlcholesterol"] },
    { key: "told_kidney_disease", label: "Told has kidney disease", type: "bool", syn: ["toldkidneydisease", "kidneydisease", "ckddiagnosed", "ckd"] },
  ];

  const norm = (h) => String(h).toLowerCase().replace(/\(.*?\)/g, (m) => m.replace(/[()]/g, "")).replace(/[^a-z0-9]/g, "");

  function parseCSV(text) {
    const rows = [];
    let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === "," || c === ";" || c === "\t") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        if (row.some((v) => v.trim() !== "")) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some((v) => v.trim() !== "")) rows.push(row);
    return { header: rows[0] || [], rows: rows.slice(1) };
  }

  function autoMap(header) {
    const h = header.map(norm), map = {};
    for (const f of FIELDS) {
      let idx = h.findIndex((c) => f.syn.includes(c));
      if (idx < 0) idx = h.findIndex((c) => f.syn.some((s) => s.length > 3 && c.startsWith(s)));
      map[f.key] = idx;
    }
    return map;
  }

  const num = (v) => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim().replace(",", ".");
    if (s === "" || /^(na|n\/a|nan|null|-)$/i.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const bool = (v) => {
    const s = String(v ?? "").trim().toLowerCase();
    if (["1", "y", "yes", "true", "t", "x"].includes(s)) return 1;
    if (["0", "n", "no", "false", "f", ""].includes(s)) return 0;
    return null;
  };
  const sexVal = (v) => {
    const s = String(v ?? "").trim().toLowerCase();
    if (["f", "female", "w", "woman", "2"].includes(s)) return 1;
    if (["m", "male", "man", "1"].includes(s)) return 0;
    return null;
  };

  function egfr2021(scr, age, female) {
    const k = female ? 0.7 : 0.9, a = female ? -0.241 : -0.302, r = scr / k;
    return 142 * Math.min(r, 1) ** a * Math.max(r, 1) ** -1.2 * 0.9938 ** age * (female ? 1.012 : 1);
  }

  // Converts one CSV row into a patient record; issues describe every change made to the data.
  function toPatient(row, map, i) {
    const issues = [], v = {};
    for (const f of FIELDS) {
      const idx = map[f.key];
      const raw = idx >= 0 ? row[idx] : undefined;
      if (f.type === "id") { v[f.key] = raw && String(raw).trim() ? String(raw).trim() : `Row ${i + 1}`; continue; }
      if (f.type === "sex") { v.sex = sexVal(raw); if (raw !== undefined && v.sex === null) issues.push({ field: f.key, kind: "unreadable", text: `Sex "${raw}" not recognised` }); continue; }
      if (f.type === "bool") { const b = bool(raw); v[f.key] = b === null ? 0 : b; if (b === null) issues.push({ field: f.key, kind: "unreadable", text: `${f.label} "${raw}" read as no` }); continue; }
      let n = num(raw);
      if (n !== null && f.fix === "creatinine" && n > 20) { issues.push({ field: f.key, kind: "unit", text: `Creatinine ${n} looks like µmol/L, converted to ${(n / 88.4).toFixed(2)} mg/dL` }); n = n / 88.4; }
      if (n !== null && f.fix === "hba1c" && n > 20) { const pc = n / 10.929 + 2.15; issues.push({ field: f.key, kind: "unit", text: `HbA1c ${n} looks like mmol/mol, converted to ${pc.toFixed(1)}%` }); n = pc; }
      if (n !== null && f.fix === "albumin" && n > 10) { issues.push({ field: f.key, kind: "unit", text: `Albumin ${n} looks like g/L, converted to ${(n / 10).toFixed(1)} g/dL` }); n = n / 10; }
      if (n !== null && (n < f.min || n > f.max)) { issues.push({ field: f.key, kind: "implausible", text: `${f.label} ${n} is outside ${f.min}–${f.max} ${f.unit || ""}, treated as missing` }); n = null; }
      v[f.key] = n;
    }
    const female = v.sex === 1 ? 1 : 0;
    const hasDm = v.diagnosed_diabetes === 1 || (v.hba1c_percent !== null && v.hba1c_percent >= 6.5) ? 1 : 0;
    const egfr = v.creatinine_mg_dl !== null && v.age !== null ? egfr2021(v.creatinine_mg_dl, v.age, female === 1) : null;
    const x = [
      v.age, female, v.bmi, v.waist_cm, v.systolic_bp, v.diastolic_bp, hasDm,
      v.diagnosed_diabetes === 1 ? v.diabetes_years : 0, v.on_insulin, v.on_diabetes_pills, v.hba1c_percent,
      v.diagnosed_hypertension, v.on_bp_meds, v.high_cholesterol, v.on_cholesterol_meds, v.heart_disease_or_stroke, v.current_smoker,
      egfr, v.uric_acid, v.albumin_g_dl, v.bun, v.potassium, v.triglycerides, v.total_cholesterol, v.hdl,
    ];
    const usable = v.age !== null && v.sex !== null;
    if (!usable) issues.push({ field: "age", kind: "excluded", text: "Missing age or sex, so this row can't be scored" });
    return { id: v.patient_id, values: v, x, issues, usable, dx_diabetes: v.diagnosed_diabetes, told_kidney: v.told_kidney_disease };
  }

  function loadClinic(text, mapOverride) {
    const { header, rows } = parseCSV(text);
    const map = mapOverride || autoMap(header);
    const patients = rows.map((r, i) => toPatient(r, map, i));
    const missingCols = FIELDS.filter((f) => f.type !== "id" && map[f.key] < 0).map((f) => f.key);
    return { header, map, patients, missingCols };
  }

  // A form entry goes through the same parsing, unit checks and range checks as a CSV row.
  function patientFromValues(values, id) {
    const row = FIELDS.map((f) => (f.key === "patient_id" ? id : values[f.key] ?? ""));
    const map = Object.fromEntries(FIELDS.map((f, i) => [f.key, i]));
    return toPatient(row, map, 0);
  }

  // ---------- drift: how different is this clinic from the training population?
  function drift(patients, M, P) {
    const rows = [];
    M.features.forEach((f, i) => {
      const vals = patients.filter((p) => p.usable).map((p) => p.x[i]);
      const present = vals.filter((v) => v !== null && v !== undefined);
      const b = P.baseline[f];
      const missing = 1 - present.length / Math.max(vals.length, 1);
      const mean = present.length ? present.reduce((a, c) => a + c, 0) / present.length : null;
      const smd = mean === null || !b.sd ? null : (mean - b.mean) / b.sd;
      rows.push({ feature: f, label: M.labels[f], mean, train_mean: b.mean, smd, missing, flag: (smd !== null && Math.abs(smd) >= 0.3) || missing >= 0.4 });
    });
    return rows;
  }

  // ---------- patterns for one patient
  function profileOf(phi, P) {
    let best = 0, bd = Infinity;
    P.profiles.forEach((pr, i) => {
      let d = 0;
      for (let j = 0; j < phi.length; j++) d += (phi[j] - pr.centroid[j]) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    return P.profiles[best];
  }

  function peopleLikeYou(x, M, P) {
    const K = P.knn, fi = K.features.map((f) => M.features.indexOf(f)), dim = fi.length;
    const z = fi.map((i, j) => { const v = x[i]; return v === null || v === undefined ? 0 : Math.max(-5, Math.min(5, (v - K.mean[j]) / K.sd[j])); });
    const n = K.y.length, d = new Float64Array(n);
    for (let r = 0; r < n; r++) {
      let s = 0;
      for (let j = 0; j < dim; j++) { const t = K.ref[r * dim + j] / K.quant - z[j]; s += t * t; }
      d[r] = Math.sqrt(s);
    }
    // k-th smallest distance via a native typed-array sort, then one pass to collect the neighbours
    const kth = Float64Array.from(d).sort()[K.k - 1];
    let positives = 0, sum = 0, taken = 0;
    for (let r = 0; r < n && taken < K.k; r++) if (d[r] < kth) { positives += K.y[r]; sum += d[r]; taken++; }
    for (let r = 0; r < n && taken < K.k; r++) if (d[r] === kth) { positives += K.y[r]; sum += d[r]; taken++; }
    const meanDist = sum / K.k;
    return { k: K.k, positives, meanDist, unusual: meanDist > K.ood_threshold };
  }

  const FI = (M, f) => M.features.indexOf(f);
  function careGaps(p, M) {
    const x = p.x, g = (f) => x[FI(M, f)], gaps = [];
    const sbp = g("sbp"), dbp = g("dbp"), a1c = g("hba1c"), egfr = g("egfr"), age = g("age");
    if (((sbp !== null && sbp >= 140) || (dbp !== null && dbp >= 90)) && g("bp_meds") === 0)
      gaps.push({ key: "bp", label: "Blood pressure high and untreated", detail: `BP ${Math.round(sbp ?? 0)}/${Math.round(dbp ?? 0)} mmHg with no BP medication recorded.` });
    if (a1c !== null && a1c >= 6.5 && p.dx_diabetes !== 1)
      gaps.push({ key: "undx_dm", label: "Possible undiagnosed diabetes", detail: `HbA1c ${a1c.toFixed(1)}% is in the diabetes range, but diabetes isn't recorded. Confirm with a repeat test.` });
    if (p.dx_diabetes === 1 && a1c !== null && a1c >= 9)
      gaps.push({ key: "dm_control", label: "Diabetes poorly controlled", detail: `HbA1c ${a1c.toFixed(1)}% is well above the usual 7% target.` });
    if (egfr !== null && egfr < 60 && p.told_kidney !== 1)
      gaps.push({ key: "ckd_unrec", label: "Low eGFR not recognised", detail: `eGFR ${Math.round(egfr)} meets CKD criteria if it persists, but kidney disease isn't on record.` });
    if (g("has_diabetes") === 1 && age !== null && age >= 40 && age <= 75 && g("chol_meds") === 0)
      gaps.push({ key: "statin", label: "Diabetes without a statin", detail: "ADA guidance recommends a statin for most people with diabetes aged 40–75." });
    if (g("current_smoker") === 1)
      gaps.push({ key: "smoke", label: "Current smoker", detail: "Smoking speeds kidney decline. Offer cessation support." });
    return gaps;
  }

  function compounding(x, M, P) {
    const ref = (f) => P.baseline[f].median;
    const set = (base, changes) => { const y = base.slice(); for (const [f, v] of changes) y[FI(M, f)] = v; return y; };
    let best = null;
    for (const { a, b } of P.interactions) {
      const ia = FI(M, a), ib = FI(M, b);
      if (x[ia] === null || x[ib] === null) continue;
      const r = (y) => S.risk(M, y);
      const both = r(x), none = r(set(x, [[a, ref(a)], [b, ref(b)]]));
      const onlyA = r(set(x, [[b, ref(b)]])), onlyB = r(set(x, [[a, ref(a)]]));
      const sepA = onlyA - none, sepB = onlyB - none, joint = both - none, extra = joint - sepA - sepB;
      if (!best || extra > best.extra) best = { a, b, sepA, sepB, joint, extra };
    }
    return best && best.extra > 0.015 && best.joint > 0 ? best : null;
  }

  // Picks the full model when most optional measures are present, otherwise the short-form model.
  function chooseModel(p, M) {
    const r = M.rules;
    const missing = r.labs.filter((f) => { const v = p.x[FI(M, f)]; return v === null || v === undefined; }).length;
    if (missing <= r.max_missing_labs) return { model: M, x: p.x, short: false, possible: r.possible, young: r.young };
    const x = p.x.map((v, i) => (M.short.inputs.includes(M.features[i]) ? v : null));
    return { model: M.short, x, short: true, possible: M.short.possible, young: M.short.young };
  }

  // Likely, Possible or Unlikely. Under 45 the bar for Possible is lower, on purpose.
  function answer(risk, age, m, M) {
    const bar = age !== null && age !== undefined && age < 45 ? m.young : m.possible;
    return risk >= M.rules.likely ? "likely" : risk >= bar ? "possible" : "unlikely";
  }

  function thresholdFor(p, M) {
    const m = chooseModel(p, M), age = p.x[FI(M, "age")];
    return age !== null && age < 45 ? m.young : m.possible;
  }

  function analyse(p, M, P, opts = {}) {
    const e = S.explain(M, p.x);
    const thr = thresholdFor(p, M);
    const g = (f) => p.x[FI(M, f)];
    const usualSkip = g("has_diabetes") !== 1 && (g("egfr") === null || g("egfr") >= 60);
    return {
      ...e, threshold: thr, flagged: e.risk >= thr, profile: profileOf(e.phi, P),
      missedByUsual: usualSkip && e.risk >= thr, gaps: careGaps(p, M),
      similar: opts.similar === false ? null : peopleLikeYou(p.x, M, P),
      compound: opts.compound ? compounding(p.x, M, P) : null,
    };
  }

  const api = { FIELDS, parseCSV, autoMap, loadClinic, patientFromValues, drift, profileOf, peopleLikeYou, careGaps, compounding, chooseModel, answer, thresholdFor, analyse, egfr2021 };
  if (typeof module !== "undefined") module.exports = api;
  else root.SilentEngine = api;
})(this);
