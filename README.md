# LibreNMS NetMap Dashboard Starter

A separate interactive dashboard that uses LibreNMS as the data source.

It gives you:

- Vertical sidebar navigation
- Interactive topology canvas
- UXG-on-edge / Sophos-in-front-of-servers layout hints
- Link utilization labels
- Color-coded links
- Device/link detail drawer
- Local browser layout save after you drag nodes
- Backend API proxy so the LibreNMS token is not exposed in the browser

## LibreNMS data used

The backend calls:

- `/api/v0/devices`
- `/api/v0/resources/links`
- `/api/v0/ports?columns=...`
- `/api/v0/alerts?state=1`

## Install

```bash
unzip librenms-netmap-starter.zip
cd librenms-netmap-starter
chmod +x bootstrap.sh
./bootstrap.sh
```

The first run creates `.env`.

Edit:

```bash
nano .env
```

Set:

```bash
LIBRENMS_URL=https://your-librenms-url
LIBRENMS_TOKEN=your_api_token
```

Then run:

```bash
./bootstrap.sh
```

Open:

```text
http://your-server:8088
```

## LibreNMS API token

In LibreNMS:

```text
LibreNMS Web UI -> /api-access/ -> Create API access token
```

Use a read-only user if possible.

## Layout notes

The first render uses hostname/display-name matching from `.env`:

```bash
EDGE_DEVICE_MATCH=uxg,unifi uxg,gateway
CORE_SWITCH_MATCH=core,switch 1,switch1,main switch
SERVER_FIREWALL_MATCH=sophos,enclave
SERVER_MATCH=librenms,server,vmware,proxmox,esxi,nas
```

Drag devices where you want them. Positions save in the browser's local storage.

## Reverse proxy example

Nginx:

```nginx
server {
    listen 443 ssl;
    server_name netmap.company.local;

    location / {
        proxy_pass http://127.0.0.1:8088;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## Security

Do not put the LibreNMS token into client-side JavaScript. This starter keeps the token in the Node backend and exposes only normalized topology data to the browser.

## GitHub sync

This project is repo-ready.

Do **not** commit `.env`; it contains your LibreNMS API token and is ignored by Git.

From Windows PowerShell:

```powershell
cd C:\temp\librenms-netmap-starter
.\scripts\push-to-github.ps1 -RepoUrl "git@github.com:YOURUSER/librenms-netmap-dashboard.git"
```

From Linux/macOS:

```bash
chmod +x scripts/push-to-github.sh
./scripts/push-to-github.sh git@github.com:YOURUSER/librenms-netmap-dashboard.git
```

More detail:

```text
docs/GITHUB_SYNC.md
docs/DEPLOYMENT.md
```

