/**
 * dsh-remote-access-proxy — embedded open RPC gateway for the DSH web GUI, as a
 * host-plane plugin.
 *
 * - Starts/stops with DSH (plugin apply/dispose), no external tool needed.
 * - Listens on every interface (easytier, ZeroTier, Tailscale, a plain LAN or
 *   a reverse-proxy front all work); `allowFrom` decides which client
 *   addresses may connect, dropping the rest at the TCP level.
 * - Random-path gate, an optional password sign-in, and a signed 30-day
 *   remembered-device cookie in front of the DSH app and its /api.
 * - Forwards to DSH with Host rewritten to loopback and Origin stripped, so
 *   the /api trust fence accepts any front — no per-host trustedHosts needed.
 * - Forwards to the running DSH instance: `upstreamHost`/`upstreamPort` default
 *   to auto-detect from the live `webStartup` service (`dsh web` listens on
 *   3080, the desktop launcher pins 19387), so no configuration is needed;
 *   explicit values override.
 * - Optional TLS (self-signed pfx): browsers require a secure context for
 *   crypto.randomUUID, so plain-HTTP remote access breaks the web client.
 * - Configured from the Plugins page: the bundle's row page (sidebar → Plugins
 *   → dsh-remote-access-proxy → the `remote-access-proxy` row → configure).
 *   A volatile-only edit never remounts this plugin; it restarts the embedded
 *   server in place.
 * - Diagnostics go to a size-bounded `access.log` beside this file: it rotates
 *   at `logMaxBytes` and keeps `logKeep` older files (`access.log.1`…), so a
 *   long-running deployment cannot grow an unbounded log.
 * - Update check (1.4): a few seconds after start, then about every 12 hours,
 *   the release tags of the GitHub repository are read and the newest `vX.Y.Z`
 *   is compared with this package's version; the result rides the status route.
 *   Nothing is installed here: the configuration page hands the tag-pinned spec
 *   (`github:<repo>#vX.Y.Z`) to DSH's own plugin manager, which installs it over
 *   this package and hot-swaps the plugin. A hot swap disposes this instance,
 *   so dispose closes the listener and every open connection at once and the
 *   new version can bind the same port right away.
 *
 * DSH browser-auth bridge (2026-09-04): DSH now authenticates every browser
 * session with a per-process launch token (`http://<upstream>/?token=…`)
 * plus an authority-bound signed cookie (`dsh-auth-*`); without it every /api
 * request is 401. This proxy therefore performs the token exchange itself and
 * forwards carrying the minted DSH cookie, so remote users keep the old gate
 * UX (random path + HttpOnly cookie) and never need to know the launch token.
 * The cookie is signed with a durable secret and lives 30 days, surviving DSH
 * restarts; an upstream 401 drops it and triggers a fresh exchange.
 *
 * DSH 0.1.7 configuration model (2026-09-24): `settings.yaml` is gone. A plugin
 * declares its configurable values in its own Cordis `Config`, marks the ones
 * that may change without a remount `.volatile()`, and reads them through those
 * references; Loader commits volatile-only changes in place and notifies this
 * instance through `loader/volatile-update`. Edits persist into the active
 * profile's own `cordis.patch.yml` through the configuration editor, so the
 * profile entry id — not a separately registered namespace — IS the settings
 * namespace. Every field below is volatile.
 */

import http from "node:http"
import https from "node:https"
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { BlockList, isIP } from "node:net"
import { execFile } from "node:child_process"
import { appendFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { fileURLToPath } from "node:url"
import z from "@deepseek-ai/schemastery"

export const name = "dsh-remote-access-proxy"
/** Package name the bundle row loads this plugin by (portable across installs). */
const PACKAGE = "dsh-remote-access-proxy"

/**
 * Required services. `connection` carries this process's launch token. The
 * settings service is deliberately NOT required: the plugin's configuration is
 * its own Config, so the proxy still runs — and still serves remote clients —
 * in a deployment that mounts no settings forms at all. `webStartup` (upstream
 * auto-detect), `configEditor` (persisting generated secrets) and `hmr`
 * (leaving the current hot-reload transaction before editing) are read
 * optionally through `ctx.get`.
 */
export const inject = ["connection"]

/** Profile entry id of the host row. On DSH 0.1.7+ this IS the settings namespace. */
const NS = "remote-access-proxy"
const HERE = fileURLToPath(new URL(".", import.meta.url))
/** Name of the HttpOnly cookie this proxy's gate mints. */
const GATE_COOKIE = "dsh_et_gate"
/** Authenticated status route the configuration page reads (below DSH's own `/api`). */
export const STATUS_ROUTE = "/api/remote-access-proxy/status"
/** What a gate path may contain: it is one URL segment. */
const SECRET_PATH_PATTERN = /^[A-Za-z0-9_-]{4,32}$/
/** What a gate cookie value may contain: a cookie-octet subset without separators. */
const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
/** How long a remembered device stays signed in. */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
/** Internal routes below the gate path (the login form posts here). */
const LOGIN_ROUTE = "/__rap/login"
const LOGOUT_ROUTE = "/__rap/logout"
/** Failed password attempts allowed per client address in LOGIN_WINDOW_MS. */
const LOGIN_MAX_FAILURES = 5
const LOGIN_WINDOW_MS = 5 * 60 * 1000
/** A ready-made allow list: private LANs, CGNAT/Tailscale, IPv6 ULA and link-local. */
export const PRIVATE_NETWORKS = "10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, fc00::/7, fe80::/10"
/** Where releases are published: the GitHub repository whose `vX.Y.Z` tags are releases. */
export const UPDATE_REPOSITORY = "citydirector/dsh-remote-access-proxy"
/** First update check this long after start (leave startup alone), then every UPDATE_INTERVAL_MS. */
const UPDATE_DELAY_MS = 5000
const UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000
/** A release tag: `v` + three numeric parts, nothing after (pre-releases are never offered). */
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
/** Authenticated route the page asks for an immediate update check. */
export const UPDATE_CHECK_ROUTE = "/api/remote-access-proxy/update-check"
/** Rotation defaults, used when a settings object predates the log fields. */
const DEFAULT_LOG_MAX_BYTES = 1024 * 1024
const DEFAULT_LOG_KEEP = 3

/** Every configurable field, in card order. */
const FIELDS = [
  "enabled",
  "listenPort",
  "allowFrom",
  "secretPath",
  "password",
  "cookieValue",
  "upstreamHost",
  "upstreamPort",
  "tlsEnabled",
  "tlsPfxPath",
  "tlsPassphrase",
  "logMaxBytes",
  "logKeep",
  "updateCheck",
]

/**
 * The plugin's live configuration. Every field is `.volatile()`: a change is
 * parsed and validated by Loader, committed into these stable references, and
 * announced with `loader/volatile-update` — the running instance is retained,
 * so the embedded server is restarted rather than re-imported. No ordinary
 * field exists, so an edit never takes the remount lifecycle.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  listenPort: z.number().default(13337).volatile(),
  // Which client addresses may connect: IPs, CIDR blocks or a-b ranges,
  // separated by commas, spaces or new lines. Empty = any address. The proxy
  // always listens on every interface; loopback is always allowed.
  allowFrom: z.string().default("").volatile(),
  secretPath: z.string().default("").volatile(),
  // Optional access password. Empty = the secret path alone opens the site.
  password: z.string().default("").volatile(),
  // Server-side secret that signs the remembered-device cookie. Generated, never
  // shown on the page; regenerating it signs every device out.
  cookieValue: z.string().default("").volatile(),
  // Upstream DSH body. Empty host / port 0 mean "follow the running instance":
  // the address is read from the live `webStartup` service at start time, so
  // `dsh web` (3080) and the desktop launcher (`--port 19387`) both work without
  // configuration. An explicit value always wins.
  upstreamHost: z.string().default("").volatile(),
  upstreamPort: z.number().default(0).volatile(),
  tlsEnabled: z.boolean().default(false).volatile(),
  tlsPfxPath: z.string().default("").volatile(),
  tlsPassphrase: z.string().default("").volatile(),
  // access.log rotation: rotate before a write that would pass this size
  // (0 = never rotate, the pre-rotation behaviour); how many rotated files to
  // keep (0 = keep no history, just truncate).
  logMaxBytes: z.number().default(DEFAULT_LOG_MAX_BYTES).volatile(),
  logKeep: z.number().default(DEFAULT_LOG_KEEP).volatile(),
  // Look for a newer release on GitHub (a few seconds after start, then about
  // every 12 hours). Never installs anything by itself.
  updateCheck: z.boolean().default(true).volatile(),
})

/**
 * Read a release tag.
 *
 * @param tag - a git tag name.
 * @returns `[major, minor, patch]`, or undefined for anything that is not `vX.Y.Z`.
 */
export function parseReleaseTag(tag) {
  const match = RELEASE_TAG.exec(String(tag ?? "").trim())
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Compare two versions written `X.Y.Z` or `vX.Y.Z`.
 *
 * @returns negative, zero or positive like a sort comparator; a version that
 *   does not parse sorts below every one that does.
 */
export function compareVersions(a, b) {
  const tag = (value) => (String(value ?? "").startsWith("v") ? String(value) : `v${value}`)
  const pa = parseReleaseTag(tag(a))
  const pb = parseReleaseTag(tag(b))
  if (pa === undefined || pb === undefined) return (pa === undefined ? 0 : 1) - (pb === undefined ? 0 : 1)
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

/**
 * The newest release among tag names: `vX.Y.Z` only, highest by semantic
 * version (not by date or list order).
 *
 * @param tags - tag names, in any order.
 * @returns the newest release tag, or undefined when there is none.
 */
export function latestRelease(tags) {
  let best
  for (const tag of tags ?? []) {
    if (parseReleaseTag(tag) === undefined) continue
    if (best === undefined || compareVersions(tag, best) > 0) best = tag
  }
  return best
}

/**
 * Where releases come from. The default is the GitHub repository; the
 * `DSH_RAP_UPDATE_SOURCE` environment variable can name another GitHub
 * repository (`owner/repo`) or any git URL (`git+file:///…`, `git+https://…`),
 * which is how a release is rehearsed against a local repository before it is
 * published.
 *
 * @param env - the environment to read.
 * @returns `{ kind: "github", repository, spec }` or `{ kind: "git", url, spec }`;
 *   `spec` is the install spec without its `#tag`.
 */
export function updateSource(env = process.env) {
  const raw = String(env.DSH_RAP_UPDATE_SOURCE ?? "").trim()
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) return { kind: "github", repository: raw, spec: `github:${raw}` }
  if (/^git(\+[a-z]+)?:\/\//i.test(raw)) return { kind: "git", url: raw.replace(/^git\+/i, ""), spec: raw }
  return { kind: "github", repository: UPDATE_REPOSITORY, spec: `github:${UPDATE_REPOSITORY}` }
}

/** The tag-pinned install spec of one release: a new spec each release, so DSH installs it over the old one. */
export function releaseSpec(source, tag) {
  return `${source.spec}#${tag}`
}

/**
 * Read the tag names of a release source.
 *
 * @param source - from `updateSource()`.
 * @param options - `{ api, signal }`: the GitHub API base URL, an abort signal.
 * @returns the tag names (GitHub: the newest 100 the API lists).
 */
export async function fetchReleaseTags(source, { api = "https://api.github.com", signal } = {}) {
  if (source.kind === "git") {
    const output = await new Promise((resolve, reject) => {
      execFile("git", ["ls-remote", "--tags", "--", source.url], { timeout: 20000, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    })
    return output.split("\n").map((line) => /refs\/tags\/([^\s^]+)$/.exec(line.trim())?.[1]).filter(Boolean)
  }
  const response = await fetch(`${api.replace(/\/+$/, "")}/repos/${source.repository}/tags?per_page=100`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "dsh-remote-access-proxy", "x-github-api-version": "2022-11-28" },
    signal,
  })
  if (!response.ok) {
    const limited = response.status === 403 || response.status === 429
    throw new Error(limited ? `GitHub rate limit (HTTP ${response.status})` : `GitHub answered HTTP ${response.status}`)
  }
  const body = await response.json()
  if (!Array.isArray(body)) throw new Error("GitHub answered something other than a tag list")
  return body.map((item) => item?.name).filter((name) => typeof name === "string")
}

/**
 * Compare a tag list with the running version.
 *
 * @param tags - tag names of the release source.
 * @param current - this package's version (`X.Y.Z`).
 * @returns `{ state: "available", latest }` when a newer release exists, else `{ state: "current", latest? }`.
 */
export function updateVerdict(tags, current) {
  const latest = latestRelease(tags)
  if (latest !== undefined && compareVersions(latest, current) > 0) return { state: "available", latest }
  return { state: "current", ...(latest !== undefined ? { latest } : {}) }
}

/** This package's own version, read fresh: after a hot swap it is the new one. */
function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    return typeof pkg.version === "string" ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/**
 * A random lowercase alphanumeric token from the OS CSPRNG. The gate path and
 * cookie ARE the access control, so `Math.random` (predictable) is not enough.
 * Rejection sampling keeps every character equally likely.
 */
export function genToken(length) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  const limit = 256 - (256 % chars.length)
  let out = ""
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue
      out += chars[byte % chars.length]
      if (out.length === length) break
    }
  }
  return out
}

/**
 * Parse an allow list: IPs, CIDR blocks (`10.0.0.0/8`, `fd00::/8`) and ranges
 * (`192.168.1.10-192.168.1.20`), separated by commas, semicolons or whitespace.
 *
 * @param text - the configured `allowFrom` value.
 * @returns `{ entries, bad, list }`; `list` is undefined when every address may connect.
 */
export function parseAllowList(text) {
  const entries = String(text ?? "").split(/[\s,;]+/).filter(Boolean)
  const bad = []
  if (entries.length === 0) return { entries, bad, list: undefined }
  const list = new BlockList()
  const family = (ip) => (isIP(ip) === 6 ? "ipv6" : "ipv4")
  for (const entry of entries) {
    const slash = entry.indexOf("/")
    const dash = entry.indexOf("-")
    try {
      if (slash > 0) {
        const ip = entry.slice(0, slash)
        const bits = Number(entry.slice(slash + 1))
        const max = isIP(ip) === 6 ? 128 : 32
        if (!isIP(ip) || !/^\d+$/.test(entry.slice(slash + 1)) || bits > max) throw new Error("bad cidr")
        list.addSubnet(ip, bits, family(ip))
      } else if (dash > 0) {
        const from = entry.slice(0, dash)
        const to = entry.slice(dash + 1)
        if (!isIP(from) || isIP(from) !== isIP(to)) throw new Error("bad range")
        list.addRange(from, to, family(from))
      } else {
        if (!isIP(entry)) throw new Error("bad address")
        list.addAddress(entry, family(entry))
      }
    } catch {
      bad.push(entry)
    }
  }
  return { entries, bad, list }
}

/** A client socket address in plain form (`::ffff:1.2.3.4` becomes `1.2.3.4`). */
function plainAddress(address) {
  const text = String(address ?? "")
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text)
  return mapped !== null ? mapped[1] : text
}

/**
 * Whether a client address may connect. Loopback always may: it is this
 * machine itself, and a local HTTPS reverse proxy connects from it.
 */
export function addressAllowed(list, address) {
  const ip = plainAddress(address)
  if (ip === "::1" || ip.startsWith("127.")) return true
  if (list === undefined) return true
  const version = isIP(ip)
  if (version === 0) return false
  return list.check(ip, version === 6 ? "ipv6" : "ipv4")
}

/**
 * The addresses a remote device can reach this listener on: every external
 * IPv4 interface, those inside the allow list first (a VPN adapter in the
 * allowed range is usually the one to use).
 *
 * @param list - the parsed allow list, or undefined for any address.
 * @returns host literals, best first; never empty.
 */
export function reachableHosts(list) {
  const hosts = []
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      const v4 = item.family === "IPv4" || item.family === 4
      if (v4 && !item.internal) hosts.push(item.address)
    }
  }
  if (hosts.length === 0) return ["127.0.0.1"]
  if (list === undefined) return hosts
  const inside = hosts.filter((host) => list.check(host, "ipv4"))
  return [...inside, ...hosts.filter((host) => !inside.includes(host))]
}

/** A remembered-device cookie value: `<expiry>.<signature>`. */
export function mintSession(settings, now = Date.now()) {
  const expiry = Math.floor(now / 1000 + SESSION_TTL_SECONDS).toString(36)
  return `${expiry}.${sessionSignature(settings, expiry)}`
}

/** Whether a cookie value is a live session for these gate settings. */
export function verifySession(settings, value, now = Date.now()) {
  const dot = typeof value === "string" ? value.indexOf(".") : -1
  if (dot <= 0) return false
  const expiry = value.slice(0, dot)
  if (!/^[0-9a-z]{1,12}$/.test(expiry) || parseInt(expiry, 36) * 1000 <= now) return false
  const given = Buffer.from(value.slice(dot + 1))
  const wanted = Buffer.from(sessionSignature(settings, expiry))
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

/**
 * The signing key covers the gate path and the password, so changing either —
 * or regenerating the server secret — signs every remembered device out.
 */
function sessionSignature(settings, expiry) {
  const key = createHmac("sha256", settings.cookieValue).update(`rap-session\0${settings.secretPath}\0${settings.password ?? ""}`).digest()
  return createHmac("sha256", key).update(expiry).digest("base64url")
}

/** Constant-time password comparison. */
function passwordMatches(given, wanted) {
  const a = createHash("sha256").update(String(given)).digest()
  const b = createHash("sha256").update(String(wanted)).digest()
  return timingSafeEqual(a, b)
}

const LOGIN_COPY = {
  zh: { title: "DSH 远程访问", prompt: "输入访问密码", button: "进入", wrong: "密码不对", locked: "尝试次数太多，请几分钟后再试" },
  en: { title: "DSH remote access", prompt: "Enter the access password", button: "Continue", wrong: "Wrong password", locked: "Too many attempts. Try again in a few minutes." },
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

/** The login page: one password field the browser can remember. */
export function loginPage({ action, next, error, lang }) {
  const t = LOGIN_COPY[lang] ?? LOGIN_COPY.en
  const message = error === "wrong" ? t.wrong : error === "locked" ? t.locked : ""
  return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(t.title)}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:Canvas;color:CanvasText}
form{width:min(320px,86vw);display:flex;flex-direction:column;gap:12px}
h1{font-size:20px;font-weight:600;margin:0 0 4px}
label{font-size:14px;opacity:.75}
input[type=password]{font-size:17px;padding:12px;border-radius:10px;border:1px solid #8886;background:transparent;color:inherit}
button{font-size:16px;padding:12px;border-radius:10px;border:0;background:#2563eb;color:#fff;font-weight:600}
p{margin:0;color:#dc2626;font-size:14px}
</style></head><body>
<form method="post" action="${escapeHtml(action)}">
<h1>${escapeHtml(t.title)}</h1>
<input type="text" name="username" value="dsh" autocomplete="username" hidden>
<label for="password">${escapeHtml(t.prompt)}</label>
<input id="password" type="password" name="password" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="${escapeHtml(next)}">
${message ? `<p role="alert">${escapeHtml(message)}</p>` : ""}
<button type="submit">${escapeHtml(t.button)}</button>
</form></body></html>
`
}

/**
 * Why a resolved configuration cannot start. `code` lets the page say it in the
 * user's language; `message` is the English line for the log.
 *
 * @param settings - resolved settings (secrets already generated).
 * @returns `{ code, message }`, or undefined when the values are usable.
 */
export function configProblem(settings) {
  const port = settings.listenPort
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { code: "bad-port", message: `listenPort must be an integer from 1 to 65535 (got ${port})` }
  if (!SECRET_PATH_PATTERN.test(settings.secretPath)) return { code: "bad-secret-path", message: "secretPath must be 4–32 letters, digits, '-' or '_'" }
  if (!COOKIE_VALUE_PATTERN.test(settings.cookieValue)) return { code: "bad-cookie", message: "cookieValue must be 8–128 letters, digits, '-' or '_'" }
  const allow = parseAllowList(settings.allowFrom)
  if (allow.bad.length > 0) return { code: "bad-allow", detail: allow.bad.join(", "), message: `allowFrom entries are not an IP, CIDR block or range: ${allow.bad.join(", ")}` }
  if (typeof settings.password === "string" && settings.password.length > 256) return { code: "bad-password", message: "password must be at most 256 characters" }
  if (settings.tlsEnabled && !settings.tlsPfxPath) return { code: "tls-no-cert", message: "tlsEnabled needs tlsPfxPath (a .pfx certificate file)" }
  return undefined
}

/** Byte size of a file, or 0 when it does not exist. */
function sizeOf(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * Shift the log ring one step: `<base>` → `<base>.1` → … → `<base>.<keep>`, the
 * oldest file dropped. Destinations are always freed before a rename, because
 * Windows `rename` refuses to overwrite an existing file.
 *
 * @param base - absolute path of the live log file.
 * @param keep - rotated files to keep; `<= 0` truncates instead of archiving.
 */
function rotateLog(base, keep) {
  if (keep <= 0) {
    try {
      writeFileSync(base, "")
    } catch {
      /* best effort */
    }
    return
  }
  try {
    rmSync(`${base}.${keep}`, { force: true })
  } catch {
    /* best effort */
  }
  for (let i = keep - 1; i >= 1; i -= 1) {
    try {
      renameSync(`${base}.${i}`, `${base}.${i + 1}`)
    } catch {
      /* that ring slot is empty */
    }
  }
  try {
    renameSync(base, `${base}.1`)
  } catch {
    /* nothing to rotate yet */
  }
}

/**
 * Append one timestamped line to `access.log`, rotating by size first.
 *
 * @param dir - directory holding the log (the plugin's own directory).
 * @param line - the message, without the timestamp or newline.
 * @param maxBytes - rotate before a write that would pass this size; `0` disables.
 * @param keep - rotated files to keep.
 */
function writeLogLine(dir, line, maxBytes, keep) {
  const base = dir + "access.log"
  const entry = `[${new Date().toISOString()}] ${line}\n`
  const cap = typeof maxBytes === "number" ? maxBytes : DEFAULT_LOG_MAX_BYTES
  if (cap > 0 && sizeOf(base) + Buffer.byteLength(entry) > cap) {
    rotateLog(base, typeof keep === "number" ? keep : DEFAULT_LOG_KEEP)
  }
  appendFileSync(base, entry)
}

/**
 * Build the gate + forward server for one resolved settings value.
 *
 * @param settings - resolved proxy settings (gate + upstream).
 * @param log - `(line) => void` diagnostic sink.
 * @param getDshCookie - `() => Promise<string | undefined>`; the proxy-held DSH
 *   session cookie, exchanged from the launch token on first need.
 * @param onUpstream401 - invoked when the upstream answers 401 to a gated
 *   request (stale DSH cookie); drop it and refresh in the background.
 */
function buildServer(settings, log, getDshCookie, onUpstream401, onDenied) {
  const { secretPath, upstreamHost, upstreamPort } = settings
  /** Every live socket, both sides of a bridged websocket included, so a stop can end them all. */
  const sockets = new Set()
  const track = (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  }
  const prefix = "/" + secretPath
  const password = settings.password || ""
  const allow = parseAllowList(settings.allowFrom).list
  /** Failed logins per client address: timestamps inside LOGIN_WINDOW_MS. */
  const failures = new Map()

  /** Whether the request carries a live remembered-device cookie. */
  function hasGate(headers) {
    const raw = headers.cookie || ""
    for (const part of raw.split(";")) {
      const idx = part.indexOf("=")
      if (idx < 0) continue
      if (part.slice(0, idx).trim() === GATE_COOKIE && verifySession(settings, part.slice(idx + 1).trim())) return true
    }
    return false
  }

  function sessionCookie() {
    return `${GATE_COOKIE}=${mintSession(settings)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Strict${settings.tlsEnabled ? "; Secure" : ""}`
  }

  /** A page load (not a fetch or an asset): the place to show the login form. */
  function isDocument(req) {
    const dest = req.headers["sec-fetch-dest"]
    if (typeof dest === "string") return dest === "document"
    return String(req.headers.accept || "").includes("text/html")
  }

  function language(req) {
    return /^\s*zh/i.test(String(req.headers["accept-language"] || "")) ? "zh" : "en"
  }

  /** Where to go after login: only somewhere under the gate path. */
  function safeNext(value) {
    return typeof value === "string" && value.startsWith(prefix + "/") && !value.startsWith(prefix + "/__rap/") ? value : prefix + "/"
  }

  function recentFailures(address) {
    const now = Date.now()
    const list = (failures.get(address) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS)
    if (list.length > 0) failures.set(address, list)
    else failures.delete(address)
    return list
  }

  function sendLogin(req, res, status, next, error) {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    })
    res.end(req.method === "HEAD" ? undefined : loginPage({ action: prefix + LOGIN_ROUTE, next, error, lang: language(req) }))
  }

  function handleLogin(req, res) {
    const address = plainAddress(req.socket.remoteAddress)
    let body = ""
    let tooBig = false
    req.setEncoding("utf8")
    req.on("data", (chunk) => {
      body += chunk
      if (body.length > 8192) {
        tooBig = true
        req.destroy()
      }
    })
    req.on("end", () => {
      if (tooBig) return
      const form = new URLSearchParams(body)
      const next = safeNext(form.get("next"))
      if (recentFailures(address).length >= LOGIN_MAX_FAILURES) {
        log(`LOGIN-LOCKED ${address}`)
        sendLogin(req, res, 429, next, "locked")
        return
      }
      if (password !== "" && passwordMatches(form.get("password") ?? "", password)) {
        failures.delete(address)
        log(`LOGIN ${address}`)
        res.writeHead(303, { location: next, "set-cookie": sessionCookie(), "cache-control": "no-store" })
        res.end()
        return
      }
      failures.set(address, [...recentFailures(address), Date.now()])
      log(`LOGIN-FAIL ${address}`)
      // A short pause makes guessing slow without bothering a person.
      setTimeout(() => sendLogin(req, res, 401, next, "wrong"), 400)
    })
  }

  function routePath(pathname) {
    if (pathname === prefix) return "/"
    if (pathname.startsWith(prefix + "/")) return pathname.slice(prefix.length)
    return undefined
  }

  /**
   * Present any request to DSH as loopback: the /api trust fence accepts it no
   * matter which VPN/reverse-proxy front this proxy sits behind (stripping
   * Origin satisfies the fence's same-origin check). The proxy-held DSH cookie
   * satisfies the browser-auth gate, and replacing the client's own Cookie
   * header keeps it from reaching DSH. Security is still our gate in front.
   */
  function upstreamHeaders(req, cookie) {
    const headers = { ...req.headers }
    headers.host = `${upstreamHost}:${upstreamPort}`
    delete headers.origin
    if (cookie === undefined) delete headers.cookie
    else headers.cookie = cookie
    return headers
  }

  /**
   * Upstream path with the launch token stripped — the proxy owns the DSH cookie.
   *
   * Operates on the RAW query string: DSH's client-plugin bundler serves bundles
   * at `/plugins/??<id>,<id>&rev=<hash>`, a scheme whose `?`, `,`, `@` and `/`
   * must reach the upstream verbatim. A URL/searchParams round-trip percent-
   * encodes them (`??id` -> `?%3Fid`), the bundle 404s, and every client plugin
   * (incl. the `@deepseek-ai/dsh-client-modules` bootstrap) fails to preload.
   * So drop only the `token=` segment, textually, and touch nothing else.
   */
  function upstreamTarget(path, search) {
    if (!search || search.indexOf("token=") === -1) return path + search
    const lead = /^\?+/.exec(search)?.[0] ?? "?"
    const kept = search.slice(lead.length).split("&").filter((part) => !part.startsWith("token="))
    return kept.length > 0 ? path + lead + kept.join("&") : path
  }

  async function forward(req, res, path, search, gated, setGate) {
    const cookie = await getDshCookie()
    const upstreamReq = http.request(
      {
        hostname: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: upstreamTarget(path, search),
        headers: upstreamHeaders(req, cookie),
      },
      (upRes) => {
        if (upRes.statusCode === 401) onUpstream401?.()
        const outHeaders = { ...upRes.headers }
        if (gated) {
          // Defensive: today the token is always stripped, so DSH never redirects
          // on the gate path; should it ever answer a root-relative Location,
          // re-enter through the gate instead of the ungated origin root.
          if (typeof outHeaders.location === "string" && outHeaders.location.startsWith("/")) {
            outHeaders.location = prefix + outHeaders.location
          }
        }
        // Each page load renews the remembered device for another 30 days.
        if (setGate) outHeaders["set-cookie"] = sessionCookie()
        res.writeHead(upRes.statusCode || 502, outHeaders)
        upRes.pipe(res)
      },
    )
    upstreamReq.on("error", (err) => {
      log(`upstream error ${err.code || err.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" })
        res.end("bad gateway\n")
      } else res.destroy()
    })
    req.pipe(upstreamReq)
  }

  const handler = (req, res) => {
    const url = new URL(req.url, "http://" + (req.headers.host || "local"))
    const path = routePath(url.pathname)
    if (url.pathname === prefix && (req.method === "GET" || req.method === "HEAD")) {
      // The client resolves its assets against `<base href="./">`: without the
      // trailing slash they would land outside the gate path.
      log(`ENTRY ${req.method} ${req.url} -> ${prefix}/`)
      res.writeHead(308, { location: prefix + "/" + url.search })
      res.end()
      return
    }
    if (path === LOGIN_ROUTE && req.method === "POST") return handleLogin(req, res)
    if (path === LOGOUT_ROUTE) {
      log(`LOGOUT ${plainAddress(req.socket.remoteAddress)}`)
      res.writeHead(303, { location: prefix + "/", "set-cookie": `${GATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`, "cache-control": "no-store" })
      res.end()
      return
    }
    const authed = hasGate(req.headers)
    if (path !== undefined) {
      if (password === "" || authed) {
        log(`ENTRY ${req.method} ${req.url}`)
        return forward(req, res, path, url.search, true, isDocument(req) || !authed)
      }
      if ((req.method === "GET" || req.method === "HEAD") && isDocument(req)) {
        log(`LOGIN-PAGE ${req.method} ${req.url}`)
        return sendLogin(req, res, 200, safeNext(url.pathname + url.search))
      }
      log(`UNAUTH ${req.method} ${req.url}`)
      res.writeHead(401, { "content-type": "text/plain" })
      res.end("sign in first\n")
      return
    }
    if (authed) {
      log(`PASS ${req.method} ${req.url}`)
      return forward(req, res, url.pathname, url.search, false, false)
    }
    log(`DENY ${req.method} ${req.url}`)
    res.writeHead(403, { "content-type": "text/plain" })
    res.end("forbidden\n")
  }

  const handleUpgrade = async (req, socket, head) => {
    const url = new URL(req.url, "http://" + (req.headers.host || "local"))
    const path = routePath(url.pathname)
    const authed = hasGate(req.headers)
    const allowed = authed || (path !== undefined && password === "")
    if (!allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n")
      socket.destroy()
      return
    }
    const target = path !== undefined ? path : url.pathname
    const cookie = await getDshCookie()
    const upstreamReq = http.request({
      hostname: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: upstreamTarget(target, url.search),
      headers: upstreamHeaders(req, cookie),
    })
    upstreamReq.on("upgrade", (upRes, upSocket, upHead) => {
      log(`WS-UPGRADE ${req.url}`)
      socket.write("HTTP/1.1 101 Switching Protocols\r\n")
      for (const [key, value] of Object.entries(upRes.headers)) {
        if (Array.isArray(value)) value.forEach((item) => socket.write(`${key}: ${item}\r\n`))
        else socket.write(`${key}: ${value}\r\n`)
      }
      socket.write("\r\n")
      if (upHead && upHead.length) socket.write(upHead)
      track(upSocket)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
      socket.on("error", () => upSocket.destroy())
      upSocket.on("error", () => socket.destroy())
    })
    upstreamReq.on("error", (err) => {
      log(`WS upstream error ${err.code || err.message}`)
      socket.destroy()
    })
    if (head && head.length) upstreamReq.write(head)
    upstreamReq.end()
  }

  // TLS (self-signed cert) when enabled: browsers require a secure context for
  // crypto.randomUUID, so plain-HTTP remote access breaks the web client.
  let server
  if (settings.tlsEnabled) {
    try {
      server = https.createServer(
        { pfx: readFileSync(settings.tlsPfxPath), passphrase: settings.tlsPassphrase || "" },
        handler,
      )
    } catch (err) {
      log(`TLS init failed (${err.message}); proxy NOT started — set tlsEnabled=false for plain HTTP, or fix tlsPfxPath/tlsPassphrase`)
      return { code: "tls-load", error: `TLS certificate could not be loaded: ${err.message}` }
    }
  } else {
    server = http.createServer(handler)
  }
  server.on("upgrade", handleUpgrade)
  // The allow list acts like a firewall: a client outside it is dropped before
  // any byte (or TLS handshake) is exchanged, so a scan learns nothing.
  server.on("connection", (socket) => {
    if (addressAllowed(allow, socket.remoteAddress)) {
      track(socket)
      return
    }
    const address = plainAddress(socket.remoteAddress)
    log(`DENY-ADDRESS ${address}`)
    onDenied?.(address)
    socket.destroy()
  })

  /**
   * Stop listening. `hard` also ends every open connection at once — keep-alive
   * sockets, requests in flight and bridged websockets — so nothing of this
   * instance outlives it (a hot swap disposes it; the browser reconnects to the
   * new version). A configuration restart is soft: it frees the port and closes
   * idle keep-alive sockets, and a websocket open now keeps running.
   */
  function stop(hard) {
    try {
      server.close()
    } catch {
      /* already closed */
    }
    if (hard) {
      try {
        server.closeAllConnections?.()
      } catch {
        /* best effort */
      }
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    } else {
      try {
        server.closeIdleConnections?.()
      } catch {
        /* best effort */
      }
    }
  }

  return { server, stop }
}

/**
 * Mount the proxy and keep it in step with the plugin's live configuration.
 *
 * @param ctx - the plugin context (`connection` is injected).
 * @param config - the schema-parsed Config: one `Volatile` reference per field.
 */
export function apply(ctx, config) {
  let server = undefined
  /** Stops the running server (soft or hard); see buildServer. */
  let stopServer = undefined
  let current = undefined
  let dshCookie = undefined
  let exchanging = undefined
  /**
   * What the configuration page shows: whether the listener is up and, if not,
   * why. `state` is one of starting | listening | disabled | error.
   */
  let status = { state: "starting" }
  /** The last client address the allow list turned away, for the page. */
  let lastDenied = undefined
  /**
   * This package's installed version. Read on every use, not once: an update
   * whose host file is unchanged (only the page or the metadata changed) is
   * installed without remounting this instance, and the page must still see
   * the new number.
   */
  const installedVersion = () => packageVersion()
  const version = installedVersion()
  const source = updateSource()
  /**
   * What the page shows about releases. `state`: off | pending | checking |
   * current | available | failed; `checkedAt` is the last finished check,
   * `latest` the newest release tag seen, `error` why the last check failed.
   */
  let update = { state: "pending" }
  let updateTimer = undefined
  let updateInterval = undefined
  let checking = undefined
  /** Aborts a check in flight when this instance goes away. */
  const updateAbort = new AbortController()

  // This plugin ships its own page for its row; tell the settings service not to
  // offer a generated one. Optional: a deployment without settings still runs.
  ctx.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), "dsh-remote-access-proxy: page policy")
  })

  function log(line) {
    try {
      writeLogLine(HERE, line, current?.logMaxBytes, current?.logKeep)
    } catch {
      /* best effort */
    }
  }

  /** Record a failure the page should show, and say it on the DSH console too. */
  function fail(message, code = "error", detail) {
    status = { state: "error", code, error: message, ...(detail !== undefined ? { detail } : {}) }
    log(message)
    ctx.logger?.warn?.("remote-access-proxy: %s", message)
  }

  /** The status document the configuration page renders. */
  function statusDocument() {
    const settings = current
    const doc = { ...status, version: installedVersion(), update: updateDocument() }
    if (settings !== undefined) {
      const scheme = settings.tlsEnabled ? "https" : "http"
      doc.scheme = scheme
      const allow = parseAllowList(settings.allowFrom)
      doc.listenPort = settings.listenPort
      doc.upstream = `${settings.upstreamHost}:${settings.upstreamPort}`
      doc.tls = settings.tlsEnabled === true
      doc.password = typeof settings.password === "string" && settings.password !== ""
      doc.allowFrom = allow.bad.length === 0 ? allow.entries : []
      if (lastDenied !== undefined) doc.lastDenied = lastDenied
      doc.updateCheck = settings.updateCheck !== false
      doc.urls = reachableHosts(allow.bad.length === 0 ? allow.list : undefined).map((host) => `${scheme}://${host.includes(":") ? `[${host}]` : host}:${settings.listenPort}/${settings.secretPath}/`)
    }
    return doc
  }

  /** The update part of the status document; `spec` is what the page installs. */
  function updateDocument() {
    const running = installedVersion()
    const doc = { ...update, source: source.spec }
    // A release found earlier may be installed by now.
    if (doc.state === "available" && running !== undefined && compareVersions(doc.latest, running) <= 0) doc.state = "current"
    if (doc.stale === "available" && running !== undefined && compareVersions(doc.latest, running) <= 0) delete doc.stale
    if (doc.latest !== undefined) doc.spec = releaseSpec(source, doc.latest)
    if (running !== undefined) doc.currentSpec = releaseSpec(source, `v${running}`)
    return doc
  }

  /**
   * Read the release tags once and record the verdict. Failures (offline, rate
   * limited, no git) are recorded for the page and never thrown or retried
   * early: the next scheduled check tries again.
   */
  function checkForUpdate() {
    if (checking !== undefined) return checking
    const running = installedVersion()
    if (running === undefined) {
      update = { state: "failed", error: "own version unreadable", checkedAt: new Date().toISOString() }
      return Promise.resolve()
    }
    const previous = update
    update = { ...previous, state: "checking" }
    const signal = AbortSignal.any([updateAbort.signal, AbortSignal.timeout(20000)])
    checking = fetchReleaseTags(source, { api: process.env.DSH_RAP_UPDATE_API || undefined, signal })
      .then((tags) => {
        update = { ...updateVerdict(tags, running), checkedAt: new Date().toISOString() }
        log(`update check: ${update.state}${update.latest ? ` (newest ${update.latest}, running ${running})` : ""}`)
      }, (error) => {
        if (updateAbort.signal.aborted) return
        const message = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timed out" : String(error?.message ?? error).split("\n")[0].slice(0, 200)
        // Keep what an earlier check found: a transient failure does not hide a known release.
        update = { ...(previous.latest !== undefined ? { latest: previous.latest } : {}), state: "failed", error: message, checkedAt: new Date().toISOString(), ...(previous.state === "available" ? { stale: "available" } : {}) }
        log(`update check failed: ${message}`)
      })
      .finally(() => {
        checking = undefined
      })
    return checking
  }

  /** Follow the `updateCheck` switch: schedule checks while on, clear them while off. */
  function scheduleUpdateChecks(enabled) {
    if (!enabled) {
      clearTimeout(updateTimer)
      clearInterval(updateInterval)
      updateTimer = undefined
      updateInterval = undefined
      update = { state: "off" }
      return
    }
    if (updateTimer !== undefined || updateInterval !== undefined) return
    if (update.state === "off") update = { state: "pending" }
    const delay = Number(process.env.DSH_RAP_UPDATE_DELAY_MS)
    updateTimer = setTimeout(() => {
      updateTimer = undefined
      void checkForUpdate()
      updateInterval = setInterval(() => void checkForUpdate(), UPDATE_INTERVAL_MS)
      updateInterval.unref?.()
    }, Number.isFinite(delay) && delay >= 0 ? delay : UPDATE_DELAY_MS)
    updateTimer.unref?.()
  }

  // The page reads the live status through DSH's own authenticated /api channel,
  // so it is exactly as private as the rest of the API.
  if (typeof ctx.connection?.fetch?.register === "function") {
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register({
        path: STATUS_ROUTE,
        methods: ["GET"],
        requestBody: "buffered",
        fetch: async () => new Response(JSON.stringify(statusDocument()), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        }),
      })
      return () => {
        void Promise.resolve(typeof dispose === "function" ? dispose() : undefined).catch(() => {})
      }
    }, "dsh-remote-access-proxy: status route")
    // "Check now" on the page: one check, answered with the fresh status.
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register({
        path: UPDATE_CHECK_ROUTE,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async () => {
          if (current?.updateCheck !== false) await checkForUpdate()
          return new Response(JSON.stringify(statusDocument()), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
          })
        },
      })
      return () => {
        void Promise.resolve(typeof dispose === "function" ? dispose() : undefined).catch(() => {})
      }
    }, "dsh-remote-access-proxy: update check route")
  }

  /** Read one `.get()` per configured field; an absent field keeps its schema default. */
  function readConfig() {
    const parsed = config ?? Config({})
    const values = {}
    for (const field of FIELDS) {
      const ref = parsed[field]
      values[field] = ref !== undefined && typeof ref.get === "function" ? ref.get() : ref
    }
    return values
  }

  /**
   * Write generated values back into the active profile's plugin configuration.
   *
   * The values live in the profile's own `cordis.patch.yml`, so the write goes
   * through the configuration editor — once the Loader has settled *and* outside
   * the hot-reload transaction that is mounting this plugin, because the editor
   * refuses to run re-entrantly ("HMR transactions cannot be nested").
   * Without an editor (a profile-less run) the generated values stay
   * process-local and change on the next start.
   */
  function persistConfig(patch) {
    const entry = ctx.fiber?.entry
    const editor = ctx.get?.("configEditor")
    if (entry === undefined || editor === undefined) {
      log("no profile configuration editor; generated values are process-local")
      return
    }
    // HMR's guard rejects re-entrant edits with this exact message; another
    // transaction (ours, or a peer plugin's) may still be in flight.
    const NESTED = /HMR transactions cannot be nested/i
    const MAX_ATTEMPTS = 5
    const write = (attempts = MAX_ATTEMPTS) => {
      editor.edit(entry, (existing = {}) => ({ ...existing, ...patch })).catch((error) => {
        const message = error?.message ?? String(error)
        if (attempts > 0 && NESTED.test(message)) {
          // Retry outside the current async store rather than dropping the value.
          setTimeout(() => outside(() => write(attempts - 1)), 250)
          return
        }
        log(`configuration write failed (${error?.message ?? error}); generated values are process-local`)
      })
    }
    // `configEditor.edit` runs through `hmr.runExclusive`, and this plugin's
    // apply()/commit runs *inside* HMR's transaction: the guard rejects with
    // "HMR transactions cannot be nested". AsyncLocalStorage keeps the store on
    // every continuation the transaction started — including one chained off
    // `loader.await()` — so leaving the context explicitly is the only way out
    // (the loader's own config watcher does the same). `runExclusive` then
    // queues the edit behind the in-flight transaction.
    const hmr = ctx.get?.("hmr")
    const outside = hmr?.executing !== undefined && typeof hmr.executing.exit === "function"
      ? (work) => hmr.executing.exit(work)
      : (work) => work()
    const loader = ctx.root?.loader
    const settled = loader !== undefined && typeof loader.await === "function" ? loader.await() : Promise.resolve()
    settled.then(() => outside(write), () => outside(write))
  }

  /**
   * Resolve the upstream address this proxy fronts.
   *
   * Both fields may be left unset (empty host / port 0) to follow the running
   * instance: the in-process web server publishes its address as `webStartup`,
   * so `dsh web`'s `--port 3080` default and the desktop launcher's hard-coded
   * `--port 19387` are picked up automatically. An explicit value always wins;
   * the last resort is the historical loopback 127.0.0.1:3080.
   */
  function resolveUpstream(settings) {
    const live = ctx.get?.("webStartup")
    let host = settings.upstreamHost || live?.host || "127.0.0.1"
    // A bind address is not a connect address: 0.0.0.0/:: mean "every host".
    if (host === "0.0.0.0" || host === "::" || host === "[::]" || host === "*") host = "127.0.0.1"
    const port = settings.upstreamPort || live?.port || 3080
    if (!settings.upstreamHost || !settings.upstreamPort) {
      log(`upstream ${host}:${port}${live === undefined ? " (webStartup unavailable, using fallback)" : " (auto)"}`)
    }
    return { upstreamHost: host, upstreamPort: port }
  }

  function ensureSecrets(settings) {
    const patch = {}
    if (!settings.secretPath) patch.secretPath = genToken(12)
    if (!settings.cookieValue) patch.cookieValue = genToken(24)
    if (Object.keys(patch).length > 0) {
      persistConfig(patch)
      return { ...settings, ...patch }
    }
    return settings
  }

  /** The launch token of this DSH process, read from the connection service. */
  function launchToken(settings) {
    try {
      const base = `http://${settings.upstreamHost}:${settings.upstreamPort}`
      return new URL(ctx.connection.authenticatedUrl(base)).searchParams.get("token") || undefined
    } catch (err) {
      log(`launch token unavailable (${err.message})`)
      return undefined
    }
  }

  /** Exchange the launch token for DSH's authority-bound session cookie. */
  function exchangeDshCookie(settings) {
    const host = settings.upstreamHost
    const port = settings.upstreamPort
    const token = launchToken(settings)
    if (!token) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const req = http.request(
        { hostname: host, port, method: "GET", path: "/?token=" + encodeURIComponent(token), headers: { host: `${host}:${port}` } },
        (res) => {
          const setCookie = res.headers["set-cookie"]
          res.resume()
          if (res.statusCode === 303 && Array.isArray(setCookie)) {
            for (const line of setCookie) {
              const pair = line.split(";")[0]
              if (pair.startsWith("dsh-auth-")) {
                dshCookie = pair
                log("DSH session cookie acquired")
                return resolve(pair)
              }
            }
          }
          log(`DSH session exchange returned ${res.statusCode || "no status"}`)
          resolve(undefined)
        },
      )
      req.on("error", (err) => {
        log(`DSH session exchange error ${err.code || err.message}`)
        resolve(undefined)
      })
      req.end()
    })
  }

  /** Return the held DSH cookie, exchanging on first need (concurrent-safe). */
  function getDshCookie() {
    if (dshCookie !== undefined) return Promise.resolve(dshCookie)
    if (exchanging !== undefined) return exchanging
    if (current === undefined) return Promise.resolve(undefined)
    exchanging = exchangeDshCookie(current).finally(() => {
      exchanging = undefined
    })
    return exchanging
  }

  /** Upstream 401 means our DSH cookie is stale; drop and refresh it. */
  function onUpstream401() {
    if (dshCookie === undefined) return
    dshCookie = undefined
    log("DSH 401 observed; refreshing session cookie")
    void getDshCookie()
  }

  /**
   * Releases before 1.2 named the row by a relative path (`./plugin/…mjs`). DSH
   * resolved it to an absolute file URL, and the configuration editor copied that
   * URL into the user patch together with the generated gate values. The bundle
   * now names the row by its package, and a user row naming a different module
   * no longer applies to it — the saved gate path and cookie would be silently
   * replaced by fresh ones, and the address every device bookmarked would die.
   *
   * So rewrite such a stale row's `name:` to the package, synchronously, before
   * the first start. The loader's config watcher then reconciles the row and the
   * saved values arrive as an ordinary volatile update.
   *
   * @returns true when the user patch was rewritten.
   */
  function healUserPatch() {
    const path = ctx.get?.("configEditor")?.documentPath
    if (typeof path !== "string") return false
    let text
    try {
      text = readFileSync(path, "utf8")
    } catch {
      return false
    }
    let inRow = false
    let changed = false
    const lines = text.split("\n").map((line) => {
      const id = /^\s*-\s+id:\s*(['"]?)([^'"\s]+)\1\s*$/.exec(line)
      if (id !== null) {
        inRow = id[2] === NS
        return line
      }
      if (/^\s*-\s/.test(line)) inRow = false
      if (!inRow) return line
      const match = /^(\s*)name:\s*(.*?)\s*$/.exec(line)
      if (match === null) return line
      const value = match[2].replace(/^(['"])(.*)\1$/, "$2").replace(/\\/g, "/")
      if (value === PACKAGE || !value.endsWith("plugin/dsh-remote-access-proxy.mjs")) return line
      changed = true
      return `${match[1]}name: ${PACKAGE}${line.endsWith("\r") ? "\r" : ""}`
    })
    if (!changed) return false
    try {
      writeFileSync(path, lines.join("\n"))
      log(`migrated the row's module name to "${PACKAGE}" in ${path}`)
      return true
    } catch (error) {
      log(`could not migrate the row's module name (${error.message})`)
      return false
    }
  }

  function start(settings) {
    stop(false)
    scheduleUpdateChecks(settings.updateCheck !== false)
    if (awaitingMigration && (!settings.secretPath || !settings.cookieValue)) {
      status = { state: "starting" }
      log("waiting for the migrated configuration before starting")
      return
    }
    const resolved = ensureSecrets({ ...settings, ...resolveUpstream(settings) })
    current = resolved
    if (!resolved.enabled) {
      status = { state: "disabled" }
      log("disabled")
      return
    }
    const problem = configProblem(resolved)
    if (problem !== undefined) {
      fail(`not started: ${problem.message}`, problem.code, problem.detail)
      return
    }
    lastDenied = undefined
    const built = buildServer(resolved, log, getDshCookie, onUpstream401, (address) => {
      lastDenied = { address, at: new Date().toISOString() }
    })
    if (built.error !== undefined) {
      fail(built.error, built.code)
      return
    }
    const own = built.server
    server = own
    stopServer = built.stop
    status = { state: "starting" }
    own.on("error", (err) => {
      if (server !== own) return
      // A machine with IPv6 turned off cannot bind "::"; every-interface IPv4 then.
      if (bindHost === "::" && (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL")) {
        bindHost = "0.0.0.0"
        own.listen(resolved.listenPort, bindHost, onListening)
        return
      }
      // The instance this one replaces (a hot swap, a restart) may still be
      // releasing the port for a moment: try again briefly before giving up.
      if (err.code === "EADDRINUSE" && bindRetries > 0) {
        bindRetries -= 1
        setTimeout(() => {
          if (server === own) own.listen(resolved.listenPort, bindHost, onListening)
        }, 250)
        return
      }
      const code = { EADDRINUSE: "port-in-use", EACCES: "port-denied" }[err.code] ?? "listen-error"
      const reason = err.code === "EADDRINUSE"
        ? `port ${resolved.listenPort} is already in use (another program, or a second DSH app sharing this profile)`
        : err.code === "EACCES"
          ? `no permission to listen on port ${resolved.listenPort}`
          : `listener error ${err.code || err.message}`
      fail(reason, code)
      server = undefined
    })
    // Every interface, IPv6 and IPv4 alike; who may connect is the allow list's job.
    let bindHost = "::"
    let bindRetries = 8
    const onListening = () => {
      if (server !== own) return
      status = { state: "listening" }
      log(`listening on ${bindHost === "::" ? "[::]" : bindHost}:${resolved.listenPort}${version ? ` v${version}` : ""} secret=/${resolved.secretPath} password=${resolved.password ? "on" : "off"} allow=${resolved.allowFrom || "any"}`)
    }
    own.listen(resolved.listenPort, bindHost, onListening)
    // Warm the DSH session cookie so the first remote request is fast.
    void getDshCookie()
  }

  /** Stop the listener; `hard` (dispose) also ends every open connection. */
  function stop(hard) {
    if (server !== undefined) {
      try {
        stopServer?.(hard)
      } catch {
        /* already closed */
      }
      server = undefined
      stopServer = undefined
    }
  }

  // A migrated user patch brings the saved gate values back through the loader
  // watcher; until then, do not mint (and persist) replacements for them.
  let awaitingMigration = healUserPatch()
  let migrationTimer
  if (awaitingMigration) {
    migrationTimer = setTimeout(() => {
      if (!awaitingMigration) return
      awaitingMigration = false
      log("migrated values did not arrive; starting with the current configuration")
      start(readConfig())
    }, 10000)
    migrationTimer.unref?.()
  }
  start(readConfig())

  // A volatile-only configuration edit keeps this instance and lands here.
  ctx.on("loader/volatile-update", () => {
    awaitingMigration = false
    clearTimeout(migrationTimer)
    start(readConfig())
  })

  ctx.effect(() => () => {
    clearTimeout(migrationTimer)
    clearTimeout(updateTimer)
    clearInterval(updateInterval)
    updateAbort.abort()
    stop(true)
    log(`stopped${version ? ` (v${version})` : ""}`)
  }, "dsh-remote-access-proxy: proxy server")
}
