#!/usr/bin/env bash
# Re-download the two MaleCNS v1.0 tables that build_wiring.py reads (public bucket, no token).
set -euo pipefail
mkdir -p data/connectome
BASE=https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome
for f in body-annotations-male-cns-v1.0-minconf-0.5.feather \
         connectome-weights-male-cns-v1.0-minconf-0.5.feather; do
  curl -fL -C - --retry 3 -o "data/connectome/$f" "$BASE/$f"
done
