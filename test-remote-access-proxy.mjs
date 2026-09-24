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
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
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
  const cookieName = "dsh-auth-mock"

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://dsh.invalid")
    const cookie = (req.headers.cookie || "").split(";").find((c) => c.trim().startsWith(cookieName + "="))

    // launch-token exchange on GET /?token=...
    if (url.pathname === "/" && url.searchParams.get("token") === LAUNCH_TOKEN && !cookie) {
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
 */
function createCtx(initial, connection) {
  const state = { ...initial }
  const refs = {}
  for (const field of Object.keys(state)) refs[field] = { get: () => state[field] }
  const handlers = new Map()
  const writes = []
  const pagePolicies = []
  const injected = []
  const settingsStub = {
    configure(presentation, owner) {
      pagePolicies.push({ presentation, owner })
      return () => {}
    },
  }
  const ctx = {
    connection,
    fiber: { entry: { options: { id: ROW_ID, name: "./plugin/dsh-remote-access-proxy.mjs", config: undefined } } },
    root: { loader: { await: () => Promise.resolve() } },
    get(name) {
      return name === "configEditor" ? editor : undefined
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
    effect(fn) {
      ctx._dispose = fn
    },
    _refs: refs,
    _state: state,
    _writes: writes,
    _pagePolicies: pagePolicies,
    _injected: injected,
    /** Loader's volatile commit: move the references, then notify the owner. */
    _commit(patch) {
      Object.assign(state, patch)
      for (const fn of handlers.get("loader/volatile-update") ?? []) fn([["config"]])
    },
    _disposeAll() {
      if (ctx._dispose) ctx._dispose()
    },
  }
  const editor = {
    async edit(target, change) {
      const next = change({ ...(target.options.config ?? {}) }, {})
      target.options.config = next
      writes.push(next)
    },
  }
  return ctx
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

/** Read the package's own layout around the loaded plugin: bundle patch + metadata. */
function readPackage(root, pluginDir) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const patchRel = pkg.dsh?.bundle?.patch
  const patchPath = typeof patchRel === "string" ? join(root, patchRel) : undefined
  const patch = patchPath !== undefined && existsSync(patchPath) ? readFileSync(patchPath, "utf8") : ""
  const rows = [...patch.matchAll(/id:\s*(\S+)\s*\n\s*name:\s*(\S+)/g)].map((m) => ({ id: m[1], name: m[2] }))
  const clientRel = JSON.parse(readFileSync(join(pluginDir, "..", "ui", "package.json"), "utf8")).exports["./client"]
  const clientPath = join(root, "ui", clientRel)
  const clientSource = existsSync(clientPath) ? readFileSync(clientPath, "utf8") : ""
  return { pkg, root, patchPath, patch, rows, clientPath, clientSource }
}

async function main() {
  const mock = await createMockDsh()
  console.log(`mock DSH upstream on 127.0.0.1:${mock.port}, launch token present`)

  const plugin = await import(PLUGIN_URL)
  const pluginDir = dirname(fileURLToPath(PLUGIN_URL))
  const root = dirname(pluginDir)
  const layout = readPackage(root, pluginDir)

  // Reserve an explicit free port so the proxy's bound port is deterministic.
  const proxyPort = await new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })

  const connection = {
    authenticatedUrl(base) {
      return `${base}/?token=${LAUNCH_TOKEN}`
    },
  }
  // secretPath / cookieValue empty on purpose: the plugin must generate both and
  // persist them into the profile configuration.
  const ctx2 = createCtx(
    {
      enabled: true,
      listenHost: "127.0.0.1",
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
  // Emulate Loader reconciling the profile patch: commit what was written.
  ctx2._commit(writeBack)
  await sleep(150)

  const GATE = `dsh_et_gate=${generatedCookie}`

  // 1) ENTRY without any cookie -> 200 index + gate cookie set, DSH session warmed.
  let r = await httpReq(proxyPort, { path: `/${generatedPath}/` })
  check("entry through the generated path -> 200 index", r.status === 200 && r.body.includes("index ok"), `got ${r.status} ${r.body}`)
  check("entry sets the gate cookie", Array.isArray(r.headers["set-cookie"]) && r.headers["set-cookie"][0].startsWith(`dsh_et_gate=${generatedCookie}`))
  check("entry serves the DSH index via the proxy-held cookie", r.status === 200)

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
    typeof defaults.listenHost?.get === "function" && defaults.listenHost.get() === "0.0.0.0"
      && typeof defaults.enabled?.get === "function" && defaults.enabled.get() === true
      && defaults.logMaxBytes.get() === 1048576,
    JSON.stringify({ listenHost: defaults.listenHost?.get?.(), logMaxBytes: defaults.logMaxBytes?.get?.() }),
  )
  let serializes = true
  try {
    if (typeof plugin.Config.toJSON !== "function") serializes = false
    else plugin.Config.toJSON()
  } catch (_error) {
    serializes = false
  }
  check("Config serializes for the settings form projection", serializes)

  check("generated values are written exactly once", ctx2._writes.length === 1, `writes=${ctx2._writes.length}`)

  const hostRow = layout.rows.find((row) => row.name.endsWith("dsh-remote-access-proxy.mjs"))
  const uiRow = layout.rows.find((row) => row.name.endsWith("ui/lib/index.js"))
  check("bundle patch declares the host row as the settings namespace", hostRow?.id === ROW_ID, JSON.stringify(layout.rows))
  check("every patch row resolves inside the package", [hostRow, uiRow].every((row) => row !== undefined && existsSync(join(root, row.name))), JSON.stringify(layout.rows))
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
