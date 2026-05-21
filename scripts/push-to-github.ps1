param(
  [Parameter(Mandatory=$true)]
  [string]$RepoUrl,

  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

function Fail($Message) {
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail "Git is not installed or not in PATH."
}

if (Test-Path ".env") {
  Write-Host "Found .env. Good: it is ignored and should not be committed." -ForegroundColor Yellow
}

if (-not (Test-Path ".git")) {
  git init
}

git branch -M $Branch

$ignoredEnv = git check-ignore .env 2>$null
if (-not $ignoredEnv) {
  Fail ".env is not ignored. Refusing to continue."
}

git add .

$staged = git diff --cached --name-only
if ($staged -match "(^|/)\.env$") {
  Fail ".env is staged. Refusing to commit secrets."
}

if (-not $staged) {
  Write-Host "No changes staged. Repository may already be committed." -ForegroundColor Yellow
} else {
  git commit -m "Initial LibreNMS NetMap dashboard"
}

$hasOrigin = git remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0 -or -not $hasOrigin) {
  git remote add origin $RepoUrl
} else {
  git remote set-url origin $RepoUrl
}

git push -u origin $Branch

Write-Host ""
Write-Host "Done. Repo pushed to $RepoUrl on branch $Branch." -ForegroundColor Green
