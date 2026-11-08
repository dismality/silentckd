# SilentCKD model card

## What it does
SilentCKD estimates the chance that an adult with diabetes or high blood pressure **currently** has albuminuria, an early sign of kidney damage, using routine check-up data. It helps a clinic decide who should get a urine albumin-to-creatinine ratio (ACR) test first.

**Brief:** DataNova 2026, DN-HC-01, Early Risk Stratification for Chronic Disease.

## Scope, stated plainly
- It detects damage that is **already present but unmeasured**. It has not been shown to predict who will develop kidney disease in future.
- It was built on a national health survey (NHANES), not on electronic health records. Survey measurements are more standardised than routine records.
- It is a prototype and not a medical device. It should only prompt a urine test. Diagnosis needs a clinician and a repeat test.

## Intended users and use
Primary-care teams and population-health staff who cannot test everyone and need to rank patients.

**Not for:** diagnosis, treatment decisions, ruling out kidney disease, children, pregnancy, or replacing the yearly ACR test that guidelines recommend for diabetes.

## Data
| | |
|---|---|
| Source | CDC NHANES public-use files, 5 cycles (2011-12, 2013-14, 2015-16, 2017-20, 2021-23) |
| Who | Adults 20+ with diabetes (diagnosed or HbA1c ≥6.5%) or hypertension (diagnosed, treated, or ≥140/90), with urine ACR and serum creatinine; pregnant participants excluded |
| Size | 13,506 people: 10,923 for development (2011-2020), 2,583 for testing (2021-23) |
| Outcome | Albuminuria, urine ACR ≥30 mg/g, from one urine sample |
| Prevalence | 19% in the test set |

## Models
Both are XGBoost: 400 trees, depth 3, learning rate 0.03. Monotone constraints mean risk can only rise with blood pressure, HbA1c, diabetes duration and age, and only fall with eGFR.

| Model | Inputs | Used when | AUROC on 2021-23 |
|---|---|---|---|
| Full | 25 | At most 2 of 9 optional measures are blank | 0.754 |
| Short form | 11: age, sex, blood pressure (2), diabetes, diabetes years, HbA1c, BP medicine, heart disease or stroke, smoking, eGFR | More than 2 are blank | 0.749 |

The short-form model was trained with blood pressure, HbA1c and creatinine randomly blanked so that it stays usable when they are unknown.

**Race is not an input.** eGFR uses the race-free CKD-EPI 2021 equation. No urine values are inputs.

## Answers
| Answer | Rule | Test set: share of patients | Test set: really had albuminuria |
|---|---|---|---|
| Likely | Chance ≥50% | 7% | 65% |
| Possible | Chance ≥13.0% (≥8.6% under age 45) | 47% | 23% |
| Unlikely | Below that | 45% | 8% |

The short-form model uses 12.5% (7.8% under 45) for Possible.

Whatever the answer, the website prompts a doctor's review when eGFR is below 60, and warns when a record falls outside the group the model was built for.

## Explanations
Exact TreeSHAP values are computed in the browser and match XGBoost to within 1e-6. They are grouped into everyday topics such as blood pressure and blood sugar. They explain **the prediction, not the cause of disease**. The website's "what if" section compares records and does not estimate a treatment effect.

## Performance
See [validation_report.md](validation_report.md). In summary, on 2021-23: AUROC 0.754 (95% CI 0.730-0.778), calibration slope 0.97, 81% of cases get a Likely or Possible answer, with 55% of patients flagged.

On a locked test of NHANES 2007-2010 (n = 2,469, rules frozen first): AUROC 0.749 (0.723-0.774), calibration slope 0.95, 82% of cases caught, and 62% of Likely answers correct.

Over about 10 years of linked death records, the 10-year death rate was 58 per 100 for Likely, 28 for Possible and 11 for Unlikely. Age/sex-adjusted hazard ratios were 4.2 and 1.7 versus Unlikely. This is long-term signal, not evidence of predicting new CKD.

In a simulation of messy records, AUROC stayed at 0.742-0.752 and calibration held. No real electronic records have been tested.

## Fairness
Group results and trade-offs are in the validation report. Main points:
- Under-45s have a lower bar for Possible, raising caught cases from 69% to 95% (42 cases, range 88-100%).
- The weakest groups are people with hypertension only (67%) and ages 45-64 (71%).
- Performance has been checked by age, sex, ethnicity, income and condition. Small groups have wide uncertainty.

## Known limitations
1. Detects current disease. Follow-up covers deaths only, with 7 kidney deaths, so prediction of new CKD is unproven.
2. One urine sample, so some positives would not persist on repeat testing.
3. US survey data. It needs local validation elsewhere, especially for Asian populations (32 test cases).
4. Weaker in the group it most aims to help. With no diabetes and eGFR ≥60: AUROC 0.71 and 59% of cases caught.
5. Most Likely answers go to people already at obvious risk: 55% have eGFR below 60 and 86% have diabetes. Only 4% have neither.
6. Blank Yes/No answers on the form count as "No".
7. No prospective or clinical evaluation has been done, and no real electronic health records have been tested. FHIR import has only been exercised on synthetic records.

## Privacy
Scoring runs entirely in the browser. The published files contain public-use NHANES data only.

## Authorship
Built by David Wong, with Claude Code as a coding assistant.
