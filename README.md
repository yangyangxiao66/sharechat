# sharechat

在不同编程 agent 之间一键切换会话，不丢上下文。比如 Claude 额度用完了，在项目目录里运行：

```bash
sharechat switch codex
```

它会找到当前目录最近的一次会话（来自任意其他 agent），转成 Codex 自己的会话格式，然后执行 `codex resume <新会话ID>`。Codex 打开后，之前的每一轮对话都是真实的历史消息，可以直接接着聊。

来源支持 Claude Code、Codex CLI、ChatGPT 桌面版、Cursor、WorkBuddy、Qwen Code、Gemini CLI、OpenCode 和 Grok Build；这些目标都支持原生历史写入，包括 WorkBuddy、ChatGPT 桌面版和 Qoder（Qoder 仅作为目标）。Codex 会话按来源分开：CLI 会话归 Codex，ChatGPT 桌面版的 Codex 会话单独归 ChatGPT 桌面版。会话转换核心零依赖，Node.js ≥ 22.15。

## 安装

```bash
cd G:\sharechat
npm link        # 之后任何目录都能用 sharechat
```

## 桌面端

```bash
npm install          # 首次安装 Electron；GitHub 下载慢可以先设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run setup        # 首次下载 Electron 运行程序
npm run desktop
```

顶部可切换「会话接续 / 终端矩阵」。会话接续保留三栏：来源和项目筛选、会话列表、内容预览及接续面板。选中会话并转换后，会在 sharechat 内置的终端矩阵里创建新终端，执行目标 Agent 的 resume 命令。也可以取消「转换后在内置终端中打开」，只转换并复制命令。

ChatGPT 桌面版（OpenAI.Codex 商店应用）的会话单独列在「ChatGPT 桌面版」来源下，不会混进 Codex CLI；点击会话默认用 `codex://threads/<id>` 在原 App 中打开。也可以把其他 agent 的会话转换到它：写入 Codex rollout（originator 为 `Codex Desktop`）后用同一个深链打开，桌面版会自动索引。

终端矩阵支持多终端并行、标签页、Git 分支、SSH、皮肤、字符动效及设置抽屉。切回会话接续时，终端进程继续运行；关闭 sharechat 窗口会释放内置终端和 SSH 连接。历史会话扫描在后台线程完成。终端源码来自 terminal 项目，详见 `modules/terminal/UPSTREAM.md`。

WorkBuddy 作为来源和目标接入：直接读取本机 WorkBuddy 桌面端的 `~/.workbuddy/workbuddy.db`（标题、目录、模型）和 `projects/<project>/<id>.jsonl`（对话、工具调用），不需要登录 WorkBuddy 开放平台或填写 Client ID/Secret。

转换到 WorkBuddy 时会把历史写入它的本地会话数据库和 JSONL，再自动启动 WorkBuddy，在会话列表里选择标题以「（来自 XX）」结尾的会话继续聊。写入使用本机最近一个 WorkBuddy 会话作模板，并：

- **转换前必须完全退出 WorkBuddy（包括托盘进程）**，否则 WorkBuddy 会用内存数据覆盖写入。
- 转换前自动备份数据库到 `~/.sharechat/backups/workbuddy/`，保留最近 3 份。
- 这是 WorkBuddy 的私有格式，WorkBuddy 升级后可能需要重新适配。
- 数据目录可用 `WORKBUDDY_HOME` 覆盖。

Windows 内置终端默认设置 `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true`，规避本机复现的 OpenCode 1.18.23 / 1.19.3 普通界面启动即退出问题。保留完整交互界面，但关闭 OpenCode 对外部文件变化的实时监听。若上游版本已修复，可在启动 sharechat 前显式设为 `false` 恢复监听；其他 Agent 和非 Windows 平台不受此设置影响。

```bash
npm start       # 启动整合后的 sharechat
npm run check   # 语法检查
npm test        # 会话格式和接续命令测试
npm run dist:win        # Windows 便携版
npm run dist:win:setup  # Windows 安装包
npm run dist:win:all    # 两者都打
```

打包产物输出到 `dist-build/`，不会提交进 Git。便携版是单个
`sharechat-portable-v<版本>-windows-x64.exe`；安装包是
`sharechat-setup-v<版本>-windows-x64.exe`。

命令行入口已改名为 `sharechat`，仍保留 `openchat` 命令别名与旧缓存目录兼容。

快捷键：`/` 搜索，`↑` `↓` 切换会话，`Ctrl+R` 刷新，`Ctrl+Enter` 转换。界面跟随系统深浅色，也可以用 `SHARECHAT_THEME=dark` 或 `light` 强制指定。

## 命令行用法

```bash
sharechat switch codex                  # 当前目录最近的会话 → Codex
sharechat switch claude --from codex    # 只从 Codex 的会话里找
sharechat switch qwen -s 3              # 指定会话（编号来自 sharechat list）
sharechat switch codex --no-launch      # 只转换，打印启动命令

sharechat list --here                   # 当前目录下所有 agent 的会话
sharechat handoff codex:01a116 --to claude   # 转换任意会话，在原会话目录打开
```

## 切换方式

选中会话后，目标默认就是来源 agent 自己：点「继续此会话」直接原生续聊（`claude --resume`、`codex resume`、`qwen --resume` 等），不转换、不新建会话文件；也可以改选其他 agent 走转换。目标为 Claude Code 时，可以勾选「Claude Code 全权限」，启动命令会追加 `--dangerously-skip-permissions`。WorkBuddy 没有命令行续聊命令，因此不支持自接续。

启动 Claude Code 前会检查当前出口 IP：中国大陆（CN）或无法确认地区时禁止启动。检查覆盖 CLI 的 `handoff` / `switch`、桌面端会话接续和内置终端启动台；`--no-launch` 或只生成命令不检查，在终端里手动输入 `claude` 也不受此限制。出口 IP 由 Cloudflare / ipinfo 探测，使用代理时以实际出口为准。

| 目标 | 方式 | 打开命令 |
| --- | --- | --- |
| Codex | 原生会话：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `codex resume <id>` |
| ChatGPT 桌面版 | Codex rollout，`originator` 写为 `Codex Desktop` | `codex://threads/<id>`，自动打开桌面版并索引 |
| Qoder（桌面端） | `~/.qoder/projects/<project>/<id>.jsonl`，并写入 Qoder `main.sqlite` 的会话索引和消息投影 | 转换后打开 Qoder；若 Qoder 已运行，重启后在新项目工作区侧栏可见 |
| Claude Code | 原生会话：`~/.claude/projects/<cwd>/<id>.jsonl` | `claude --resume <id>` |
| Qwen Code | 原生会话：`~/.qwen/projects/<cwd>/chats/<id>.jsonl` | `qwen --resume <id>` |
| Gemini CLI | 原生会话：`~/.gemini/tmp/<project>/chats/session-*.jsonl` | `gemini --resume <id>` |
| OpenCode | 官方 `opencode import`，导入 `opencode export` 格式的 JSON | `opencode --session <id>` |
| Grok Build | 原生会话目录：`~/.grok/sessions/<cwd>/<id>/`（`chat_history.jsonl`、`updates.jsonl`、`summary.json`） | `grok --resume <id>` |
| Cursor（桌面端） | 写入 Cursor 全局数据库 `state.vscdb`：会话头、界面消息、模型历史 | `cursor <项目目录>`，在右侧 Agents 列表里打开 |
| WorkBuddy（桌面端） | 写入 `workbuddy.db` 会话行和 `projects/<cwd>/<id>.jsonl`，使用本机最近会话作模板 | 转换后自动启动 WorkBuddy，在会话列表打开新会话（需先完全退出 WorkBuddy） |

OpenCode 续聊用的模型：如果你最近用过的模型还在 `opencode models` 列表里，就继续用它；否则优先选你自己配置的服务商，不用 OpenCode 的免费模型。也可以用 `--model 服务商/模型` 指定。

原会话不会被修改。每次切换都会在目标 agent 里新建一个会话，标题后面带「（来自 XX）」。

**切换到 Cursor 的前提**：
- 转换前要先完全退出 Cursor。Cursor 运行时会用内存里的数据覆盖写进去的会话，所以检测到 Cursor 在运行时会直接拒绝。
- 项目目录要先在 Cursor 里打开过一次，这样 Cursor 才会为它分配工作区 ID。
- 本机至少要有一个用 Agent 聊过的 Cursor 会话，用作数据结构的模板。
- 每次写入前，会自动把 `state.vscdb` 备份到 `~/.sharechat/backups/cursor/`，保留最近 3 份。

**工具调用怎么处理**：工具调用和结果会写成文本，格式和 Codex 官方的外部会话导入器一致，形如 `[external_agent_tool_call: Bash] … [/external_agent_tool_call]`，结果超过 4000 字符会截断。原因是不同 agent 的工具集互不兼容，一个找不到匹配结果的原生工具调用会让历史失效。所以新 agent 知道之前做过什么，但文件内容要以磁盘为准，它会自己重新读取。

**长会话**：目标 agent 压缩时会把整段历史发给模型做摘要，历史本身超过模型上下文就无法压缩。所以写入前会按 token 预算裁剪：先把较早消息里的工具输出缩成一行，仍超出就省略最早的消息（始终保留第一条用户请求，并注明省略了多少条），最近 6 条保持原样。预算按目标模型的上下文窗口计算：(上下文 − 输出上限) × 0.6。各 agent 的上下文来源：OpenCode 读 `opencode models --verbose`；Codex 读 config.toml 的 `model_context_window`，没有就查 `models_cache.json`；Grok 读 `models_cache.json`；Claude Code 按 200k 算（`[1m]` 模型按 1M），如果 `ANTHROPIC_BASE_URL` 指向第三方服务，按 128k 算；Qwen Code 的 qwen3-coder 按 1M 算，其他模型按 128k 算；Gemini 按 1M 算；Cursor 按 200k 算。读不到时预算默认 120000 token；可用 `--max-tokens <n>` 指定，`0` 表示不裁剪。写入时还会附上 token 估算，Codex 读取 `token_count`，Claude 读取最后一条 usage，让目标 agent 及时自动压缩。

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

- **Cursor**（闭源，参照 Codex 的 `records_cur.rs` 和 Grok 的 `resume-session/session_reader.py`，并对照本机数据推导）：
  - 会话登记在全局数据库的 `composerHeaders` 表里，通过 `workspaceId` 关联到 `workspaceStorage/<id>/workspace.json` 里的项目目录。
  - `cursorDiskKV` 里的 `composerData:<id>` 是会话本体，`bubbleId:<id>:<bubbleId>` 是界面上的每条消息。
  - 模型真正看到的历史在 `composerData.conversationState`：`~` 加上 base64 编码的 protobuf，其中 field 1 按顺序列出每条消息的 sha256，消息正文存在 `agentKv:blob:<sha256>`，格式是 AI SDK 消息 `{role, content}`。
  - 写入时拿本机最近一个真实会话作模板，沿用它的系统提示，把 `<user_info>` 里的工作区路径改成目标项目。
  - 读取时会去掉系统提示、`<user_info>`，以及 Cursor 注入的 `<system_notification>` 后台通知。

## 已验证

| 目标 | 验证结果 |
| --- | --- |
| Codex 0.163.0 | ✅ 用 `codex exec resume` 提问，能准确回答 Claude 历史里做过什么、生成了哪个文件 |
| Claude Code | ✅ 用 `claude -p --resume` 提问，能准确回答 OpenCode 历史里的细节 |
| OpenCode 1.1.31 | ✅ `opencode import` 导入成功，`opencode run --session` 能准确回答 Claude 历史 |
| Qwen Code 0.25.2 | ⚠️ `qwen sessions list` 能识别导入的会话和标题；没有账号，没测续聊 |
| Gemini CLI 0.64.0 | ⚠️ `gemini --list-sessions` 能识别导入的会话，文件不会被清理；没有账号，没测续聊 |
| Grok Build 1.0.41 | ⚠️ `grok sessions list` 能识别导入的会话，`grok export` 能完整读出内容；未登录，没测续聊 |
| Cursor 3.17.8 | ✅ 在隔离的数据目录（`--user-data-dir`）里运行真实 Cursor：导入的会话出现在 Agents 列表里，内容显示正常；提问后，模型能准确回答 Claude 历史里执行过的命令和生成的文件 |

`npm test` 覆盖每家的读取器，以及直接写文件的原生写入器的往返测试（写入后再用该 agent 自己的读取器读回）；Cursor 部分用一个结构和真实数据库一致的假数据库来测。

## 新增一个 agent

在 `src/adapters/` 下新建一个读取器（导出 `id`、`label`、`home()`、`list()`、`load(meta)`、`launchCommand(prompt)`），并在 `src/agents.js` 里注册。如果要支持原生切换，再在 `src/native/` 下写一个 `write<Agent>Session(session, sourceLabel, { cwd })`，返回 `{ sessionId, file, resume: { cmd, args } }`，并在 `src/native/index.js` 里注册。
