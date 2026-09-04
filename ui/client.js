/**
 * dsh-remote-access-proxy-ui, browser half — a configuration card for the
 * `remote-access-proxy` settings namespace, registered into the Plugins settings
 * section's card list (`settings.plugin.item`). Mirrors the shipped cards:
 * foldable card chrome, per-field parse/validation, landed-checked save
 * (only the Host decides whether a write landed; a save that did not land
 * keeps its drafts so the user can correct them).
 */
window.__ModuleLoader__.load({
  id: "dsh-remote-access-proxy-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react_jsx_runtime = require("react/jsx-runtime");
    let react = require("react");
    let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const css = ".epx_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}.epx_card:hover{border-color:var(--dsw-alias-label-dimmed)}.epx_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}.epx_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.epx_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.epx_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.epx_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.epx_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.epx_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.epx_chevronOpen{transform:rotate(180deg)}.epx_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}.epx_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.epx_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}.epx_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}.epx_discard,.epx_save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.epx_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}.epx_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}.epx_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.epx_discard:disabled,.epx_save:disabled{opacity:.4;cursor:default}.epx_discard:focus-visible,.epx_save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.epxf_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}.epxf_field+.epxf_field{border-top:1px solid var(--dsw-alias-border-l2)}.epxf_head{align-items:center;gap:8px;display:flex}.epxf_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}.epxf_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}.epxf_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.epxf_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.epxf_inputInvalid{border-color:var(--dsw-alias-label-error)}.epxf_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}.epxf_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}.epx_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}";
    const tagId = "dsh-remote-access-proxy-ui/card.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-remote-access-proxy-ui";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const SETTINGS_NS = "remote-access-proxy";

    const FIELDS = [
      { key: "enabled", label: "启用", kind: "boolean", hint: "关闭后代理停止监听" },
      { key: "listenHost", label: "监听 IP", kind: "text", hint: "本机网卡的具体 IP（如 10.0.0.5），不要填网段（如 10.0.0.0/24）" },
      { key: "listenPort", label: "监听端口", kind: "number", min: 1, max: 65535, hint: "1–65535；改动后入口 URL 同步更新" },
      { key: "secretPath", label: "随机路径", kind: "text", pattern: /^[A-Za-z0-9_-]{4,32}$/, invalidText: "4–32 位字母数字、连字符或下划线（URL 路径段）", hint: "入口 = https://<IP>:<端口>/<随机路径>/" },
      { key: "cookieValue", label: "门禁 Cookie", kind: "text", minLength: 8, invalidText: "至少 8 位", hint: "改后旧 Cookie 立即失效" },
      { key: "tlsEnabled", label: "启用 TLS", kind: "boolean", hint: "开：https 访问（浏览器需接受一次自签证书警告）；关：明文 http" },
      { key: "tlsPfxPath", label: "TLS 证书 (pfx)", kind: "text", hint: "启用 TLS 时必填，指向 pfx 文件（如 data\\certs\\local-proxy.pfx）" },
      { key: "tlsPassphrase", label: "TLS 证书口令", kind: "text", hint: "导出 pfx 时设置的口令" },
      { key: "upstreamHost", label: "上游主机", kind: "text", hint: "转发目标（默认 127.0.0.1，即 DSH 本体）" },
      { key: "upstreamPort", label: "上游端口", kind: "number", min: 1, max: 65535, hint: "转发目标端口（默认 3080）" }
    ];
    const SPECS = {};
    for (const spec of FIELDS) SPECS[spec.key] = spec;

    /** Parse a staged raw value into { ok, value? } | { ok, clear } | { ok:false }. */
    function parseField(spec, raw) {
      if (spec.kind === "boolean") return { ok: true, value: !!raw };
      const text = String(raw).trim();
      if (text === "") return { ok: true, clear: true };
      if (spec.kind === "number") {
        const n = Number(text);
        if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false };
        if (spec.min !== void 0 && n < spec.min) return { ok: false };
        if (spec.max !== void 0 && n > spec.max) return { ok: false };
        return { ok: true, value: n };
      }
      if (spec.minLength !== void 0 && text.length < spec.minLength) return { ok: false };
      if (spec.pattern !== void 0 && !spec.pattern.test(text)) return { ok: false };
      return { ok: true, value: text };
    }

    function clsx() {
      var out = "";
      for (var i = 0; i < arguments.length; i += 1) if (arguments[i]) out += (out ? " " : "") + arguments[i];
      return out;
    }

    function DSHRemoteAccessProxy(props) {
      const api = props.api;
      const [open, setOpen] = react.useState(false);
      const [snap, setSnap] = react.useState({ status: "loading", writable: true, value: {}, user: {}, revision: void 0 });
      const [staged, setStaged] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [failed, setFailed] = react.useState(false);
      const [failDetails, setFailDetails] = react.useState(null);

      // Reads go straight through the settings wire (describe), so the card
      // works on remote connections too — the settingsScope is loopback-only.
      const load = react.useCallback(async () => {
        if (api === void 0) return;
        try {
          const res = await api.settings.describe();
          if (!res.ok) return;
          const { namespaces, writable } = res.value;
          const view = namespaces.find((n) => n.ns === SETTINGS_NS);
          if (view === void 0) {
            setSnap({ status: "unavailable", writable: writable !== false, value: {}, user: {}, revision: void 0 });
            return;
          }
          setSnap({ status: "ready", writable: writable !== false, value: view.value || {}, user: view.user || {}, revision: view.revision });
          setFailed(false);
        } catch {
          /* keep previous snapshot */
        }
      }, [api]);

      react.useEffect(() => {
        load();
      }, [load]);

      const resolved = snap.value || {};
      const mode = snap.mode || "host";
      const writable = snap.writable !== false;
      const dirty = staged !== null && Object.keys(staged).length > 0;

      const rawOf = (key) => {
        if (staged !== null && Object.hasOwn(staged, key)) return staged[key];
        const v = resolved[key];
        return typeof v === "boolean" ? v : v == null ? "" : String(v);
      };
      const parsedOf = (key) => parseField(SPECS[key], rawOf(key));
      const stage = (key, raw) => setStaged((s) => ({ ...(s || {}), [key]: raw }));

      /** Write one op through the settings wire; return the host's own verdict. */
      const execute = async (op) => {
        if (api === void 0) return { ok: false, error: "settings api 不可用（未就绪）" };
        try {
          const res = await api.settings.mutate(SETTINGS_NS, [op], snap.revision);
          if (!res.ok) return { ok: false, error: res.error.message };
          return { ok: true };
        } catch (e) {
          return { ok: false, error: "RPC: " + ((e && e.message) || String(e)) };
        }
      };

      /** Planned writes, mirroring the shipped CardForm (skip no-ops; invalid = no run). */
      const plan = () => {
        if (staged === null) return [];
        const items = [];
        const user = snap.user || {};
        for (const key of Object.keys(staged)) {
          const spec = SPECS[key];
          const parsed = parseField(spec, staged[key]);
          if (!parsed.ok) {
            items.push({ key, run: void 0 });
            continue;
          }
          if (parsed.clear) {
            if (Object.hasOwn(user, key)) {
              const op = { op: "unset", path: [key] };
              items.push({ key, run: () => execute(op) });
            }
            continue;
          }
          if (parsed.value === resolved[key]) continue;
          const op = { op: "set", path: [key], value: parsed.value };
          items.push({ key, run: () => execute(op) });
        }
        return items;
      };

      const items = plan();
      const invalid = items.some((item) => item.run === void 0);
      const hasWrites = items.length > 0;

      const discard = () => {
        setStaged(null);
        setFailed(false);
        setFailDetails(null);
      };
      const save = async () => {
        if (items.length === 0 || busy || invalid) return;
        setBusy(true);
        setFailed(false);
        setFailDetails(null);
        const results = [];
        for (const item of items) results.push(await item.run());
        const failures = results.filter((r) => !r.ok);
        if (failures.length === 0) {
          setStaged(null);
          load();
        } else {
          setFailDetails(failures[0].error);
        }
        setBusy(false);
        setFailed(failures.length > 0);
      };

      const Icon = _deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14;
      const chevron = Icon
        ? react.createElement(Icon, { size: 14, className: clsx("epx_chevron", open && "epx_chevronOpen") })
        : react.createElement("span", { className: clsx("epx_chevron", open && "epx_chevronOpen") }, "\u25BE");

      const fields = FIELDS.map((spec) => {
        const parsed = parsedOf(spec.key);
        let input;
        if (spec.kind === "boolean") {
          input = react.createElement("input", {
            type: "checkbox",
            checked: !!rawOf(spec.key),
            disabled: !writable,
            style: { width: 16, height: 16 },
            onChange: (e) => stage(spec.key, e.target.checked)
          });
        } else {
          input = react.createElement("input", {
            type: spec.kind === "number" ? "number" : "text",
            className: clsx("epxf_input", !parsed.ok && "epxf_inputInvalid"),
            disabled: !writable,
            value: typeof rawOf(spec.key) === "string" ? rawOf(spec.key) : String(rawOf(spec.key) ?? ""),
            onChange: (e) => stage(spec.key, e.target.value)
          });
        }
        return react.createElement("div", { key: spec.key, className: "epxf_field" },
          react.createElement("div", { className: "epxf_head" },
            react.createElement("label", { className: "epxf_label" }, spec.label),
            input
          ),
          !parsed.ok
            ? react.createElement("p", { className: "epxf_invalid", role: "alert" }, spec.invalidText || "输入无效")
            : null,
          spec.hint ? react.createElement("p", { className: "epxf_hint" }, spec.hint) : null
        );
      });

      return react.createElement("li", { className: clsx("epx_card", open && "epx_cardOpen") },
        react.createElement("button", {
          type: "button",
          className: "epx_header",
          "aria-expanded": open,
          onClick: () => setOpen(!open)
        },
          react.createElement("span", { className: "epx_headText" },
            react.createElement("span", { className: "epx_name" }, "远程访问代理"),
            react.createElement("span", { className: "epx_description" }, "通用开放 RPC 入口：随机路径 + Cookie 门禁，任意 VPN/反代前置均可接入"),
          ),
          dirty ? react.createElement("span", { className: "epx_pending" }, "未保存") : null,
          chevron
        ),
        open
          ? react.createElement("div", { className: "epx_body" },
              !writable
                ? react.createElement("p", { className: "epx_readOnly", role: "status" }, "配置只读")
                : null,
              react.createElement("p", { className: "epxf_hint" },
                "状态: " + (snap.status || "?") + " · 可写: " + (snap.writable !== false) + " · 已载字段: " + Object.keys(resolved).length),
              react.createElement("p", { className: "epxf_hint" },
                "当前入口: " + (resolved.tlsEnabled ? "https" : "http") + "://" + (resolved.listenHost || "?") + ":" + (resolved.listenPort || "?") + "/" + (resolved.secretPath || "<随机路径>") + "/"),
              fields,
              dirty && !hasWrites
                ? react.createElement("p", { className: "epxf_hint" }, "未检测到改动——这些值已是当前配置，直接改某一项再保存")
                : null,
              react.createElement("div", { className: "epx_footer" },
                failed
                  ? react.createElement("p", { className: "epx_failed", role: "status" },
                      failDetails ? "保存未生效：" + failDetails : "保存未生效，请检查输入")
                  : null,
                react.createElement("button", { type: "button", className: "epx_discard", disabled: !dirty || busy, onClick: discard }, "放弃"),
                react.createElement("button", { type: "button", className: "epx_save", disabled: !dirty || busy || invalid || !hasWrites, onClick: save }, busy ? "保存中…" : "保存")
              )
            )
          : null
      );
    }

    const inject = ["slots", "remote", "remote.settings"];

    function apply(ctx) {
      ctx.slots.inject("settings.plugin.item", function* () {
        yield ctx.slots.register({
          name: "settings.plugin.item",
          key: "remote-access-proxy",
          id: "remote-access-proxy",
          order: 30,
          label: () => "远程访问代理",
          inject: () => ({
            api: ctx.remote
          })
        }, DSHRemoteAccessProxy);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
