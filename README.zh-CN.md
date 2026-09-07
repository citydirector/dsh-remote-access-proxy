# dsh-remote-access-proxy

[English](README.md) · [简体中文](README.zh-CN.md)

DSH（DeepSeek Harness）Web 界面的远程访问代理——一个宿主层（host-plane）插件：
内嵌反向代理，把 DSH Web GUI 和它的 `/api` 安全地暴露给任意远程前置（easytier、
ZeroTier、Tailscale、nginx、Caddy、Cloudflare Tunnel 或普通局域网 IP），
并自动桥接新版 DSH 的进程级启动 token 认证。

- 服务端插件 `plugin/dsh-remote-access-proxy.mjs` —— 门禁 + 转发服务器，随 DSH 启停
- 网页配置卡片 `ui/` —— 设置 → 插件配置 → 远程访问代理（客户端包）
- 验证台 `test-remote-access-proxy.mjs` —— mock DSH 的端到端测试

## 为什么需要它

新版 DSH 对浏览器会话引入两级认证：

1. **Host/Origin 信任栅栏**：`/api` 只接受回环 Host 或显式 `trustedHosts`，且 Origin 需同源；
2. **浏览器会话认证**：每次进程启动生成随机 `launchToken`（`http://127.0.0.1:3080/?token=…`），
   无 `dsh-auth-*` 签名 Cookie 的 `/api` 一律 401。

本插件把请求以回环身份（Host 改写为 `127.0.0.1:3080`、剥离 Origin）转发给 DSH，
并**自行执行 token 交换、持有 `dsh-auth-*` Cookie**，因此：
远程用户只需要随机路径 + HttpOnly Cookie 门禁，**无需知道每次启动的 launchToken**。

## 安全模型

访问控制完全由本代理的门禁承担，两层：

- **随机路径**：入口是 `https://<IP>:<端口>/<secretPath>/`，路径即第一道密钥；
- **HttpOnly Cookie**：首次通过入口时签发 `dsh_et_gate` Cookie（`Path=/; HttpOnly; SameSite=Strict`），
  之后对整个 origin 的 `/api`、静态资源放行。

强烈建议开启 TLS（`tlsEnabled: true`）：浏览器的 `crypto.randomUUID` 需要安全上下文，
明文 HTTP 下 Web 客户端会失效；且自签证书的入口会暴露随机路径——两者配合才完整。

DSH 的 launchToken 从不透传给远程用户：代理内部用 `ctx.connection.authenticatedUrl()`
获取当前进程 token，只在自身与 DSH 之间做一次交换并缓存 Cookie（30 天有效、跨重启有效、
上游返回 401 时自动重换）。

## 兼容性

- 目标：**新版 DSH**（带 launchToken + `dsh-auth-*` Cookie 认证的 Web profile）。
- 依赖：`@deepseek-ai/schemastery`（DSH 自带）、宿主 `settings` 与 `connection` 服务。
- 运行环境：作为 DSH web profile 的宿主插件（`cordis.patch.yml` insert 加载）。

## 文件结构

```
dsh-remote-access-proxy/
├── plugin/
│   └── dsh-remote-access-proxy.mjs   # 服务端插件（唯一入口）
├── ui/
│   ├── client.js                     # 配置卡片（浏览器半）
│   ├── index.js                      # 宿主半（空 apply 占位）
│   └── package.json                  # 客户端包声明（含 @deepseek-ai/dsh-api-remotes）
├── config/
│   └── settings.example.yaml         # 脱敏配置模板
├── test-remote-access-proxy.mjs      # mock DSH 端到端测试（12 项）
├── .gitignore                        # 排除 access.log / certs / node_modules
└── README.md
```

## 安装

1. **放置文件**：
   - `plugin/dsh-remote-access-proxy.mjs` → DSH `data\profiles\web\`
   - `ui/`（client.js、index.js、package.json）→ DSH `data\profiles\node_modules\dsh-remote-access-proxy-ui\`

2. **注册插件**：在 DSH `data\profiles\web\cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: dsh-remote-access-proxy
         name: ./dsh-remote-access-proxy.mjs
   - insert:
       - id: dsh-remote-access-proxy-ui
         name: dsh-remote-access-proxy-ui
   ```

   web profile 的 `patchReload: live` 会热加载注册表；插件代码改动需重启 DSH 生效。

3. **配置**：把 `config/settings.example.yaml` 的 `remote-access-proxy:` 段并入
   `data\settings.yaml`（或经 Web UI 卡片填写）。`secretPath` / `cookieValue` 留空
   会在启动时自动生成并回写。

4. **TLS 证书**（`tlsEnabled: true` 时）：生成自签 pfx 放到 `data\certs\local-proxy.pfx`
   并填 `tlsPassphrase`。证书加载失败会**拒绝启动**（fail-loud，不会降级明文）。

   ```bash
   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 825 \
     -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<你的IP>"
   openssl pkcs12 -export -out local-proxy.pfx -inkey key.pem -in cert.pem -passout pass:<口令>
   ```

5. **验证**：

   ```bash
   # 默认读 D:\dsh-portable；其他安装用 DSH_HOME 环境变量指向
   DSH_HOME=/path/to/dsh node test-remote-access-proxy.mjs
   # 期望：12 passed, 0 failed
   ```

## 配置字段

| 字段 | 说明 |
|---|---|
| `enabled` | 关闭后停止监听 |
| `listenHost` | 监听地址（`0.0.0.0` = 全接口） |
| `listenPort` | 监听端口 |
| `secretPath` | 随机门禁路径（4–32 位） |
| `cookieValue` | 门禁 HttpOnly Cookie 值 |
| `upstreamHost` / `upstreamPort` | 上游 DSH（默认 `127.0.0.1:3080`） |
| `tlsEnabled` / `tlsPfxPath` / `tlsPassphrase` | 自签 TLS |

入口：`https://<IP>:<端口>/<secretPath>/`（每设备接受一次自签证书警告）。

## 测试台说明

`test-remote-access-proxy.mjs` 会：

- mock 一个 DSH 上游（复刻 launchToken 交换 + `dsh-auth` Cookie 门禁）；
- 从 `$DSH_HOME`（默认 `D:/dsh-portable`）读取**真实插件文件**加载（保证模块解析与生产一致）；
- 验证 12 项行为：门禁放行/拒绝、Cookie 注入、token 剥离、303 Location 重写、401 自愈、WS 升级、禁用停服等；
- 快照并还原插件 `access.log`，测试不留痕。
