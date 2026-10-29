# dsh-remote-access-proxy

[English](README.md) · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/dsh-remote-access-proxy)](https://www.npmjs.com/package/dsh-remote-access-proxy) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![DSH plugin](https://img.shields.io/badge/DSH%20plugin-%E2%89%A50.2.1--rc.2-blue)](https://github.com/topics/dsh-plugin)

Use DSH (DeepSeek Harness) from your phone, tablet, or another computer's browser.

The plugin runs a small reverse proxy inside DSH. A remote device opens one address with a random path and gets the full Web GUI, without ever needing the launch token DSH changes on every start. Anything can sit in front: a LAN IP, easytier, ZeroTier, Tailscale, nginx, Caddy, Cloudflare Tunnel.

Requires **DSH >=0.2.1-rc.2 <0.3.0** and **Node.js 24.9+**.

## Quick start

1. **Install**: sidebar **Plugins** → Add plugin, and give it
   ```
   dsh-remote-access-proxy
   ```
   Switch it on.
2. **Get the address**: open **Remote Access Proxy** in the plugin list, then the **Remote Access Proxy** component under it. The top of the page shows whether it is running and the **entry addresses**. Click **Copy**.
3. **Open it remotely**: on a device on the same network, open the address in a browser, e.g. `http://192.168.1.20:13337/k3x9q2m7p1zt/`. Bookmark it or add it to the home screen.

Nothing needs configuring: port 13337 on every interface, with the random path generated and saved on first start. Add a password or limit who may connect whenever you like.

> **Set your API key on this machine first.** Some DSH settings can only be changed from a page on the host (subject to DSH’s own remote-access policy), so set the API key in DSH on the host. Remote pages can create sessions, chat, and pick workspaces normally.

From the command line:

```bash
dsh plugin --profile web add dsh-remote-access-proxy
```

Stop the corresponding DSH instance before CLI changes and restart afterwards. Prefer the Plugins page on Desktop; its desktop profile requires that installation’s CLI and the same DSH_HOME.

## The configuration page

![Configuration page](docs/config-page.en.png)

- **Status**: running, off, or not running — and when it failed, why and what to do ("Port 13337 is already in use", "The certificate could not be loaded"), instead of a line buried in a log.
- **Entry addresses**: one per network interface, each with a copy button.
- **Allowed client addresses**: which devices may connect — IPs, CIDR blocks or ranges, e.g. `192.168.1.0/24, 100.64.0.0/10`. **LAN and VPN only** fills in every private range in one click; empty means anyone. Connections from elsewhere are dropped before a byte is exchanged, and the page tells you the last address it turned away, so you can add your own device if you locked it out. This machine itself is always allowed.
- **Access password** (optional): the entry then shows a sign-in page. A signed-in device is remembered for 30 days; changing the password signs every device out. Five wrong tries lock that address for a few minutes. `<entry>/__rap/logout` signs a device out.
- **Regenerate the entry path**: after saving, the old address stops working — use it if the address may have leaked.
- On/off settings are switches. A save applies at once: the proxy restarts in place, DSH does not.

Access to host settings depends on the DSH version and its remote-access policy. Plugin updates are managed from DSH’s Plugins page.

## Do I need TLS?

No. DSH 0.2 works over plain http.

- **VPN / home LAN**: HTTP is available, but does not encrypt traffic. Use HTTPS on untrusted networks; a VPN may provide a separate encrypted transport.
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
| These client addresses aren't valid | Write an IP (`10.0.0.5`), a CIDR block (`10.0.0.0/24`) or a range (`10.0.0.5-10.0.0.9`) |
| The certificate could not be loaded | Check the path (relative to DSH's working directory) and the passphrase |
| Can't read the proxy status | The plugin isn't running: check both the plugin's and the component's switches |

- **The remote device can't connect at all** (connection reset): its address isn't in the allow list. The page shows the address it turned away; add it, or click **LAN and VPN only**.
- **`forbidden` on the remote device**: the path is wrong. Open the full entry address again.
- **A plain-text `bad gateway`**: the proxy could not reach the upstream DSH. The status card's **Upstream** line shows the address it is using, and `access.log` records the reason (usually `ECONNREFUSED`). Leave `upstreamHost` / `upstreamPort` at empty / `0` so the address follows the running instance. Before 1.4.1 the desktop app was unusable this way: it starts its host with `--port 0`, the plugin read the *requested* `0` from `webStartup` instead of the port the OS bound on `webServer`, and fell back to 3080.
- **Two DSH apps sharing one `$DSH_HOME`** read the same profile and fight over one port. Switch "Enabled" off in one of them, or give each its own port.

## Security

Access control is entirely the proxy's gate:

- **Allow list**: a client outside `allowFrom` is dropped at the TCP level (before TLS), like a firewall rule. Loopback is always allowed, so a local HTTPS reverse proxy keeps working;
- **Random path**: the entry is `<address>:<port>/<secretPath>/`, generated from the OS CSPRNG;
- **Password** (optional): without it the path alone opens the site; with it the entry shows a sign-in form, failed tries are slowed and rate-limited per address;
- **Remembered device**: entering (or signing in) sets `dsh_et_gate`, a signed value that expires after 30 days (`Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict`, plus `Secure` with TLS). It is signed with a server secret over the path and the password, so changing either — or regenerating the path — revokes every device. Nobody ever edits it by hand.

The proxy forwards to DSH as loopback (Host rewritten to `127.0.0.1:<port>`, Origin stripped) and **performs the launch-token exchange itself, holding the `dsh-auth-*` cookie**, so remote users never see the per-start token. On an upstream 401 it drops that cookie and exchanges again.

The path is the key: treat the entry address like a password. The `access.log` startup line records it too.

## Configuration

Every field is a `.volatile()` field of the plugin's Cordis `Config`, stored in the active profile's `cordis.patch.yml`. Edit them in the page, or by hand from [`config/cordis.patch.example.yml`](config/cordis.patch.example.yml).

| Field | Description |
|---|---|
| `enabled` | Stop listening when off |
| `listenPort` | Port (default `13337`); the proxy listens on every interface, IPv4 and IPv6 |
| `allowFrom` | Client addresses allowed to connect: IPs, CIDR blocks, `a-b` ranges, separated by commas or spaces. Empty = anyone; loopback always |
| `secretPath` | Gate path (4–32 letters, digits, `-`, `_`; generated when empty) |
| `password` | Optional access password (empty = none) |
| `cookieValue` | Server secret that signs remembered devices (generated; not shown on the page) |
| `upstreamHost` / `upstreamPort` | Upstream DSH. Empty / `0` follows the running instance: the bound port from its `webServer` service, then `webStartup` (3080 under `dsh web`; a desktop launch passes `--port 0`, so its real port exists only on `webServer`) |
| `tlsEnabled` / `tlsPfxPath` / `tlsPassphrase` | TLS (pfx certificate) |
| `logMaxBytes` / `logKeep` | `access.log` rotation: rotate past the cap (default 1 MiB), keep this many old files (default 3); `0` turns rotation / history off |

## Updating

Updates use npm and DSH’s installer. Use the Plugins page version list when your host provides it. Otherwise stop DSH and run:

~~~sh
dsh plugin --profile web add dsh-remote-access-proxy@latest
~~~

The plugin’s GitHub polling and private update buttons have been removed; the old updateCheck setting has no effect. Maintainer publishing instructions are in [PUBLISHING.md](PUBLISHING.md).

## Upgrading from older versions

To migrate a GitHub dependency, back up the profile’s cordis.patch.yml, remove the old package and add dsh-remote-access-proxy by its npm name. Keep row IDs and verify saved settings afterwards.

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
node test-remote-access-proxy.mjs   # Expected: 78 passed, 0 failed
```

The tests mock a DSH upstream (launch-token exchange + `dsh-auth` cookie gate) and the host contract the plugin relies on, and cover the gate, cookie injection, token stripping, 303 rewrite, 401 self-heal, WS upgrade, log rotation, secret generation and write-back, the status route, failure reasons (invalid path, busy port, bad allow-list entry), the password sign-in (deep links, lockout, logout, revocation), the allow list (drop, loopback, reporting), the 1.1 → 1.2 migration, upstream auto-detect, closing every connection on a hot swap and rebinding the port at once, and the package layout.

### Release convention

Bump package.json and package-lock.json together and push main. GitHub Actions tests and publishes the new npm version automatically. Version tags and manual dispatch are also supported. See [PUBLISHING.md](PUBLISHING.md) for the one-time Trusted Publisher setup.

## Related projects

- [deepinfra-fusion-proxy](https://github.com/citydirector/deepinfra-fusion-proxy): DeepInfra Standard / Flex switching with automatic fallback, per session
- [dsh-loop-rescue](https://github.com/citydirector/dsh-loop-rescue): Cut model repetition loops mid-stream, prune them from the log, and resume
- [dsh-session-manager](https://github.com/citydirector/dsh-session-manager): Offline session manager: upgrade, archive, trash, loop cleanup, broken-tail repair

## License

[MIT](LICENSE)
