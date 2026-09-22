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
 * - Configured on the web page: Settings → 插件配置 → 远程访问代理.
 *   Changes restart the embedded server without a DSH restart.
 *
 * DSH browser-auth bridge (2026-09-04): DSH now authenticates every browser
 * session with a per-process launch token (`http://127.0.0.1:3080/?token=…`)
 * plus an authority-bound signed cookie (`dsh-auth-*`); without it every /api
 * request is 401. This proxy therefore performs the token exchange itself and
 * forwards carrying the minted DSH cookie, so remote users keep the old gate
 * UX (random path + HttpOnly cookie) and never need to know the launch token.
 * The cookie is signed with a durable secret and lives 30 days, surviving DSH
 * restarts; an upstream 401 drops it and triggers a fresh exchange.
 */

import http from "node:http"
import https from "node:https"
import { appendFileSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import z from "@deepseek-ai/schemastery"

export const name = "dsh-remote-access-proxy"
export const inject = ["settings", "connection"]

const NS = "remote-access-proxy"
const HERE = fileURLToPath(new URL(".", import.meta.url))

const Schema = z.object({
  enabled: z.boolean().default(true),
  listenHost: z.string().default("0.0.0.0"),
  listenPort: z.number().default(13337),
  secretPath: z.string().default(""),
  cookieValue: z.string().default(""),
  upstreamHost: z.string().default("127.0.0.1"),
  upstreamPort: z.number().default(3080),
  tlsEnabled: z.boolean().default(false),
  tlsPfxPath: z.string().default(""),
  tlsPassphrase: z.string().default(""),
})

function genToken(length) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""
  for (let i = 0; i < length; i += 1) out += chars[Math.floor(Math.random() * chars.length)]
  return out
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
  const { secretPath, cookieName = "dsh_et_gate", cookieValue, upstreamHost, upstreamPort } = settings
  const prefix = "/" + secretPath

  function hasGate(headers) {
    const raw = headers.cookie || ""
    for (const part of raw.split(";")) {
      const idx = part.indexOf("=")
      if (idx < 0) continue
      if (part.slice(0, idx).trim() === cookieName && part.slice(idx + 1).trim() === cookieValue) return true
    }
    return false
  }

  function routePath(pathname) {
    if (pathname === prefix) return "/"
    if (pathname.startsWith(prefix + "/")) return pathname.slice(prefix.length)
    return undefined
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
    // Present the request to DSH as loopback so the /api trust fence accepts it
    // no matter which VPN/reverse-proxy front this proxy sits behind; stripping
    // Origin satisfies the fence's same-origin check. The proxy-held DSH cookie
    // satisfies the new browser-auth gate. Security is still our gate (random
    // path + HttpOnly cookie) in front of this proxy.
    const cookie = await getDshCookie()
    const headers = { ...req.headers }
    headers.host = `${upstreamHost}:${upstreamPort}`
    delete headers.origin
    if (cookie !== undefined) headers.cookie = cookie
    else delete headers.cookie
    const upstreamReq = http.request(
      { hostname: upstreamHost, port: upstreamPort, method: req.method, path: upstreamTarget(path, search), headers },
      (upRes) => {
        if (upRes.statusCode === 401) onUpstream401?.()
        const outHeaders = { ...upRes.headers }
        if (setGate) outHeaders["set-cookie"] = `${cookieName}=${cookieValue}; Path=/; HttpOnly; SameSite=Strict`
        if (setGate && typeof outHeaders.location === "string" && outHeaders.location.startsWith("/")) {
          outHeaders.location = prefix + outHeaders.location
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
    const headers = { ...req.headers }
    headers.host = `${upstreamHost}:${upstreamPort}`
    delete headers.origin
    if (cookie !== undefined) headers.cookie = cookie
    else delete headers.cookie
    const upstreamReq = http.request(
      { hostname: upstreamHost, port: upstreamPort, method: req.method, path: upstreamTarget(target, url.search), headers },
    )
    upstreamReq.on("upgrade", (upRes, upSocket, upHead) => {
      log(`WS-UPGRADE ${req.url}`)
      socket.write("HTTP/1.1 101 Switching Protocols\r\n")
      for (const [key, value] of Object.entries(upRes.headers)) {
        if (Array.isArray(value)) value.forEach((v) => socket.write(`${key}: ${value}\r\n`))
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

export function apply(ctx) {
  ctx.settings.register(NS, Schema, { base: {} })
  let server = undefined
  let current = undefined
  let dshCookie = undefined
  let exchanging = undefined

  function log(line) {
    try {
      appendFileSync(HERE + "access.log", `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      /* best effort */
    }
  }

  function ensureSecrets(settings) {
    const patch = {}
    if (!settings.secretPath) patch.secretPath = genToken(12)
    if (!settings.cookieValue) patch.cookieValue = genToken(24)
    if (Object.keys(patch).length > 0) {
      ctx.settings.update(NS, patch).catch(() => {})
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

  start(ctx.settings.get(NS))

  ctx.on("settings/updated", (ns, next) => {
    if (ns === NS) start(next)
  })

  ctx.effect(() => () => stop())
}
