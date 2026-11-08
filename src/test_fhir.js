// Tests demo/fhir.js on an unzipped folder of Synthea FHIR bundles and rewrites demo/data/sample_health_records.json.
// Usage: node src/test_fhir.js <folder of Synthea .json files>
const fs = require("fs"), path = require("path");
const demo = path.join(__dirname, "..", "demo") + path.sep;
const S = require(demo + "model.js"), E = require(demo + "engine.js"), F = require(demo + "fhir.js");
const M = JSON.parse(fs.readFileSync(demo + "data/model.json", "utf8")); S.prepare(M); S.prepare(M.short);
const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f));
const texts = files.map((f) => fs.readFileSync(f, "utf8"));
const r = F.load(texts);
console.log("read", r.read, "kept", r.patients.length, JSON.stringify(r.skipped));
const fill = {};
for (const p of r.patients) for (const k in p.values) if (p.values[k] !== null && p.values[k] !== undefined) fill[k] = (fill[k] || 0) + 1;
console.log("filled", JSON.stringify(fill));
console.log("issues", r.patients.flatMap((p) => p.issues.map((i) => i.text)).slice(0, 8));
const counts = {}; let short = 0;
for (const p of r.patients) { const m = E.chooseModel(p, M), risk = S.risk(m.model, m.x), v = E.answer(risk, p.x[0], m, M); counts[v] = (counts[v] || 0) + 1; if (m.short) short++; }
console.log("answers", counts, "short model", short);
for (const p of r.patients.slice(0, 3)) console.log(JSON.stringify(p.values));

// trimmed sample: only what SilentCKD reads
const KEEP = /^(8480-6|8462-4|85354-9|4548-4|2160-0|38483-4|39156-5|8280-0|3084-1|1751-7|3094-0|6299-2|2823-3|6298-4|2571-8|2093-3|2085-9|72166-2)$/;
const keptIds = new Set(r.patients.slice(0, 40).map((p) => p.id.replace("Record ", "")));
const out = [];
const trimCode = (c) => c && ({ coding: (c.coding || []).slice(0, 1).map((x) => ({ code: x.code, display: x.display })) });
const USEFUL = /diabet|hypertens|hyperlipid|hypercholesterol|dyslipid|myocardial|coronary|heart failure|ischemic heart|ischaemic heart|stroke|cerebrovascular|angina|kidney|nephropathy|renal|insulin|metformin|glipizide|glimepiride|glyburide|sitagliptin|linagliptin|pioglitazone|gliflozin|pril|sartan|dipine|thiazide|chlorthalidone|indapamide|olol|statin|ezetimibe/i;
const useful = (c) => USEFUL.test(JSON.stringify(c || {}));
for (const t of texts) for (const res of F.resources(t)) {
  const id = res.resourceType === "Patient" ? res.id : (res.subject && res.subject.reference || "").replace(/^urn:uuid:|^Patient\//, "");
  if (![...keptIds].some((k) => String(id).startsWith(k))) continue;
  if (res.resourceType === "Patient") out.push({ resourceType: "Patient", id: res.id, gender: res.gender, birthDate: res.birthDate });
  if (res.resourceType === "Condition" && useful(res.code)) out.push({ resourceType: "Condition", subject: res.subject, code: trimCode(res.code), clinicalStatus: res.clinicalStatus, onsetDateTime: res.onsetDateTime, recordedDate: res.recordedDate });
  if (res.resourceType === "MedicationRequest" && res.status === "active" && useful(res.medicationCodeableConcept)) out.push({ resourceType: "MedicationRequest", subject: res.subject, status: res.status, authoredOn: res.authoredOn, medicationCodeableConcept: trimCode(res.medicationCodeableConcept) });
  if (res.resourceType === "Observation" && (res.code.coding || []).some((c) => KEEP.test(c.code))) out.push({ resourceType: "Observation", subject: res.subject, code: trimCode(res.code), effectiveDateTime: res.effectiveDateTime, valueQuantity: res.valueQuantity, valueCodeableConcept: trimCode(res.valueCodeableConcept), component: res.component });
}
const newest = new Map(); const rest = [];
for (const r of out) {
  if (r.resourceType !== "Observation") { rest.push(r); continue; }
  const k = r.subject.reference + "|" + r.code.coding[0].code, cur = newest.get(k);
  if (!cur || Date.parse(r.effectiveDateTime) > Date.parse(cur.effectiveDateTime)) newest.set(k, r);
}
const bundle = JSON.stringify({ resourceType: "Bundle", type: "collection", entry: [...rest, ...newest.values()].map((resource) => ({ resource })) });
fs.writeFileSync(demo + "data/sample_health_records.json", bundle);
const again = F.load([bundle]);
console.log("sample size KB", Math.round(bundle.length / 1024), "kept", again.patients.length, JSON.stringify(again.skipped));
// A difference can occur when a synthetic record holds two conflicting results at the same timestamp.
const differing = r.patients.filter((p, i) => JSON.stringify(p.values) !== JSON.stringify(again.patients[i].values)).length;
console.log("patients whose sample differs from the full records:", differing, "of", r.patients.length);
