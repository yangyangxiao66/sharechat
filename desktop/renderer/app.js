const api = window.sharechat;
const $ = (id) => document.getElementById(id);

const GLYPH = { claude: 'C', codex: 'X', chatgpt: 'D', cursor: 'Cu', workbuddy: 'W', grok: 'G', qwen: 'Q', gemini: 'Ge', opencode: 'O', qoder: 'Qd' };
const state = {
  agents: [],
  sessions: [],
  errors: [],
  agent: 'all',
  project: null,
  query: '',
  selected: null,
  detail: null,
  target: null,
  loadToken: 0,
};

const SKIP_PERMS_KEY = 'sharechat-claude-skip-permissions';

document.body.classList.add(`platform-${api.platform}`);

function renderView(mode) {
  document.body.dataset.view = mode;
  $('terminal-host').hidden = mode !== 'terminal';
  $('refresh').hidden = mode !== 'sessions';
  for (const button of document.querySelectorAll('.workspace-nav [data-view]')) {
    button.classList.toggle('active', button.dataset.view === mode);
    button.setAttribute('aria-pressed', String(button.dataset.view === mode));
  }
}

api.onViewChange(renderView);
for (const button of document.querySelectorAll('.workspace-nav [data-view]')) {
  button.addEventListener('click', async () => {
    const mode = button.dataset.view;
    renderView(mode);
    $('terminal-loading').textContent = '正在加载终端矩阵…';
    try { const result = await api.setView(mode); renderView(result.mode); }
    catch (error) { $('terminal-loading').textContent = error.message; toast(error.message); }
  });
}

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const keyOf = (s) => `${s.agent}:${s.id}`;
const agentById = (id) => state.agents.find((a) => a.id === id);
const labelOf = (id) => agentById(id)?.label ?? id;
const baseName = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p : '未知目录');
const glyph = (id, cls = '') => `<span class="glyph a-${esc(id)} ${cls}">${esc(GLYPH[id] ?? id[0]?.toUpperCase())}</span>`;

function when(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (d >= today) return `今天 ${hm}`;
  if (d >= new Date(today.getTime() - 86400000)) return `昨天 ${hm}`;
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// Small, safe Markdown subset: fenced code, inline code, bold. Everything is escaped first.
function md(text) {
  const parts = String(text ?? '').split(/```[^\n]*\n?/);
  return parts.map((chunk, i) => {
    if (i % 2 === 1) return `<pre>${esc(chunk.replace(/\n$/, ''))}</pre>`;
    return esc(chunk)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  }).join('');
}

// ---------- filtering ----------
function visibleSessions() {
  const q = state.query.trim().toLowerCase();
  return state.sessions.filter((s) =>
    (state.agent === 'all' || s.agent === state.agent)
    && (!state.project || s.cwd === state.project)
    && (!q || `${s.title} ${s.cwd} ${s.id}`.toLowerCase().includes(q)));
}

// ---------- sidebar ----------
function renderSidebar() {
  const counts = {};
  for (const s of state.sessions) counts[s.agent] = (counts[s.agent] || 0) + 1;
  const items = [{ id: 'all', label: '全部', count: state.sessions.length }]
    .concat(state.agents.map((a) => ({ id: a.id, label: a.label, count: counts[a.id] || 0, missing: a.detected === false })));
  $('agent-filter').innerHTML = items.map((a) => `
    <li class="side-item ${state.agent === a.id ? 'active' : ''} ${a.missing && !a.count ? 'muted' : ''}" data-agent="${a.id}" title="${a.missing ? '本机未发现数据目录' : ''}">
      ${a.id === 'all' ? '<span class="glyph all">∗</span>' : glyph(a.id)}
      <span class="label">${esc(a.label)}</span>
      <span class="count">${a.count}</span>
    </li>`).join('');

  const projects = new Map();
  for (const s of state.sessions) {
    if (state.agent !== 'all' && s.agent !== state.agent) continue;
    if (!s.cwd) continue;
    const p = projects.get(s.cwd) || { cwd: s.cwd, count: 0, latest: '' };
    p.count++;
    if (String(s.updatedAt) > p.latest) p.latest = String(s.updatedAt);
    projects.set(s.cwd, p);
  }
  const list = [...projects.values()].sort((a, b) => b.latest.localeCompare(a.latest));
  $('project-filter').innerHTML = list.length
    ? list.map((p) => `
      <li class="side-item ${state.project === p.cwd ? 'active' : ''}" data-project="${esc(p.cwd)}" title="${esc(p.cwd)}">
        <svg class="folder" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>
        <span class="label">${esc(baseName(p.cwd))}</span>
        <span class="count">${p.count}</span>
      </li>`).join('')
    : '<li class="side-item muted"><span class="label">暂无</span></li>';

  $('side-foot').innerHTML = state.errors.length
    ? state.errors.map((e) => `<div class="warn" title="${esc(e.message)}">${esc(labelOf(e.agent))} 读取失败</div>`).join('')
    : `${state.sessions.length} 个会话 · ${state.agents.filter((a) => a.detected !== false).length} 个 agent`;
}

// ---------- list ----------
function renderList() {
  const rows = visibleSessions();
  $('list-meta').textContent = state.project ? `${baseName(state.project)} · ${rows.length} 个会话` : `${rows.length} 个会话`;
  if (!rows.length) {
    $('session-list').innerHTML = `<li class="list-empty">${state.sessions.length ? '没有匹配的会话' : '本机还没有发现任何会话'}</li>`;
    return;
  }
  $('session-list').innerHTML = rows.map((s) => `
    <li class="session ${state.selected && keyOf(state.selected) === keyOf(s) ? 'active' : ''}" data-key="${esc(keyOf(s))}">
      ${glyph(s.agent)}
      <div class="session-title">${esc(s.title || '(无标题)')}</div>
      <div class="session-sub">
        <span class="cwd" title="${esc(s.cwd)}">${esc(baseName(s.cwd))}</span>
        <span class="time">${esc(when(s.updatedAt))}</span>
      </div>
    </li>`).join('');
}

function renderListSkeleton() {
  $('session-list').innerHTML = Array.from({ length: 8 }, () => '<li class="skeleton"></li>').join('');
  $('list-meta').textContent = '正在读取各 agent 的会话…';
}

// ---------- detail ----------
function renderHead(meta, detail) {
  $('d-kicker').innerHTML = `${glyph(meta.agent)}<span>${esc(labelOf(meta.agent))}</span>`;
  $('d-title').textContent = detail?.title || meta.title || '(无标题)';
  const chips = [];
  if (meta.cwd) chips.push(`<button class="chip link" data-open="${esc(meta.cwd)}" title="打开目录"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg><span>${esc(meta.cwd)}</span></button>`);
  if (detail?.model) chips.push(`<span class="chip"><span>${esc(detail.model)}</span></span>`);
  if (meta.updatedAt) chips.push(`<span class="chip"><span>${esc(when(meta.updatedAt))}更新</span></span>`);
  chips.push(`<button class="chip link" data-copy="${esc(meta.id)}" title="复制会话 ID"><code>${esc(meta.id.slice(0, 13))}</code></button>`);
  $('d-chips').innerHTML = chips.join('');
}

function renderTargets() {
  const src = state.selected?.agent;
  const targets = state.agents.filter((a) => a.canTarget || (a.id === src && a.canSelfResume));
  $('targets').innerHTML = targets.map((a) => {
    const self = a.id === src;
    const selfResumable = !self || a.canSelfResume !== false;
    const sub = self
      ? selfResumable ? '继续此会话' : '当前来源'
      : a.id === 'chatgpt' ? '桌面版接续' : a.detected === false ? '未检测到安装' : '原生续聊';
    return `
    <button class="target a-${a.id}" role="radio" data-target="${a.id}"
      aria-checked="${state.target === a.id}" ${selfResumable ? '' : 'disabled title="这个 agent 只能作为会话来源"'}>
      ${glyph(a.id, 'lg')}
      <span><div class="t-name">${esc(a.label)}</div><div class="t-sub">${sub}</div></span>
    </button>`;
  }).join('');
  const btn = $('convert');
  btn.disabled = !state.target || !state.detail;
  const targetAgent = state.agents.find((a) => a.id === state.target);
  const self = Boolean(state.target) && state.target === src && targetAgent?.canSelfResume !== false;
  $('convert-label').textContent = state.target
    ? self ? '继续此会话' : `转换到 ${labelOf(state.target)}`
    : '选择目标';
  $('model-row').hidden = state.target !== 'opencode' || self;
  const skipRow = $('skip-perms-row');
  if (skipRow) skipRow.hidden = state.target !== 'claude';
  const launchLabel = $('launch-label');
  const relayHint = $('relay-hint');
  if (state.target === 'workbuddy') {
    if (launchLabel) launchLabel.textContent = '转换后启动 WorkBuddy';
    if (relayHint) relayHint.textContent = '写入 WorkBuddy 本地会话；请先完全退出 WorkBuddy，转换后会自动启动';
  } else if (self) {
    const desktopApp = state.target === 'chatgpt';
    if (launchLabel) launchLabel.textContent = desktopApp ? '在 ChatGPT 桌面版中打开' : '在内置终端中打开';
    if (relayHint) relayHint.textContent = desktopApp ? '交给 ChatGPT 桌面版打开原会话' : '直接恢复原会话，不写入新文件';
  } else if (state.target === 'chatgpt') {
    if (launchLabel) launchLabel.textContent = '转换后启动 ChatGPT 桌面版';
    if (relayHint) relayHint.textContent = '写入 ChatGPT 桌面版会话格式，转换后自动打开';
  } else if (state.target === 'qoder') {
    if (launchLabel) launchLabel.textContent = '转换后打开 Qoder';
    if (relayHint) relayHint.textContent = '写入 Qoder 会话；若 Qoder 已打开，侧栏可能需要重启后显示';
  } else {
    if (launchLabel) launchLabel.textContent = '转换后在内置终端中打开';
    if (relayHint) relayHint.textContent = '写入目标 agent 自己的会话格式，历史就是真实的对话';
  }
}

function renderTranscript(detail) {
  $('t-count').textContent = detail.rawMarkdown ? '官方导出' : `${detail.total} 条消息`;
  if (detail.rawMarkdown) {
    $('transcript').innerHTML = `<div class="msg"><div class="text">${md(detail.rawMarkdown)}</div></div>`;
    return;
  }
  const out = [];
  if (detail.omitted) out.push(`<div class="omitted">较早的 ${detail.omitted} 条消息未显示（转换时会全部带上）</div>`);
  for (const m of detail.messages) {
    if (m.role === 'user') {
      out.push(`<div class="msg user"><div class="msg-role">你</div><div class="bubble"><div class="text">${md(m.text)}</div></div></div>`);
      continue;
    }
    const body = m.parts.map((p) => (p.type === 'text'
      ? `<div class="text">${md(p.text)}</div>`
      : `<details class="tool ${p.isError ? 'err' : ''}">
          <summary><span class="t-tool">${esc(p.name)}</span><span class="t-in">${esc(p.input)}</span>
            <svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"></path></svg></summary>
          ${p.output ? `<pre>${esc(p.output)}</pre>` : ''}
        </details>`)).join('');
    out.push(`<div class="msg assistant"><div class="msg-role">${esc(labelOf(detail.agent))}</div>${body}</div>`);
  }
  $('transcript').innerHTML = out.join('') || '<div class="omitted">这个会话没有可显示的消息</div>';
}

async function select(meta) {
  state.selected = meta;
  state.detail = null;
  const ownAgent = state.agents.find((a) => a.id === meta.agent);
  state.target = ownAgent && ownAgent.canSelfResume !== false ? meta.agent : null;
  $('empty').hidden = true;
  $('detail-body').hidden = false;
  $('result').hidden = true;
  renderHead(meta);
  renderTargets();
  renderList();
  $('transcript').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  $('t-count').textContent = '';
  $('detail').scrollTop = 0;
  const token = ++state.loadToken;
  try {
    const detail = await api.load(meta);
    if (token !== state.loadToken) return;
    state.detail = detail;
    renderHead(meta, detail);
    renderTargets();
    renderTranscript(detail);
  } catch (e) {
    if (token !== state.loadToken) return;
    $('transcript').innerHTML = `<div class="result error"><div class="result-title">读取失败</div>${esc(e.message)}</div>`;
  }
}

// ---------- convert ----------
async function convert() {
  const meta = state.selected;
  if (!meta || !state.target) return;
  const isSelf = state.target === meta.agent;
  const btn = $('convert');
  btn.disabled = true;
  btn.classList.add('busy');
  $('convert-label').textContent = isSelf ? '正在打开…' : '正在转换…';
  const launch = $('opt-launch').checked;
  const skipPermissions = state.target === 'claude' && $('opt-skip-perms')?.checked === true;
  const res = $('result');
  try {
    const r = await api.convert({
      meta,
      target: state.target,
      model: $('opt-model').value,
      launch,
      skipPermissions,
    });
    const targetLabel = labelOf(r.target);
    res.className = 'result';
    if (r.native) {
      const external = Boolean(r.openUrl);
      const title = external
        ? launch ? `已在 ${esc(targetLabel)} 中打开会话` : `已生成 ${esc(targetLabel)} 会话链接`
        : launch ? `已继续 ${esc(targetLabel)} 原生会话` : `已生成 ${esc(targetLabel)} 原生续聊命令`;
      res.innerHTML = `
        <div class="result-title">
          <svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"></path></svg>
          ${title}
        </div>
        <div>${external ? '由桌面版直接打开原会话' : '直接恢复原会话，未写入新文件'} · 工作目录 <code>${esc(r.cwd)}</code></div>
        <div class="cmd"><code>${esc(r.command)}</code><button class="mini-btn" data-copy="${esc(r.command)}">复制${external ? '链接' : ''}</button></div>
        ${external ? '' : `<div class="result-actions">
          <button class="mini-btn" data-copy="${esc(`cd "${r.cwd}" && ${r.command}`)}">复制完整命令</button>
        </div>`}`;
      if (r.launchError) {
        const warning = document.createElement('p');
        warning.textContent = `会话启动失败：${r.launchError}`;
        res.appendChild(warning);
      }
      toast(r.launchError
        ? '会话已就绪，请检查启动提示'
        : external
          ? launch ? `已在 ${targetLabel} 中打开会话` : '已生成会话链接'
          : launch ? `已在 ${targetLabel} 中继续会话` : '已生成续聊命令');
      return;
    }
    const isWorkBuddy = r.target === 'workbuddy';
    const isChatGPT = r.target === 'chatgpt';
    const isQoder = r.target === 'qoder';
    const opening = launch
      ? isWorkBuddy ? '，正在启动 WorkBuddy' : isChatGPT ? '，正在 ChatGPT 桌面版中打开' : isQoder ? '，正在打开 Qoder' : '，正在新终端中打开'
      : '';
    res.innerHTML = `
      <div class="result-title">
        <svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"></path></svg>
        已转换为 ${esc(targetLabel)} 会话${opening}
      </div>
      <div>共 ${r.messages} 条消息 · 工作目录 <code>${esc(r.cwd)}</code></div>
      ${isWorkBuddy ? `<div>打开 WorkBuddy 后，在会话列表中选择「${esc(r.title)}（来自 ${esc(labelOf(meta.agent))}）」。</div>` : ''}
      ${isQoder ? '<div>若 Qoder 已打开，重启 Qoder 后新会话会出现在对应工作区的侧栏。</div>' : ''}
      <div class="cmd"><code>${esc(isWorkBuddy ? `WorkBuddy 会话 ${r.sessionId}` : r.command)}</code><button class="mini-btn" data-copy="${esc(isWorkBuddy ? r.sessionId : r.command)}">${isWorkBuddy ? '复制 ID' : isChatGPT ? '复制链接' : '复制'}</button></div>
      <div class="result-actions">
        ${r.file && !String(r.file).startsWith('opencode:') ? `<button class="mini-btn" data-reveal="${esc(r.file)}">在文件夹中显示</button>` : ''}
        ${isWorkBuddy || isChatGPT ? '' : `<button class="mini-btn" data-copy="${esc(`cd "${r.cwd}" && ${r.command}`)}">复制完整命令</button>`}
      </div>`;
    if (r.launchError) {
      const warning = document.createElement('p');
      warning.textContent = `会话已转换，但${isWorkBuddy ? ' WorkBuddy 启动' : isChatGPT ? ' ChatGPT 桌面版启动' : isQoder ? ' Qoder 启动' : '终端启动'}失败：${r.launchError}`;
      res.appendChild(warning);
    }
    toast(r.launchError ? '会话已转换，请检查启动提示' : `已转换到 ${targetLabel}`);
    refresh({ keepSelection: true });
  } catch (e) {
    res.className = 'result error';
    res.innerHTML = `<div class="result-title">${isSelf ? '继续会话失败' : '转换失败'}</div>${esc(e.message)}`;
  } finally {
    res.hidden = false;
    btn.classList.remove('busy');
    renderTargets();
  }
}

let modelsLoaded = false;
async function loadModels() {
  if (modelsLoaded) return;
  modelsLoaded = true;
  const sel = $('opt-model');
  sel.innerHTML = '<option value="">自动选择（读取中…）</option>';
  try {
    const models = await api.opencodeModels();
    sel.innerHTML = '<option value="">自动选择</option>' + models.map((m) => `<option>${esc(m)}</option>`).join('');
  } catch {
    sel.innerHTML = '<option value="">自动选择</option>';
  }
}

// ---------- data ----------
async function refresh({ keepSelection = false } = {}) {
  const btn = $('refresh');
  btn.classList.add('spin');
  if (!state.sessions.length) renderListSkeleton();
  try {
    const [agents, { rows, errors }] = await Promise.all([api.agents(), api.sessions()]);
    state.agents = agents;
    state.sessions = rows;
    state.errors = errors;
    if (keepSelection && state.selected) {
      state.selected = rows.find((s) => keyOf(s) === keyOf(state.selected)) || state.selected;
    }
    renderSidebar();
    renderList();
    if (state.selected) renderTargets();
  } catch (e) {
    $('list-meta').textContent = `读取失败：${e.message}`;
  } finally {
    btn.classList.remove('spin');
  }
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-agent],[data-project],[data-key],[data-target],[data-copy],[data-reveal],[data-open]');
  if (!el) return;
  if (el.dataset.agent) {
    state.agent = el.dataset.agent;
    state.project = null;
    renderSidebar(); renderList();
  } else if (el.dataset.project !== undefined) {
    state.project = state.project === el.dataset.project ? null : el.dataset.project;
    renderSidebar(); renderList();
  } else if (el.dataset.key) {
    const s = state.sessions.find((x) => keyOf(x) === el.dataset.key);
    if (s) select(s);
  } else if (el.dataset.target && !el.disabled) {
    state.target = el.dataset.target;
    $('result').hidden = true;
    if (state.target === 'opencode') loadModels();
    renderTargets();
  } else if (el.dataset.copy) {
    api.copy(el.dataset.copy).then(() => toast('已复制'));
  } else if (el.dataset.reveal) {
    api.reveal(el.dataset.reveal);
  } else if (el.dataset.open) {
    api.openFolder(el.dataset.open);
  }
});

$('convert').addEventListener('click', convert);
$('refresh').addEventListener('click', () => refresh({ keepSelection: true }));
$('search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });

const skipPerms = $('opt-skip-perms');
try { skipPerms.checked = localStorage.getItem(SKIP_PERMS_KEY) === '1'; } catch { /* ignore */ }
skipPerms.addEventListener('change', () => {
  try { localStorage.setItem(SKIP_PERMS_KEY, skipPerms.checked ? '1' : '0'); } catch { /* ignore */ }
});

document.addEventListener('keydown', (e) => {
  if (document.body.dataset.view !== 'sessions') return;
  const typing = e.target.matches('input, select, textarea');
  if (e.key === '/' && !typing) { e.preventDefault(); $('search').focus(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); refresh({ keepSelection: true }); return; }
  if (e.key === 'Escape' && typing) { e.target.blur(); return; }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing) {
    e.preventDefault();
    const rows = visibleSessions();
    if (!rows.length) return;
    const i = state.selected ? rows.findIndex((s) => keyOf(s) === keyOf(state.selected)) : -1;
    const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    select(next).then(() => document.querySelector('.session.active')?.scrollIntoView({ block: 'nearest' }));
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !$('convert').disabled) convert();
});

refresh();
