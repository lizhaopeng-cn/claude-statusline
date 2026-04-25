# claude-statusline

为 [Claude Code](https://claude.com/claude-code) 和 [claude-code-router (CCR)](https://github.com/musistudio/claude-code-router) 写的自定义状态栏脚本。

在 Claude Code 底部多画几行，显示：工作目录 / git 分支 / 当前模型 / 上下文占用 / input & output tokens / OpenRouter 账号余额 / 会话成本。

---

## 输出样式

**CCR 路径（`ccr code`，用 `ccr-append.js`）** —— 4 行：

```
 xtuul  main 󰚩 claude-4.7-opus
󰉍 58% ↑ 104 ↓ 60 ⚡ 0t/s 💰 $0.44 ⏱ 9m21s
openrouter: $286.15 / $500    openrouter1: $0.27 / $0.50
tokens: 116.0k / 200.0k (58%)
```

| 行 | 内容 |
|---|---|
| L1 身份 | 工作目录 · git 分支 · 当前模型 |
| L2 运行时 | 上下文占用% · 本次请求 ↑in ↓out · 速度 · 会话成本 · 会话时长 |
| L3 预算 | 每个 OpenRouter key 的累计花费 / 限额 |
| L4 tokens | 上下文窗口占用（按 `contextPercent × 总窗口` 反推） |

**bare Claude Code（`claude`，用 `statusline.ts`）** —— 3 行：

```
OpenRouter: claude-4.7-opus - $0.4447 - cache discount: $0.00  usage tracking: up-to-date
budget: $286.15 / $500
tokens: 116.0k / 200.0k (58%)
```

---

## 文件

| 文件 | 作用 |
|---|---|
| `ccr-append.js` | CCR 专用。被 CCR 的 `StatusLine.default.modules` 里的 `type:"script"` 模块加载。CCR 会把运行时变量（workDirName/gitBranch/model/inputTokens/outputTokens/contextPercent/cost/duration/...）作为参数传进来，脚本返回一个字符串给 Claude Code。 |
| `statusline.ts` | bare claude 专用（不走 CCR 时）。通过 stdin 读 `{session_id, transcript_path, context_window}`，从 transcript 里抓所有 `gen-*` ID 去 OpenRouter `/api/v1/generation` 查每次请求的真实 cost，按 session 累加。 |
| `statusline.sh` | `statusline.ts` 的 shell wrapper，用 `npx tsx` 启动 TS。 |

---

## 安装与接线

### 1. 克隆本仓库

```bash
git clone https://github.com/lizhaopeng-cn/claude-statusline.git ~/.claude/scripts/claude-statusline
chmod +x ~/.claude/scripts/claude-statusline/statusline.sh
```

### 2. 接到 bare Claude Code（用 `statusline.ts`）

编辑 `~/.claude/settings.json`：

```json
{
  "statusLine": {
    "type": "command",
    "command": "/Users/你/.claude/scripts/claude-statusline/statusline.sh"
  }
}
```

需要环境变量：`ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY` 设为你的 OpenRouter API key（脚本会拿来调 `/api/v1/generation` 和 `/api/v1/auth/key`）。

### 3. 接到 CCR（用 `ccr-append.js`）

编辑 `~/.claude-code-router/config.json`，让 `StatusLine.default.modules` 只留一个 `type:"script"` 模块：

```json
{
  "StatusLine": {
    "enabled": true,
    "currentStyle": "default",
    "default": {
      "modules": [
        {
          "type": "script",
          "scriptPath": "/Users/你/.claude/scripts/claude-statusline/ccr-append.js"
        }
      ]
    }
  }
}
```

CCR 会在每次状态栏刷新时 `require()` 这个脚本、把当前运行时 `variables` 对象传进来、把返回字符串喂给 Claude Code。

> **为什么不用 CCR 自带的 10-module 配置？** CCR 的内置渲染器 `k8()` 对多个 `type:"default"` module 做 `join(" ")`，丢 ANSI 颜色序列也不做宽度截断。换成单个 `type:"script"` 模块后，所有渲染（颜色 + 宽度截断 + 多行）都由 `ccr-append.js` 自己管，CCR 不参与。

---

## 已知限制：多行状态栏在窄终端会被截断

Claude Code 2.1.119 的 statusLine 渲染外层是 `<Text wrap="truncate">`（Ink 5）。**Ink 的 `truncate` 模式遇到 `\n` 会把后续行整段丢掉**，所以：

- **宽终端**：4 行 / 3 行全部显示。
- **窄终端**：只能看到第 1 行，L2/L3/L4 被 Ink 吞掉。

这是 Claude Code 渲染侧的约束，脚本层面没法绕过。脚本已经对每一行独立按 `COLUMNS` 做 `…` 截断，所以宽终端下每行都不会溢出；窄终端下只能看到 L1 是"权衡后的妥协"，不是 bug。

---

## 状态栏字段与数据源

### CCR 路径（`ccr-append.js`）

CCR 会把下列字段作为 `variables` 对象传给脚本（字段名和类型实测而来，不同 CCR 版本可能有差异）：

```
workDirName        "xtuul"
gitBranch          "main"
model              "anthropic/claude-4.7-opus-20260416"  ← 上一次请求路由后的模型
inputTokens        "104.9k"   ← 上一次请求 input（含义在不同 CCR 版本间摇摆）
outputTokens       "275"
cacheReadInputTokens / cacheCreationInputTokens  ← 有的版本会传
contextPercent     "52"       ← Claude Code 给的「当前窗口占用%」，最可靠
contextWindowSize  "200k" | "1000k"
totalInputTokens   "3530.5k"  ← 整个 session 所有请求累加
totalOutputTokens  "154.6k"
cost               "$22.78"
duration           "1448m4s"
tokenSpeed         "0"
sessionId          "5d8e8ea1"
version            "2.1.119"
```

想实际看一次？把 `ccr-append.js` 里的 `const DEBUG_DUMP = false` 改成 `true`，每次状态栏刷新都会把 `variables` 追加到 `/tmp/ccr-append-debug.log`。

### bare claude 路径（`statusline.ts`）

Claude Code 通过 stdin 传给脚本 JSON：

```json
{
  "session_id": "...",
  "transcript_path": "/Users/你/.claude/projects/.../XXX.jsonl",
  "context_window": {
    "context_window_size": 200000,
    "current_usage": {
      "input_tokens": 104,
      "cache_creation_input_tokens": 191,
      "cache_read_input_tokens": 116000
    }
  }
}
```

脚本从 `transcript_path` 扫所有形如 `gen-*` 的 message ID，去 OpenRouter `/api/v1/generation?id=<id>` 查每个请求的 `total_cost` + `cache_discount`，在 `/tmp/claude-openrouter-cost-<session_id>.json` 里去重累加。

---

## tokens 行为什么用 `contextPercent × 总窗口` 反推

早期版本用 `inputTokens + cacheReadInputTokens + cacheCreationInputTokens` 三项相加。但 CCR 的 `inputTokens` 字段**含义不稳**：有时是本次请求 input（几百），有时含 cache read（100k+），跳变剧烈。

只有 Claude Code 自己算好的 `contextPercent` 是**当前上下文窗口占用的真值**——所以现在 `formatTokenLine` 直接用 `Math.round(pct / 100 * total)`，和 L2 的 `󰉍 xx%` 永远一致。

**未知模型的限制**：当你 `/model <CC 不认识的 alias>`（比如 `ccr-free`）切到自定义路由模型时，CC 对该模型的 context_window 不知道，`contextPercent` 可能退化为 0 或无意义值，这时 tokens 行也跟着不准。用 CC 官方预设模型（opus/sonnet/haiku）则正常。

---

## 模型显示和实际路由

`ccr-append.js` L1 显示的 `model` 是 **CCR `variables.model`**，也就是"上一次请求路由后的模型"。这意味着：

1. 你刚 `/model <xxx>` 切换后，L1 还会显示旧模型一小段——直到下一条消息发出、CCR 用新规则路由了一次，variables.model 才会更新。
2. 如果你走 CCR，你看到 L1 的模型名是 **路由最终送到 OpenRouter 的那个模型**，不是你在 `/model` 菜单里选的 alias。Claude Code 端的 `/model` 设置只是个标签，真正决定模型的是 CCR Router 和 `router.js`。

---

## License

MIT

---

## 灵感 / 相关

- [claude-code-router (musistudio)](https://github.com/musistudio/claude-code-router) —— 本仓库 `ccr-append.js` 为其 `StatusLine.default.modules` 的 `type:"script"` 而写。
- [Claude Code](https://claude.com/claude-code) —— `statusline.ts` 使用 Claude Code 官方 statusLine 协议（stdin JSON + stdout 字符串）。
