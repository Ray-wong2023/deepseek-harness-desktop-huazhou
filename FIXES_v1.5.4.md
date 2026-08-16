# DeepSeek Desktop 修复记录（v1.5.4，2026-08-16）

## Bug 1：新创建的项目没有在工作区显示 ✅ 已修复
**根因**（`src/renderer/app.js` `renderSessionList()`）：
```js
// 旧代码：空项目（无会话）被过滤，新建项目立即"消失"
if (items.length) groups.push({ project: p, items });
```
新建项目没有任何会话 → 不满足 `items.length` → 不渲染 → 工作区看不到。

**修复**：空项目也加入分组渲染，并显示"（暂无对话）"占位；项目创建后立即可见。

**附带修复**：新建项目路径原来硬编码 `D:\deepseek harness`，与主进程工作区 `C:\Users\gylcl\Documents\deepseek harness` 不一致（目录错位）。现改为从主进程 `app:info` 获取 workspace，统一创建位置。

## Bug 2：新建项目无法删除、无删除安检 ✅ 已修复
**根因**：Bug 1 导致项目不可见 → 侧边栏没有删除按钮入口 → "无法删除"。
**修复**：项目可见后删除入口（🗑 按钮）自动出现，确认框安检（customConfirm）原本存在且已加固：
- 删除确认文案增加项目**路径**，让用户清楚删除对象
- 危险操作（删除）确认框**默认焦点在"取消"**，防止误按 Enter 直接删除

## Bug 3：删除确认框一闪而过 ✅ 已修复（customConfirm 加固）
**根因分析**：确认框用原生 DOM modal，易被双击残留事件 / Enter 键（50ms 后焦点在"确定"上，用户按 Enter 立即确认删除）瞬间关闭，表现为"一闪而过"。

**修复**（`customConfirm` 全面加固）：
1. **单例锁**：同一时间只允许一个确认框，防止叠加/竞态
2. **250ms 防抖**：弹出后 250ms 内忽略背景点击与键盘事件（防双击误触关闭）
3. **焦点安全**：danger 操作默认聚焦"取消"；正常操作聚焦"确定"
4. **Escape 捕获阶段监听**：确保页面快捷键不吞掉 Escape
5. **事件完整清理**：keydown/unload 监听器在关闭时移除，无泄漏

## Bug 4：任务栏固定后，运行框与软件折叠在一起 ✅ 已修复（配置层 + 窗口层）
**根因**：
- 你运行的 `DeepSeek-Desktop-1.5.2-portable` 是 **portable（便携）模式**：每次启动自解压到临时目录运行，任务栏"固定"指向原始 exe 路径 → 任务栏按钮与运行中窗口分组异常（出现"折叠/重叠"的两个入口）。这是 portable 模式的固有问题。
- 窗口恢复逻辑缺少置顶处理。

**修复**：
1. **打包配置**：新增 **NSIS 安装版**目标（`npm run dist:installer`）。安装版有固定安装路径，任务栏固定可靠，点击图标正常聚焦单窗口。安装版会创建桌面/开始菜单快捷方式。
2. **窗口层加固**（`src/main.js` `second-instance`）：点击任务栏图标唤起已运行实例时，依次 restore（最小化则还原）→ show（不可见则显示）→ **moveTop()（置顶，防止被任务栏边缘/其他窗口遮挡）**→ focus。

## 验证状态
- ✅ 三个 JS 文件语法检查通过（node --check）
- ✅ 应用可正常启动（当前机器上有正在运行的实例，single-instance lock 行为正常）
- ⚠️ GUI 交互验证需你关闭旧实例后操作

## 如何验证/部署
```powershell
cd deepseek-desktop
npm start            # 开发模式运行（需先关闭正在运行的实例）
npm run dist         # 重新打包 portable 版
npm run dist:installer  # 打包 NSIS 安装版（推荐，解决任务栏固定问题）
```
