"""Three checks that go beyond the 2021-23 test set.

1. Locked external test: the final models and answer rules, unchanged, on NHANES 2007-2010. Those cycles
   were not used to fit anything or to choose any rule.
2. Long-term outcomes: linked National Death Index follow-up through 2019 for the same people.
3. Messy-record test: the 2021-23 test set degraded to look like routine health records.

Run after answers.py. Writes metrics/external.json and adds "external" to demo/data/model.json.
"""
import json
import numpy as np
import pandas as pd
import xgboost as xgb
from lifelines import CoxPHFitter, KaplanMeierFitter
from sklearn.metrics import roc_auc_score

import prep
from answers import LABS, SHORT, short_frame
from train import FEATURES, MET, ROOT, WEB, calib, predict

RAW = ROOT / "data" / "raw"
EXTERNAL = ROOT / "data" / "cohort_external.csv"
HEART_KIDNEY_METABOLIC = [1, 5, 7, 9]  # heart disease, stroke, diabetes, kidney disease


def build_external():
    original_read = prep.read

    def read(name, cols):
        if name.startswith("DEMO"):
            df = original_read(name, cols + ["RIDRETH1"])
            df["RIDRETH3"] = df.RIDRETH1.replace(5, 7)  # the older race variable has no separate Asian group
            return df
        df = original_read(name, cols)
        if name.startswith("BPQ"):
            df = df.assign(**{c: np.nan for c in ["BPQ150", "BPQ101D"] if c not in df})  # names used only in later cycles
        return df

    prep.read = read
    prep.CYCLES = {"2007-2008": (lambda c: f"{c}_E", 2.0), "2009-2010": (lambda c: f"{c}_F", 2.0)}
    prep.OUT = EXTERNAL
    c = prep.build()
    prep.read = original_read
    return c


def mortality():
    frames = []
    for y in ["2007_2008", "2009_2010"]:
        frames.append(pd.read_fwf(RAW / f"NHANES_{y}_MORT_2019_PUBLIC.dat", header=None, na_values=["."],
                                  colspecs=[(0, 6), (14, 15), (15, 16), (16, 19), (45, 48)],
                                  names=["seqn", "eligstat", "mortstat", "ucod", "months"], dtype=float))
    return pd.concat(frames, ignore_index=True)


def score(df, full, short, bundle):
    rules = bundle["rules"]
    miss = df[LABS].isna().sum(axis=1).values
    use_short = miss > rules["max_missing_labs"]
    p = predict(full, df)
    if use_short.any():
        p[use_short] = predict(short, short_frame(df[use_short]))
    young = df.age.values < 45
    bar = np.where(use_short, np.where(young, bundle["short"]["young"], bundle["short"]["possible"]),
                   np.where(young, rules["young"], rules["possible"]))
    band = np.where(p >= rules["likely"], "likely", np.where(p >= bar, "possible", "unlikely"))
    return p, band, use_short


def pct(v):
    return round(float(v) * 100)


def locked_test(ext, p, band):
    y = ext.albuminuria.values
    flag = band != "unlikely"
    rng = np.random.default_rng(11)
    aucs = [roc_auc_score(y[i], p[i]) for i in (rng.integers(0, len(y), len(y)) for _ in range(1000))]
    intercept, slope = calib(y, p)
    dm = ext.has_diabetes.values == 1
    k = int(0.2 * len(y))
    top = np.argsort(-p)[:k]
    dm_first = (min(k, dm.sum()) * y[dm].mean() + max(0, k - dm.sum()) * y[~dm].mean()) / y.sum()
    groups = {"20–44": ext.age.values < 45, "45–64": (ext.age.values >= 45) & (ext.age.values < 65), "65+": ext.age.values >= 65,
              "Women": ext.female.values == 1, "Men": ext.female.values == 0,
              "Black": ext.race_eth.values == "Black", "White": ext.race_eth.values == "White", "Mexican American": ext.race_eth.values == "Mexican American",
              "Has diabetes": dm, "High blood pressure only": ~dm}
    return {
        "n": int(len(y)), "cases": int(y.sum()), "prevalence": pct(y.mean()), "auroc": round(float(roc_auc_score(y, p)), 3),
        "auroc_ci": [round(float(v), 3) for v in np.percentile(aucs, [2.5, 97.5])], "calibration_slope": round(slope, 2), "calibration_intercept": round(intercept, 2),
        "mean_pred": pct(p.mean()), "caught": pct(flag[y == 1].mean()), "flagged": pct(flag.mean()),
        "bands": {v: {"share": pct((band == v).mean()), "have": pct(y[band == v].mean()), "mean_pred": pct(p[band == v].mean())} for v in ["likely", "possible", "unlikely"]},
        "found_testing_1_in_5": {"silentckd": pct(y[top].sum() / y.sum()), "diabetes_first": pct(dm_first)},
        "groups": [{"group": g, "cases": int(y[m].sum()), "caught": pct(flag[m & (y == 1)].mean())} for g, m in groups.items()],
    }


def hr(d, covs, exposure):
    m = CoxPHFitter(penalizer=1e-4).fit(d[["t", "e"] + covs], "t", "e")
    s = m.summary.loc[exposure]
    return {"hr": round(float(s["exp(coef)"]), 2), "low": round(float(s["exp(coef) lower 95%"]), 2), "high": round(float(s["exp(coef) upper 95%"]), 2)}


def outcomes(ext, p, band):
    d = ext.assign(p=p, band=band).merge(mortality(), on="seqn", how="left")
    d = d[(d.eligstat == 1) & d.months.notna() & d.mortstat.notna()].copy()
    d["t"] = d.months.clip(lower=0.5) / 12
    d["logit"] = np.log(d.p / (1 - d.p))
    d["sd_score"] = (d.logit - d.logit.mean()) / d.logit.std()
    d["flagged"] = (d.band != "unlikely").astype(int)
    for v in ["likely", "possible"]:
        d[v] = (d.band == v).astype(int)
    d["age10"] = d.age / 10
    all_e = d.mortstat.values.astype(int)
    cause = (d.mortstat == 1) & d.ucod.isin(HEART_KIDNEY_METABOLIC)

    def km10(m, event):
        f = KaplanMeierFitter().fit(d.t[m], event[m])
        return pct(1 - f.predict(10))

    def block(m, event):
        x = d[m].assign(e=np.asarray(event)[m])
        return {"n": int(m.sum()), "events": int(x.e.sum()), "per_sd_age_sex": hr(x, ["sd_score", "age10", "female"], "sd_score"), "flagged_vs_unlikely_age_sex": hr(x, ["flagged", "age10", "female"], "flagged")}

    everyone = np.ones(len(d), bool)
    clean = (d.acr.values < 30)
    clean_kidneys = clean & (d.egfr.values >= 60)
    return {
        "n": int(len(d)), "deaths": int(all_e.sum()), "median_followup_years": round(float(d.t.median()), 1),
        "ten_year_death_percent": {v: km10((d.band == v).values, all_e) for v in ["likely", "possible", "unlikely"]},
        "by_answer_age_sex": {v: hr(d.assign(e=all_e), ["likely", "possible", "age10", "female"], v) for v in ["likely", "possible"]},
        "all_cause": block(everyone, all_e),
        "heart_kidney_metabolic": block(everyone, cause.astype(int).values),
        "urine_test_normal_today": {"all_cause": block(clean, all_e), "heart_kidney_metabolic": block(clean, cause.astype(int).values)},
        "no_detectable_kidney_disease_today": {"all_cause": block(clean_kidneys, all_e), "heart_kidney_metabolic": block(clean_kidneys, cause.astype(int).values),
                                               "ten_year_death_percent": {"flagged": km10(clean_kidneys & (d.flagged.values == 1), all_e), "unlikely": km10(clean_kidneys & (d.flagged.values == 0), all_e)}},
        "kidney_deaths": int(((d.mortstat == 1) & (d.ucod == 9)).sum()),
    }


def degrade(t, kind, rng):
    d = t.copy()
    n = len(d)
    if kind in ("missing", "all"):
        d["waist"] = np.nan
        for f, keep in [("uric_acid", .25), ("serum_albumin", .55), ("bun", .6), ("potassium", .6), ("triglycerides", .5), ("total_chol", .55), ("hdl", .5), ("bmi", .8)]:
            d.loc[rng.random(n) > keep, f] = np.nan
        no_dm = d.has_diabetes.values != 1
        d.loc[no_dm & (rng.random(n) > .4), "hba1c"] = np.nan
    if kind in ("noise", "all"):
        d["sbp"] = (d.sbp + rng.normal(0, 8, n)).round(-1)
        d["dbp"] = (d.dbp + rng.normal(0, 5, n)).round(-1)
        d["hba1c"] = d.hba1c + rng.normal(0, .15, n)
        d["egfr"] = d.egfr * np.exp(rng.normal(0, .07, n))
    if kind in ("underrecorded", "all"):
        for f in ["dx_hypertension", "bp_meds", "dx_high_chol", "chol_meds", "cvd_history", "current_smoker"]:
            d.loc[(d[f] == 1) & (rng.random(n) < .15), f] = 0
        d.loc[(d.diabetes_years > 0) & (rng.random(n) < .4), "diabetes_years"] = np.nan
    return d


def robustness(test, full, short, bundle):
    y = test.albuminuria.values
    out = []
    for kind, label in [("none", "Clean research data"), ("missing", "Many tests missing, as in routine care"), ("noise", "Single rounded BP, noisier labs"), ("underrecorded", "15% of diagnoses and medicines not recorded"), ("all", "All of the above together")]:
        rows = []
        for seed in range(10 if kind != "none" else 1):
            d = degrade(test, kind, np.random.default_rng(seed))
            p, band, use_short = score(d, full, short, bundle)
            flag = band != "unlikely"
            rows.append((roc_auc_score(y, p), p.mean(), flag[y == 1].mean(), flag.mean(), use_short.mean()))
        a = np.mean(rows, axis=0)
        out.append({"scenario": label, "auroc": round(float(a[0]), 3), "mean_pred": pct(a[1]), "observed": pct(y.mean()), "caught": pct(a[2]), "flagged": pct(a[3]), "short_model_share": pct(a[4])})
    return out


def main():
    ext = build_external().reset_index(drop=True)
    bundle = json.loads((WEB / "model.json").read_text())
    full, short = xgb.Booster(), xgb.Booster()
    full.load_model(str(ROOT / "models" / "silentckd_xgb.json"))
    short.load_model(str(ROOT / "models" / "silentckd_short_xgb.json"))
    p, band, use_short = score(ext, full, short, bundle)
    test = pd.read_csv(ROOT / "data" / "cohort.csv")
    test = test[test.cycle == "2021-2023"].reset_index(drop=True)
    result = {"locked_test": locked_test(ext, p, band), "short_model_share_external": pct(use_short.mean()), "outcomes": outcomes(ext, p, band), "robustness": robustness(test, full, short, bundle)}
    (MET / "external.json").write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    bundle["external"] = result
    (WEB / "model.json").write_text(json.dumps(bundle, separators=(",", ":")))
    print(json.dumps(result, indent=1, ensure_ascii=True))


if __name__ == "__main__":
    main()
