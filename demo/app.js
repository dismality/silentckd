// SilentCKD website: plain-language screens on top of the model (model.js) and pattern engine (engine.js).
(async function () {
  const S = window.SilentCKD, E = window.SilentEngine;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const r0 = (v) => Math.round(v);

  const [M, P, clinicText, resultsText] = await Promise.all([
    fetch("data/model.json").then((r) => r.json()),
    fetch("data/patterns.json").then((r) => r.json()),
    fetch("data/sample_clinic.csv").then((r) => r.text()),
    fetch("data/sample_results.csv").then((r) => r.text()),
  ]);
  S.prepare(M); S.prepare(M.short);
  const FI = (f) => M.features.indexOf(f);
  const RESULTS = Object.fromEntries(E.parseCSV(resultsText).rows.filter((r) => r[0]).map((r) => [r[0], Number(r[1])]));

  const SUMMARY = M.summary;  // results on the 2021-23 test set, written by src/answers.py

  // ---------- verdicts
  const VERDICT = {
    likely: { tag: "LIKELY", title: "Likely to have hidden kidney damage", known: "Likely to have kidney damage", short: "Likely" },
    possible: { tag: "POSSIBLE", title: "Possibly has hidden kidney damage", known: "Possibly has kidney damage", short: "Possible" },
    unlikely: { tag: "UNLIKELY", title: "Unlikely to have hidden kidney damage", known: "Unlikely to have kidney damage", short: "Unlikely" },
  };
  function nextStep(v, hasDm, lowEgfr) {
    if (lowEgfr) return "Arrange a doctor's review and a urine test (urine ACR), because the kidney blood test is low.";
    if (v === "likely") return "Arrange a urine test (urine ACR) soon. It's a quick, cheap urine sample.";
    if (v === "possible") return "Add a urine test (urine ACR) at the next routine visit.";
    return hasDm ? "No urgent test. People with diabetes should still have the yearly urine test that guidelines recommend."
                 : "No extra test needed now. Check again next year, or sooner if blood pressure or blood sugar rises.";
  }

  // ---------- plain-language reasons: SHAP values grouped into everyday topics
  const fmt = (v, d = 0) => (v === null || v === undefined ? null : Number(v).toFixed(d));
  const TOPICS = [
    { feats: ["sbp", "dbp", "bp_meds", "dx_hypertension"], text: (g, up) => {
      const s = g("sbp"), d = g("dbp"), bp = s !== null ? ` (${r0(s)}${d !== null ? "/" + r0(d) : ""})` : "";
      if (up) return s !== null && s >= 140 ? `Blood pressure is high${bp}` : g("bp_meds") === 1 ? `Needs blood pressure medicine${bp}` : s !== null && s >= 130 ? `Blood pressure is a little raised${bp}` : g("dx_hypertension") === 1 ? `Has been told they have high blood pressure${bp}` : `Blood pressure reading${bp}`;
      if (s === null) return "Blood pressure history isn't adding risk";
      return s < 130 ? `Blood pressure is healthy${bp}` : s < 140 ? `Blood pressure is only mildly raised${bp}` : `Blood pressure isn't adding much here${bp}`;
    } },
    { feats: ["has_diabetes", "diabetes_years", "insulin", "diabetes_pills", "hba1c"], text: (g, up) => {
      const a = g("hba1c"), dm = g("has_diabetes") === 1, y = g("diabetes_years"), a1c = a !== null ? ` (HbA1c ${fmt(a, 1)}%)` : "";
      const undiagnosed = dm && !y && g("insulin") !== 1 && g("diabetes_pills") !== 1 && a !== null && a >= 6.5;
      if (up) {
        if (undiagnosed) return `Blood sugar is in the diabetes range${a1c}, though diabetes isn't on record`;
        if (dm) return `Has diabetes${y ? ` for ${r0(y)} years` : ""}${a !== null && a >= 7 ? `, with blood sugar above target${a1c}` : ""}`;
        return a !== null && a >= 5.7 ? `Blood sugar is borderline${a1c}` : `Blood sugar results${a1c}`;
      }
      if (!dm) return a !== null && a < 5.7 ? `No diabetes, normal blood sugar${a1c}` : `No diabetes on record${a1c}`;
      if (a !== null && a < 7) return `Diabetes is well controlled${a1c}`;
      return y && y < 5 ? `Diabetes is fairly recent (${r0(y)} years)` : "Diabetes isn't adding much here";
    } },
    { feats: ["egfr", "bun", "potassium"], text: (g, up) => {
      const e = g("egfr"), eg = e !== null ? ` (eGFR ${r0(e)}; normal is 90+)` : "";
      if (e === null) return up ? "Other kidney-related blood tests" : "Other kidney-related blood tests aren't adding risk";
      if (up) return e < 60 ? `Kidney blood test is low${eg}` : e < 90 ? `Kidney blood test is slightly low${eg}`
        : e >= 105 ? `Kidney blood test is unusually high (eGFR ${r0(e)}), which can be an early sign of strain` : "Other kidney blood test results";
      return e >= 90 ? `Kidney blood test is normal (eGFR ${r0(e)})` : e >= 60 ? `Kidney blood test is only slightly low (eGFR ${r0(e)})` : "Other kidney-related blood tests aren't adding risk";
    } },
    { feats: ["age"], text: (g, up) => (up ? `Age ${r0(g("age"))}: kidney damage becomes more common with age` : `Age ${r0(g("age"))}: younger than many people with kidney damage`) },
    { feats: ["cvd_history"], text: (g, up) => (up ? "Has had heart disease or a stroke" : "No heart disease or stroke") },
    { feats: ["bmi", "waist"], text: (g, up) => { const b = g("bmi"); if (b === null && g("waist") === null && up) return "BMI and waist are missing, which in this data goes with poorer health"; const t = b !== null ? ` (BMI ${fmt(b, 1)})` : ""; return !up ? `Body weight is not adding risk${t}` : b !== null && b >= 30 ? `High body weight${t}` : b !== null && b < 20 ? `Low body weight${t}` : `Body measurements${t}`; } },
    { feats: ["dx_high_chol", "chol_meds", "triglycerides", "total_chol", "hdl"], text: (g, up) => {
      const tg = g("triglycerides"), hdl = g("hdl");
      if (up) return tg !== null && tg >= 150 ? `High blood fats (triglycerides ${r0(tg)})` : hdl !== null && hdl < 40 ? `Low "good" cholesterol (HDL ${r0(hdl)})` : "Cholesterol results";
      return "Cholesterol levels are not adding risk";
    } },
    { feats: ["current_smoker"], text: (g, up) => (up ? "Smokes" : "Doesn't smoke") },
    { feats: ["serum_albumin", "uric_acid"], text: (g, up) => {
      const al = g("serum_albumin"), ua = g("uric_acid");
      if (up) return al !== null && al < 3.8 ? `Low blood protein (albumin ${fmt(al, 1)})` : ua !== null && ua >= 7 ? `High uric acid (${fmt(ua, 1)})` : "Other blood test results";
      return "Other blood test results aren't adding risk";
    } },
    { feats: ["female"], text: (g, up) => `${g("female") === 1 ? "Women" : "Men"} are slightly ${up ? "more" : "less"} likely to have it` },
  ];
  function reasons(x, phi) {
    const g = (f) => x[FI(f)];
    const out = TOPICS.map((t) => {
      const v = t.feats.reduce((s, f) => s + phi[FI(f)], 0);
      return { v, up: v > 0, text: t.text(g, v > 0) };
    }).filter((r) => Math.abs(r.v) >= 0.05);
    const ups = out.filter((r) => r.up).sort((a, b) => b.v - a.v).slice(0, 4);
    const downs = out.filter((r) => !r.up).sort((a, b) => a.v - b.v).slice(0, 3);
    return { ups, downs };
  }
  const strength = (v) => (Math.abs(v) >= 0.4 ? 3 : Math.abs(v) >= 0.15 ? 2 : 1);
  const STRENGTH_WORD = ["", "a little", "moderately", "strongly"];
  function reasonList(list, up) {
    return `<ul class="reasons">${list.map((r) => {
      const s = strength(r.v);
      return `<li class="${up ? "up" : "down"}"><span class="arrow" aria-hidden="true">${up ? "↑" : "↓"}</span><span>${esc(r.text)}</span>
        <span class="strength" title="${up ? "Raises" : "Lowers"} the chance ${STRENGTH_WORD[s]}" aria-label="${up ? "Raises" : "Lowers"} the chance ${STRENGTH_WORD[s]}">${[1, 2, 3].map((i) => `<i class="${i <= s ? "on" : ""}"></i>`).join("")}</span></li>`;
    }).join("")}</ul>`;
  }

  // ---------- questions for the doctor (prompts, never orders)
  function questions(p, v) {
    const qs = [], x = p.x, g = (f) => x[FI(f)];
    if (v !== "unlikely") qs.push("Should this patient have a urine test (urine ACR) to check their kidneys?");
    for (const gap of E.careGaps(p, M)) {
      if (gap.key === "bp") qs.push(`Blood pressure is ${r0(g("sbp") ?? 0)}/${r0(g("dbp") ?? 0)} with no medicine recorded. Does it need treatment?`);
      if (gap.key === "undx_dm") qs.push(`HbA1c is ${fmt(g("hba1c"), 1)}% with no diabetes on record. Could this patient have diabetes?`);
      if (gap.key === "dm_control") qs.push(`HbA1c is ${fmt(g("hba1c"), 1)}%. How can blood sugar be brought down?`);
      if (gap.key === "ckd_unrec") qs.push(`The kidney blood test (eGFR ${r0(g("egfr"))}) is low with no kidney diagnosis recorded. Does this patient need a kidney review?`);
      if (gap.key === "statin") qs.push("Would a cholesterol medicine (statin) help protect this patient's heart and kidneys?");
      if (gap.key === "smoke") qs.push("What help can this patient get to stop smoking?");
    }
    if (!qs.length) qs.push("When should this patient's kidneys next be checked?");
    return qs;
  }

  function dots(n) {
    const k = Math.max(0, Math.min(100, Math.round(n)));
    return `<div class="dots" aria-hidden="true">${Array.from({ length: 100 }, (_, i) => `<i class="${i < k ? "on" : ""}"></i>`).join("")}</div>`;
  }

  // ---------- one patient, full result
  function score(p) {
    const m = E.chooseModel(p, M), e = S.explain(m.model, m.x), age = p.x[FI("age")];
    const v = E.answer(e.risk, age, m, M);
    return { ...e, short: m.short, v, lowerBar: v === "possible" && e.risk < m.possible };
  }
  function verdictCard(p, s, compact) {
    const V = VERDICT[s.v], n = r0(s.risk * 100), hasDm = p.x[FI("has_diabetes")] === 1;
    const egfr = p.x[FI("egfr")], lowEgfr = egfr !== null && egfr < 60, known = lowEgfr || p.told_kidney === 1;
    const usualSkip = s.v !== "unlikely" && !hasDm && egfr !== null && egfr >= 60;
    const heading = known && s.v === "unlikely" ? "A urine test is unlikely to show damage" : known ? V.known : V.title;
    return `<div class="verdict ${s.v}">
      <div class="tag">${V.tag}</div>
      <h2>${heading}</h2>
      <div class="vbody">${dots(n)}
        <div><div class="chance">About ${n} in 100</div><div>people with a record like this have kidney damage. The average for adults with diabetes or high blood pressure is ${SUMMARY.prevalence} in 100.</div></div>
      </div>
      ${s.lowerBar ? `<div class="flagline">Under 45 we use a lower bar for Possible, because kidney damage this early has decades to get worse.</div>` : ""}
      ${s.v === "possible" && !s.lowerBar && n < SUMMARY.prevalence ? `<div class="flagline">This is below average, but it's still worth checking: the urine test is cheap, so we suggest one from about 13 in 100.</div>` : ""}
      ${lowEgfr && s.v !== "unlikely" ? `<div class="flagline">The kidney blood test is already low, so this isn't hidden. A urine test shows how much damage there is.</div>` : ""}
      ${lowEgfr && s.v === "unlikely" ? `<div class="flagline">But the kidney blood test is already low (eGFR ${r0(egfr)}). That needs a doctor's review, whatever this answer says.</div>` : ""}
      ${usualSkip ? `<div class="flagline">Usual practice would probably not test this patient: no diabetes, and a kidney blood test that doesn't raise an alarm. These are the cases SilentCKD is built to find.</div>` : ""}
      ${compact ? "" : `<div class="next"><b>Suggested next step</b>${nextStep(s.v, hasDm, lowEgfr)}</div>`}
    </div>`;
  }

  // The model was trained on adults 20+ with diabetes or high blood pressure.
  function inScope(p) {
    const v = p.values;
    return v.age >= 20 && (p.x[FI("has_diabetes")] === 1 || v.diagnosed_hypertension === 1 || v.on_bp_meds === 1 || v.systolic_bp >= 140 || v.diastolic_bp >= 90);
  }
  function renderResult(p, ctx) {
    const box = $("result");
    if (!p.usable) {
      $("live").innerHTML = "";
      box.innerHTML = `<div class="card"><h3>Enter age and sex to see an answer</h3><p class="muted">Everything else is optional, but a kidney blood test (creatinine) and blood pressure make the answer much more reliable.</p></div>`;
      return;
    }
    const s = score(p), rs = reasons(p.x, s.phi), sim = E.peopleLikeYou(p.x, M, P);
    const missing = [];
    if (p.values.creatinine_mg_dl === null) missing.push("a kidney blood test (creatinine)");
    if (p.values.systolic_bp === null) missing.push("blood pressure");
    if (p.values.hba1c_percent === null) missing.push("HbA1c");
    const fixes = p.issues.filter((i) => i.kind !== "unreadable" && i.kind !== "excluded");
    let real = "";
    if (ctx && ctx.id && RESULTS[ctx.id] !== undefined) {
      real = ctx.dirty
        ? `<div class="real muted">You've changed this record, so the patient's real urine result no longer applies.</div>`
        : `<div>${realBadge(ctx.id, s.v)}<p style="margin:6px 0 0">SilentCKD never saw this result. Urine ACR ${fmt(RESULTS[ctx.id], 1)} mg/g (30 or more means kidney damage).</p></div>`;
    }
    box.innerHTML = `
      ${verdictCard(p, s)}
      ${real}
      ${inScope(p) ? "" : `<div class="note"><b>Outside the group it was built for.</b> SilentCKD was built for adults 20 or over with diabetes or high blood pressure. This record shows neither, so treat the answer with caution.</div>`}
      ${s.short ? `<div class="note">Several blood tests are blank, so this answer comes from a <b>shorter version of the model</b> that needs fewer details. Fill in "More details" to use the full version.</div>` : ""}
      ${p.told_kidney === 1 ? `<div class="note">This patient already has a kidney disease diagnosis. SilentCKD is meant for finding people who don't know yet.</div>` : ""}
      ${sim.unusual ? `<div class="note"><b>Unusual record.</b> This patient is quite different from the people SilentCKD learned from, so treat the answer with extra caution.</div>` : ""}
      <div class="card">
        <h3>Why this answer</h3>
        ${rs.ups.length ? `<p style="margin:0;font-weight:700">Raises the chance</p>${reasonList(rs.ups, true)}` : ""}
        ${rs.downs.length ? `<p style="margin:12px 0 0;font-weight:700">Lowers the chance</p>${reasonList(rs.downs, false)}` : ""}
        ${missing.length ? `<p class="small" style="margin:8px 0 0">Adding ${missing.join(", ")} would make this answer more reliable.</p>` : ""}
        ${fixes.length ? `<p class="small muted" style="margin:8px 0 0">${fixes.map((f) => esc(f.text)).join(". ")}.</p>` : ""}
      </div>
      ${whatIfCard(s)}
      <div class="card">
        <h3>Points for the doctor to review</h3>
        <ul class="qs">${questions(p, s.v).map((q) => `<li>${esc(q)}</li>`).join("")}</ul>
        <p style="margin:10px 0 0">These are prompts, not orders. Only a doctor can diagnose kidney disease.</p>
      </div>`;
    paintLive(s);
  }

  // ---------- what if: change things that can be changed and see the new chance
  const WHATIF = [
    { key: "bp", label: "Blood pressure of 130/80", when: (v) => +v.systolic_bp > 130 || +v.diastolic_bp > 80,
      apply: (v) => { if (+v.systolic_bp > 130) v.systolic_bp = "130"; if (+v.diastolic_bp > 80) v.diastolic_bp = "80"; } },
    { key: "sugar", label: "HbA1c of 7%", when: (v) => num(v.hba1c_percent) > 7, apply: (v) => { v.hba1c_percent = "7"; } },
    { key: "smoke", label: "A non-smoker", when: (v) => v.current_smoker === "1", apply: (v) => { v.current_smoker = "0"; } },
    { key: "weight", label: "BMI 5 points lower", when: (v) => num(v.bmi) >= 27, apply: (v) => { v.bmi = String(num(v.bmi) - 5); if (num(v.waist_cm)) v.waist_cm = String(num(v.waist_cm) - 12); } },
  ];
  const num = (s) => (s === "" || s === undefined || s === null ? NaN : Number(s));
  let whatIf = new Set();
  function riskOf(values) {
    const p = E.patientFromValues(values, "x"), m = E.chooseModel(p, M);
    const risk = S.risk(m.model, m.x);
    return { risk, v: E.answer(risk, p.x[FI("age")], m, M) };
  }
  function whatIfCard(s) {
    const base = r0(s.risk * 100);
    const opts = WHATIF.filter((o) => { if (!o.when(vals)) return false; const v = { ...vals }; o.apply(v); return r0(riskOf(v).risk * 100) <= base; });
    if (!opts.length) return "";
    const now = r0(s.risk * 100);
    const rows = opts.map((o) => {
      const v = { ...vals }; o.apply(v);
      const alone = r0(riskOf(v).risk * 100), d = alone - now, on = whatIf.has(o.key);
      return `<button type="button" class="wi" data-wi="${o.key}" aria-pressed="${on}">
        <span class="box" aria-hidden="true">${on ? "✓" : ""}</span><span>${o.label}</span>
        <span class="delta ${d < 0 ? "dn" : d > 0 ? "upd" : ""}">${d === 0 ? "no change" : `${d > 0 ? "+" : "−"}${Math.abs(d)} in 100`}</span></button>`;
    }).join("");
    let combined = `<p style="margin:12px 0 0">Tick one or more to see the combined effect.</p>`;
    const chosen = opts.filter((o) => whatIf.has(o.key));
    if (chosen.length) {
      const v = { ...vals }; chosen.forEach((o) => o.apply(v));
      const after = riskOf(v), n = r0(after.risk * 100);
      combined = `<div class="wi-result ${after.v}">
        <div><span class="muted">Now</span><div class="wi-num">${now}<small> in 100</small></div><span class="chip ${s.v}">${VERDICT[s.v].short}</span></div>
        <div class="wi-arrow" aria-hidden="true">→</div>
        <div><span class="muted">With these differences</span><div class="wi-num">${n}<small> in 100</small></div><span class="chip ${after.v}">${VERDICT[after.v].short}</span></div>
      </div>`;
    }
    return `<div class="card" id="whatif">
      <h3>What if this record were different?</h3>
      <p style="margin:0 0 8px">The same patient, with one thing different:</p>
      ${rows}${combined}
      <p style="margin:12px 0 0"><b>This compares records. It does not show what treatment would do.</b> Only a urine test can show whether this patient has kidney damage.</p>
    </div>`;
  }
  $("result").addEventListener("click", (ev) => {
    const b = ev.target.closest(".wi"); if (!b) return;
    const k = b.dataset.wi; whatIf.has(k) ? whatIf.delete(k) : whatIf.add(k);
    const y = window.scrollY; update(); window.scrollTo(0, y);
    const again = document.querySelector(`.wi[data-wi="${k}"]`); if (again) again.focus({ preventScroll: true });
  });

  // ---------- live answer shown above the form, so changes are visible while editing
  function paintLive(s) {
    const n = r0(s.risk * 100);
    const ex = ctx && EXAMPLES.find((e) => e.id === ctx.id), who = !ctx ? "New patient" : `${ex ? ex.name : ctx.id}${ctx.dirty ? " (edited)" : ""}`;
    $("live").innerHTML = `<span><b style="font-size:inherit">${esc(who)}</b>:</span> <span class="chip ${s.v}">${VERDICT[s.v].short}</span> <b>${n} in 100</b>`;
  }

  // ---------- the form
  const EXAMPLES = [
    { id: "C-0320", name: "Mr Koh, 63", note: "High blood pressure only" },
    { id: "C-0332", name: "Mr Lim, 57", note: "No diabetes on record" },
    { id: "C-0038", name: "Mdm Wong, 71", note: "Diabetes, high blood pressure" },
    { id: "C-0302", name: "Ms Ng, 34", note: "Young, no diabetes" },
    { id: "C-0015", name: "Mr Tan, 58", note: "Diabetes, well controlled" },
    { id: "C-0242", name: "Mdm Goh, 75", note: "A case it got wrong" },
  ];
  const clinicSample = E.loadClinic(clinicText);
  const byId = Object.fromEntries(clinicSample.patients.map((p) => [p.id, p]));
  let vals = {}, ctx = null;

  function valuesToForm(v) {
    const out = {};
    for (const f of E.FIELDS) {
      const x = v[f.key];
      if (f.key === "patient_id") continue;
      if (f.type === "sex") out.sex = x === 1 ? "F" : x === 0 ? "M" : "";
      else out[f.key] = x === null || x === undefined ? "" : String(f.type === "bool" ? x : +Number(x).toFixed(2));
    }
    return out;
  }
  function paintForm() {
    document.querySelectorAll("#form input[data-k]").forEach((el) => { el.value = vals[el.dataset.k] ?? ""; });
    document.querySelectorAll("#form .seg").forEach((seg) => {
      seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(vals[seg.dataset.k] === b.dataset.v)));
    });
    $("dm-years").hidden = vals.diagnosed_diabetes !== "1";
    document.querySelectorAll("#examples .ex").forEach((b) => b.setAttribute("aria-pressed", String(!!ctx && ctx.id === b.dataset.id && !ctx.dirty)));
  }
  function update() {
    paintForm();
    renderResult(E.patientFromValues(vals, ctx ? ctx.id : "Patient"), ctx);
  }
  function loadPatient(p) {
    vals = valuesToForm(p.values);
    ctx = { id: p.id, dirty: false };
    whatIf = new Set();
    update();
  }
  // Each example shows its own answer and chance, so patients can be compared at a glance.
  function exampleButtons(cls) {
    return EXAMPLES.map((e) => {
      const s = score(byId[e.id]), on = cls === "hp" ? e.id === heroId : !!ctx && ctx.id === e.id && !ctx.dirty;
      return `<button type="button" class="ex" data-id="${e.id}" aria-pressed="${on}"><b>${e.name}</b><span>${e.note}</span>
        <span class="exv"><span class="chip ${s.v}">${VERDICT[s.v].short}</span><span class="exn"><b>${r0(s.risk * 100)}</b><small>in 100</small></span></span></button>`;
    }).join("");
  }
  $("examples").innerHTML = exampleButtons("ex");
  $("back-clinic").addEventListener("click", () => go("clinic"));
  $("examples").addEventListener("click", (ev) => { const b = ev.target.closest(".ex"); if (!b) return; $("back-clinic").hidden = true; loadPatient(byId[b.dataset.id]); if (innerWidth < 880) $("result").scrollIntoView({ behavior: "smooth" }); });
  $("form").addEventListener("submit", (ev) => ev.preventDefault());
  $("form").addEventListener("input", (ev) => {
    const k = ev.target.dataset.k; if (!k) return;
    vals[k] = ev.target.value; if (ctx) ctx.dirty = true;
    paintForm(); renderResult(E.patientFromValues(vals, "Patient"), ctx);
  });
  $("form").addEventListener("click", (ev) => {
    const b = ev.target.closest(".seg button"); if (!b) return;
    const k = b.parentElement.dataset.k;
    vals[k] = vals[k] === b.dataset.v ? "" : b.dataset.v; if (ctx) ctx.dirty = true;
    update();
  });
  $("clear").addEventListener("click", () => { vals = {}; ctx = null; whatIf = new Set(); update(); });

  // ---------- home hero: a live example
  function facts(p) {
    const v = p.values, x = p.x, egfr = x[FI("egfr")], a1c = v.hba1c_percent, sbp = v.systolic_bp, dbp = v.diastolic_bp;
    const dm = v.diagnosed_diabetes === 1, undx = !dm && a1c !== null && a1c >= 6.5;
    const tile = (label, value, status, tone) => `<div class="fact"><span class="fl">${label}</span><span class="fv">${value}</span>${status ? `<span class="fs ${tone}">${status}</span>` : ""}</div>`;
    return `<div class="facts">
      ${tile("Age, sex", `${v.age ?? "?"}, ${v.sex === 1 ? "female" : "male"}`, "", "")}
      ${tile("Blood pressure", sbp !== null ? `${r0(sbp)}/${dbp !== null ? r0(dbp) : "?"}` : "Not given", sbp === null ? "" : sbp >= 140 ? "High" : sbp >= 130 ? "Slightly high" : "Healthy", sbp >= 140 ? "bad" : sbp >= 130 ? "mid" : "ok")}
      ${tile("Diabetes", dm ? `Yes${v.diabetes_years ? `, ${r0(v.diabetes_years)} yrs` : ""}` : "Not on record", undx ? "Sugar in diabetes range" : "", "bad")}
      ${tile("Blood sugar (HbA1c)", a1c !== null ? `${fmt(a1c, 1)}%` : "Not given", a1c === null ? "" : a1c >= 7 ? "High" : a1c >= 5.7 ? "Borderline" : "Normal", a1c >= 7 ? "bad" : a1c >= 5.7 ? "mid" : "ok")}
      ${tile("Kidney blood test", egfr !== null ? `eGFR ${r0(egfr)}` : "Not given", egfr === null ? "" : egfr < 60 ? "Low" : egfr < 90 ? "Slightly low" : "Normal", egfr < 60 ? "bad" : egfr < 90 ? "mid" : "ok")}
    </div>`;
  }
  function realBadge(id, v) {
    if (RESULTS[id] === undefined) return "";
    const has = RESULTS[id] >= 30, wrong = (v === "likely" && !has) || (v === "unlikely" && has);
    return `<div class="realbadge ${has ? "yes" : "no"}"><span>Real urine test result</span><b>${has ? "Protein found: kidney damage" : "Urine test was normal"}</b>${wrong ? `<em>SilentCKD got this one wrong.</em>` : ""}</div>`;
  }
  let heroId = EXAMPLES[0].id;
  function hero() {
    const p = byId[heroId], s = score(p), ex = EXAMPLES.find((e) => e.id === heroId);
    $("hero-demo").innerHTML = `
      <div class="eyebrow">Try it: pick a patient (real people, names made up)</div>
      <div class="picker" role="group" aria-label="Example patients">${exampleButtons("hp")}</div>
      <div class="card" style="margin-top:12px">
        <h3 style="margin-bottom:10px">${ex.name}</h3>
        ${facts(p)}
      </div>
      <div style="margin-top:12px">${verdictCard(p, s, true)}</div>
      <div class="row" style="margin-top:12px;justify-content:space-between">${realBadge(p.id, s.v)}<button class="btn" id="hero-open">Change details and see why</button></div>`;
  }
  $("hero-demo").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-id]");
    if (b) { heroId = b.dataset.id; hero(); return; }
    if (ev.target.closest("#hero-open")) { loadPatient(byId[heroId]); go("check"); }
  });
  hero();

  // ---------- clinic list
  let clinic = null, filter = "all", shown = 50;
  function runClinic(loaded, label, isSample) {
    const usable = loaded.patients.filter((p) => p.usable);
    const rows = usable.map((p) => {
      const m = E.chooseModel(p, M), risk = S.risk(m.model, m.x);
      const egfr = p.x[FI("egfr")], hasDm = p.x[FI("has_diabetes")] === 1;
      return { p, m, risk, v: E.answer(risk, p.x[FI("age")], m, M), hasDm, lowEgfr: egfr !== null && egfr < 60, usualSkip: !hasDm && egfr !== null && egfr >= 60 };
    }).sort((a, b) => b.risk - a.risk);
    clinic = { rows, label, isSample, loaded, skipped: loaded.patients.length - usable.length };
    filter = "all"; shown = 50;
    renderClinic();
    setupPlan();
  }
  function mainReason(row) {
    if (!row.reason) {
      const e = S.explain(row.m.model, row.m.x), rs = reasons(row.p.x, e.phi);
      row.reason = rs.ups[0] ? rs.ups[0].text : rs.downs[0] ? rs.downs[0].text : "";
    }
    return row.reason;
  }
  function renderClinic() {
    const { rows, label, isSample, loaded, skipped } = clinic;
    const count = (v) => rows.filter((r) => r.v === v).length;
    $("clinic-src").textContent = isSample ? `A sample of ${rows.length} real adults from the 2021–23 test group. Their urine results are hidden from the model, so we can check its answers.` : `${label}: ${rows.length} patients checked. Your file stays in your browser.`;
    $("sample").hidden = isSample;
    $("tiles").innerHTML = ["likely", "possible", "unlikely"].map((v) => `<button class="tile ${v}" data-v="${v}" aria-pressed="${filter === v}">
      <span class="chip ${v}">${VERDICT[v].short}</span><div class="big-num" style="margin-top:8px">${count(v)}</div><div class="t">${v === "likely" ? "Test these first" : v === "possible" ? "Test at next visit" : "No extra test now"}</div></button>`).join("");

    const likely = rows.filter((r) => r.v === "likely"), skip = rows.filter((r) => r.v !== "unlikely" && r.usualSkip).length;
    const lowUnlikely = rows.filter((r) => r.v === "unlikely" && r.lowEgfr).length, outside = rows.filter((r) => !inScope(r.p)).length;
    let second;
    if (isSample) {
      const has = (r) => RESULTS[r.p.id] >= 30, n = likely.length, found = likely.filter(has).length;
      const dm = rows.filter((r) => r.hasDm), nd = rows.filter((r) => !r.hasDm);
      const rate = (a) => (a.length ? a.filter(has).length / a.length : 0);
      const dmFirst = n <= dm.length ? n * rate(dm) : dm.filter(has).length + (n - dm.length) * rate(nd);
      second = `<div class="card"><div class="eyebrow">Checked against real results</div><h3>${found} of these ${n} really had kidney damage</h3>
        <p class="muted" style="margin:0">We know these patients' real urine results. Testing ${n} people with diabetes first would have found about <b>${r0(dmFirst)}</b>.</p></div>`;
    } else {
      const fixes = loaded.patients.reduce((s, p) => s + p.issues.filter((i) => i.kind === "unit").length, 0);
      const odd = loaded.patients.reduce((s, p) => s + p.issues.filter((i) => i.kind === "implausible").length, 0);
      second = `<div class="card"><div class="eyebrow">Your file</div><h3>Read ${loaded.patients.length} patients</h3><ul class="clean">
        <li>${fixes} values were in other units and converted (for example creatinine in µmol/L).</li>
        <li>${odd} values were impossible (for example a blood pressure of 1400) and ignored.</li>
        ${skipped ? `<li>${skipped} rows had no age or sex and were skipped.</li>` : ""}
        ${outside ? `<li><b>${outside}</b> patients show no diabetes or high blood pressure, or are under 20. SilentCKD wasn't built for them, so treat their answers with caution.</li>` : ""}</ul></div>`;
    }
    $("clinic-insight").innerHTML = `<div class="card"><div class="eyebrow">Where to start</div><h3>Start with the ${likely.length} Likely patients</h3>
      <p style="margin:0 0 12px">Then look at the <b>${skip}</b> Likely or Possible patients with no diabetes and a normal kidney blood test. Usual practice would probably not test them.</p>
      ${lowUnlikely ? `<p style="margin:0 0 12px"><b>${lowUnlikely}</b> Unlikely ${lowUnlikely === 1 ? "patient has" : "patients have"} a low kidney blood test and still ${lowUnlikely === 1 ? "needs" : "need"} a doctor's review.</p>` : ""}
      <button class="btn ghost sm" id="show-missed">${filter === "missed" ? "Show everyone" : `Show these ${skip} patients`}</button></div>${second}`;

    const list = rows.map((r, i) => ({ ...r, rank: i + 1, ref: r })).filter((r) => filter === "all" || r.v === filter || (filter === "missed" && r.v !== "unlikely" && r.usualSkip));
    $("tbody").innerHTML = list.slice(0, shown).map((r) => {
      const v = r.p.values;
      return `<tr data-i="${r.rank - 1}"><td class="muted">${r.rank}</td><td><b>${esc(r.p.id)}</b> ${r.usualSkip && r.v !== "unlikely" ? `<span class="nodm" title="No diabetes and normal kidney blood test">Usually missed</span>` : r.lowEgfr ? `<span class="known" title="Kidney blood test is already low">Low kidney test</span>` : ""}</td>
        <td class="hide-sm">${v.age ?? ""}, ${v.sex === 1 ? "F" : "M"}</td><td><span class="chip ${r.v}">${VERDICT[r.v].short}</span></td>
        <td class="ch"><b>${r0(r.risk * 100)}</b><span class="muted"> in 100</span></td><td class="hide-sm">${esc(mainReason(r.ref))}</td></tr>`;
    }).join("");
    $("more").hidden = list.length <= shown;
    const what = filter === "all" ? `all ${list.length} patients` : filter === "missed" ? `the ${list.length} usually missed patients` : `the ${list.length} ${VERDICT[filter].short} patients`;
    $("list-guide").innerHTML = `Showing <b>${what}</b>, highest chance first. ${filter === "all" ? "Click a coloured box above to show one group." : `<button class="linkish" id="show-all">Show everyone</button>.`} Click a patient to see why. A <b>green bar</b> means inside your test plan. <b>Usually missed</b> means no diabetes and a normal kidney blood test.`;
    markPlan();
  }

  // ---------- test planner
  function capacity() { return clinic ? Math.min(+$("plan-n").value || 0, clinic.rows.length) : 0; }
  function markPlan() {
    const n = capacity();
    document.querySelectorAll("#tbody tr").forEach((tr) => tr.classList.toggle("in-plan", +tr.dataset.i < n));
  }
  function paintPlan() {
    const { rows } = clinic, n = capacity(), cost = Math.max(0, +$("plan-cost").value || 0);
    const sum = (a) => a.reduce((s, r) => s + r.risk, 0);
    const dm = rows.filter((r) => r.hasDm), other = rows.filter((r) => !r.hasDm);
    const mean = (a) => (a.length ? sum(a) / a.length : 0);
    const found = sum(rows.slice(0, n));
    const usual = n <= dm.length ? n * mean(dm) : sum(dm) + (n - dm.length) * mean(other);
    const extra = found - usual, money = (v) => "$" + Math.round(v).toLocaleString("en-US");
    $("plan-n-label").textContent = `${n} tests, for ${r0(n / rows.length * 100)}% of this clinic`;
    $("plan-out").innerHTML = [
      [`${r0(found)}`, `people with kidney damage expected if you test the top ${n} on this list`],
      [`${r0(usual)}`, `expected if you spend the same ${n} tests on people with diabetes first`],
      [`${money(cost * n)}`, found >= 1 ? `in total, about <b>${money(cost * n / found)}</b> for each person found.` : "in total."],
    ].map(([a, b]) => `<div class="stat"><div class="big-num">${a}</div><p style="margin:6px 0 0">${b}</p></div>`).join("");
    const extraText = r0(extra) > 0 ? `That is about <b>${r0(extra)} more people found</b> with the same tests.` : "Here the list finds about the same number as testing diabetes first.";
    let realText = "";
    if (clinic.isSample) {
      const has = (r) => RESULTS[r.p.id] >= 30, rate = (a) => (a.length ? a.filter(has).length / a.length : 0);
      const realFound = rows.slice(0, n).filter(has).length, realUsual = n <= dm.length ? n * rate(dm) : dm.filter(has).length + (n - dm.length) * rate(other);
      realText = ` <b>Checked against their real urine results:</b> the top ${n} really included ${realFound} people with kidney damage, and diabetes first would have found about ${r0(realUsual)}.`;
    }
    $("plan-note").innerHTML = `${extraText} These figures are estimates added up from each patient's chance.${realText} The patients to test get a green bar in the list below.`;
    markPlan();
  }
  function setupPlan() {
    const n = clinic.rows.length, slider = $("plan-n");
    slider.max = n; slider.value = Math.max(1, Math.round(n * 0.2));
    paintPlan();
  }
  $("plan-n").addEventListener("input", paintPlan);
  $("plan-cost").addEventListener("input", paintPlan);

  async function runHealthRecords(texts, label) {
    const msg = $("clinic-msg");
    let loaded;
    try { loaded = window.SilentFhir.load(texts); }
    catch (e) {
      msg.hidden = false;
      msg.innerHTML = `<b>We couldn't read "${esc(label)}".</b> It doesn't look like a FHIR health-record export.`;
      return;
    }
    const s = loaded.skipped, left = [
      s.not_target && `${s.not_target} with neither diabetes nor high blood pressure`,
      s.under_20 && `${s.under_20} under 20`, s.deceased && `${s.deceased} who had died`, s.no_age_or_sex && `${s.no_age_or_sex} with no age or sex`,
    ].filter(Boolean);
    msg.hidden = false;
    if (!loaded.patients.length) {
      msg.innerHTML = `<b>No eligible patients in "${esc(label)}".</b> We read ${loaded.read} patient records. ${left.length ? `Left out: ${left.join(", ")}.` : ""}`;
      return;
    }
    msg.innerHTML = `<b>Read ${loaded.read} patient records and checked ${loaded.patients.length}.</b> ${left.length ? `Left out: ${left.join(", ")}.` : ""}`;
    runClinic(loaded, label, false);
  }
  $("tiles").addEventListener("click", (ev) => { const t = ev.target.closest(".tile"); if (!t) return; filter = filter === t.dataset.v ? "all" : t.dataset.v; shown = 50; renderClinic(); });
  $("list-guide").addEventListener("click", (ev) => { if (ev.target.id !== "show-all") return; filter = "all"; shown = 50; renderClinic(); });
  $("clinic-insight").addEventListener("click", (ev) => { if (ev.target.id !== "show-missed") return; filter = filter === "missed" ? "all" : "missed"; shown = 50; renderClinic(); });
  $("more").addEventListener("click", () => { shown += 50; renderClinic(); });
  $("tbody").addEventListener("click", (ev) => { const tr = ev.target.closest("tr"); if (!tr) return; loadPatient(clinic.rows[+tr.dataset.i].p); $("back-clinic").hidden = false; go("check"); });
  $("sample").addEventListener("click", () => { $("clinic-msg").hidden = true; runClinic(clinicSample, "Sample clinic", true); });
  $("upload").addEventListener("change", async (ev) => {
    const files = [...ev.target.files]; if (!files.length) return;
    const texts = await Promise.all(files.map((f) => f.text()));
    const file = files[0], msg = $("clinic-msg");
    const isRecord = (f, t) => /\.(json|ndjson)$/i.test(f.name) || /^\s*[{[]/.test(t);
    if (files.some((f, i) => isRecord(f, texts[i]))) {
      if (!files.every((f, i) => isRecord(f, texts[i]))) {
        msg.hidden = false; msg.innerHTML = "<b>Please upload either one CSV list or health-record files, not both.</b>"; ev.target.value = ""; return;
      }
      await runHealthRecords(texts, files.length === 1 ? file.name : `${files.length} health-record files`);
      ev.target.value = ""; return;
    }
    if (files.length > 1) { msg.hidden = false; msg.innerHTML = "<b>Please upload one CSV list at a time.</b>"; ev.target.value = ""; return; }
    const loaded = E.loadClinic(texts[0]);
    if (loaded.map.age < 0 || loaded.map.sex < 0) {
      msg.hidden = false;
      msg.innerHTML = `<b>We couldn't find an age or sex column in "${esc(file.name)}".</b> Those two are required. Check the column names, or download the sample file below as a template.`;
      ev.target.value = ""; return;
    }
    const keyMissing = ["systolic_bp", "creatinine_mg_dl", "hba1c_percent", "diagnosed_diabetes"].filter((k) => loaded.map[k] < 0)
      .map((k) => ({ systolic_bp: "blood pressure", creatinine_mg_dl: "creatinine", hba1c_percent: "HbA1c", diagnosed_diabetes: "diabetes" }[k]));
    msg.hidden = !keyMissing.length;
    if (keyMissing.length) msg.innerHTML = `Your file has no column for <b>${keyMissing.join(", ")}</b>. Answers will still work but will be less reliable.`;
    runClinic(loaded, file.name, false);
    ev.target.value = "";
  });
  $("download").addEventListener("click", () => {
    const planned = capacity();
    const lines = [["rank", "patient_id", "test_now", "answer", "chance_in_100", "usually_missed", "low_kidney_blood_test", "main_reason"].join(",")];
    clinic.rows.forEach((r, i) => lines.push([i + 1, r.p.id, i < planned ? "yes" : "no", VERDICT[r.v].short, r0(r.risk * 100), r.usualSkip && r.v !== "unlikely" ? "yes" : "no", r.lowEgfr ? "yes" : "no", `"${mainReason(r).replace(/"/g, "'")}"`].join(",")));
    saveFile("silentckd_test_list.csv", lines.join("\n"));
  });
  $("template").addEventListener("click", () => saveFile("silentckd_template.csv", clinicText));
  $("fhir-sample").addEventListener("click", async () => {
    const text = await fetch("data/sample_health_records.json").then((r) => r.text());
    await runHealthRecords([text], "Sample health records (computer-generated)");
  });

  async function saveDoc(path, name) { await saveFile(name, await fetch(path).then((r) => r.text())); }
  $("dl-card").addEventListener("click", () => saveDoc("docs/model_card.md", "silentckd_model_card.md"));
  $("dl-report").addEventListener("click", () => saveDoc("docs/validation_report.md", "silentckd_validation_report.md"));
  $("dl-related").addEventListener("click", () => saveDoc("docs/related_work.md", "silentckd_related_work.md"));
  $("dl-plan").addEventListener("click", () => saveDoc("docs/deployment_plan.md", "silentckd_deployment_plan.md"));

  // In claude.ai the viewer must confirm each file; elsewhere a normal browser download is used.
  let downloads;
  async function saveFile(name, text) {
    if (downloads === undefined) downloads = window.claude && window.claude.use ? await window.claude.use("downloads").catch(() => null) : null;
    if (downloads) {
      try { await downloads.save({ filename: name, data: text }); } catch (e) { /* declined or unavailable: nothing to do */ }
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  runClinic(clinicSample, "Sample clinic", true);

  // ---------- accurate and fair?
  const cap = M.metrics.capacity, at = (arr, t) => arr.find((r) => r.tested_pct === t).found_pct;
  const LB = SUMMARY.bands.likely, MG = SUMMARY.missed_group, YG = SUMMARY.young;
  $("trust-tiles").innerHTML = [
    [`${SUMMARY.overall_caught} <small>in 100</small>`, `people with kidney damage get a Likely or Possible answer. To do that, it flags ${SUMMARY.overall_flagged} in 100 of all patients.`],
    [`${r0(at(cap.model, 20))} <small>vs ${r0(at(cap.guideline, 20))}</small>`, "of every 100 people with kidney damage are found when a clinic can test only 1 in 5 patients, compared with testing diabetes first."],
    ["3 <small>in 4</small>", "Take one person with kidney damage and one without. Three times in four, it gives the higher chance to the right one."],
    [`${LB.have} <small>vs ${LB.mean_pred}</small>`, `Its chances are honest. For Likely patients it predicted ${LB.mean_pred} in 100 on average, and ${LB.have} in 100 really had damage.`],
  ].map(([n, t]) => `<div class="card stat"><div class="big-num">${n}</div><p>${t}</p></div>`).join("");
  $("missed-card").innerHTML = `<div class="eyebrow">The patients it is built for</div>
    <h3>No diabetes and a normal kidney blood test</h3>
    <p>They make up ${MG.share_of_all_cases} in 100 of everyone with kidney damage, and they are the least likely to be tested. This is the hardest group to spot.</p>
    <div class="grid g3" style="margin-top:12px">
      <div class="stat"><div class="big-num">${MG.caught} <small>in 100</small></div><p>of those with kidney damage are caught, against ${SUMMARY.overall_caught} in 100 overall.</p></div>
      <div class="stat"><div class="big-num">${MG.right_when_flagged} <small>vs ${MG.base_rate}</small></div><p>really have damage when flagged, against ${MG.base_rate} in 100 if you tested this group at random.</p></div>
      <div class="stat"><div class="big-num">${r0(MG.auroc * 100)} <small>in 100</small></div><p>pairs ranked correctly (one person with damage, one without), against 75 in 100 overall.</p></div>
    </div>
    <p style="margin:14px 0 0">Most <b>Likely</b> answers still go to people with diabetes or a low blood test. These patients mostly appear as <b>Possible</b>: only ${SUMMARY.likely_makeup.usually_missed} in 100 Likely answers are from this group.</p>`;
  $("bands").innerHTML = ["likely", "possible", "unlikely"].map((v) => {
    const b = SUMMARY.bands[v];
    return `<div class="bandrow ${v}">${dots(b.have)}<div><span class="chip ${v}">${VERDICT[v].short}</span>
      <p style="margin:8px 0 0"><b>${b.have} in 100</b> really had kidney damage.</p>
      <p class="muted" style="margin:2px 0 0">${b.share} in 100 patients got this answer.${v === "unlikely" ? ` That's well below the average of ${SUMMARY.prevalence} in 100, but not zero, so it isn't a guarantee.` : ""}</p></div></div>`;
  }).join("");
  $("capacity").innerHTML = [[10, "1 in 10 patients"], [20, "1 in 5 patients"], [30, "3 in 10 patients"], [50, "half of patients"]].map(([t, lab]) => `
    <div class="grp">Test ${lab}</div>
    <div class="b"><span>SilentCKD</span><div class="track"><div class="fill" style="width:${at(cap.model, t)}%"></div></div><span class="num">${r0(at(cap.model, t))}</span></div>
    <div class="b"><span>Diabetes first</span><div class="track"><div class="fill alt" style="width:${at(cap.guideline, t)}%"></div></div><span class="num">${r0(at(cap.guideline, t))}</span></div>`).join("");
  let lastDim = "";
  $("fair").innerHTML = `<div class="b f4 hdr"><span></span><span></span><span>Caught</span><span class="hide-sm">Range</span><span>False alarms</span></div>` + SUMMARY.fairness.map((f) => {
    const head = f.dim !== lastDim ? `<div class="grp">${f.dim}</div>` : ""; lastDim = f.dim;
    return `${head}<div class="b f4"><span>${f.group}</span><div class="track"><div class="fill" style="width:${f.caught}%"></div></div><span class="num">${f.caught}</span><span class="rng hide-sm">${f.ci[0]}–${f.ci[1]}</span><span class="num alarm">${f.false_alarm}</span></div>`;
  }).join("");
  $("young-card").innerHTML = `<h3>Lower bar for under 45s</h3><p class="muted">With one bar for everyone it caught only <b>${YG.before} in 100</b> people with kidney damage aged 20–44. With a lower bar it catches <b>${YG.after} in 100</b>, though from just ${YG.cases} cases. The cost is more false alarms at that age.</p>`;


  const X = M.external, LK = X.locked_test, OC = X.outcomes, CL = OC.no_detectable_kidney_disease_today;
  const row = (label, a, b) => `<div class="evidence-row"><span>${label}</span><span class="r">${a}</span><b>${b}</b></div>`;
  $("locked-card").innerHTML = `<div class="eyebrow">A second, stricter test</div>
    <h3>Tested again on ${LK.n.toLocaleString("en-US")} people from 2007–2010</h3>
    <p>After seeing the 2021–23 results we simplified the answer rules, which can flatter those results. So we froze the model and every rule, then tested people from an earlier survey who had never been used for anything. Nothing was changed afterwards.</p>
    <div class="evidence-row head"><span></span><span class="r">2021–23</span><span class="r">2007–10</span></div>
    ${row("Of 100 Likely answers, how many really had damage", SUMMARY.bands.likely.have, LK.bands.likely.have)}
    ${row("Of 100 people with kidney damage, how many were caught", SUMMARY.overall_caught, LK.caught)}
    ${row("Of 100 people with kidney damage, how many were found when testing 1 in 5", r0(at(cap.model, 20)), LK.found_testing_1_in_5.silentckd)}
    ${row("The same, testing diabetes first", r0(at(cap.guideline, 20)), LK.found_testing_1_in_5.diabetes_first)}
    <p style="margin:14px 0 0"><b>The results held up,</b> so the rules weren't just tuned to fit one group. Both tests are US survey data, though, so a real hospital's patients could still differ.</p>`;
  const P10 = OC.ten_year_death_percent;
  $("outcomes-card").innerHTML = `<div class="eyebrow">What happened next</div>
    <h3>Do these answers matter 10 years later?</h3>
    <p>We followed the 2007–2010 patients through national death records to 2019. Out of every 100 people, how many died within 10 years:</p>
    <div class="grid g3" style="margin-top:10px">
      ${["likely", "possible", "unlikely"].map((v) => `<div class="stat"><span class="chip ${v}">${VERDICT[v].short}</span><div class="big-num" style="margin-top:8px">${P10[v]} <small>in 100</small></div></div>`).join("")}
    </div>
    <p style="margin:16px 0 0">Part of that is age, because older people get higher scores. After allowing for age and sex, Likely patients still had <b>${OC.by_answer_age_sex.likely.hr.toFixed(1)} times</b> the risk of dying compared with Unlikely patients.</p>
    <p style="margin:12px 0 0"><b>The patients who matter most:</b> among people whose urine and kidney blood tests were both normal that day, those SilentCKD flagged (Likely or Possible) were <b>${CL.heart_kidney_metabolic.flagged_vs_unlikely_age_sex.hr.toFixed(1)} times</b> as likely as the rest to die of heart disease, stroke, diabetes or kidney disease, after allowing for age and sex.</p>
    <div class="note" style="margin-top:14px"><b>What this doesn't prove:</b> death is not the same as developing kidney disease. Only ${OC.kidney_deaths} deaths were from kidney disease, too few to say anything specific about kidneys. The score is partly a general-health warning.</div>`;
  const RB = X.robustness, SHORT_NAME = ["Clean research data", "Many tests missing", "Rounded blood pressure, noisy labs", "15% of diagnoses and medicines unrecorded", "All of these at once"];
  $("messy-card").innerHTML = `<div class="eyebrow">Real records are messier</div>
    <h3>Would it still work on messy records?</h3>
    <p>Hospital records have gaps, rounded numbers and missing diagnoses. We damaged the 2021–23 data in those ways on purpose, then measured it again. All figures are out of 100.</p>
    <div class="messy-row head" style="margin-top:12px"><span></span><span class="r">Pairs right</span><span class="r">Caught</span><span class="r">Flagged</span></div>
    ${RB.map((r, i) => `<div class="messy-row"><span>${SHORT_NAME[i]}</span><b>${r0(r.auroc * 100)}</b><span class="r">${r.caught}</span><span class="r">${r.flagged}</span></div>`).join("")}
    <p style="margin:14px 0 0"><b>Pairs right</b> is the fairest measure, and it barely moved. With many tests missing it catches a few more people only because it flags more of them, so there are more false alarms. Its average prediction stayed honest (${RB[4].mean_pred} predicted, ${RB[4].observed} real). This was a simulation, not a test on real hospital records.</p>`;

  $("home-proof").innerHTML = [
    [`${r0(at(cap.model, 20))} <small>vs ${r0(at(cap.guideline, 20))}</small>`, "of every 100 people with kidney damage are found when a clinic can test only 1 in 5 patients, compared with testing diabetes first."],
    [`${LK.bands.likely.have} <small>in 100</small>`, `Likely answers were right on a second group of ${LK.n.toLocaleString("en-US")} people, with every rule frozen first.`],
    [`${P10.likely} <small>vs ${P10.unlikely}</small>`, "died within 10 years, per 100 Likely and Unlikely patients. Part of that is age, and it isn't proof of predicting new kidney disease."],
  ].map(([n, t]) => `<div class="card stat"><div class="big-num">${n}</div><p>${t}</p></div>`).join("");

  // ---------- navigation
  const VIEWS = ["home", "check", "clinic", "trust"];
  function go(name) { if (location.hash !== "#" + name) location.hash = name; else show(name); }
  function show(name) {
    if (!VIEWS.includes(name)) name = "home";
    VIEWS.forEach((v) => $("view-" + v).classList.toggle("on", v === name));
    document.querySelectorAll("nav button").forEach((b) => (b.dataset.go === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
    window.scrollTo(0, 0);
  }
  document.addEventListener("click", (ev) => { const b = ev.target.closest("[data-go]"); if (b) { ev.preventDefault(); go(b.dataset.go); } });
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));
  loadPatient(byId[EXAMPLES[0].id]);
  show(location.hash.slice(1) || "home");
})();
