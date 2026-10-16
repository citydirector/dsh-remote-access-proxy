/**
 * dsh-remote-access-proxy, browser half — the Remote Access Proxy configuration
 * page for the host row `remote-access-proxy`.
 *
 * The page answers the two questions a user opens it with — "is it running?" and
 * "what do I type on my phone?" — before any field: a live status line and the
 * entry addresses with copy buttons, read from the host plugin's authenticated
 * `api/remote-access-proxy/status` route. The fields below are grouped by what
 * they control, and booleans render as switches.
 *
 * A bundle row's own page is contributed through the Plugins page's
 * `plugins.row.config` slot, keyed `<bundle package>#<row id>`. The staged form
 * is the one the shipped settings pages use: `SettingsFormModel` over a
 * `configForms` scope plus the `ui-primitives` settings form and fields. The
 * registration follows `ctx.configForms.whileServed`, so a deployment that never
 * composed the host plugin — or a remote page, which DSH does not let edit
 * Host settings — shows no page. Every value is a `.volatile()` field of the
 * host plugin's Config: a save lands in the active profile's `cordis.patch.yml`
 * and restarts the embedded server without remounting the plugin.
 *
 * Updates (1.4): the host half checks the GitHub release tags and reports the
 * newest one on the status route. "Update to vX" hands the tag-pinned spec to
 * DSH's own plugin manager (`ctx.remote.pluginManager.installBundle`, the call
 * the official Plugins page makes), which installs it over this package and
 * hot-swaps the plugin. The host half cannot do this itself: it would be
 * replaced while waiting for its own install. A hot swap may also remount this
 * page, so the operation is kept in sessionStorage and the remounted page picks
 * up its outcome (or asks the manager with `waitForInstall`). Only a page opened
 * on this machine offers the button.
 */
window.__ModuleLoader__.load({
  id: "dsh-remote-access-proxy",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    const {
      Button,
      SettingsForm,
      SettingsFormModel,
      SettingsValueField,
      StateDot,
      Switch,
      Tag,
      settingsNumberField,
      settingsTextField,
      writeClipboard,
    } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = react.createElement;

    /** Settings namespace — the host row's profile entry id, not a separate registration. */
    const NS = "remote-access-proxy";
    /** Bundle package that declares the row; a row page is keyed `<package>#<row id>`. */
    const BUNDLE = "dsh-remote-access-proxy";
    const ROW_KEY = BUNDLE + "#" + NS;
    /** Host status route, relative to the page's `<base href>` so it also works through the proxy. */
    const STATUS_URL = "api/remote-access-proxy/status";
    /** Ask the host half to check for a release now (answers with the status document). */
    const UPDATE_CHECK_URL = "api/remote-access-proxy/update-check";
    /** Where an update in progress (or its outcome) survives a hot swap of this page. */
    const UPDATE_OP_KEY = "dsh-remote-access-proxy.update";
    const POLL_MS = 3000;

    // ---- copy ----------------------------------------------------------------
    const COPY = {
      zh: {
        summary: "在手机或其它电脑上用浏览器访问 DSH：随机路径入口，可选访问密码和来源地址白名单",
        statusTitle: "状态",
        listening: "运行中",
        starting: "启动中…",
        disabled: "已关闭",
        error: "未能启动",
        unknown: "读取状态中…",
        unreachable: "读不到代理状态（插件可能未运行）",
        entries: "入口地址",
        entriesHint: "在同一网络（局域网 / VPN / 反代）的设备上用浏览器打开其中一个地址，存成书签或添加到主屏幕即可。",
        passwordOn: "需要密码：登录后这台设备会被记住 30 天。",
        allowSummary: "只允许来自：{list}（本机始终允许）",
        denied: "刚刚拒绝了 {address} 的连接。如果这是你的设备，把它加进「允许的来源地址」。",
        copy: "复制",
        copied: "已复制",
        remoteNote: "远程页面可以正常使用 DSH；一键更新和部分设置（如 API Key）只能在这台电脑上操作。",
        tlsNote: "未启用 TLS：流量是明文。只在可信网络（VPN、家庭局域网）里这样用；公网请启用 TLS 或放在 HTTPS 反代后面。",
        groupAccess: "访问",
        groupGate: "门禁",
        groupTls: "加密（TLS）",
        groupAdvanced: "高级",
        regenerate: "重新生成入口路径",
        regenerateHint: "保存后旧地址失效，所有设备都需要用新地址重新进入",
        presetPrivate: "只允许局域网和 VPN",
        presetAny: "允许任何地址",
        fields: {
          enabled: ["启用", "关闭后代理停止监听"],
          listenPort: ["监听端口", "1–65535，默认 13337；代理在本机所有网卡上监听"],
          allowFrom: ["允许的来源地址", "客户端的 IP、网段或范围，用逗号分隔，例如 192.168.1.0/24, 100.64.0.0/10, 10.0.0.5-10.0.0.9；留空 = 不限制"],
          secretPath: ["随机路径", "入口 = <地址>:<端口>/<随机路径>/；4–32 位字母、数字、- 或 _"],
          password: ["访问密码", "留空 = 不需要密码；修改后所有设备需要重新登录"],
          tlsEnabled: ["启用 TLS", "开：https（浏览器需接受一次自签证书）；关：明文 http"],
          tlsPfxPath: ["证书文件 (.pfx)", "启用 TLS 时必填；相对路径相对于 DSH 的工作目录"],
          tlsPassphrase: ["证书口令", "导出 pfx 时设置的口令，没有就留空"],
          upstreamHost: ["上游主机", "留空 = 自动跟随当前 DSH 实例"],
          upstreamPort: ["上游端口", "0 = 自动（读当前实例实际绑定的端口）"],
          logMaxBytes: ["日志上限（字节）", "access.log 超过此大小即轮转；0 = 不轮转"],
          logKeep: ["日志保留份数", "保留 access.log.1…N；0 = 不留历史"],
          updateCheck: ["检查更新", "启动几秒后和之后每 12 小时到 GitHub 看一次有没有新版本；只提示，不会自动安装"],
        },
        auto: "自动",
        form: {
          unavailable: "配置暂不可用（宿主未提供该命名空间）",
          readOnly: "配置只读（本部署以只读方式存储设置）",
          saveFailed: "保存未生效，请检查输入",
          saving: "保存中…",
          save: "保存",
        },
        overridden: "已修改",
        reset: "恢复默认",
        invalid: "输入无效",
        invalidNumber: "请填数字；留空恢复默认",
        on: "开",
        off: "关",
        update: {
          title: "版本",
          current: "当前版本 v{version}",
          off: "检查更新已关闭",
          pending: "稍后检查更新…",
          checking: "正在检查更新…",
          latest: "已是最新",
          available: "有新版本 {tag}",
          failed: "检查更新失败：{error}",
          checkedAt: "{time} 检查",
          checkNow: "立即检查",
          install: "更新到 {tag}",
          installing: "正在更新到 {tag}：下载并安装，通常需要几十秒…",
          switching: "已安装 {tag}，正在切换到新版本…",
          applied: "已更新到 v{version}",
          restart: "已安装 {tag}，重启 DSH 后生效",
          restartWhy: "原因：{reason}",
          failedInstall: "更新到 {tag} 没有成功：{reason}",
          rollback: "回退到 {tag}",
          failedRollback: "回退到 {tag} 没有成功：{reason}",
          manualRollback: "也可以在「插件」→「添加插件」里输入 {spec} 手动装回旧版本。",
          rescueTitle: "远程访问代理 · 更新",
          rollingBack: "正在回退到 {tag}…",
          rolledBack: "已回退到 v{version}",
          stillOld: "旧版本 {tag} 仍在使用，无需回退",
          unknown: "没拿到安装结果。请到「插件」页看当前版本；必要时重启 DSH。",
          details: "详细信息",
          remoteOnly: "只能在这台电脑上打开的配置页里更新（远程页面不提供更新按钮）。",
          noManager: "这个 DSH 没有提供插件管理服务，不能一键更新；请到「插件」页手动安装 {spec}。",
          manual: "也可以在「插件」→「添加插件」里输入 {spec} 手动安装。",
          dismiss: "知道了",
          restartReasons: {
            "no-hmr": "这个 profile 只在启动时应用插件变更（没有热重载）",
            "package-moved": "插件包换了安装位置（例如之前是从本地目录或其它来源安装的）",
            "host-module": "改动涉及 DSH 自身已经加载的模块",
            "unmanaged-plugin": "改动涉及不在插件列表里运行的插件",
            "module-comparison": "DSH 无法比较已加载的插件和新文件",
          },
          errors: {
            "already-installed": "DSH 认为这个版本已经装好了",
            "incompatible-version": "新版本和当前 DSH 版本不兼容",
            "not-bundle": "下载到的包不是 DSH 插件",
            "invalid-spec": "安装地址无效",
            "ambiguous-install": "DSH 无法确认装上的是哪个包",
            network: "下载失败：连不上 GitHub（检查网络或代理）",
            timeout: "下载超时",
            "not-found": "找不到这个版本（tag 不存在？）",
            "no-matching-version": "找不到这个版本（tag 不存在？）",
            "pnpm-missing": "DSH 找不到 pnpm",
            "disk-full": "磁盘空间不足",
            permission: "没有权限写入 profile 目录",
            load: "新版本装上了，但没能启动",
          },
        },
        reasons: {
          "port-in-use": "端口 {port} 已被占用：换一个端口，或关掉占用它的程序（两个 DSH 共用同一个 profile 也会这样）",
          "bad-allow": "这些来源地址写法不对：{detail}。可以写 IP（10.0.0.5）、网段（10.0.0.0/24）或范围（10.0.0.5-10.0.0.9）",
          "bad-password": "访问密码最长 256 个字符",
          "port-denied": "没有权限监听端口 {port}：换一个 1024 以上的端口",
          "bad-port": "监听端口要是 1–65535 的整数",
          "bad-secret-path": "随机路径只能是 4–32 位字母、数字、- 或 _",
          "tls-no-cert": "启用 TLS 需要先填证书文件 (.pfx)",
          "tls-load": "证书读不出来：检查证书路径和口令",
        },
      },
      en: {
        summary: "Use DSH from your phone or another computer: a secret-path entry with an optional password and client allow list",
        statusTitle: "Status",
        listening: "Running",
        starting: "Starting…",
        disabled: "Off",
        error: "Not running",
        unknown: "Reading status…",
        unreachable: "Can't read the proxy status (the plugin may not be running)",
        entries: "Entry addresses",
        entriesHint: "Open one of these in a browser on a device on the same network (LAN, VPN, or behind your reverse proxy), then bookmark it or add it to the home screen.",
        passwordOn: "Password required: a signed-in device is remembered for 30 days.",
        allowSummary: "Only from: {list} (this machine is always allowed)",
        denied: "Just turned away a connection from {address}. If that's your device, add it to Allowed client addresses.",
        copy: "Copy",
        copied: "Copied",
        remoteNote: "Remote pages can use DSH normally; one-click updates and some settings (such as the API key) work only on this computer.",
        tlsNote: "TLS is off, so traffic is plain text. Use it like this only on a trusted network (VPN, home LAN); on the internet turn TLS on or put an HTTPS reverse proxy in front.",
        groupAccess: "Access",
        groupGate: "Gate",
        groupTls: "Encryption (TLS)",
        groupAdvanced: "Advanced",
        regenerate: "Regenerate the entry path",
        regenerateHint: "After saving, the old address stops working and every device re-enters with the new one",
        presetPrivate: "LAN and VPN only",
        presetAny: "Allow any address",
        fields: {
          enabled: ["Enabled", "Turn off to stop listening"],
          listenPort: ["Listen port", "1–65535, default 13337; the proxy listens on every interface of this machine"],
          allowFrom: ["Allowed client addresses", "Client IPs, CIDR blocks or ranges, comma-separated, e.g. 192.168.1.0/24, 100.64.0.0/10, 10.0.0.5-10.0.0.9; empty = anyone"],
          secretPath: ["Secret path", "Entry = <address>:<port>/<secret path>/; 4–32 letters, digits, - or _"],
          password: ["Access password", "Empty = no password; changing it signs every device out"],
          tlsEnabled: ["Enable TLS", "On: https (accept the self-signed certificate once); off: plain http"],
          tlsPfxPath: ["Certificate (.pfx)", "Required with TLS; relative paths resolve from DSH's working directory"],
          tlsPassphrase: ["Certificate passphrase", "The passphrase set when exporting the pfx; leave empty if none"],
          upstreamHost: ["Upstream host", "Empty = follow the running DSH instance"],
          upstreamPort: ["Upstream port", "0 = automatic (reads the port the running instance actually bound)"],
          logMaxBytes: ["Log size cap (bytes)", "Rotate access.log past this size; 0 = never rotate"],
          logKeep: ["Rotated logs kept", "Keep access.log.1…N; 0 = keep no history"],
          updateCheck: ["Check for updates", "Look for a newer release on GitHub a few seconds after start and every 12 hours; it only tells you, never installs by itself"],
        },
        auto: "automatic",
        form: {
          unavailable: "Configuration unavailable (the Host does not serve this namespace)",
          readOnly: "Configuration is read-only in this deployment",
          saveFailed: "Not saved — check the values",
          saving: "Saving…",
          save: "Save",
        },
        overridden: "Changed",
        reset: "Reset",
        invalid: "Invalid value",
        invalidNumber: "Enter a number; leave empty for the default",
        on: "On",
        off: "Off",
        update: {
          title: "Version",
          current: "Version v{version}",
          off: "Update check is off",
          pending: "Checking for updates shortly…",
          checking: "Checking for updates…",
          latest: "Up to date",
          available: "{tag} is available",
          failed: "Couldn't check for updates: {error}",
          checkedAt: "checked {time}",
          checkNow: "Check now",
          install: "Update to {tag}",
          installing: "Updating to {tag}: downloading and installing, usually under a minute…",
          switching: "{tag} is installed; switching over…",
          applied: "Updated to v{version}",
          restart: "{tag} is installed and takes effect after DSH restarts",
          restartWhy: "Why: {reason}",
          failedInstall: "The update to {tag} didn't work: {reason}",
          rollback: "Roll back to {tag}",
          failedRollback: "The rollback to {tag} didn't work: {reason}",
          manualRollback: "You can also reinstall the old version: Plugins → Add plugin → {spec}.",
          rescueTitle: "Remote Access Proxy · update",
          rollingBack: "Rolling back to {tag}…",
          rolledBack: "Rolled back to v{version}",
          stillOld: "{tag} is still the version in use; nothing to roll back",
          unknown: "No result came back. Check the version on the Plugins page, and restart DSH if needed.",
          details: "Details",
          remoteOnly: "Updates are installed from the configuration page opened on this computer (remote pages have no update button).",
          noManager: "This DSH offers no plugin manager to update with; install {spec} from the Plugins page instead.",
          manual: "You can also install {spec} from Plugins → Add plugin.",
          dismiss: "OK",
          restartReasons: {
            "no-hmr": "this profile applies plugin changes only at startup (no hot reload)",
            "package-moved": "the package now installs to another place (for example it was installed from a local folder or another source before)",
            "host-module": "the change reaches modules DSH itself loaded",
            "unmanaged-plugin": "the change reaches a plugin running outside the plugin list",
            "module-comparison": "DSH could not compare the loaded plugin with the new files",
          },
          errors: {
            "already-installed": "DSH considers this version already installed",
            "incompatible-version": "the new version is not compatible with this DSH",
            "not-bundle": "the downloaded package is not a DSH plugin",
            "invalid-spec": "the install address is invalid",
            "ambiguous-install": "DSH could not tell which package was installed",
            network: "download failed: GitHub is unreachable (check the network or proxy)",
            timeout: "the download timed out",
            "not-found": "that version does not exist (missing tag?)",
            "no-matching-version": "that version does not exist (missing tag?)",
            "pnpm-missing": "DSH cannot find pnpm",
            "disk-full": "the disk is full",
            permission: "no permission to write the profile folder",
            load: "the new version installed but did not start",
          },
        },
        reasons: {
          "port-in-use": "Port {port} is already in use: pick another port, or close the program holding it (two DSH apps sharing one profile do this too)",
          "bad-allow": "These client addresses aren't valid: {detail}. Use an IP (10.0.0.5), a CIDR block (10.0.0.0/24) or a range (10.0.0.5-10.0.0.9)",
          "bad-password": "The access password can be at most 256 characters",
          "port-denied": "No permission to listen on port {port}: pick a port above 1024",
          "bad-port": "The listen port must be an integer from 1 to 65535",
          "bad-secret-path": "The secret path must be 4–32 letters, digits, - or _",
          "tls-no-cert": "TLS needs a certificate file (.pfx) first",
          "tls-load": "The certificate could not be loaded: check its path and passphrase",
        },
      },
    };
    /** Pick the dictionary for the page's language (DSH sets `<html lang>`). */
    function copy() {
      const lang = (document.documentElement.lang || navigator.language || "en").toLowerCase();
      return lang.startsWith("zh") ? COPY.zh : COPY.en;
    }

    // ---- field specs -------------------------------------------------------
    /** A two-state field; the page renders it as a Switch rather than a text box. */
    const booleanField = (field) => ({
      field,
      format: (value) => (value === true ? "true" : "false"),
      parse: (text) => ({ kind: "set", value: text === "true" }),
    });

    /** Fields by group, in page order. `kind` picks the control. */
    const GROUPS = [
      { title: "groupAccess", fields: [
        { spec: booleanField("enabled"), kind: "boolean" },
        { spec: settingsNumberField("listenPort"), kind: "number" },
        { spec: settingsTextField("allowFrom"), kind: "text", presets: true },
      ] },
      { title: "groupGate", gate: true, fields: [
        { spec: settingsTextField("secretPath"), kind: "text" },
        { spec: settingsTextField("password"), kind: "text", secret: true },
        // The server secret that signs remembered devices: edited only by the
        // regenerate button, never shown.
        { spec: settingsTextField("cookieValue"), kind: "text", hidden: true },
      ] },
      { title: "groupTls", fields: [
        { spec: booleanField("tlsEnabled"), kind: "boolean" },
        { spec: settingsTextField("tlsPfxPath"), kind: "text" },
        { spec: settingsTextField("tlsPassphrase"), kind: "text" },
      ] },
      { title: "groupAdvanced", fields: [
        { spec: settingsTextField("upstreamHost"), kind: "text", auto: true },
        { spec: settingsNumberField("upstreamPort"), kind: "number", auto: true },
        { spec: settingsNumberField("logMaxBytes"), kind: "number" },
        { spec: settingsNumberField("logKeep"), kind: "number" },
        { spec: booleanField("updateCheck"), kind: "boolean" },
      ] },
    ];
    const FIELDS = GROUPS.flatMap((group) => group.fields);
    /** Private LANs, CGNAT/Tailscale, IPv6 ULA and link-local (matches the host's PRIVATE_NETWORKS). */
    const PRIVATE_NETWORKS = "10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, fc00::/7, fe80::/10";
    /** Mask a secret field until it is focused (the shared field is a plain text input). */
    const SECRET_STYLE = "[data-rap-secret] input:not(:focus){-webkit-text-security:disc;text-security:disc}";

    /** A random lowercase alphanumeric token (getRandomValues works on any origin). */
    function randomToken(length) {
      const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      const limit = 256 - (256 % chars.length);
      let out = "";
      while (out.length < length) {
        for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
          if (byte >= limit) continue;
          out += chars[byte % chars.length];
          if (out.length === length) break;
        }
      }
      return out;
    }

    // ---- staged form over the host row's configuration form ----------------
    /**
     * Bridges this page onto the shared form of one Host entry: field reads,
     * staged drafts, and the single revision-fenced write a save performs.
     */
    class RemoteAccessProxyCardController {
      constructor(scope) {
        this.form = new SettingsFormModel(scope, FIELDS.map((entry) => entry.spec));
        this.store = this.form.bind(() => this.projection());
        /** The plugin manager Remote and whether this page runs on the Host's machine; set once served. */
        this.updater = { manager: undefined, isLoopback: false };
      }
      projection() {
        const out = { ...this.form.shell() };
        for (const entry of FIELDS) out[entry.spec.field] = this.form.field(entry.spec.field);
        return out;
      }
      /** The face the page's slot entry injects: one snapshot store plus the form actions. */
      inject() {
        return { hooks: { rapCard: this.store }, updater: this.updater, ...this.form.actions() };
      }
      dispose() {
        this.form.dispose();
      }
    }

    // ---- live status ---------------------------------------------------------
    /** Poll the host plugin's status route while the page is open. */
    function useProxyStatus(refreshKey) {
      const [status, setStatus] = react.useState(undefined);
      // "Check now" answers with a fresh status document; show it at once.
      react.useEffect(() => {
        const onFresh = (event) => setStatus(event.detail);
        window.addEventListener("rap-status", onFresh);
        return () => window.removeEventListener("rap-status", onFresh);
      }, []);
      react.useEffect(() => {
        let alive = true;
        let timer;
        const read = async () => {
          try {
            const response = await fetch(STATUS_URL, { credentials: "same-origin", cache: "no-store" });
            const next = response.ok ? await response.json() : { state: "unreachable" };
            if (alive) setStatus(next);
          } catch (_error) {
            if (alive) setStatus({ state: "unreachable" });
          }
          if (alive) timer = setTimeout(read, POLL_MS);
        };
        void read();
        return () => {
          alive = false;
          clearTimeout(timer);
        };
      }, [refreshKey]);
      return status;
    }

    // ---- UI ----------------------------------------------------------------
    const S = {
      panel: { display: "flex", flexDirection: "column", gap: 10, padding: 16, marginBottom: 24, borderRadius: 12, border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-bg-layer-1)" },
      statusLine: { display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
      reason: { margin: 0, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-state-error-primary)", overflowWrap: "anywhere" },
      label: { margin: "6px 0 0", fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-secondary)" },
      urlRow: { display: "flex", alignItems: "center", gap: 8 },
      url: { flex: 1, minWidth: 0, padding: "6px 10px", borderRadius: 8, background: "var(--dsw-alias-bg-layer-3)", fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)", fontSize: 13, color: "var(--dsw-alias-label-primary)", overflowWrap: "anywhere", userSelect: "all" },
      note: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
      warn: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))" },
      groupTitle: { margin: "20px 0 0", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      field: { display: "flex", flexDirection: "column", gap: 6, padding: "12px 0", borderTop: "1px solid var(--dsw-alias-border-l2)" },
      head: { display: "flex", alignItems: "center", gap: 8 },
      fieldLabel: { flex: 1, fontSize: 13, fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
      badges: { display: "inline-flex", alignItems: "center", gap: 8 },
      reset: { cursor: "pointer", background: "none", border: 0, fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
      hint: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, margin: 0 },
      regen: { display: "flex", alignItems: "center", gap: 10, padding: "10px 0 2px" },
      updateRow: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 },
      ok: { margin: 0, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary))" },
      pre: { margin: 0, maxHeight: 180, overflow: "auto", padding: "8px 10px", borderRadius: 8, background: "var(--dsw-alias-bg-layer-3)", fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--dsw-alias-label-secondary)" },
    };

    /** One entry address with its copy button. */
    function EntryUrl(props) {
      const t = props.t;
      const [copied, setCopied] = react.useState(false);
      return h(
        "div",
        { style: S.urlRow },
        h("code", { style: S.url }, props.url),
        h(
          Button,
          {
            variant: "outline",
            size: "sm",
            onClick: async () => {
              try {
                await writeClipboard(props.url);
              } catch (_error) {
                /* the address stays selectable */
              }
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
          },
          copied ? t.copied : t.copy,
        ),
      );
    }

    /** The status panel: running or why not, then the addresses to open remotely. */
    function StatusPanel(props) {
      const t = props.t;
      const status = props.status;
      const state = status === undefined ? "unknown" : status.state;
      const dot = state === "listening" ? "done" : state === "error" || state === "unreachable" ? "error" : state === "disabled" ? "idle" : "ongoing";
      const label = {
        listening: t.listening + (status?.scheme ? " · " + status.scheme + " · :" + status.listenPort : ""),
        starting: t.starting,
        disabled: t.disabled,
        error: t.error,
        unreachable: t.unreachable,
        unknown: t.unknown,
      }[state] ?? state;
      const children = [
        h("div", { key: "line", style: S.statusLine }, h(StateDot, { state: dot }), h("span", null, label)),
      ];
      if (state === "error") {
        const template = t.reasons[status.code];
        const text = template === undefined
          ? status.error
          : template.replace("{port}", String(status.listenPort)).replace("{detail}", String(status.detail ?? ""));
        children.push(h("p", { key: "reason", style: S.reason, title: status.error }, text));
      }
      if (state === "listening" && Array.isArray(status.urls) && status.urls.length > 0) {
        children.push(h("p", { key: "label", style: S.label }, t.entries));
        for (const url of status.urls) children.push(h(EntryUrl, { key: url, url, t }));
        children.push(h("p", { key: "hint", style: S.note }, t.entriesHint));
        if (status.password) children.push(h("p", { key: "pw", style: S.note }, t.passwordOn));
        if (Array.isArray(status.allowFrom) && status.allowFrom.length > 0) {
          children.push(h("p", { key: "allow", style: S.note }, t.allowSummary.replace("{list}", status.allowFrom.join(", "))));
        }
        if (status.lastDenied) children.push(h("p", { key: "denied", style: S.warn }, t.denied.replace("{address}", status.lastDenied.address)));
        if (!status.tls) children.push(h("p", { key: "tls", style: S.warn }, t.tlsNote));
        children.push(h("p", { key: "remote", style: S.note }, t.remoteNote));
      }
      // A save that breaks the listener (a busy port, a bad certificate) happens
      // at the bottom of the form; bring the reason into view.
      const ref = react.useRef(null);
      react.useEffect(() => {
        if (state === "error" && ref.current && typeof ref.current.scrollIntoView === "function") {
          ref.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      }, [state, status?.error]);
      if (state !== "unknown" && state !== "unreachable") children.push(h(UpdatePanel, { key: "update", t, status, updater: props.updater }));
      return h("section", { ref, style: S.panel, "data-rap-status": state }, children);
    }

    // ---- updates -------------------------------------------------------------
    /** The update in progress or its outcome, shared by every mount of this page in the tab. */
    function readOp() {
      try {
        const raw = sessionStorage.getItem(UPDATE_OP_KEY);
        return raw ? JSON.parse(raw) : undefined;
      } catch (_error) {
        return undefined;
      }
    }
    function writeOp(op) {
      try {
        if (op === undefined) sessionStorage.removeItem(UPDATE_OP_KEY);
        else sessionStorage.setItem(UPDATE_OP_KEY, JSON.stringify(op));
      } catch (_error) {
        /* private mode: the outcome shows in this mount only */
      }
      window.dispatchEvent(new CustomEvent("rap-update-op"));
    }
    function useUpdateOp() {
      const [op, setOp] = react.useState(readOp);
      react.useEffect(() => {
        const sync = () => setOp(readOp());
        window.addEventListener("rap-update-op", sync);
        return () => window.removeEventListener("rap-update-op", sync);
      }, []);
      return op;
    }
    function requestId() {
      if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
      return "rap-" + randomToken(24);
    }
    /** `#v1.4.0` out of a tag-pinned spec, for labels. */
    function tagOf(spec) {
      const hash = String(spec || "").lastIndexOf("#");
      return hash >= 0 ? spec.slice(hash + 1) : String(spec || "");
    }
    function formatTime(iso) {
      try {
        return new Date(iso).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      } catch (_error) {
        return String(iso);
      }
    }
    /**
     * A plain-language diagnostic of a failed install: the refusal or package
     * failure in words, and the raw manager output for the details box.
     */
    function describeFailure(t, result) {
      const code = result?.error?.code;
      const kind = result?.packageResult?.kind;
      const words = (code && code !== "operation-error" && t.update.errors[code]) || (kind && t.update.errors[kind]) || (result?.stage === "enable" ? t.update.errors.load : undefined);
      const raw = [result?.error?.message, result?.error?.diagnostic, result?.packageResult?.output].filter(Boolean).join("\n").trim();
      return { text: words || result?.error?.message || code || "failed", raw: raw.length > 4000 ? raw.slice(-4000) : raw };
    }

    /**
     * Run one install through DSH's plugin manager and keep its outcome in
     * sessionStorage. `kind` is "update" or "rollback". The page that started it
     * may be torn down by the very hot swap it causes; the stored record lets the
     * next mount finish the story.
     */
    async function runInstall(manager, kind, spec, from) {
      const id = requestId();
      writeOp({ kind, spec, from, phase: "installing", requestId: id, at: Date.now() });
      let answer;
      try {
        answer = await manager.installBundle(spec, { requestId: id });
      } catch (error) {
        answer = { ok: false, error: { message: String(error?.message ?? error) } };
      }
      settleInstall(kind, spec, from, id, answer);
    }
    function settleInstall(kind, spec, from, id, answer) {
      const op = readOp();
      // A newer operation replaced this one; its own settlement owns the record.
      if (op !== undefined && op.requestId !== id) return;
      if (!answer || !answer.ok) {
        // The reply was lost (the page or connection went away mid-install): ask again from the next mount.
        writeOp({ kind, spec, from, phase: "lost", requestId: id, at: Date.now(), message: answer?.error?.message });
        return;
      }
      const result = answer.value;
      if (result === null || result === undefined) {
        writeOp({ kind, spec, from, phase: "unknown", requestId: id, at: Date.now() });
        return;
      }
      writeOp({
        kind, spec, from, requestId: id, at: Date.now(),
        phase: result.application,
        version: result.version,
        restartReason: result.restartReason,
        error: result.error,
        stage: result.stage,
        packageResult: result.packageResult ? { kind: result.packageResult.kind, output: String(result.packageResult.output ?? "").slice(-4000) } : undefined,
      });
    }

    /**
     * What an install in progress came to, as page rows: progress, the new
     * version, why a restart is needed, or the diagnostic with a rollback.
     * `version` is the running version when known (the status card), else the
     * installed result's own.
     */
    function outcomeRows(t, op, { version, manager, local }) {
      const u = t.update;
      const tag = tagOf(op.spec);
      const fromTag = tagOf(op.from);
      const busy = op.phase === "installing" || op.phase === "lost";
      const done = [];
      if (busy) {
        done.push(h("p", { key: "busy", style: S.note }, (op.kind === "rollback" ? u.rollingBack : u.installing).replace("{tag}", tag)));
      } else if (op.phase === "applied") {
        const target = tag.replace(/^v/, "");
        const running = version ?? op.version;
        if (running === target) done.push(h("p", { key: "ok", style: S.ok }, (op.kind === "rollback" ? u.rolledBack : u.applied).replace("{version}", running)));
        else done.push(h("p", { key: "sw", style: S.note }, u.switching.replace("{tag}", tag)));
      } else if (op.phase === "restart-required") {
        done.push(h("p", { key: "rs", style: S.warn }, u.restart.replace("{tag}", tag)));
        const why = u.restartReasons[op.restartReason];
        if (why || op.restartReason) done.push(h("p", { key: "why", style: S.note }, u.restartWhy.replace("{reason}", why || op.restartReason)));
      } else if (op.phase === "failed") {
        const diag = describeFailure(t, op);
        if (op.kind === "rollback" && op.error?.code === "already-installed") {
          done.push(h("p", { key: "old", style: S.note }, u.stillOld.replace("{tag}", tag)));
        } else {
          done.push(h("p", { key: "f", style: S.reason }, (op.kind === "rollback" ? u.failedRollback : u.failedInstall).replace("{tag}", tag).replace("{reason}", diag.text)));
          if (diag.raw) done.push(h("details", { key: "d" }, h("summary", { style: S.note }, u.details), h("pre", { style: S.pre }, diag.raw)));
          if (op.kind === "update" && op.from && manager !== undefined && local) {
            done.push(h("div", { key: "rb", style: S.updateRow }, h(Button, {
              variant: "primary", size: "sm", "data-rap-rollback": fromTag,
              onClick: () => void runInstall(manager, "rollback", op.from, op.spec),
            }, u.rollback.replace("{tag}", fromTag))));
          }
          if (op.kind === "update" && op.from) done.push(h("p", { key: "rbm", style: S.note }, u.manualRollback.replace("{spec}", op.from)));
        }
      } else if (op.phase === "unknown") {
        done.push(h("p", { key: "u", style: S.warn }, u.unknown));
      }
      if (!busy && op.phase !== "cancelled") {
        done.push(h("div", { key: "x" }, h(Button, { variant: "ghost", size: "sm", onClick: () => writeOp(undefined) }, u.dismiss)));
      }
      return done;
    }

    /** How many status cards are on screen; the rescue card stands in when none is. */
    function usePanelCount() {
      const [count, setCount] = react.useState(() => window.__rapUpdatePanels || 0);
      react.useEffect(() => {
        const sync = () => setCount(window.__rapUpdatePanels || 0);
        window.addEventListener("rap-update-panels", sync);
        sync();
        return () => window.removeEventListener("rap-update-panels", sync);
      }, []);
      return count;
    }
    function useMarkPanel() {
      react.useEffect(() => {
        window.__rapUpdatePanels = (window.__rapUpdatePanels || 0) + 1;
        window.dispatchEvent(new CustomEvent("rap-update-panels"));
        return () => {
          window.__rapUpdatePanels = Math.max(0, (window.__rapUpdatePanels || 1) - 1);
          window.dispatchEvent(new CustomEvent("rap-update-panels"));
        };
      }, []);
    }

    /**
     * An update outlives the page that started it: if the new version fails to
     * start, DSH hides this plugin's own page (its host row is not running), so
     * the outcome — and the rollback button — would have nowhere to show. This
     * card sits in the shell overlay instead, outside the row page's lifetime,
     * and shows only while there is an outcome and no status card on screen.
     */
    function UpdateRescue(props) {
      const t = copy();
      const op = useUpdateOp();
      const panels = usePanelCount();
      if (op === undefined || panels > 0 || op.phase === "cancelled") return null;
      const updater = props.updater;
      return h(
        "div",
        { "data-rap-rescue": op.phase, style: { position: "fixed", right: 16, bottom: 16, zIndex: 1000, width: "min(420px, calc(100vw - 32px))", display: "flex", flexDirection: "column", gap: 8, padding: 14, borderRadius: 12, border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-bg-layer-1, Canvas)", boxShadow: "0 8px 30px rgba(0,0,0,.18)", pointerEvents: "auto" } },
        h("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, t.update.rescueTitle),
        outcomeRows(t, op, { version: undefined, manager: updater?.manager, local: updater?.isLoopback === true }),
      );
    }

    /** Version and update section of the status card. */
    function UpdatePanel(props) {
      const { t, status, updater } = props;
      const u = t.update;
      const op = useUpdateOp();
      const [checking, setChecking] = react.useState(false);
      const info = status?.update;
      const version = status?.version;
      const manager = updater?.manager;
      const local = updater?.isLoopback === true;
      useMarkPanel();

      // A mount that finds an install still marked in progress (the page that
      // started it was swapped out) asks the manager for its result once.
      const recovering = react.useRef(false);
      react.useEffect(() => {
        if (op === undefined || manager === undefined || recovering.current) return;
        if (op.phase !== "installing" && op.phase !== "lost") return;
        if (op.phase === "installing" && Date.now() - op.at < 1500) return;
        recovering.current = true;
        manager.waitForInstall(op.requestId).then((answer) => {
          if (answer && answer.ok && answer.value === null) {
            // The manager keeps no finished results: the running version tells.
            const target = tagOf(op.spec).replace(/^v/, "");
            if (version === target) writeOp({ ...op, phase: "applied", version: target });
            else if (op.phase === "lost") writeOp({ ...op, phase: "unknown" });
          } else if (answer && answer.ok) {
            settleInstall(op.kind, op.spec, op.from, op.requestId, answer);
          }
        }, () => {}).finally(() => {
          recovering.current = false;
        });
      }, [op?.requestId, op?.phase, manager, version]);

      const busy = op !== undefined && (op.phase === "installing" || op.phase === "lost");
      const rows = [];
      const line = [h("span", { key: "v" }, version ? u.current.replace("{version}", version) : u.title)];
      let verdict;
      if (info?.state === "off") verdict = u.off;
      else if (info?.state === "pending") verdict = u.pending;
      else if (info?.state === "checking" || checking) verdict = u.checking;
      else if (info?.state === "current") verdict = u.latest;
      else if (info?.state === "available") verdict = u.available.replace("{tag}", info.latest);
      else if (info?.state === "failed") verdict = u.failed.replace("{error}", info.error || "?");
      if (verdict) line.push(h("span", { key: "s", style: { color: "var(--dsw-alias-label-secondary)" } }, "· " + verdict + (info?.checkedAt && info.state !== "checking" ? " (" + u.checkedAt.replace("{time}", formatTime(info.checkedAt)) + ")" : "")));
      if (info !== undefined && info.state !== "off") {
        line.push(h(Button, {
          key: "check", variant: "outline", size: "sm", disabled: checking || busy || info.state === "checking",
          onClick: async () => {
            setChecking(true);
            try {
              const response = await fetch(UPDATE_CHECK_URL, { method: "POST", credentials: "same-origin", cache: "no-store" });
              if (response.ok) window.dispatchEvent(new CustomEvent("rap-status", { detail: await response.json() }));
            } catch (_error) {
              /* the next poll shows the state */
            }
            setChecking(false);
          },
        }, u.checkNow));
      }
      rows.push(h("div", { key: "line", style: { ...S.updateRow, fontSize: 13, color: "var(--dsw-alias-label-primary)" } }, line));

      // An install in progress, or what came of it.
      if (op !== undefined) rows.push(h("div", { key: "op", style: { display: "flex", flexDirection: "column", gap: 6 } }, outcomeRows(t, op, { version, manager, local })));

      // The button: only a page on this machine, with a plugin manager, offers it.
      if (info?.state === "available" || (info?.state === "failed" && info.stale === "available")) {
        const spec = info.spec;
        if (!local) rows.push(h("p", { key: "remote", style: S.note }, u.remoteOnly));
        else if (manager === undefined) rows.push(h("p", { key: "nom", style: S.note }, u.noManager.replace("{spec}", spec)));
        else if (!(op !== undefined && op.phase === "applied" && tagOf(op.spec) === info.latest)) {
          rows.push(h("div", { key: "go", style: S.updateRow }, h(Button, {
            variant: "primary", size: "sm", disabled: busy, "data-rap-update": info.latest,
            onClick: () => {
              if (!busy) void runInstall(manager, "update", spec, info.currentSpec);
            },
          }, u.install.replace("{tag}", info.latest))));
          rows.push(h("p", { key: "man", style: S.note }, u.manual.replace("{spec}", spec)));
        }
      }
      return h("div", { style: { display: "flex", flexDirection: "column", gap: 8, paddingTop: 10, borderTop: "1px solid var(--dsw-alias-border-l2)" }, "data-rap-update-state": info?.state ?? "unknown" }, rows);
    }

    /** Text/number input row over the shared primitives field. */
    function ValueField(props) {
      const { state, numeric, t, ...rest } = props;
      return h(SettingsValueField, {
        ...rest,
        ...state,
        numeric,
        overriddenLabel: t.overridden,
        resetLabel: t.reset,
        invalidLabel: numeric ? t.invalidNumber : t.invalid,
      });
    }

    /** Boolean toggle row; the shared primitives ship no boolean field control. */
    function ToggleField(props) {
      const { label, hint, state, disabled, onEdit, onReset, t } = props;
      return h(
        "div",
        { style: S.field },
        h(
          "div",
          { style: S.head },
          h("label", { style: S.fieldLabel }, label),
          state.overridden
            ? h(
                "span",
                { style: S.badges },
                h(Tag, { tone: "neutral" }, t.overridden),
                h("button", { type: "button", style: S.reset, disabled, onClick: () => onReset() }, t.reset),
              )
            : null,
          h(Switch, {
            checked: state.text === "true",
            disabled,
            label,
            onChange: (next) => onEdit(next ? "true" : "false"),
          }),
        ),
        hint ? h("p", { style: S.hint }, hint) : null,
      );
    }

    /** The page: a one-liner for the row list, status + grouped form for its own page. */
    function RemoteAccessProxyCard(props) {
      const t = copy();
      if (props.view === "summary") return t.summary;
      const state = props.useRapCard((snapshot) => snapshot);
      // Re-read the status right after a save lands (the server restarts in place).
      const status = useProxyStatus(state.saving ? 1 : 0);
      const field = (entry) => {
        const name = entry.spec.field;
        const fieldState = state[name] ?? { text: "", overridden: false, invalid: false };
        const [label, hint] = t.fields[name];
        const shared = {
          key: name,
          id: "plugin-config-remote-access-" + name,
          label,
          hint,
          t,
          state: fieldState,
          disabled: !state.writable,
          onReset: () => props.resetField(name),
          onEdit: (value) => props.edit(name, value),
        };
        if (entry.kind === "boolean") return h(ToggleField, shared);
        const input = h(ValueField, { ...shared, numeric: entry.kind === "number", placeholder: entry.auto ? t.auto : undefined });
        if (entry.secret) return h("div", { key: name, "data-rap-secret": "" }, input);
        if (!entry.presets) return input;
        return h(
          "div",
          { key: name },
          input,
          h(
            "div",
            { style: S.regen },
            h(Button, { variant: "outline", size: "sm", disabled: !state.writable, onClick: () => props.edit(name, PRIVATE_NETWORKS) }, t.presetPrivate),
            h(Button, { variant: "ghost", size: "sm", disabled: !state.writable, onClick: () => props.edit(name, "") }, t.presetAny),
          ),
        );
      };
      const body = [];
      for (const group of GROUPS) {
        body.push(h("h4", { key: "title-" + group.title, style: S.groupTitle }, t[group.title]));
        for (const entry of group.fields) if (!entry.hidden) body.push(field(entry));
        if (group.gate) {
          body.push(
            h(
              "div",
              { key: "regen", style: S.regen },
              h(
                Button,
                {
                  variant: "outline",
                  size: "sm",
                  disabled: !state.writable,
                  onClick: () => {
                    props.edit("secretPath", randomToken(12));
                    props.edit("cookieValue", randomToken(24));
                  },
                },
                t.regenerate,
              ),
              h("span", { style: S.hint }, t.regenerateHint),
            ),
          );
        }
      }
      return h(
        "div",
        null,
        h("style", null, SECRET_STYLE),
        h(StatusPanel, { status, t, updater: props.updater }),
        h(SettingsForm, { labels: t.form, state, onSave: props.save, onDiscard: props.discard }, body),
      );
    }

    // ---- registration ------------------------------------------------------
    const inject = ["slots", "configForms"];

    function apply(ctx) {
      const card = new RemoteAccessProxyCardController(ctx.configForms.get(NS));
      ctx.effect(() => () => card.dispose(), "dsh-remote-access-proxy: form subscription");
      // DSH's plugin manager, the same Remote the Plugins page installs through.
      // Optional: without it the page still shows the update, with the spec to install by hand.
      ctx.inject(["remote", "remote.pluginManager"], (sub) => {
        card.updater.manager = sub.remote.pluginManager;
        card.updater.isLoopback = sub.remote.$host?.isLoopback === true;
        sub.effect(() => () => {
          card.updater.manager = undefined;
        }, "dsh-remote-access-proxy: plugin manager");
      });
      // The update outcome card: outside whileServed, so it still shows when a
      // failed update leaves the host row (and with it the row page) stopped.
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "dsh-remote-access-proxy.update", inject: () => ({ updater: card.updater }) },
          UpdateRescue,
        ),
      );
      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS], () =>
            ctx.slots.inject("plugins.row.config", () =>
              ctx.slots.register(
                { name: "plugins.row.config", key: ROW_KEY, inject: () => card.inject() },
                RemoteAccessProxyCard,
              ),
            ),
          ),
        "dsh-remote-access-proxy: configuration page",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
