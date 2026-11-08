"""Pattern analytics for the SilentCKD website. Run after train.py.

Produces demo/data/patterns.json with:
  - risk profiles: KMeans on per-patient SHAP vectors ("why" each patient scored as they did)
  - a quantised reference sample for "people like you" nearest-neighbour lookups and the
    unusual-patient (out-of-distribution) threshold
  - top SHAP interaction pairs for the "risk factors that compound" view
  - training baselines for drift and data-quality checks
  - headline pattern statistics (missed by usual practice, care gaps, equity)
and the sample clinic files demo/data/sample_clinic*.csv + sample_results.csv.
"""
import json
import numpy as np
import pandas as pd
import xgboost as xgb
from pathlib import Path
from sklearn.cluster import KMeans
from sklearn.neighbors import NearestNeighbors

from train import FEATURES, ROOT

WEB = ROOT / "demo" / "data"
SEED = 7
K_PROFILES = 6
KNN_FEATURES = ["age", "female", "sbp", "dbp", "bmi", "has_diabetes", "diabetes_years", "hba1c", "egfr",
                "cvd_history", "bp_meds", "current_smoker"]
KNN_K = 100
QUANT = 25  # z-scores stored as round(z * QUANT) integers

PROFILE_TEXT = {
    "Advanced kidney decline": {
        "key": "advanced", "summary": "Kidney function is already well below normal on the blood test.",
        "patient": "Your blood test shows your kidneys are filtering much less than they should. A urine test tells your care team how much damage there is and which treatments will help most.",
        "clinic": "Confirm CKD on the problem list, order ACR, review nephrology referral and medication doses."},
    "Ageing kidneys": {
        "key": "ageing", "summary": "Older adults whose eGFR has drifted below 60, often with heart disease.",
        "patient": "Kidney function naturally declines with age, and yours is lower than average. A urine test shows whether there is also early damage that treatment can slow.",
        "clinic": "Order ACR alongside the annual review. Check BP targets and medicines cleared by the kidney."},
    "Blood-sugar driven": {
        "key": "sugar", "summary": "Diabetes with high HbA1c is the main reason for the risk.",
        "patient": "High blood sugar over time can damage the small filters in the kidneys. A urine test can find this early, while better sugar control and kidney-protecting medicines work best.",
        "clinic": "Order ACR with the next HbA1c. A positive result supports SGLT2 inhibitor and ACE inhibitor or ARB discussions."},
    "Blood-pressure driven": {
        "key": "pressure", "summary": "Systolic blood pressure well above target is the main reason.",
        "patient": "High blood pressure strains the kidneys' blood vessels. A urine test shows whether that strain has started to cause damage, and helps your doctor choose blood pressure medicines that also protect the kidneys.",
        "clinic": "Order ACR and review BP control. If albuminuria is confirmed, prefer an ACE inhibitor or ARB."},
    "Borderline blood pressure": {
        "key": "borderline", "summary": "Mildly raised blood pressure with otherwise reassuring results.",
        "patient": "Your risk is a little above average, mostly from blood pressure. A routine yearly urine test is enough unless your doctor advises otherwise.",
        "clinic": "Routine yearly ACR. Reinforce BP and lifestyle targets."},
    "Well-controlled": {
        "key": "controlled", "summary": "Blood pressure and blood sugar are near target.",
        "patient": "Your blood pressure and blood sugar are well controlled, which protects your kidneys. Keep up the yearly urine test that guidelines recommend.",
        "clinic": "Routine yearly ACR."},
}


def name_profiles(df, labels, p):
    stats = []
    for c in range(K_PROFILES):
        m = labels == c
        stats.append(dict(c=c, egfr=df.egfr[m].median(), hba1c=df.hba1c[m].median(), sbp=df.sbp[m].median(), risk=p[m].mean()))
    names = {}
    for s in stats:
        if s["egfr"] < 35:
            names[s["c"]] = "Advanced kidney decline"
        elif s["egfr"] < 60:
            names[s["c"]] = "Ageing kidneys"
        elif s["hba1c"] >= 7.5:
            names[s["c"]] = "Blood-sugar driven"
        elif s["sbp"] >= 150:
            names[s["c"]] = "Blood-pressure driven"
    rest = sorted([s for s in stats if s["c"] not in names], key=lambda s: -s["risk"])
    for s, n in zip(rest, ["Borderline blood pressure", "Well-controlled"]):
        names[s["c"]] = n
    assert len(set(names.values())) == K_PROFILES, names
    return names


def main():
    df = pd.read_csv(ROOT / "data" / "cohort.csv")
    dev_mask = (df.cycle != "2021-2023").values
    b = xgb.Booster()
    b.load_model(str(ROOT / "models" / "silentckd_xgb.json"))
    D = xgb.DMatrix(df[FEATURES], feature_names=FEATURES)
    p = b.predict(D)
    S = b.predict(D, pred_contribs=True)[:, :-1]
    thr = json.loads((ROOT / "metrics" / "performance.json").read_text())["threshold"]

    # ---- risk profiles from explanation space
    km = KMeans(K_PROFILES, n_init=10, random_state=SEED).fit(S)
    names = name_profiles(df, km.labels_, p)
    order = sorted(range(K_PROFILES), key=lambda c: -p[km.labels_ == c].mean())
    profiles = []
    for c in order:
        m = km.labels_ == c
        mu = S[m].mean(0)
        top = [FEATURES[i] for i in np.argsort(-mu)[:3] if mu[i] > 0.02]
        profiles.append(dict(
            name=names[c], **PROFILE_TEXT[names[c]], centroid=[round(float(v), 5) for v in km.cluster_centers_[c]],
            n=int(m.sum()), share=float(m.mean()), mean_risk=float(p[m].mean()), prevalence=float(df.albuminuria[m].mean()),
            drivers=top, traits=dict(age=float(df.age[m].median()), sbp=float(df.sbp[m].median()), hba1c=float(df.hba1c[m].median()),
                                     egfr=float(df.egfr[m].median()), diabetes=float(df.has_diabetes[m].mean()),
                                     cvd=float(df.cvd_history[m].mean()), female=float(df.female[m].mean()),
                                     bp_meds=float(df.bp_meds[m].mean())),
            flagged_share=float((p[m] >= thr).mean())))

    # ---- "people like you" reference sample (development data only)
    dev = df[dev_mask].reset_index(drop=True)
    mu = dev[KNN_FEATURES].mean()
    sd = dev[KNN_FEATURES].std().replace(0, 1)
    Z = ((dev[KNN_FEATURES] - mu) / sd).fillna(0).clip(-5, 5)
    ref_idx = np.random.default_rng(SEED).choice(len(dev), 6000, replace=False)
    Q = np.round(Z.values[ref_idx] * QUANT).astype(int)
    ref_y = dev.albuminuria.values[ref_idx]
    nn = NearestNeighbors(n_neighbors=KNN_K + 1).fit(Q / QUANT)
    dist, _ = nn.kneighbors(Q[:1500] / QUANT)
    ood_stat = dist[:, 1:].mean(1)  # exclude self
    ood_threshold = float(np.percentile(ood_stat, 99))

    # ---- interaction pairs (SHAP interaction values, test sample)
    test = df[~dev_mask].reset_index(drop=True)
    samp = test.sample(1200, random_state=SEED)
    I = b.predict(xgb.DMatrix(samp[FEATURES], feature_names=FEATURES), pred_interactions=True)[:, :-1, :-1]
    mabs = np.abs(I).mean(0) * 2
    # restricted to risk factors a patient and clinician can recognise and discuss
    clinical = {FEATURES.index(f) for f in ["sbp", "dbp", "hba1c", "egfr", "diabetes_years", "has_diabetes", "cvd_history",
                                            "age", "bmi", "current_smoker"]}
    pairs = sorted([(mabs[i, j], i, j) for i in clinical for j in clinical if i < j], reverse=True)[:8]
    interactions = [dict(a=FEATURES[i], b=FEATURES[j], mean_abs=float(v)) for v, i, j in pairs]

    # ---- baselines for drift and data-quality checks
    baseline = {f: dict(mean=float(dev[f].mean()), sd=float(dev[f].std()), p01=float(dev[f].quantile(0.01)),
                        p99=float(dev[f].quantile(0.99)), median=float(dev[f].median())) for f in FEATURES}

    # ---- headline pattern statistics on the external test set
    pt = p[~dev_mask]
    usual_skip = (test.has_diabetes == 0) & (test.egfr >= 60)
    cases = test.albuminuria == 1
    flagged = pt >= thr
    gaps = care_gaps_frame(test)
    stats = {
        "missed_by_usual": dict(share_of_cases=float((cases & usual_skip).sum() / cases.sum()),
                                caught_by_model=float((cases & usual_skip & flagged).sum() / max((cases & usual_skip).sum(), 1)),
                                n_cases=int((cases & usual_skip).sum())),
        "care_gaps": {k: float(v.mean()) for k, v in gaps.items()},
        "care_gaps_any": float(pd.concat(gaps, axis=1).any(axis=1).mean()),
        "prevalence_by_income": prevalence_by(df, pd.cut(df.income_pir, [-1, 1.3, 3.5, 99], labels=["Low", "Middle", "High"])),
        "prevalence_by_race": prevalence_by(df, df.race_eth),
    }

    zq = ((test.loc[0, KNN_FEATURES] - mu) / sd).fillna(0).clip(-5, 5).values.astype(float)
    dq = np.sqrt(((Q / QUANT - zq) ** 2).sum(1))
    nearest = np.argsort(dq)[:KNN_K]
    knn_verify = dict(positives=int(ref_y[nearest].sum()), mean_dist=float(dq[nearest].mean()))

    out = dict(profiles=profiles, knn=dict(features=KNN_FEATURES, mean=mu.round(5).tolist(), sd=sd.round(5).tolist(), quant=QUANT,
                                           k=KNN_K, ref=Q.flatten().tolist(), y=ref_y.tolist(), ood_threshold=ood_threshold),
               interactions=interactions, baseline=baseline, stats=stats,
               verify=dict(x=[None if pd.isna(v) else float(v) for v in test.loc[0, FEATURES]],
                           profile=names[int(km.predict(S[np.where(~dev_mask)[0][:1]])[0])], knn=knn_verify))
    (WEB / "patterns.json").write_text(json.dumps(out, separators=(",", ":")))
    write_sample_clinic(test)

    for pr in profiles:
        print(f"{pr['name']:28s} n={pr['n']:5d} share={pr['share']:.2f} risk={pr['mean_risk']:.2f} prev={pr['prevalence']:.2f} drivers={pr['drivers']}")
    print("ood threshold", round(ood_threshold, 3))
    print("interactions", [(d["a"], d["b"], round(d["mean_abs"], 3)) for d in interactions])
    print(json.dumps(stats, indent=1))


def care_gaps_frame(d):
    """Rule-based care gaps; the same rules run in the browser (demo/engine.js)."""
    return {
        "bp_uncontrolled_untreated": ((d.sbp >= 140) | (d.dbp >= 90)) & (d.bp_meds == 0),
        "possible_undiagnosed_diabetes": (d.hba1c >= 6.5) & (d.dx_diabetes == 0),
        "diabetes_poor_control": (d.dx_diabetes == 1) & (d.hba1c >= 9),
        "ckd_unrecognised": (d.egfr < 60) & (d.told_kidney_disease != 1),
        "diabetes_no_statin": (d.has_diabetes == 1) & d.age.between(40, 75) & (d.chol_meds == 0),
        "smoker": d.current_smoker == 1,
    }


def prevalence_by(df, groups):
    g = pd.Series(np.asarray(groups, dtype=object), index=df.index)
    return {str(k): dict(n=int((g == k).sum()), prevalence=float(df.albuminuria[g == k].mean()))
            for k in g.dropna().unique() if str(k) != "nan"}


def write_sample_clinic(test):
    rng = np.random.default_rng(11)
    s = test.iloc[rng.choice(len(test), 400, replace=False)].reset_index(drop=True)
    ids = [f"C-{i + 1:04d}" for i in range(len(s))]
    clinic = pd.DataFrame({
        "patient_id": ids, "age": s.age.astype(int), "sex": np.where(s.female == 1, "F", "M"),
        "systolic_bp": s.sbp.round(0), "diastolic_bp": s.dbp.round(0), "bmi": s.bmi.round(1), "waist_cm": s.waist.round(1),
        "diagnosed_diabetes": s.dx_diabetes.astype(int), "diabetes_years": s.diabetes_years.round(0),
        "hba1c_percent": s.hba1c.round(1), "on_insulin": s.insulin.astype(int), "on_diabetes_pills": s.diabetes_pills.astype(int),
        "diagnosed_hypertension": s.dx_hypertension.astype(int), "on_bp_meds": s.bp_meds.astype(int),
        "high_cholesterol": s.dx_high_chol.astype(int), "on_cholesterol_meds": s.chol_meds.astype(int),
        "heart_disease_or_stroke": s.cvd_history.astype(int), "current_smoker": s.current_smoker.astype(int),
        "creatinine_mg_dl": s.scr.round(2), "uric_acid": s.uric_acid, "albumin_g_dl": s.serum_albumin, "bun": s.bun,
        "potassium": s.potassium, "triglycerides": s.triglycerides, "total_cholesterol": s.total_chol, "hdl": s.hdl,
        "told_kidney_disease": s.told_kidney_disease.fillna(0).astype(int),
    })
    clinic.to_csv(WEB / "sample_clinic.csv", index=False)
    pd.DataFrame({"patient_id": ids, "acr_mg_g": s.acr.round(1)}).to_csv(WEB / "sample_results.csv", index=False)

    # A deliberately messy export: renamed headers, mixed units, typos, a missing column
    messy = clinic.copy()
    r = rng.choice(len(messy), 18, replace=False)
    messy.loc[r, "creatinine_mg_dl"] = (messy.loc[r, "creatinine_mg_dl"] * 88.4).round(0)  # µmol/L
    r = rng.choice(len(messy), 10, replace=False)
    messy.loc[r, "hba1c_percent"] = ((messy.loc[r, "hba1c_percent"] - 2.15) * 10.929).round(0)  # mmol/mol
    r = rng.choice(len(messy), 4, replace=False)
    messy.loc[r, "systolic_bp"] = messy.loc[r, "systolic_bp"] * 10  # typo
    messy = messy.drop(columns=["waist_cm", "uric_acid"]).rename(columns={
        "patient_id": "MRN", "age": "Age (yrs)", "systolic_bp": "SBP", "diastolic_bp": "DBP", "hba1c_percent": "A1C",
        "creatinine_mg_dl": "Creat", "on_bp_meds": "Antihypertensive", "current_smoker": "Smoker"})
    messy.to_csv(WEB / "sample_clinic_messy.csv", index=False)


if __name__ == "__main__":
    main()
