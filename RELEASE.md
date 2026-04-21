# 发包/自动更新发布流程（GitHub Releases）

本项目已接入 **GitHub Releases 自动更新**（`electron-builder` + `electron-updater`）。

- **触发方式**：push 一个 `vX.Y.Z` tag（例如 `v0.1.1`）
- **构建方式**：GitHub Actions 在 **macOS + Windows** 上构建并上传到本仓库的 Releases
- **客户端更新**：已安装的 App 启动后会自动检查更新，下载后提示重启安装

> 提示：自动更新只对「安装版/打包版」生效；`npm start` 的开发模式不会走自动更新。

---

## 0. 你需要准备什么

### 0.1 GitHub Actions 权限

本仓库已包含工作流：`.github/workflows/release.yml`，并设置：

- `permissions: contents: write`（允许上传 Release 资产）
- 使用内置 `secrets.GITHUB_TOKEN` 发布（无需你手动配置 token）

### 0.2 （可选）设置默认管理员密码（推荐）

`proxy-service` 打包时支持把 `.env` 打进安装包（用于默认管理员密码）。

最推荐的方式：在 GitHub 仓库里配置 Actions Secret：

1) GitHub 仓库 → `Settings` → `Secrets and variables` → `Actions`
2) 新建 `Repository secret`
3) 名称：`PROXY_ADMIN_PASSWORD`
4) 值：你的管理员密码

之后每次打包，workflow 会写入 `.env` 并由构建脚本打包进 `build/bundled.env`。

如果你不配置这个 secret：打包后的首次启动会自动生成临时管理员密码（并弹窗提示）。

### 0.3 本地工具（可选）

如果你想本地手动发包（不用 Actions），需要：

- Node.js 20+
- 本机可访问 GitHub
- GitHub Token（classic PAT，建议勾选 `repo`）并设置环境变量 `GH_TOKEN`

macOS / Linux：

```bash
export GH_TOKEN="xxxxxxxx"
```

Windows PowerShell：

```powershell
$env:GH_TOKEN="xxxxxxxx"
```

---

## 1. 标准推荐：用 GitHub Actions 发包（只需要 push tag）

下面是「一次发一个新版本」的完整命令序列。

### 1.1 确认当前版本号

```bash
cd /Users/wen/work/google-flow/proxy-service
node -p "require('./package.json').version"
```

### 1.2 修改版本号（必须递增）

示例：发 `0.1.1`

```bash
cd /Users/wen/work/google-flow/proxy-service
npm pkg set version="0.1.1"
```

### 1.3 提交版本号变更

```bash
cd /Users/wen/work/google-flow/proxy-service
git add package.json package-lock.json
git commit -m "release: 0.1.1"
git push origin main
```

### 1.4 打 tag 并推送 tag（这一步会触发 GitHub Actions）

**重要规则**：tag 必须等于 `v<package.json version>`，例如 `version=0.1.1` → tag=`v0.1.1`

```bash
cd /Users/wen/work/google-flow/proxy-service
git tag v0.1.1
git push origin v0.1.1
```

### 1.5 观察构建结果

1) 打开 GitHub 仓库 → `Actions`  
2) 找到 `release` workflow（本次 tag 触发）  
3) 等待 `macos-latest` 与 `windows-latest` 两个 job 都成功

### 1.6 你应该在 Releases 里看到什么（验收清单）

仓库 → `Releases` → 对应 `v0.1.1` release 中，通常会包含：

- macOS：`.dmg`、`.zip`、`latest-mac.yml`、`*.blockmap`
- Windows：`*Setup*.exe`（NSIS 安装包）、`latest.yml`、`*.blockmap`

---

## 2. 验证自动更新是否工作（真实场景）

### 2.1 安装旧版本

1) 从 Releases 下载旧版本安装包（例如 `v0.1.0`）
2) 安装并启动一次，确认能正常打开

### 2.2 发布新版本

按第 1 章发布 `v0.1.1`。

### 2.3 用旧版本打开 App

启动旧版本 App（仍是旧安装版）：

- 启动后会自动检查更新
- 有更新则自动下载
- 下载完成弹窗提示「立即重启」→ 重启后即更新到新版本

---

## 3. 本地手动发包（不推荐，仅用于紧急/调试）

> 这会直接把构建产物发布到 GitHub Releases；建议只在你熟悉流程后使用。

macOS 上：

```bash
cd /Users/wen/work/google-flow/proxy-service
npm ci
npm run dist -- --publish always
```

Windows 上：

```bash
cd /Users/wen/work/google-flow/proxy-service
npm ci
npm run dist -- --publish always
```

---

## 4. 常见问题/排障

### 4.1 为什么我 `npm start` 看不到自动更新？

自动更新只在打包后（`app.isPackaged === true`）启用；开发模式不会。

### 4.1.1 为什么 macOS Release 只有 dmg 也不更新？

macOS 的自动更新依赖 `latest-mac.yml` + `.zip`（由构建流程自动上传）。`dmg` 主要用于“首次安装”，不是自动更新的数据源。

### 4.2 为什么客户端没发现新版本？

逐项检查：

1) 是否真的发了新版本（`package.json version` 递增）  
2) tag 是否严格匹配（例如 `v0.1.1`）  
3) GitHub Release 是否是 **非 draft、非 prerelease**  
4) `Actions` 是否两个平台都构建成功（缺一个平台资产可能影响该平台更新）

### 4.3 macOS 更新被系统拦截怎么办？

如果后续你要面向更多机器分发，建议加：

- macOS 签名（Developer ID）
- 公证（notarize）

否则有概率在「更新后」被 Gatekeeper 阻止运行。

---

## 5. 开关（可选）

关闭自动更新检查：

```bash
PROXY_AUTO_UPDATE=0
```
