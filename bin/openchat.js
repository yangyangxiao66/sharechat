#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AGENTS, getAgent } from '../src/agents.js';
import { renderHandoff } from '../src/render.js';
import { NATIVE } from '../src/native/index.js';
import { listSessions } from '../src/core.js';
import { assertClaudeLaunchAllowed } from '../src/claude-guard.js';
import { HOME, exists, samePath, oneLine, quoteArg } from '../src/util.js';

const HELP = `sharechat — 在不同编程 agent 之间无缝切换会话

一键切换（在项目目录里运行）:
  sharechat switch codex          把当前目录最近的会话（来自任意其他 agent）转成 Codex 会话并打开
  sharechat switch claude --from codex
  sharechat switch qwen -s 3      指定要转的会话

用法:
  sharechat switch <agent> [--from <agent>] [-s <会话>]       一键切换到另一个 agent
  sharechat handoff <会话> --to <agent> [选项]                 转换指定会话并打开
  sharechat list [-a claude,codex] [--here] [-n 20] [--json]   列出会话（带编号）
  sharechat show <会话>                                        打印会话内容（Markdown）
  sharechat export <会话> [-o 文件] [--format md|json]          导出为 Markdown 或统一 JSON
  sharechat agents                                            查看支持的 agent

原生切换（写入目标 agent 自己的会话格式，用 --resume 打开，历史就是真实的对话）:
  ${Object.keys(NATIVE).join(', ')}
其他目标（${Object.keys(AGENTS).filter((a) => !NATIVE[a]).join(', ')}）暂不支持原生写入，会退回交接文档。

<会话> 的写法:
  3              上一次 list 结果中的编号
  latest         所有 agent 中最近的会话（加 --here 只看当前目录）
  claude:latest  某个 agent 最近的会话
  codex:01a116   某个 agent 中 ID 前缀匹配的会话
  01a116         在所有 agent 中按 ID 前缀匹配

switch / handoff 选项:
  --to, -t <agent>    目标：${Object.keys(AGENTS).filter((a) => !AGENTS[a].sourceOnly).join(' | ')}
  --from, -f <agent>  switch 时只从这个 agent 里找会话
  --session, -s <会话> switch 时指定会话（默认当前目录最近的一个）
  --no-launch         只写入会话，打印启动命令，不启动
  --cwd <目录>         目标 agent 的工作目录（handoff 默认用原会话目录，switch 默认用当前目录）
  --doc               不做原生写入，改用交接文档
  --model <p/m>       目标为 opencode 时指定续聊模型（默认优先用你自己配置的服务商）
  --max-tokens <n>    写入历史的 token 上限，超出时先去掉旧工具输出、再省略最早的消息（默认按目标模型的上下文窗口自动计算；0 不限制）
`;

function parseArgs(argv) {
  const opts = { _: [] };
  const alias = { a: 'agent', n: 'limit', t: 'to', o: 'out', h: 'help', f: 'from', s: 'session' };
  const flags = new Set(['here', 'json', 'doc', 'no-launch', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-') || a === '-') { opts._.push(a); continue; }
    let [k, v] = a.replace(/^--?/, '').split(/=(.*)/s);
    k = alias[k] || k;
    if (flags.has(k)) opts[k] = true;
    else opts[k] = v ?? argv[++i];
  }
  return opts;
}

const stateFile = path.join(HOME, '.openchat', 'last-list.json');

function collect(opts) {
  return listSessions({
    agents: opts.agent ? String(opts.agent).split(',') : null,
    cwd: opts.here ? process.cwd() : null,
    onError: (n, e) => console.error(`[${n}] 读取失败：${e.message}`),
  });
}

function resolve(ref, opts) {
  if (!ref) throw new Error('缺少 <会话> 参数，先运行 sharechat list 看看');
  if (/^\d+$/.test(ref)) {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const hit = saved[Number(ref) - 1];
    if (!hit) throw new Error(`编号 ${ref} 不存在，请重新运行 sharechat list`);
    return hit;
  }
  let [agent, key] = ref.includes(':') ? ref.split(/:(.*)/s) : [null, ref];
  const rows = collect({ ...opts, agent: agent || opts.agent });
  if (key === 'latest') {
    if (!rows.length) throw new Error('没有找到会话');
    return rows[0];
  }
  const hits = rows.filter((s) => s.id.startsWith(key));
  if (!hits.length) throw new Error(`没有 ID 以 ${key} 开头的会话`);
  if (hits.length > 1 && !hits.every((h) => h.id === hits[0].id)) {
    throw new Error(`前缀 ${key} 匹配到 ${hits.length} 个会话，请写长一点：\n` + hits.slice(0, 5).map((h) => `  ${h.agent}:${h.id}`).join('\n'));
  }
  return hits[0];
}

function load(meta) {
  const a = getAgent(meta.agent);
  return { agent: a, session: a.load(meta) };
}

function cmdList(opts) {
  const rows = collect(opts).slice(0, Number(opts.limit) || 20);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(rows));
  if (opts.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log('没有找到会话。');
  rows.forEach((s, i) => {
    const d = s.updatedAt ? new Date(s.updatedAt) : null;
    const pad = (x) => String(x).padStart(2, '0');
    const when = d && !isNaN(d) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '????-??-?? ??:??';
    console.log(`${String(i + 1).padStart(3)}  ${when}  ${s.agent.padEnd(8)} ${s.id.slice(0, 8)}  ${oneLine(s.title || '(无标题)', 50)}`);
    if (s.cwd) console.log(`     ${' '.repeat(16)}  ${''.padEnd(8)} ${s.cwd}`);
  });
  console.log('\n下一步：sharechat handoff <编号> --to <agent>，或在项目目录里 sharechat switch <agent>');
}

function cmdShow(opts) {
  const { agent, session } = load(resolve(opts._[1], opts));
  process.stdout.write(renderHandoff(session, agent.label, { maxChars: Number(opts['max-chars']) || 120000 }));
}

function cmdExport(opts) {
  const { agent, session } = load(resolve(opts._[1], opts));
  const text = opts.format === 'json'
    ? JSON.stringify(session, null, 2)
    : renderHandoff(session, agent.label, { maxChars: Number(opts['max-chars']) || Infinity });
  if (opts.out) { fs.writeFileSync(opts.out, text); console.log(`已导出到 ${opts.out}`); }
  else process.stdout.write(text);
}

function launch({ cmd, args, detached = false }, cwd, noLaunch) {
  const line = [cmd, ...args.map(quoteArg)].join(' ');
  if (noLaunch) {
    console.log(`\n在 ${cwd} 中运行：\n  ${line}`);
    return;
  }
  console.log(`\n▶ ${line}\n`);
  const win = process.platform === 'win32';
  const child = spawn(cmd, win ? args.map(quoteArg) : args, {
    cwd,
    detached,
    stdio: detached ? 'ignore' : 'inherit',
    shell: win,
  });
  if (detached) child.unref();
  child.on('error', (e) => { console.error(`启动 ${cmd} 失败：${e.message}`); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 0; });
}

function openUrl(url) {
  const win = process.platform === 'win32';
  const child = win
    ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

function transfer(meta, target, cwd, opts) {
  if (target.sourceOnly) throw new Error(`${target.label} 目前只能作为会话来源，暂不支持作为目标`);
  const { agent: source, session } = load(meta);
  console.log(`来源：${source.label} · ${session.title || session.id}（${session.messages.length} 条消息）`);
  console.log(`目标：${target.label} · 目录 ${cwd}`);

  const write = NATIVE[target.id];
  if (write && !opts.doc) {
    const maxTokens = opts['max-tokens'] == null ? undefined : Number(opts['max-tokens']);
    const r = write(session, source.label, { cwd, model: opts.model, maxTokens });
    console.log(`已转换为 ${target.label} 原生会话 ${r.sessionId}\n  ${r.file}`);
    if (r.openUrl) {
      if (opts['no-launch']) {
        console.log(`\n在 ${target.label} 中打开：\n  ${r.openUrl}`);
        return;
      }
      console.log(`\n▶ ${r.openUrl}\n`);
      openUrl(r.openUrl);
      return;
    }
    return launch(r.resume, cwd, opts['no-launch']);
  }
  if (!write) console.log(`${target.label} 暂不支持原生写入，改用交接文档。`);

  const md = renderHandoff(session, source.label, { maxChars: Number(opts['max-chars']) || 120000 });
  const dir = path.join(cwd, '.openchat');
  fs.mkdirSync(dir, { recursive: true });
  if (!exists(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const file = path.join(dir, `handoff-${source.id}-${session.id.slice(0, 8)}-${stamp}.md`);
  fs.writeFileSync(file, md);
  const rel = path.relative(cwd, file).split(path.sep).join('/');
  console.log(`交接文档：${file}（${md.length} 字符）`);

  const prompt = `我刚从 ${source.label} 切换过来继续之前的工作。之前的完整会话记录在 ${rel} 文件里，请先完整阅读它，然后用几句话总结目前的进度和下一步打算，等我确认后再继续。`;
  launch(target.launchCommand(prompt), cwd, opts['no-launch']);
}

async function cmdHandoff(opts) {
  if (!opts.to) throw new Error('请用 --to 指定目标 agent');
  const meta = resolve(opts._[1], opts);
  const cwd = path.resolve(opts.cwd || (meta.cwd && exists(meta.cwd) ? meta.cwd : process.cwd()));
  const target = getAgent(opts.to);
  if (target.id === 'claude' && !opts['no-launch']) await assertClaudeLaunchAllowed();
  transfer(meta, target, cwd, opts);
}

// One-step switch: take the newest session for this directory from any other
// agent and reopen it in the target.
async function cmdSwitch(opts) {
  const target = getAgent(opts._[1] || opts.to || '');
  const cwd = path.resolve(opts.cwd || process.cwd());
  let meta;
  if (opts.session) meta = resolve(String(opts.session), opts);
  else {
    const from = opts.from ? [opts.from] : Object.keys(AGENTS).filter((a) => a !== target.id);
    meta = collect({ agent: from.join(',') }).find((s) => samePath(s.cwd, cwd));
    if (!meta) throw new Error(`当前目录 ${cwd} 下没有找到${opts.from ? ` ${opts.from} 的` : '其他 agent 的'}会话，可以用 sharechat list 查看后用 -s 指定`);
  }
  if (target.id === 'claude' && !opts['no-launch']) await assertClaudeLaunchAllowed();
  transfer(meta, target, cwd, opts);
}

function cmdAgents() {
  for (const a of Object.values(AGENTS)) {
    const h = a.home();
    const state = h == null ? '通过官方 CLI 读取' : exists(h) ? `数据目录 ${h}` : `未发现 ${h}`;
    console.log(`${a.id.padEnd(9)} ${a.label.padEnd(12)} ${state}`);
  }
}

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._[0];
try {
  if (!cmd || opts.help || cmd === 'help') console.log(HELP);
  else if (cmd === 'list' || cmd === 'ls') cmdList(opts);
  else if (cmd === 'show') cmdShow(opts);
  else if (cmd === 'export') cmdExport(opts);
  else if (cmd === 'handoff' || cmd === 'to') await cmdHandoff(opts);
  else if (cmd === 'switch' || cmd === 'sw') await cmdSwitch(opts);
  else if (cmd === 'agents') cmdAgents();
  else throw new Error(`未知命令 ${cmd}，运行 sharechat help 查看用法`);
} catch (e) {
  console.error(`错误：${e.message}`);
  process.exitCode = 1;
}
