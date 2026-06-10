#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npx --yes eyeling --rdf --stream-messages \
  rules/owl2rl-eyeling.n3 \
  ontologies/transit.n3 \
  rules/stream-enrichment.n3 \
  rules/example-output.n3 \
  examples/input/messages.trig
