# NetMap

Interactive LibreNMS-powered topology dashboard.

NetMap is generalized for enterprise LibreNMS environments, including Juniper/Mist and Aruba switching environments. LibreNMS remains the data source; NetMap is the browser UI.

## What it does

- Pulls devices from LibreNMS
- Pulls discovered LLDP/CDP-style links from LibreNMS
- Pulls real interface counters and utilization
- Classifies common vendors and roles:
  - Juniper / Juniper Mist
  - Aruba / HPE Aruba CX
  - UniFi
  - Sophos
  - core / distribution / access / wireless / server / firewall / edge
- Shows an interactive topology map
- Animates traffic links
- Provides menu panels for Overview, Devices, Interfaces, Links, Alerts, and Settings
- Keeps the LibreNMS API token on the backend

## Quick start

```bash
cp .env.example .env
nano .env
docker compose up -d --build
```

Open:

```text
http://SERVER_IP:8088
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

## Interface data

NetMap exposes interface data at:

```text
/api/interfaces
```

The main topology payload also includes interface rows:

```text
/api/topology
```

## Classification tuning

Edit `.env` to tune classification:

```bash
CORE_SWITCH_MATCH=core,coresw,core-sw,dist,distribution,agg,aggregation,spine
ACCESS_SWITCH_MATCH=access,access-sw,edge-sw,closet,idf,switch,sw-
WIRELESS_MATCH=mist,ap-,aruba ap,access point,wifi,wireless
JUNIPER_MATCH=juniper,ex2300,ex3400,ex4300,ex4400,ex4650,qfx,srx,mist,junos
ARUBA_MATCH=aruba,procurve,hpe,2930,3810,5400,6200,6300,6400,8320,cx
```

## Updating on the server

```bash
cd NetMap
git pull
docker compose up -d --build
```

## Security

Do not commit `.env`.

Put the dashboard behind VPN, internal VLAN access, reverse proxy auth, SSO, or a firewall allowlist before production.
