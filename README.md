# 代理管理服务（框架）

这是一个运行在本机的“代理管理服务”，为 `Flow 多账号管理器` 提供一个统一的代理获取接口。

## 启动

在仓库根目录：

```bash
cd proxy-service
npm install
npm start
```

`npm start` 会直接启动桌面软件（Electron），并在后台启动内置服务。

如需只启动服务端（不打开桌面窗口）：

```bash
npm run start:server
```

默认监听（服务端模式）：`http://0.0.0.0:3123`（所有网卡）。本机访问请用 `http://127.0.0.1:3123`。

## 管理员登录（必配）

管理页面与管理接口需要管理员登录（session cookie）。

在管理员机器上建议设置：

- `PROXY_ADMIN_PASSWORD=你的管理员密码`
- `PROXY_ADMIN_SESSION_SECRET=随机长字符串（用于签名 session）`

配置位置：

- 开发/源码运行：`proxy-service/.env`
- 打包后（dmg/exe）：`<userData>/.env`（macOS: `~/Library/Application Support/Flow 代理管理服务/.env`；Windows: `%APPDATA%\\Flow 代理管理服务\\.env`）

### 打包时“内置 .env”（按你当前 .env 固定密码）

如果你希望 `npm run dist` 打出的安装包**默认就使用你当前仓库里的 `proxy-service/.env`**（不需要另外去 userData 放一份），本项目会在打包前把 `proxy-service/.env` 复制到 `proxy-service/build/bundled.env` 并随安装包一起内置。

运行时加载优先级：

1) `<userData>/.env`（你可以用它覆盖内置配置）
2) 内置的 `build/bundled.env`（来自打包时的 `proxy-service/.env`）

注意：这会把管理员密码打进安装包文件里（适合内网工具，但不适合公开分发）。

可选：

- `PROXY_ADMIN_SESSION_TTL_SEC=43200`（默认 12 小时）
- `PROXY_ADMIN_COOKIE_PERSIST=1`（默认是 session cookie：关闭浏览器即失效；设为 1 则持久化）
- `PROXY_ADMIN_COOKIE_SECURE=1`（仅在 HTTPS 下建议开启）

## 前端页面（代理池配置）

启动后直接打开：

- `http://127.0.0.1:3123/`

可以在页面里维护“代理池”：添加/启用/删除/标签，并支持“随机测试”。

## 管理后台（账号/设备）

- 节点管理（机场订阅）：`http://127.0.0.1:3123/nodes.html`
- 账号仓库：`http://127.0.0.1:3123/accounts.html`
- 激活码：`http://127.0.0.1:3123/codes.html`
- 设备管理：`http://127.0.0.1:3123/admin.html`

首次打开会跳转到登录页 `http://127.0.0.1:3123/login.html`，输入管理员密码后才能进入。

提示：页面已内置导航栏，可在“代理池 / 账号仓库 / 激活码 / 设备管理”之间切换。

## API（v1）

- 健康检查：`GET /health`
- 管理登录：`POST /auth/login`（body: `{ password }`，成功后写入 HttpOnly cookie）
- 管理退出：`POST /auth/logout`

管理接口（需要管理员 session cookie）：

- 查看存储：`GET /v1/store`
- 获取某个账号的代理：`GET /v1/proxy/:profile`
- 设置某个账号的静态代理：`PUT /v1/proxy/:profile`
- 删除某个账号的静态代理：`DELETE /v1/proxy/:profile`
- 代理池列表：`GET /v1/pool`
- 添加到代理池：`POST /v1/pool`
- 从 URL 拉取并加入代理池：`POST /v1/pool/fetch`
- 更新代理池项：`PUT /v1/pool/:id`
- 删除代理池项：`DELETE /v1/pool/:id`
- 随机取一个代理：`GET /v1/pool/random`
- 启动浏览器登录并保存账号：`POST /v1/admin/capture/start`（body: `{ profile }`）
- 完成保存：`POST /v1/admin/capture/finish/:id`
- 取消并关闭浏览器：`POST /v1/admin/capture/cancel/:id`

## 激活与账号分发（框架）

该服务同时作为“控制面”：

- 客户端激活：`POST /v1/client/activate`（machineId + activationCode → token）
- 客户端拉取分配账号列表：`GET /v1/client/profiles`（Bearer token）
- 客户端拉取某账号 storageState：`GET /v1/client/profiles/:profile`（Bearer token）
- 客户端获取某账号代理：`GET /v1/client/proxy/:profile`（Bearer token，且 profile 必须已分配给该机器码）
  - 优先返回 `proxy`（HTTP/SOCKS，Playwright 可直接使用）
  - 如代理池为空且存在启用节点（`vless://` / `hysteria2://`），会返回 `node`（含 `fullLink`），需要客户端用 sing-box/Clash 落地后再供 Playwright 使用

管理端（管理员登录后使用）：

- 生成激活码：`POST /v1/admin/codes`
- 查看激活码：`GET /v1/admin/codes`
- 查看机器列表：`GET /v1/admin/machines`
- 设置机器分配：`PUT /v1/admin/machines/:machineId`
- 账号仓库：`GET/PUT/DELETE /v1/admin/accounts(/:profile)`

### 代理格式（支持多种）

写入或上游返回时支持：

- `"ip:port"`
- `"http://ip:port"` / `"socks5://ip:port"`
- `{ "server": "http://ip:port", "username": "...", "password": "..." }`
- `{ "host": "ip", "port": 7890, "protocol": "http", "username": "...", "password": "..." }`

## 存储

默认写入：

- 开发/服务端模式（`npm run start:server`）：`proxy-service/data/proxies.json`
- 桌面应用模式（Electron/打包后）：`<userData>/data/proxies.json`

可用环境变量覆盖：

- `PROXY_SERVICE_STORE=/abs/path/to/proxies.json`
- `PROXY_SERVICE_DATA_DIR=/abs/path/to/data`（可选：修改 data 目录，默认会自动选择）
- `PROXY_SERVICE_ACCOUNTS_DIR=/abs/path/to/accounts`（可选：账号仓库目录）

说明：打包后（dmg/exe）应用资源目录是只读的，因此默认会把可写数据放到 `userData`（macOS: `~/Library/Application Support/Flow 代理管理服务/`；Windows: `%APPDATA%\\Flow 代理管理服务\\`）。

## 打包发布（DMG / EXE）

在 `proxy-service/` 目录执行：

```bash
npm install
npm run dist
```

- macOS：生成 `proxy-service/dist/*.dmg`
- Windows：生成 `proxy-service/dist/*.exe`（NSIS 安装器）

提示：通常需要在对应系统上构建对应产物（mac 上出 dmg，win 上出 exe）。

## 上游（预留）

设置环境变量 `PROXY_UPSTREAM_URL` 后，当某个 profile 没有静态代理映射时，会调用上游接口获取：

- `PROXY_UPSTREAM_URL=https://example.com/getProxy`
- 服务会追加 query 参数：`?profile=<profileName>`

超时：`PROXY_UPSTREAM_TIMEOUT_MS`（默认 3500ms）

## 工具：机场订阅解析（vless/hysteria2）

有些“机场订阅链接”返回的是 Base64（或 Base64URL）编码文本，内容为多行节点链接（例如 `vless://...` / `hysteria2://...`）。

在 `proxy-service/` 目录下运行：

```bash
node decode-sub.js "https://你的订阅链接"
```

或：

```bash
npm run decode-sub -- "https://你的订阅链接"
```
