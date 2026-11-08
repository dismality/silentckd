# How SilentCKD compares with existing kidney tools

## The short answer
Most well-known kidney risk scores answer a different question, so a direct score-against-score comparison would be misleading. The closest published model estimates the same outcome in the same kind of patients. When we rebuilt its design on our data, SilentCKD was only slightly more accurate: **0.754 vs 0.739 on 2021-23 patients and 0.749 vs 0.730 on the locked 2007-10 patients.**

The bigger differences are practical. SilentCKD does not use race, gives reasons for each patient, works when records are incomplete, and turns the score into a clinic testing list.

## Existing tools
| Tool | What it predicts | Who it was built on | Reported accuracy | Can it be compared directly here? |
|---|---|---|---|---|
| [SCORED](https://www.ncbi.nlm.nih.gov/pubmed/17325299) (Bang 2007) | Low kidney function today (eGFR under 60) | US NHANES 1999-2002, 8,530 people | AUROC 0.88 internally, 0.71 externally | **No.** Different outcome. It also uses urine protein, which is what SilentCKD tries to find without a urine test. |
| [QKidney](https://pmc.ncbi.nlm.nih.gov/articles/PMC2905345) (Hippisley-Cox 2010) | Moderate-severe kidney disease or kidney failure within 5 years | UK primary-care records, ages 35-74 | ROC about 0.88 | **No.** It needs follow-up data, which our survey data lacks, and its outcome is more severe. |
| [CKD Prognosis Consortium equations](https://pubmed.ncbi.nlm.nih.gov/31703124/) (Nelson 2019) | New eGFR under 60 within 5 years | 5.2 million people, 34 cohorts, 28 countries | Reported for each cohort | **No.** Different outcome. Albuminuria is one of its inputs. |
| [Chu et al. 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC10375308) | Albuminuria (ACR 30 or more) | US NHANES 2007-2018 adults with hypertension or diabetes, 13,410 people | C-statistic 0.730 in NHANES, 0.682 in real-world US records | **Yes, closest match.** Same outcome and same type of patients. Built to estimate how much albuminuria goes undetected, not to guide individual patients. |
| [Lin et al. 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC8858816) | Microalbuminuria | One centre in China, 3,294 people | AUROC not reported | **No.** No comparable accuracy measure. |
| [Khitan et al. 2021](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8696217/) | Albuminuria in type 2 diabetes | LOOK AHEAD trial | Machine learning | **No.** It relies on body scans and exercise tests that clinics do not routinely have. |

## Direct test against the closest design
Chu et al. used a logistic regression with age, sex, race, ethnicity, systolic blood pressure, eGFR, diabetes, coronary disease and heart failure. We refitted that design on our 2011-2020 development data and tested it on the same patients as SilentCKD. The script is `src/compare_published.py`.

| | 2021-23 test (n = 2,583) | Locked 2007-10 test (n = 2,469) |
|---|---|---|
| SilentCKD AUROC | **0.754** | **0.749** |
| Published-style model AUROC | 0.739 | 0.730 |
| Gain for SilentCKD (95% CI) | 0.015 (0.000 to 0.030) | 0.019 (0.004 to 0.035) |
| Calibration slope: SilentCKD / published-style | 0.97 / 1.06 | 0.95 / 0.92 |
| Cases found testing 1 in 5: SilentCKD / published-style | 48% / 46% | 47% / 44% |

**What this shows:** the gain is small. On the 2021-23 patients, its confidence interval reaches zero. On the locked test, it stays just above zero. A simple regression gets close, and it would be wrong to claim a big accuracy jump.

**Limits of this test:** it is our approximation of the design, not their published equation. Their study had separate coronary disease and heart failure fields, and ours combines heart disease and stroke history. We chose the spline knots ourselves.

## What SilentCKD adds
1. **No race input.** The closest published model uses race and ethnicity. SilentCKD uses neither, and is slightly more accurate here.
2. **A reason for each patient.** Each answer shows what pushed the chance up or down.
3. **Works with gaps.** A short model takes over when too many blood tests are missing, and we tested messy records.
4. **Built for a decision.** It ranks patients and shows how many cases a clinic can expect to find with the tests it can afford.
5. **A locked second test and 10-year outcomes.** The answer rules were frozen before the 2007-10 test.

## What we should expect in real hospital records
Chu et al. fell from 0.730 in NHANES to 0.682 in real-world US records. SilentCKD could lose a similar amount. In those records, people who get urine tests are already a selected group, and record quality varies. We have not tested SilentCKD on real hospital records, so **the survey results should not be read as hospital performance.** [The deployment plan](deployment_plan.md) makes that test the first step.

## Guidelines
[KDIGO 2024](https://doi.org/10.1016/j.kint.2023.10.018) advises testing people at risk with both eGFR and ACR. SilentCKD does not replace that advice. It helps clinics that cannot reach everyone decide who to test first. [Shin et al. 2021](https://pubmed.ncbi.nlm.nih.gov/34365812/) measured the gap: only 35.1% of people with diabetes and 4.1% with hypertension had ACR testing within two years.
