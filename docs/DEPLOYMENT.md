# Deployment

## Docker Compose

```bash
cp .env.example .env
nano .env
docker compose up -d --build
```

## Update from GitHub

```bash
cd NetMap
git pull
docker compose up -d --build
```

## Logs

```bash
docker compose logs -f librenms-netmap
```

## Health check

```bash
curl http://localhost:8088/api/health
```

## Reverse proxy example

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
