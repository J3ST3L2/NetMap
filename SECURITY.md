# Security Notes

NetMap talks to LibreNMS through a server-side proxy. The browser does not receive the LibreNMS API token.

## Do not commit secrets

Never commit:

- `.env`
- LibreNMS API tokens
- Internal customer data
- Private infrastructure diagrams that should not be public

## Recommended exposure

Use one of these:

- Internal-only VLAN access
- VPN-only access
- Reverse proxy with authentication
- Firewall allowlist

The starter app does not include user authentication by default.
