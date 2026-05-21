# Testing

## Test with mock data

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

## Test live LibreNMS data

Set:

```bash
MOCK_MODE=false
LIBRENMS_URL=https://your-librenms-url
LIBRENMS_TOKEN=your_token
```

Then:

```bash
docker compose up -d --build
```

Open:

```text
http://localhost:8088/api/topology
```

You should see JSON with:

- `devices`
- `links`
- `ports`
- `summary`

## Common issues

### Devices load but links are empty

Enable LLDP/CDP on switches, UXG, and other network gear where supported.

### Self-signed TLS error

Set:

```bash
ALLOW_SELF_SIGNED_LIBRENMS=true
```

### No API data

Check:

```bash
curl http://localhost:8088/api/health
```
