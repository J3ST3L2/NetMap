#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${1:-}"
BRANCH="${2:-main}"

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

if [ -z "$REPO_URL" ]; then
  echo "Usage:"
  echo "  ./scripts/push-to-github.sh git@github.com:YOURUSER/librenms-netmap-dashboard.git [branch]"
  exit 1
fi

command -v git >/dev/null 2>&1 || fail "Git is not installed."

if [ -f ".env" ]; then
  echo "Found .env. Good: it is ignored and should not be committed."
fi

if [ ! -d ".git" ]; then
  git init
fi

git branch -M "$BRANCH"

if ! git check-ignore .env >/dev/null 2>&1; then
  fail ".env is not ignored. Refusing to continue."
fi

git add .

if git diff --cached --name-only | grep -E '(^|/)\.env$' >/dev/null 2>&1; then
  fail ".env is staged. Refusing to commit secrets."
fi

if git diff --cached --quiet; then
  echo "No changes staged. Repository may already be committed."
else
  git commit -m "Initial LibreNMS NetMap dashboard"
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

git push -u origin "$BRANCH"

echo
echo "Done. Repo pushed to $REPO_URL on branch $BRANCH."
