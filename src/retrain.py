"""Retrain SilentCKD on a new dataset, for example one supplied by a clinic or by the datathon finals.

Input: a CSV with one patient per row, a 0/1 outcome column, and any of the columns in train.FEATURES.
Missing columns are left blank. Columns that have another name can be renamed with --rename old=new.

Examples:
  python src/retrain.py data/cohort.csv --label albuminuria --split-col cycle --test-value 2021-2023
  python src/retrain.py new.csv --label ckd --rename SBP=sbp --rename HbA1c=hba1c --update-site

Without --split-col, a random 20% is held out. Cut-offs are always set on the training part only.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score, roc_curve
from sklearn.model_selection import StratifiedKFold

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train import FEATURES, ROOT, SEED, WEB, calib, dump_trees, fit_xgb, predict  # noqa: E402

LIKELY = 0.50


def cutoff(y, p, sensitivity=0.80):
    f, t, th = roc_curve(y, p)
    return float(th[np.argmax(t >= sensitivity)])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv")
    ap.add_argument("--label", required=True, help="0/1 outcome column")
    ap.add_argument("--rename", action="append", default=[], metavar="OLD=NEW")
    ap.add_argument("--split-col", help="column that defines the held-out test set")
    ap.add_argument("--test-value", help="value of --split-col that marks test rows")
    ap.add_argument("--out", default=str(ROOT / "retrained"))
    ap.add_argument("--update-site", action="store_true", help="also put the new model into demo/data/model.json")
    a = ap.parse_args()

    df = pd.read_csv(a.csv).rename(columns=dict(x.split("=", 1) for x in a.rename))
    if a.label not in df:
        sys.exit(f"No outcome column called {a.label!r}. Columns found: {list(df.columns)}")
    df = df[df[a.label].isin([0, 1])].reset_index(drop=True)
    present = [f for f in FEATURES if f in df]
    missing = [f for f in FEATURES if f not in df]
    if len(present) < 3:
        sys.exit(f"Only {present} matched the model's inputs. Use --rename to map your column names: {FEATURES}")
    for f in missing:
        df[f] = np.nan
    df[FEATURES] = df[FEATURES].apply(pd.to_numeric, errors="coerce")
    df["_y"] = df[a.label].astype(int)

    if a.split_col:
        is_test = df[a.split_col].astype(str) == str(a.test_value)
        if not is_test.any() or is_test.all():
            sys.exit("The split must leave rows on both sides.")
    else:
        is_test = pd.Series(np.random.default_rng(SEED).random(len(df)) < 0.2)
    dev, test = df[~is_test].reset_index(drop=True), df[is_test].reset_index(drop=True)

    oof = np.zeros(len(dev))
    for tr, va in StratifiedKFold(5, shuffle=True, random_state=SEED).split(dev, dev._y):
        oof[va] = predict(fit_xgb(dev.iloc[tr], dev._y.iloc[tr]), dev.iloc[va])
    final = fit_xgb(dev, dev._y)
    p, y = predict(final, test), test._y.values

    possible = cutoff(dev._y.values, oof)
    young = possible
    if "age" in present and (dev.age < 45).sum() >= 200 and dev._y[dev.age < 45].sum() >= 20:
        young = min(possible, cutoff(dev._y[dev.age < 45].values, oof[(dev.age < 45).values]))
    bar = np.where(test.age.values < 45, young, possible)
    band = np.where(p >= LIKELY, "likely", np.where(p >= bar, "possible", "unlikely"))
    intercept, slope = calib(y, p)
    report = {
        "rows": {"train": int(len(dev)), "test": int(len(test))}, "inputs_found": present, "inputs_missing": missing,
        "outcome_rate": {"train": round(float(dev._y.mean()), 3), "test": round(float(y.mean()), 3)},
        "test": {"auroc": round(float(roc_auc_score(y, p)), 3), "auprc": round(float(average_precision_score(y, p)), 3), "brier": round(float(brier_score_loss(y, p)), 3),
                 "calibration_slope": round(slope, 2), "calibration_intercept": round(intercept, 2), "cases_caught": round(float((band != "unlikely")[y == 1].mean()), 3), "flagged": round(float((band != "unlikely").mean()), 3)},
        "cutoffs": {"likely": LIKELY, "possible": possible, "possible_under_45": young},
        "answers": {v: {"share": round(float((band == v).mean()), 3), "had_outcome": round(float(y[band == v].mean()), 3) if (band == v).any() else None} for v in ("likely", "possible", "unlikely")},
    }

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    final.save_model(str(out / "model.json"))
    (out / "report.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))

    if a.update_site:
        cfg = json.loads(final.save_config())
        base = float(cfg["learner"]["learner_model_param"]["base_score"].strip("[]"))
        bundle = json.loads((WEB / "model.json").read_text())
        bundle.update({"trees": dump_trees(final), "base_margin": float(np.log(base / (1 - base))), "threshold": possible})
        bundle["rules"].update({"likely": LIKELY, "possible": possible, "young": young})
        (WEB / "model.json").write_text(json.dumps(bundle, separators=(",", ":")))
        print("\nThe website now uses this model. Its accuracy page still shows the NHANES results until src/answers.py is adapted and rerun.")


if __name__ == "__main__":
    main()
