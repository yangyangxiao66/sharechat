# openchat

在不同编程 agent 之间一键切换会话，不丢上下文。比如 Claude 额度用完了，在项目目录里运行：

```bash
openchat switch codex
```

它会找到当前目录最近的一次会话（来自任意其他 agent），转成 Codex 自己的会话格式，然后执行 `codex resume <新会话ID>`。Codex 打开后，之前的每一轮对话都是真实的历史消息，可以直接接着聊。

支持 Claude Code、Codex、Qwen Code、Gemini CLI、OpenCode、Grok Build。零依赖，Node.js ≥ 18。

## 安装

```bash
cd G:\openchat
npm link        # 之后任何目录都能用 openchat
```

## 桌面端

```bash
npm install          # 首次安装 Electron；GitHub 下载慢可以先设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run desktop
```

界面分三栏：左边按来源 agent 和项目筛选，中间是会话列表，右边是会话预览和“接续到”面板。选中一个会话，选好目标 agent，点“转换到 …”，会话就会被写成目标 agent 的原生会话，并在新终端里执行它的 resume 命令。也可以取消“在新终端中打开”，只做转换，然后复制命令自己运行。

快捷键：`/` 搜索，`↑` `↓` 切换会话，`Ctrl+R` 刷新，`Ctrl+Enter` 转换。界面跟随系统深浅色，也可以用 `OPENCHAT_THEME=dark` 或 `light` 强制指定。

## 命令行用法

```bash
openchat switch codex                  # 当前目录最近的会话 → Codex
openchat switch claude --from codex    # 只从 Codex 的会话里找
openchat switch qwen -s 3              # 指定会话（编号来自 openchat list）
openchat switch codex --no-launch      # 只转换，打印启动命令

openchat list --here                   # 当前目录下所有 agent 的会话
openchat handoff codex:01a116 --to claude   # 转换任意会话，在原会话目录打开
```

## 切换方式

| 目标 | 方式 | 打开命令 |
| --- | --- | --- |
| Codex | 原生会话：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `codex resume <id>` |
| Claude Code | 原生会话：`~/.claude/projects/<cwd>/<id>.jsonl` | `claude --resume <id>` |
| Qwen Code | 原生会话：`~/.qwen/projects/<cwd>/chats/<id>.jsonl` | `qwen --resume <id>` |
| Gemini CLI | 原生会话：`~/.gemini/tmp/<project>/chats/session-*.jsonl` | `gemini --resume <id>` |
| OpenCode | 官方 `opencode import`，导入 `opencode export` 格式的 JSON | `opencode --session <id>` |
| Grok Build | 原生会话目录：`~/.grok/sessions/<cwd>/<id>/`（`chat_history.jsonl`、`updates.jsonl`、`summary.json`） | `grok --resume <id>` |

OpenCode 续聊用的模型：如果你最近用过的模型还在 `opencode models` 列表里，就继续用它；否则优先选你自己配置的服务商，不用 OpenCode 的免费模型。也可以用 `--model 服务商/模型` 指定。

原会话不会被修改。每次切换都会在目标 agent 里新建一个会话，标题后面带「（来自 XX）」。

**工具调用怎么处理**：工具调用和结果会写成文本，格式和 Codex 官方的外部会话导入器一致，形如 `[external_agent_tool_call: Bash] … [/external_agent_tool_call]`，结果超过 4000 字符会截断。原因是不同 agent 的工具集互不兼容，一个找不到匹配结果的原生工具调用会让历史失效。所以新 agent 知道之前做过什么，但文件内容要以磁盘为准，它会自己重新读取。

**长会话**：写入时会附上 token 估算，Codex 读取 `token_count`，Claude 读取最后一条 usage。超出上下文窗口时，目标 agent 会自动压缩，而不是直接报错。

## 格式依据（官方源码）

- **Codex**：写入格式参照官方的外部会话导入器 `codex-rs/external-agent-migration/src/sessions/export.rs`。每一轮写 TurnStarted、UserMessage 和用户 ResponseItem、AgentMessage 和助手 ResponseItem、TurnComplete，最后写一条 TokenCount。`codex resume <id>` 在 SQLite 索引里查不到这个会话时，会按文件名扫描并修复索引（`codex-rs/rollout/src/list.rs`），所以不需要改数据库。
- **Qwen Code**：`packages/core/src/services/chatRecordingService.ts`（ChatRecord）、`sessionService.ts`（第一条记录的 cwd 必须属于当前项目）、`utils/paths.ts`（`sanitizeCwd`）。
- **Gemini CLI**：`chatRecordingService.ts`（JSONL 追加日志，以及 `$rewindTo`、`$patch`、`$set` 的回放规则）、`projectRegistry.ts`（`projects.json` 和 `.project_root` 归属标记）。
- **OpenCode**：读取用官方命令 `opencode session list --format json` 和 `opencode export`；写入用官方命令 `opencode import`。消息结构参照 `packages/opencode/src/session/message-v2.ts`，ID 规则参照 `src/id/id.ts`（会话 ID 降序，消息和片段 ID 升序），projectID 参照 `src/project/project.ts`（取 git 根提交，否则为 `global`）。1.1.31 和 1.19.3 的导入格式一致。
- **Grok**（`xai-org/grok-build`，Apache 2.0）：
  - `summary.json` 对应 `xai-grok-shell/src/session/persistence.rs` 里的 `Summary`。必填字段是 `info`、`session_summary`、`created_at`、`updated_at`、`num_messages`、`current_model_id`；没有 `summary.json` 的目录不算可恢复的会话。
  - `chat_history.jsonl` 每行是一个 `ConversationItem`（`xai-grok-sampling-types/src/conversation.rs`），以 `type` 区分 `user`、`assistant`、`tool_result` 等。
  - 会话目录名来自 `xai-grok-config/src/paths.rs` 的 `encode_cwd_dirname`：先按 Rust `urlencoding` 编码（只保留 `A-Za-z0-9-_.~`）；超过 255 字节时改为 `{slug}-{blake3 前 16 位}`，并写一个 `.cwd` 标记文件。
  - 不写 system 记录：冷加载时 Grok 会调用 `replace_or_insert_system_head`（`xai-chat-state/src/conversation_util.rs`），自动在开头插入当前的系统提示。
  - Grok 自带的外部会话恢复（`xai-grok-foreign-sessions`，以及会话选择器里的 Claude、Codex、Cursor 条目）只会执行 `/resume-claude <id>` 或 `/resume-codex <id>` 技能，生成一段摘要接着做，不会导入真实的历史消息。

## 已验证

| 目标 | 验证结果 |
| --- | --- |
| Codex 0.163.0 | ✅ 用 `codex exec resume` 提问，能准确回答 Claude 历史里做过什么、生成了哪个文件 |
| Claude Code | ✅ 用 `claude -p --resume` 提问，能准确回答 OpenCode 历史里的细节 |
| OpenCode 1.1.31 | ✅ `opencode import` 导入成功，`opencode run --session` 能准确回答 Claude 历史 |
| Qwen Code 0.25.2 | ⚠️ `qwen sessions list` 能识别导入的会话和标题；没有账号，没测续聊 |
| Gemini CLI 0.64.0 | ⚠️ `gemini --list-sessions` 能识别导入的会话，文件不会被清理；没有账号，没测续聊 |
| Grok Build 1.0.41 | ⚠️ `grok sessions list` 能识别导入的会话，`grok export` 能完整读出内容；未登录，没测续聊 |

`npm test` 覆盖每家的读取器，以及 5 个直接写文件的原生写入器的往返测试（写入后再用该 agent 自己的读取器读回）。

## 新增一个 agent

在 `src/adapters/` 下新建一个读取器（导出 `id`、`label`、`home()`、`list()`、`load(meta)`、`launchCommand(prompt)`），并在 `src/agents.js` 里注册。如果要支持原生切换，再在 `src/native/` 下写一个 `write<Agent>Session(session, sourceLabel, { cwd })`，返回 `{ sessionId, file, resume: { cmd, args } }`，并在 `src/native/index.js` 里注册。
