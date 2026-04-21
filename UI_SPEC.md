# Inspiration Pack · Proxy Service（代理池配置 UI）

目标：做一个“表格为主、操作密度高、错误可见”的内部配置台；包含两个页签（代理池 / 设备管理），并用同一套 tokens + 组件保持一致性（适合后续打包为 exe/dmg 的内网工具）。

## Reference Set（8–12 个参考拆解）

> 不照抄整站，只提炼可复用规则（table density / toolbar / chips / empty states / inline edit）。

1) **shadcn/ui · Data Table patterns**
   - 借用点：顶部 toolbar（搜索 + 过滤）+ table sticky header + inline actions；状态 chips 低干扰
2) **Flowbite / Preline · Admin table**
   - 借用点：表格 hover 轻微底色、行操作按钮收敛在右侧；移动端横向滚动容器
3) **Every Layout · Sidebar / Cluster**
   - 借用点：左侧“输入/导入”与右侧“列表/表格”两栏，窄屏自动变 1 栏
4) **web.dev patterns · repeat(auto-fit, minmax)**
   - 借用点：统计 chips 使用 cluster 自动换行，避免拥挤
5) **MDN Layout cookbook · Table + sticky header**
   - 借用点：sticky header 与滚动容器配合，保持上下文可见
6) **SaaS settings pages（Refero/Screenlane 常见结构）**
   - 借用点：危险操作（批量删除/清理）单独归组，颜色更克制
7) **Console UIs（NOC/ops dashboards）**
   - 借用点：状态 pill + LED，服务健康感知强；提示信息用 inline status 替代弹窗
8) **现代表单样式**
   - 借用点：输入 focus ring 明确但不过亮；textarea 用 monospace 适配批量粘贴

## Layout Blueprint（App / Dashboard · A2 列表/表格页）

- Page type: `Dashboard / Settings`
- Container: `max-width: 1240px`, gutters `16px`, text line length `<= 90ch`
- Grid:
  - `lg`: 2 cols（左 420px 固定、右自适应）
  - `sm`: 1 col
- Pages:
  - **代理池页**：维护代理池、静态代理与拉取 URL
  - **设备管理页**：生成激活码、上传账号 JSON、分配机器允许的 profiles
- Shared shell:
  1. Topbar（goal: 状态/说明 + 主操作）
  2. Nav pills（goal: 在“代理池 / 设备管理”间切换）
  3. Two-column grid（goal: 左侧输入/动作，右侧列表/表格）
- Primary user path:
  1) 粘贴代理 → 2) 添加到池 → 3) 启用/命名 → 4) 随机测试 → 5) Flow 侧调用生效

## Tokens（可直接落地的 CSS Variables）

```css
:root{
  --bg0:#f6f7f3; --bg1:#f1f3ee;
  --panel:rgba(255,255,255,.86); --panel2:rgba(255,255,255,.72);
  --ink:#16201b; --ink2:rgba(22,32,27,.74); --ink3:rgba(22,32,27,.54);
  --line:rgba(23,29,26,.12); --line2:rgba(23,29,26,.18);
  --accent:#1f8a70; --accent2:#2aa39a;
  --good:#1f8a70; --warn:#9a6b16; --bad:#b43b3b;
  --r:18px; --r2:14px;
  --shadow:0 22px 48px rgba(12,18,14,.12);
  --shadow2:0 10px 18px rgba(12,18,14,.08);
}
```

## Component Checklist（页面组件清单）

- Topbar
  - Brand title + short explainer
  - Status pill（LED + text）
- Add Panel（左）
  - Multiline textarea（monospace）
  - Primary action button + secondary clear
  - Chips：store path / pool count / enabled count
  - Inline status box（success/warn/error）
  - `<details>`：静态代理（profile + proxy + set/delete）
- Table Panel（右）
  - Search input
  - Filter button（只看启用）
  - “清理禁用”危险操作
  - Sticky header + scroll container
  - Row:
    - enabled toggle switch（即时保存）
    - proxy server tag（mask credentials）
    - label inline edit（debounced save）
    - actions：copy / delete
  - Empty state（无匹配/空池）

- **Device 管理页（设备管理）**
  - Card：激活码（生成 + 列表）
  - Card：账号仓库（上传/更新/删除 + 文件导入 + 列表）
  - Full-width Card：机器分配（选择 machineId + 编辑 allowedProfiles + 保存）

## Interaction Rules（交互规则）

- 所有反馈走 inline status（不要 alert）
- 输入聚焦：4px 柔和 ring；按钮 hover 仅 1px 上浮
- 表格 hover：轻微底色，不用强边框
- 动效：默认 120–180ms，尊重 `prefers-reduced-motion`

## Do / Don’t（快速自检）

- Do：表格是主角，操作“就地完成”（toggle / label / copy）
- Do：危险操作按钮必须单独且低频出现（如“清理禁用”）
- Do：任何失败必须可见且可恢复（refresh/重试）
- Don’t：不要把“炫背景”做成信息噪音；避免对比度不足
- Don’t：不要把 proxy 密码直接展示（UI 永远只显示 `***`）

## 实现落点（代码组织）

- Shared tokens/components：`proxy-service/public/app.css`
- Pages：
  - `proxy-service/public/index.html`（代理池）
  - `proxy-service/public/admin.html`（设备管理）
