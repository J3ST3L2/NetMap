# Testing NetMap

## Health

```bash
curl -s http://localhost:8088/api/health
```

## Topology summary

```bash
curl -s http://localhost:8088/api/topology | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['summary'], indent=2)); print('mode:', d['mode']); print('source:', d['source'])"
```

## Interfaces

```bash
curl -s http://localhost:8088/api/interfaces | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['summary'], indent=2))"
```

## Top busy interfaces

```bash
curl -s http://localhost:8088/api/interfaces | python3 -c "import sys,json; d=json.load(sys.stdin); ports=sorted(d['interfaces'], key=lambda p:p.get('utilPct',0), reverse=True)[:10]; [print(f\"{p.get('device_label')} {p.get('name')} {p.get('ifOperStatus')} {p.get('speedLabel')} {p.get('utilPct'):.2f}% down={p.get('inMbps'):.2f} up={p.get('outMbps'):.2f}\") for p in ports]"
```

## Links

```bash
curl -s http://localhost:8088/api/links | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f\"{l.get('localDeviceLabel')}:{l.get('localPortName')} -> {l.get('remoteDeviceLabel')}:{l.get('remotePortName')} {l.get('utilPct'):.2f}%\") for l in d['links']]"
```

## If devices appear but links are empty

Enable LLDP/CDP on the switches/firewalls and confirm LibreNMS has discovered neighbors.
