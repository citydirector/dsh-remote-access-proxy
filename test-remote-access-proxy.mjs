/**
 * Standalone end-to-end test for dsh-remote-access-proxy.
 *
 * Mocks the DSH upstream (launch-token exchange + dsh-auth cookie gate) and the
 * DSH 0.1.7 host contract around the plugin — a Cordis Config of volatile
 * references, `loader/volatile-update`, the profile configuration editor, the
 * page-policy call, and the connection service — then exercises the proxy
 * server itself.
 *
 * Run: node test-remote-access-proxy.mjs
 *
 * It loads the plugin beside this file — the copy a pnpm install of this bundle
 * deploys — so module resolution matches production when run from an installed
 * bundle, or after a local install. DSH_PLUGIN points at any other copy. The
 * plugin appends to its access.log; the harness snapshots that file (and clears
 * the rotated access.log.1…) and restores it on exit, so test activity leaves no
 * trace.
 */

import http from "node:http"
import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { networkInterfaces, tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import vm from "node:vm"

const PLUGIN_URL = process.env.DSH_PLUGIN
  ? pathToFileURL(process.env.DSH_PLUGIN).href
  : new URL("./plugin/dsh-remote-access-proxy.mjs", import.meta.url).href
const REAL_LOG = join(dirname(fileURLToPath(PLUGIN_URL)), "access.log")
/** Rotated files the plugin can create; the harness restores the whole ring. */
const LOG_RING = 5
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
  for (let i = 1; i <= LOG_RING; i += 1) {
    try {
      rmSync(`${REAL_LOG}.${i}`, { force: true })
    } catch {
      /* not there */
    }
  }
}
function logSize(suffix = "") {
  try {
    return statSync(REAL_LOG + suffix).size
  } catch {
    return -1
  }
}
const LAUNCH_TOKEN = "TEST_LAUNCH_TOKEN_0123456789abcdef0123456789abcdef"
// The update check must never reach the real GitHub from the harness: every
// instance checks a mock tag list (or never, until a test asks).
process.env.DSH_RAP_UPDATE_API = "http://127.0.0.1:9"
process.env.DSH_RAP_UPDATE_DELAY_MS = "600000"
delete process.env.DSH_RAP_UPDATE_SOURCE
/** Profile entry id the bundle mounts the host plugin as; also its settings namespace. */
const ROW_ID = "remote-access-proxy"
/** Bundle package name (the row page key is `<package>#<row id>`). */
const BUNDLE = "dsh-remote-access-proxy"

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
  let exchanges = 0 // launch-token exchanges served (proves who was forwarded to)
  const cookieName = "dsh-auth-mock"

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://dsh.invalid")
    const cookie = (req.headers.cookie || "").split(";").find((c) => c.trim().startsWith(cookieName + "="))

    // launch-token exchange on GET /?token=...
    if (url.pathname === "/" && url.searchParams.get("token") === LAUNCH_TOKEN && !cookie) {
      exchanges += 1
      validCookie = "v1.mockbody.sig-" + randomBytes(8).toString("hex")
      res.writeHead(303, {
        location: "./",
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
      get exchanges() {
        return exchanges
      },
    }))
  })
}

/**
 * The DSH 0.1.7 host contract around one plugin instance: a Config of volatile
 * `{ get() }` references, the configuration editor that persists edits into the
 * profile patch, the loader notification a volatile-only edit lands as, and the
 * optional settings service this plugin only asks for a page policy.
 *
 * `_commit(patch)` is the Loader half: it moves the references and re-fires
 * `loader/volatile-update`, exactly as `Entry._commitVolatile` does.
 *
 * `webServer` models the host's `webserver` row: `port` is the port the OS
 * actually bound (undefined until `listen` returns), and `active: false` mimics
 * a fiber that has not reached ACTIVE, where the strict `ctx.get` sees nothing.
 */
function createCtx(initial, connection, { webStartup, webServer, documentPath } = {}) {
  const state = { ...initial }
  const refs = {}
  for (const field of Object.keys(state)) refs[field] = { get: () => state[field] }
  const handlers = new Map()
  const writes = []
  const pagePolicies = []
  const injected = []
  const stats = { escapes: 0, nestedRejections: 0 }
  // Mirrors `dsh-hmr`: an AsyncLocalStorage marking the caller as inside a
  // hot-reload transaction, the `exit()` escape hatch the Loader itself uses
  // (`watchConfig`), and the guard that rejects re-entrant edits.
  let inTransaction = false
  const executing = {
    getStore: () => (inTransaction ? true : undefined),
    run(_value, fn) {
      const before = inTransaction
      inTransaction = true
      try {
        return fn()
      } finally {
        inTransaction = before
      }
    },
    exit(fn) {
      const before = inTransaction
      inTransaction = false
      stats.escapes += 1
      try {
        return fn()
      } finally {
        inTransaction = before
      }
    },
  }
  const hmr = { executing }
  const settingsStub = {
    configure(presentation, owner) {
      pagePolicies.push({ presentation, owner })
      return () => {}
    },
  }
  const ctx = {
    connection,
    fiber: { entry: { options: { id: ROW_ID, name: BUNDLE, config: undefined } } },
    root: { loader: { await: () => Promise.resolve() } },
    get(name, strict = true) {
      if (name === "configEditor") return editor
      if (name === "hmr") return hmr
      if (name === "webStartup") return webStartup
      if (name === "webServer") {
        if (webServer === undefined) return undefined
        return strict && webServer.active === false ? undefined : webServer
      }
      return undefined
    },
    inject(deps, callback) {
      injected.push([...deps])
      if (deps.includes("settings")) callback({ settings: settingsStub, effect: (fn) => { fn() } })
    },
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
    },
    // Cordis runs an effect at once and keeps the disposer it returns.
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === "function") disposers.push(dispose)
    },
    _refs: refs,
    _state: state,
    /** The live `webserver` row, poked by tests to model the OS binding a port late. */
    _webServer: webServer,
    _writes: writes,
    _pagePolicies: pagePolicies,
    _injected: injected,
    _stats: stats,
    /** Put the caller inside a hot-reload transaction (as the Loader mounts us). */
    _setTransaction(value) {
      inTransaction = value
    },
    /** Loader's volatile commit: move the references, then notify the owner. */
    _commit(patch) {
      Object.assign(state, patch)
      for (const fn of handlers.get("loader/volatile-update") ?? []) fn([["config"]])
    },
    _disposeAll() {
      while (disposers.length > 0) disposers.pop()()
    },
  }
  const disposers = []
  const editor = {
    documentPath,
    async edit(target, change) {
      if (executing.getStore()) {
        stats.nestedRejections += 1
        throw new Error("HMR transactions cannot be nested")
      }
      const next = change({ ...(target.options.config ?? {}) }, {})
      target.options.config = next
      writes.push(next)
    },
  }
  return ctx
}

function httpReq(port, { method = "GET", path = "/", headers = {}, body, hostname = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, method, path, headers }, (res) => {
      let data = ""
      res.on("data", (c) => (data += c))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

/** Read the package's own layout around the loaded plugin: bundle patch + metadata. */
function readPackage(root, pluginDir) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const patchRel = pkg.dsh?.bundle?.patch
  const patchPath = typeof patchRel === "string" ? join(root, patchRel) : undefined
  const patch = patchPath !== undefined && existsSync(patchPath) ? readFileSync(patchPath, "utf8") : ""
  const rows = [...patch.matchAll(/id:\s*(\S+)\s*\n\s*name:\s*(\S+)/g)].map((m) => ({ id: m[1], name: m[2] }))
  const clientRel = pkg.exports?.["./client"]
  const clientPath = typeof clientRel === "string" ? join(root, clientRel) : ""
  const clientSource = existsSync(clientPath) ? readFileSync(clientPath, "utf8") : ""
  return { pkg, root, patchPath, patch, rows, clientPath, clientSource }
}

/** A free loopback port, closed again so a listener can bind it deterministically. */
function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

async function main() {
  const mock = await createMockDsh()
  console.log(`mock DSH upstream on 127.0.0.1:${mock.port}, launch token present`)

  const plugin = await import(PLUGIN_URL)
  const pluginDir = dirname(fileURLToPath(PLUGIN_URL))
  const root = dirname(pluginDir)
  const layout = readPackage(root, pluginDir)

  // Reserve an explicit free port so the proxy's bound port is deterministic.
  const proxyPort = await freePort()

  // The 0.2 connection also carries the authenticated /api Fetch registry the
  // status route rides; keep every registration so the test can call it.
  const routes = new Map()
  const connection = {
    authenticatedUrl(base) {
      return `${base}/?token=${LAUNCH_TOKEN}`
    },
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return async () => {
          if (routes.get(route.path) === route) routes.delete(route.path)
        }
      },
    },
  }
  /** Read the status document the configuration page polls. */
  async function readStatus() {
    const route = routes.get(plugin.STATUS_ROUTE)
    if (route === undefined) return undefined
    const response = await route.fetch(new Request("http://127.0.0.1" + plugin.STATUS_ROUTE))
    return await response.json()
  }
  // secretPath / cookieValue empty on purpose: the plugin must generate both and
  // persist them into the profile configuration.
  const ctx2 = createCtx(
    {
      enabled: true,
      allowFrom: "",
      password: "",
      listenPort: proxyPort,
      secretPath: "",
      cookieValue: "",
      upstreamHost: "127.0.0.1",
      upstreamPort: mock.port,
      tlsEnabled: false,
      tlsPfxPath: "",
      tlsPassphrase: "",
      logMaxBytes: 1024 * 1024,
      logKeep: 3,
    },
    connection,
  )
  // The Loader mounts this plugin inside an HMR transaction, and every volatile
  // commit arrives the same way; `configEditor.edit` refuses to run re-entrantly
  // ("HMR transactions cannot be nested"), so the write-back has to leave that
  // context first. Stay inside a transaction for the whole run to prove it.
  ctx2._setTransaction(true)
  plugin.apply(ctx2, ctx2._refs)
  console.log(`proxy listening on 127.0.0.1:${proxyPort}`)
  await sleep(150)

  // The generated values must be exactly what the gate accepts, and exactly what
  // went into the profile configuration.
  const writeBack = ctx2._writes[0] ?? {}
  const generatedPath = ctx2._state.secretPath || writeBack.secretPath
  const generatedCookie = ctx2._state.cookieValue || writeBack.cookieValue
  check("generates a gate path and persists it to the profile", typeof writeBack.secretPath === "string" && writeBack.secretPath.length === 12, JSON.stringify(writeBack))
  check("generates a gate cookie value and persists it", typeof writeBack.cookieValue === "string" && writeBack.cookieValue.length === 24, JSON.stringify(writeBack))
  check(
    "escapes the hot-reload transaction before editing the profile",
    ctx2._stats.escapes >= 1 && ctx2._stats.nestedRejections === 0,
    JSON.stringify(ctx2._stats),
  )
  // Emulate Loader reconciling the profile patch: commit what was written.
  ctx2._commit(writeBack)
  await sleep(150)

  // 1) ENTRY without any cookie -> 200 index + gate cookie set, DSH session warmed.
  let r = await httpReq(proxyPort, { path: `/${generatedPath}/` })
  check("entry through the generated path -> 200 index", r.status === 200 && r.body.includes("index ok"), `got ${r.status} ${r.body}`)
  const minted = Array.isArray(r.headers["set-cookie"]) ? r.headers["set-cookie"][0] : ""
  check(
    "entry remembers the device with a signed 30-day cookie, not the raw secret",
    /^dsh_et_gate=[0-9a-z]+\.[A-Za-z0-9_-]{43};/.test(minted) && minted.includes("Max-Age=2592000") && minted.includes("HttpOnly") && !minted.includes(generatedCookie),
    minted,
  )
  const GATE = minted.split(";")[0]
  r = await httpReq(proxyPort, { path: "/api/session/me", headers: { cookie: `dsh_et_gate=${generatedCookie}` } })
  check("the raw server secret is not a valid cookie", r.status === 403, `got ${r.status}`)

  // 1b) the gate path without its trailing slash redirects into it, so the
  //     client's `<base href="./">` assets stay under the gate.
  r = await httpReq(proxyPort, { path: `/${generatedPath}` })
  check("gate path without a slash -> 308 to the slash form", r.status === 308 && r.headers.location === `/${generatedPath}/`, `status=${r.status} loc=${r.headers.location}`)

  // 1c) the status route the page reads: running, with the address to open.
  let status = await readStatus()
  check("status route is registered on the authenticated /api channel", status !== undefined && plugin.STATUS_ROUTE === "/api/remote-access-proxy/status")
  check(
    "status reports listening with the entry address",
    status?.state === "listening" && Array.isArray(status.urls) && status.urls.length > 0 && status.urls.every((url) => url.startsWith("http://") && url.endsWith(`:${proxyPort}/${generatedPath}/`)),
    JSON.stringify(status),
  )

  // 2) PASS /api with only the gate cookie -> 200, DSH cookie injected upstream.
  r = await httpReq(proxyPort, { path: "/api/session/me", headers: { cookie: GATE } })
  check("pass /api with gate cookie -> 200", r.status === 200 && r.body.includes('"ok":true'), `got ${r.status} ${r.body}`)

  // 3) no cookie at all -> 403 (gate denies before upstream).
  r = await httpReq(proxyPort, { path: "/api/session/me" })
  check("api without cookie -> 403", r.status === 403, `got ${r.status}`)

  // 4) entry with token in query -> token stripped upstream, still 200.
  r = await httpReq(proxyPort, { path: `/${generatedPath}/?token=` + LAUNCH_TOKEN, headers: { cookie: GATE } })
  check("entry with ?token= still 200", r.status === 200, `got ${r.status}`)
  r = await httpReq(proxyPort, { path: "/api/tokencode", headers: { cookie: GATE } })
  const q = JSON.parse(r.body)
  check("token query stripped upstream", !("token" in q.q), `q=${JSON.stringify(q.q)}`)

  // 5) Location rewrite on entry: an upstream 303 Location '/' becomes the gate prefix.
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
  ctx2._commit({ upstreamPort: mocked303.port })
  await sleep(150)
  r = await httpReq(proxyPort, { path: `/${generatedPath}/?token=` + LAUNCH_TOKEN })
  check("303 location rewritten to the gate prefix", r.status === 303 && r.headers.location === `/${generatedPath}/`, `status=${r.status} loc=${r.headers.location}`)
  ctx2._commit({ upstreamPort: mock.port })
  mocked303.server.close()
  await sleep(150)

  // 6) self-heal: mock rejects the held cookie -> 401, then the next request re-exchanges -> 200.
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
  check("ws upgrade passes with the gate cookie", wsStatus === 101, `got ${wsStatus}`)

  // 8) a volatile `enabled: false` commit stops the listener.
  ctx2._commit({ enabled: false })
  await sleep(150)
  const afterDisable = await httpReq(proxyPort, { path: `/${generatedPath}/` }).catch(() => ({ status: "conn-error" }))
  check("volatile enabled=false stops the listener", afterDisable.status === "conn-error", `got ${afterDisable.status}`)
  status = await readStatus()
  check("status reports disabled", status?.state === "disabled", JSON.stringify(status))

  // 8a) problems the page has to explain instead of failing silently.
  const badCtx = createCtx(
    { ...ctx2._state, enabled: true, listenPort: await freePort(), secretPath: "has/slash", cookieValue: "validcookie123" },
    connection,
  )
  routes.clear()
  plugin.apply(badCtx, badCtx._refs)
  await sleep(100)
  status = await readStatus()
  check("an invalid gate path is refused with a reason", status?.state === "error" && status.code === "bad-secret-path", JSON.stringify(status))
  badCtx._disposeAll()

  const busyCtx = createCtx(
    { ...ctx2._state, enabled: true, listenPort: mock.port, secretPath: "abcd1234", cookieValue: "validcookie123" },
    connection,
  )
  plugin.apply(busyCtx, busyCtx._refs)
  // A busy port is retried for about two seconds (a hot-swapped predecessor may
  // still be releasing it) before it is reported.
  for (let i = 0; i < 40; i += 1) {
    await sleep(100)
    status = await readStatus()
    if (status?.state === "error") break
  }
  check("a busy port is reported, not swallowed", status?.state === "error" && status.code === "port-in-use" && status.listenPort === mock.port, JSON.stringify(status))
  busyCtx._disposeAll()

  // 8a') migration from the pre-1.2 row: the user patch names the module by an
  //      absolute file URL (copied there by the configuration editor). It must be
  //      rewritten to the package name, and the saved gate values must survive —
  //      no fresh secrets minted while the loader brings them back.
  const migrationDir = mkdtempSync(join(tmpdir(), "rap-migrate-"))
  const userPatch = join(migrationDir, "cordis.patch.yml")
  writeFileSync(userPatch, [
    "- id: remote-access-proxy",
    "  name: file:///C:/old/place/node_modules/dsh-remote-access-proxy/plugin/dsh-remote-access-proxy.mjs",
    "  config:",
    "    secretPath: keepme123",
    "    cookieValue: keepcookie12345",
    "- id: something-else",
    "  name: ./plugin/dsh-remote-access-proxy.mjs",
    "",
  ].join("\n"))
  const migratePort = await freePort()
  const migrateCtx = createCtx(
    { ...ctx2._state, enabled: true, listenPort: migratePort, secretPath: "", cookieValue: "" },
    connection,
    { documentPath: userPatch },
  )
  plugin.apply(migrateCtx, migrateCtx._refs)
  await sleep(150)
  const migrated = readFileSync(userPatch, "utf8")
  check("migration rewrites the stale absolute module name", migrated.includes("  name: dsh-remote-access-proxy\n  config:") && !migrated.includes("file:///C:/old"), migrated)
  check("migration leaves other rows alone", migrated.includes("- id: something-else\n  name: ./plugin/dsh-remote-access-proxy.mjs"), migrated)
  check("no replacement secrets are minted while the saved ones load", migrateCtx._writes.length === 0, JSON.stringify(migrateCtx._writes))
  migrateCtx._commit({ secretPath: "keepme123", cookieValue: "keepcookie12345" })
  await sleep(150)
  r = await httpReq(migratePort, { path: "/keepme123/" })
  check("the saved gate path still works after migration", r.status === 200 && migrateCtx._writes.length === 0, `got ${r.status}`)
  migrateCtx._disposeAll()
  rmSync(migrationDir, { recursive: true, force: true })

  // 8b) upstream auto-detect: an empty host / port 0 follow the running
  //     instance's published `webStartup` address instead of the historical 3080
  //     default — this is what makes `dsh web` work without any configuration.
  const autoMock = await createMockDsh()
  const autoPort = await freePort()
  const ctx3 = createCtx(
    {
      enabled: true,
      allowFrom: "",
      password: "",
      listenPort: autoPort,
      secretPath: "",
      cookieValue: "",
      upstreamHost: "",
      upstreamPort: 0,
      tlsEnabled: false,
      tlsPfxPath: "",
      tlsPassphrase: "",
      logMaxBytes: 1024 * 1024,
      logKeep: 3,
    },
    connection,
    { webStartup: { host: "127.0.0.1", port: autoMock.port } },
  )
  plugin.apply(ctx3, ctx3._refs)
  await sleep(150)
  check("auto-detects the upstream from webStartup", autoMock.exchanges > 0, `exchanges=${autoMock.exchanges}`)
  const autoPath = ctx3._writes[0]?.secretPath
  const autoGate = `dsh_et_gate=${ctx3._writes[0]?.cookieValue}`
  r = await httpReq(autoPort, { path: `/${autoPath}/`, headers: { cookie: autoGate } })
  check("the auto-detected proxy serves the entry", r.status === 200 && r.body.includes("index ok"), `got ${r.status} ${r.body}`)
  let autoLogged = true
  try {
    autoLogged = readFileSync(REAL_LOG, "utf8").includes(`upstream 127.0.0.1:${autoMock.port} (auto)`)
  } catch {
    autoLogged = false
  }
  check("logs the auto-detected upstream", autoLogged)

  // An explicit address always wins over the live webStartup one.
  const explicitPort = await freePort()
  const mockBefore = mock.exchanges
  const autoBefore = autoMock.exchanges
  const ctx4 = createCtx(
    {
      enabled: true,
      allowFrom: "",
      password: "",
      listenPort: explicitPort,
      secretPath: "",
      cookieValue: "",
      upstreamHost: "127.0.0.1",
      upstreamPort: mock.port,
      tlsEnabled: false,
      tlsPfxPath: "",
      tlsPassphrase: "",
      logMaxBytes: 1024 * 1024,
      logKeep: 3,
    },
    connection,
    { webStartup: { host: "127.0.0.1", port: autoMock.port } },
  )
  plugin.apply(ctx4, ctx4._refs)
  await sleep(150)
  check(
    "an explicit upstream wins over webStartup",
    mock.exchanges > mockBefore && autoMock.exchanges === autoBefore,
    `mock=${mock.exchanges} auto=${autoMock.exchanges}`,
  )
  ctx3._disposeAll()
  ctx4._disposeAll()
  autoMock.server.close()
  await sleep(50)

  // 8c) `--port 0` hosts (the desktop launcher) publish `webStartup.port === 0`:
  //     the requested "let the OS pick one", not a connectable port. The bound
  //     port lives on `webServer` instead, and a proxy that ignored it forwarded
  //     to the 3080 fallback and answered 502 bad gateway on every request.
  const zeroMock = await createMockDsh()
  const zeroPort = await freePort()
  const ctx5 = createCtx(
    {
      enabled: true,
      allowFrom: "",
      password: "",
      listenPort: zeroPort,
      secretPath: "",
      cookieValue: "",
      upstreamHost: "",
      upstreamPort: 0,
      tlsEnabled: false,
      tlsPfxPath: "",
      tlsPassphrase: "",
      logMaxBytes: 1024 * 1024,
      logKeep: 3,
    },
    connection,
    {
      webStartup: { host: "127.0.0.1", port: 0 },
      webServer: { host: "127.0.0.1", port: zeroMock.port },
    },
  )
  plugin.apply(ctx5, ctx5._refs)
  await sleep(150)
  check("port 0 upstream reads the bound port from webServer", zeroMock.exchanges > 0, `exchanges=${zeroMock.exchanges}`)
  const zeroPath = ctx5._writes[0]?.secretPath
  const zeroGate = `dsh_et_gate=${ctx5._writes[0]?.cookieValue}`
  r = await httpReq(zeroPort, { path: `/${zeroPath}/`, headers: { cookie: zeroGate } })
  check(
    "a --port 0 host is reachable through the gate instead of 502",
    r.status === 200 && r.body.includes("index ok"),
    `got ${r.status} ${String(r.body).slice(0, 60)}`,
  )
  let zeroLogged = true
  try {
    zeroLogged = readFileSync(REAL_LOG, "utf8").includes(`upstream 127.0.0.1:${zeroMock.port} (auto)`)
  } catch {
    zeroLogged = false
  }
  check("logs the webServer-bound upstream", zeroLogged)

  // The window between plugin start and the OS binding a port: the service exists
  // but has no port yet, so the start-time resolution still lands on the 3080
  // fallback. The address is re-resolved per request, so the proxy recovers on its
  // own — no timer, no restart, and no 502 once the port appears.
  const latePort = await freePort()
  const lateCtx = createCtx(
    {
      enabled: true,
      allowFrom: "",
      password: "",
      listenPort: latePort,
      secretPath: "lateretry1234",
      cookieValue: "latesecret12345",
      upstreamHost: "",
      upstreamPort: 0,
      tlsEnabled: false,
      tlsPfxPath: "",
      tlsPassphrase: "",
      logMaxBytes: 1024 * 1024,
      logKeep: 3,
    },
    connection,
    { webStartup: { host: "127.0.0.1", port: 0 }, webServer: { host: "127.0.0.1", active: false } },
  )
  plugin.apply(lateCtx, lateCtx._refs)
  await sleep(100)
  const lateGate = "dsh_et_gate=latesecret12345"
  r = await httpReq(latePort, { path: "/lateretry1234/", headers: { cookie: lateGate } })
  check(
    "an unbound upstream does not serve the entry while the port is unknown",
    !(r.status === 200 && String(r.body).includes("index ok")),
    `got ${r.status}`,
  )
  const earlyMock = await createMockDsh()
  lateCtx._webServer.port = earlyMock.port
  lateCtx._webServer.active = true
  r = await httpReq(latePort, { path: "/lateretry1234/", headers: { cookie: lateGate } })
  check(
    "re-resolves the upstream once the OS-assigned port shows up",
    r.status === 200 && r.body.includes("index ok") && earlyMock.exchanges > 0,
    `got ${r.status} exchanges=${earlyMock.exchanges}`,
  )
  lateCtx._disposeAll()
  earlyMock.server.close()
  ctx5._disposeAll()
  zeroMock.server.close()
  await sleep(50)

  // 9) access.log rotation: a tiny cap must rotate into access.log.1 and keep the
  //    live file under the cap. Each gate miss logs one DENY line.
  ctx2._commit({ enabled: true, logMaxBytes: 300, logKeep: 2 })
  await sleep(150)
  for (let i = 0; i < 12; i += 1) await httpReq(proxyPort, { path: "/logfill" })
  const liveSize = logSize()
  check("rotation keeps the live log under the cap", liveSize > 0 && liveSize <= 300, `size=${liveSize}`)
  check("rotation archived the previous log", logSize(".1") > 0, `size=${logSize(".1")}`)
  check("rotation honours logKeep (no .3 with keep=2)", !existsSync(`${REAL_LOG}.3`))

  // 10) logMaxBytes=0 is the off switch: the log grows again, nothing rotates.
  rmSync(`${REAL_LOG}.1`, { force: true })
  ctx2._commit({ enabled: true, logMaxBytes: 0, logKeep: 2 })
  await sleep(150)
  for (let i = 0; i < 12; i += 1) await httpReq(proxyPort, { path: "/logfill" })
  check("logMaxBytes=0 disables rotation", logSize() > 300 && !existsSync(`${REAL_LOG}.1`), `size=${logSize()}`)

  ctx2._disposeAll()
  mock.server.close()
  const pwMock = await createMockDsh()

  // ---- the 0.1.7 host contract ------------------------------------------------

  check("inject requires connection and no settings service", Array.isArray(plugin.inject) && plugin.inject.length === 1 && plugin.inject[0] === "connection", JSON.stringify(plugin.inject))

  const policies = ctx2._pagePolicies
  check(
    "registers its own page policy (settings.configure({auto:false}))",
    policies.length === 1 && policies[0].presentation?.auto === false && policies[0].owner === ctx2.fiber,
    JSON.stringify(policies.map((p) => p.presentation)),
  )

  const dict = plugin.Config?.dict
  const fields = Object.keys(dict ?? {})
  const ordinary = fields.filter((field) => dict[field]?.meta?.volatile !== true)
  check("Config declares a schema", fields.length > 0, `fields=${fields.length}`)
  check("every Config field is volatile (edits never remount)", fields.length > 0 && ordinary.length === 0, `non-volatile: ${ordinary.join(", ")}`)

  // The real schemastery must hand back live references, and the serialized
  // schema must survive the form projection the settings service performs.
  const defaults = plugin.Config({})
  check(
    "Config parses into live references carrying their schema defaults",
    typeof defaults.allowFrom?.get === "function" && defaults.allowFrom.get() === "" && defaults.password.get() === "" && defaults.listenHost === undefined
      && typeof defaults.enabled?.get === "function" && defaults.enabled.get() === true
      && defaults.logMaxBytes.get() === 1048576
      && defaults.upstreamHost.get() === "" && defaults.upstreamPort.get() === 0,
    JSON.stringify({ allowFrom: defaults.allowFrom?.get?.(), logMaxBytes: defaults.logMaxBytes?.get?.(), upstreamPort: defaults.upstreamPort?.get?.() }),
  )
  let serializes = true
  try {
    if (typeof plugin.Config.toJSON !== "function") serializes = false
    else plugin.Config.toJSON()
  } catch (_error) {
    serializes = false
  }
  check("Config serializes for the settings form projection", serializes)

  // ---- 1.3: access password, allow list -------------------------------------
  const pwPort = await freePort()
  const pwCtx = createCtx(
    { ...ctx2._state, enabled: true, listenPort: pwPort, secretPath: "pwgate1234", cookieValue: "pwsecret12345", password: "open sesame", upstreamHost: "127.0.0.1", upstreamPort: pwMock.port },
    connection,
  )
  plugin.apply(pwCtx, pwCtx._refs)
  await sleep(150)
  const html = { accept: "text/html", "accept-language": "zh-CN,zh;q=0.9" }
  r = await httpReq(pwPort, { path: "/pwgate1234/", headers: html })
  check("with a password the entry shows the login page", r.status === 200 && r.body.includes('type="password"') && r.body.includes("输入访问密码") && !r.body.includes("index ok"), `got ${r.status}`)
  check("the login page sets no cookie", r.headers["set-cookie"] === undefined)
  r = await httpReq(pwPort, { path: "/pwgate1234/api/session/me" })
  check("an API call before login is 401", r.status === 401, `got ${r.status}`)
  r = await httpReq(pwPort, { path: "/pwgate1234/session/abc", headers: html })
  check("a deep link keeps where it was going", r.body.includes('name="next" value="/pwgate1234/session/abc"'))
  const form = (pw, next = "/pwgate1234/session/abc") => new URLSearchParams({ username: "dsh", password: pw, next }).toString()
  const post = (body, address) => httpReq(pwPort, { method: "POST", path: "/pwgate1234/__rap/login", headers: { "content-type": "application/x-www-form-urlencoded", ...html }, body })
  r = await post(form("wrong"))
  check("a wrong password is refused on the login page", r.status === 401 && r.body.includes("密码不对") && r.headers["set-cookie"] === undefined, `got ${r.status}`)
  r = await post(form("open sesame"))
  const pwCookie = Array.isArray(r.headers["set-cookie"]) ? r.headers["set-cookie"][0].split(";")[0] : ""
  check("the right password signs in and returns to the deep link", r.status === 303 && r.headers.location === "/pwgate1234/session/abc" && pwCookie.startsWith("dsh_et_gate="), `got ${r.status} ${r.headers.location}`)
  r = await post(form("open sesame", "https://evil.example/"))
  check("login never redirects off the gate path", r.headers.location === "/pwgate1234/", `loc=${r.headers.location}`)
  r = await httpReq(pwPort, { path: "/pwgate1234/", headers: { ...html, cookie: pwCookie } })
  check("a signed-in device opens DSH", r.status === 200 && r.body.includes("index ok"), `got ${r.status}`)
  r = await httpReq(pwPort, { path: "/api/session/me", headers: { cookie: pwCookie } })
  check("a signed-in device passes outside the path too", r.status === 200, `got ${r.status}`)
  const pwWs = await new Promise((resolve) => {
    const req = http.request({ hostname: "127.0.0.1", port: pwPort, path: "/pwgate1234/ws", headers: { connection: "Upgrade", upgrade: "websocket" } })
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode) })
    req.on("response", (res) => resolve(res.statusCode))
    req.on("error", () => resolve("error"))
    req.end()
  })
  check("a websocket without login is refused even on the gate path", pwWs === 403, `got ${pwWs}`)
  r = await httpReq(pwPort, { path: "/pwgate1234/__rap/logout", headers: { cookie: pwCookie } })
  check("logout clears the cookie", r.status === 303 && String(r.headers["set-cookie"]).includes("Max-Age=0"), `got ${r.status}`)
  pwCtx._commit({ password: "new password" })
  await sleep(150)
  r = await httpReq(pwPort, { path: "/api/session/me", headers: { cookie: pwCookie } })
  check("changing the password signs every device out", r.status === 403, `got ${r.status}`)
  for (let i = 0; i < 5; i += 1) await post(form("guess" + i))
  r = await post(form("new password"))
  check("too many wrong passwords lock the address for a while", r.status === 429 && r.body.includes("尝试次数太多"), `got ${r.status}`)
  status = await readStatus()
  check("status says a password is set", status?.password === true, JSON.stringify(status))

  // Allow list: loopback always passes; an outside address is dropped.
  const external = Object.values(networkInterfaces()).flat().find((item) => item && (item.family === "IPv4" || item.family === 4) && !item.internal)?.address
  pwCtx._commit({ password: "", allowFrom: "203.0.113.0/24" })
  await sleep(150)
  r = await httpReq(pwPort, { path: "/pwgate1234/" })
  check("loopback is always allowed", r.status === 200, `got ${r.status}`)
  if (external !== undefined) {
    r = await httpReq(pwPort, { path: "/pwgate1234/", hostname: external }).catch((error) => ({ status: error.code }))
    check("an address outside the allow list is dropped", r.status === "ECONNRESET" || r.status === "EPIPE", `got ${r.status} from ${external}`)
    status = await readStatus()
    check("the page learns which address was turned away", status?.lastDenied?.address === external, JSON.stringify(status?.lastDenied))
    pwCtx._commit({ allowFrom: `203.0.113.0/24, ${external}` })
    await sleep(150)
    r = await httpReq(pwPort, { path: "/pwgate1234/", hostname: external })
    check("adding the address lets it in (and the listener covers every interface)", r.status === 200, `got ${r.status}`)
  }
  pwCtx._commit({ allowFrom: "192.168.1.0/24, not-an-ip" })
  await sleep(100)
  status = await readStatus()
  check("a bad allow-list entry is refused with a reason", status?.state === "error" && status.code === "bad-allow" && status.detail === "not-an-ip", JSON.stringify(status))
  const parsed = plugin.parseAllowList("10.0.0.0/8 192.168.1.10-192.168.1.20; fd00::/8,1.2.3.4")
  check(
    "allow list understands IPs, CIDR blocks, ranges and IPv4-mapped clients",
    parsed.bad.length === 0
      && plugin.addressAllowed(parsed.list, "::ffff:10.9.8.7")
      && plugin.addressAllowed(parsed.list, "192.168.1.15")
      && !plugin.addressAllowed(parsed.list, "192.168.1.21")
      && plugin.addressAllowed(parsed.list, "fd12::3")
      && !plugin.addressAllowed(parsed.list, "8.8.8.8")
      && plugin.addressAllowed(plugin.parseAllowList("").list, "8.8.8.8"),
  )
  pwCtx._disposeAll()
  pwMock.server.close()

  check("generated values are written exactly once", ctx2._writes.length === 1, `writes=${ctx2._writes.length}`)

  const hostRow = layout.rows.find((row) => row.id === ROW_ID)
  check("bundle patch declares the host row as the settings namespace", hostRow !== undefined && layout.rows.length === 1, JSON.stringify(layout.rows))
  check("the row names the package, never a path (portable installs)", hostRow?.name === BUNDLE, JSON.stringify(layout.rows))
  check(
    "the package root is the host plugin and the client page",
    layout.pkg.name === BUNDLE
      && typeof layout.pkg.exports?.["."] === "string" && join(root, layout.pkg.exports["."]) === fileURLToPath(PLUGIN_URL)
      && existsSync(layout.clientPath)
      && layout.pkg.dsh?.client?.platform === "web",
    JSON.stringify(layout.pkg.exports),
  )
  const tokens = new Set(Array.from({ length: 50 }, () => plugin.genToken(12)))
  check("generated secrets are random lowercase alphanumerics", tokens.size === 50 && [...tokens].every((token) => /^[a-z0-9]{12}$/.test(token)))
  check("package metadata is packaged (icon + locale dictionaries)", [
    layout.pkg.icon,
    "locale/en.json",
    "locale/zh.json",
  ].every((rel) => typeof rel === "string" && rel !== "" && existsSync(join(root, rel))), JSON.stringify({ icon: layout.pkg.icon }))

  const clientSource = layout.clientSource
  let clientParses = clientSource !== ""
  try {
    new vm.Script(clientSource)
  } catch (error) {
    clientParses = false
    console.log(`    client parse error: ${error.message}`)
  }
  check("the browser half is a valid bundle script", clientParses)
  check(
    "the browser half registers the row page on the 0.1.7 slots",
    clientSource.includes('"plugins.row.config"')
      && clientSource.includes('BUNDLE + "#" + NS')
      && clientSource.includes(`"${BUNDLE}"`)
      && clientSource.includes(`"${ROW_ID}"`)
      && clientSource.includes("configForms")
      && clientSource.includes("whileServed"),
  )
  check(
    "the browser half renders booleans as switches and reads the status route",
    clientSource.includes('entry.kind === "boolean"')
      && !clientSource.includes("entry.spec.kind")
      && clientSource.includes('"' + plugin.STATUS_ROUTE.slice(1) + '"'),
  )
  // ---- 1.4: update check, one-click update, clean hot swap ------------------
  check(
    "release tags: only vX.Y.Z counts, highest by semantic version",
    plugin.latestRelease(["v1.3.0", "v1.10.0", "v1.9.9", "v2.0.0-rc.1", "1.11.0", "latest", "v1.4", "v01.2.3", "v3.0.0+build"]) === "v1.10.0"
      && plugin.latestRelease(["nightly", "v2.0.0-beta.1"]) === undefined
      && plugin.latestRelease([]) === undefined,
  )
  check(
    "version comparison is numeric, not textual",
    plugin.compareVersions("1.10.0", "v1.9.0") > 0 && plugin.compareVersions("v1.4.0", "1.4.0") === 0
      && plugin.compareVersions("1.3.9", "1.4.0") < 0 && plugin.compareVersions("2.0.0", "1.99.99") > 0
      && plugin.compareVersions("garbage", "0.0.1") < 0,
  )
  check(
    "the verdict offers only a newer release",
    plugin.updateVerdict(["v1.3.0", "v1.4.1"], "1.4.0").state === "available"
      && plugin.updateVerdict(["v1.3.0", "v1.4.1"], "1.4.0").latest === "v1.4.1"
      && plugin.updateVerdict(["v1.3.0", "v1.4.0"], "1.4.0").state === "current"
      && plugin.updateVerdict(["v1.5.0-rc.1"], "1.4.0").state === "current"
      && plugin.updateVerdict([], "1.4.0").state === "current",
  )
  const ghSource = plugin.updateSource({})
  const ownSource = plugin.updateSource({ DSH_RAP_UPDATE_SOURCE: "someone/fork" })
  const gitSource = plugin.updateSource({ DSH_RAP_UPDATE_SOURCE: "git+file:///tmp/rap.git" })
  check(
    "releases install as tag-pinned specs from the GitHub repository (overridable)",
    ghSource.kind === "github" && ghSource.repository === "citydirector/dsh-remote-access-proxy"
      && plugin.releaseSpec(ghSource, "v1.4.1") === "github:citydirector/dsh-remote-access-proxy#v1.4.1"
      && plugin.releaseSpec(ownSource, "v2.0.0") === "github:someone/fork#v2.0.0"
      && gitSource.kind === "git" && gitSource.url === "file:///tmp/rap.git"
      && plugin.releaseSpec(gitSource, "v1.4.1") === "git+file:///tmp/rap.git#v1.4.1"
      && plugin.updateSource({ DSH_RAP_UPDATE_SOURCE: "not a source" }).repository === "citydirector/dsh-remote-access-proxy",
  )
  check("Config has an updateCheck switch, on by default", defaults.updateCheck?.get?.() === true && dict.updateCheck?.meta?.volatile === true)

  // A mock GitHub tags API: the answer is switchable per test.
  let ghAnswer = { status: 200, body: [{ name: "v0.9.0" }, { name: "v99.1.0" }, { name: "v99.2.0-rc.1" }, { name: "nightly" }] }
  const ghRequests = []
  const gh = http.createServer((req, res) => {
    ghRequests.push({ url: req.url, ua: req.headers["user-agent"], accept: req.headers.accept })
    res.writeHead(ghAnswer.status, { "content-type": "application/json" })
    res.end(JSON.stringify(ghAnswer.body))
  })
  await new Promise((resolve) => gh.listen(0, "127.0.0.1", resolve))
  process.env.DSH_RAP_UPDATE_API = `http://127.0.0.1:${gh.address().port}`
  process.env.DSH_RAP_UPDATE_DELAY_MS = "30"
  const upMock = await createMockDsh()
  const upRoutes = new Map()
  const upConnection = {
    authenticatedUrl: connection.authenticatedUrl,
    fetch: { register(route) { upRoutes.set(route.path, route); return () => upRoutes.delete(route.path) } },
  }
  const upStatus = async (method = "GET") => {
    const route = upRoutes.get(method === "GET" ? plugin.STATUS_ROUTE : plugin.UPDATE_CHECK_ROUTE)
    if (route === undefined) return undefined
    return await (await route.fetch(new Request("http://127.0.0.1/x", { method }))).json()
  }
  const upPort = await freePort()
  const upState = { ...ctx2._state, enabled: true, listenPort: upPort, secretPath: "upgate1234", cookieValue: "upsecret12345", password: "", allowFrom: "", upstreamHost: "127.0.0.1", upstreamPort: upMock.port, updateCheck: true }
  let upCtx = createCtx(upState, upConnection)
  plugin.apply(upCtx, upCtx._refs)
  let up = await upStatus()
  check("status carries the running version and a pending check", up?.version === layout.pkg.version && up?.update?.state === "pending", JSON.stringify(up?.update))
  await sleep(300)
  up = await upStatus()
  check(
    "a newer release is reported with its tag-pinned spec",
    up?.update?.state === "available" && up.update.latest === "v99.1.0"
      && up.update.spec === "github:citydirector/dsh-remote-access-proxy#v99.1.0"
      && up.update.currentSpec === `github:citydirector/dsh-remote-access-proxy#v${layout.pkg.version}`
      && typeof up.update.checkedAt === "string",
    JSON.stringify(up?.update),
  )
  check(
    "the check reads the repository's tag list once, as a named client",
    ghRequests.length === 1 && ghRequests[0].url === "/repos/citydirector/dsh-remote-access-proxy/tags?per_page=100" && ghRequests[0].ua === "dsh-remote-access-proxy",
    JSON.stringify(ghRequests),
  )
  ghAnswer = { status: 403, body: { message: "API rate limit exceeded" } }
  up = await upStatus("POST")
  check(
    "a failed check is reported (with time and reason) and keeps the known release",
    up?.update?.state === "failed" && /rate limit/i.test(up.update.error) && typeof up.update.checkedAt === "string"
      && up.update.latest === "v99.1.0" && up.update.stale === "available",
    JSON.stringify(up?.update),
  )
  ghAnswer = { status: 200, body: [{ name: `v${layout.pkg.version}` }, { name: "v0.1.0" }] }
  up = await upStatus("POST")
  check("\"check now\" answers with the fresh verdict: up to date", up?.update?.state === "current" && ghRequests.length === 3, JSON.stringify(up?.update))
  // Offline: nothing listens on the API port.
  const deadPort = await freePort()
  process.env.DSH_RAP_UPDATE_API = `http://127.0.0.1:${deadPort}`
  up = await upStatus("POST")
  check("offline fails quietly with a reason", up?.update?.state === "failed" && typeof up.update.error === "string" && up.state === "listening", JSON.stringify(up?.update))
  process.env.DSH_RAP_UPDATE_API = `http://127.0.0.1:${gh.address().port}`
  upCtx._commit({ updateCheck: false })
  await sleep(100)
  const before = ghRequests.length
  up = await upStatus("POST")
  check("updateCheck=false turns checking off", up?.update?.state === "off" && up.updateCheck === false && ghRequests.length === before, JSON.stringify(up?.update))
  upCtx._commit({ updateCheck: true })
  await sleep(300)
  up = await upStatus()
  check("turning it back on checks again", up?.update?.state === "current", JSON.stringify(up?.update))

  // A hot swap disposes this instance and starts the new version on the same
  // port at once: dispose must end the listener and every connection.
  const keepAlive = new http.Agent({ keepAlive: true })
  const kaRes = await new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port: upPort, path: "/upgate1234/", agent: keepAlive }, (res) => {
      res.resume()
      res.on("end", () => resolve(res))
    }).on("error", reject)
  })
  const kaSocket = Object.values(keepAlive.freeSockets).flat()[0]
  const wsSocket = await new Promise((resolve) => {
    const req = http.request({ hostname: "127.0.0.1", port: upPort, path: "/upgate1234/ws", headers: { connection: "Upgrade", upgrade: "websocket" } })
    req.on("upgrade", (_res, socket) => resolve(socket))
    req.on("response", () => resolve(undefined))
    req.on("error", () => resolve(undefined))
    req.end()
  })
  const closed = (socket) => new Promise((resolve) => {
    if (socket === undefined) return resolve(false)
    if (socket.destroyed) return resolve(true)
    socket.once("close", () => resolve(true))
    setTimeout(() => resolve(socket.destroyed), 1000)
  })
  const kaClosed = closed(kaSocket)
  const wsClosed = closed(wsSocket)
  upCtx._disposeAll()
  check("dispose ends keep-alive connections at once", kaRes.statusCode === 200 && (await kaClosed) === true)
  check("dispose ends bridged websockets at once", (await wsClosed) === true)
  // The replacement binds the same port immediately.
  upCtx = createCtx(upState, upConnection)
  plugin.apply(upCtx, upCtx._refs)
  await sleep(150)
  up = await upStatus()
  const swapped = await httpReq(upPort, { path: "/upgate1234/" }).catch((error) => ({ status: error.code }))
  check("the replacing instance listens on the same port right away, same gate", up?.state === "listening" && swapped.status === 200, `${up?.state} ${swapped.status}`)
  upCtx._disposeAll()
  keepAlive.destroy()
  upMock.server.close()
  gh.close()
  process.env.DSH_RAP_UPDATE_DELAY_MS = "600000"

  check(
    "the browser half installs through DSH's plugin manager, only on this machine",
    clientSource.includes("remote.pluginManager")
      && clientSource.includes("installBundle(spec")
      && clientSource.includes("waitForInstall")
      && clientSource.includes("isLoopback")
      && clientSource.includes('"' + plugin.UPDATE_CHECK_ROUTE.slice(1) + '"')
      && ["no-hmr", "package-moved", "host-module", "unmanaged-plugin", "module-comparison"].every((reason) => clientSource.split(`"${reason}"`).length === 3),
  )
  check(
    "every Config field is editable in the browser half",
    fields.every((field) => clientSource.includes(`"${field}"`)),
    `missing: ${fields.filter((field) => !clientSource.includes(`"${field}"`)).join(", ")}`,
  )

  restoreLog()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  restoreLog()
  console.error("harness error:", err)
  process.exit(1)
})
