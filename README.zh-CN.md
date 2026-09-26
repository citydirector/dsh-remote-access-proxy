# dsh-remote-access-proxy

[English](README.md) · [简体中文](README.zh-CN.md)

DSH（DeepSeek Harness）Web 界面的远程访问代理，以 **DSH profile bundle** 形式分发：
内嵌反向代理，把 Web GUI 与其 `/api` 安全地暴露给任意远程前置（easytier、ZeroTier、
Tailscale、nginx、Caddy、Cloudflare Tunnel 或普通局域网 IP），自动桥接新版 DSH 的
进程级启动 token 认证，并向插件面板贡献自己的配置页。

面向 **DSH 0.1.7-rc.1 及以上**（profile 持有配置的新模型）。该要求写在
`peerDependencies` 里，因此在更旧的 harness 上安装会被明确拒绝，而不是加载到一半报错。

## 安装

本仓库**本身就是一个 bundle 包**，插件页可直接用 GitHub URL 安装。

### 从插件页安装（推荐）

打开侧边栏**插件**面板 → 安装，填入仓库地址：

```
https://github.com/citydirector/dsh-remote-access-proxy
```

管理器会对该 URL 执行 pnpm、读取 `dsh.bundle.patch`，把本 bundle 的行加入 profile
的用户层。启用后，打开该 bundle 的页面，进入 **`remote-access-proxy`** 行，用它的
配置页编辑即可。

### 用 profile CLI

```bash
dsh plugin --profile web add github:citydirector/dsh-remote-access-proxy
```

git 依赖的 commit 由 profile 的 `pnpm-lock.yaml` 钉住，普通 `pnpm install` 不会移动它。
要前移到新版本，就在 profile 目录里用同样的 spec 重跑 `pnpm add`，再把该 bundle 关→开；
这也正是让 `node_modules`、`.modules.yaml`、`pnpm-lock.yaml` 三者重新一致的做法。

### 手动安装

把 `plugin/`、`ui/`、`locale/`、`icon.svg` 拷入 profile，自行插入两行：

```yaml
# data/profiles/web/cordis.patch.yml
- insert:
    - id: remote-access-proxy
      name: ./plugin/dsh-remote-access-proxy.mjs
    - id: remote-access-proxy-ui
      name: ./ui/lib/index.js
```

宿主行的 id 是关键：0.1.7+ 里，插件的设置命名空间**就是**它的 profile entry id。
另外手动安装没有 bundle 条目，插件页不会有配置页入口——直接改 profile patch 即可。

共用同一个 `$DSH_HOME` 的两个 DSH app（便携版与桌面端指向同一个 `data` 目录）会解析同一份
profile patch，因此都会尝试绑定同一个 `listenPort`。用 `enabled: false`（或行级 `disabled: true`）
关掉其中一个，或者给两边配不同的 `listenPort`。

## 目录结构

```
dsh-remote-access-proxy/
├── package.json                      # bundle 清单：dsh.bundle.patch、icon、engines/peers
├── cordis.patch.yml                  # 本 bundle 插入的两行
├── plugin/
│   └── dsh-remote-access-proxy.mjs   # 宿主层网关（门禁 + 转发服务器）
├── ui/                               # 配置页（双面包）
│   ├── package.json                  # dsh.client 声明 + exports["./client"]
│   └── lib/{index.js,client.js}      # 宿主半（行锚点）+ 浏览器半（配置页）
├── config/cordis.patch.example.yml   # 脱敏的 profile patch 模板
├── locale/{en,zh}.json               # 插件页标题/描述词典
├── icon.svg                          # 插件页图标
├── test-remote-access-proxy.mjs      # mock DSH 端到端测试（31 项）
└── README.md / README.zh-CN.md
```

`access.log`（以及轮转出来的 `.1`…）是运行产物，永不入库。

## 为什么需要它

新版 DSH 对浏览器会话引入两级认证：

1. **Host/Origin 信任栅栏** —— `/api` 只接受回环 Host 或显式 `trustedHosts`，且 Origin 需同源；
2. **浏览器会话认证** —— 每次进程启动生成随机 `launchToken`
   （`http://127.0.0.1:3080/?token=…`）；无 `dsh-auth-*` 签名 Cookie 的 `/api` 一律 401。

本代理把请求以回环身份（Host 改写为 `127.0.0.1:3080`、剥离 Origin）转发给 DSH，
并**自行执行 token 交换、持有 `dsh-auth-*` Cookie**。远程用户只需要随机路径 +
HttpOnly Cookie 门禁，**永远看不到每次启动的 launchToken**。

## 安全模型

访问控制完全由代理的门禁承担：

- **随机路径** —— 入口是 `https://<IP>:<端口>/<secretPath>/`；
- **HttpOnly Cookie** —— 首次通过入口签发 `dsh_et_gate`
  （`Path=/; HttpOnly; SameSite=Strict`），之后整个 origin 放行。

建议开启 TLS（`tlsEnabled: true`）——`crypto.randomUUID` 需要安全上下文，明文 HTTP
会让 Web 客户端失效。证书加载失败会拒绝启动（fail-loud，不降级明文）。

## 配置

每个字段都是插件自己 Cordis `Config` 里的 `.volatile()` 字段，因此取值存放在活动 profile
的 `cordis.patch.yml` 中——可以在 `remote-access-proxy` 行的配置页里改（插件面板），
也可以把 [`config/cordis.patch.example.yml`](config/cordis.patch.example.yml) 手工并进
profile patch。`secretPath` / `cookieValue` 留空时首次启动自动生成并回写。

保存即写入 profile patch 并立即生效：插件**不会**被重新挂载，只是内嵌服务器带着新值重启。

| 字段 | 说明 |
|---|---|
| `enabled` | 关闭后停止监听 |
| `listenHost` | 监听地址（`0.0.0.0` = 全接口） |
| `listenPort` | 监听端口（默认 `13337`）|
| `secretPath` | 随机门禁路径（4–32 位） |
| `cookieValue` | 门禁 HttpOnly Cookie 值 |
| `upstreamHost` / `upstreamPort` | 上游 DSH（默认 `127.0.0.1:3080`） |
| `tlsEnabled` / `tlsPfxPath` / `tlsPassphrase` | 自签 TLS（pfx） |
| `logMaxBytes` / `logKeep` | `access.log` 轮转：写入将超过此大小就先轮转（默认 `1048576` = 1 MiB），保留这么多份旧文件（默认 `3`）。`logMaxBytes: 0` = 不轮转；`logKeep: 0` = 不留历史 |

入口：`https://<IP>:<端口>/<secretPath>/`（每设备接受一次自签证书警告）。

## 日志轮转

每次经过门禁的请求（`ENTRY` / `PASS` / `DENY`）、监听变化与 DSH 401 自愈都会追加到插件
旁边的 `access.log`（在 profile 的 `node_modules` 里）。放着不管它会无限增长，所以改成按大小轮转：

- 某行写入会把文件顶过 `logMaxBytes`（默认 1 MiB）时，先轮转再写；
- 写满的文件变成 `access.log.1`，更旧的顺移到 `access.log.2`……超过 `logKeep`（默认 `3`）的直接删除；
- 因此活动的 `access.log` 始终在阈值以内，整个环上限是 `logMaxBytes × (logKeep + 1)`。

`logMaxBytes: 0` 恢复"从不轮转"，`logKeep: 0` 则不留历史（每次轮转只是清空当前文件）。
两者都是普通配置字段，配置页或 profile patch 里都能改。

注意这些是**诊断日志而非审计流水**：启动行会记录门禁路径（`secret=…`），
所以这些日志文件应当和你的 profile 配置同等看待。

## 配置页

配置页是一个双面客户端包。浏览器半注册进插件页的 **`plugins.row.config`** 槽，
键为 `dsh-remote-access-proxy#remote-access-proxy`，并通过 `configForms` 客户端服务
读写配置——官方设置页同款的分阶段表单。它仅在宿主提供 `remote-access-proxy` 命名
空间时注册，因此从未组合该插件的部署不会看到任何痕迹。

## 从 0.3.0 迁移

DSH 0.1.7 移除了 `settings.yaml`，所以 0.3.0 在它上面加载不了。升级本身只是一次版本
前移 + 一次一次性导入：

1. **先升级 DSH**，再在 profile 目录里重跑
   `pnpm add github:citydirector/dsh-remote-access-proxy` 前移 pin，并 toggle 该 bundle。
2. **旧值会自动跟过来。** 升级后首次启动时，DSH 会把 `data/settings.yaml` 里的
   `remote-access-proxy:` 段导入 profile patch，并把该文件改名为 `settings.yaml.imported`。
   这次导入按 **profile entry id** 匹配——宿主行之所以叫 `remote-access-proxy` 就是为此；
   沿用旧行 id `dsh-remote-access-proxy` 的那一段会被拒绝。
3. **顺手看一眼日志。** 被组合拒绝的段只会记一条 warn，值仍留在改名后的文件里；在 DSH
   日志里搜 `settings: section … was not imported into entry` 即可确认。
4. **卡片换位置了。** 它不再是插件面板里的顶层卡片，而是该 bundle 的
   `remote-access-proxy` 行的配置页。

## 测试

```bash
pnpm install                      # 只需一次：插件要 import @deepseek-ai/schemastery
node test-remote-access-proxy.mjs # 默认加载它旁边的插件（已安装的 bundle 副本也行：
                                  # DSH_PLUGIN=/path/to/plugin.mjs）
# 期望：31 passed, 0 failed
```

它 mock 一个 DSH 上游（复刻 launchToken 交换 + `dsh-auth` Cookie 门禁），并 mock 插件
周围的 0.1.7 宿主契约——volatile Config 引用、`loader/volatile-update`、profile 配置
编辑器与页面策略调用——然后校验门禁放行/拒绝、Cookie 注入、token 剥离、303 Location
重写、401 自愈、WS 升级、`access.log` 轮转（阈值、环、关断开关）、生成值回写、
volatile 字段契约，以及 bundle/包布局（patch 行可解析到文件、元数据已打包、浏览器半
注册了行配置页且覆盖每个字段）。测试会快照/还原整个日志环，不留痕。
