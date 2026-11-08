"""Build the SilentCKD analysis cohort from raw NHANES files.

Cohort: adults (>=20) with diabetes or hypertension who have a urine ACR and serum creatinine.
Target: albuminuria (urine albumin-to-creatinine ratio >= 30 mg/g) -- the half of CKD that a
blood test alone cannot see. Predictors are restricted to data a routine visit already has
(vitals, history, medications, a basic metabolic panel, HbA1c, lipids). Race is NOT a predictor;
it is kept only for the fairness audit.
"""
import numpy as np
import pandas as pd
from pathlib import Path

RAW = Path(__file__).resolve().parents[1] / "data" / "raw"
OUT = Path(__file__).resolve().parents[1] / "data" / "cohort.csv"

# cycle label -> (file name builder, years covered by the MEC weight)
CYCLES = {
    "2011-2012": (lambda c: f"{c}_G", 2.0),
    "2013-2014": (lambda c: f"{c}_H", 2.0),
    "2015-2016": (lambda c: f"{c}_I", 2.0),
    "2017-2020": (lambda c: f"P_{c}", 3.2),
    "2021-2023": (lambda c: f"{c}_L", 2.0),
}


def read(name, cols):
    df = pd.read_sas(RAW / f"{name}.xpt", encoding="latin-1")
    return df[[c for c in cols if c in df.columns]]


def yes(s):
    return (s == 1).astype(float).where(s.isin([1, 2]), np.nan)


def egfr_2021(scr, age, female):
    """CKD-EPI 2021 creatinine equation (race-free)."""
    k = np.where(female, 0.7, 0.9)
    a = np.where(female, -0.241, -0.302)
    r = scr / k
    return 142 * np.minimum(r, 1) ** a * np.maximum(r, 1) ** -1.200 * 0.9938 ** age * np.where(female, 1.012, 1)


def egfr_2009(scr, age, female, black):
    """CKD-EPI 2009 creatinine equation (race coefficient) -- used only for the fairness audit."""
    k = np.where(female, 0.7, 0.9)
    a = np.where(female, -0.329, -0.411)
    r = scr / k
    return (141 * np.minimum(r, 1) ** a * np.maximum(r, 1) ** -1.209 * 0.993 ** age
            * np.where(female, 1.018, 1) * np.where(black, 1.159, 1))


def load_cycle(cycle, fname):
    bp_file = "BPXO" if cycle in ("2017-2020", "2021-2023") else "BPX"
    demo = read(fname("DEMO"), ["SEQN", "RIAGENDR", "RIDAGEYR", "RIDRETH3", "INDFMPIR", "DMDEDUC2",
                                "WTMEC2YR", "WTMECPRP", "SDMVPSU", "SDMVSTRA", "RIDEXPRG"])
    demo["wt"] = demo.pop("WTMECPRP") if "WTMECPRP" in demo else demo.pop("WTMEC2YR")
    parts = [
        read(fname("BMX"), ["SEQN", "BMXBMI", "BMXWAIST"]),
        read(fname(bp_file), ["SEQN"] + [f"BPXSY{i}" for i in range(1, 5)] + [f"BPXDI{i}" for i in range(1, 5)]
             + [f"BPXOSY{i}" for i in range(1, 4)] + [f"BPXODI{i}" for i in range(1, 4)]),
        read(fname("BIOPRO"), ["SEQN", "LBXSCR", "LBXSUA", "LBXSAL", "LBXSBU", "LBXSTR", "LBXSKSI"]),
        read(fname("ALB_CR"), ["SEQN", "URDACT"]),
        read(fname("GHB"), ["SEQN", "LBXGH"]),
        read(fname("DIQ"), ["SEQN", "DIQ010", "DID040", "DIQ050", "DIQ070"]),
        read(fname("BPQ"), ["SEQN", "BPQ020", "BPQ050A", "BPQ150", "BPQ080", "BPQ100D", "BPQ101D"]),
        read(fname("MCQ"), ["SEQN", "MCQ160B", "MCQ160C", "MCQ160E", "MCQ160F"]),
        read(fname("KIQ_U"), ["SEQN", "KIQ022"]),
        read(fname("SMQ"), ["SEQN", "SMQ020", "SMQ040"]),
        read(fname("TCHOL"), ["SEQN", "LBXTC"]),
        read(fname("HDL"), ["SEQN", "LBDHDD"]),
    ]
    df = demo
    for p in parts:
        df = df.merge(p, on="SEQN", how="left")
    df["cycle"] = cycle
    return df


def build():
    frames = []
    for cycle, (fname, years) in CYCLES.items():
        d = load_cycle(cycle, fname)
        d["wt_years"] = years
        frames.append(d)
    raw = pd.concat(frames, ignore_index=True)

    o = pd.DataFrame({"seqn": raw.SEQN.astype(int), "cycle": raw.cycle})
    o["age"] = raw.RIDAGEYR
    o["female"] = (raw.RIAGENDR == 2).astype(int)
    eth = {1: "Mexican American", 2: "Other Hispanic", 3: "White", 4: "Black", 6: "Asian", 7: "Other/Multiracial"}
    o["race_eth"] = raw.RIDRETH3.map(eth)
    o["income_pir"] = raw.INDFMPIR
    o["bmi"] = raw.BMXBMI
    o["waist"] = raw.BMXWAIST
    sys_cols = [c for c in raw.columns if c.startswith(("BPXSY", "BPXOSY"))]
    dia_cols = [c for c in raw.columns if c.startswith(("BPXDI", "BPXODI"))]
    o["sbp"] = raw[sys_cols].mean(axis=1)
    o["dbp"] = raw[dia_cols].replace(0, np.nan).mean(axis=1)
    o["scr"] = raw.LBXSCR
    o["uric_acid"] = raw.LBXSUA
    o["serum_albumin"] = raw.LBXSAL
    o["bun"] = raw.LBXSBU
    o["triglycerides"] = raw.LBXSTR
    o["potassium"] = raw.LBXSKSI
    o["hba1c"] = raw.LBXGH
    o["total_chol"] = raw.LBXTC
    o["hdl"] = raw.LBDHDD

    o["dx_diabetes"] = yes(raw.DIQ010).fillna(0)
    dur = raw.RIDAGEYR - raw.DID040.where(raw.DID040 < 100)
    o["diabetes_years"] = dur.clip(lower=0).where(o.dx_diabetes == 1, 0)
    o["insulin"] = yes(raw.DIQ050).fillna(0)
    o["diabetes_pills"] = yes(raw.DIQ070).fillna(0)
    o["dx_hypertension"] = yes(raw.BPQ020).fillna(0)
    bp_med = raw.BPQ050A.where(raw.BPQ050A.notna(), raw.BPQ150)
    o["bp_meds"] = yes(bp_med).fillna(0)
    o["dx_high_chol"] = yes(raw.BPQ080).fillna(0)
    chol_med = raw.BPQ100D.where(raw.BPQ100D.notna(), raw.BPQ101D)
    o["chol_meds"] = yes(chol_med).fillna(0)
    o["cvd_history"] = (raw[["MCQ160B", "MCQ160C", "MCQ160E", "MCQ160F"]] == 1).any(axis=1).astype(int)
    o["current_smoker"] = ((raw.SMQ020 == 1) & raw.SMQ040.isin([1, 2])).astype(int)
    o["told_kidney_disease"] = yes(raw.KIQ022)

    o["egfr"] = egfr_2021(o.scr, o.age, o.female == 1)
    o["egfr_2009_race"] = egfr_2009(o.scr, o.age, o.female == 1, o.race_eth == "Black")
    o["acr"] = raw.URDACT

    # survey design, for population-level prevalence estimates
    o["wt"] = raw.wt * raw.wt_years / sum(y for c, (_, y) in CYCLES.items() if c != "2021-2023")
    o.loc[o.cycle == "2021-2023", "wt"] = raw.wt[o.cycle == "2021-2023"]

    # cohort: adults with diabetes (diagnosed or HbA1c>=6.5) or hypertension (diagnosed, treated, or measured >=140/90)
    diabetes = (o.dx_diabetes == 1) | (o.hba1c >= 6.5)
    htn = (o.dx_hypertension == 1) | (o.bp_meds == 1) | (o.sbp >= 140) | (o.dbp >= 90)
    o["has_diabetes"] = diabetes.astype(int)
    o["has_hypertension"] = htn.astype(int)
    pregnant = raw.RIDEXPRG == 1
    keep = (o.age >= 20) & (diabetes | htn) & o.acr.notna() & o.scr.notna() & ~pregnant
    c = o[keep].copy()
    c["albuminuria"] = (c.acr >= 30).astype(int)
    c["ckd_any"] = ((c.acr >= 30) | (c.egfr < 60)).astype(int)
    OUT.parent.mkdir(exist_ok=True)
    c.to_csv(OUT, index=False)
    return c


if __name__ == "__main__":
    c = build()
    print(c.groupby("cycle").agg(n=("seqn", "size"), albuminuria=("albuminuria", "mean"),
                                 ckd=("ckd_any", "mean")).round(3))
    print("missing share:\n", c.isna().mean().round(3)[c.isna().mean() > 0])
