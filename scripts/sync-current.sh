#!/usr/bin/env bash
set -euo pipefail

MESSAGE="${1:-Update NetMap dashboard UI}"

if [ ! -d ".git" ]; then
  echo "Run this from the repo root." >&2
  exit 1
fi

git status

git add .

if git diff --cached --quiet; then
  echo "No changes staged."
  exit 0
fi

if git diff --cached --name-only | grep -E '(^|/)\.env$' >/dev/null 2>&1; then
  echo ".env is staged. Refusing to commit secrets." >&2
  exit 1
fi

git commit -m "$MESSAGE"
git push

echo "Synced changes to GitHub."
