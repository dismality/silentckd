"""Short-form model and the Likely / Possible / Unlikely answer rules used by the website.

The full model expects 25 inputs. When a user fills in only the short form, most of those are blank and the
full model over-predicts, so a second model is trained on the 11 short-form inputs. During training its inputs
are randomly blanked so it stays calibrated when a user leaves blood pressure, HbA1c or creatinine empty.

Run after train.py and patterns.py. Adds "short", "rules" and "summary" to demo/data/model.json.
"""
import json
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import roc_auc_score, roc_curve
from sklearn.model_selection import StratifiedKFold
from train import FEATURES, fit_xgb, predict, dump_trees, ROOT, WEB, MET, SEED

SHORT = ["age", "female", "sbp", "dbp", "has_diabetes", "diabetes_years", "hba1c", "bp_meds", "cvd_history", "current_smoker", "egfr"]
BLANKABLE = [["sbp", "dbp"], ["hba1c"], ["egfr"]]
LIKELY = 0.50  # a "Likely" answer should mean more likely than not
LABS = ["bmi", "waist", "uric_acid", "serum_albumin", "bun", "potassium", "triglycerides", "total_chol", "hdl"]


def short_frame(df):
    out = df.copy()
    for f in FEATURES:
        if f not in SHORT:
            out[f] = np.nan
    return out


def augment(df, rng, copies=2, p=0.35):
    parts = [df]
    for _ in range(copies):
        c = df.copy()
        for group in BLANKABLE:
            c.loc[rng.random(len(c)) < p, group] = np.nan
        parts.append(c)
    return pd.concat(parts, ignore_index=True)


def cutoff(y, p, sens=0.80):
    f, t, th = roc_curve(y, p)
    return float(th[np.argmax(t >= sens)])


def bands(p, possible, age, young):
    thr = np.where(np.asarray(age) < 45, young, possible)
    return np.where(p >= LIKELY, "likely", np.where(p >= thr, "possible", "unlikely"))


def ci(flags, rng, n=2000):
    s = [flags[rng.integers(0, len(flags), len(flags))].mean() for _ in range(n)]
    return [round(float(v) * 100) for v in np.percentile(s, [2.5, 97.5])]


def pct(v):
    return round(float(v) * 100)


def main():
    df = pd.read_csv(ROOT / "data" / "cohort.csv")
    dev = df[df.cycle != "2021-2023"].reset_index(drop=True)
    test = df[df.cycle == "2021-2023"].reset_index(drop=True)
    ydev, y = dev.albuminuria.values, test.albuminuria.values
    bundle = json.loads((WEB / "model.json").read_text())
    rng = np.random.default_rng(SEED)

    # short-form model: out-of-fold cut-offs on development data only
    sdev, stest = short_frame(dev), short_frame(test)
    oof = np.zeros(len(dev))
    for tr, va in StratifiedKFold(5, shuffle=True, random_state=SEED).split(sdev, ydev):
        a = augment(sdev.iloc[tr].reset_index(drop=True), rng)
        oof[va] = predict(fit_xgb(a, a.albuminuria), sdev.iloc[va])
    a = augment(sdev, rng)
    final = fit_xgb(a, a.albuminuria)
    s_possible = cutoff(ydev, oof)
    young_dev = dev.age.values < 45
    s_young = cutoff(ydev[young_dev], oof[young_dev])
    ps = predict(final, stest)

    # full model
    b = xgb.Booster()
    b.load_model(str(ROOT / "models" / "silentckd_xgb.json"))
    p = predict(b, test)
    f_possible, f_young = bundle["threshold"], bundle["age_thresholds"]["20-44"]
    band = bands(p, f_possible, test.age, f_young)
    flag = band != "unlikely"

    def report_short(frame, label):
        q = predict(final, frame)
        bd = bands(q, s_possible, test.age, s_young)
        return {"scenario": label, "auroc": round(float(roc_auc_score(y, q)), 3), "mean_pred": round(float(q.mean()), 3), "observed": round(float(y.mean()), 3),
                "likely_pred": round(float(q[bd == "likely"].mean()), 3), "likely_obs": round(float(y[bd == "likely"].mean()), 3), "likely_share": round(float((bd == "likely").mean()), 3)}

    scen = [report_short(stest, "all short-form fields")]
    for name, cols in [("no HbA1c", ["hba1c"]), ("no blood pressure", ["sbp", "dbp"]), ("no creatinine", ["egfr"]), ("age, sex and yes/no answers only", ["hba1c", "sbp", "dbp", "egfr"])]:
        c = stest.copy()
        c[cols] = np.nan
        scen.append(report_short(c, name))

    partial = test.copy()
    partial[["waist", "uric_acid"]] = np.nan
    pp = predict(b, partial)

    rule_rows = {}
    for v in ["likely", "possible", "unlikely"]:
        m = band == v
        rule_rows[v] = {"share": pct(m.mean()), "have": pct(y[m].mean()), "mean_pred": pct(p[m].mean()), "share_of_cases": pct(y[m].sum() / y.sum())}

    groups = {
        "Age": pd.cut(test.age, [0, 44, 64, 200], labels=["20–44", "45–64", "65+"]).astype(str).values,
        "Sex": np.where(test.female == 1, "Women", "Men"),
        "Ethnicity": test.race_eth.fillna("Unknown").astype(str).values,
        "Household income": pd.cut(test.income_pir, [-1, 1.3, 3.5, 99], labels=["Lower", "Middle", "Higher"]).astype(str).values,
        "Condition": np.where(test.has_diabetes == 1, "Has diabetes", "High blood pressure only"),
    }
    fair = []
    for dim, g in groups.items():
        g = pd.Series(np.asarray(g, dtype=object)).fillna("Unknown").astype(str).values
        for v in sorted(set(g)):
            if v in ("Unknown", "nan"):
                continue
            pos, neg = (g == v) & (y == 1), (g == v) & (y == 0)
            if pos.sum() < 25:
                continue
            fair.append({"dim": dim, "group": v.replace("Other/Multiracial", "Other / multiracial"), "cases": int(pos.sum()), "caught": pct(flag[pos].mean()), "ci": ci(flag[pos], rng),
                         "false_alarm": pct(flag[neg].mean()), "right_when_flagged": pct(y[(g == v) & flag].mean())})

    young_cases = (test.age.values < 45) & (y == 1)
    missed = (test.has_diabetes.values != 1) & (test.egfr.values >= 60)
    L = band == "likely"
    summary = {
        "n_test": int(len(test)), "prevalence": pct(y.mean()),
        "bands": rule_rows, "fairness": fair,
        "overall_caught": pct(flag[y == 1].mean()), "overall_flagged": pct(flag.mean()),
        "single_cutoff_caught": pct((p >= f_possible)[y == 1].mean()),
        "young": {"cases": int(young_cases.sum()), "before": pct((p >= f_possible)[young_cases].mean()), "after": pct(flag[young_cases].mean()), "ci": ci(flag[young_cases], rng)},
        "missed_group": {"n": int(missed.sum()), "cases": int(y[missed].sum()), "share_of_all_cases": pct(y[missed].sum() / y.sum()), "auroc": round(float(roc_auc_score(y[missed], p[missed])), 3),
                         "caught": pct(flag[missed & (y == 1)].mean()), "flagged": pct(flag[missed].mean()), "right_when_flagged": pct(y[missed & flag].mean()), "base_rate": pct(y[missed].mean())},
        "likely_makeup": {"egfr_below_60": pct((test.egfr[L] < 60).mean()), "has_diabetes": pct((test.has_diabetes[L] == 1).mean()), "told_kidney": pct((test.told_kidney_disease[L] == 1).mean()), "usually_missed": pct(missed[L].mean())},
        "tests_per_case": {"likely": round(float(L.sum() / y[L].sum()), 1), "likely_or_possible": round(float(flag.sum() / y[flag].sum()), 1), "everyone": round(float(len(y) / y.sum()), 1)},
        "short_model": {"auroc": scen[0]["auroc"], "scenarios": scen},
        "full_with_two_labs_missing": {"auroc": round(float(roc_auc_score(y, pp)), 3), "mean_pred": round(float(pp.mean()), 3)},
    }

    base = float(json.loads(final.save_config())["learner"]["learner_model_param"]["base_score"].strip("[]"))
    base_margin = float(np.log(base / (1 - base)))
    trees = dump_trees(final)

    bundle["short"] = {"inputs": SHORT, "features": FEATURES, "trees": trees, "possible": s_possible, "young": s_young,
                       "base_margin": base_margin,
                       "verify": [{"x": [None if pd.isna(v) else float(v) for v in stest.loc[i, FEATURES]], "p": float(ps[i])} for i in range(25)]}
    bundle["rules"] = {"likely": LIKELY, "possible": f_possible, "young": f_young, "labs": LABS, "max_missing_labs": 2}
    bundle["summary"] = summary
    (WEB / "model.json").write_text(json.dumps(bundle, separators=(",", ":")))
    (MET / "answer_summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding="utf-8")
    final.save_model(str(ROOT / "models" / "silentckd_short_xgb.json"))
    print(json.dumps(summary, indent=1))
    print("short cutoffs", s_possible, s_young, "base margin", base_margin)


if __name__ == "__main__":
    main()
