# 本机安装初始化指南 (macOS)

本文档面向 fork 维护者，说明如何在一台新 Mac 上从零配置 claude-mem 开发与运行环境。

## 前置条件

- macOS（当前只支持 macOS 的 launchd 定时维护）
- Node.js >= 18
- Git
- 网络代理可用（GitHub 访问需要）

## 安装方式

### 方式一：npm 一键安装（推荐）

```bash
npx @cee0503/claude-mem install
```

这会自动完成插件文件复制、依赖安装、marketplace 注册、launchd 维护注册。

### 方式二：从源码构建安装（开发者）

```bash
# 1. 克隆 fork 仓库
https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  git clone https://github.com/Dee-0503/claude-mem.git ~/代码项目/claude-mem
cd ~/代码项目/claude-mem

# 2. 安装依赖
bun install

# 3. 构建并同步到本地插件目录
npm run build-and-sync
```

`build-and-sync` 会：
1. 构建 hooks 和 plugin 脚本
2. rsync 到 `~/.claude/plugins/marketplaces/thedotmack/`
3. 同步到 cache 目录 `~/.claude/plugins/cache/thedotmack/claude-mem/<version>/`
4. 重启 worker 服务

## 确认插件指向 fork 仓库

确保 `~/.claude/plugins/known_marketplaces.json` 中的 `thedotmack` 条目指向你的 fork：

```json
"thedotmack": {
    "source": {
        "source": "github",
        "repo": "Dee-0503/claude-mem"
    },
    "autoUpdate": true
}
```

Claude Code 会根据 `autoUpdate: true` 自动从 GitHub 拉取最新代码。

## 注册 launchd 定时维护

`npx @cee0503/claude-mem install` 会自动注册。如需手动操作：

```bash
npx @cee0503/claude-mem maintenance install
```

注册两个 launchd agent：

| Agent | 功能 | 频率 |
|-------|------|------|
| `com.claude-mem.scheduled-maintenance` | 每日定时重启 worker | 每天 04:00 |
| `com.claude-mem.health-check` | 健康检查 + 自动恢复 | 每小时 |

验证：

```bash
npx @cee0503/claude-mem maintenance status
launchctl list | grep claude-mem
```

### 健康检查会做什么

- worker 无响应 → 自动重启
- 初始化卡死超过 5 分钟 → 自动重启
- 最后交互超过 48 小时 → 自动重启
- failed pending_messages 超过 30 条 → 归档 + 清理 + 重启

### 定时维护会做什么

- 等待网络就绪（睡眠唤醒后）
- 优雅停止 worker（SIGTERM → 5s → SIGKILL）
- 启动新 worker
- 轮询验证 `initialized && mcpReady`
- 每天只执行一次

### 卸载

```bash
npx @cee0503/claude-mem maintenance uninstall
```

## 确认 worker 运行正常

```bash
npx @cee0503/claude-mem status
curl -s http://127.0.0.1:37777/api/health | python3 -m json.tool
```

## 清理旧脚本（如有）

如果之前手动配置过 crontab、launchd 或 apply-patches，需要清理：

```bash
# 移除旧 crontab
crontab -l | grep -v "claude-mem/health-check.sh" | crontab -

# 移除旧 launchd
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ceemac.claude-mem-restart.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.ceemac.claude-mem-restart.plist

# 移除 apply-patches hook（如果 settings.json 中有）
# 删除 SessionStart hooks 中的 "bash ~/.claude-mem/apply-patches.sh" 条目

# 归档旧脚本
mkdir -p ~/.claude-mem/archived-scripts
mv ~/.claude-mem/scheduled-restart.sh ~/.claude-mem/health-check.sh ~/.claude-mem/apply-patches.sh ~/.claude-mem/archived-scripts/ 2>/dev/null
```

> **注意：** `apply-patches.sh` 已完全过时。它修补的 MCP schema 和冷启动问题已在上游 v12.3.x 中修复并合入我们的 fork。不再需要运行时 patch。

## 自动更新机制

本 fork 有三层自动更新：

### 1. Claude Code 自动更新（GitHub → 本机）
`known_marketplaces.json` 中 `autoUpdate: true` 让 Claude Code 定期从 GitHub 拉最新代码到本地插件目录。

### 2. 上游自动同步（upstream → fork GitHub）
`Ceemac Upstream Sync` workflow 每 6 小时自动运行：
- 上游有新代码且能自动合并 → 创建 PR → CI 通过后自动合并
- 上游有新代码但有冲突 → 创建标记冲突的 PR → GitHub 邮件通知你手动解决
- 上游无变化 → 跳过

### 3. npm 自动发布（fork GitHub → npm）
main 分支 `package.json` 版本变更时，GitHub CI 自动发布到 npm。需要在仓库 Settings > Secrets 中设置 `NPM_TOKEN`。

## CI 邮件提醒

PR 的 CI 检查非全绿时，通过 Resend 发邮件提醒。需要设置以下 GitHub Secrets：
- `CI_ALERT_EMAIL`
- `RESEND_API_KEY`
- `RESEND_FROM`

## 日常操作速查

| 操作 | 命令 |
|------|------|
| 安装/更新 | `npx @cee0503/claude-mem install` |
| 启动 worker | `npx @cee0503/claude-mem start` |
| 停止 worker | `npx @cee0503/claude-mem stop` |
| 重启 worker | `npx @cee0503/claude-mem restart` |
| 查看状态 | `npx @cee0503/claude-mem status` |
| 搜索记忆 | `npx @cee0503/claude-mem search <关键词>` |
| 维护状态 | `npx @cee0503/claude-mem maintenance status` |
| 手动健康检查 | `npx @cee0503/claude-mem maintenance health-check` |
| 手动定时维护 | `npx @cee0503/claude-mem maintenance scheduled` |
| 本地构建同步 | `npm run build-and-sync` |
| 查看 worker 日志 | `npm run worker:logs` |
| 查看维护日志 | `cat ~/.claude-mem/logs/maintenance-health.log` |

## GitHub Secrets 清单

| Secret | 用途 |
|--------|------|
| `NPM_TOKEN` | npm 自动发布 |
| `CI_ALERT_EMAIL` | CI 邮件提醒收件地址 |
| `RESEND_API_KEY` | Resend 邮件 API |
| `RESEND_FROM` | Resend 发件地址 |

## 换机迁移

在新 Mac 上只需：

```bash
npx @cee0503/claude-mem install
```

所有能力（hooks、维护、健康检查、launchd）会自动配置，无需额外操作。
