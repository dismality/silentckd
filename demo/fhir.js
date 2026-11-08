// Reads standard FHIR R4 health-record exports (Patient, Observation, Condition, MedicationRequest)
// and turns them into SilentCKD patients. Runs in the browser; shared with the Node test script.
(function (root) {
  const E = root.SilentEngine || require("./engine.js");

  const LOINC = {
    "8480-6": "systolic_bp", "8462-4": "diastolic_bp", "4548-4": "hba1c_percent", "17856-6": "hba1c_percent",
    "2160-0": "creatinine_mg_dl", "38483-4": "creatinine_mg_dl", "39156-5": "bmi", "8280-0": "waist_cm",
    "3084-1": "uric_acid", "1751-7": "albumin_g_dl", "3094-0": "bun", "6299-2": "bun", "2823-3": "potassium", "6298-4": "potassium",
    "2571-8": "triglycerides", "2093-3": "total_cholesterol", "2085-9": "hdl",
  };
  const SMOKING = "72166-2";
  const RECENT_YEARS = 3;
  const YEAR = 365.25 * 864e5;

  const MEDS = {
    on_insulin: /insulin/i,
    on_diabetes_pills: /metformin|glipizide|glimepiride|glyburide|sitagliptin|linagliptin|pioglitazone|empagliflozin|dapagliflozin|canagliflozin/i,
    on_bp_meds: /lisinopril|enalapril|ramipril|benazepril|losartan|valsartan|irbesartan|olmesartan|amlodipine|nifedipine|hydrochlorothiazide|chlorthalidone|indapamide|atenolol|metoprolol|bisoprolol|carvedilol/i,
    on_cholesterol_meds: /atorvastatin|simvastatin|rosuvastatin|pravastatin|lovastatin|fluvastatin|pitavastatin|ezetimibe/i,
  };
  const CONDITIONS = {
    diagnosed_diabetes: /(^|[^e])diabet|\bE1[01]\b/i,
    diagnosed_hypertension: /hypertens/i,
    high_cholesterol: /hyperlipid|hypercholesterol|dyslipid/i,
    heart_disease_or_stroke: /myocardial|coronary|heart failure|ischemic heart|ischaemic heart|stroke|cerebrovascular|angina/i,
    told_kidney_disease: /chronic kidney|kidney disease|nephropathy|end-stage renal/i,
  };

  function resources(text) {
    const trimmed = text.trim();
    let items;
    try {
      const j = JSON.parse(trimmed);
      items = Array.isArray(j) ? j : [j];
    } catch (e) {
      items = trimmed.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    }
    const out = [];
    for (const r of items) {
      if (r.resourceType === "Bundle") (r.entry || []).forEach((e) => e.resource && out.push(e.resource));
      else out.push(r);
    }
    return out;
  }

  const ref = (r) => (r.subject && r.subject.reference ? r.subject.reference.replace(/^urn:uuid:|^Patient\//, "") : null);
  const when = (r) => Date.parse(r.effectiveDateTime || r.issued || r.authoredOn || r.recordedDate || "") || null;
  const codes = (c) => ((c && c.coding) || []).map((x) => x.code);
  const words = (c) => (c ? [c.text, ...((c.coding || []).map((x) => `${x.display || ""} ${x.code || ""}`))].join(" ") : "");

  function keepLatest(store, key, value, t) {
    if (value === null || value === undefined || !Number.isFinite(value) || !t) return;
    if (!store[key] || t > store[key].t) store[key] = { value, t };
  }

  // Unknown or implausible values are handled later by the same checks used for CSV files.
  function buildValues(pat, items) {
    const obs = {}, flags = {}, onset = {};
    let latest = 0, smokes = null, smokeT = 0;
    for (const r of items) {
      const t = when(r);
      if (r.resourceType === "Observation") {
        const measured = [...codes(r.code), ...(r.component || []).flatMap((part) => codes(part.code))].some((c) => LOINC[c] || c === SMOKING);
        if (t && t > latest && measured) latest = t;
        for (const c of codes(r.code)) {
          if (LOINC[c] && r.valueQuantity) keepLatest(obs, LOINC[c], r.valueQuantity.value, t);
          if (c === SMOKING && t && t > smokeT) {
            const w = words(r.valueCodeableConcept);
            smokeT = t;
            smokes = /every day|some ?day|current/i.test(w) && !/former|never|ex-/i.test(w);
          }
        }
        for (const part of r.component || []) for (const c of codes(part.code)) if (LOINC[c] && part.valueQuantity) keepLatest(obs, LOINC[c], part.valueQuantity.value, t);
      } else if (r.resourceType === "Condition") {
        const w = words(r.code);
        if (/pre-?diabet/i.test(w)) continue;
        const status = codes(r.clinicalStatus)[0];
        for (const [k, re] of Object.entries(CONDITIONS)) {
          if (!re.test(w)) continue;
          if (k === "heart_disease_or_stroke" || !status || status === "active" || status === "recurrence") {
            flags[k] = 1;
            const o = Date.parse(r.onsetDateTime || r.recordedDate || "");
            if (Number.isFinite(o) && (!onset[k] || o < onset[k])) onset[k] = o;
          }
        }
      } else if (r.resourceType === "MedicationRequest" && (r.status === "active" || r.status === "on-hold")) {
        const w = words(r.medicationCodeableConcept) || (r.medicationReference && r.medicationReference.display) || "";
        for (const [k, re] of Object.entries(MEDS)) if (re.test(w)) flags[k] = 1;
      }
    }
    if (!latest) latest = Date.now();
    const birth = Date.parse(pat.birthDate || "");
    const v = {};
    if (Number.isFinite(birth)) v.age = String(Math.floor((latest - birth) / YEAR));
    v.sex = pat.gender === "female" ? "F" : pat.gender === "male" ? "M" : "";
    for (const [k, o] of Object.entries(obs)) if (latest - o.t <= RECENT_YEARS * YEAR) v[k] = String(o.value);
    for (const [k, on] of Object.entries(flags)) v[k] = String(on);
    if (onset.diagnosed_diabetes) v.diabetes_years = String(Math.max(0, +((latest - onset.diagnosed_diabetes) / YEAR).toFixed(1)));
    if (smokes !== null) v.current_smoker = smokes ? "1" : "0";
    return v;
  }

  // texts: one string per uploaded file. Patients outside the model's target group are counted and left out.
  function load(texts) {
    const all = texts.flatMap(resources);
    const patients = all.filter((r) => r.resourceType === "Patient");
    const byPatient = new Map(patients.map((p) => [p.id, []]));
    for (const r of all) {
      const id = ref(r);
      if (id && byPatient.has(id)) byPatient.get(id).push(r);
    }
    const out = [], skipped = { deceased: 0, under_20: 0, not_target: 0, no_age_or_sex: 0 };
    for (const pat of patients) {
      if (pat.deceasedDateTime || pat.deceasedBoolean === true) { skipped.deceased++; continue; }
      const v = buildValues(pat, byPatient.get(pat.id));
      if (!v.age || !v.sex) { skipped.no_age_or_sex++; continue; }
      if (+v.age < 20) { skipped.under_20++; continue; }
      const target = v.diagnosed_diabetes === "1" || v.diagnosed_hypertension === "1" || v.on_bp_meds === "1" || v.on_insulin === "1" || v.on_diabetes_pills === "1"
        || +v.hba1c_percent >= 6.5 || +v.systolic_bp >= 140 || +v.diastolic_bp >= 90;
      if (!target) { skipped.not_target++; continue; }
      out.push(E.patientFromValues(v, `Record ${String(pat.id).slice(0, 8)}`));
    }
    const map = Object.fromEntries(E.FIELDS.map((f) => [f.key, out.some((p) => p.values[f.key] !== null && p.values[f.key] !== undefined) ? 0 : -1]));
    return { header: [], map, patients: out, missingCols: [], skipped, read: patients.length };
  }

  const api = { load, resources };
  if (typeof module !== "undefined") module.exports = api;
  else root.SilentFhir = api;
})(this);
