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
 * session with a per-process launch token (`http://127.0.0.1:3080/?token=…`)
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
import { appendFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import z from "@deepseek-ai/schemastery"

export const name = "dsh-remote-access-proxy"

/**
 * Required services. `connection` carries this process's launch token. The
 * settings service is deliberately NOT required: the plugin's configuration is
 * its own Config, so the proxy still runs — and still serves remote clients —
 * in a deployment that mounts no settings forms at all.
 */
export const inject = ["connection"]

/** Profile entry id of the host row. On DSH 0.1.7+ this IS the settings namespace. */
const NS = "remote-access-proxy"
const HERE = fileURLToPath(new URL(".", import.meta.url))
/** Name of the HttpOnly cookie this proxy's gate mints. */
const GATE_COOKIE = "dsh_et_gate"
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
  upstreamHost: z.string().default("127.0.0.1").volatile(),
  upstreamPort: z.number().default(3080).volatile(),
  tlsEnabled: z.boolean().default(false).volatile(),
  tlsPfxPath: z.string().default("").volatile(),
  tlsPassphrase: z.string().default("").volatile(),
  // access.log rotation: rotate before a write that would pass this size
  // (0 = never rotate, the pre-rotation behaviour); how many rotated files to
  // keep (0 = keep no history, just truncate).
  logMaxBytes: z.number().default(DEFAULT_LOG_MAX_BYTES).volatile(),
  logKeep: z.number().default(DEFAULT_LOG_KEEP).volatile(),
})

function genToken(length) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""
  for (let i = 0; i < length; i += 1) out += chars[Math.floor(Math.random() * chars.length)]
  return out
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
          outHeaders["set-cookie"] = `${GATE_COOKIE}=${cookieValue}; Path=/; HttpOnly; SameSite=Strict`
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
      return undefined
    }
  } else {
    server = http.createServer(handler)
  }
  server.on("upgrade", handleUpgrade)

  return server
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
   * through the configuration editor — and only once the Loader has settled, or
   * the edit would re-enter the reconcile that is still mounting this plugin.
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
    const write = () => {
      editor.edit(entry, (existing = {}) => ({ ...existing, ...patch })).catch((error) => {
        log(`configuration write failed (${error?.message ?? error}); generated values are process-local`)
      })
    }
    const loader = ctx.root?.loader
    if (loader !== undefined && typeof loader.await === "function") loader.await().then(write, write)
    else queueMicrotask(write)
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
      const base = `http://${settings.upstreamHost || "127.0.0.1"}:${settings.upstreamPort || 3080}`
      return new URL(ctx.connection.authenticatedUrl(base)).searchParams.get("token") || undefined
    } catch (err) {
      log(`launch token unavailable (${err.message})`)
      return undefined
    }
  }

  /** Exchange the launch token for DSH's authority-bound session cookie. */
  function exchangeDshCookie(settings) {
    const host = settings.upstreamHost || "127.0.0.1"
    const port = settings.upstreamPort || 3080
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

  function start(settings) {
    stop()
    const resolved = ensureSecrets(settings)
    current = resolved
    if (!resolved.enabled) {
      log("disabled")
      return
    }
    server = buildServer(resolved, log, getDshCookie, onUpstream401)
    if (server === undefined) {
      log("proxy not started (see TLS init error above)")
      return
    }
    server.on("error", (err) => log(`server error ${err.code || err.message}`))
    server.listen(resolved.listenPort, resolved.listenHost, () => {
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

  start(readConfig())

  // A volatile-only configuration edit keeps this instance and lands here.
  ctx.on("loader/volatile-update", () => {
    start(readConfig())
  })

  ctx.effect(() => () => stop(), "dsh-remote-access-proxy: proxy server")
}
