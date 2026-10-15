/**
 * dsh-remote-access-proxy — embedded open RPC gateway for the DSH web GUI, as a
 * host-plane plugin.
 *
 * - Starts/stops with DSH (plugin apply/dispose), no external tool needed.
 * - Binds to the configured interface (any VPN/network segment; easytier,
 *   ZeroTier, Tailscale, or a plain LAN/reverse-proxy front all work).
 * - Random-path + HttpOnly-cookie gate in front of the DSH app and its /api.
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
import { randomBytes } from "node:crypto"
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
/** Rotation defaults, used when a settings object predates the log fields. */
const DEFAULT_LOG_MAX_BYTES = 1024 * 1024
const DEFAULT_LOG_KEEP = 3

/** Every configurable field, in card order. */
const FIELDS = [
  "enabled",
  "listenHost",
  "listenPort",
  "secretPath",
  "cookieValue",
  "upstreamHost",
  "upstreamPort",
  "tlsEnabled",
  "tlsPfxPath",
  "tlsPassphrase",
  "logMaxBytes",
  "logKeep",
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
  listenHost: z.string().default("0.0.0.0").volatile(),
  listenPort: z.number().default(13337).volatile(),
  secretPath: z.string().default("").volatile(),
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
})

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
 * The addresses a remote device can reach this listener on: the bind address
 * itself, or every external IPv4 interface when bound to all of them.
 *
 * @param listenHost - the configured bind address.
 * @returns host literals, best first; never empty.
 */
export function reachableHosts(listenHost) {
  if (listenHost !== "0.0.0.0" && listenHost !== "::" && listenHost !== "") return [listenHost]
  const hosts = []
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      const v4 = item.family === "IPv4" || item.family === 4
      if (v4 && !item.internal) hosts.push(item.address)
    }
  }
  return hosts.length > 0 ? hosts : ["127.0.0.1"]
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
function buildServer(settings, log, getDshCookie, onUpstream401) {
  const { secretPath, cookieValue, upstreamHost, upstreamPort } = settings
  const prefix = "/" + secretPath

  function hasGate(headers) {
    const raw = headers.cookie || ""
    for (const part of raw.split(";")) {
      const idx = part.indexOf("=")
      if (idx < 0) continue
      if (part.slice(0, idx).trim() === GATE_COOKIE && part.slice(idx + 1).trim() === cookieValue) return true
    }
    return false
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

  async function forward(req, res, path, search, setGate) {
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
        if (setGate) {
          outHeaders["set-cookie"] = `${GATE_COOKIE}=${cookieValue}; Path=/; HttpOnly; SameSite=Strict${settings.tlsEnabled ? "; Secure" : ""}`
          // Defensive: today the token is always stripped, so DSH never redirects
          // on the gate path; should it ever answer a root-relative Location,
          // re-enter through the gate instead of the ungated origin root.
          if (typeof outHeaders.location === "string" && outHeaders.location.startsWith("/")) {
            outHeaders.location = prefix + outHeaders.location
          }
        }
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
    if (path !== undefined) {
      log(`ENTRY ${req.method} ${req.url}`)
      return forward(req, res, path, url.search, true)
    }
    if (hasGate(req.headers)) {
      log(`PASS ${req.method} ${req.url}`)
      return forward(req, res, url.pathname, url.search, false)
    }
    log(`DENY ${req.method} ${req.url}`)
    res.writeHead(403, { "content-type": "text/plain" })
    res.end("forbidden\n")
  }

  const handleUpgrade = async (req, socket, head) => {
    const url = new URL(req.url, "http://" + (req.headers.host || "local"))
    const path = routePath(url.pathname)
    const allowed = path !== undefined || hasGate(req.headers)
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

  return { server }
}

/**
 * Mount the proxy and keep it in step with the plugin's live configuration.
 *
 * @param ctx - the plugin context (`connection` is injected).
 * @param config - the schema-parsed Config: one `Volatile` reference per field.
 */
export function apply(ctx, config) {
  let server = undefined
  let current = undefined
  let dshCookie = undefined
  let exchanging = undefined
  /**
   * What the configuration page shows: whether the listener is up and, if not,
   * why. `state` is one of starting | listening | disabled | error.
   */
  let status = { state: "starting" }

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
  function fail(message, code = "error") {
    status = { state: "error", code, error: message }
    log(message)
    ctx.logger?.warn?.("remote-access-proxy: %s", message)
  }

  /** The status document the configuration page renders. */
  function statusDocument() {
    const settings = current
    const doc = { ...status }
    if (settings !== undefined) {
      const scheme = settings.tlsEnabled ? "https" : "http"
      doc.scheme = scheme
      doc.listenHost = settings.listenHost
      doc.listenPort = settings.listenPort
      doc.upstream = `${settings.upstreamHost}:${settings.upstreamPort}`
      doc.tls = settings.tlsEnabled === true
      doc.urls = reachableHosts(settings.listenHost).map((host) => `${scheme}://${host.includes(":") ? `[${host}]` : host}:${settings.listenPort}/${settings.secretPath}/`)
    }
    return doc
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
    stop()
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
      fail(`not started: ${problem.message}`, problem.code)
      return
    }
    const built = buildServer(resolved, log, getDshCookie, onUpstream401)
    if (built.error !== undefined) {
      fail(built.error, built.code)
      return
    }
    const own = built.server
    server = own
    status = { state: "starting" }
    own.on("error", (err) => {
      if (server !== own) return
      const code = { EADDRINUSE: "port-in-use", EADDRNOTAVAIL: "bad-address", EACCES: "port-denied" }[err.code] ?? "listen-error"
      const reason = err.code === "EADDRINUSE"
        ? `port ${resolved.listenPort} is already in use on ${resolved.listenHost} (another program, or a second DSH app sharing this profile)`
        : err.code === "EADDRNOTAVAIL"
          ? `${resolved.listenHost} is not an address of this machine`
          : err.code === "EACCES"
            ? `no permission to listen on port ${resolved.listenPort}`
            : `listener error ${err.code || err.message}`
      fail(reason, code)
      server = undefined
    })
    own.listen(resolved.listenPort, resolved.listenHost, () => {
      if (server !== own) return
      status = { state: "listening" }
      log(`listening on ${resolved.listenHost}:${resolved.listenPort} secret=/${resolved.secretPath}`)
    })
    // Warm the DSH session cookie so the first remote request is fast.
    void getDshCookie()
  }

  function stop() {
    if (server !== undefined) {
      try {
        server.close()
      } catch {
        /* already closed */
      }
      server = undefined
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
    stop()
  }, "dsh-remote-access-proxy: proxy server")
}
