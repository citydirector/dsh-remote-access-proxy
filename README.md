# dsh-remote-access-proxy

[English](README.md) · [简体中文](README.zh-CN.md)

Use DSH (DeepSeek Harness) from your phone, tablet, or another computer's browser.

The plugin runs a small reverse proxy inside DSH. A remote device opens one address with a random path and gets the full Web GUI, without ever needing the launch token DSH changes on every start. Anything can sit in front: a LAN IP, easytier, ZeroTier, Tailscale, nginx, Caddy, Cloudflare Tunnel.

Requires **DSH 0.1.7-rc.1 or newer** (tested on 0.2.0-rc.2).

## Three steps

1. **Install**: sidebar **Plugins** → Add plugin, and give it
   ```
   https://github.com/citydirector/dsh-remote-access-proxy
   ```
   Switch it on.
2. **Get the address**: open **Remote Access Proxy** in the plugin list, then the **Remote Access Proxy** component under it. The top of the page shows whether it is running and the **entry addresses**. Click **Copy**.
3. **Open it remotely**: on a device on the same network, open the address in a browser, e.g. `http://192.168.1.20:13337/k3x9q2m7p1zt/`. The first visit sets the gate cookie; after that the whole site works.

Nothing needs configuring: port 13337 on every interface, with the random path and cookie generated and saved on first start.

> **Set your API key on this machine first.** DSH does not let remote pages change settings (DSH's own rule, not this plugin's), so the API key, models and the rest are set in DSH on the host. Remote pages can create sessions, chat, and pick workspaces normally.

## The configuration page

![Configuration page](docs/config-page.en.png)

- **Status**: running, off, or not running — and when it failed, why and what to do ("Port 13337 is already in use", "The certificate could not be loaded"), instead of a line buried in a log.
- **Entry addresses**: one per network interface, each with a copy button.
- **Gate**: one click regenerates the path and cookie. After saving, the old address and every signed-in device stop working — use it if the address may have leaked.
- On/off settings are switches. A save applies at once: the proxy restarts in place, DSH does not.

The page appears on the host only; remote pages don't show it, again by DSH's design.

## Do I need TLS?

No. DSH 0.2 works over plain http.

- **VPN / home LAN**: http is fine; the traffic is already on a private network.
- **Internet**: turn TLS on, or put the proxy behind an HTTPS reverse proxy (Caddy, nginx, Cloudflare Tunnel).

TLS needs a `.pfx` certificate. A self-signed one on Windows (PowerShell):

```powershell
$cert = New-SelfSignedCertificate -DnsName "dsh.local" -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(5)
Export-PfxCertificate -Cert $cert -FilePath .\data\certs\dsh-proxy.pfx -Password (ConvertTo-SecureString "your-passphrase" -AsPlainText -Force)
```

On macOS / Linux (openssl):

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 1825 -subj "/CN=dsh.local" -keyout key.pem -out cert.pem
openssl pkcs12 -export -inkey key.pem -in cert.pem -out dsh-proxy.pfx -passout pass:your-passphrase
```

Then switch on "Enable TLS" in the page, fill in the path and passphrase, and save. Browsers ask you to accept the certificate once. With TLS the gate cookie also gets the `Secure` flag.

## Troubleshooting

| The page says | Do this |
|---|---|
| Port … is already in use | Pick another port, or close what holds it. Two DSH apps sharing one `data` directory (portable + desktop) do this too — see below |
| … is not an address of this machine | Use `0.0.0.0`, or one interface address of this machine (not a subnet) |
| The certificate could not be loaded | Check the path (relative to DSH's working directory) and the passphrase |
| Can't read the proxy status | The plugin isn't running: check both the plugin's and the component's switches |

- **`forbidden` on the remote device**: the path is wrong or the cookie was cleared. Enter again through the full entry address.
- **Two DSH apps sharing one `$DSH_HOME`** read the same profile and fight over one port. Switch "Enabled" off in one of them, or give each its own port.

## Security model

Access control is entirely the proxy's gate:

- **Random path**: the entry is `<address>:<port>/<secretPath>/`, generated from the OS CSPRNG;
- **HttpOnly cookie**: the first visit through the entry sets `dsh_et_gate` (`Path=/; HttpOnly; SameSite=Strict`, plus `Secure` with TLS); after that the whole origin is allowed, and anything without the cookie gets 403.

The proxy forwards to DSH as loopback (Host rewritten to `127.0.0.1:<port>`, Origin stripped) and **performs the launch-token exchange itself, holding the `dsh-auth-*` cookie**, so remote users never see the per-start token. On an upstream 401 it drops that cookie and exchanges again.

The path is the key: treat the entry address like a password. The `access.log` startup line records it too.

## Configuration

Every field is a `.volatile()` field of the plugin's Cordis `Config`, stored in the active profile's `cordis.patch.yml`. Edit them in the page, or by hand from [`config/cordis.patch.example.yml`](config/cordis.patch.example.yml).

| Field | Description |
|---|---|
| `enabled` | Stop listening when off |
| `listenHost` | Bind address (`0.0.0.0` = every interface) |
| `listenPort` | Bind port (default `13337`) |
| `secretPath` | Gate path (4–32 letters, digits, `-`, `_`; generated when empty) |
| `cookieValue` | Gate cookie value (8+ letters, digits, `-`, `_`; generated when empty) |
| `upstreamHost` / `upstreamPort` | Upstream DSH. Empty / `0` follows the running instance: 3080 for `dsh web`, 19387 for the desktop app |
| `tlsEnabled` / `tlsPfxPath` / `tlsPassphrase` | TLS (pfx certificate) |
| `logMaxBytes` / `logKeep` | `access.log` rotation: rotate past the cap (default 1 MiB), keep this many old files (default 3); `0` turns rotation / history off |

## Upgrading from 1.1

Nothing to do:

- 1.1 named its components by relative path, and DSH's first configuration save expanded that into an **absolute path** in the profile — so a portable install stopped loading the plugin once its folder moved.
- 1.2 loads by package name. On its first start it rewrites that stale absolute path in the profile to the package name and **keeps your gate path and cookie**, so bookmarked addresses keep working.
- The two components (proxy + page) are now one, shown in the Plugins page with a proper title and icon instead of a long `file:///…` path.

### Migrating from 0.3.0

DSH 0.1.7 removed `settings.yaml`. Update DSH first, then the plugin, and switch it off and on. On first start DSH imports the `remote-access-proxy:` section of `data/settings.yaml` into the profile and renames the file to `settings.yaml.imported`.

## Manual install / CLI

```bash
dsh plugin --profile web add github:citydirector/dsh-remote-access-proxy
```

A git dependency is pinned to a commit by the profile's `pnpm-lock.yaml`. To take a newer release, run `pnpm add` with the same spec in the profile directory, then switch the plugin off and on.

## Development

```
dsh-remote-access-proxy/
├── package.json                        # bundle manifest + dsh.client; "." = proxy, "./client" = page
├── cordis.patch.yml                    # the one row this bundle inserts (by package name)
├── plugin/dsh-remote-access-proxy.mjs  # host: gate + forwarding + status route
├── client/index.js                     # browser: the configuration page
├── config/cordis.patch.example.yml     # hand-configuration template
├── locale/{en,zh}.json                 # Plugins-page title and description
└── test-remote-access-proxy.mjs        # end-to-end tests against a mock DSH
```

```bash
pnpm install
node test-remote-access-proxy.mjs   # Expected: 49 passed, 0 failed
```

The tests mock a DSH upstream (launch-token exchange + `dsh-auth` cookie gate) and the host contract the plugin relies on, and cover the gate, cookie injection, token stripping, 303 rewrite, 401 self-heal, WS upgrade, log rotation, secret generation and write-back, the status route, failure reasons (invalid path, busy port), the 1.1 → 1.2 migration, upstream auto-detect, and the package layout.
