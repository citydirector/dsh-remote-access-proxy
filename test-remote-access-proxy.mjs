/**
 * Standalone end-to-end test for dsh-remote-access-proxy.
 * Mocks the DSH upstream (launch-token exchange + dsh-auth cookie gate) and a
 * minimal cordis ctx (settings + connection), then exercises the proxy server.
 *
 * Run: node test-remote-access-proxy.mjs
 *
 * It loads the plugin beside this file — the copy a pnpm install of this bundle
 * deploys — so module resolution matches production when run from an installed
 * bundle, or after a local install. DSH_PLUGIN points at any other copy. The
 * plugin appends to its access.log; the harness snapshots that file and restores
 * it on exit, so test activity leaves no trace.
 */

import http from "node:http"
import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

const PLUGIN_URL = process.env.DSH_PLUGIN
  ? pathToFileURL(process.env.DSH_PLUGIN).href
  : new URL("./plugin/dsh-remote-access-proxy.mjs", import.meta.url).href
const REAL_LOG = join(dirname(fileURLToPath(PLUGIN_URL)), "access.log")
let LOG_BEFORE = ""
try {
  LOG_BEFORE = readFileSync(REAL_LOG, "utf8")
} catch {
  /* no log yet — the plugin creates it on first write */
}
function restoreLog() {
  try {
    writeFileSync(REAL_LOG, LOG_BEFORE)
  } catch {
    /* best effort */
  }
}
const LAUNCH_TOKEN = "TEST_LAUNCH_TOKEN_0123456789abcdef0123456789abcdef"

let passed = 0
let failed = 0
function check(name, cond, extra = "") {
  if (cond) {
    passed += 1
    console.log(`  PASS ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name} ${extra}`)
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Mock DSH upstream: token exchange + authority-bound cookie gate. */
function createMockDsh() {
  let validCookie = null // cookie value the mock currently accepts
  let rejectHeld = false // test knob: reject whatever cookie the client holds
  const cookieName = "dsh-auth-mock"

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://dsh.invalid")
    const cookie = (req.headers.cookie || "").split(";").find((c) => c.trim().startsWith(cookieName + "="))

    // launch-token exchange on GET /?token=...
    if (url.pathname === "/" && url.searchParams.get("token") === LAUNCH_TOKEN && !cookie) {
      validCookie = "v1.mockbody.sig-" + randomBytes(8).toString("hex")
      res.writeHead(303, {
        location: "/",
        "set-cookie": `${cookieName}=${validCookie}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
      })
      res.end()
      return
    }

    const authed = cookie !== undefined && cookie.split("=")[1].trim() === validCookie && !rejectHeld

    // index: serve only when the cookie validates
    if (url.pathname === "/") {
      if (authed) {
        res.writeHead(200, { "content-type": "text/html" })
        res.end("<html>index ok</html>")
      } else {
        res.writeHead(401, { "content-type": "text/plain" })
        res.end("dsh web authentication required\n")
      }
      return
    }

    // /api: requires the browser-auth cookie
    if (url.pathname.startsWith("/api/")) {
      if (authed) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true, path: url.pathname, q: Object.fromEntries(url.searchParams) }))
      } else {
        res.writeHead(401, { "content-type": "text/plain" })
        res.end("unauthorized\n")
      }
      return
    }

    res.writeHead(200, { "content-type": "text/plain" })
    res.end("asset " + url.pathname)
  })

  server.on("upgrade", (req, socket) => {
    const cookie = (req.headers.cookie || "").split(";").find((c) => c.trim().startsWith(cookieName + "="))
    const authed = cookie !== undefined && cookie.split("=")[1].trim() === validCookie && !rejectHeld
    if (!authed) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
    socket.pipe(socket)
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      port: server.address().port,
      server,
      get rejectHeld() {
        return rejectHeld
      },
      set rejectHeld(v) {
        rejectHeld = v
      },
    }))
  })
}

/** Minimal cordis ctx stub satisfying the plugin's apply(). */
function createCtx(settings, connection) {
  const handlers = []
  const state = { ...settings }
  return {
    settings: {
      register() {
        /* the harness drives start() directly; registration is a no-op here */
      },
      get(ns) {
        return { ...state }
      },
      update(ns, patch) {
        Object.assign(state, patch)
        return Promise.resolve()
      },
    },
    connection,
    on(event, fn) {
      if (event === "settings/updated") handlers.push(fn)
    },
    effect(fn) {
      this._dispose = fn
    },
    _handlers: handlers,
    _fireSettings(next) {
      for (const fn of handlers) fn("remote-access-proxy", next)
    },
    _disposeAll() {
      if (this._dispose) this._dispose()
    },
  }
}

function httpReq(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = ""
      res.on("data", (c) => (data += c))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

async function main() {
  const mock = await createMockDsh()
  console.log(`mock DSH upstream on 127.0.0.1:${mock.port}, launch token present`)

  const { apply } = await import(PLUGIN_URL)

  // Reserve an explicit free port so the proxy's bound port is deterministic.
  const proxyPort = await new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })

  const settings = {
    enabled: true,
    listenHost: "127.0.0.1",
    listenPort: proxyPort,
    secretPath: "t3stpath",
    cookieValue: "testgatecookie0001",
    upstreamHost: "127.0.0.1",
    upstreamPort: mock.port,
    tlsEnabled: false,
    tlsPfxPath: "",
    tlsPassphrase: "",
  }
  const connection = {
    authenticatedUrl(base) {
      return `${base}/?token=${LAUNCH_TOKEN}`
    },
  }
  const ctx2 = createCtx(settings, connection)
  apply(ctx2)
  console.log(`proxy listening on 127.0.0.1:${proxyPort}`)
  await sleep(150)

  const GATE = "dsh_et_gate=testgatecookie0001"

  // 1) ENTRY without any cookie -> 200 index + gate cookie set, DSH session warmed.
  let r = await httpReq(proxyPort, { path: "/t3stpath/" })
  check("entry /t3stpath/ -> 200 index", r.status === 200 && r.body.includes("index ok"), `got ${r.status} ${r.body}`)
  check("entry sets gate cookie", Array.isArray(r.headers["set-cookie"]) && r.headers["set-cookie"][0].startsWith("dsh_et_gate=testgatecookie0001"))
  check("entry serves DSH index via proxy-held cookie", r.status === 200)

  // 2) PASS /api with only the gate cookie -> 200, DSH cookie injected upstream.
  r = await httpReq(proxyPort, { path: "/api/session/me", headers: { cookie: GATE } })
  check("pass /api with gate cookie -> 200", r.status === 200 && r.body.includes('"ok":true'), `got ${r.status} ${r.body}`)

  // 3) no cookie at all -> 403 (gate denies before upstream).
  r = await httpReq(proxyPort, { path: "/api/session/me" })
  check("api without cookie -> 403", r.status === 403, `got ${r.status}`)

  // 4) entry with token in query -> token stripped upstream, still 200.
  r = await httpReq(proxyPort, { path: "/t3stpath/?token=" + LAUNCH_TOKEN, headers: { cookie: GATE } })
  check("entry with ?token= still 200", r.status === 200, `got ${r.status}`)
  r = await httpReq(proxyPort, { path: "/api/tokencode", headers: { cookie: GATE } })
  const q = JSON.parse(r.body)
  check("token query stripped upstream", !("token" in q.q), `q=${JSON.stringify(q.q)}`)

  // 5) Location rewrite on entry: upstream 303 Location '/' becomes the gate prefix.
  const mocked303 = await new Promise((resolve) => {
    const orig = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x")
      if (url.pathname === "/") {
        res.writeHead(303, { location: "/" })
        res.end()
        return
      }
      res.writeHead(200)
      res.end("ok")
    })
    orig.listen(0, "127.0.0.1", () => resolve({ port: orig.address().port, server: orig }))
  })
  settings.upstreamPort = mocked303.port
  ctx2._fireSettings({ ...settings })
  await sleep(150)
  r = await httpReq(proxyPort, { path: "/t3stpath/?token=" + LAUNCH_TOKEN })
  check("303 location rewritten to gate prefix", r.status === 303 && r.headers.location === "/t3stpath/", `status=${r.status} loc=${r.headers.location}`)
  settings.upstreamPort = mock.port
  ctx2._fireSettings({ ...settings })
  mocked303.server.close()
  await sleep(150)

  // 6) self-heal: mock rejects the held cookie -> 401, then next request re-exchanges -> 200.
  mock.rejectHeld = true
  r = await httpReq(proxyPort, { path: "/api/selfheal", headers: { cookie: GATE } })
  check("stale cookie -> upstream 401 surfaces", r.status === 401, `got ${r.status}`)
  await sleep(200) // background re-exchange
  mock.rejectHeld = false
  r = await httpReq(proxyPort, { path: "/api/selfheal", headers: { cookie: GATE } })
  check("self-heal: next request re-auths -> 200", r.status === 200, `got ${r.status} ${r.body}`)

  // 7) WS upgrade passes with the proxy-held cookie.
  const wsStatus = await new Promise((resolve) => {
    const req = http.request({ hostname: "127.0.0.1", port: proxyPort, path: "/wsx", headers: { connection: "Upgrade", upgrade: "websocket", cookie: GATE } })
    req.on("upgrade", (res, socket) => {
      socket.destroy()
      resolve(res.statusCode)
    })
    req.on("response", (res) => {
      resolve(res.statusCode)
    })
    req.on("error", () => resolve("error"))
    req.end()
  })
  check("ws upgrade passes with cookie", wsStatus === 101, `got ${wsStatus}`)

  // 8) settings/updated with enabled=false stops the listener.
  ctx2._fireSettings({ ...settings, enabled: false })
  await sleep(150)
  const afterDisable = await httpReq(proxyPort, { path: "/t3stpath/" }).catch((e) => ({ status: "conn-error" }))
  check("disabled setting stops listener", afterDisable.status === "conn-error", `got ${afterDisable.status}`)

  ctx2._disposeAll()
  mock.server.close()

  restoreLog()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  restoreLog()
  console.error("harness error:", err)
  process.exit(1)
})
