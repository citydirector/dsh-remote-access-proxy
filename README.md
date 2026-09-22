# dsh-remote-access-proxy

[English](README.md) · [简体中文](README.zh-CN.md)

A remote-access proxy for the DSH (DeepSeek Harness) Web GUI, shipped as a **DSH
profile bundle**: it embeds a reverse proxy that safely exposes the Web GUI and its
`/api` to any remote front (easytier, ZeroTier, Tailscale, nginx, Caddy, Cloudflare
Tunnel, or a plain LAN IP), bridges the per-process launch-token auth of newer DSH
builds, and contributes its own configuration page to the Plugins panel.

## Install

This repository **is** a bundle package, so the Plugins page can install it straight
from the GitHub URL.

### From the Plugins page (recommended)

Open the sidebar **Plugins** panel → install, and give it the repository URL:

```
https://github.com/citydirector/dsh-remote-access-proxy
```

The manager runs pnpm against the URL, resolves `dsh.bundle.patch`, and adds the
bundle's rows to the profile's user layer. Enable the bundle, then open the
**远程访问代理** card in the same panel to configure it.

### From a profile's CLI

```bash
dsh plugin --profile web add github:citydirector/dsh-remote-access-proxy
```

### By hand

Copy `plugin/` and `ui/` into the profile and insert the two rows yourself:

```yaml
# data/profiles/web/cordis.patch.yml
- insert:
    - id: dsh-remote-access-proxy
      name: ./plugin/dsh-remote-access-proxy.mjs
    - id: dsh-remote-access-proxy-ui
      name: ./ui/lib/index.js
```

## Layout

```
dsh-remote-access-proxy/
├── package.json                    # bundle manifest: dsh.bundle.patch
├── cordis.patch.yml                # the two rows this bundle inserts
├── plugin/
│   └── dsh-remote-access-proxy.mjs # host-plane gateway (gate + forward server)
├── ui/                             # configuration card (dual-face package)
│   ├── package.json                # dsh.client declaration + exports["./client"]
│   └── lib/{index.js,client.js}    # host half (row anchor) + browser half (card)
├── config/settings.example.yaml    # sanitized configuration template
├── test-remote-access-proxy.mjs    # mock-DSH end-to-end tests (12 checks)
└── README.md / README.zh-CN.md
```

## Why it is needed

Newer DSH authenticates every browser session with two layers:

1. **Host/Origin trust fence** — `/api` accepts only a loopback Host or explicit
   `trustedHosts`, with a matching same-origin `Origin`;
2. **Browser-session auth** — every process start mints a random `launchToken`
   (`http://127.0.0.1:3080/?token=…`); `/api` without the `dsh-auth-*` signed cookie
   answers 401.

The proxy forwards to DSH as loopback (Host rewritten to `127.0.0.1:3080`, Origin
stripped) and **performs the token exchange itself, holding the `dsh-auth-*` cookie**.
Remote users only need the random path + HttpOnly-cookie gate and **never see the
per-start launchToken**.

## Security model

Access control is carried entirely by the proxy's gate:

- **Random path** — the entry is `https://<IP>:<port>/<secretPath>/`;
- **HttpOnly cookie** — the first visit through the entry mints `dsh_et_gate`
  (`Path=/; HttpOnly; SameSite=Strict`); afterwards the whole origin is allowed.

Enable TLS (`tlsEnabled: true`) — `crypto.randomUUID` needs a secure context, so plain
HTTP breaks the Web client. Certificate load failure refuses to start (fail-loud).

## Configuration

Merge `config/settings.example.yaml` into `data/settings.yaml`, or edit the fields in
the **远程访问代理** card (Plugins panel). `secretPath` / `cookieValue` are generated
and written back on first start when left empty.

| Field | Description |
|---|---|
| `enabled` | Stop listening when disabled |
| `listenHost` | Bind address (`0.0.0.0` = all interfaces) |
| `listenPort` | Bind port |
| `secretPath` | Random gate path (4–32 chars) |
| `cookieValue` | Gate HttpOnly cookie value |
| `upstreamHost` / `upstreamPort` | Upstream DSH (default `127.0.0.1:3080`) |
| `tlsEnabled` / `tlsPfxPath` / `tlsPassphrase` | Self-signed TLS (pfx) |

Entry: `https://<IP>:<port>/<secretPath>/` (accept the self-signed certificate once per device).

## The configuration card

The card is a dual-face client package. On the browser side it registers into the
Plugins page's **`plugins.item`** slot and reads/writes through the `settingsScope`
client service — the pattern the shipped cards use. It registers only while the Host
serves the `remote-access-proxy` settings namespace, so a deployment that never
composed the plugin shows no trace of it.

## Tests

```bash
# Defaults to D:\dsh-portable; point DSH_HOME at any DSH install otherwise.
# The harness reads the plugin from $DSH_HOME/data/profiles/web, so it covers the
# manual-install layout.
DSH_HOME=/path/to/dsh node test-remote-access-proxy.mjs
# Expected: 12 passed, 0 failed
```

It mocks a DSH upstream (launch-token exchange + `dsh-auth` cookie gate), checks the
gate, cookie injection, token stripping, 303 Location rewrite, 401 self-heal and WS
upgrade, and snapshots/restores the plugin's `access.log` so runs leave no trace.
