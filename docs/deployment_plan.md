# SilentCKD deployment plan

How SilentCKD would move from this prototype into a real clinic. **Today it is a prototype. It has not been tested on real hospital records, and it should not be used for real patient care.**

The numeric targets below are proposals, to be agreed with the clinical lead at each site. The legal sections are a starting point and need review by a qualified adviser.

## 1. Who uses it, and for what
- **Users:** doctors, nurses and care teams. It is not a tool for patients to use on their own.
- **Patients:** adults aged 20+ with diabetes or high blood pressure who have no recent urine ACR test.
- **Decision:** who to send for a urine ACR test first.
- **Rule that never changes:** guidelines advise testing these patients. SilentCKD sets the order when a clinic cannot reach everyone. **An "Unlikely" answer is never a reason to withhold a test someone is due.**

## 2. How it fits into the clinic's week
1. The clinic exports its diabetes and hypertension list as FHIR or CSV.
2. SilentCKD ranks patients with no recent ACR and shows the reasons.
3. A nurse or doctor reviews the list and removes anyone it does not suit.
4. The clinic sets how many tests it can afford. The top patients get an ACR order or an invitation.
5. A positive result is **repeated to confirm** and handled under the clinic's usual kidney care.
6. Results go back into the monitoring table in section 4.

A later version could sit inside the record system through SMART on FHIR, so staff do not need to export files.

## 3. Rollout in stages
Each stage must pass before the next one starts.

| Stage | What happens | Move on only if |
|---|---|---|
| **0. Clinical review** | Kidney and primary-care doctors review the answers, reasons and workflow. | They agree it is safe and useful, and any changes are made. |
| **1. Test on past records** | Run it on at least 12 months of the site's records, among patients who had an ACR test. | It finds more cases than the clinic's current order for the same number of tests. Calibration slope is 0.8 to 1.2 after local adjustment. No age, sex, ethnicity or condition group is caught more than 15 points below the overall rate. |
| **2. Silent run** | Run for 3 months with staff unable to see the scores. Compare with what actually happened. | Data feeds are reliable, and stage 1 results hold. |
| **3. Small pilot** | One or two clinics use it, with a sample of "Unlikely" patients also tested. | More cases are found per 100 tests, staff accept the workload, and no safety concerns arise. |
| **4. Wider use** | Add clinics one at a time, each repeating stage 1. | Monitoring in section 4 stays within limits. |

**Expect a drop at stage 1.** The closest published model fell from 0.730 to 0.682 when moved from NHANES to real-world records ([details](related_work.md)). That is why the main target is finding more cases than current practice, not reaching a fixed AUROC.

## 4. Monitoring
Review every quarter. The clinical lead owns this review.

| Check | Why it matters | Act if |
|---|---|---|
| Share of each input missing | A broken feed or lab change quietly harms accuracy. | Any input changes by more than 10 points. |
| Predicted vs actual rate, by answer group | Shows whether the percentages are still honest. | Slope falls outside 0.8 to 1.2, or the overall rate is off by more than 3 points, for two quarters. |
| Cases found per 100 tests | The main measure of benefit. | It falls to the level of the clinic's previous order. |
| Results by age, sex, ethnicity, condition | Catches unfair drift. | A group falls more than 15 points below overall. |
| Tests ordered and completed | A list nobody acts on helps nobody. | Fewer than half of invited patients complete a test. |
| Staff overrides and reasons | Shows where the tool is not trusted or is wrong. | One reason keeps repeating. |

**The blind spot:** only people who get tested have results, so a model can look better than it is. To check this, each clinic also tests a small random sample of "Unlikely" patients. A site-specific sample size is set at stage 1.

## 5. Updating the model
1. **Recalibrate first.** If the percentages drift but ranking holds, adjust them on local data.
2. **Retrain only if ranking has dropped.** `src/retrain.py` retrains on new data and sets cut-offs on the training part only.
3. **Repeat testing after any change.** Every version is numbered and archived, with the date it was active, so past decisions can be traced.
4. **Watch for outside changes:** a new lab method, eGFR equation, medicine or guideline can each change the model's behaviour.
5. **Stop rule:** if a serious safety issue appears, turn it off and return to the clinic's previous process.

## 6. Risks and safeguards
| Risk | Safeguard |
|---|---|
| False reassurance from "Unlikely" | The rule in section 1, plain wording on the answer, and random testing of "Unlikely" patients. |
| A low kidney blood test receives "Unlikely" | The site already sends these patients for doctor review regardless of the score. |
| Too many false alarms | The clinic sets how many tests to run. A false alarm costs one cheap urine test. |
| Weaker results in some groups | Known weak spots: ages 45-64, hypertension only. Group results are checked at every stage. |
| Staff over-trust the number | Reasons are shown, and a clinician reviews every list. |
| Works only on survey data | Stage 1 tests it on the site's own records. |

## 7. Privacy and security
**The public site is for demonstration only.** Files are read in the browser and are not sent to a server by the site's code. That lowers exposure, but it is not a full privacy assessment, and the site's hosting provider still sees ordinary web traffic details such as addresses and page requests.

A real rollout needs:
- Hosting approved by the site, ideally inside its own network.
- Staff sign-in, role-based access, audit logs and encrypted storage for any saved list.
- A data-protection assessment before any real patient data is used.
- **United States (HIPAA):** treat records as protected health information. Any vendor handling them needs a business associate agreement.
- **Singapore (PDPA):** check the legal basis for using patient data, protection and retention duties, and any transfer outside Singapore. Public healthcare institutions may have separate rules.
- Fairness data such as ethnicity should be used for checking results only. The model does not use it as an input.

## 8. Medical-device status
**SilentCKD's regulatory status has not been determined. Plan as if it may be a medical device until a regulator or qualified adviser says otherwise.**

- **United States:** the FDA's [January 2026 clinical decision support guidance](https://www.cov.com/en/news-and-insights/insights/2026/01/5-key-takeaways-from-fdas-revised-clinical-decision-support-cds-software-guidance) applies four tests for software to fall outside device rules. One is that professionals can independently review the basis for a recommendation. A machine-learning score may struggle with this, even with reasons shown.
- **Singapore:** HSA [treats decision support based solely on established clinical guidelines as non-device](https://www.hsa.gov.sg/announcements/update-for-guidelines-on-risk-classification-of-samd-and-qualification-of-clinical-decision-support-software--cdss-/). SilentCKD is a trained model, so it should not rely on that exclusion. [HSA's software guidance](https://www.hsa.gov.sg/medical-devices/guidance-documents/) (GL-04 life cycle, GL-07 risk classification, GN-37 change management for machine-learning software) is the place to start.
- **Any market:** keep the intended use narrow, as in section 1. Changing it, for example to diagnosis or patient self-use, would change the assessment.

## 9. Costs to work out for each site
Hosting the current site is a small cost. The real costs are below, and each needs local figures:
- Linking to the record system
- Clinician time for review, validation and monitoring
- ACR tests, including random checks of "Unlikely" patients
- Follow-up care for newly found patients
- Regulatory and privacy review

The test price in the website's planner is only an example, and should be replaced with the local price.
