"""Compares SilentCKD with an approximation of the closest published model.

Chu et al. (JAMA Netw Open 2023) fitted a logistic regression to NHANES adults with hypertension or diabetes to
estimate albuminuria (ACR >=30 mg/g), using age, sex, race, ethnicity, systolic BP, eGFR, diabetes, coronary artery
disease and heart failure, with continuous variables as splines. The coefficients are not used here. This refits that
design on SilentCKD's development data. It is an approximation: coronary disease and heart failure are combined into
one heart-disease-or-stroke history field, and spline knots were chosen here.

Run after external.py. Writes metrics/published_comparison.json.
"""
import json
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import Pipeline, make_pipeline
from sklearn.preprocessing import OneHotEncoder, SplineTransformer

from external import EXTERNAL, score
from train import MET, ROOT, WEB, calib

CONTINUOUS = ["age", "sbp", "egfr"]
OTHER = ["female", "has_diabetes", "cvd_history"]


def design(df):
    d = df[CONTINUOUS + OTHER].copy()
    d["race_eth"] = pd.Series(np.asarray(df.race_eth, dtype=object), index=df.index).fillna("Unknown").astype(str)
    return d


def fit_baseline(dev):
    columns = ColumnTransformer([
        ("spline", make_pipeline(SimpleImputer(strategy="median"), SplineTransformer(n_knots=4, degree=3, include_bias=False)), CONTINUOUS),
        ("flag", SimpleImputer(strategy="most_frequent"), OTHER),
        ("race", OneHotEncoder(handle_unknown="ignore"), ["race_eth"]),
    ])
    return Pipeline([("x", columns), ("lr", LogisticRegression(max_iter=3000))]).fit(design(dev), dev.albuminuria.values)


def found_top_fifth(y, p):
    return float(y[np.argsort(-p)[:int(0.2 * len(y))]].sum() / y.sum())


def compare(y, ours, baseline, seed=7):
    rng = np.random.default_rng(seed)
    diffs = []
    for _ in range(1000):
        i = rng.integers(0, len(y), len(y))
        diffs.append(roc_auc_score(y[i], ours[i]) - roc_auc_score(y[i], baseline[i]))
    out = {"n": int(len(y)), "auroc_gain": round(float(roc_auc_score(y, ours) - roc_auc_score(y, baseline)), 3),
           "auroc_gain_ci": [round(float(v), 3) for v in np.percentile(diffs, [2.5, 97.5])]}
    for name, p in [("silentckd", ours), ("published_style", baseline)]:
        intercept, slope = calib(y, p)
        out[name] = {"auroc": round(float(roc_auc_score(y, p)), 3), "calibration_slope": round(float(slope), 2),
                     "mean_pred_percent": round(float(p.mean()) * 100, 1), "found_testing_1_in_5_percent": round(found_top_fifth(y, p) * 100)}
    out["observed_percent"] = round(float(y.mean()) * 100, 1)
    return out


def main():
    cohort = pd.read_csv(ROOT / "data" / "cohort.csv")
    dev = cohort[cohort.cycle != "2021-2023"].reset_index(drop=True)
    test = cohort[cohort.cycle == "2021-2023"].reset_index(drop=True)
    ext = pd.read_csv(EXTERNAL).reset_index(drop=True)
    bundle = json.loads((WEB / "model.json").read_text())
    full, short = xgb.Booster(), xgb.Booster()
    full.load_model(str(ROOT / "models" / "silentckd_xgb.json"))
    short.load_model(str(ROOT / "models" / "silentckd_short_xgb.json"))
    baseline = fit_baseline(dev)
    result = {}
    for name, d in [("test_2021_23", test), ("locked_2007_10", ext)]:
        result[name] = compare(d.albuminuria.values, score(d, full, short, bundle)[0], baseline.predict_proba(design(d))[:, 1])
    (MET / "published_comparison.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
