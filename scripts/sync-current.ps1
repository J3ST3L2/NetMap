param(
  [string]$Message = "Update NetMap dashboard UI"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path ".git")) {
  throw "Run this from the repo root."
}

git status

git add .

$staged = git diff --cached --name-only
if (-not $staged) {
  Write-Host "No changes staged."
  exit 0
}

if ($staged -match "(^|/)\.env$") {
  throw ".env is staged. Refusing to commit secrets."
}

git commit -m $Message
git push

Write-Host "Synced changes to GitHub." -ForegroundColor Green
