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
 * Updates are managed by the DSH Plugins page through npm.
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
        remoteNote: "远程页面可以正常使用 DSH；插件更新和部分设置（如 API Key）只能在这台电脑上操作。",
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
        remoteNote: "Remote pages can use DSH normally; plugin updates and some settings (such as the API key) work only on this computer.",
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
      }
      projection() {
        const out = { ...this.form.shell() };
        for (const entry of FIELDS) out[entry.spec.field] = this.form.field(entry.spec.field);
        return out;
      }
      /** The face the page's slot entry injects: one snapshot store plus the form actions. */
      inject() {
        return { hooks: { rapCard: this.store }, ...this.form.actions() };
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
      if (status?.version) children.push(h("p", { key: "version", style: S.note }, "v" + status.version));
      return h("section", { ref, style: S.panel, "data-rap-status": state }, children);
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
        h(StatusPanel, { status, t }),
        h(SettingsForm, { labels: t.form, state, onSave: props.save, onDiscard: props.discard }, body),
      );
    }

    // ---- registration ------------------------------------------------------
    const inject = ["slots", "configForms"];

    function apply(ctx) {
      const card = new RemoteAccessProxyCardController(ctx.configForms.get(NS));
      ctx.effect(() => () => card.dispose(), "dsh-remote-access-proxy: form subscription");
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
