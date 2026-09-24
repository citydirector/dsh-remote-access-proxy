/**
 * dsh-remote-access-proxy-ui, browser half — the 远程访问代理 configuration page
 * for the host row `remote-access-proxy`.
 *
 * Targets DSH 0.1.7+. The 0.1.6-era `settingsScope` client service is gone: the
 * shared configuration service is now `configForms` (`@deepseek-ai/dsh-client-ui-settings`),
 * and a bundle row's own page is contributed through the Plugins page's
 * `plugins.row.config` slot, keyed `<bundle package>#<row id>` — `plugins.item`
 * is reserved for the shipped official settings pages. The staged form is the
 * one the shipped companion cards use: `SettingsFormModel` over a `configForms`
 * scope plus the `ui-primitives` settings form and fields.
 *
 * The registration follows `ctx.configForms.whileServed`, so a deployment that
 * never composed the host plugin shows no page at all. Every value the page
 * edits is a `.volatile()` field of the host plugin's Config, so a save lands
 * in the active profile's `cordis.patch.yml` and restarts the embedded server
 * without remounting the plugin.
 */
window.__ModuleLoader__.load({
  id: "dsh-remote-access-proxy-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    const {
      SettingsForm,
      SettingsFormModel,
      SettingsValueField,
      Switch,
      Tag,
      settingsNumberField,
      settingsTextField,
    } = require("@deepseek-ai/dsh-client-ui-primitives");

    /** Settings namespace — the host row's profile entry id, not a separate registration. */
    const NS = "remote-access-proxy";
    /** Bundle package that declares the row; a row page is keyed `<package>#<row id>`. */
    const BUNDLE = "dsh-remote-access-proxy";
    const ROW_KEY = BUNDLE + "#" + NS;

    // ---- field specs -------------------------------------------------------
    /** A two-state field; the card renders it as a Switch rather than a text box. */
    const booleanField = (field) => ({
      field,
      format: (value) => (value === true ? "true" : "false"),
      parse: (text) => ({ kind: "set", value: text === "true" }),
    });

    const FIELDS = [
      { spec: booleanField("enabled"), kind: "boolean", label: "启用", hint: "关闭后代理停止监听" },
      { spec: settingsTextField("listenHost"), kind: "text", label: "监听 IP", hint: "本机网卡的具体 IP（如 10.0.0.5）；0.0.0.0 = 全部网卡，不要填网段" },
      { spec: settingsNumberField("listenPort"), kind: "number", label: "监听端口", hint: "1–65535；改动后入口 URL 同步更新" },
      { spec: settingsTextField("secretPath"), kind: "text", label: "随机路径", hint: "入口 = https://<IP>:<端口>/<随机路径>/" },
      { spec: settingsTextField("cookieValue"), kind: "text", label: "门禁 Cookie", hint: "改后旧 Cookie 立即失效" },
      { spec: booleanField("tlsEnabled"), kind: "boolean", label: "启用 TLS", hint: "开：https（需接受一次自签证书警告）；关：明文 http" },
      { spec: settingsTextField("tlsPfxPath"), kind: "text", label: "TLS 证书 (pfx)", hint: "启用 TLS 时必填，指向 pfx 文件" },
      { spec: settingsTextField("tlsPassphrase"), kind: "text", label: "TLS 证书口令", hint: "导出 pfx 时设置的口令" },
      { spec: settingsTextField("upstreamHost"), kind: "text", label: "上游主机", hint: "转发目标（默认 127.0.0.1，即 DSH 本体）" },
      { spec: settingsNumberField("upstreamPort"), kind: "number", label: "上游端口", hint: "转发目标端口（默认 3080）" },
      { spec: settingsNumberField("logMaxBytes"), kind: "number", label: "日志上限 (字节)", hint: "access.log 超过此大小即轮转；0 = 不轮转（默认 1048576 = 1 MiB）" },
      { spec: settingsNumberField("logKeep"), kind: "number", label: "日志保留份数", hint: "轮转后保留 access.log.1…N 的份数；0 = 不留历史，直接清空（默认 3）" },
    ];

    // ---- staged form over the host row's configuration form ----------------
    /**
     * Bridges this page onto the shared form of one Host entry: field reads,
     * staged drafts, and the single revision-fenced write a save performs.
     * Mirrors `ShellCardController` in the shipped settings pages.
     */
    class RemoteAccessProxyCardController {
      constructor(scope) {
        this.form = new SettingsFormModel(scope, FIELDS.map((entry) => entry.spec));
        this.store = this.form.bind(() => this.projection());
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

    // ---- UI ----------------------------------------------------------------
    const S = {
      field: { display: "flex", flexDirection: "column", gap: 6, padding: "12px 0", borderTop: "1px solid var(--dsw-alias-border-l2)" },
      head: { display: "flex", alignItems: "center", gap: 8 },
      label: { flex: 1, fontSize: 13, fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
      badges: { display: "inline-flex", alignItems: "center", gap: 8 },
      reset: { cursor: "pointer", background: "none", border: 0, fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
      hint: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, margin: 0 },
    };

    const T = {
      unavailable: "配置暂不可用（宿主未提供该命名空间）",
      readOnly: "配置只读（本部署以只读方式存储设置）",
      saveFailed: "保存未生效，请检查输入",
      saving: "保存中…",
      save: "保存",
      overridden: "已覆盖",
      reset: "重置",
      invalid: "输入无效",
      invalidNumber: "请填数字；留空表示恢复默认",
    };
    /** Form-frame copy, read by the shared settings form. */
    const FORM_LABELS = {
      unavailable: T.unavailable,
      readOnly: T.readOnly,
      saveFailed: T.saveFailed,
      save: T.save,
      saving: T.saving,
    };
    const SUMMARY = "随机路径 + HttpOnly Cookie 门禁；自动桥接 DSH 启动 token，任意 VPN/反代前置可接入";

    /** Text/number input row over the shared primitives field. */
    function ValueField(props) {
      const { state, numeric, ...rest } = props;
      return react.createElement(SettingsValueField, {
        ...rest,
        ...state,
        numeric,
        overriddenLabel: T.overridden,
        resetLabel: T.reset,
        invalidLabel: numeric ? T.invalidNumber : T.invalid,
      });
    }

    /** Boolean toggle row; the shared primitives ship no boolean field control. */
    function ToggleField(props) {
      const { label, hint, state, disabled, onEdit, onReset } = props;
      return react.createElement(
        "div",
        { style: S.field },
        react.createElement(
          "div",
          { style: S.head },
          react.createElement("label", { style: S.label }, label),
          state.overridden
            ? react.createElement(
                "span",
                { style: S.badges },
                react.createElement(Tag, { tone: "neutral" }, T.overridden),
                react.createElement("button", { type: "button", style: S.reset, disabled, onClick: () => onReset() }, T.reset),
              )
            : null,
          react.createElement(Switch, {
            checked: state.text === "true",
            disabled,
            label,
            onChange: (next) => onEdit(next ? "true" : "false"),
          }),
        ),
        hint ? react.createElement("p", { style: S.hint }, hint) : null,
      );
    }

    /** The page: a one-liner for the row list, the configuration form for its own page. */
    function RemoteAccessProxyCard(props) {
      if (props.view === "summary") return SUMMARY;
      const state = props.useRapCard((snapshot) => snapshot);
      const fields = FIELDS.map((entry) => {
        const fieldState = state[entry.spec.field] ?? { text: "", overridden: false, invalid: false };
        const shared = {
          key: entry.spec.field,
          id: "plugin-config-remote-access-" + entry.spec.field,
          label: entry.label,
          hint: entry.hint,
          state: fieldState,
          disabled: !state.writable,
          onReset: () => props.resetField(entry.spec.field),
          onEdit: (value) => props.edit(entry.spec.field, value),
        };
        return entry.spec.kind === "boolean"
          ? react.createElement(ToggleField, shared)
          : react.createElement(ValueField, { ...shared, numeric: entry.spec.kind === "number" });
      });
      return react.createElement(
        SettingsForm,
        { labels: FORM_LABELS, state, onSave: props.save, onDiscard: props.discard },
        fields,
      );
    }

    // ---- registration ------------------------------------------------------
    const inject = ["slots", "configForms"];

    function apply(ctx) {
      const card = new RemoteAccessProxyCardController(ctx.configForms.get(NS));
      ctx.effect(() => () => card.dispose(), "dsh-remote-access-proxy-ui: form subscription");
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
        "dsh-remote-access-proxy-ui: configuration page",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
