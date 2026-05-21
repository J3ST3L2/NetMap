# Security Notes

This project talks to LibreNMS through a server-side proxy.

## Do not commit secrets

Never commit:

- `.env`
- LibreNMS API tokens
- Internal hostnames you do not want published
- VPN URLs, private IP diagrams, or customer data

The repository intentionally tracks `.env.example` only.

## Recommended production exposure

Use one of these:

- Internal-only VLAN access
- VPN-only access
- Reverse proxy with SSO/basic auth
- Firewall allowlist

The starter app does not include user authentication by default.

## LibreNMS token

Create a dedicated LibreNMS API token for this dashboard. Use a read-only/least-privilege user when possible.
