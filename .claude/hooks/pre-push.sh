#!/bin/sh
# guard pre-push: installed by .claude/hooks/install-git-hooks.ps1
# Runs pre-push-save.js from the working tree, so an edit to it needs no new install, then
# `git lfs pre-push` when git-lfs is installed. A save that cannot run lets the push go ahead; an LFS
# upload that fails stops it, and so does a missing git-lfs where the repository tracks LFS content.
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
lines=$(cat)
if [ -f "$root/.claude/hooks/pre-push-save.js" ]; then
  printf '%s\n' "$lines" | node "$root/.claude/hooks/pre-push-save.js" "$@" ||
    echo "pre-push: the save of the shared branch did not run, so the push goes ahead unsaved." >&2
fi
if [ -n "$lines" ]; then
  if command -v git-lfs >/dev/null 2>&1; then
    printf '%s\n' "$lines" | git lfs pre-push "$@" || exit $?
  elif git -C "$root" grep -q 'filter=lfs' -- '*.gitattributes' 2>/dev/null ||
    grep -qs 'filter=lfs' "$(git rev-parse --path-format=absolute --git-common-dir)/info/attributes"; then
    echo "pre-push: this repository tracks LFS content, but git-lfs is not installed, so the push stops. Install Git LFS and push again." >&2
    exit 1
  fi
fi
exit 0
