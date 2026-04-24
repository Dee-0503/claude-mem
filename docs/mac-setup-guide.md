# 本机安装初始化指南 (macOS)

本文档面向 fork 维护者，说明如何在一台新 Mac 上从零配置 claude-mem 开发与运行环境。

## 前置条件

- macOS（当前只支持 macOS 的 launchd 定时维护）
- Node.js >= 18
- Git
- 网络代理可用（GitHub 访问需要）

## 一、克隆 fork 仓库

```bash
https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
  git clone https://github.com/Dee-0503/claude-mem.git ~/代码项目/claude-mem
cd ~/代码项目/claude-mem
```

## 二、安装依赖

```bash
bun install
```

如果 bun 未安装，项目的 `smart-install.js` 会在首次 hook 触发时自动安装。也可以手动装：

```bash
curl -fsSL https://bun.sh/install | bash
```

## 三、构建并同步到本地插件目录

```bash
npm run build-and-sync
```

这会：
1. 构建 hooks 和 plugin 脚本
2. rsync 到 `~/.claude/plugins/marketplaces/thedotmack/`
3. 同步到 cache 目录 `~/.claude/plugins/cache/thedotmack/claude-mem/<version>/`
4. 重启 worker 服务

## 四、确认插件指向 fork 仓库

安装目录应指向你的 fork，而不是 upstream：

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
git remote set-url origin https://github.com/Dee-0503/claude-mem.git
git remote -v
# 应显示：origin  https://github.com/Dee-0503/claude-mem.git
```

## 五、注册 launchd 定时维护

项目内置了 macOS launchd 自动注册能力：

```bash
npx claude-mem maintenance install
```

这会注册两个 launchd agent：

| Agent | 功能 | 频率 |
|-------|------|------|
| `com.claude-mem.scheduled-maintenance` | 每日定时重启 worker | 每天 04:00 |
| `com.claude-mem.health-check` | 健康检查 + 自动恢复 | 每小时 |

验证：

```bash
npx claude-mem maintenance status
# Scheduled maintenance: installed
# Hourly health check:   installed

launchctl list | grep claude-mem
# 应显示两个 agent
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
npx claude-mem maintenance uninstall
```

## 六、确认 worker 运行正常

```bash
npx claude-mem status
curl -s http://127.0.0.1:37777/api/health | python3 -m json.tool
```

## 七、清理旧的手动脚本（如有）

如果之前手动配置过 crontab 或 launchd，需要清理：

```bash
# 移除旧 crontab
crontab -l | grep -v "claude-mem/health-check.sh" | crontab -

# 移除旧 launchd
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ceemac.claude-mem-restart.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.ceemac.claude-mem-restart.plist

# 归档旧脚本
mkdir -p ~/.claude-mem/archived-scripts
mv ~/.claude-mem/scheduled-restart.sh ~/.claude-mem/health-check.sh ~/.claude-mem/archived-scripts/ 2>/dev/null
```

## 八、CI 自动同步上游

fork 仓库配有 `Ceemac Upstream Sync` workflow（每 6 小时自动运行）：

- 上游有新代码且能自动合并 → 创建 PR → CI 通过后自动合并
- 上游有新代码但有冲突 → 创建标记冲突的 PR → GitHub 邮件通知你手动解决
- 上游无变化 → 跳过

## 日常操作速查

| 操作 | 命令 |
|------|------|
| 启动 worker | `npx claude-mem start` |
| 停止 worker | `npx claude-mem stop` |
| 重启 worker | `npx claude-mem restart` |
| 查看状态 | `npx claude-mem status` |
| 搜索记忆 | `npx claude-mem search <关键词>` |
| 维护状态 | `npx claude-mem maintenance status` |
| 手动健康检查 | `npx claude-mem maintenance health-check` |
| 手动定时维护 | `npx claude-mem maintenance scheduled` |
| 本地构建同步 | `npm run build-and-sync` |
| 查看 worker 日志 | `npm run worker:logs` |
| 查看维护日志 | `cat ~/.claude-mem/logs/maintenance-health.log` |

## 换机迁移清单

在新 Mac 上只需执行步骤一到六。所有能力（hooks、维护、健康检查）会自动恢复，无需额外配置。
