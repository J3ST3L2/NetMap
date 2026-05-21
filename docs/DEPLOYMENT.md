# Deployment

## Docker Compose

```bash
cp .env.example .env
nano .env
docker compose up -d --build
```

Open:

```text
http://SERVER_IP:8088
```

## Required `.env`

```bash
LIBRENMS_URL=https://your-librenms-url
LIBRENMS_TOKEN=your_librenms_api_token
PORT=8088
```

If LibreNMS uses an internal/self-signed certificate:

```bash
ALLOW_SELF_SIGNED_LIBRENMS=true
```

## Reverse proxy

Nginx example:

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

## Updating after a Git pull

```bash
git pull
docker compose up -d --build
```

## Troubleshooting

Check container logs:

```bash
docker compose logs -f librenms-netmap
```

Test app health:

```bash
curl http://localhost:8088/api/health
```

If the API fails, check:

- `LIBRENMS_URL`
- `LIBRENMS_TOKEN`
- Firewall rules between dashboard server and LibreNMS
- Self-signed cert setting
