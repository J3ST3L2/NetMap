# NetMap

Interactive LibreNMS-powered topology dashboard.

This dashboard is designed for a layout where the **UXG is on the edge** and **Sophos sits in front of the server zone**. LibreNMS remains the data source; NetMap is the custom browser UI.

## What it does

- Pulls devices from LibreNMS
- Pulls discovered LLDP/CDP-style links from LibreNMS
- Pulls port counters and utilization
- Shows a browser-based topology map
- Animates traffic links
- Provides a vertical sidebar UI
- Keeps the LibreNMS API token on the backend
- Supports mock/demo mode for UI testing without LibreNMS access

## Quick start with Docker

```bash
cp .env.example .env
nano .env
docker compose up -d --build
```

Open:

```text
http://SERVER_IP:8088
```

## Local test mode

To test the UI without LibreNMS:

```bash
cp .env.example .env
```

Set:

```bash
MOCK_MODE=true
```

Then:

```bash
docker compose up -d --build
```

Open:

```text
http://localhost:8088
```

## Live LibreNMS mode

Set:

```bash
MOCK_MODE=false
LIBRENMS_URL=https://your-librenms-url
LIBRENMS_TOKEN=your_librenms_api_token
```

If LibreNMS uses a self-signed certificate:

```bash
ALLOW_SELF_SIGNED_LIBRENMS=true
```

## API endpoints used

- `/api/v0/devices`
- `/api/v0/resources/links`
- `/api/v0/ports?columns=...`
- `/api/v0/alerts?state=1`

## Development workflow

```bash
git checkout -b ui-dev
# edit files
git add .
git commit -m "Improve dashboard UI"
git push -u origin ui-dev
```

For direct testing on main:

```bash
git add .
git commit -m "Build v2 interactive dashboard UI"
git push
```

## Security

Do not commit `.env`.

Put the dashboard behind one of these before production:

- VPN-only access
- Internal VLAN only
- Reverse proxy auth
- SSO
- Firewall allowlist
