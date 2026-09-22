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
├── test-remote-access-proxy.mjs    # mock-DSH end-to-end tests (16 checks)
└── README.md / README.zh-CN.md
```

`access.log` (and its rotated `.1`… siblings) is runtime output and never committed.

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
| `logMaxBytes` / `logKeep` | `access.log` rotation: rotate once a write would pass this size (default `1048576` = 1 MiB) and keep this many older files (default `3`). `logMaxBytes: 0` = never rotate; `logKeep: 0` = keep no history |

Entry: `https://<IP>:<port>/<secretPath>/` (accept the self-signed certificate once per device).

## Log rotation

Every gated request (`ENTRY` / `PASS` / `DENY`), listener change and DSH 401 self-heal
is appended to `access.log` beside the plugin in the profile's `node_modules`. Left
alone that file grows without bound, so it rotates by size instead:

- a line that would push the file past `logMaxBytes` (default 1 MiB) rotates first;
- the full file becomes `access.log.1`, older files shift to `access.log.2`, … and
  whatever passes `logKeep` (default `3`) is deleted;
- the live `access.log` therefore always stays under the cap, and the whole ring is
  bounded at `logMaxBytes × (logKeep + 1)`.

Set `logMaxBytes: 0` to restore the never-rotate behaviour, or `logKeep: 0` to keep no
history at all (each rotation just truncates the live file). Both are ordinary settings
fields, editable in the card or in `data/settings.yaml`.

Note that these lines are diagnostics, not an audit trail: the startup line records the
gate path (`secret=…`), so treat the log files with the same care as `settings.yaml`.

## The configuration card

The card is a dual-face client package. On the browser side it registers into the
Plugins page's **`plugins.item`** slot and reads/writes through the `settingsScope`
client service — the pattern the shipped cards use. It registers only while the Host
serves the `remote-access-proxy` settings namespace, so a deployment that never
composed the plugin shows no trace of it.

## Tests

```bash
pnpm install                      # once: the plugin imports @deepseek-ai/schemastery
node test-remote-access-proxy.mjs # loads the plugin beside it (an installed bundle copy
                                  # works too: DSH_PLUGIN=/path/to/plugin.mjs)
# Expected: 16 passed, 0 failed
```

It mocks a DSH upstream (launch-token exchange + `dsh-auth` cookie gate), checks the
gate, cookie injection, token stripping, 303 Location rewrite, 401 self-heal, WS
upgrade and `access.log` rotation (cap, ring, off switch), and snapshots/restores the
whole log ring so runs leave no trace.
