/**
 * dsh-remote-access-proxy-ui, browser half — the 远程访问代理 configuration card
 * for the `remote-access-proxy` host-plugin settings namespace.
 *
 * Targets the installed harness (0.1.6-alpha.2). The old `settings.plugin.item`
 * slot and `ctx.remote.settings` wire are gone; a plugin's page now registers
 * into the Plugins page's `plugins.item` slot and reads/writes through the
 * `settingsScope` client service. Mirrors the shipped cards in
 * `@deepseek-ai/dsh-client-ui-settings-plugins`: a staged CardForm over one
 * bound scope, a form shell, and value/toggle fields; the page is registered
 * only while the Host serves the namespace.
 */
window.__ModuleLoader__.load({
  id: "dsh-remote-access-proxy-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    const { Switch, Tag } = require("@deepseek-ai/dsh-client-ui-primitives");

    /** Settings namespace the host plugin registers. */
    const NS = "remote-access-proxy";

    // ---- field specs -------------------------------------------------------
    const textField = (field) => ({
      field,
      kind: "text",
      format: (value) => (typeof value === "string" ? value : ""),
      parse: (raw) => {
        const trimmed = String(raw).trim();
        return trimmed === "" ? { kind: "clear" } : { kind: "set", value: trimmed };
      },
    });
    const numberField = (field) => ({
      field,
      kind: "number",
      format: (value) => (typeof value === "number" ? String(value) : ""),
      parse: (raw) => {
        const trimmed = String(raw).trim();
        if (trimmed === "") return { kind: "clear" };
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? { kind: "set", value: parsed } : undefined;
      },
    });
    const booleanField = (field) => ({
      field,
      kind: "boolean",
      format: (value) => (value === true ? "true" : "false"),
      parse: (raw) => ({ kind: "set", value: raw === true || raw === "true" }),
    });

    const FIELDS = [
      { spec: booleanField("enabled"), label: "启用", hint: "关闭后代理停止监听" },
      { spec: textField("listenHost"), label: "监听 IP", hint: "本机网卡的具体 IP（如 10.0.0.5）；0.0.0.0 = 全部网卡，不要填网段" },
      { spec: numberField("listenPort"), label: "监听端口", hint: "1–65535；改动后入口 URL 同步更新" },
      { spec: textField("secretPath"), label: "随机路径", hint: "入口 = https://<IP>:<端口>/<随机路径>/" },
      { spec: textField("cookieValue"), label: "门禁 Cookie", hint: "改后旧 Cookie 立即失效" },
      { spec: booleanField("tlsEnabled"), label: "启用 TLS", hint: "开：https（需接受一次自签证书警告）；关：明文 http" },
      { spec: textField("tlsPfxPath"), label: "TLS 证书 (pfx)", hint: "启用 TLS 时必填，指向 pfx 文件" },
      { spec: textField("tlsPassphrase"), label: "TLS 证书口令", hint: "导出 pfx 时设置的口令" },
      { spec: textField("upstreamHost"), label: "上游主机", hint: "转发目标（默认 127.0.0.1，即 DSH 本体）" },
      { spec: numberField("upstreamPort"), label: "上游端口", hint: "转发目标端口（默认 3080）" },
    ];

    // ---- staged form over one bound settings scope -------------------------
    /** Ported from the shipped cards' CardForm: stage edits, write them on save. */
    class CardForm {
      constructor(scope, specs) {
        this.scope = scope;
        this.specs = new Map(specs.map((spec) => [spec.field, spec]));
        this.staged = new Map();
        this.listeners = new Set();
        this.saving = false;
        this.failed = false;
        scope.subscribe(() => this.publish());
      }
      /** A { getSnapshot, subscribe } observable for the slot hooks compartment. */
      bind(project) {
        let state = project();
        const listeners = new Set();
        const api = {
          getSnapshot: () => state,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        };
        this.listeners.add(() => {
          state = project();
          for (const listener of [...listeners]) listener();
        });
        return api;
      }
      shell() {
        const snapshot = this.scope.getSnapshot();
        const plan = this.plan();
        return {
          available: snapshot.status === "ready",
          writable: snapshot.writable,
          dirty: plan.length > 0,
          invalid: plan.some((item) => item.run === undefined),
          saving: this.saving,
          failed: this.failed,
        };
      }
      field(field) {
        const spec = this.spec(field);
        const staged = this.staged.get(field);
        if (staged === undefined) {
          return { text: spec.format(this.value(field)), overridden: this.stored(field), invalid: false };
        }
        const write = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
        return { text: staged.text, overridden: write?.kind === "set", invalid: write === undefined };
      }
      actions() {
        return {
          edit: (field, value) => {
            this.staged.set(field, { text: value, clear: false });
            this.failed = false;
            this.publish();
          },
          resetField: (field) => {
            this.staged.set(field, { text: this.spec(field).format(this.base(field)), clear: true });
            this.publish();
          },
          save: () => this.save(),
          discard: () => {
            if (this.staged.size === 0 && !this.failed) return;
            this.staged.clear();
            this.failed = false;
            this.publish();
          },
        };
      }
      plan() {
        const out = [];
        for (const [field, staged] of this.staged) {
          const spec = this.spec(field);
          if (staged.clear) {
            if (this.stored(field)) out.push({ field, run: () => this.clear(field) });
            continue;
          }
          if (staged.text === spec.format(this.value(field))) continue;
          const write = spec.parse(staged.text);
          if (write === undefined) out.push({ field, run: undefined });
          else if (write.kind === "clear") out.push({ field, run: () => this.clear(field) });
          else out.push({ field, run: () => this.store(field, write.value) });
        }
        return out;
      }
      async save() {
        const plan = this.plan();
        const runs = plan.flatMap((item) => (item.run === undefined ? [] : [item.run]));
        if (plan.length === 0 || this.saving || runs.length !== plan.length) return;
        this.saving = true;
        this.failed = false;
        this.publish();
        let landed = true;
        for (const run of runs) landed = (await run()) && landed;
        if (landed) this.staged.clear();
        this.saving = false;
        this.failed = !landed;
        this.publish();
      }
      async clear(field) {
        await this.scope.unset(field);
        return !this.stored(field);
      }
      async store(field, value) {
        await this.scope.set(field, value);
        return this.user()?.[field] === value;
      }
      spec(field) {
        const spec = this.specs.get(field);
        if (spec === undefined) throw new Error("plugin card has no field " + field);
        return spec;
      }
      value(field) {
        return this.scope.getSnapshot().value?.[field];
      }
      base(field) {
        return this.scope.getSnapshot().base?.[field];
      }
      user() {
        return this.scope.getSnapshot().user;
      }
      stored(field) {
        const user = this.user();
        return user !== undefined && Object.hasOwn(user, field);
      }
      publish() {
        for (const listener of [...this.listeners]) listener();
      }
    }

    // ---- UI ----------------------------------------------------------------
    const S = {
      field: { display: "flex", flexDirection: "column", gap: 6, padding: "12px 0", borderTop: "1px solid var(--dsw-alias-border-l2)" },
      head: { display: "flex", alignItems: "center", gap: 8 },
      label: { flex: 1, fontSize: 13, fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
      input: { height: 34, padding: "0 12px", fontSize: 13, borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-primary)", boxSizing: "border-box", width: "100%" },
      invalid: { color: "var(--dsw-alias-label-error)", fontSize: 12, margin: 0 },
      hint: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, margin: 0 },
      footer: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, padding: "12px 0 4px", borderTop: "1px solid var(--dsw-alias-border-l2)" },
      save: { padding: "5px 14px", fontSize: 13, borderRadius: 8, border: "1px solid transparent", cursor: "pointer", background: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-bg-layer-3)" },
      failed: { flex: 1, color: "var(--dsw-alias-label-error)", fontSize: 12, margin: 0 },
      status: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, margin: "12px 0 0" },
      reset: { cursor: "pointer", background: "none", border: 0, fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
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
    };
    const SUMMARY = "随机路径 + HttpOnly Cookie 门禁；自动桥接 DSH 启动 token，任意 VPN/反代前置可接入";

    /** Text/number input row. */
    function ValueField(props) {
      const { kind, label, hint, state, disabled, onEdit } = props;
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
                { style: { display: "inline-flex", alignItems: "center", gap: 8 } },
                react.createElement(Tag, { tone: "neutral" }, T.overridden),
                react.createElement("button", { type: "button", style: S.reset, disabled, onClick: () => props.onReset() }, T.reset),
              )
            : null,
        ),
        react.createElement("input", {
          type: kind === "number" ? "number" : "text",
          style: S.input,
          value: state.text,
          disabled,
          onChange: (e) => onEdit(e.target.value),
        }),
        state.invalid ? react.createElement("p", { style: S.invalid, role: "alert" }, T.invalid) : null,
        hint ? react.createElement("p", { style: S.hint }, hint) : null,
      );
    }

    /** Boolean toggle row. */
    function ToggleField(props) {
      const { label, hint, state, disabled, onEdit } = props;
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
                { style: { display: "inline-flex", alignItems: "center", gap: 8 } },
                react.createElement(Tag, { tone: "neutral" }, T.overridden),
                react.createElement("button", { type: "button", style: S.reset, disabled, onClick: () => props.onReset() }, T.reset),
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

    /** The form shell: unavailable / read-only / fields / save. */
    function PluginConfigForm(props) {
      const { state, onSave, onDiscard, children } = props;
      const discard = react.useRef(onDiscard);
      discard.current = onDiscard;
      react.useEffect(() => () => {
        if (typeof discard.current === "function") discard.current();
      }, []);
      if (!state.available) return react.createElement("p", { style: S.status, role: "status" }, T.unavailable);
      const blocked = !state.dirty || state.invalid || state.saving;
      return react.createElement(
        "div",
        null,
        state.writable ? null : react.createElement("p", { style: S.status, role: "status" }, T.readOnly),
        children,
        react.createElement(
          "div",
          { style: S.footer },
          state.failed ? react.createElement("p", { style: S.failed, role: "status" }, T.saveFailed) : null,
          react.createElement("button", { type: "button", style: S.save, disabled: blocked, onClick: onSave }, state.saving ? T.saving : T.save),
        ),
      );
    }

    /** The card: one-liner for the list, the configuration form for its page. */
    function RemoteAccessProxyCard(props) {
      if (props.view === "summary") return SUMMARY;
      const state = props.useRapCard((snapshot) => snapshot);
      const fields = FIELDS.map((entry) => {
        const fieldState = state[entry.spec.field] ?? { text: "", overridden: false, invalid: false };
        const shared = {
          key: entry.spec.field,
          label: entry.label,
          hint: entry.hint,
          state: fieldState,
          disabled: !state.writable,
          onReset: () => props.resetField(entry.spec.field),
          onEdit: (value) => props.edit(entry.spec.field, value),
        };
        return entry.spec.kind === "boolean"
          ? react.createElement(ToggleField, shared)
          : react.createElement(ValueField, { ...shared, kind: entry.spec.kind });
      });
      return react.createElement(
        PluginConfigForm,
        { state, onSave: props.save, onDiscard: props.discard },
        fields,
      );
    }

    // ---- controller + registration ----------------------------------------
    class RemoteAccessProxyCardController {
      constructor(scope) {
        this.form = new CardForm(scope, FIELDS.map((entry) => entry.spec));
        this.store = this.form.bind(() => this.projection());
      }
      projection() {
        const out = { ...this.form.shell() };
        for (const entry of FIELDS) out[entry.spec.field] = this.form.field(entry.spec.field);
        return out;
      }
      inject() {
        return { hooks: { rapCard: this.store }, ...this.form.actions() };
      }
    }

    const inject = ["slots", "settingsScope"];

    function apply(ctx) {
      const card = new RemoteAccessProxyCardController(ctx.settingsScope.bind({ namespace: NS }));
      const describeFace = ctx.settingsScope.describe();
      ctx.effect(() => {
        let off;
        const sync = () => {
          const served = new Set(
            (describeFace.getSnapshot().view?.namespaces ?? []).map((view) => view.ns),
          );
          const available = served.has(NS);
          if (available && off === undefined) {
            off = ctx.slots.inject("plugins.item", () =>
              ctx.slots.register(
                {
                  name: "plugins.item",
                  id: NS,
                  order: 30,
                  label: () => "远程访问代理",
                  inject: () => card.inject(),
                },
                RemoteAccessProxyCard,
              ),
            );
          } else if (!available && off !== undefined) {
            off();
            off = undefined;
          }
        };
        const unsubscribe = describeFace.subscribe(sync);
        describeFace.ensure();
        sync();
        return () => {
          unsubscribe();
          if (off !== undefined) off();
        };
      }, "dsh-remote-access-proxy-ui: configuration page");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
