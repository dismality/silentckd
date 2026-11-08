#!/usr/bin/env bash
# Downloads NHANES public-use files (CDC) used by SilentCKD into data/raw/
set -u
BASE="https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public"
COMPONENTS="DEMO BMX BIOPRO ALB_CR GHB DIQ BPQ MCQ KIQ_U SMQ TCHOL HDL"
fetch() { # year file
  local out="data/raw/$2.xpt"
  [ -s "$out" ] && return
  code=$(curl -s -L -o "$out" -w "%{http_code}" "$BASE/$1/DataFiles/$2.xpt")
  if [ "$code" != "200" ] || head -c 6 "$out" | grep -qi "<"; then echo "MISSING $1 $2 ($code)"; rm -f "$out"; else echo "ok $2"; fi
}
for pair in 2011:_G 2013:_H 2015:_I; do
  y=${pair%%:*}; s=${pair##*:}
  for c in $COMPONENTS BPX; do fetch $y "$c$s"; done
done
for c in $COMPONENTS BPXO; do fetch 2017 "P_$c"; done
for c in $COMPONENTS BPXO; do fetch 2021 "${c}_L"; done

# untouched earlier cycles, used only for external testing (src/external.py)
for pair in 2007:_E 2009:_F; do
  y=${pair%%:*}; s=${pair##*:}
  for c in $COMPONENTS BPX; do fetch $y "$c$s"; done
done
# NCHS public-use linked mortality files, follow-up through 31 Dec 2019
MORT="https://ftp.cdc.gov/pub/Health_Statistics/NCHS/datalinkage/linked_mortality"
for y in 2007_2008 2009_2010; do
  out="data/raw/NHANES_${y}_MORT_2019_PUBLIC.dat"
  [ -s "$out" ] || curl -s -L -o "$out" "$MORT/NHANES_${y}_MORT_2019_PUBLIC.dat"
  echo "ok $out"
done
