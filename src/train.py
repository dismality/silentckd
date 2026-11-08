"""Train, validate and fairness-audit the SilentCKD albuminuria model.

Development: NHANES 2011-2020 (5-fold CV for model selection and out-of-fold estimates).
Temporal external validation: NHANES 2021-2023, never touched during development.
Writes metrics/*.json, figures/*.png and the browser model bundle used by the demo.
"""
import json
import numpy as np
import pandas as pd
import xgboost as xgb
from pathlib import Path
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss, roc_curve, precision_recall_curve

ROOT = Path(__file__).resolve().parents[1]
MET, FIG, WEB = ROOT / "metrics", ROOT / "figures", ROOT / "demo" / "data"
for p in (MET, FIG, WEB):
    p.mkdir(parents=True, exist_ok=True)

FEATURES = [
    "age", "female", "bmi", "waist", "sbp", "dbp",
    "has_diabetes", "diabetes_years", "insulin", "diabetes_pills", "hba1c",
    "dx_hypertension", "bp_meds", "dx_high_chol", "chol_meds", "cvd_history", "current_smoker",
    "egfr", "uric_acid", "serum_albumin", "bun", "potassium", "triglycerides", "total_chol", "hdl",
]
LABELS = {
    "age": "Age", "female": "Female sex", "bmi": "BMI", "waist": "Waist circumference", "sbp": "Systolic BP",
    "dbp": "Diastolic BP", "has_diabetes": "Diabetes", "diabetes_years": "Years with diabetes",
    "insulin": "On insulin", "diabetes_pills": "On diabetes pills", "hba1c": "HbA1c",
    "dx_hypertension": "Diagnosed hypertension", "bp_meds": "On BP medication", "dx_high_chol": "High cholesterol",
    "chol_meds": "On cholesterol medication", "cvd_history": "Prior heart disease/stroke",
    "current_smoker": "Current smoker", "egfr": "eGFR (2021, race-free)", "uric_acid": "Uric acid",
    "serum_albumin": "Serum albumin", "bun": "Blood urea nitrogen", "potassium": "Potassium",
    "triglycerides": "Triglycerides", "total_chol": "Total cholesterol", "hdl": "HDL cholesterol",
}
# clinically expected direction; enforced so explanations never contradict physiology
MONOTONE = {"sbp": 1, "hba1c": 1, "egfr": -1, "diabetes_years": 1, "age": 1}
XGB_PARAMS = dict(objective="binary:logistic", eval_metric="logloss", max_depth=3, learning_rate=0.03,
                  subsample=0.8, colsample_bytree=0.8, min_child_weight=5, reg_lambda=2.0, tree_method="hist",
                  monotone_constraints="(" + ",".join(str(MONOTONE.get(f, 0)) for f in FEATURES) + ")", seed=7)
N_TREES = 400
SEED = 7
BLUE, ORANGE, GRAY = "#2a78d6", "#eb6834", "#8a8984"


def fit_xgb(X, y, n_trees=N_TREES, features=FEATURES, params=XGB_PARAMS):
    p = dict(params)
    if features is not FEATURES:
        p["monotone_constraints"] = "(" + ",".join(str(MONOTONE.get(f, 0)) for f in features) + ")"
    return xgb.train(p, xgb.DMatrix(X[features], label=y, feature_names=features), num_boost_round=n_trees)


def predict(b, X, features=FEATURES):
    return b.predict(xgb.DMatrix(X[features], feature_names=features))


def logreg():
    return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=0.5, max_iter=2000))


def calib(y, p):
    """Calibration intercept and slope via logistic recalibration on logit(p)."""
    lp = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    m = LogisticRegression(C=1e6).fit(lp.reshape(-1, 1), y)
    return float(m.intercept_[0]), float(m.coef_[0][0])


def metrics(y, p, thr):
    y, p = np.asarray(y), np.asarray(p)
    pred = p >= thr
    tp, fp = int((pred & (y == 1)).sum()), int((pred & (y == 0)).sum())
    fn, tn = int((~pred & (y == 1)).sum()), int((~pred & (y == 0)).sum())
    ci, cs = calib(y, p)
    return dict(n=len(y), prevalence=float(y.mean()), auroc=float(roc_auc_score(y, p)),
                auprc=float(average_precision_score(y, p)), brier=float(brier_score_loss(y, p)),
                calib_intercept=ci, calib_slope=cs, sensitivity=tp / max(tp + fn, 1),
                specificity=tn / max(tn + fp, 1), ppv=tp / max(tp + fp, 1), npv=tn / max(tn + fn, 1),
                flagged_share=float(pred.mean()), mean_pred=float(p.mean()))


def bootstrap_ci(y, p, fn, n=1000):
    rng = np.random.default_rng(SEED)
    y, p = np.asarray(y), np.asarray(p)
    vals = []
    for _ in range(n):
        i = rng.integers(0, len(y), len(y))
        if y[i].min() != y[i].max():
            vals.append(fn(y[i], p[i]))
    return [float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))]


def net_benefit(y, p, thresholds):
    y, p = np.asarray(y), np.asarray(p)
    n, out = len(y), []
    for t in thresholds:
        pred = p >= t
        tp, fp = (pred & (y == 1)).sum(), (pred & (y == 0)).sum()
        out.append(tp / n - fp / n * t / (1 - t))
    return out


def capacity_curve(y, p):
    """Share of all albuminuria cases found when testing the top-k% highest-risk patients."""
    y = np.asarray(y)[np.argsort(-np.asarray(p))]
    ks = np.arange(0, 101, 5)
    return [dict(tested_pct=int(k), found_pct=float(y[: int(round(len(y) * k / 100))].sum() / y.sum() * 100))
            for k in ks]


def oof(dev, make_pred):
    out = np.zeros(len(dev))
    for tr, va in StratifiedKFold(5, shuffle=True, random_state=SEED).split(dev, dev.albuminuria):
        out[va] = make_pred(dev.iloc[tr], dev.iloc[va])
    return out


def subgroups(df):
    age = pd.cut(df.age, [19, 44, 64, 120], labels=["20-44", "45-64", "65+"]).astype(str)
    inc = pd.cut(df.income_pir, [-1, 1.3, 3.5, 99], labels=["Low (PIR<1.3)", "Middle", "High (PIR>3.5)"])
    cond = np.where(df.has_diabetes == 1, np.where(df.has_hypertension == 1, "Diabetes + HTN", "Diabetes only"),
                    "Hypertension only")
    return {"Race/ethnicity": df.race_eth, "Sex": np.where(df.female == 1, "Female", "Male"), "Age": age,
            "Income": inc.astype(str).replace("nan", "Unknown"), "Condition": cond}


def fairness_table(df, p, thr):
    rows = []
    for dim, grp in subgroups(df).items():
        grp = pd.Series(np.asarray(grp), index=df.index).fillna("Unknown").astype(str).replace("nan", "Unknown")
        for g in sorted(grp.unique()):
            m = (grp == g).values
            y = df.albuminuria.values[m]
            if m.sum() < 40 or y.min() == y.max() or g == "Unknown":
                continue
            r = metrics(y, p[m], thr)
            r.update(dimension=dim, group=g, fpr=1 - r["specificity"])
            rows.append(r)
    return rows


def plot_all(test, p_x, p_lr, guide_rank, perf, dca, cap, fair, shap_global):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "Segoe UI", "font.size": 11, "axes.spines.top": False,
                         "axes.spines.right": False, "axes.edgecolor": "#b5b4ae", "axes.labelcolor": "#52514e",
                         "xtick.color": "#52514e", "ytick.color": "#52514e", "axes.grid": True,
                         "grid.color": "#ecebe7", "grid.linewidth": 0.8, "figure.dpi": 160})
    y = test.albuminuria.values

    fig, ax = plt.subplots(1, 2, figsize=(10, 4.2))
    for p, c, name in [(p_x, BLUE, "SilentCKD (XGBoost)"), (p_lr, ORANGE, "Logistic regression")]:
        f, t, _ = roc_curve(y, p)
        ax[0].plot(f, t, color=c, lw=2, label=f"{name}  AUROC {roc_auc_score(y, p):.3f}")
        pr, rc, _ = precision_recall_curve(y, p)
        ax[1].plot(rc, pr, color=c, lw=2, label=f"{name}  AUPRC {average_precision_score(y, p):.3f}")
    ax[0].plot([0, 1], [0, 1], color=GRAY, lw=1, ls="--")
    ax[1].axhline(y.mean(), color=GRAY, lw=1, ls="--", label=f"Prevalence {y.mean():.2f}")
    ax[0].set(xlabel="False positive rate", ylabel="Sensitivity", title="ROC — 2021-23 external test")
    ax[1].set(xlabel="Recall", ylabel="Precision", title="Precision-recall — 2021-23 external test")
    for a in ax:
        a.legend(frameon=False, fontsize=9, loc="lower right" if a is ax[0] else "upper right")
    fig.tight_layout(); fig.savefig(FIG / "roc_pr.png"); plt.close(fig)

    fig, ax = plt.subplots(figsize=(5, 4.6))
    bins = pd.qcut(p_x, 10, duplicates="drop")
    g = pd.DataFrame({"p": p_x, "y": y}).groupby(bins, observed=True).mean()
    ax.plot([0, 0.8], [0, 0.8], color=GRAY, lw=1, ls="--", label="Perfect calibration")
    ax.plot(g.p, g.y, color=BLUE, lw=2, marker="o", ms=6, label="SilentCKD (deciles)")
    ax.set(xlabel="Predicted risk", ylabel="Observed albuminuria rate", title="Calibration — external test")
    ax.legend(frameon=False, fontsize=9)
    fig.tight_layout(); fig.savefig(FIG / "calibration.png"); plt.close(fig)

    fig, ax = plt.subplots(figsize=(6.4, 4.2))
    ts = [d["threshold"] for d in dca]
    ax.plot(ts, [d["model"] for d in dca], color=BLUE, lw=2, label="SilentCKD")
    ax.plot(ts, [d["test_all"] for d in dca], color=ORANGE, lw=2, label="Test everyone")
    ax.plot(ts, [0] * len(ts), color=GRAY, lw=1.5, label="Test no one")
    ax.set_ylim(-0.05, max(d["model"] for d in dca) * 1.15)
    ax.set(xlabel="Threshold probability", ylabel="Net benefit", title="Decision curve — external test")
    ax.legend(frameon=False, fontsize=9)
    fig.tight_layout(); fig.savefig(FIG / "decision_curve.png"); plt.close(fig)

    fig, ax = plt.subplots(figsize=(6.4, 4.2))
    ax.plot([c["tested_pct"] for c in cap["model"]], [c["found_pct"] for c in cap["model"]], color=BLUE, lw=2,
            marker="o", ms=4, label="Rank by SilentCKD risk")
    ax.plot([c["tested_pct"] for c in cap["guideline"]], [c["found_pct"] for c in cap["guideline"]], color=ORANGE,
            lw=2, label="Diabetes first, then random")
    ax.plot([0, 100], [0, 100], color=GRAY, lw=1, ls="--", label="Random order")
    ax.set(xlabel="% of patients given a urine ACR test", ylabel="% of albuminuria cases found",
           title="Finding cases with a limited testing budget")
    ax.legend(frameon=False, fontsize=9)
    fig.tight_layout(); fig.savefig(FIG / "capacity.png"); plt.close(fig)

    top = shap_global[:12][::-1]
    fig, ax = plt.subplots(figsize=(6.4, 4.6))
    ax.barh([LABELS[t["feature"]] for t in top], [t["mean_abs_shap"] for t in top], color=BLUE, height=0.6)
    ax.set(xlabel="Mean |SHAP| (log-odds)", title="What drives the risk score")
    ax.grid(axis="y", visible=False)
    fig.tight_layout(); fig.savefig(FIG / "shap_global.png"); plt.close(fig)

    race = [r for r in fair if r["dimension"] == "Race/ethnicity"]
    fig, ax = plt.subplots(figsize=(7, 4))
    xs = np.arange(len(race))
    ax.bar(xs - 0.2, [r["sensitivity"] for r in race], 0.38, color=BLUE, label="Sensitivity")
    ax.bar(xs + 0.2, [r["fpr"] for r in race], 0.38, color=ORANGE, label="False positive rate")
    ax.set_xticks(xs, [f"{r['group']}\n(n={r['n']})" for r in race], fontsize=8.5)
    ax.set(ylim=(0, 1), title="Error rates by race/ethnicity (race is not a model input)")
    ax.legend(frameon=False, fontsize=9)
    fig.tight_layout(); fig.savefig(FIG / "fairness_race.png"); plt.close(fig)


def dump_trees(booster):
    """Compact tree arrays for the in-browser scorer + TreeSHAP."""
    trees = []
    for t in booster.get_dump(dump_format="json", with_stats=True):
        nodes = {}

        def walk(n):
            nodes[n["nodeid"]] = n
            for c in n.get("children", []):
                walk(c)
        walk(json.loads(t.replace("-inf", "-1e30")))  # a split at -inf separates blank from non-blank values
        size = max(nodes) + 1
        arr = {k: [0] * size for k in ("f", "t", "l", "r", "m", "v", "c")}
        for i, n in nodes.items():
            arr["c"][i] = round(n["cover"], 4)
            if "leaf" in n:
                arr["f"][i], arr["v"][i] = -1, n["leaf"]
            else:
                arr["f"][i] = FEATURES.index(n["split"])
                arr["t"][i], arr["l"][i], arr["r"][i], arr["m"][i] = n["split_condition"], n["yes"], n["no"], n["missing"]
        trees.append(arr)
    return trees


def main():
    df = pd.read_csv(ROOT / "data" / "cohort.csv")
    dev, test = df[df.cycle != "2021-2023"].reset_index(drop=True), df[df.cycle == "2021-2023"].reset_index(drop=True)
    ydev, ytest = dev.albuminuria.values, test.albuminuria.values

    # --- model selection on development data
    oof_x = oof(dev, lambda tr, va: predict(fit_xgb(tr, tr.albuminuria), va))
    oof_lr = oof(dev, lambda tr, va: logreg().fit(tr[FEATURES], tr.albuminuria).predict_proba(va[FEATURES])[:, 1])
    # operating threshold chosen on development OOF predictions: sensitivity >= 0.80
    fpr, tpr, thr = roc_curve(ydev, oof_x)
    THR = float(thr[np.argmax(tpr >= 0.80)])

    final = fit_xgb(dev, ydev)
    lr = logreg().fit(dev[FEATURES], ydev)
    p_x, p_lr = predict(final, test), lr.predict_proba(test[FEATURES])[:, 1]
    rng = np.random.default_rng(SEED)
    guide_rank = test.has_diabetes.values + rng.random(len(test)) * 0.5  # diabetes first, random within

    perf = {
        "threshold": THR,
        "dev_oof": {"xgboost": metrics(ydev, oof_x, THR), "logistic": metrics(ydev, oof_lr, np.quantile(oof_lr, 1 - (oof_x >= THR).mean()))},
        "test": {"xgboost": metrics(ytest, p_x, THR),
                 "logistic": metrics(ytest, p_lr, np.quantile(p_lr, 1 - (p_x >= THR).mean())),
                 "diabetes_rule": {"sensitivity": float(test.has_diabetes[ytest == 1].mean()),
                                   "flagged_share": float(test.has_diabetes.mean()),
                                   "ppv": float(ytest[test.has_diabetes == 1].mean())}},
        "test_ci": {"auroc": bootstrap_ci(ytest, p_x, roc_auc_score),
                    "auprc": bootstrap_ci(ytest, p_x, average_precision_score),
                    "auroc_logistic": bootstrap_ci(ytest, p_lr, roc_auc_score)},
    }
    # Model's sensitivity when flagging the same number of people as the diabetes-only rule
    k = int(test.has_diabetes.sum())
    top = np.argsort(-p_x)[:k]
    perf["test"]["xgboost_same_budget_as_diabetes_rule"] = {"flagged": k, "sensitivity": float(ytest[top].sum() / ytest.sum()),
                                                           "ppv": float(ytest[top].mean())}

    ts = np.round(np.arange(0.05, 0.51, 0.01), 2)
    nb = net_benefit(ytest, p_x, ts)
    nb_all = net_benefit(ytest, np.ones(len(ytest)), ts)
    dca = [dict(threshold=float(t), model=float(a), test_all=float(b)) for t, a, b in zip(ts, nb, nb_all)]
    cap = {"model": capacity_curve(ytest, p_x), "guideline": capacity_curve(ytest, guide_rank),
           "logistic": capacity_curve(ytest, p_lr)}

    # --- fairness: pooled OOF dev + external test, for adequate subgroup sizes
    pooled = pd.concat([dev, test], ignore_index=True)
    p_pool = np.concatenate([oof_x, p_x])
    fair = fairness_table(pooled, p_pool, THR)
    fair_test = fairness_table(test, p_x, THR)

    # race-as-input experiment and eGFR-equation experiment (OOF on dev)
    race_dummies = pd.get_dummies(pooled.race_eth, prefix="race").astype(float)
    pooled_r = pd.concat([pooled, race_dummies], axis=1)
    feats_r = FEATURES + list(race_dummies.columns)
    dev_r = pooled_r[pooled_r.cycle != "2021-2023"].reset_index(drop=True)
    oof_race = oof(dev_r, lambda tr, va: predict(fit_xgb(tr, tr.albuminuria, features=feats_r), va, feats_r))
    feats_09 = [("egfr_2009_race" if f == "egfr" else f) for f in FEATURES]
    oof_09 = oof(dev, lambda tr, va: predict(fit_xgb(tr, tr.albuminuria, features=feats_09), va, feats_09))

    def by_race(p):
        out = {}
        for g in sorted(dev.race_eth.unique()):
            m = (dev.race_eth == g).values
            y = ydev[m]
            out[g] = dict(n=int(m.sum()), auroc=float(roc_auc_score(y, p[m])), sensitivity=float((p[m][y == 1] >= THR).mean()),
                          fpr=float((p[m][y == 0] >= THR).mean()))
        return out

    # mitigation: group-specific thresholds tuned on dev OOF to reach sensitivity >= 0.80, evaluated on the external test
    def mitigation(dim):
        g_dev, g_test = subgroups(dev)[dim], subgroups(test)[dim]
        g_dev, g_test = pd.Series(np.asarray(g_dev)).astype(str), pd.Series(np.asarray(g_test)).astype(str)
        res = {}
        for g in sorted(g_test.unique()):
            md, mt = (g_dev == g).values, (g_test == g).values
            if mt.sum() < 40 or g in ("Unknown", "nan"):
                continue
            f, t, th = roc_curve(ydev[md], oof_x[md])
            gthr = float(th[np.argmax(t >= 0.80)])
            yt, pt = ytest[mt], p_x[mt]
            res[g] = dict(n_test=int(mt.sum()), threshold=gthr,
                          sens_global=float((pt[yt == 1] >= THR).mean()), sens_group=float((pt[yt == 1] >= gthr).mean()),
                          flagged_global=float((pt >= THR).mean()), flagged_group=float((pt >= gthr).mean()))
        return res

    black = df.race_eth == "Black"
    reclass = df[black & (df.egfr_2009_race >= 60) & (df.egfr < 60)]
    equity = {
        "race_free_no_race_input": by_race(oof_x),
        "with_race_input": by_race(oof_race),
        "with_2009_race_based_egfr": by_race(oof_09),
        "egfr_reclassification": {
            "black_participants": int(black.sum()),
            "reclassified_to_egfr_below_60_by_2021_equation": int(len(reclass)),
            "black_with_egfr_below_60_2009": int((black & (df.egfr_2009_race < 60)).sum()),
            "black_with_egfr_below_60_2021": int((black & (df.egfr < 60)).sum()),
            "mean_egfr_black_2009": float(df.egfr_2009_race[black].mean()),
            "mean_egfr_black_2021": float(df.egfr[black].mean()),
        },
        "mitigation_age": mitigation("Age"),
        "mitigation_race": mitigation("Race/ethnicity"),
    }

    # --- population burden (survey-weighted, 2017-2020 cycle for a recent national estimate)
    w = df[df.cycle == "2017-2020"]
    W = w.wt
    ckd = w.ckd_any == 1
    burden = {
        "cohort_n": int(len(df)), "dev_n": int(len(dev)), "test_n": int(len(test)),
        "weighted_albuminuria_prev": float((W * w.albuminuria).sum() / W.sum()),
        "weighted_ckd_prev": float((W * w.ckd_any).sum() / W.sum()),
        "weighted_ckd_unaware": float((W[ckd] * (w.told_kidney_disease[ckd] != 1)).sum() / W[ckd].sum()),
        "weighted_ckd_invisible_to_blood_test": float((W[ckd] * (w.egfr[ckd] >= 60)).sum() / W[ckd].sum()),
        "unweighted_albuminuria_with_normal_egfr_share": float(((df.albuminuria == 1) & (df.egfr >= 60)).sum() / df.albuminuria.sum()),
    }

    # --- explanations (TreeSHAP built into XGBoost)
    contrib = final.predict(xgb.DMatrix(test[FEATURES], feature_names=FEATURES), pred_contribs=True)
    shap_global = sorted([dict(feature=f, mean_abs_shap=float(np.abs(contrib[:, i]).mean())) for i, f in enumerate(FEATURES)],
                         key=lambda d: -d["mean_abs_shap"])

    for name, obj in [("performance", perf), ("decision_curve", dca), ("capacity", cap), ("fairness_pooled", fair),
                      ("fairness_test", fair_test), ("equity_experiments", equity), ("burden", burden),
                      ("shap_global", shap_global)]:
        (MET / f"{name}.json").write_text(json.dumps(obj, indent=2))
    plot_all(test, p_x, p_lr, guide_rank, perf, dca, cap, fair, shap_global)

    # --- browser bundle: trees, base score, verification cases, demo patient panel
    (ROOT / "models").mkdir(exist_ok=True)
    final.save_model(str(ROOT / "models" / "silentckd_xgb.json"))
    cfg = json.loads(final.save_config())
    base = float(cfg["learner"]["learner_model_param"]["base_score"].strip("[]"))
    base_margin = float(np.log(base / (1 - base)))
    f_, t_, _ = roc_curve(ytest, p_x)
    keep = np.unique(np.linspace(0, len(f_) - 1, 60).astype(int))
    roc_points = {"xgboost": [[float(f_[i]), float(t_[i])] for i in keep]}
    f_, t_, _ = roc_curve(ytest, p_lr)
    keep = np.unique(np.linspace(0, len(f_) - 1, 60).astype(int))
    roc_points["logistic"] = [[float(f_[i]), float(t_[i])] for i in keep]
    dec = pd.DataFrame({"p": p_x, "y": ytest}).groupby(pd.qcut(p_x, 10), observed=True)
    calib_deciles = [dict(pred=float(g.p.mean()), obs=float(g.y.mean()), n=int(len(g))) for _, g in dec]
    panel_idx = np.random.default_rng(3).choice(len(test), 60, replace=False)
    panel = test.iloc[panel_idx]
    bundle = {
        "features": FEATURES, "labels": LABELS, "base_margin": base_margin, "threshold": THR,
        "trees": dump_trees(final),
        "verify": [{"x": [None if pd.isna(v) else float(v) for v in test.loc[i, FEATURES]], "p": float(p_x[i]),
                    "contrib": [float(c) for c in contrib[i]]} for i in range(25)],
        "panel": [{"id": f"P-{int(r.seqn)}", "x": [None if pd.isna(v) else float(v) for v in r[FEATURES]],
                   "scr": float(r.scr), "egfr_2009_race": float(r.egfr_2009_race), "race_eth": r.race_eth, "acr": float(r.acr),
                   "albuminuria": int(r.albuminuria)} for _, r in panel.iterrows()],
        "age_thresholds": {g: v["threshold"] for g, v in equity["mitigation_age"].items()},
        "metrics": {"perf": perf, "roc": roc_points, "calibration": calib_deciles, "capacity": cap, "dca": dca, "fairness": fair, "equity": equity,
                    "burden": burden, "shap_global": shap_global},
    }
    (WEB / "model.json").write_text(json.dumps(bundle, separators=(",", ":")))

    t = perf["test"]
    print(f"threshold={THR:.3f}")
    print("dev OOF  xgb AUROC %.3f  lr %.3f" % (perf["dev_oof"]["xgboost"]["auroc"], perf["dev_oof"]["logistic"]["auroc"]))
    print("TEST     xgb AUROC %.3f %s AUPRC %.3f  lr AUROC %.3f" % (t["xgboost"]["auroc"], perf["test_ci"]["auroc"], t["xgboost"]["auprc"], t["logistic"]["auroc"]))
    print("TEST     sens %.3f spec %.3f ppv %.3f flagged %.3f  calib int %.2f slope %.2f" % tuple(t["xgboost"][k] for k in ["sensitivity", "specificity", "ppv", "flagged_share", "calib_intercept", "calib_slope"]))
    print("diabetes rule", t["diabetes_rule"], "model same budget", t["xgboost_same_budget_as_diabetes_rule"])
    print(json.dumps(burden, indent=1))
    print(json.dumps({k: equity[k] for k in ("egfr_reclassification", "mitigation_age", "mitigation_race")}, indent=1))
    print(pd.DataFrame(fair)[["dimension", "group", "n", "prevalence", "auroc", "sensitivity", "fpr", "ppv", "mean_pred"]].round(3).to_string())
    print("top shap", [s["feature"] for s in shap_global[:8]])


if __name__ == "__main__":
    main()
