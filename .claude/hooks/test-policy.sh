#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Runs every test-*.js harness in this folder, as test-policy.ps1 does, found by name so a new
# harness needs no edit here. Finding none is a failure: a rename would otherwise leave every hook
# untested.
FAILURES=0
FOUND=0

for harness in "$SCRIPT_DIR"/test-*.js; do
  [ -e "$harness" ] || continue
  FOUND=$((FOUND + 1))
  echo ""
  echo "RUN  $(basename "$harness")"
  if ! node "$harness"; then
    echo "FAIL $(basename "$harness") exited non-zero"
    FAILURES=$((FAILURES + 1))
  fi
done

if [ "$FOUND" -eq 0 ]; then
  echo "No Node hook harness sits beside this script, so every hook is unverified."
  exit 1
fi

if [ "$FAILURES" -ne 0 ]; then
  echo "$FAILURES hook harnesses failed."
  exit 1
fi

echo ""
echo "PASS: hook policy checks succeeded."
