#!/usr/bin/env bash
set -euo pipefail

echo "This script performs a git-preserving move of key top-level folders into server/ and updates textual references."
echo "Run this from the repository root. Commit or stash any local changes before running."

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree not clean; please commit or stash changes first." >&2
  git status --porcelain
  exit 1
fi

BRANCH=refactor/move-server-root
echo "Creating branch ${BRANCH}..."
git checkout -b ${BRANCH}

mkdir -p server

move_if_exists() {
  src="$1"
  dst="server/$1"
  if [ -d "$src" ]; then
    echo "Moving $src -> $dst"
    git mv "$src" "$dst"
  else
    echo "Skipping $src (not found)"
  fi
}

move_if_exists backend
move_if_exists operator-ui
move_if_exists operator-dashboard
move_if_exists config

echo "Searching repository for textual references to update..."

declare -a PAIRS=(
  "backend/" "server/backend/"
  "operator-ui/" "server/operator-ui/"
  "operator-dashboard/" "server/operator-dashboard/"
  "config/" "server/config/"
)

for ((i=0;i<${#PAIRS[@]}; i+=2)); do
  from=${PAIRS[$i]}
  to=${PAIRS[$i+1]}
  # Find files (text) containing the pattern
  files=$(git grep -Il --exclude-dir=.git -- "${from}" || true)
  if [ -n "$files" ]; then
    echo "Patching references: ${from} -> ${to}"
    while IFS= read -r f; do
      # Use perl to do a global and safe in-place replacement
      perl -0777 -pe "s|\Q${from}\E|${to}|g" -i "$f"
      git add "$f"
    done <<< "$files"
  fi
done

git add server || true
git commit -m "refactor: move backend and operator-ui into server/ (preserve history) and update references" || {
  echo "Nothing to commit or commit failed.";
}

echo
echo "Move complete on branch ${BRANCH}."
echo "Verify changes, run tests, then push:"
echo "  git push -u origin ${BRANCH}"
