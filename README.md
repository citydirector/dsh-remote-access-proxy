# dsh-remote-access-proxy

[English](README.md) · [简体中文](README.zh-CN.md)

A remote-access proxy for the DSH (DeepSeek Harness) Web GUI, shipped as a **DSH
profile bundle**: it embeds a reverse proxy that safely exposes the Web GUI and its
`/api` to any remote front (easytier, ZeroTier, Tailscale, nginx, Caddy, Cloudflare
Tunnel, or a plain LAN IP), bridges the per-process launch-token auth of newer DSH
builds, and contributes its own configuration page to the Plugins panel.

Built for **DSH 0.1.7-rc.1 or newer** (the profile-owned configuration model). The
bundle declares that requirement in `peerDependencies`, so installing it on an older
harness is refused with an explanation instead of failing at load.

## Install

This repository **is** a bundle package, so the Plugins page can install it straight
from the GitHub URL.

### From the Plugins page (recommended)

Open the sidebar **Plugins** panel → install, and give it the repository URL:

```
https://github.com/citydirector/dsh-remote-access-proxy
```

The manager runs pnpm against the URL, resolves `dsh.bundle.patch`, and adds the
bundle's rows to the profile's user layer. Enable the bundle, then open the bundle's
page, open the **`remote-access-proxy`** row and use its 配置 page.

### From a profile's CLI

```bash
dsh plugin --profile web add github:citydirector/dsh-remote-access-proxy
```

A git dependency is pinned to a commit by the profile's `pnpm-lock.yaml`, so a plain
`pnpm install` never moves it. To take a newer release, re-run `pnpm add` with the
same spec from the profile directory and toggle the bundle off and on — that is also
what makes `node_modules`, `.modules.yaml` and `pnpm-lock.yaml` agree again.

### By hand

Copy `plugin/`, `ui/`, `locale/` and `icon.svg` into the profile and insert the two
rows yourself:

```yaml
# data/profiles/web/cordis.patch.yml
- insert:
    - id: remote-access-proxy
      name: ./plugin/dsh-remote-access-proxy.mjs
    - id: remote-access-proxy-ui
      name: ./ui/lib/index.js
```

The host row's id is load-bearing: on 0.1.7+ a plugin's settings namespace **is** its
profile entry id. A hand-copied install also has no bundle entry in the Plugins page,
so it gets no 配置 page — edit the profile patch by hand instead.

## Layout

```
dsh-remote-access-proxy/
├── package.json                      # bundle manifest: dsh.bundle.patch, icon, engines/peers
├── cordis.patch.yml                  # the two rows this bundle inserts
├── plugin/
│   └── dsh-remote-access-proxy.mjs   # host-plane gateway (gate + forward server)
├── ui/                               # configuration page (dual-face package)
│   ├── package.json                  # dsh.client declaration + exports["./client"]
│   └── lib/{index.js,client.js}      # host half (row anchor) + browser half (page)
├── config/cordis.patch.example.yml   # sanitized profile-patch template
├── locale/{en,zh}.json               # Plugins-page title/description dictionaries
├── icon.svg                          # Plugins-page artwork
├── test-remote-access-proxy.mjs      # mock-DSH end-to-end tests (31 checks)
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

Every field is a `.volatile()` field of the plugin's own Cordis `Config`, so its values
live in the active profile's `cordis.patch.yml` — edit them in the 配置 page of the
`remote-access-proxy` row (Plugins panel), or merge
[`config/cordis.patch.example.yml`](config/cordis.patch.example.yml) into the profile
patch by hand. `secretPath` / `cookieValue` are generated and written back on first
start when left empty.

A save writes the profile patch and is applied immediately: the plugin is **not**
remounted, the embedded server just restarts with the new values.

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
history at all (each rotation just truncates the live file). Both are ordinary config
fields, editable in the 配置 page or in the profile patch.

Note that these lines are diagnostics, not an audit trail: the startup line records the
gate path (`secret=…`), so treat the log files with the same care as your profile
configuration.

## The configuration page

The page is a dual-face client package. On the browser side it registers into the
Plugins page's **`plugins.row.config`** slot, keyed
`dsh-remote-access-proxy#remote-access-proxy`, and reads/writes through the `configForms`
client service — the staged form the shipped settings pages use. It registers only
while the Host serves the `remote-access-proxy` namespace, so a deployment that never
composed the plugin shows no trace of it.

## Migrating from 0.3.0

DSH 0.1.7 removed `settings.yaml`, so 0.3.0 does not load on it. Upgrading is a
version bump plus one one-shot import:

1. **Update DSH first**, then re-pin the bundle (`pnpm add
   github:citydirector/dsh-remote-access-proxy` in the profile directory) and toggle it.
2. **Your values come along.** On the first start after the upgrade DSH imports the
   `remote-access-proxy:` section of `data/settings.yaml` into the profile patch and
   renames the file to `settings.yaml.imported`. That import matches on the profile
   entry id, which is exactly why the row is named `remote-access-proxy`; the same
   section under the old row id `dsh-remote-access-proxy` would be rejected.
3. **Check the log once.** A section the composition rejects is only warned about and
   stays in the renamed file; grep the DSH log for
   `settings: section … was not imported into entry`.
4. **The card moved.** It is no longer a top-level card in the Plugins panel; it is the
   配置 page of the bundle's `remote-access-proxy` row.

## Tests

```bash
pnpm install                      # once: the plugin imports @deepseek-ai/schemastery
node test-remote-access-proxy.mjs # loads the plugin beside it (an installed bundle copy
                                  # works too: DSH_PLUGIN=/path/to/plugin.mjs)
# Expected: 31 passed, 0 failed
```

It mocks a DSH upstream (launch-token exchange + `dsh-auth` cookie gate) and the 0.1.7
host contract around the plugin — volatile Config references, `loader/volatile-update`,
the profile configuration editor and the page-policy call — then checks the gate, cookie
injection, token stripping, 303 Location rewrite, 401 self-heal, WS upgrade,
`access.log` rotation (cap, ring, off switch), generated-secret write-back, the
volatile-field contract, and the bundle/package layout (patch rows resolve, metadata is
packaged, the browser half registers the row page and edits every field). It snapshots
and restores the whole log ring so runs leave no trace.
