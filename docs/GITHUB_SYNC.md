# Syncing to GitHub

## 1. Create a new GitHub repo

Create an empty repo, for example:

```text
librenms-netmap-dashboard
```

Do **not** add a README, `.gitignore`, or license from GitHub if you want the first push to be clean.

## 2. Push from Windows PowerShell

From the extracted project folder:

```powershell
cd C:\temp\librenms-netmap-starter
.\scripts\push-to-github.ps1 -RepoUrl "git@github.com:YOURUSER/librenms-netmap-dashboard.git"
```

HTTPS example:

```powershell
.\scripts\push-to-github.ps1 -RepoUrl "https://github.com/YOURUSER/librenms-netmap-dashboard.git"
```

## 3. Push from Linux/macOS

```bash
cd librenms-netmap-starter
chmod +x scripts/push-to-github.sh
./scripts/push-to-github.sh git@github.com:YOURUSER/librenms-netmap-dashboard.git
```

## 4. Verify secrets are not staged

Before pushing, run:

```bash
git status
git diff --cached --name-only
```

You should not see `.env`.

## 5. Bring it into work

On the work server:

```bash
git clone git@github.com:YOURUSER/librenms-netmap-dashboard.git
cd librenms-netmap-dashboard
cp .env.example .env
nano .env
./bootstrap.sh
```

Or with HTTPS:

```bash
git clone https://github.com/YOURUSER/librenms-netmap-dashboard.git
```
