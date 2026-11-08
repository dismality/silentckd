# SilentCKD submission kit

Text to paste into Devpost, an explanation of the numbers, likely questions, and a demo script. Items in [square brackets] are for you to fill in.

**Live demo:** https://silentckd.davidwong51423.workers.dev (public, hosted on Cloudflare)
**Slides:** https://claude.ai/artifact/FbHEYsrXp2LU2ZRkp5Nb7W (private until shared. Can be downloaded as PowerPoint.)

## Before you submit
1. Open the slides' **Share** menu and make them viewable by anyone with the link. The live demo is already public.
2. Replace `[confirm team]` on the last slide, and fill in the team section below.
3. Confirm the deadline with the organisers. The site says final submission is 25 Nov 2026, but its timeline shows Round 2 running until 25 Nov and closing on 30 Nov.
4. Upload the code to GitHub (steps are in the README), and give the organisers that link plus `docs/model_card.md`, `docs/validation_report.md`, `docs/related_work.md` and `docs/deployment_plan.md` wherever they ask.

## Devpost sections

### Title
SilentCKD: finding hidden kidney damage before anyone orders the test

### Overview
SilentCKD helps clinics decide who to send for a urine kidney test first. For adults with diabetes or high blood pressure, it gives one direct answer (Likely, Possible or Unlikely), the chance in 100, and the reasons in plain language. It ranks a whole clinic from a CSV or FHIR health-record export, and shows how many cases a clinic can expect to find with the tests it can afford. Everything runs in the browser.

### Problem statement
Early chronic kidney disease has no symptoms. A cheap urine test (ACR) finds it, but a large US study found only 35.1% of people with diabetes and 4.1% with hypertension were tested within two years (Shin et al., Hypertension, 2021). Testing was largely unrelated to a patient's risk. In our data, 35 in 100 hidden cases were in people with no diabetes and a normal kidney blood test, who usual practice has little reason to test.

### Solution and methodology
We used CDC NHANES public data on adults aged 20+ with diabetes or hypertension. The outcome was urine ACR of 30 mg/g or more, and no urine values were used as inputs.

An XGBoost model with monotone constraints uses 25 routine inputs. An 11-input short model handles records with many blanks. Race is not an input, and eGFR uses the race-free 2021 equation. Exact TreeSHAP explanations run in the browser and are grouped into plain-language topics.

The model was developed on 2011-2020 data (n = 10,923) and tested on 2021-23 (n = 2,583). We adjusted the answer rules after viewing 2021-23 results and disclosed this, so we then froze everything and ran a second test on 2007-2010 (n = 2,469).

### Demonstration
- **Check a patient:** change any detail and watch the chance and the answer update.
- **Clinic list:** a ranked list with the patients usual practice would skip, CSV or FHIR R4 upload, a test planner, and a downloadable list.
- **Is it accurate and fair?:** all results, including where it is weak.

### Impact and validation
| | 2021-23 | 2007-10 locked |
|---|---|---|
| AUROC | 0.754 (0.730-0.778) | 0.749 (0.723-0.774) |
| Calibration slope | 0.97 | 0.95 |
| Hidden cases caught | 81% | 82% |
| Likely answers correct | 65% | 62% |
| Cases found testing 1 in 5, vs diabetes first | 48% vs 31% | 47% vs 31% |

Through linked death records (n = 2,466, median 9.8 years), 10-year deaths per 100 were 58 for Likely, 28 for Possible and 11 for Unlikely. Among people with normal urine and kidney blood tests that day, flagged patients had 2.3 times the risk of heart, stroke, diabetes or kidney death, adjusted for age and sex (95% CI 1.42-3.74). With only 7 kidney deaths, we make no kidney-specific claim.

In a simulation of messy records, AUROC stayed between 0.742 and 0.752, and calibration held.

Limits: SilentCKD finds damage already present, and prediction of new CKD is unproven. It has been tested on US survey data, not real hospital records. Its FHIR reader has only been run on synthetic records. It is a prototype and not a medical device.

### Team contributions
- David Wong: [confirm: problem choice, data, modelling, validation, website, presentation]
- [Other team members and their contributions, if any]
- Claude Code was used as a coding assistant.

## The numbers, in plain words
| Term | What to say |
|---|---|
| Albuminuria / ACR | Protein leaking into urine, an early sign of kidney damage. ACR is the urine test that measures it. |
| eGFR | Kidney function estimated from the blood test creatinine. It can stay normal while damage has begun. |
| AUROC 0.75 | Pick one patient with damage and one without. About 3 times in 4, the one with damage gets the higher score. |
| Calibration | Whether the percentages are honest. If it says 20 in 100, about 20 in 100 really have it. A slope of 1.0 is ideal. |
| Caught (sensitivity) | Of people who really have damage, the share who got Likely or Possible. |
| Flagged | The share of all patients who got Likely or Possible. |
| Cut-offs | Likely is 50% or more, because that means more likely than not. Possible is about 13% or more, set on development data to catch most cases. Under 45s have a lower bar. |
| SHAP | A way of working out how much each input pushed this patient's score up or down. |
| Hazard ratio 2.3 | At any point in follow-up, that group's risk of the event was 2.3 times the other group's. |
| Monotone constraint | A rule that stops the model learning backwards medicine, such as "higher blood pressure lowers risk". |

## Likely judge questions
**Why not just test everyone?**
Guidelines already call for that in diabetes, and only 35% get it. In hypertension it's 4%. When capacity is limited, order decides who gets found.

**Is 0.75 good enough?**
It's a triage tool, not a diagnosis, and a false alarm costs one cheap urine test. The practical result is finding 48 in 100 cases rather than 31 with the same number of tests.

**Does it predict future disease? The brief says "developing".**
Not proven. It finds damage already present, which is the earliest stage clinics can act on. Public data has no follow-up urine tests, so we used linked death records as the closest evidence. Flagged patients with normal tests that day did worse over 10 years, but that's a long-term signal and not proof of predicting new CKD.

**You changed rules after seeing the test set. Doesn't that invalidate it?**
That's why we disclosed it and ran a second test on 2007-2010 with everything frozen first. Results matched: 62% vs 65% of Likely answers were right, and 82% vs 81% of cases were caught.

**NHANES isn't an EHR.**
Correct, and it's our largest limit. We simulated messy records, built FHIR import, and included a retraining script. The next step is validation on one health system's records.

**Why XGBoost instead of something simpler?**
It beat logistic regression with the same inputs by 0.026 AUROC, with a confidence interval that excludes zero (0.015-0.037). Monotone constraints and exact SHAP keep it explainable.

**How does it compare with existing kidney scores?**
Most, like SCORED and QKidney, predict something different or need urine results, so comparing scores directly would mislead. The closest is Chu et al. 2023. We rebuilt its design on our data and SilentCKD scored 0.754 vs 0.739, and 0.749 vs 0.730 on the locked test. That's a small gain, and we say so. The real differences are no race input, a reason for each patient, handling of gaps, and a clinic testing list.

**How would a hospital actually use it?**
Our deployment plan goes from clinician review, to testing on the hospital's past records, a silent run, then a small pilot, with pass marks at each stage. Regulatory status still needs a formal review, and we plan as if it may be a medical device.

**Isn't it just finding old, sick people?**
Partly. Most Likely answers go to obvious risk: 55% have low eGFR and 86% have diabetes. So we report the harder group separately: with no diabetes and normal eGFR, it catches 59 in 100 cases, and flagged patients have damage 20 times in 100 against 12 at random.

**Is it fair?**
Race isn't an input, and eGFR is race-free. We report results by age, sex, ethnicity, income and condition. The weakest are hypertension-only patients and ages 45-64, and Asian results have a wide range because there were only 32 cases.

**Why did 45-64 year olds do worse?**
They have a standard bar, while under-45s have a lower one. We report it openly and would address it with local data in a validation study.

## Two-minute demo script
| Time | Show | Say |
|---|---|---|
| 0:00 | Home | "Early kidney damage has no symptoms. A cheap urine test finds it, but only 4 in 100 people with high blood pressure get one in two years." |
| 0:20 | Home example | "SilentCKD gives a clinic one direct answer per patient, using data it already has." |
| 0:35 | Check a patient, change blood pressure | "Change a detail and the chance updates. It shows the reasons in plain words, not jargon." |
| 0:55 | Clinic list | "Here's a whole clinic ranked. These are patients with no diabetes and a normal blood test, who usual practice would skip." |
| 1:10 | Drag the planner | "Tell it how many tests you can afford. It estimates how many cases you'd find, compared with testing diabetes first." |
| 1:25 | Accurate and fair, locked test | "We froze everything and tested it again on separate patients. The results held." |
| 1:40 | Ten-year card, then limits | "Flagged patients did worse over 10 years. We also show where it's weak, and it still needs testing on real hospital records." |
| 1:55 | Close | "More hidden kidney damage found, with the tests clinics can already afford." |
