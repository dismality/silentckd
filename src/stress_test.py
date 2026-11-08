"""Sceptical checks of the final model on the 2021-23 test set: calibration, who is flagged, hard subgroups, simple baselines.
Run from the project root after train.py."""
import sys, json, numpy as np, pandas as pd, xgboost as xgb, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, "src")
from train import FEATURES, predict
from sklearn.metrics import roc_auc_score as auc, average_precision_score as ap
df = pd.read_csv("data/cohort.csv")
t = df[df.cycle == "2021-2023"].reset_index(drop=True)
print("told_kidney in cohort test %.3f" % (t.told_kidney_disease==1).mean())
b = xgb.Booster(); b.load_model("models/silentckd_xgb.json")
p = predict(b, t); y = t.albuminuria.values
at = json.load(open("demo/data/model.json"))["age_thresholds"]
thr = np.where(t.age < 45, at["20-44"], json.load(open("demo/data/model.json"))["threshold"])
band = np.where(p >= .50, "L", np.where(p >= thr, "P", "U"))
print("\n1 CALIBRATION by predicted band (n, mean pred, observed)")
for lo, hi in [(0,.1),(.1,.2),(.2,.35),(.35,.5),(.5,.7),(.7,1.01)]:
    m=(p>=lo)&(p<hi); print(f"  {lo:.2f}-{hi:.2f} n={m.sum():4d} pred={p[m].mean():.3f} obs={y[m].mean():.3f}")
print("  Likely mean pred %.3f obs %.3f" % (p[band=='L'].mean(), y[band=='L'].mean()))
print("\n2 WHO IS IN 'LIKELY'")
L=band=='L'
print("  eGFR<60: %.2f; dx diabetes %.2f; has_diabetes %.2f; told kidney %.2f; neither dm nor eGFR<60: %.2f" % ((t.egfr[L]<60).mean(), (t.dx_diabetes[L]==1).mean(), (t.has_diabetes[L]==1).mean(), (t.told_kidney_disease[L]==1).mean(), ((t.has_diabetes[L]!=1)&(t.egfr[L]>=60)).mean()))
print("\n3 SUBGROUPS (AUROC, prevalence, n)")
subs={"all":np.ones(len(t),bool),"eGFR>=60":t.egfr>=60,"eGFR>=60 & not told":(t.egfr>=60)&(t.told_kidney_disease!=1),"no dm & eGFR>=60 (usually missed)":(t.has_diabetes!=1)&(t.egfr>=60),"dm only":t.has_diabetes==1,"dx dm":t.dx_diabetes==1}
for k,m in subs.items():
    m=np.asarray(m); print(f"  {k:36s} n={m.sum():4d} prev={y[m].mean():.3f} auc={auc(y[m],p[m]):.3f} flagged={(p[m]>=thr[m]).mean():.2f} sens={(p[m&(y==1)]>=thr[m&(y==1)]).mean():.2f} ppv={y[m&(p>=thr)].mean():.3f}")
print("\n4 SHORT FORM ONLY (the fields on the main form)")
keep=["age","female","sbp","dbp","has_diabetes","diabetes_years","hba1c","bp_meds","cvd_history","current_smoker","egfr"]
ts=t.copy()
for f in FEATURES:
    if f not in keep: ts[f]=np.nan
ps=predict(b,ts)
print("  short form auc %.3f vs full %.3f; mean pred %.3f vs obs %.3f" % (auc(y,ps),auc(y,p),ps.mean(),y.mean()))
for lo,hi in [(0,.2),(.2,.5),(.5,1.01)]:
    m=(ps>=lo)&(ps<hi); print(f"   {lo}-{hi} n={m.sum()} pred={ps[m].mean():.3f} obs={y[m].mean():.3f}")
print("\n5 ANSWER CONTRADICTIONS: lower chance but stronger answer")
order=np.argsort(p); 
a=(band=='P'); c=(band=='U')
print("  max prob among Unlikely %.3f; min prob among Possible %.3f" % (p[c].max(),p[a].min()))
print("  Unlikely with chance >= overall avg 19%%: %d ; Possible with chance < 19%%: %d of %d" % ((p[c]>=.19).sum(),(p[a]<.19).sum(),a.sum()))
print("\n6 FLAG RATE BY AGE (age thresholds)")
for n,m in [("20-44",t.age<45),("45-64",(t.age>=45)&(t.age<65)),("65+",t.age>=65)]:
    m=np.asarray(m); print(f"  {n} n={m.sum()} cases={y[m].sum()} flagged={(p[m]>=thr[m]).mean():.2f} ppv={y[m&(p>=thr)].mean():.3f}")
print("\n7 XGB vs SIMPLE MODELS, paired bootstrap")
from sklearn.pipeline import make_pipeline; from sklearn.impute import SimpleImputer; from sklearn.preprocessing import StandardScaler; from sklearn.linear_model import LogisticRegression
d=df[df.cycle!="2021-2023"]
def fitpred(fs):
    m=make_pipeline(SimpleImputer(strategy="median"),StandardScaler(),LogisticRegression(max_iter=2000)); m.fit(d[fs],d.albuminuria); return m.predict_proba(t[fs])[:,1]
l25=fitpred(FEATURES); l5=fitpred(["age","sbp","hba1c","egfr","has_diabetes"])
rng=np.random.default_rng(0); D25=[];D5=[]
for _ in range(1000):
    i=rng.integers(0,len(y),len(y)); D25.append(auc(y[i],p[i])-auc(y[i],l25[i])); D5.append(auc(y[i],p[i])-auc(y[i],l5[i]))
print("  LR25 %.3f LR5 %.3f XGB %.3f"%(auc(y,l25),auc(y,l5),auc(y,p)))
print("  XGB-LR25 %.3f (%.3f,%.3f)  XGB-LR5 %.3f (%.3f,%.3f)"%(np.mean(D25),*np.percentile(D25,[2.5,97.5]),np.mean(D5),*np.percentile(D5,[2.5,97.5])))
print("\n8 Survey-weighted AUROC on test: %.3f (unweighted %.3f)"%(auc(y,p,sample_weight=t.wt.fillna(0)),auc(y,p)))
print("\n9 Young-adult CI: sens with age thresholds")
m=np.asarray(t.age<45)&(y==1); f=(p>=thr)[m]; s=[f[rng.integers(0,len(f),len(f))].mean() for _ in range(2000)]
print("  n=%d sens=%.2f CI %.2f-%.2f"%(m.sum(),f.mean(),*np.percentile(s,[2.5,97.5])))
m=np.asarray(t.race_eth=="Asian")&(y==1); f=(p>=thr)[m]; s=[f[rng.integers(0,len(f),len(f))].mean() for _ in range(2000)]
print("  Asian n=%d sens=%.2f CI %.2f-%.2f"%(m.sum(),f.mean(),*np.percentile(s,[2.5,97.5])))
print("\n10 RANDOM vs 'diabetes first' at Likely-size; tests per case")
for k,v in [("Likely",band=='L'),("Likely+Possible",band!='U')]: print(f"  {k}: tests per case found {v.sum()/y[v].sum():.2f}")
print("  test everyone: %.2f"%(len(y)/y.sum()))
