# SilentCKD validation report

Everything here can be reproduced with the commands in the [README](../README.md). Raw outputs are in `metrics/`.

## 1. Design
- **Development:** NHANES 2011-2020, n = 10,923, with 5-fold cross-validation.
- **Test:** NHANES 2021-23, n = 2,583, a later period held out from model fitting.
- **Outcome:** urine ACR ≥30 mg/g.
- **Baselines:** logistic regression with the same inputs, logistic regression with 5 inputs, and testing people with diabetes first.

### Disclosure: how the test set was used
The model and all numeric cut-offs were fitted on development data. However, after reviewing 2021-23 results we changed three design choices:
1. "Likely" moved from a 35% to a 50% chance, because 35-50% predictions had only a 39% outcome rate. The value 50% is the plain meaning of "more likely than not" and was not searched for.
2. Age-specific cut-offs for 45-64 and 65+ were dropped, leaving one lower bar for under-45s.
3. A short-form model was added after finding the full model over-predicted when most inputs were blank.

These choices were informed by the test set, so the answer-level results below are **slightly optimistic**. The AUROC and calibration of the full model are unaffected. Section 9 gives a clean estimate of the final rules on a locked dataset.

## 2. Discrimination and calibration (full model, test set)
| Metric | Result |
|---|---|
| AUROC | 0.754 (95% CI 0.730-0.778) |
| Survey-weighted AUROC | 0.765 |
| AUPRC | 0.478 at 19% prevalence |
| Brier score | 0.129 |
| Calibration slope, intercept | 0.97, -0.07 |
| Development out-of-fold AUROC | 0.755 |

Predicted vs observed by risk band:

| Predicted | n | Mean predicted | Observed |
|---|---|---|---|
| 0-10% | 853 | 7.5% | 6.7% |
| 10-20% | 921 | 14.1% | 15.0% |
| 20-35% | 447 | 25.9% | 23.9% |
| 35-50% | 178 | 41.0% | 39.3% |
| 50-70% | 116 | 58.8% | 56.0% |
| 70%+ | 68 | 80.6% | 80.9% |

## 3. Comparison with simpler options
| Model | AUROC |
|---|---|
| XGBoost, 25 inputs | 0.754 |
| Logistic regression, 25 inputs | 0.728 (XGBoost gain 0.026, paired bootstrap 95% CI 0.015-0.037) |
| Logistic regression, 5 inputs | 0.701 (XGBoost gain 0.053, 95% CI 0.039-0.068) |

| Share of patients tested | Cases found: SilentCKD | Cases found: diabetes first |
|---|---|---|
| 10% | 31% | 16% |
| 20% | 48% | 31% |
| 30% | 58% | 47% |
| 50% | 77% | 65% |

With the same 886 tests as diabetes-first, the model finds 63.4% of cases vs 54.5%.

**Context on the comparator:** guidelines already advise testing these groups, so diabetes-first describes a capacity-limited clinic, not the guideline. In practice [only 35.1% of people with diabetes and 4.1% with hypertension had ACR testing within two years](https://pubmed.ncbi.nlm.nih.gov/34365812/), and testing was largely unrelated to predicted risk.

**Against the closest published design:** we refitted the logistic-regression design of Chu et al. 2023, which uses race and ethnicity, on the same development data. It scored AUROC 0.739 on 2021-23 and 0.730 on the locked 2007-10 group. SilentCKD's gain was 0.015 (95% CI 0.000-0.030) and 0.019 (0.004-0.035). The gain is small. See [related work](related_work.md).

## 4. The answers
| Answer | Share of patients | Had albuminuria | Share of all cases | Tests per case found |
|---|---|---|---|---|
| Likely | 7% | 65% | 24% | 1.5 |
| Possible | 47% | 23% | 57% | |
| Likely or Possible | 55% | 28% | 81% | 3.5 |
| Unlikely | 45% | 8% | 19% | |
| Testing everyone | 100% | 19% | 100% | 5.2 |

## 5. Short-form model
Without its own model, feeding only the 11 short-form fields to the full model gave a mean prediction of 27.0% against 19.0% observed. The dedicated model corrects this:

| Scenario | AUROC | Mean predicted | Observed |
|---|---|---|---|
| All short-form fields | 0.749 | 19.8% | 19.0% |
| No HbA1c | 0.740 | 19.6% | 19.0% |
| No blood pressure | 0.723 | 20.7% | 19.0% |
| No creatinine | 0.736 | 20.7% | 19.0% |
| Age, sex and yes/no answers only | 0.696 | 21.9% | 19.0% |

The full model with two labs missing (waist, uric acid) keeps AUROC 0.753.

## 6. The usually-missed group
No diabetes and eGFR ≥60: n = 1,504, 35% of all cases.

| Metric | Result |
|---|---|
| AUROC | 0.706 |
| Prevalence | 12% |
| Cases caught | 59% |
| Patients flagged | 35% |
| Flagged who have albuminuria | 20% |

## 7. Fairness (test set, Likely or Possible answers)
Caught is the share of real cases flagged, with a bootstrap 95% range. False alarms is the share of people without albuminuria who were flagged.

| Group | Value | Cases | Caught | Range | False alarms | Flagged who have it |
|---|---|---|---|---|---|---|
| Age | 20-44 | 42 | 95% | 88-100 | 42% | 24% |
| | 45-64 | 170 | 71% | 64-78 | 36% | 29% |
| | 65+ | 280 | 85% | 80-89 | 60% | 29% |
| Sex | Men | 259 | 82% | 77-86 | 50% | 30% |
| | Women | 233 | 80% | 75-85 | 47% | 26% |
| Ethnicity | Asian | 32 | 75% | 59-88 | 39% | 40% |
| | Black | 91 | 84% | 76-91 | 62% | 29% |
| | Mexican American | 28 | 82% | 68-96 | 54% | 25% |
| | Other Hispanic | 43 | 86% | 74-95 | 48% | 28% |
| | Other / multiracial | 39 | 90% | 79-97 | 51% | 35% |
| | White | 259 | 78% | 73-83 | 45% | 26% |
| Income | Lower | 117 | 85% | 79-91 | 56% | 31% |
| | Middle | 199 | 80% | 74-86 | 52% | 30% |
| | Higher | 102 | 75% | 67-83 | 38% | 22% |
| Condition | Has diabetes | 268 | 93% | 89-96 | 76% | 35% |
| | Hypertension only | 224 | 67% | 61-73 | 37% | 22% |

**Equity experiments**
- Adding race as an input changed AUROC by at most 0.003, so race is left out.
- Moving from the 2009 race-based eGFR equation to the 2021 race-free one reclassified 158 Black participants below 60 (459 to 617).
- Race-specific cut-offs were unstable and are not used.
- A lower bar for under-45s raised caught cases from 69% to 95%. The evidence is only 42 cases, and it adds false alarms at that age.

## 8. Limitations
- Cross-sectional: it identifies current albuminuria, not future onset.
- One urine sample per person. The ACR files in these cycles contain a single measurement, so persistence cannot be checked.
- Survey data, not routine records. Real records will have more errors and more missing values.
- Performance metrics are unweighted unless stated. NHANES oversamples some groups.
- No external dataset from another country, no prospective study and no cost-effectiveness analysis.

## 9. Locked external test (NHANES 2007-2010)
The final models and answer rules were frozen before this data was run. These two cycles were not used to fit a model or choose a rule, and nothing was changed afterwards. This gives the clean estimate of the final rules that the disclosure in section 1 calls for. Script: `src/external.py`; output: `metrics/external.json`.

n = 2,469; 457 cases; prevalence 19%.

| Metric | 2021-23 | 2007-10 (locked) |
|---|---|---|
| AUROC | 0.754 (0.730-0.778) | 0.749 (0.723-0.774) |
| Calibration slope | 0.97 | 0.95 |
| Calibration intercept | -0.07 | -0.17 |
| Mean predicted vs observed | 19 vs 19 | 20 vs 19 |
| Cases caught (Likely or Possible) | 81% | 82% |
| Patients flagged | 55% | 58% |
| Likely: share, had albuminuria | 7%, 65% | 6%, 62% |
| Possible: share, had albuminuria | 47%, 23% | 51%, 22% |
| Unlikely: share, had albuminuria | 45%, 8% | 42%, 8% |
| Cases found testing 1 in 5 (SilentCKD vs diabetes first) | 48% vs 31% | 47% vs 31% |

Cases caught by group (2007-10): 20-44 87% (54 cases), 45-64 66% (143), 65+ 89% (260), women 80%, men 83%, Black 86%, White 78%, Mexican American 85%, diabetes 93%, hypertension only 70%. The older race variable has no separate Asian group, so this test adds nothing for Asian patients.

**Limit:** this is the same survey programme, from an earlier period. It tests stability, not transport to another health system.

## 10. Long-term outcomes (linked mortality through 2019)
The 2007-2010 participants linked to the National Death Index public-use files: n = 2,466, 555 deaths, median follow-up 9.8 years. Cox models adjust for age and sex. Results are unweighted.

| Answer | 10-year deaths per 100 | Age/sex-adjusted hazard ratio vs Unlikely |
|---|---|---|
| Likely | 58 | 4.20 (3.15-5.59) |
| Possible | 28 | 1.72 (1.38-2.15) |
| Unlikely | 11 | reference |

| Population | Outcome | Flagged vs Unlikely HR | Per SD of score HR |
|---|---|---|---|
| Everyone | All-cause (555) | 1.95 (1.57-2.42) | 1.52 (1.41-1.64) |
| Everyone | Heart, stroke, diabetes or kidney (213) | 2.63 (1.76-3.92) | 1.70 (1.52-1.91) |
| Urine normal today (n = 2,010) | All-cause | 1.67 (1.30-2.14) | |
| Urine normal today | Heart, stroke, diabetes or kidney | 2.33 (1.47-3.70) | |
| ACR <30 and eGFR ≥60 today (n = 1,765) | All-cause | 1.56 (1.20-2.03) | |
| ACR <30 and eGFR ≥60 today | Heart, stroke, diabetes or kidney (95) | 2.30 (1.42-3.74) | 1.81 (1.41-2.31) |

**How to read this:** the score carries long-term information, including in people with no detectable kidney disease that day. **It is not evidence of predicting incident CKD.** Public mortality files have no kidney outcomes, only 7 deaths were coded as kidney disease, and the score is partly a general-health signal.

## 11. Messy-record simulation
The 2021-23 test set was degraded to resemble routine records (10 random seeds per scenario). Simulated, not real EHR data.

| Scenario | AUROC | Mean predicted (observed 19) | Caught | Flagged |
|---|---|---|---|---|
| Clean research data | 0.754 | 20 | 81% | 55% |
| Many tests missing | 0.747 | 20 | 85% | 64% |
| Single rounded BP, noisier labs | 0.748 | 20 | 80% | 55% |
| 15% of diagnoses and medicines unrecorded | 0.752 | 19 | 80% | 54% |
| All together | 0.742 | 20 | 83% | 61% |

With many tests missing, about 95% of patients are routed to the short-form model.

## 12. Health-record format test
`demo/fhir.js` reads FHIR R4 Patient, Observation, Condition and MedicationRequest resources using LOINC codes and medicine and diagnosis names, keeping results from the 3 years before each patient's latest measurement. On 112 third-party synthetic Synthea records (Apache-2.0) it kept 25 eligible patients and left out 12 deceased, 25 under 20 and 50 outside the target group. It rejected one impossible HbA1c. This shows the format can be read. **Synthetic records say nothing about accuracy.**

## 13. Further validation needed
1. Validate on real electronic records from a health system, including local missingness and case mix.
2. Follow patients prospectively for new CKD, with confirmed repeat ACR.
3. Obtain clinician review of the answers and workflow, then run a small pilot.
4. Replace the example test price with local costs.

The stages and pass marks are in the [deployment plan](deployment_plan.md).
