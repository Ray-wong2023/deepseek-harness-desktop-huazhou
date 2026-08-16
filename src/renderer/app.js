'use strict';

import { marked } from '../../node_modules/marked/lib/marked.esm.js';
import DOMPurify from '../../node_modules/dompurify/dist/purify.es.mjs';

// xterm / prism are loaded as UMD globals via <script> tags (no ESM builds in npm packages)
const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;
const Prism = window.Prism;

// ---------- state ----------
let config = null;
let sessions = [];
let skills = [];
let plugins = [];
let projects = [];
let appEnv = null; // { version, platform, workspace, dataDir, electron } from main process
let currentId = null;
let streaming = false;
let currentRequestId = null; // legacy alias kept for abort; use streamCtx
let streamCtx = null; // active stream: { requestId, asstMsg, wrap, bubble, cursor }
let stopPending = false; // guards double-fires of the stop button (never disables sendBtn)
const DEFAULT_INPUT_PLACEHOLDER = 'Ask DeepSeek…  （Enter 发送 / Shift+Enter 换行）';
let lastRunId = 0;
let activityLog = []; // lines for the collapsible activity box above the composer
let activityExpanded = false;
let activityCollapseTimer = null;
let wsSearchQuery = '';
let skillMenuIndex = 0;
let skillMenuItems = [];

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const sessionListEl = $('sessionList');
const modelBadge = $('modelBadge');

// ---------- context detail popover (small box beside the ring, no page overlay) ----------
async function showContextPopover() {
  const s = currentSession();
  if (!s) return;
  const msgs = [];
  if (config.systemPrompt) msgs.push({ role: 'system', content: config.systemPrompt });
  for (const m of s.messages) msgs.push({ role: m.role, content: m.content });
  const p = currentProvider();
  const limit = contextLimitFor(p ? p.model : '');
  const detail = await window.dsh.context.detail(msgs);
  const total = detail.total || 0;
  const frac = Math.min(1, total / limit);
  const row = (label, val, color) => {
    const div = document.createElement('div');
    div.className = 'ctxRow';
    const top = document.createElement('div');
    top.className = 'ctxRowTop';
    const name = document.createElement('span');
    name.textContent = label;
    const num = document.createElement('span');
    num.className = 'ctxRowNum';
    num.textContent = `${val.toLocaleString()} (${((val / limit) * 100).toFixed(1)}%)`;
    top.append(name, num);
    const bar = document.createElement('div');
    bar.className = 'ctxBar';
    const fill = document.createElement('div');
    fill.className = 'ctxBarFill';
    fill.style.width = `${Math.min(100, (val / limit) * 100)}%`;
    fill.style.background = color;
    bar.append(fill);
    div.append(top, bar);
    return div;
  };
  const pop = $('ctxPopover');
  pop.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'ctxPopTitle';
  title.textContent = `📊 上下文占用 · ${p ? p.model : ''}`;
  pop.append(title);
  pop.append(row('🧠 系统提示词', detail.system, 'var(--accent2)'));
  pop.append(row('🛠 工具（' + detail.toolCount + '）', detail.tools, 'var(--green)'));
  pop.append(row('💬 对话（' + msgs.length + ' 条）', detail.messages, 'var(--amber)'));
  const totalRow = document.createElement('div');
  totalRow.className = 'ctxTotal';
  const color = frac > 0.9 ? 'var(--red)' : frac > 0.7 ? 'var(--amber)' : 'var(--green)';
  totalRow.innerHTML = `<b>合计</b> <span style="font-family:var(--mono);font-size:11px;color:${color}">${total.toLocaleString()} / ${limit.toLocaleString()} (${(frac * 100).toFixed(1)}%)</span>`;
  pop.append(totalRow);
  pop.classList.remove('hidden');
}

function closeContextPopover() {
  $('ctxPopover').classList.add('hidden');
}

// ---------- "/" skill menu ----------
function renderSkillMenuItems() {
  skillMenuIndex = 0;
  const menu = $('skillMenu');
  menu.classList.remove('hidden');
  menu.innerHTML = '';
  skillMenuItems.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'skillMenuItem' + (i === 0 ? ' selected' : '');
    const name = document.createElement('div');
    name.className = 'skillMenuName';
    name.textContent = '🎯 ' + s.name + (s.source === 'claude' ? ' (Claude)' : '');
    const desc = document.createElement('div');
    desc.className = 'skillMenuDesc';
    desc.textContent = (s.desc || '').slice(0, 60);
    item.append(name, desc);
    item.onclick = () => applySkillById(s.id);
    item.onmouseenter = () => {
      skillMenuIndex = i;
      renderSkillMenuSelection();
    };
    menu.append(item);
  });
}
function updateSkillMenu() {
  const input = inputEl.value;
  if (!input.startsWith('/') || input.length < 2) {
    closeSkillMenu();
    return;
  }
  const q = input.slice(1).toLowerCase();
  skillMenuItems = skills.filter((s) => {
    const hay = (s.name + ' ' + (s.desc || '')).toLowerCase();
    return hay.includes(q) || !q;
  }).slice(0, 12);
  if (!skillMenuItems.length) {
    closeSkillMenu();
    return;
  }
  renderSkillMenuItems();
}
function openSkillMenu() {
  skillMenuItems = skills.slice(0, 12);
  renderSkillMenuItems();
}

function renderSkillMenuSelection() {
  const items = document.querySelectorAll('#skillMenu .skillMenuItem');
  items.forEach((el, i) => el.classList.toggle('selected', i === skillMenuIndex));
}

function closeSkillMenu() {
  $('skillMenu').classList.add('hidden');
  $('skillMenu').innerHTML = '';
  skillMenuItems = [];
}

function applySkillById(id) {
  const s = skills.find((x) => x.id === id);
  if (!s) return;
  config.activeSkillId = s.id;
  window.dsh.config.set({ activeSkillId: s.id }).then((c) => { config = c; });
  inputEl.value = '';
  autoGrow();
  closeSkillMenu();
  renderSkillBadge();
  inputEl.focus();
  flashStatus('🎯 已启用技能：' + s.name);
}

function flashStatus(text) {
  const badge = modelBadge;
  const old = badge.textContent;
  badge.textContent = text;
  setTimeout(() => { badge.textContent = old; }, 2200);
}

// ---------- terminal ----------
const term = new Terminal({
  fontFamily: '"Cascadia Code", Consolas, monospace',
  fontSize: 13,
  theme: { background: '#0d1117', foreground: '#e6e9f0', cursor: '#4d6bfe' },
  convertEol: true
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
let termOpen = false;

function openTerminal() {
  $('terminalPanel').classList.remove('hidden');
  if (!termOpen) {
    term.open($('terminal'));
    termOpen = true;
  }
  requestAnimationFrame(() => fitAddon.fit());
}
function closeTerminal() {
  $('terminalPanel').classList.add('hidden');
}
function termWrite(text) {
  openTerminal();
  term.write(text.replace(/\n/g, '\r\n'));
}

// ---------- theme ----------
function applyTheme() {
  const t = config.theme || { mode: 'dark', accent: 'blue', uiFontSize: 14, codeFontSize: 13, opacity: 1, contrast: 1 };
  document.body.dataset.theme = t.mode;
  document.body.dataset.accent = t.accent || 'blue';
  document.body.style.fontSize = (t.uiFontSize || 14) + 'px';
  // custom background color overrides theme default
  if (t.bgColor) document.body.style.setProperty('--bg', t.bgColor);
  else document.body.style.removeProperty('--bg');
  // fonts
  if (t.uiFont) document.body.style.setProperty('--ui-font', t.uiFont);
  else document.body.style.removeProperty('--ui-font');
  if (t.codeFont) document.body.style.setProperty('--mono', t.codeFont);
  else document.body.style.removeProperty('--mono');
  document.body.style.setProperty('--code-font-size', (t.codeFontSize || 13) + 'px');
  // opacity & contrast
  document.body.style.opacity = String(t.opacity == null ? 1 : t.opacity);
  document.body.style.filter = `contrast(${t.contrast == null ? 1 : t.contrast})`;
  const light = t.mode === 'light' || t.mode === 'sky';
  term.options.theme = light
    ? { background: '#ffffff', foreground: '#24292f', cursor: '#4d6bfe' }
    : { background: '#0d1117', foreground: '#e6e9f0', cursor: (t.accent === 'blue' ? '#4d6bfe' : '#8b5cf6') };
}

// ---------- context window ring (token usage) ----------
const CONTEXT_LIMITS = {
  'deepseek-chat': 131072, 'deepseek-reasoner': 131072,
  'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'gpt-4.1-mini': 128000, 'gpt-4.1': 128000,
  'o1': 200000, 'o1-mini': 128000, 'o3': 200000, 'o3-mini': 200000,
  'claude-3-5-sonnet': 200000, 'claude-3-7-sonnet': 200000, 'claude-sonnet-4': 200000,
  'glm-4': 128000, 'glm-4-flash': 128000, 'glm-4-plus': 128000, 'glm-4-air': 128000,
  'qwen-plus': 131072, 'qwen-turbo': 131072, 'qwen-max': 131072, 'qwen-long': 10000000,
  'moonshot-v1-8k': 8192, 'moonshot-v1-32k': 32768, 'moonshot-v1-128k': 131072,
  'llama3.2': 131072, 'llama3.1': 131072, 'llama3': 8192,
  'gemini-1.5-pro': 2000000, 'gemini-1.5-flash': 1000000,
  'openrouter/auto': 128000
};
function contextLimitFor(model) {
  const m = model || '';
  if (CONTEXT_LIMITS[m]) return CONTEXT_LIMITS[m];
  for (const k of Object.keys(CONTEXT_LIMITS)) {
    if (m.includes(k) || k.includes(m)) return CONTEXT_LIMITS[k];
  }
  return 128000;
}
function estimateTokens(text) {
  if (!text) return 0;
  let ascii = 0, cjk = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else cjk++;
  }
  return Math.ceil(ascii / 4 + cjk * 0.75);
}
function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += 4 + estimateTokens(m.content || '');
  }
  return total;
}
function updateContextRing() {
  const s = currentSession();
  if (!s) return;
  const msgs = [];
  if (config.systemPrompt) msgs.push({ role: 'system', content: config.systemPrompt });
  for (const m of s.messages) msgs.push({ role: m.role, content: m.content });
  const p = currentProvider();
  const limit = contextLimitFor(p ? p.model : '');
  const used = estimateMessagesTokens(msgs);
  const frac = Math.min(1, used / limit);
  const arc = $('ctxRingArc');
  const label = $('ctxRingLabel');
  const C = 2 * Math.PI * 9;
  arc.setAttribute('stroke-dasharray', `${(frac * C).toFixed(1)} ${C.toFixed(1)}`);
  arc.setAttribute('stroke', frac > 0.9 ? 'var(--red)' : frac > 0.7 ? 'var(--amber)' : 'var(--green)');
  label.textContent = frac >= 0.1 ? `${Math.round(frac * 100)}%` : '<10%';
  $('ctxRingWrap').title = `上下文占用 ${used.toLocaleString()} / ${limit.toLocaleString()} tokens`;
  // numeric readout next to the badge
  const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  const ctxText = $('ctxText');
  ctxText.textContent = `📊 ${fmt(used)} / ${fmt(limit)} (${(frac * 100).toFixed(1)}%)`;
  ctxText.style.color = frac > 0.9 ? 'var(--red)' : frac > 0.7 ? 'var(--amber)' : 'var(--text-dim)';
}

// ---------- markdown rendering ----------
marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(src) {
  const raw = marked.parse(src || '');
  const clean = DOMPurify.sanitize(raw, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form', 'input']
  });
  const container = document.createElement('div');
  container.innerHTML = clean;
  container.querySelectorAll('pre > code').forEach((codeEl) => {
    try {
      const lang = (codeEl.className.match(/language-([\w-]+)/) || [])[1] || '';
      if (lang) {
        const grammar = Prism.languages[lang] || Prism.languages.markup;
        try { codeEl.innerHTML = Prism.highlight(codeEl.textContent, grammar, lang); } catch {}
      }
      const pre = codeEl.parentElement;
      const block = document.createElement('div');
      block.className = 'codeBlock';
      const header = document.createElement('div');
      header.className = 'codeHeader';
      const langSpan = document.createElement('span');
      langSpan.className = 'codeLang';
      langSpan.textContent = lang || 'text';
      const spacer = document.createElement('span');
      spacer.className = 'codeSpacer';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'codeBtn';
      copyBtn.textContent = 'copy';
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(codeEl.textContent);
        copyBtn.textContent = 'copied ✓';
        setTimeout(() => { copyBtn.textContent = 'copy'; }, 1200);
      };
      header.append(langSpan, spacer, copyBtn);
      if (['bash', 'powershell', 'cmd', 'shell', 'pwsh'].includes(lang)) {
        const runBtn = document.createElement('button');
        runBtn.className = 'codeBtn run';
        runBtn.textContent = '▶ run';
        runBtn.onclick = () => runCommand(codeEl.textContent, lang);
        header.insertBefore(runBtn, copyBtn);
      }
      block.append(header);
      pre.replaceWith(block);
      block.append(pre);
    } catch (err) {
      console.error('[codeBlock]', err);
    }
  });
  return container;
}

function newMessageEl(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const label = document.createElement('div');
  label.className = 'msgLabel';
  label.textContent = role === 'user' ? 'You' : 'DeepSeek';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  wrap.append(label, bubble);
  if (role === 'user') bubble.textContent = text;
  else bubble.append(renderMarkdown(text));
  messagesEl.append(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { wrap, bubble, cursor: null };
}

// thinking-process panel (collapsible, shown above assistant bubble)
function renderThinking(wrap, bubble, reasoning, live) {
  if (!reasoning) return null;
  const panel = document.createElement('div');
  panel.className = 'thinkPanel' + (live ? ' live' : ' collapsed');
  const head = document.createElement('div');
  head.className = 'thinkHead';
  const toggle = document.createElement('span');
  toggle.className = 'thinkToggle';
  toggle.textContent = live ? '思考中…' : '展开 ▾';
  const body = document.createElement('div');
  body.className = 'thinkBody';
  body.textContent = reasoning;
  head.textContent = '🧠 思考过程 ';
  head.append(toggle);
  head.onclick = () => {
    panel.classList.toggle('collapsed');
    toggle.textContent = panel.classList.contains('collapsed') ? '展开 ▾' : '收起 ▴';
  };
  panel.append(head, body);
  wrap.insertBefore(panel, bubble);
  return { panel, body };
}

// ---------- activity mini-box (above the composer, Claude Code style) ----------
// live tool calls + thinking stream into a collapsible 2-3 line box above the
// input; tool calls additionally leave a one-line chip inside the bubble.
function activityEls() {
  return { bar: $('activityBar'), status: $('activityStatus'), body: $('activityBody') };
}
function renderActivityBody() {
  const { body } = activityEls();
  if (!body) return;
  body.innerHTML = '';
  for (const a of activityLog) {
    const line = document.createElement('div');
    line.className = 'activityLine';
    line.textContent = (a.icon ? a.icon + ' ' : '') + (a.text || '');
    line.title = a.text || '';
    body.append(line);
  }
  body.scrollTop = body.scrollHeight;
}
function setActivityStatus(icon, text) {
  const { status } = activityEls();
  if (!status) return;
  status.innerHTML = '';
  const t = document.createElement('span');
  t.className = 'activityText';
  t.textContent = (icon ? icon + ' ' : '') + (text || '');
  status.append(t);
}
function showActivityBar() {
  const { bar } = activityEls();
  if (!bar) return;
  bar.classList.remove('hidden');
  bar.classList.remove('idle');
  clearTimeout(activityCollapseTimer);
}
function pushActivity(icon, text) {
  activityLog.push({ icon, text });
  if (activityLog.length > 50) activityLog.shift();
  renderActivityBody();
  setActivityStatus(icon, text);
  showActivityBar();
}
// update the line with this kind in place (streaming reasoning/text), or append
// a new one if none exists yet (each tool call uses its id as the kind)
function setActivityLine(kind, icon, text) {
  let line = activityLog.find((a) => a.kind === kind);
  if (!line) {
    activityLog.push({ kind, icon, text });
    if (activityLog.length > 50) activityLog.shift();
  } else {
    line.icon = icon;
    line.text = text;
  }
  renderActivityBody();
  setActivityStatus(icon, text);
  showActivityBar();
}
function clearActivity() {
  activityLog = [];
  activityExpanded = false;
  clearTimeout(activityCollapseTimer);
  const { bar, status, body } = activityEls();
  if (!bar) return;
  bar.classList.add('hidden');
  bar.classList.remove('expanded', 'idle');
  if (status) status.innerHTML = '';
  if (body) body.innerHTML = '';
}
function collapseActivity() {
  activityExpanded = false;
  const { bar } = activityEls();
  if (bar) bar.classList.remove('expanded');
}
function scheduleActivityCollapse(delayMs) {
  clearTimeout(activityCollapseTimer);
  activityCollapseTimer = setTimeout(() => {
    collapseActivity();
    const { bar } = activityEls();
    if (bar) bar.classList.add('idle');
  }, delayMs || 2500);
}
function shortTail(s, n) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  return str.length > n ? '…' + str.slice(-n) : str;
}

// ---------- subtask checklist panel ----------
// task lines are only collected outside fenced code blocks, so `- [ ]`
// inside code samples never becomes a subtask panel
function taskScan(content, fn) {
  const lines = String(content || '').split('\n');
  let inFence = false;
  const out = [];
  for (const ln of lines) {
    if (/^\s*```/.test(ln)) { inFence = !inFence; out.push(ln); continue; }
    const m = ln.match(/^\s*[-*]\s*\[([ xX])\]\s+(.+?)\s*$/);
    if (!inFence && m) {
      const keep = fn(m, ln);
      if (keep !== undefined) out.push(keep);
      continue;
    }
    out.push(ln);
  }
  return out;
}
function extractTasks(content) {
  const tasks = [];
  let saw = false;
  taskScan(content, (m) => {
    tasks.push({ done: m[1].toLowerCase() === 'x', text: m[2] });
    saw = true;
  });
  if (!saw) return null;
  return tasks.length >= 2 ? tasks : null;
}
function stripTasks(content, tasks) {
  if (!tasks) return content;
  let removed = 0;
  return taskScan(content, (m, ln) => {
    if (removed < tasks.length) { removed++; return undefined; }
    return ln;
  }).join('\n');
}
function renderAssistantBubble(bubble, content, chips) {
  bubble.innerHTML = '';
  const tasks = extractTasks(content);
  if (tasks) {
    const panel = document.createElement('div');
    panel.className = 'subtaskPanel';
    const head = document.createElement('div');
    head.className = 'subtaskHead';
    const icon = document.createElement('span');
    icon.textContent = '📋';
    const lbl = document.createElement('span');
    lbl.textContent = '子任务';
    const cnt = document.createElement('span');
    cnt.className = 'subtaskCount';
    cnt.textContent = tasks.length;
    const arrow = document.createElement('span');
    arrow.className = 'subtaskArrow';
    arrow.textContent = '▾';
    head.append(icon, lbl, cnt, arrow);
    const body = document.createElement('div');
    body.className = 'subtaskBody';
    for (const t of tasks) {
      const row = document.createElement('label');
      row.className = 'subtaskRow' + (t.done ? ' done' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = t.done;
      cb.onchange = () => row.classList.toggle('done', cb.checked);
      const tx = document.createElement('span');
      tx.className = 'subtaskText';
      tx.textContent = t.text;
      row.append(cb, tx);
      body.append(row);
    }
    head.onclick = () => {
      body.classList.toggle('hidden');
      arrow.textContent = body.classList.contains('hidden') ? '▸' : '▾';
    };
    panel.append(head, body);
    bubble.append(panel);
  }
  const md = renderMarkdown(stripTasks(content, tasks));
  if (md) bubble.append(md);
  if (chips && chips.length) renderToolChips(bubble, chips);
}

function addCursor(bubble) {
  const c = document.createElement('span');
  c.className = 'cursorBlink';
  bubble.append(c);
  return c;
}

// ---------- one-line tool chips (persisted in the assistant bubble) ----------
function renderToolChips(bubble, toolCalls) {
  if (!bubble) return;
  let wrap = bubble.querySelector('.toolChips');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toolChips';
    bubble.prepend(wrap);
  }
  wrap.innerHTML = '';
  for (const tc of toolCalls || []) {
    const chip = document.createElement('div');
    chip.className = 'toolChip' + (tc.ok ? ' done' : '');
    chip.title = tc.status || '';
    const nm = document.createElement('span');
    nm.className = 'tcName';
    nm.textContent = tc.name;
    const st = document.createElement('span');
    st.className = 'tcStatus';
    st.textContent = tc.ok ? '✓' : (tc.status || '');
    chip.append('🔧 ', nm, st);
    wrap.append(chip);
  }
}
function ensureToolChip(toolId, name, statusText, ok) {
  const s = streamCtx;
  if (!s) return;
  const calls = (s.asstMsg.toolCalls = s.asstMsg.toolCalls || []);
  let entry = calls.find((t) => t.id === toolId);
  if (!entry) calls.push({ id: toolId, name, status: statusText, ok: !!ok });
  else { entry.name = name; entry.status = statusText; entry.ok = !!ok; }
  if (s.bubble) renderToolChips(s.bubble, calls);
}
function updateToolChip(toolId, statusText, ok) {
  const s = streamCtx;
  if (!s) return;
  const entry = (s.asstMsg.toolCalls || []).find((t) => t.id === toolId);
  if (entry) { entry.status = statusText; entry.ok = !!ok; }
  if (s.bubble) renderToolChips(s.bubble, s.asstMsg.toolCalls);
}

// ---------- custom prompt (Electron has no window.prompt) ----------
function customPrompt(title, placeholder, def) {
  return new Promise((resolve) => {
    $('promptTitle').textContent = title;
    $('promptInput').placeholder = placeholder || '';
    $('promptInput').value = def || '';
    $('promptModal').classList.remove('hidden');
    setTimeout(() => $('promptInput').focus(), 50);
    const done = (val) => {
      $('promptModal').classList.add('hidden');
      $('promptInput').onkeydown = null;
      resolve(val);
    };
    $('promptOk').onclick = () => done($('promptInput').value.trim());
    $('promptCancel').onclick = () => done(null);
    $('promptInput').onkeydown = (e) => {
      if (e.key === 'Enter') done($('promptInput').value.trim());
      else if (e.key === 'Escape') done(null);
    };
  });
}

// ---------- custom confirm (native confirm() can flash/close instantly in Electron) ----------
let confirmActive = false; // singleton: only one confirm dialog at a time
function customConfirm(title, message, okLabel, danger) {
  return new Promise((resolve) => {
    if (confirmActive) { resolve(false); return; }
    confirmActive = true;
    const modal = document.createElement('div');
    modal.className = 'modal';
    const card = document.createElement('div');
    card.className = 'modalCard';
    card.style.width = '420px';
    const t = document.createElement('h2');
    t.style.cssText = 'margin:0;font-size:15px;';
    t.textContent = title || '确认';
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:13px;line-height:1.8;color:var(--text);white-space:pre-wrap;word-break:break-word;user-select:text;';
    msg.textContent = message || '';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:4px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'barBtn';
    cancelBtn.textContent = '取消';
    const okBtn = document.createElement('button');
    okBtn.className = 'barBtn' + (danger ? ' danger' : '');
    okBtn.textContent = okLabel || '确定';
    actions.append(cancelBtn, okBtn);
    card.append(t, msg, actions);
    modal.append(card);
    document.body.append(modal);
    let settled = false;
    let armed = false; // ignore clicks/keys for the first 250 ms (prevents double-click / stray event from closing the dialog instantly)
    const armTimer = setTimeout(() => { armed = true; }, 250);
    const onKey = (e) => {
      if (!armed || settled) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
    };
    const done = (v) => {
      if (settled) return;
      settled = true;
      confirmActive = false;
      clearTimeout(armTimer);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('unload', onUnload);
      modal.remove();
      resolve(v);
    };
    const onUnload = () => done(false);
    const onBg = (e) => { if (armed && !settled && e.target === modal) done(false); };
    cancelBtn.onclick = (e) => { e.stopPropagation(); done(false); };
    okBtn.onclick = (e) => { e.stopPropagation(); done(true); };
    modal.addEventListener('click', onBg);
    // capture-phase keydown so page-level shortcuts cannot swallow Escape
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('unload', onUnload);
    // focus the safe button: cancel by default for dangerous actions (prevents Enter from deleting accidentally)
    const focusTarget = danger ? cancelBtn : okBtn;
    setTimeout(() => { if (!settled) focusTarget.focus(); }, 260);
  });
}

// ---------- projects ----------
function currentProject() {
  return projects.find((p) => p.id === (config.activeProjectId || '')) || projects[0] || null;
}

// 新建项目统一放到主进程工作区（与 sandbox 一致；原来硬编码 D 盘与 C 盘工作区不一致导致目录错位）
function projectRoot() {
  return (appEnv && appEnv.workspace) || 'D:\\DeepSeek工作区';
}

async function newProject() {
  const root = projectRoot();
  const name = await customPrompt('新建项目', `项目名称（将创建空白文件夹：${root}\\<名称>）`, '');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  const id = 'proj-' + Date.now();
  const folderPath = root + '\\' + trimmed;
  const res = await window.dsh.projects.createFolder(folderPath);
  const project = { id, name: trimmed, path: res.ok ? folderPath : '', createdAt: Date.now() };
  projects.push(project);
  await window.dsh.projects.save(projects);
  config = await window.dsh.config.set({ activeProjectId: id });
  renderSessionList();
  if (!res.ok) {
    alert('创建文件夹失败（' + (res.error || '未知') + '），但项目已创建为逻辑项目');
  }
}

// ---------- sessions ----------
function currentSession() {
  return sessions.find((s) => s.id === currentId) || null;
}
function persist() {
  window.dsh.sessions.save(sessions);
}
function matchesSearch(s, q) {
  if (!q) return true;
  const hay = (s.title || '') + ' ' + s.messages.map((m) => m.content || '').join(' ');
  return hay.toLowerCase().includes(q.toLowerCase());
}
// ---------- view options ----------
function viewState() {
  return {
    groupBy: (config && config.view && config.view.groupBy) || 'project',
    sortBy: (config && config.view && config.view.sortBy) || 'recent'
  };
}
function renderViewMenu() {
  const view = viewState();
  document.querySelectorAll('#viewMenu .viewOpt').forEach((b) => {
    b.classList.toggle('active', view[b.dataset.view] === b.dataset.val);
  });
}
function sortSessions(items, sortBy) {
  if (sortBy !== 'recent') return items; // manual: keep array order
  return [...items].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}
function touchSession(s) {
  s.updatedAt = Date.now();
}
function renderSessionList() {
  sessionListEl.innerHTML = '';
  const q = wsSearchQuery;
  const view = viewState();
  // search mode: flat results across projects
  if (q) {
    const hits = sortSessions(sessions.filter((s) => !s.archived && matchesSearch(s, q)), view.sortBy);
    for (const s of hits) {
      const item = sessionItemEl(s);
      sessionListEl.append(item);
    }
    if (!hits.length) {
      const empty = document.createElement('div');
      empty.className = 'pluginDesc';
      empty.textContent = '未找到匹配的对话';
      sessionListEl.append(empty);
    }
    return;
  }
  const visible = sessions.filter((s) => !s.archived);
  // flat list (单列表): no project grouping
  if (view.groupBy === 'flat') {
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'pluginDesc';
      empty.textContent = '暂无对话，点击上方 ＋ New chat 开始';
      sessionListEl.append(empty);
      return;
    }
    for (const s of sortSessions(visible, view.sortBy)) {
      sessionListEl.append(sessionItemEl(s));
    }
    return;
  }
  // group by project（空项目也显示，保证新建项目立即可见）
  // 只显示归属于该项目的会话；无归属会话（含网页版遗留/被删项目）一律进"未分组"，
  // 不再被第一个项目组吸收，避免无关对话混入新项目
  const groups = [];
  const knownIds = new Set(projects.map((p) => p.id));
  for (const p of projects) {
    const items = sortSessions(visible.filter((s) => s.projectId === p.id), view.sortBy);
    groups.push({ project: p, items });
  }
  // sessions whose project folder was deleted (or never had one) land in 未分组
  const orphans = visible.filter((s) => !s.projectId || !knownIds.has(s.projectId));
  if (orphans.length) groups.unshift({ project: null, items: sortSessions(orphans, view.sortBy) });
  for (const g of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'projectGroup';
    const isActive = g.project && currentProject() && g.project.id === currentProject().id;
    const head = document.createElement('div');
    head.className = 'projectHead' + (g.project && g.project.collapsed ? ' collapsed' : '') + (isActive ? ' active' : '');
    const arrow = document.createElement('span');
    arrow.className = 'projectArrow';
    arrow.textContent = g.project && g.project.collapsed ? '▸' : '▾';
    const label = document.createElement('span');
    label.className = 'projectLabel';
    label.textContent = (g.project ? '📁 ' + g.project.name : '📂 未分组');
    const count = document.createElement('span');
    count.className = 'projectCount';
    count.textContent = g.items.length;
    head.append(arrow, label, count);
    if (g.project) {
      // project actions: archive all / delete project (always visible)
      const archAll = document.createElement('button');
      archAll.className = 'sessionDel';
      archAll.title = '归档项目（项目下所有对话归档）';
      archAll.textContent = '📦';
      archAll.onclick = async (ev) => {
        ev.stopPropagation();
        const ok = await customConfirm('归档项目', `归档项目「${g.project.name}」？\n项目下所有对话将移入归档库。`, '归档');
        if (!ok) return;
        archiveProjectSessions(g.project.id);
      };
      const delProj = document.createElement('button');
      delProj.className = 'sessionDel';
      delProj.title = '删除项目（含所有对话）';
      delProj.textContent = '🗑';
      delProj.onclick = (ev) => {
        ev.stopPropagation();
        deleteProject(g.project.id);
      };
      const acts = document.createElement('span');
      acts.className = 'projectActions';
      acts.append(archAll, delProj);
      head.append(acts);
      // click head: collapse toggle + sync active project to composer selector
      head.onclick = async () => {
        g.project.collapsed = !g.project.collapsed;
        window.dsh.projects.save(projects);
        if (config.activeProjectId !== g.project.id) {
          config = await window.dsh.config.set({ activeProjectId: g.project.id });
        }
        renderSessionList();
      };
    }
    groupEl.append(head);
    if (!g.project || !g.project.collapsed) {
      if (g.items.length) {
        for (const s of g.items) {
          groupEl.append(sessionItemEl(s));
        }
      } else if (g.project) {
        const empty = document.createElement('div');
        empty.className = 'pluginDesc';
        empty.style.cssText = 'padding:3px 10px 6px;font-size:11px;color:var(--text-dim);';
        empty.textContent = '（暂无对话）';
        groupEl.append(empty);
      }
    }
    sessionListEl.append(groupEl);
  }
}

function archiveProjectSessions(projectId) {
  let changed = false;
  for (const s of sessions) {
    if (s.projectId === projectId && !s.archived) {
      s.archived = true;
      changed = true;
    }
  }
  if (!changed) return;
  if (currentId && sessions.find((x) => x.id === currentId)?.archived) {
    const next = sessions.find((x) => !x.archived);
    currentId = next ? next.id : newSession();
  }
  persist();
  renderSessionList();
  renderMessages();
  renderArchiveList();
}

async function deleteProject(projectId) {
  const p = projects.find((x) => x.id === projectId);
  if (!p) return;
  const loc = p.path ? `\n路径：${p.path}` : '';
  const ok = await customConfirm('删除项目', `删除项目「${p.name}」？${loc}\n项目文件夹和项目下所有对话将被永久删除，此操作不可撤销。`, '删除', true);
  if (!ok) return;
  if (p.path) {
    const res = await window.dsh.projects.deleteFolder(p.path);
    if (!res.ok) alert('项目文件夹删除失败（' + (res.error || '未知') + '）。\n项目记录已删除，请手动清理该文件夹。');
  }
  projects = projects.filter((x) => x.id !== projectId);
  await window.dsh.projects.save(projects);
  sessions = sessions.filter((s) => s.projectId !== projectId);
  if (currentId && !sessions.find((x) => x.id === currentId)) {
    const next = sessions.find((x) => !x.archived);
    currentId = next ? next.id : newSession();
  }
  if (config.activeProjectId === projectId) {
    const next = projects[0] || null;
    config = await window.dsh.config.set({ activeProjectId: next ? next.id : '' });
  }
  persist();
  renderSessionList();
  renderMessages();
  renderArchiveList();
}

function sessionItemEl(s) {
  const item = document.createElement('div');
  item.className = 'sessionItem' + (s.id === currentId ? ' active' : '');
  const title = document.createElement('span');
  title.className = 'sessionTitle';
  title.textContent = s.title || 'New chat';
  const arch = document.createElement('button');
  arch.className = 'sessionDel';
  arch.title = '归档此会话';
  arch.textContent = '📦';
  arch.onclick = (ev) => {
    ev.stopPropagation();
    archiveSession(s.id);
  };
  const del = document.createElement('button');
  del.className = 'sessionDel';
  del.textContent = '✕';
  del.onclick = (ev) => {
    ev.stopPropagation();
    sessions = sessions.filter((x) => x.id !== s.id);
    if (currentId === s.id) {
      const next = sessions.find((x) => !x.archived);
      currentId = next ? next.id : newSession();
    }
    persist();
    renderSessionList();
    renderMessages();
  };
  item.append(title, arch, del);
  item.onclick = () => {
    if (currentId === s.id) return;
    currentId = s.id;
    renderSessionList();
    renderMessages();
  };
  // manual sort: drag & drop reorder (persisted array order)
  if (viewState().sortBy === 'manual') {
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', s.id);
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', (e) => e.preventDefault());
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');
      if (!id || id === s.id) return;
      const from = sessions.findIndex((x) => x.id === id);
      const to = sessions.findIndex((x) => x.id === s.id);
      if (from < 0 || to < 0) return;
      const [moved] = sessions.splice(from, 1);
      const to2 = sessions.findIndex((x) => x.id === s.id);
      sessions.splice(to2 < 0 ? to : to2, 0, moved);
      persist();
      renderSessionList();
    });
  }
  return item;
}

function archiveSession(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  s.archived = true;
  if (currentId === id) {
    const next = sessions.find((x) => !x.archived && x.id !== id);
    currentId = next ? next.id : (sessions.find((x) => !x.archived) ? sessions.find((x) => !x.archived).id : newSession());
  }
  persist();
  renderSessionList();
  renderMessages();
  renderArchiveList();
}

function renderArchiveList() {
  const list = $('archiveList');
  if (!list) return;
  list.innerHTML = '';
  const archived = sessions.filter((s) => s.archived);
  if (!archived.length) {
    const empty = document.createElement('div');
    empty.className = 'pluginDesc';
    empty.textContent = '暂无已归档会话';
    list.append(empty);
    return;
  }
  for (const s of archived) {
    const row = document.createElement('div');
    row.className = 'pluginRow';
    const head = document.createElement('div');
    head.className = 'pluginHead';
    const name = document.createElement('div');
    name.className = 'pluginName';
    name.textContent = s.title || 'New chat';
    const desc = document.createElement('div');
    desc.className = 'pluginDesc';
    const lastMsg = s.messages[s.messages.length - 1];
    desc.textContent = `消息 ${s.messages.length} 条 · 最后：${lastMsg ? (lastMsg.content || '').slice(0, 60) : ''}`;
    head.append(name, desc);
    const actions = document.createElement('div');
    actions.className = 'pluginActions';
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'barBtn';
    restoreBtn.textContent = '↩ 恢复';
    restoreBtn.onclick = () => {
      s.archived = false;
      persist();
      renderArchiveList();
      renderSessionList();
      currentId = s.id;
      renderMessages();
    };
    const delBtn = document.createElement('button');
    delBtn.className = 'barBtn danger';
    delBtn.textContent = '🗑 删除';
    delBtn.onclick = async () => {
      const ok = await customConfirm('删除归档会话', `永久删除归档会话「${s.title || 'New chat'}」？`, '删除', true);
      if (!ok) return;
      sessions = sessions.filter((x) => x.id !== s.id);
      persist();
      renderArchiveList();
      renderSessionList();
    };
    actions.append(restoreBtn, delBtn);
    row.append(head, actions);
    list.append(row);
  }
}
function newSession() {
  const p = currentProject();
  const s = { id: 's' + Date.now(), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), projectId: p ? p.id : '', messages: [] };
  sessions.push(s);
  currentId = s.id;
  persist();
  renderSessionList();
  renderMessages();
  return s.id;
}
function ensureSession() {
  if (!currentSession()) newSession();
  return currentSession();
}
function renderMessages() {
  messagesEl.innerHTML = '';
  const s = currentSession();
  if (!s) return;
  for (const m of s.messages) {
    const { wrap, bubble } = newMessageEl(m.role, m.content);
    if (m.role === 'assistant') {
      const vis = reasoningVisible(m.reasoning);
      if (vis) renderThinking(wrap, bubble, vis, false);
      renderAssistantBubble(bubble, m.content, m.toolCalls);
    }
  }
  updateContextRing();
  if (!s.messages.length) {
    const hint = document.createElement('div');
    hint.style.cssText = 'margin:auto;text-align:center;color:#5a6578;font-size:13px;line-height:2;user-select:none;';
    hint.innerHTML = '🐋 Welcome to <b style="color:#8b93a7">DeepSeek Desktop</b><br>Ask me anything — 我可以用技能和插件工具帮你干活';
    messagesEl.append(hint);
  }
}

// ---------- chat ----------
let activeStreamError = null;

function buildMessages() {
  const s = ensureSession();
  const msgs = [];
  if (config.systemPrompt) msgs.push({ role: 'system', content: config.systemPrompt });
  for (const m of s.messages) msgs.push({ role: m.role, content: m.content });
  return msgs;
}

async function sendMessage() {
  if (streaming) { injectInstruction(); return; }
  const text = inputEl.value.trim();
  if (!text) return;
  const s = ensureSession();
  s.messages.push({ role: 'user', content: text });
  touchSession(s);
  inputEl.value = '';
  autoGrow();
  if (s.title === 'New chat') {
    s.title = text.slice(0, 42);
    renderSessionList();
  }
  persist();
  newMessageEl('user', text);
  updateContextRing();

  const { wrap, bubble } = newMessageEl('assistant', '');
  const cursor = addCursor(bubble);
  clearActivity();
  streaming = true;
  stopPending = false;
  $('sendBtn').classList.add('running');
  $('sendBtn').textContent = '■ stop';
  $('sendBtn').title = '停止当前任务';
  inputEl.placeholder = '运行中… 输入新指令直接回车即可注入，指导任务走向';
  setActivityLine('think', '🧠', '思考中…');

  const requestId = 'r' + Date.now();
  activeStreamError = null;
  const asstMsg = { role: 'assistant', content: '', reasoning: '', toolCalls: [] };
  s.messages.push(asstMsg);
  streamCtx = { requestId, asstMsg, wrap, bubble, cursor };

  // finalization is driven by the "done" chunk, not by the invoke promise,
  // because IPC event delivery order vs. invoke resolution is not guaranteed
  window.dsh.chat.start({
    requestId,
    messages: buildMessages(),
    providerId: config.activeProviderId,
    temperature: config.temperature,
    skillId: config.activeSkillId || 'default',
    useTools: true
  }).catch((e) => {
    if (streamCtx && streamCtx.requestId === requestId) {
      activeStreamError = String(e.message || e);
      finishStream();
    }
  });
}

// mid-run steering: the user pressed Enter with new text while a task is streaming.
// Queue it via chat:inject; main soft-interrupts the current tool round so the model
// redirects toward the new instruction instead of finishing the old plan.
function injectInstruction() {
  const text = inputEl.value.trim();
  if (!text || !streaming || !streamCtx) return;
  const s = currentSession();
  if (s) {
    s.messages.push({ role: 'user', content: text, injected: true });
    touchSession(s);
    persist();
  }
  newMessageEl('user', text);
  inputEl.value = '';
  autoGrow();
  setActivityLine('inject', '📨', '已注入指令，模型正在切换方向…');
  flashStatus('📨 已注入指令');
  window.dsh.chat.inject(streamCtx.requestId, text).then((r) => {
    if (r && !r.ok) flashStatus('⚠ 注入失败：' + (r.error || '运行已结束'));
  });
}

// freeze the current partial assistant turn into its final rendered bubble, then open a
// fresh assistant bubble for the model's redirected reply. The partial turn is ALREADY in
// s.messages (pushed by sendMessage) and must not be re-pushed.
function finalizePartialAssistant() {
  if (!streamCtx) return;
  const { requestId, asstMsg, wrap, bubble, cursor } = streamCtx;
  cursor.remove();
  const vis = reasoningVisible(asstMsg.reasoning);
  if (vis) renderThinking(wrap, bubble, vis, false);
  renderAssistantBubble(bubble, asstMsg.content, asstMsg.toolCalls);
  const s = currentSession();
  if (s) touchSession(s);
  const fresh = { role: 'assistant', content: '', reasoning: '', toolCalls: [] };
  if (s) s.messages.push(fresh);
  const { wrap: wrap2, bubble: bubble2 } = newMessageEl('assistant', '');
  const cursor2 = addCursor(bubble2);
  streamCtx = { requestId, asstMsg: fresh, wrap: wrap2, bubble: bubble2, cursor: cursor2 };
  updateContextRing();
  persist();
}

function finishStream() {
  if (!streamCtx) return;
  const { asstMsg, wrap, bubble, cursor } = streamCtx;
  streamCtx = null;
  streaming = false;
  cursor.remove();
  scheduleActivityCollapse(3000);
  if (!activeStreamError) {
    const finalText = asstMsg.content;
    const vis = reasoningVisible(asstMsg.reasoning);
    if (vis) renderThinking(wrap, bubble, vis, false);
    renderAssistantBubble(bubble, finalText, asstMsg.toolCalls);
    asstMsg.content = finalText;
    const s = currentSession();
    if (s) touchSession(s);
    persist();
  }
  stopPending = false;
  $('sendBtn').classList.remove('running');
  $('sendBtn').textContent = 'Send ↵';
  $('sendBtn').title = '';
  inputEl.placeholder = DEFAULT_INPUT_PLACEHOLDER;
  renderSessionList();
  updateContextRing();
}

window.dsh.chat.onChunk(async ({ requestId, text, done, error, tool, reasoning, injected }) => {
  if (!streamCtx || requestId !== streamCtx.requestId) return;
  if (reasoning) {
    streamCtx.asstMsg.reasoning = (streamCtx.asstMsg.reasoning || '') + reasoning;
    setActivityLine('think', '🧠', '思考 ' + shortTail(reasoning, 46));
    return;
  }
  if (error) {
    activeStreamError = error;
    const s = currentSession();
    if (s) {
      const last = s.messages[s.messages.length - 1];
      if (last && last.role === 'assistant' && last.content === '') s.messages.pop();
    }
    const bubble = streamCtx.bubble;
    bubble.innerHTML = '';
    const errEl = document.createElement('div');
    errEl.style.cssText = 'color:var(--red);font-family:var(--mono);font-size:12.5px;white-space:pre-wrap;';
    errEl.textContent = '⚠ ' + error;
    bubble.append(errEl);
    finishStream();
    return;
  }
  if (tool) {
    const s = streamCtx;
    const argStr = tool.args && tool.args.command ? tool.args.command : (tool.args && tool.args.path ? tool.args.path : '');
    if (tool.status === 'start') {
      setActivityLine('tool:' + tool.id, '🔧', tool.name + ' 运行中' + (argStr ? ' · ' + shortTail(argStr, 36) : ''));
      ensureToolChip(tool.id, tool.name, '运行中', false);
    } else if (tool.status === 'confirm') {
      setActivityLine('tool:' + tool.id, '🔧', tool.name + ' 等待确认');
      updateToolChip(tool.id, '等待确认', false);
      const ok = await customConfirm('工具执行确认', `AI 想执行工具「${tool.name}」\n\n${argStr ? argStr.slice(0, 200) : ''}\n\n允许吗？`, '允许');
      window.dsh.tool.confirmReply(requestId, ok);
      if (!ok) {
        setActivityLine('tool:' + tool.id, '🔧', tool.name + ' 已拒绝');
        updateToolChip(tool.id, '已拒绝', false);
      }
    } else if (tool.status === 'done') {
      setActivityLine('tool:' + tool.id, '🔧', tool.name + ' ✓' + (tool.summary ? ' ' + tool.summary : ''));
      updateToolChip(tool.id, '✓', true);
      if (s) setActivityStatus('✅', '工具完成，继续处理');
    }
    return;
  }
  if (injected !== undefined) {
    finalizePartialAssistant();
    setActivityLine('inject', '📨', '已注入指令，模型正在切换方向…');
    return;
  }
  if (text) {
    if (!streamCtx.asstMsg.reasoning) {
      activityLog = activityLog.filter((a) => a.kind !== 'think');
    }
    setActivityLine('gen', '✍️', '生成回复 ' + shortTail(text, 46));
    streamCtx.asstMsg.content += text;
    const bubble = streamCtx.bubble;
    if (bubble) {
      const cursor = bubble.querySelector('.cursorBlink');
      renderAssistantBubble(bubble, streamCtx.asstMsg.content, streamCtx.asstMsg.toolCalls);
      if (cursor) bubble.append(cursor);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    updateContextRing();
    return;
  }
  if (done) {
    const nTools = (streamCtx.asstMsg.toolCalls || []).length;
    pushActivity('✅', '完成' + (nTools ? ' · ' + nTools + ' 次工具调用' : ''));
    const s = currentSession();
    if (s) persist();
    finishStream();
  }
});

// ---------- shell ----------
async function runCommand(cmd, lang) {
  const ok = await customConfirm('运行命令', 'Run this command in the terminal?\n\n' + cmd.slice(0, 300) + (cmd.length > 300 ? '…' : ''), '运行');
  if (!ok) return;
  const id = 'run' + (++lastRunId);
  $('termStatus').textContent = 'running…';
  $('termStatus').className = 'termStatus running';
  termWrite('\x1b[36m$ ' + cmd + '\x1b[0m\r\n');
  const info = await window.dsh.app.info();
  const res = await window.dsh.shell.exec(id, cmd, info.workspace);
  if (!res.ok) {
    $('termStatus').textContent = 'error';
    $('termStatus').className = 'termStatus error';
    termWrite('\r\n\x1b[31m[failed to start]\x1b[0m\r\n');
  }
  window.dsh.shell.onData(({ id: rid, stream, data }) => {
    if (rid !== id) return;
    termWrite(data);
  });
  window.dsh.shell.onDone(({ id: rid, code, error }) => {
    if (rid !== id) return;
    if (error) {
      $('termStatus').textContent = 'error';
      $('termStatus').className = 'termStatus error';
      termWrite('\r\n\x1b[31m' + error + '\x1b[0m\r\n');
    } else {
      $('termStatus').textContent = code === 0 ? 'done (exit 0)' : `exit ${code}`;
      $('termStatus').className = 'termStatus' + (code === 0 ? '' : ' error');
      termWrite('\r\n\x1b[2m[exit ' + code + ']\x1b[0m\r\n');
    }
  });
}

// ---------- settings: tabs ----------
const tabButtons = document.querySelectorAll('.tabBtn');
tabButtons.forEach((btn) => {
  btn.onclick = () => {
    tabButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tabPane').forEach((p) => p.classList.add('hidden'));
    $('tab-' + btn.dataset.tab).classList.remove('hidden');
  };
});

// ---------- settings: providers ----------
function currentProvider() {
  return (config.providers || []).find((p) => p.id === config.activeProviderId) || (config.providers || [])[0] || null;
}
function renderProviderSelect() {
  const sel = $('setProvider');
  sel.innerHTML = '';
  for (const p of config.providers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.append(opt);
  }
  sel.value = config.activeProviderId;
}
function fillProviderForm(p) {
  $('pvName').value = p.name || '';
  $('pvBaseUrl').value = p.baseUrl || '';
  $('pvApiKey').value = p.apiKey || '';
  $('pvModel').value = p.model || '';
  $('pvThinking').value = (p.modelThinking || {})[p.model || ''] || 'medium';
  $('pvModels').value = (p.models || []).join('\n');
  const dl = $('pvModelList');
  dl.innerHTML = '';
  for (const m of p.models || []) {
    const opt = document.createElement('option');
    opt.value = m;
    dl.append(opt);
  }
  $('pvTestResult').textContent = '';
  $('pvTestResult').className = 'pvTestResult';
}
function readProviderForm() {
  const model = $('pvModel').value.trim();
  return {
    name: $('pvName').value.trim() || '未命名 API',
    baseUrl: $('pvBaseUrl').value.trim(),
    apiKey: $('pvApiKey').value.trim(),
    model,
    models: $('pvModels').value.split('\n').map((s) => s.trim()).filter(Boolean)
  };
}
async function openSettings() {
  renderProviderSelect();
  fillProviderForm(currentProvider() || {});
  $('setTemp').value = config.temperature;
  $('setSysPrompt').value = config.systemPrompt;
  $('settingsStatus').textContent = '';
  // appearance
  const t = config.theme || {};
  $('setThemeMode').value = t.mode || 'dark';
  $('setUiFontSize').value = String(t.uiFontSize || 14);
  $('setCodeFontSize').value = String(t.codeFontSize || 13);
  $('setUiFont').value = t.uiFont || '';
  $('setCodeFont').value = t.codeFont || '';
  $('setBgColor').value = t.bgColor || '';
  $('setOpacity').value = Math.round((t.opacity == null ? 1 : t.opacity) * 100);
  $('opacityVal').textContent = $('setOpacity').value + '%';
  $('setContrast').value = Math.round((t.contrast == null ? 1 : t.contrast) * 100);
  $('contrastVal').textContent = $('setContrast').value + '%';
  document.querySelectorAll('.accentSwatch').forEach((s) => {
    s.classList.toggle('active', s.dataset.accent === (t.accent || 'blue'));
  });
  // config tab
  document.querySelectorAll('input[name="approvalPolicy"]').forEach((r) => {
    r.checked = r.value === (config.approvalPolicy || 'smart');
  });
  $('setWorkspace').value = (config.sandbox && config.sandbox.workspace) || '';
  $('setRestrictTools').checked = !(config.sandbox && config.sandbox.restrictTools === false);
  $('setReasoningDisplay').value = config.reasoningDisplay || 'full';
  $('setVerbosity').value = config.verbosity || 'standard';
  // personal tab
  $('setCustomInstructions').value = config.customInstructions || '';
  $('setMemoryMode').value = (config.memory && config.memory.enabled) ? 'manual' : 'off';
  $('setMemoryContent').value = (config.memory && config.memory.content) || '';
  $('setPersona').value = config.persona || 'pragmatic';
  // skills
  renderActiveSkillSelect();
  renderSkillList();
  // plugins
  $('setAutoRunTools').value = String(config.autoRunTools !== false);
  renderPluginList();
  // archived
  renderArchiveList();
  $('settingsModal').classList.remove('hidden');
}
async function saveSettings() {
  const pv = readProviderForm();
  const providerId = $('setProvider').value;
  const providers = config.providers.map((p) => {
    if (p.id !== providerId) return p;
    const modelThinking = { ...(p.modelThinking || {}) };
    modelThinking[pv.model || p.model || ''] = $('pvThinking').value;
    return { ...p, ...pv, modelThinking };
  });
  const theme = {
    mode: $('setThemeMode').value,
    accent: document.querySelector('.accentSwatch.active')?.dataset.accent || 'blue',
    uiFontSize: parseInt($('setUiFontSize').value, 10) || 14,
    codeFontSize: parseInt($('setCodeFontSize').value, 10) || 13,
    uiFont: $('setUiFont').value,
    codeFont: $('setCodeFont').value,
    bgColor: $('setBgColor').value,
    opacity: (parseInt($('setOpacity').value, 10) || 100) / 100,
    contrast: (parseInt($('setContrast').value, 10) || 100) / 100
  };
  const approvalPolicy = document.querySelector('input[name="approvalPolicy"]:checked')?.value || 'smart';
  const patch = {
    activeProviderId: providerId,
    providers,
    temperature: parseFloat($('setTemp').value) || 0.7,
    systemPrompt: $('setSysPrompt').value,
    theme,
    activeSkillId: $('setActiveSkill').value || config.activeSkillId,
    autoRunTools: $('setAutoRunTools').value === 'true',
    approvalPolicy,
    sandbox: {
      workspace: $('setWorkspace').value.trim() || config.sandbox.workspace,
      restrictTools: $('setRestrictTools').checked
    },
    reasoningDisplay: $('setReasoningDisplay').value,
    verbosity: $('setVerbosity').value,
    customInstructions: $('setCustomInstructions').value,
    memory: {
      enabled: $('setMemoryMode').value === 'manual',
      content: $('setMemoryContent').value
    },
    persona: $('setPersona').value
  };
  config = await window.dsh.config.set(patch);
  applyTheme();
  updateModelBadge();
  renderComposerControls();
  renderSkillBadge();
  $('settingsStatus').textContent = 'saved ✓';
  setTimeout(() => $('settingsModal').classList.add('hidden'), 500);
}
function updateModelBadge() {
  const p = currentProvider();
  modelBadge.textContent = p ? `${p.name} · ${p.model || '?'}` : 'no provider';
}

// composer quick controls: model / thinking level / approval policy
function renderComposerControls() {
  const p = currentProvider();
  const msel = $('composerModel');
  msel.innerHTML = '';
  const models = (p && p.models && p.models.length) ? p.models : (p && p.model ? [p.model] : []);
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    msel.append(opt);
  }
  if (p && p.model && !models.includes(p.model)) {
    const opt = document.createElement('option');
    opt.value = p.model;
    opt.textContent = p.model + '（自定义）';
    msel.append(opt);
  }
  msel.value = p ? p.model : '';
  $('composerThinking').value = (p && (p.modelThinking || {})[p.model || '']) || 'medium';
  $('approvalBadge').value = config.approvalPolicy || 'smart';
}

function reasoningVisible(reasoning) {
  const mode = config.reasoningDisplay || 'full';
  if (mode === 'off' || !reasoning) return null;
  if (mode === 'summary') {
    const s = String(reasoning);
    return s.length > 200 ? s.slice(0, 200) + '…（摘要）' : s;
  }
  return reasoning;
}
async function addProvider() {
  const id = 'custom-' + Date.now();
  config.providers.push({ id, name: '自定义 API', baseUrl: '', apiKey: '', model: '', models: [] });
  config.activeProviderId = id;
  renderProviderSelect();
  fillProviderForm(config.providers[config.providers.length - 1]);
}
async function deleteProvider() {
  const providerId = $('setProvider').value;
  const p = config.providers.find((x) => x.id === providerId);
  if (!p) return;
  const ok = await customConfirm('删除提供商', `删除提供商「${p.name}」？`, '删除', true);
  if (!ok) return;
  config.providers = config.providers.filter((x) => x.id !== providerId);
  if (config.providers.length === 0) {
    config.providers.push({ id: 'custom-' + Date.now(), name: '自定义 API', baseUrl: '', apiKey: '', model: '', models: [] });
  }
  config.activeProviderId = config.providers[0].id;
  renderProviderSelect();
  fillProviderForm(config.providers[0]);
}
async function testProvider() {
  const pv = readProviderForm();
  const btn = $('pvTestBtn');
  btn.disabled = true;
  btn.textContent = '测试中…';
  const res = await window.dsh.provider.test({ baseUrl: pv.baseUrl, apiKey: pv.apiKey });
  btn.disabled = false;
  btn.textContent = '🔌 测试连接';
  const el = $('pvTestResult');
  if (res.ok) {
    el.textContent = `✅ 连接成功 (${res.status})，可用模型 ${res.models.length} 个` + (res.models.length ? `：${res.models.slice(0, 6).join(', ')}${res.models.length > 6 ? '…' : ''}` : '');
    el.className = 'pvTestResult ok';
    if (res.models.length) {
      $('pvModels').value = res.models.join('\n');
      const dl = $('pvModelList');
      dl.innerHTML = '';
      for (const m of res.models) {
        const opt = document.createElement('option');
        opt.value = m;
        dl.append(opt);
      }
      if (!res.models.includes(pv.model) && res.models.length) {
        $('pvModel').value = res.models[0];
      }
    }
  } else {
    el.textContent = '❌ 连接失败: ' + (res.error || '未知错误');
    el.className = 'pvTestResult err';
  }
}

// ---------- skills ----------
function renderActiveSkillSelect() {
  const sel = $('setActiveSkill');
  sel.innerHTML = '';
  for (const s of skills) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name + (s.builtin ? '' : '（自定义）');
    sel.append(opt);
  }
  sel.value = config.activeSkillId && skills.find((x) => x.id === config.activeSkillId) ? config.activeSkillId : (skills[0] ? skills[0].id : '');
}
function renderSkillBadge() {
  const badge = $('skillBadgeBtn');
  if (!badge) return;
  const cur = skills.find((x) => x.id === config.activeSkillId) || skills[0] || null;
  badge.textContent = cur ? '🎯 ' + cur.name : '🎯 默认';
}
function renderSkillList() {
  const list = $('skillList');
  list.innerHTML = '';
  const q = ($('skillSearch') ? $('skillSearch').value.trim() : '').toLowerCase();
  const shown = q ? skills.filter((s) => (s.name + ' ' + (s.desc || '')).toLowerCase().includes(q)) : skills;
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'pluginDesc';
    empty.textContent = '无匹配技能';
    list.append(empty);
    return;
  }
  for (const s of shown) {
    const row = document.createElement('div');
    row.className = 'pluginRow skillRow';
    row.dataset.sid = s.id;
    const name = document.createElement('div');
    name.className = 'pluginName';
    const tag = s.builtin ? '' : (s.source === 'claude' ? '（Claude）' : '（自定义）');
    name.textContent = s.name + tag;
    const desc = document.createElement('div');
    desc.className = 'pluginDesc';
    desc.textContent = s.desc || '';
    const head = document.createElement('div');
    head.className = 'pluginHead';
    head.append(name, desc);
    const actions = document.createElement('div');
    actions.className = 'pluginActions';
    const useBtn = document.createElement('button');
    useBtn.className = 'barBtn';
    useBtn.textContent = s.id === config.activeSkillId ? '✓ 使用中' : '使用';
    useBtn.onclick = async () => {
      config.activeSkillId = s.id;
      config = await window.dsh.config.set({ activeSkillId: s.id });
      renderActiveSkillSelect();
      renderSkillList();
      renderSkillBadge();
    };
    actions.append(useBtn);
    if (!s.builtin) {
      const editBtn = document.createElement('button');
      editBtn.className = 'barBtn';
      editBtn.textContent = '编辑';
      editBtn.onclick = () => editSkill(s.id);
      const delBtn = document.createElement('button');
      delBtn.className = 'barBtn danger';
      delBtn.textContent = '删除';
      delBtn.onclick = async () => {
        const ok = await customConfirm('删除技能', `删除技能「${s.name}」？`, '删除', true);
        if (!ok) return;
        skills = skills.filter((x) => x.id !== s.id);
        await window.dsh.skills.save(skills);
        if (config.activeSkillId === s.id) {
          config = await window.dsh.config.set({ activeSkillId: 'default' });
        }
        renderActiveSkillSelect();
        renderSkillList();
        renderSkillBadge();
      };
      actions.append(editBtn, delBtn);
    }
    row.append(head, actions);
    list.append(row);
  }
}
function editSkill(id) {
  const s = skills.find((x) => x.id === id);
  if (!s) return;
  const form = document.createElement('div');
  form.className = 'skillEdit';
  form.innerHTML = `
    <input id="skName" placeholder="技能名称" value="${esc(s.name)}" />
    <input id="skDesc" placeholder="一句话描述" value="${esc(s.desc || '')}" />
    <textarea id="skPrompt" rows="5" placeholder="技能指令（注入给模型的系统提示词）">${esc(s.prompt || '')}</textarea>
    <div class="pvActions">
      <span class="composerSpacer"></span>
      <button id="skCancel" class="barBtn">取消</button>
      <button id="skSave" class="sendBtn">保存</button>
    </div>`;
  const rows = Array.from(document.querySelectorAll('.skillRow'));
  const row = rows.find((r) => r.dataset.sid === id);
  if (!row) return;
  row.replaceWith(form);
  $('skCancel').onclick = () => renderSkillList();
  $('skSave').onclick = async () => {
    s.name = $('skName').value.trim() || '未命名技能';
    s.desc = $('skDesc').value.trim();
    s.prompt = $('skPrompt').value;
    await window.dsh.skills.save(skills);
    renderActiveSkillSelect();
    renderSkillList();
    renderSkillBadge();
  };
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
async function addSkill() {
  const id = 'skill-' + Date.now();
  skills.push({ id, name: '新技能', desc: '', prompt: '', builtin: false });
  await window.dsh.skills.save(skills);
  renderActiveSkillSelect();
  renderSkillList();
  editSkill(id);
}

// ---------- Skill Creator (Claude Code style guided creation) ----------
function skillCreator() {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const card = document.createElement('div');
  card.className = 'modalCard';
  card.style.width = '540px';
  card.innerHTML = `
    <h2 style="margin:0;font-size:15px;">✨ Skill Creator</h2>
    <label>技能名称
      <input id="scName" placeholder="例如：code-review" />
    </label>
    <label>一句话描述（什么时候该用这个技能）
      <input id="scDesc" placeholder="例如：审查代码质量，发现 bug 和优化点" />
    </label>
    <label>行为指令（告诉 AI 启用技能时如何行动）
      <textarea id="scPrompt" rows="7" placeholder="例如：&#10;1. 读取目标文件/代码&#10;2. 按可维护性、性能、安全三个维度审查&#10;3. 输出问题清单与修改建议"></textarea>
    </label>
    <label>SKILL.md 预览
      <pre id="scPreview" class="scPreview"></pre>
    </label>
    <div class="pvActions">
      <span class="composerSpacer"></span>
      <button id="scCancel" class="barBtn">取消</button>
      <button id="scSave" class="sendBtn">💾 保存到技能库</button>
    </div>`;
  modal.append(card);
  document.body.append(modal);
  const preview = () => {
    const name = $('scName').value.trim() || 'my-skill';
    const desc = $('scDesc').value.trim() || '…';
    const body = $('scPrompt').value.trim();
    $('scPreview').textContent = '---\nname: ' + name + '\ndescription: ' + desc + '\n---\n\n' + (body || '（未填写行为指令）');
  };
  $('scName').oninput = preview;
  $('scDesc').oninput = preview;
  $('scPrompt').oninput = preview;
  $('scCancel').onclick = () => modal.remove();
  $('scSave').onclick = async () => {
    const name = $('scName').value.trim();
    const desc = $('scDesc').value.trim();
    const prompt = $('scPrompt').value.trim();
    if (!name) { $('scName').focus(); return; }
    const id = 'skill-' + name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-').slice(0, 40) + '-' + Date.now();
    skills.push({ id, name, desc, prompt, builtin: false, source: 'creator' });
    await window.dsh.skills.save(skills);
    modal.remove();
    renderActiveSkillSelect();
    renderSkillList();
    renderSkillBadge();
    flashStatus('✨ 技能已创建：' + name);
  };
  preview();
  setTimeout(() => $('scName').focus(), 50);
}

// ---------- Self-Improve (analyze sessions, suggest new/upgraded skills) ----------
async function selfImprove() {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const card = document.createElement('div');
  card.className = 'modalCard';
  card.style.width = '580px';
  card.innerHTML = `
    <h2 style="margin:0;font-size:15px;">🧬 Self-Improve</h2>
    <div id="siStatus" class="pvTestResult" style="white-space:pre-wrap;">分析最近的会话，提炼可复用的技能…</div>
    <div id="siBody" style="display:flex;flex-direction:column;gap:8px;max-height:300px;overflow-y:auto;"></div>
    <div class="pvActions" id="siActions" style="display:none;">
      <span class="composerSpacer"></span>
      <button id="siCancel" class="barBtn">关闭</button>
      <button id="siApply" class="sendBtn">✅ 应用选中（0）</button>
    </div>`;
  modal.append(card);
  document.body.append(modal);
  $('siCancel').onclick = () => modal.remove();
  const status = $('siStatus');
  status.textContent = '⏳ 正在分析会话记录…（需要 API 提供商可用）';
  // session summary
  const lines = [];
  for (const s of sessions) {
    if (s.archived) continue;
    lines.push('## ' + (s.title || '无标题'));
    for (const m of s.messages.slice(-3)) {
      lines.push((m.role === 'user' ? '用户: ' : '助手: ') + String(m.content || '').replace(/\s+/g, ' ').slice(0, 300));
    }
  }
  const existing = skills.filter((x) => !x.builtin).map((x) => x.name).join('、') || '（无自定义技能）';
  const res = await window.dsh.selfimprove.run(lines.join('\n').slice(0, 30000), existing);
  if (!res.ok) {
    status.textContent = '❌ ' + (res.error || '分析失败');
    return;
  }
  const picks = [];
  const body = $('siBody');
  const addItem = (kind, item, idx) => {
    const row = document.createElement('label');
    row.className = 'pluginRow';
    const head = document.createElement('div');
    head.className = 'pluginHead';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    const name = document.createElement('div');
    name.className = 'pluginName';
    name.textContent = (kind === 'new' ? '🆕 新技能：' : '⬆️ 升级技能：') + item.name;
    head.append(cb, name);
    const desc = document.createElement('div');
    desc.className = 'pluginDesc';
    desc.textContent = item.description || '';
    const promptEl = document.createElement('pre');
    promptEl.className = 'scPreview';
    promptEl.textContent = item.prompt || '';
    row.append(head, desc, promptEl);
    cb.onchange = () => {
      const i = picks.indexOf(idx);
      if (cb.checked && i < 0) picks.push(idx);
      else if (!cb.checked && i >= 0) picks.splice(i, 1);
      $('siApply').textContent = '✅ 应用选中（' + picks.length + '）';
    };
    body.append(row);
    picks.push(idx);
  };
  res.skills.forEach((s, i) => addItem('new', s, 'n' + i));
  res.upgrades.forEach((u, i) => addItem('up', u, 'u' + i));
  if (!res.skills.length && !res.upgrades.length) {
    status.textContent = 'ℹ️ 未发现值得提炼的重复模式。' + (res.parseFailed ? '（模型输出无法解析）' : '');
    return;
  }
  status.textContent = '✅ 分析完成，勾选后点击"应用选中"：';
  $('siApply').textContent = '✅ 应用选中（' + picks.length + '）';
  $('siActions').style.display = 'flex';
  $('siApply').onclick = async () => {
    let applied = 0;
    for (const k of picks) {
      if (k[0] === 'n') {
        const item = res.skills[Number(k.slice(1))];
        if (!item || !item.name) continue;
        const id = 'skill-' + item.name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-').slice(0, 40) + '-' + Date.now();
        skills.push({ id, name: item.name, desc: item.description || '', prompt: item.prompt || '', builtin: false, source: 'selfimprove' });
        applied++;
      } else {
        const item = res.upgrades[Number(k.slice(1))];
        if (!item || !item.name) continue;
        const target = skills.find((x) => x.name === item.name);
        if (target) {
          target.prompt = item.prompt || target.prompt;
          target.desc = item.description || target.desc;
          applied++;
        }
      }
    }
    await window.dsh.skills.save(skills);
    status.textContent = '🎉 已应用 ' + applied + ' 个技能建议';
    $('siApply').style.display = 'none';
    renderActiveSkillSelect();
    renderSkillList();
    renderSkillBadge();
  };
}

// ---------- Claude Code skills import ----------
let claudeScanned = [];
async function scanClaudeSkills() {
  const dir = $('claudeSkillsDir').value.trim();
  const btn = $('claudeScanBtn');
  btn.disabled = true;
  btn.textContent = '扫描中…';
  const res = await window.dsh.skills.scanClaude(dir || undefined);
  btn.disabled = false;
  btn.textContent = '🔍 扫描';
  const el = $('claudeScanResult');
  if (res.ok) {
    claudeScanned = res.skills || [];
    const existing = new Set(skills.map((s) => s.id));
    const fresh = claudeScanned.filter((s) => !existing.has(s.id)).length;
    el.textContent = `✅ 目录 ${res.dir}：发现 ${res.count} 个技能（未导入 ${fresh} 个）`;
    el.className = 'pvTestResult ok';
  } else {
    claudeScanned = [];
    el.textContent = '❌ ' + (res.error || '扫描失败');
    el.className = 'pvTestResult err';
  }
}
async function importClaudeSkills() {
  if (!claudeScanned.length) {
    await scanClaudeSkills();
  }
  const existing = new Set(skills.map((s) => s.id));
  const fresh = claudeScanned.filter((s) => !existing.has(s.id));
  if (!fresh.length) {
    $('claudeScanResult').textContent = 'ℹ️ 没有新的技能需要导入';
    $('claudeScanResult').className = 'pvTestResult';
    return;
  }
  const ok = await customConfirm('导入技能', `将导入 ${fresh.length} 个 Claude Code 技能？\n（已存在的将跳过）`, '导入');
  if (!ok) return;
  skills.push(...fresh);
  await window.dsh.skills.save(skills);
  renderActiveSkillSelect();
  renderSkillList();
  renderSkillBadge();
  $('claudeScanResult').textContent = `✅ 已导入 ${fresh.length} 个技能，当前技能库共 ${skills.length} 个`;
  $('claudeScanResult').className = 'pvTestResult ok';
}

// ---------- plugins ----------
function renderPluginList() {
  const list = $('pluginList');
  list.innerHTML = '';
  for (const p of plugins) {
    const row = document.createElement('div');
    row.className = 'pluginRow';
    const head = document.createElement('div');
    head.className = 'pluginHead';
    const name = document.createElement('div');
    name.className = 'pluginName';
    name.textContent = (p.enabled ? '🟢 ' : '⚪ ') + (p.name || p.id);
    const cmd = document.createElement('div');
    cmd.className = 'pluginDesc';
    cmd.textContent = p.type === 'stdio' ? (p.command || '') : (p.url || '');
    head.append(name, cmd);
    const actions = document.createElement('div');
    actions.className = 'pluginActions';
    const en = document.createElement('label');
    en.className = 'pluginToggle';
    en.textContent = '启用 ';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!p.enabled;
    cb.onchange = async () => {
      p.enabled = cb.checked;
      await window.dsh.plugins.save(plugins);
      updateToolsBadge();
    };
    en.append(cb);
    const testBtn = document.createElement('button');
    testBtn.className = 'barBtn';
    testBtn.textContent = '🔌 连接';
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      testBtn.textContent = '连接中…';
      const res = await window.dsh.plugins.connect(p);
      testBtn.disabled = false;
      if (res.ok) {
        testBtn.textContent = `✓ ${res.toolCount || 0} 工具`;
        updateToolsBadge();
      } else {
        testBtn.textContent = '✗ ' + (res.error || '失败').slice(0, 40);
      }
    };
    const disBtn = document.createElement('button');
    disBtn.className = 'barBtn';
    disBtn.textContent = '断开';
    disBtn.onclick = async () => {
      await window.dsh.plugins.disconnect(p.id);
      updateToolsBadge();
    };
    const delBtn = document.createElement('button');
    delBtn.className = 'barBtn danger';
    delBtn.textContent = '删除';
    delBtn.onclick = async () => {
      const ok = await customConfirm('删除插件', `删除插件「${p.name || p.id}」？`, '删除', true);
      if (!ok) return;
      await window.dsh.plugins.disconnect(p.id);
      plugins = plugins.filter((x) => x.id !== p.id);
      await window.dsh.plugins.save(plugins);
      renderPluginList();
      updateToolsBadge();
    };
    actions.append(en, testBtn, disBtn, delBtn);
    row.append(head, actions);
    list.append(row);
  }
}
async function addPlugin() {
  const form = document.createElement('div');
  form.className = 'skillEdit';
  form.innerHTML = `
    <input id="plName" placeholder="插件名称，如 filesystem" />
    <select id="plType">
      <option value="stdio">stdio（本地命令）</option>
      <option value="http">http / SSE（远程端点）</option>
    </select>
    <input id="plCmd" placeholder="stdio: npx -y @modelcontextprotocol/server-xxx [args]" />
    <input id="plUrl" class="hidden" placeholder="http: https://host/mcp 或 sse://…" />
    <div class="pvActions">
      <span class="composerSpacer"></span>
      <button id="plCancel" class="barBtn">取消</button>
      <button id="plSave" class="sendBtn">添加</button>
    </div>`;
  const list = $('pluginList');
  list.prepend(form);
  $('plType').onchange = () => {
    const isStdio = $('plType').value === 'stdio';
    $('plCmd').classList.toggle('hidden', !isStdio);
    $('plUrl').classList.toggle('hidden', isStdio);
  };
  $('plCancel').onclick = () => renderPluginList();
  $('plSave').onclick = async () => {
    const type = $('plType').value;
    const name = $('plName').value.trim() || 'mcp-' + Date.now();
    const plugin = {
      id: 'mcp-' + Date.now(),
      name,
      type,
      command: type === 'stdio' ? $('plCmd').value.trim() : '',
      url: type === 'http' ? $('plUrl').value.trim() : '',
      enabled: false
    };
    if (type === 'stdio' && !plugin.command) { alert('请填写命令'); return; }
    if (type === 'http' && !plugin.url) { alert('请填写 URL'); return; }
    plugins.push(plugin);
    await window.dsh.plugins.save(plugins);
    renderPluginList();
  };
}
async function updateToolsBadge() {
  let connected = 0;
  for (const p of plugins) {
    if (!p.enabled) continue;
    const res = await window.dsh.plugins.listTools(p.id);
    if (res.ok) connected++;
  }
  const count = 5 + connected;
  $('toolsBadge').textContent = `🛠 ${count} 工具`;
  $('toolsBadge').title = `内置 5 个工具 + ${connected} 个已连接 MCP 插件`;
}

// ---------- input ----------
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
}
inputEl.addEventListener('input', () => {
  autoGrow();
  updateSkillMenu();
});
inputEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    if (!skillMenuItems.length) {
      ev.preventDefault();
      sendMessage();
    } else {
      // enter picks the highlighted skill
      ev.preventDefault();
      const s = skillMenuItems[skillMenuIndex];
      if (s) applySkillById(s.id);
    }
    return;
  }
  if (skillMenuItems.length) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      skillMenuIndex = (skillMenuIndex + 1) % skillMenuItems.length;
      renderSkillMenuSelection();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      skillMenuIndex = (skillMenuIndex - 1 + skillMenuItems.length) % skillMenuItems.length;
      renderSkillMenuSelection();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closeSkillMenu();
    }
  }
});

// ---------- events ----------
$('sendBtn').onclick = () => {
  if (streaming) {
    // sendBtn is NEVER disabled during a run (a disabled button can't fire onclick,
    // which was why stop was broken). stopPending absorbs double-clicks instead.
    if (stopPending) return;
    stopPending = true;
    $('sendBtn').textContent = '⏹ 停止中…';
    window.dsh.chat.abort(streamCtx ? streamCtx.requestId : null);
  } else sendMessage();
};
$('activityHead').addEventListener('click', () => {
  activityExpanded = !activityExpanded;
  clearTimeout(activityCollapseTimer);
  $('activityBar').classList.toggle('expanded', activityExpanded);
});
$('newChatBtn').onclick = newSession;
$('settingsBtn').onclick = openSettings;
$('settingsSave').onclick = saveSettings;
$('settingsCancel').onclick = () => $('settingsModal').classList.add('hidden');
$('setProvider').onchange = () => {
  const p = config.providers.find((x) => x.id === $('setProvider').value);
  if (p) fillProviderForm(p);
};
$('pvAddBtn').onclick = addProvider;
$('pvDeleteBtn').onclick = deleteProvider;
$('pvTestBtn').onclick = testProvider;
$('skillAddBtn').onclick = addSkill;
$('skillCreatorBtn').onclick = skillCreator;
$('selfImproveBtn').onclick = selfImprove;
$('claudeScanBtn').onclick = scanClaudeSkills;
$('claudeImportBtn').onclick = importClaudeSkills;
$('skillSearch').oninput = renderSkillList;
$('pluginAddBtn').onclick = addPlugin;
$('skillBadgeBtn').onclick = (e) => {
  e.stopPropagation();
  const menu = $('skillMenu');
  if (!menu.classList.contains('hidden')) closeSkillMenu();
  else openSkillMenu();
};
$('pvModel').onchange = () => {
  // refresh thinking level dropdown for the newly selected model
  const p = config.providers.find((x) => x.id === $('setProvider').value);
  if (p) $('pvThinking').value = (p.modelThinking || {})[$('pvModel').value] || 'medium';
};
$('archiveRefreshBtn').onclick = renderArchiveList;
$('newProjectBtn').onclick = newProject;
$('wsSearch').oninput = () => {
  wsSearchQuery = $('wsSearch').value.trim();
  renderSessionList();
};
// view options menu
$('viewOptionsBtn').onclick = (e) => {
  e.stopPropagation();
  $('viewMenu').classList.toggle('hidden');
};
document.querySelectorAll('#viewMenu .viewOpt').forEach((b) => {
  b.onclick = async () => {
    const patch = {};
    patch[b.dataset.view] = b.dataset.val;
    config = await window.dsh.config.set({ view: { ...viewState(), ...patch } });
    renderViewMenu();
    renderSessionList();
  };
});
$('ctxRingWrap').onclick = (e) => {
  e.stopPropagation();
  const pop = $('ctxPopover');
  if (!pop.classList.contains('hidden')) { closeContextPopover(); return; }
  showContextPopover();
};
document.addEventListener('click', (e) => {
  const pop = $('ctxPopover');
  if (!pop.classList.contains('hidden') && !pop.contains(e.target) && e.target.id !== 'ctxRingWrap' && !e.target.closest('#ctxRingWrap')) {
    closeContextPopover();
  }
  const vm = $('viewMenu');
  if (vm && !vm.classList.contains('hidden') && !vm.contains(e.target) && e.target.id !== 'viewOptionsBtn') {
    vm.classList.add('hidden');
  }
  const sm = $('skillMenu');
  if (sm && !sm.classList.contains('hidden') && !sm.contains(e.target) && e.target.id !== 'skillBadgeBtn' && !e.target.closest('#skillBadgeBtn')) {
    closeSkillMenu();
  }
});

// composer quick controls
$('composerModel').onchange = async () => {
  const providerId = config.activeProviderId;
  const model = $('composerModel').value;
  if (!model) return;
  const providers = config.providers.map((pr) => (pr.id === providerId ? { ...pr, model } : pr));
  config = await window.dsh.config.set({ providers });
  updateModelBadge();
  $('composerThinking').value = (currentProvider()?.modelThinking || {})[model] || 'medium';
  updateContextRing();
};
$('composerThinking').onchange = async () => {
  const providerId = config.activeProviderId;
  const p = config.providers.find((x) => x.id === providerId);
  if (!p) return;
  const model = $('composerModel').value || p.model;
  const modelThinking = { ...(p.modelThinking || {}), [model]: $('composerThinking').value };
  const providers = config.providers.map((pr) => (pr.id === providerId ? { ...pr, modelThinking } : pr));
  config = await window.dsh.config.set({ providers });
};
$('approvalBadge').onchange = async () => {
  config = await window.dsh.config.set({ approvalPolicy: $('approvalBadge').value });
};

// appearance live hints
$('setOpacity').oninput = () => { $('opacityVal').textContent = $('setOpacity').value + '%'; };
$('setContrast').oninput = () => { $('contrastVal').textContent = $('setContrast').value + '%'; };
$('accentCustom').onchange = () => {
  document.querySelectorAll('.accentSwatch').forEach((x) => x.classList.remove('active'));
  document.body.style.setProperty('--accent', $('accentCustom').value);
  document.body.style.setProperty('--accent2', $('accentCustom').value);
};
$('bgResetBtn').onclick = () => { $('setBgColor').value = ''; };
document.querySelectorAll('.accentSwatch').forEach((s) => {
  s.onclick = () => {
    document.querySelectorAll('.accentSwatch').forEach((x) => x.classList.remove('active'));
    s.classList.add('active');
  };
});
$('terminalToggle').onclick = () => {
  const p = $('terminalPanel');
  if (p.classList.contains('hidden')) openTerminal();
  else closeTerminal();
};
$('termCloseBtn').onclick = closeTerminal;
$('termKillBtn').onclick = () => {
  if (lastRunId) window.dsh.shell.kill('run' + lastRunId);
  $('termStatus').textContent = 'killed';
  $('termStatus').className = 'termStatus';
};
window.addEventListener('resize', () => {
  if (termOpen && !$('terminalPanel').classList.contains('hidden')) fitAddon.fit();
});

// ---------- boot ----------
async function boot() {
  config = await window.dsh.config.get();
  sessions = await window.dsh.sessions.load();
  skills = await window.dsh.skills.load();
  plugins = await window.dsh.plugins.load();
  projects = await window.dsh.projects.load();
  try { appEnv = await window.dsh.app.info(); } catch (e) { appEnv = null; }
  if (!Array.isArray(sessions)) sessions = [];
  if (!Array.isArray(skills)) skills = [];
  if (!Array.isArray(plugins)) plugins = [];
  if (!Array.isArray(projects)) projects = [];
  applyTheme();
  updateModelBadge();
  renderComposerControls();
  renderSkillBadge();
  updateToolsBadge();
  renderViewMenu();
  $('claudeSkillsDir').value = 'C:\\Users\\gylcl\\.claude\\skills';
  if (sessions.length) {
    currentId = sessions[sessions.length - 1].id;
  } else {
    newSession();
  }
  renderSessionList();
  renderMessages();
  updateContextRing();
  // keep workspace in sync when project folders are created/removed in the terminal
  window.dsh.projects.onChanged(async () => {
    projects = await window.dsh.projects.load();
    if (!Array.isArray(projects)) projects = [];
    renderSessionList();
  });
  const p = currentProvider();
  if (!p || !p.apiKey) {
    setTimeout(openSettings, 400);
  }
  window.__dshBooted = true;
}
boot();
