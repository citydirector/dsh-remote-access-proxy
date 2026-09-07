# dsh-remote-access-proxy

[English](README.md) · [简体中文](README.zh-CN.md)

A remote-access proxy for the DSH (DeepSeek Harness) Web GUI — a host-plane plugin
that embeds a reverse proxy to safely expose the DSH Web GUI and its `/api` to any
remote front (easytier, ZeroTier, Tailscale, nginx, Caddy, Cloudflare Tunnel, or a
plain LAN IP), and automatically bridges the per-process launch-token auth of newer
DSH builds.

- Server plugin `plugin/dsh-remote-access-proxy.mjs` — the gate + forward server, starts/stops with DSH
- Web configuration card `ui/` — Settings → 插件配置 → 远程访问代理 (client package)
- Verification harness `test-remote-access-proxy.mjs` — end-to-end tests against a mock DSH

## Why

Newer DSH authenticates every browser session with two layers:

1. **Host/Origin trust fence**: `/api` accepts only a loopback Host or explicit
   `trustedHosts`, and a matching same-origin `Origin`;
2. **Browser-session auth**: every process start generates a random `launchToken`
   (`http://127.0.0.1:3080/?token=…`); `/api` without a valid `dsh-auth-*` signed
   cookie answers 401.

This plugin forwards requests to DSH as loopback (Host rewritten to `127.0.0.1:3080`,
Origin stripped) and **performs the token exchange itself, holding the `dsh-auth-*`
cookie** — so remote users only need the random path + HttpOnly-cookie gate and
**never need to know the per-start launchToken**.

## Security model

Access control is fully carried by the proxy's gate, two layers:

- **Random path**: the entry is `https://<IP>:<port>/<secretPath>/` — the path is the first key;
- **HttpOnly cookie**: the first visit through the entry mints the `dsh_et_gate` cookie
  (`Path=/; HttpOnly; SameSite=Strict`); afterwards the whole origin (`/api`, static
  assets) is allowed through.

TLS is strongly recommended (`tlsEnabled: true`): the browser's `crypto.randomUUID`
needs a secure context, so plain HTTP breaks the Web client; and the self-signed entry
exposes the random path — the two work together.

The DSH launchToken never reaches remote users: the proxy reads the current process
token via `ctx.connection.authenticatedUrl()`, performs a single exchange with DSH and
caches the cookie (30-day lifetime, survives DSH restarts, auto-refreshed on an
upstream 401).

## Compatibility

- Target: **newer DSH** (Web profile with launchToken + `dsh-auth-*` cookie auth).
- Dependencies: `@deepseek-ai/schemastery` (ships with DSH), the host `settings` and
  `connection` services.
- Runtime: a host-plane plugin of the DSH web profile (loaded via `cordis.patch.yml` insert).

## File layout

```
dsh-remote-access-proxy/
├── plugin/
│   └── dsh-remote-access-proxy.mjs   # server plugin (single entry)
├── ui/
│   ├── client.js                     # configuration card (browser half)
│   ├── index.js                      # host half (empty apply placeholder)
│   └── package.json                  # client-package manifest (incl. @deepseek-ai/dsh-api-remotes)
├── config/
│   └── settings.example.yaml         # sanitized configuration template
├── test-remote-access-proxy.mjs      # mock-DSH end-to-end tests (12 checks)
├── .gitignore                        # excludes access.log / certs / node_modules
└── README.md / README.zh-CN.md
```

## Installation

1. **Place the files**:
   - `plugin/dsh-remote-access-proxy.mjs` → DSH `data\profiles\web\`
   - `ui/` (client.js, index.js, package.json) → DSH `data\profiles\node_modules\dsh-remote-access-proxy-ui\`

2. **Register the plugin**: append to DSH `data\profiles\web\cordis.patch.yml`:

   ```yaml
   - insert:
       - id: dsh-remote-access-proxy
         name: ./dsh-remote-access-proxy.mjs
   - insert:
       - id: dsh-remote-access-proxy-ui
         name: dsh-remote-access-proxy-ui
   ```

   The web profile's `patchReload: live` hot-reloads the registry; plugin code changes
   require a DSH restart.

3. **Configure**: merge the `remote-access-proxy:` section from
   `config/settings.example.yaml` into `data\settings.yaml` (or fill it in via the Web
   UI card). Leave `secretPath` / `cookieValue` empty and they are generated and written
   back on startup.

4. **TLS certificate** (when `tlsEnabled: true`): generate a self-signed pfx, place it
   at `data\certs\local-proxy.pfx`, and set `tlsPassphrase`. Certificate load failure
   **refuses to start** (fail-loud — never silently degrades to plain HTTP).

   ```bash
   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 825 \
     -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<your-ip>"
   openssl pkcs12 -export -out local-proxy.pfx -inkey key.pem -in cert.pem -passout pass:<passphrase>
   ```

5. **Verify**:

   ```bash
   # Defaults to D:\dsh-portable; point DSH_HOME at any DSH install otherwise
   DSH_HOME=/path/to/dsh node test-remote-access-proxy.mjs
   # Expected: 12 passed, 0 failed
   ```

## Configuration fields

| Field | Description |
|---|---|
| `enabled` | Stop listening when disabled |
| `listenHost` | Bind address (`0.0.0.0` = all interfaces) |
| `listenPort` | Bind port |
| `secretPath` | Random gate path (4–32 chars) |
| `cookieValue` | Gate HttpOnly cookie value |
| `upstreamHost` / `upstreamPort` | Upstream DSH (default `127.0.0.1:3080`) |
| `tlsEnabled` / `tlsPfxPath` / `tlsPassphrase` | Self-signed TLS |

Entry: `https://<IP>:<port>/<secretPath>/` (accept the self-signed cert warning once per device).

## Test harness notes

`test-remote-access-proxy.mjs`:

- mocks a DSH upstream (replicating the launchToken exchange + `dsh-auth` cookie gate);
- loads the **real plugin file** from `$DSH_HOME` (default `D:/dsh-portable`) so module
  resolution matches production;
- checks 12 behaviors: gate allow/deny, cookie injection, token stripping, 303 Location
  rewrite, 401 self-heal, WS upgrade, disable-stops-listening, and more;
- snapshots and restores the plugin's `access.log` so test runs leave no trace.
