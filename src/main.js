'use strict';
const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const WORKSPACE = 'D:\\DeepSeek工作区';
const DATA_DIR = path.join(app.getPath('appData'), 'DeepSeek-Desktop');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const SKILLS_PATH = path.join(DATA_DIR, 'skills.json');
const PLUGINS_PATH = path.join(DATA_DIR, 'plugins.json');

let mainWin = null;
const shellProcs = new Map();
const toolShellProcs = new Set(); // in-flight tool shell procs; killed on chat:abort
const chatAborts = new Map();
const chatRounds = new Map(); // requestId -> per-round AbortController (soft-interrupt for mid-run injection)
const chatInjections = new Map(); // requestId -> string[] of queued steering instructions
let activeStream = null; // { requestId, sender } — in-flight chat stream, used to flush text before an inject event
const toolConfirmWaiters = new Map();
const mcpClients = new Map(); // pluginId -> { client, transport, tools }

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, data) {
  ensureDataDir();
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}
function sendToRenderer(chunk) {
  if (mainWin) mainWin.webContents.send('chat:chunk', chunk);
}

const DEFAULT_SYSTEM_PROMPT = 'You are DeepSeek, an AI coding assistant running in a desktop app on Windows. You have real tools: shell_exec (run cmd commands in the workspace), list_dir, read_file, write_file, get_system_info. When a task requires inspecting or changing files or running commands, USE those tools directly instead of only describing commands: read the relevant files first, make the edits, run the program/tests, and check the output. Work inside the workspace folder. When you finish, give a short summary of what you changed and the result. Respond in the same language the user uses. Be concise and practical.';

// ============ API providers ============
const PRESET_PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'openrouter/auto', models: ['openrouter/auto'] },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'] },
  { id: 'ollama', name: 'Ollama (本地)', baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama', model: 'llama3.2', models: [] },
  { id: 'moonshot', name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', apiKey: '', model: 'moonshot-v1-8k', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', model: 'glm-4-flash', models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'] },
  { id: 'qwen', name: '阿里通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', model: 'qwen-plus', models: ['qwen-plus', 'qwen-turbo', 'qwen-max'] }
];

function normalizeConfig(raw) {
  const base = {
    activeProviderId: 'deepseek',
    providers: [],
    temperature: 0.7,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    theme: { mode: 'sky', accent: 'blue', uiFontSize: 14, codeFontSize: 13, bgColor: '', uiFont: '', codeFont: '', opacity: 1, contrast: 1 },
    activeSkillId: 'default',
    activeProjectId: '',
    autoRunTools: true,
    approvalPolicy: 'smart',        // ask | smart | full
    sandbox: { workspace: WORKSPACE, restrictTools: true },
    reasoningDisplay: 'full',       // full | summary | off
    verbosity: 'standard',          // concise | standard | detailed
    customInstructions: '',
    memory: { enabled: false, content: '' },
    persona: 'pragmatic',            // warm | pragmatic | professional | humorous | concise
    chat: { streamIdleMs: 240000, streamMaxMs: 1800000 }  // stream watchdog limits
  };
  const cfg = { ...base, ...raw };
  cfg.theme = { ...base.theme, ...(cfg.theme || {}) };
  cfg.sandbox = { ...base.sandbox, ...(cfg.sandbox || {}) };
  cfg.memory = { ...base.memory, ...(cfg.memory || {}) };
  cfg.chat = { ...base.chat, ...(cfg.chat || {}) };
  // migrate legacy autoRunTools -> approvalPolicy
  if (!raw.approvalPolicy) {
    cfg.approvalPolicy = raw.autoRunTools === false ? 'ask' : 'smart';
  }
  let providers = Array.isArray(cfg.providers) ? cfg.providers : [];
  if ((raw.apiKey || raw.baseUrl || raw.model) && !providers.length) {
    providers = [{
      id: 'deepseek', name: 'DeepSeek 官方',
      baseUrl: raw.baseUrl || 'https://api.deepseek.com',
      apiKey: raw.apiKey || '',
      model: raw.model || 'deepseek-chat',
      models: ['deepseek-chat', 'deepseek-reasoner']
    }];
  }
  const merged = PRESET_PROVIDERS.map((p) => {
    const saved = providers.find((x) => x.id === p.id);
    const mergedP = { ...p, modelThinking: {}, ...(saved || {}) };
    delete mergedP.removed;
    return mergedP;
  });
  for (const p of providers) {
    if (!PRESET_PROVIDERS.find((x) => x.id === p.id) && !p.removed) merged.push({ ...p });
  }
  cfg.providers = merged;
  if (!cfg.providers.find((p) => p.id === cfg.activeProviderId)) {
    cfg.activeProviderId = cfg.providers.length ? cfg.providers[0].id : 'deepseek';
  }
  return cfg;
}

function loadConfig() {
  return normalizeConfig(readJson(CONFIG_PATH, {}));
}

// ============ Skills ============
const BUILTIN_SKILLS = [
  { id: 'default', name: '通用助手', desc: '默认模式，不附加技能指令', builtin: true, prompt: '' },
  { id: 'code-review', name: '代码审查', desc: '以资深 Reviewer 视角审查代码质量、bug 与安全隐患', builtin: true, prompt: 'You are a senior code reviewer. Analyze the provided code carefully. Report: (1) bugs and logic errors, (2) security issues, (3) performance problems, (4) style/maintainability suggestions. Be specific, cite line-level evidence, and prioritize issues by severity. Write in the same language the user uses.' },
  { id: 'test-writer', name: '单元测试', desc: '为指定代码生成覆盖主要路径的单元测试', builtin: true, prompt: 'You are a test-driven development expert. Write thorough unit tests for the given code: cover normal paths, edge cases, and failure paths. Use the testing framework most natural for the language (pytest for Python, Vitest/Jest for JS/TS, etc.). Include assertions that would actually fail on regression. Write in the same language the user uses.' },
  { id: 'explain', name: '代码解释', desc: '逐段解释代码逻辑与设计意图', builtin: true, prompt: 'You are a patient code explainer. Explain the code step by step: what each part does, how the pieces connect, and the design intent. Use concrete examples where helpful. Match the technical level to the user. Write in the same language the user uses.' },
  { id: 'refactor', name: '重构专家', desc: '在不改变行为的前提下改善代码结构', builtin: true, prompt: 'You are a refactoring expert. Improve the code structure without changing its observable behavior: extract functions, remove duplication, improve naming, simplify conditionals. Explain each change and why it is safer. Write in the same language the user uses.' },
  { id: 'shell-expert', name: 'Shell 专家', desc: '编写与调试 Windows 命令行脚本（cmd/powershell）', builtin: true, prompt: 'You are a Windows shell scripting expert (cmd.exe and PowerShell). Provide correct, robust scripts: handle quoting, encoding (GBK/UTF-8), error codes, and edge cases. Always explain what the script does. Prefer PowerShell when the task needs object pipelines, cmd when it is simple. Write in the same language the user uses.' },
  { id: 'translator', name: '翻译官', desc: '中英文互译，保留技术术语准确性', builtin: true, prompt: 'You are a professional translator. Translate between Chinese and English accurately: preserve technical terms, code identifiers, and formatting (code blocks, tables). Keep the tone natural for the target language. If the input is already in the target language, polish it instead.' },
  { id: 'weekly-report', name: '周报助手', desc: '从工作内容整理成结构化的周报', builtin: true, prompt: 'You are a weekly report assistant. Turn the user\'s work notes into a well-structured weekly report: highlights, tasks completed, problems and solutions, next week plan. Keep it concise and business-friendly, no fluff. Write in Chinese unless told otherwise.' }
];

function loadSkills() {
  const saved = readJson(SKILLS_PATH, []);
  const list = Array.isArray(saved) ? saved : [];
  const merged = BUILTIN_SKILLS.map((s) => ({ ...s, ...(list.find((x) => x.id === s.id) || {}) }));
  for (const s of list) {
    if (!BUILTIN_SKILLS.find((x) => x.id === s.id) && !s.removed) merged.push({ ...s });
  }
  return merged;
}

// ============ Plugins (MCP) ============
function loadPlugins() {
  return readJson(PLUGINS_PATH, []);
}

async function connectMcp(plugin) {
  const id = plugin.id;
  const entry = mcpClients.get(id);
  if (entry) return { ok: true, tools: entry.tools };
  try {
    const sdk = await import('@modelcontextprotocol/sdk/client/index.js');
    const { Client } = sdk;
    let transport;
    if (plugin.type === 'stdio') {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const parts = (plugin.command || '').trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return { ok: false, error: 'empty command' };
      transport = new StdioClientTransport({ command: parts[0], args: parts.slice(1), env: { ...process.env } });
    } else {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      transport = new StreamableHTTPClientTransport(new URL(plugin.url));
    }
    const client = new Client({ name: 'deepseek-desktop', version: '1.0.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    const prefix = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const tools = (listed.tools || []).map((t) => ({
      type: 'function',
      function: {
        name: `${prefix}__${(t.name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        description: String(t.description || `Tool from plugin ${plugin.name || id}`).slice(0, 900),
        parameters: t.inputSchema || { type: 'object', properties: {} }
      }
    }));
    mcpClients.set(id, { client, transport, tools });
    return { ok: true, tools, toolCount: tools.length };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function disconnectMcp(id) {
  const entry = mcpClients.get(id);
  if (entry) {
    try { await entry.client.close(); } catch {}
    mcpClients.delete(id);
  }
  return { ok: true };
}

async function callMcpTool(pluginId, toolName, args) {
  const entry = mcpClients.get(pluginId);
  if (!entry) return { error: `plugin "${pluginId}" not connected` };
  const res = await entry.client.callTool({ name: toolName, arguments: args || {} });
  if (Array.isArray(res.content)) {
    return { result: res.content.map((c) => (c.text != null ? c.text : JSON.stringify(c))).join('\n') };
  }
  return { result: JSON.stringify(res) };
}

// ============ Built-in tools ============
const BUILTIN_TOOLS = [
  {
    name: 'shell_exec', description: 'Execute a shell command on the user\'s Windows machine (cmd.exe) inside the workspace folder. Returns stdout, stderr and exit code. Use for running scripts, git, build tools, etc.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'The full command line to run' } }, required: ['command'] }
  },
  {
    name: 'list_dir', description: 'List files and folders in a directory (relative to the workspace). Returns names and sizes.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory relative to workspace, e.g. "src" or "."' } }, required: ['path'] }
  },
  {
    name: 'read_file', description: 'Read a text file from the workspace. Returns its content (truncated to 40000 chars).',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to workspace' } }, required: ['path'] }
  },
  {
    name: 'write_file', description: 'Write text content to a file in the workspace (creates parent folders). Overwrites existing files.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to workspace' }, content: { type: 'string', description: 'Full text content' } }, required: ['path', 'content'] }
  },
  {
    name: 'get_system_info', description: 'Return basic system information: OS version, CPU, memory, disk, workspace path.',
    parameters: { type: 'object', properties: {} }
  }
];

function safeJoin(rel, base) {
  const root = path.resolve(base || WORKSPACE);
  const target = path.resolve(root, String(rel || '.'));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('path escapes workspace: ' + rel);
  }
  return target;
}

// ---- risk classification & approval policy (ask / smart / full) ----
const DANGEROUS_CMD = /(^|\s|\|)(del|rm|rmdir|rd|format|shutdown|taskkill|diskpart|cipher|takeown|icacls|attrib|net\s+user|sc\s+delete|reg\s+delete|wmic|psexec|format\s+[a-z]:)/i;
const NET_CMD = /(curl|wget|iwr|invoke-webrequest|invoke-restmethod|net\s+use|ssh|ftp|telnet)/i;

function toolRisk(name, args) {
  if (name === 'write_file') return 'high';
  if (name === 'shell_exec') {
    const cmd = String((args && args.command) || '');
    if (DANGEROUS_CMD.test(cmd)) return 'high';
    if (NET_CMD.test(cmd)) return 'medium';
    return 'medium';
  }
  return 'low'; // read_file / list_dir / get_system_info / mcp reads
}
function needsApproval(policy, risk) {
  if (policy === 'full') return false;
  if (policy === 'ask') return risk !== 'low';
  return risk === 'high'; // smart
}

function runShellForTool(command, timeoutMs, cwd) {
  return new Promise((resolve) => {
    const proc = spawn('cmd.exe', ['/d', '/s', '/c', String(command || '')], { cwd: cwd || WORKSPACE, windowsHide: true });
    toolShellProcs.add(proc);
    const dec = new TextDecoder('gbk');
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs || 60000);
    proc.stdout.on('data', (d) => { out += dec.decode(d, { stream: true }); });
    proc.stderr.on('data', (d) => { err += dec.decode(d, { stream: true }); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      toolShellProcs.delete(proc);
      resolve({ exitCode: code, stdout: out.slice(0, 6000), stderr: err.slice(0, 4000) });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      toolShellProcs.delete(proc);
      resolve({ exitCode: -1, stdout: '', stderr: String(e.message || e) });
    });
  });
}

async function runBuiltinTool(name, args, workspace) {
  const a = args || {};
  switch (name) {
    case 'shell_exec': return await runShellForTool(a.command, 60000, workspace);
    case 'list_dir': {
      const dir = safeJoin(a.path || '.', workspace);
      const items = fs.readdirSync(dir, { withFileTypes: true }).map((it) => {
        let size = '';
        if (it.isFile()) { try { size = fs.statSync(path.join(dir, it.name)).size + ' B'; } catch {} }
        return `${it.isDirectory() ? '[dir] ' : '      '}${it.name}${size ? '  ' + size : ''}`;
      });
      return { path: dir, entries: items.length, files: items.slice(0, 200) };
    }
    case 'read_file': {
      const p = safeJoin(a.path, workspace);
      if (!fs.existsSync(p)) return { error: 'file not found: ' + a.path };
      const content = fs.readFileSync(p, 'utf8');
      return { path: p, length: content.length, content: content.slice(0, 40000) };
    }
    case 'write_file': {
      const p = safeJoin(a.path, workspace);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(a.content == null ? '' : a.content), 'utf8');
      return { ok: true, path: p, bytes: String(a.content || '').length };
    }
    case 'get_system_info': {
      return {
        os: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        node: process.versions.node,
        workspace: workspace || WORKSPACE,
        cpus: require('os').cpus().length,
        totalMemGB: Math.round(require('os').totalmem() / 1073741824)
      };
    }
    default:
      return { error: 'unknown tool: ' + name };
  }
}

async function runTool(toolName, args, workspace) {
  // MCP tools are prefixed with pluginId__
  const idx = toolName.indexOf('__');
  if (idx > 0) {
    const pluginId = toolName.slice(0, idx);
    const tname = toolName.slice(idx + 2);
    return await callMcpTool(pluginId, tname, args);
  }
  return await runBuiltinTool(toolName, args, workspace);
}

function requestToolConfirm(requestId, toolName, args) {
  return new Promise((resolve) => {
    const key = requestId;
    toolConfirmWaiters.set(key, resolve);
    sendToRenderer({ requestId, tool: { name: toolName, args, status: 'confirm' } });
    setTimeout(() => {
      if (toolConfirmWaiters.has(key)) { toolConfirmWaiters.delete(key); resolve(false); }
    }, 90000);
  });
}

ipcMain.handle('tool:confirm:reply', (e, { requestId, approved }) => {
  const w = toolConfirmWaiters.get(requestId);
  if (w) { toolConfirmWaiters.delete(requestId); w(!!approved); }
  return { ok: true };
});

// ============ window (position memory + taskbar identity) ============
const WINDOW_STATE_PATH = path.join(DATA_DIR, 'window-state.json');
let boundsSaveTimer = null;

function loadWindowBounds() {
  const saved = readJson(WINDOW_STATE_PATH, null);
  if (!saved || typeof saved.x !== 'number') return null;
  // ensure the saved position is still on a visible display
  const { screen } = require('electron');
  try {
    const displays = screen.getAllDisplays();
    const visible = displays.some((d) => {
      const b = d.bounds;
      return saved.x < b.x + b.width - 60 && saved.x + 60 > b.x &&
             saved.y < b.y + b.height - 60 && saved.y + 60 > b.y;
    });
    return visible ? saved : null;
  } catch {
    return saved;
  }
}

function saveWindowBounds() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const b = mainWin.getBounds();
  writeJson(WINDOW_STATE_PATH, { x: b.x, y: b.y, width: b.width, height: b.height });
}

function scheduleBoundsSave() {
  clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(saveWindowBounds, 500);
}

function createWindow() {
  const saved = loadWindowBounds();
  mainWin = new BrowserWindow({
    ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : { width: 1280, height: 820 }),
    minWidth: 940,
    minHeight: 600,
    show: false, // show only after ready-to-show so the window never appears as a stuck taskbar tile
    backgroundColor: '#0b0e14',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    title: 'DeepSeek Desktop',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWin.once('ready-to-show', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.show();
      mainWin.focus();
    }
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('move', scheduleBoundsSave);
  mainWin.on('resize', scheduleBoundsSave);
  mainWin.on('close', () => {
    saveWindowBounds();
    // X / Alt+F4 close the window and quit the app (window-all-closed -> app.quit).
    // No hijack here: the taskbar-icon toggle (second-instance) is what folds/restores
    // a running window, and it does not block closing.
  });
  mainWin.on('closed', () => { mainWin = null; });
}

const menu = Menu.buildFromTemplate([
  { label: 'DeepSeek Desktop', submenu: [
    { role: 'about', label: 'About DeepSeek Desktop' },
    { type: 'separator' },
    { role: 'quit', label: 'Quit', accelerator: 'CmdOrCtrl+Q' }
  ]},
  { label: 'Edit', role: 'editMenu' },
  { label: 'View', submenu: [
    { role: 'reload', label: 'Reload' },
    { role: 'toggleDevTools', label: 'Developer Tools' },
    { type: 'separator' },
    { role: 'togglefullscreen', label: 'Full Screen' }
  ]}
]);
Menu.setApplicationMenu(menu);

// ============ config ============
ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:set', (e, patch) => {
  const cfg = normalizeConfig({ ...readJson(CONFIG_PATH, {}), ...patch });
  writeJson(CONFIG_PATH, cfg);
  return cfg;
});

// ============ provider connection test ============
ipcMain.handle('provider:test', async (e, { baseUrl, apiKey, timeoutMs }) => {
  const url = `${(baseUrl || '').replace(/\/+$/, '')}/models`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 10000);
  try {
    const resp = await fetch(url, { signal: ac.signal, headers: { 'Authorization': `Bearer ${apiKey || ''}` } });
    if (resp.ok) {
      const j = await resp.json();
      const models = (Array.isArray(j.data) ? j.data : []).map((m) => m.id).slice(0, 30);
      return { ok: true, status: resp.status, models, error: null };
    }
    let detail = '';
    try { detail = (await resp.text()).slice(0, 300); } catch {}
    return { ok: false, status: resp.status, models: [], error: `HTTP ${resp.status}: ${detail}` };
  } catch (err) {
    const msg = err.name === 'AbortError' ? '连接超时' : String(err.message || err);
    return { ok: false, status: 0, models: [], error: msg };
  } finally {
    clearTimeout(timer);
  }
});

// ============ projects ============
const PROJECTS_PATH = path.join(DATA_DIR, 'projects.json');
// project folders live in the workspace root (same dir the built-in terminal starts in),
// so folders created/removed in the terminal show up in the workspace list automatically
function getProjectRoot() {
  const cfg = loadConfig();
  return (cfg.sandbox && cfg.sandbox.workspace) || WORKSPACE;
}
ipcMain.handle('projects:load', () => readJson(PROJECTS_PATH, []));
ipcMain.handle('projects:save', (e, projects) => { writeJson(PROJECTS_PATH, projects); return true; });
ipcMain.handle('projects:createFolder', (e, folderPath) => {
  try {
    fs.mkdirSync(String(folderPath || ''), { recursive: true });
    return { ok: true, path: String(folderPath) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});
// delete a project folder from disk. Only paths inside the workspace root are
// allowed — never the root itself or anything outside it (path.resolve normalizes
// `..` so an escape attempt gets caught by the prefix check).
ipcMain.handle('projects:deleteFolder', (e, folderPath) => {
  try {
    const p = String(folderPath || '').trim();
    if (!p) return { ok: false, error: 'empty path' };
    const root = path.resolve(getProjectRoot());
    const target = path.resolve(p);
    if (target === root || !target.startsWith(root + path.sep)) {
      return { ok: false, error: 'path not inside workspace root' };
    }
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---- sync projects with folders created/removed in the terminal ----
let projectScanTimer = null;
let projectWatcher = null;
let projectRootDir = WORKSPACE;
// directories present in the workspace root when the app started. The runtime sweep may only
// auto-add folders that appeared AFTER startup: pre-existing folders (e.g. from the web version,
// which the user explicitly deleted from the desktop) must never pop back in.
let baselineDirs = new Set();

function normPath(p) {
  return String(p || '').toLowerCase().replace(/[\\/]+$/, '');
}

// scanProjectFolders({ allowAdd }):
//  - allowAdd: true  (watch events at runtime)  -> folders that newly appear become projects
//  - allowAdd: false (startup)                  -> existing folders are NOT auto-registered,
//    so pre-existing work folders (e.g. from the web version) never show up as projects
function scanProjectFolders(options) {
  const allowAdd = !!(options && options.allowAdd);
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectRootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return; // root missing / not readable
  }
  const projects = readJson(PROJECTS_PATH, []);
  if (!Array.isArray(projects)) return;
  const dirSet = new Set(dirs);
  const rootNorm = normPath(projectRootDir);
  let changed = false;
  // runtime only: add folders that newly appear and are not yet projects
  if (allowAdd) {
    for (const name of dirs) {
      if (baselineDirs.has(name)) continue; // pre-existing folder, not new -> never auto-add
      const folderPath = path.join(projectRootDir, name);
      const exists = projects.some((p) => p.path && normPath(p.path) === normPath(folderPath));
      if (!exists) {
        projects.push({ id: 'proj-dir-' + name, name, path: folderPath, createdAt: Date.now() });
        changed = true;
      }
    }
  }
  // remove projects whose folder (direct child of the project root) disappeared
  const kept = projects.filter((p) => {
    if (!p.path) return true; // logical project without a folder stays
    if (normPath(path.dirname(p.path)) === rootNorm) return dirSet.has(path.basename(p.path));
    return true; // folder outside the project root is not auto-managed
  });
  if (kept.length !== projects.length) changed = true;
  if (changed) {
    writeJson(PROJECTS_PATH, kept);
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('projects:changed');
  }
}

function scheduleProjectScan() {
  clearTimeout(projectScanTimer);
  projectScanTimer = setTimeout(() => scanProjectFolders({ allowAdd: true }), 300);
}

function startProjectWatcher() {
  projectRootDir = getProjectRoot();
  try {
    if (!fs.existsSync(projectRootDir)) fs.mkdirSync(projectRootDir, { recursive: true });
    projectWatcher = fs.watch(projectRootDir, { persistent: false }, () => scheduleProjectScan());
  } catch {
    // fs.watch unavailable: fall back to polling
    projectWatcher = setInterval(() => scanProjectFolders({ allowAdd: true }), 3000);
  }
  // record the folders that already exist, so the runtime sweep never re-adds them
  try {
    baselineDirs = new Set(fs.readdirSync(projectRootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name));
  } catch {
    baselineDirs = new Set();
  }
  // startup: only clean up disappeared projects, never auto-add pre-existing folders
  scanProjectFolders({ allowAdd: false });
}

// ============ context usage detail ============
function estimateTokens(text) {
  if (!text) return 0;
  let ascii = 0, cjk = 0;
  for (const ch of String(text)) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else cjk++;
  }
  return Math.ceil(ascii / 4 + cjk * 0.75);
}

ipcMain.handle('context:detail', (e, { messages }) => {
  const cfg = loadConfig();
  const p = cfg.providers.find((x) => x.id === cfg.activeProviderId) || cfg.providers[0] || null;
  // system prompt: base + skill + custom instructions + memory + persona + verbosity
  const sysParts = [cfg.systemPrompt || ''];
  sysParts.push('[子任务格式]\n当任务较复杂（需要多个步骤）时，先输出一份子任务清单，每行以 `- [ ] ` 开头；完成某步后改为 `- [x] `。简单任务不要输出清单。');
  const skillId = cfg.activeSkillId || 'default';
  const skill = loadSkills().find((s) => s.id === skillId);
  if (skill && skill.prompt) sysParts.push(`[当前技能: ${skill.name}]\n${skill.prompt}`);
  if (cfg.customInstructions) sysParts.push('[全局自定义指令]\n' + cfg.customInstructions);
  if (cfg.memory && cfg.memory.enabled && cfg.memory.content) sysParts.push('[长期记忆]\n' + cfg.memory.content);
  const personaPrompts = {
    warm: 'Tone: warm and friendly. Be welcoming, empathetic and encouraging.',
    pragmatic: 'Tone: pragmatic and direct. Get to the point, prioritize actionable advice.',
    professional: 'Tone: professional and formal. Precise, well-structured, no slang.',
    humorous: 'Tone: light and humorous. Sprinkle tasteful wit, stay helpful.',
    concise: 'Tone: concise. Short answers, minimal filler.'
  };
  const verbosityPrompts = { concise: 'Output style: concise. Prefer short answers and lists; avoid lengthy explanations.', standard: '', detailed: 'Output style: detailed. Explain thoroughly with examples, rationale and edge cases.' };
  if (personaPrompts[cfg.persona]) sysParts.push('[语气: ' + cfg.persona + ']\n' + personaPrompts[cfg.persona]);
  if (verbosityPrompts[cfg.verbosity]) sysParts.push('[输出风格]\n' + verbosityPrompts[cfg.verbosity]);
  const systemTokens = estimateTokens(sysParts.join('\n\n'));
  // tools: builtin + connected MCP plugins
  const toolDefs = BUILTIN_TOOLS.map((t) => JSON.stringify(t));
  for (const pl of loadPlugins().filter((x) => x.enabled)) {
    const entry = mcpClients.get(pl.id);
    if (entry) toolDefs.push(...entry.tools.map((t) => JSON.stringify(t)));
  }
  const toolsTokens = toolDefs.reduce((s, t) => s + estimateTokens(t), 0);
  // conversation messages
  const msgs = Array.isArray(messages) ? messages : [];
  const messagesTokens = msgs.reduce((s, m) => s + 4 + estimateTokens(m.content || ''), 0);
  return {
    system: systemTokens,
    tools: toolsTokens,
    messages: messagesTokens,
    total: systemTokens + toolsTokens + messagesTokens,
    model: p ? p.model : '',
    toolCount: toolDefs.length
  };
});

// ============ sessions ============
ipcMain.handle('sessions:load', () => readJson(SESSIONS_PATH, []));
ipcMain.handle('sessions:save', (e, sessions) => { writeJson(SESSIONS_PATH, sessions); return true; });

// ============ skills ============
ipcMain.handle('skills:load', () => loadSkills());
ipcMain.handle('skills:save', (e, skills) => { writeJson(SKILLS_PATH, skills); return true; });

// scan Claude Code style skills directory (SKILL.md with YAML frontmatter)
function parseSkillMd(filePath, fallbackId) {
  const text = fs.readFileSync(filePath, 'utf8');
  let name = fallbackId;
  let desc = '';
  let body = text;
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end > 0) {
      const fm = text.slice(3, end);
      body = text.slice(end + 4).trim();
      for (const line of fm.split('\n')) {
        const m = line.match(/^([\w-]+):\s*(.*)$/);
        if (m) {
          const val = m[2].trim().replace(/^["']|["']$/g, '');
          if (m[1] === 'name' && val) name = val;
          if (m[1] === 'description' && val) desc = val;
        }
      }
    }
  }
  return { name, desc, body };
}

ipcMain.handle('skills:scanClaude', (e, dir) => {
  const base = (dir && fs.existsSync(dir)) ? dir : path.join(require('os').homedir(), '.claude', 'skills');
  if (!fs.existsSync(base)) return { ok: false, error: '技能目录不存在: ' + base };
  const results = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of entries) {
      try {
        if (it.isDirectory()) walk(path.join(d, it.name));
        else if (it.name.toLowerCase() === 'skill.md') {
          const fallbackId = path.basename(d);
          const { name, desc, body } = parseSkillMd(path.join(d, it.name), fallbackId);
          if (body && body.length > 20) {
            results.push({
              id: 'claude-' + String(name).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60),
              name: String(name).slice(0, 80),
              desc: String(desc).slice(0, 200),
              prompt: body.slice(0, 8000),
              builtin: false,
              source: 'claude'
            });
          }
        }
      } catch {}
    }
  };
  walk(base);
  return { ok: true, dir: base, count: results.length, skills: results };
});

// ============ plugins (MCP) ============
ipcMain.handle('plugins:load', () => loadPlugins());
ipcMain.handle('plugins:save', (e, plugins) => { writeJson(PLUGINS_PATH, plugins); return true; });
ipcMain.handle('plugins:connect', async (e, plugin) => {
  if (!plugin || !plugin.id) return { ok: false, error: 'missing plugin id' };
  return await connectMcp(plugin);
});
ipcMain.handle('plugins:disconnect', async (e, id) => disconnectMcp(id));
ipcMain.handle('plugins:listTools', async (e, id) => {
  const entry = mcpClients.get(id);
  if (!entry) return { ok: false, error: 'plugin not connected' };
  return { ok: true, tools: entry.tools };
});

// ============ shell ============
function resolveCwd(cwd) {
  return cwd && fs.existsSync(cwd) ? cwd : WORKSPACE;
}

ipcMain.handle('shell:exec', (e, { id, cmd, cwd }) => {
  if (!cmd || typeof cmd !== 'string') return { ok: false, error: 'empty command' };
  const resolved = resolveCwd(cwd);
  const proc = spawn('cmd.exe', ['/d', '/s', '/c', cmd], { cwd: resolved, windowsHide: true, env: process.env });
  const dec = new TextDecoder('gbk');
  shellProcs.set(id, proc);
  proc.stdout.on('data', (d) => {
    if (mainWin) mainWin.webContents.send('shell:data', { id, stream: 'out', data: dec.decode(d, { stream: true }) });
  });
  proc.stderr.on('data', (d) => {
    if (mainWin) mainWin.webContents.send('shell:data', { id, stream: 'err', data: dec.decode(d, { stream: true }) });
  });
  proc.on('error', (err) => {
    if (mainWin) mainWin.webContents.send('shell:done', { id, code: -1, error: String(err.message || err) });
  });
  proc.on('close', (code) => {
    shellProcs.delete(id);
    if (mainWin) mainWin.webContents.send('shell:done', { id, code });
  });
  return { ok: true, cwd: resolved };
});

ipcMain.handle('shell:kill', (e, id) => {
  const proc = shellProcs.get(id);
  if (!proc) return { ok: false };
  exec(`taskkill /PID ${proc.pid} /T /F`, () => {});
  return { ok: true };
});

// ============ chat with tool-calling loop ============
const MAX_TOOL_ROUNDS = 12;
// reasoning_effort is only a real parameter for OpenAI/OpenRouter-style APIs.
// Aggregators / other backends (incl. opencode.ai) reject unknown fields with a 400,
// which surfaces to the user as "connection dropped". Send it only where supported.
const REASONING_SUPPORTED = new Set(['openai', 'openrouter']);
// stream watchdog: abort a round instead of hanging forever on a dead/stalled connection.
// Both limits are generous by design: slow reasoning and aggregator gaps between tokens are
// normal, so the per-round cap is a last-resort backstop, not the expected termination path.
const STREAM_IDLE_MS = 240000;  // no bytes for this long -> treat as disconnected (4 min)
const STREAM_MAX_MS = 1800000;  // hard cap for one streaming round (30 min)

function streamError(status, detail) {
  if (status === 401) return 'API Key 无效或已过期（401）：请在 设置 → API Provider 中检查';
  if (status === 403) return '访问被拒绝（403）：中转拒绝了请求，请检查 Key 与模型名';
  if (status === 429) return '中转限流（429）：请求太频繁，请稍后重试';
  if (status === 502 || status === 503 || status === 504) return `中转服务异常（HTTP ${status}）：请稍后重试`;
  if (status === 400) return `请求被拒绝（400）：${detail || '请求参数非法'}`;
  return `请求失败（HTTP ${status}）${detail ? '：' + detail : ''}`;
}

// context budget: keep system + last 20 non-system messages, then drop oldest
// non-system messages until the serialized body fits ~350KB. Prevents long sessions
// from growing past the proxy's request-size limit (surfaces as "connection dropped").
function trimContext(msgs) {
  const system = msgs.filter((m) => m.role === 'system');
  const tail = msgs.filter((m) => m.role !== 'system').slice(-20);
  const out = [...system, ...tail];
  const MAX_BYTES = 350 * 1024;
  while (out.length > 1 && JSON.stringify(out).length > MAX_BYTES) {
    const idx = out.findIndex((m) => m.role !== 'system');
    if (idx < 0) break;
    out.splice(idx, 1);
  }
  return out;
}

// throttle per-token deltas into batched chat:chunk pushes so the renderer
// re-renders ~25x/s instead of per-token.
function makeDeltaSender(requestId) {
  let pendingText = '';
  let pendingReasoning = '';
  let timer = null;
  const flush = () => {
    if (pendingText) { try { sendToRenderer({ requestId, text: pendingText }); } catch {} pendingText = ''; }
    if (pendingReasoning) { try { sendToRenderer({ requestId, reasoning: pendingReasoning }); } catch {} pendingReasoning = ''; }
    if (timer) { clearTimeout(timer); timer = null; }
  };
  return {
    push(d) {
      if (d.text) pendingText += d.text;
      if (d.reasoning) pendingReasoning += d.reasoning;
      if (!timer) timer = setTimeout(flush, 40);
    },
    flush
  };
}

async function streamRound(provider, ac, msgs, cfg, tools, onDelta, opts) {
  // one streaming request; returns { content, reasoning, toolCalls, truncated }
  const idleMs = (opts && opts.idleMs) || STREAM_IDLE_MS;
  const maxMs = (opts && opts.maxMs) || STREAM_MAX_MS;
  const idleSec = Math.round(idleMs / 1000);
  const maxMin = Math.round(maxMs / 60000);
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const thinkingLevel = (provider.modelThinking || {})[provider.model] || 'off';
  const body = {
    model: provider.model,
    messages: msgs,
    temperature: cfg.temperature,
    stream: true,
    ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {})
  };
  if (thinkingLevel !== 'off' && REASONING_SUPPORTED.has(provider.id)) body.reasoning_effort = thinkingLevel;

  const localAc = new AbortController();
  const onOuterAbort = () => localAc.abort();
  ac.signal.addEventListener('abort', onOuterAbort);
  const start = Date.now();
  let watchdog = null; // 'idle' | 'total' | null
  let idleTimer = null;
  let emittedContent = 0;
  let emittedReasoning = 0;
  const cleanup = () => {
    clearTimeout(idleTimer);
    ac.signal.removeEventListener('abort', onOuterAbort);
  };
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { watchdog = 'idle'; localAc.abort(); }, idleMs);
  };
  // A "stall error" marks a connection that dropped with no useful output yet. It carries
  // `stall` + `emitted` so the round loop can auto-retry (emitted===0) instead of killing
  // the run, and gives the user a precise reason when it does surface.
  const stallError = (why) => {
    const er = new Error(`连接中断：${why}，已停止`);
    er.stall = true;
    er.emitted = emittedContent + emittedReasoning;
    return er;
  };
  const doFetch = () => fetch(url, {
    method: 'POST',
    signal: localAc.signal,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
    body: JSON.stringify(body)
  });

  try {
    // arm the idle watchdog BEFORE fetching so a slow header / aggregator-queue wait is
    // covered by our own timer instead of undici's internal 300s timeout.
    touch();
    let resp;
    try {
      resp = await doFetch();
      // one retry for transient proxy errors; no tool has executed yet this round, so it's safe
      if ((resp.status === 429 || resp.status >= 500) && !ac.signal.aborted) {
        await new Promise((r) => setTimeout(r, 1200));
        if (!ac.signal.aborted) resp = await doFetch();
      }
    } catch (e) {
      // our own watchdog fired while waiting for headers -> no bytes yet, treat as a stall
      if (e && e.name === 'AbortError' && watchdog && localAc.signal.aborted && !ac.signal.aborted) {
        throw stallError(watchdog === 'idle' ? `超过 ${idleSec} 秒未收到数据` : `单轮处理超过 ${maxMin} 分钟`);
      }
      // undici's own HTTP timeout (UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT) surfaces
      // as an AbortError that is neither our signal nor the outer one. Without this, the
      // round loop misreads it as an injection soft-interrupt and silently retries forever
      // (UI shows "running" with no output, then the run eventually stops on its own).
      if (e && e.name === 'AbortError' && !ac.signal.aborted && !localAc.signal.aborted) {
        throw stallError('中转长时间未响应');
      }
      throw e;
    }
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 500); } catch {}
      throw new Error(streamError(resp.status, detail));
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let reasoning = '';
    const toolCalls = [];
    let doneFlag = false;
    let sawDone = false;
    let finishReason = '';
    touch();

    while (!doneFlag) {
      if (Date.now() - start > maxMs) { watchdog = 'total'; localAc.abort(); }
      let read;
      try { read = await reader.read(); }
      catch (e) {
        if (watchdog) throw stallError(watchdog === 'idle'
          ? `超过 ${idleSec} 秒未收到数据`
          : `单轮处理超过 ${maxMin} 分钟`);
        throw e;
      }
      if (read.done) break; // abnormal close (no [DONE]) exits here; flagged as truncated below
      touch();
      emittedContent = content.length;
      emittedReasoning = reasoning.length;
      buf += decoder.decode(read.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        // [DONE] is the stream terminator — stop reading even if the proxy keeps the socket open
        if (payload === '[DONE]') { clearTimeout(idleTimer); doneFlag = true; sawDone = true; buf = ''; break; }
        try {
          const json = JSON.parse(payload);
          const choice = json.choices && json.choices[0];
          const delta = choice && choice.delta;
          if (!delta) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          let dc = '', dr = '';
          if (delta.content) { content += delta.content; dc = delta.content; }
          // thinking traces: deepseek uses reasoning_content, openai uses reasoning (string or object)
          if (delta.reasoning_content) { reasoning += delta.reasoning_content; dr = delta.reasoning_content; }
          if (delta.reasoning) {
            const r = typeof delta.reasoning === 'string' ? delta.reasoning : (delta.reasoning.content || '');
            if (r) { reasoning += r; dr = r; }
          }
          if ((dc || dr) && onDelta) { try { onDelta({ text: dc, reasoning: dr }); } catch {} }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const i = tc.index != null ? tc.index : 0;
              if (!toolCalls[i]) toolCalls[i] = { id: tc.id || '', name: '', arguments: '' };
              if (tc.id) toolCalls[i].id = tc.id;
              if (tc.function && tc.function.name) toolCalls[i].name = tc.function.name;
              if (tc.function && tc.function.arguments) toolCalls[i].arguments += tc.function.arguments;
            }
          }
        } catch {}
      }
    }
    cleanup();
    // A round is truncated when the backend cut it short without a clean stop:
    // finish_reason length/max_tokens, or the socket closed with no [DONE]/stop marker
    // (common when an aggregator hits its own idle/output cap and drops the connection).
    const cleanEnd = sawDone || finishReason === 'stop' || finishReason === 'tool_calls';
    const truncated = !cleanEnd || finishReason === 'length' || finishReason === 'max_tokens';
    // drop nameless tool calls: empty name + empty args previously spawned `cmd.exe /c ''`
    return { content, reasoning, toolCalls: toolCalls.filter(Boolean).filter((tc) => tc.name && tc.name.trim()), truncated };
  } catch (e) {
    cleanup();
    throw e;
  }
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return { raw: s }; }
}

ipcMain.handle('chat:start', async (e, { requestId, messages, providerId, temperature, skillId, useTools }) => {
  const cfg = loadConfig();
  const provider = cfg.providers.find((p) => p.id === (providerId || cfg.activeProviderId)) || cfg.providers[0];
  if (!provider) {
    sendToRenderer({ requestId, done: true, error: '没有可用的 API 提供商，请先在设置中添加' });
    return { ok: false };
  }
  if (!provider.apiKey) {
    // empty key => every request 401s, which the user experiences as "connection dropped"
    sendToRenderer({ requestId, done: true, error: '未配置 API Key：请在 设置 → 通用 → API Provider 中填写后重试' });
    return { ok: false };
  }
  const ac = new AbortController();
  chatAborts.set(requestId, ac);

  // attach global instructions / memory / persona / verbosity + skill prompt to the system message
  const PERSONA_PROMPTS = {
    warm: 'Tone: warm and friendly. Be welcoming, empathetic and encouraging.',
    pragmatic: 'Tone: pragmatic and direct. Get to the point, prioritize actionable advice.',
    professional: 'Tone: professional and formal. Precise, well-structured, no slang.',
    humorous: 'Tone: light and humorous. Sprinkle tasteful wit, stay helpful.',
    concise: 'Tone: concise. Short answers, minimal filler.'
  };
  const VERBOSITY_PROMPTS = {
    concise: 'Output style: concise. Prefer short answers and lists; avoid lengthy explanations.',
    standard: '',
    detailed: 'Output style: detailed. Explain thoroughly with examples, rationale and edge cases.'
  };
  let msgs = messages.map((m) => ({ ...m }));
  // context budget: keep history from growing past the proxy's request-size limit,
  // which otherwise surfaces as "connection dropped" on long sessions
  msgs = trimContext(msgs);
  const sysParts = [];
  sysParts.push('[子任务格式]\n当任务较复杂（需要多个步骤）时，先输出一份子任务清单，每行以 `- [ ] ` 开头（如 `- [ ] 安装依赖`）；完成某步后，在后续回合把该行改为 `- [x] `。简单任务不要输出清单。');
  if (skillId) {
    const skill = loadSkills().find((s) => s.id === skillId);
    if (skill && skill.prompt) sysParts.push(`[当前技能: ${skill.name}]\n${skill.prompt}`);
  }
  if (cfg.customInstructions) sysParts.push('[全局自定义指令]\n' + cfg.customInstructions);
  if (cfg.memory && cfg.memory.enabled && cfg.memory.content) sysParts.push('[长期记忆]\n' + cfg.memory.content);
  if (PERSONA_PROMPTS[cfg.persona]) sysParts.push(`[语气: ${cfg.persona}]\n` + PERSONA_PROMPTS[cfg.persona]);
  if (VERBOSITY_PROMPTS[cfg.verbosity]) sysParts.push('[输出风格]\n' + VERBOSITY_PROMPTS[cfg.verbosity]);
  if (sysParts.length) {
    const extra = '\n\n' + sysParts.join('\n\n');
    const sysIdx = msgs.findIndex((m) => m.role === 'system');
    if (sysIdx >= 0) msgs[sysIdx] = { ...msgs[sysIdx], content: msgs[sysIdx].content + extra };
    else msgs.unshift({ role: 'system', content: extra.trim() });
  }

  // collect tools: builtin + connected enabled MCP plugins
  let tools = [];
  if (useTools !== false) {
    tools = BUILTIN_TOOLS.map((t) => ({ type: 'function', function: t }));
    const plugins = loadPlugins().filter((p) => p.enabled);
    for (const p of plugins) {
      const entry = mcpClients.get(p.id);
      if (entry) tools.push(...entry.tools);
    }
  }

  try {
    let reachedLimit = false;
    const idleMs = (cfg.chat && cfg.chat.streamIdleMs) || STREAM_IDLE_MS;
    const maxMs = (cfg.chat && cfg.chat.streamMaxMs) || STREAM_MAX_MS;
    const roundOpts = { idleMs, maxMs };
    const STALL_RETRIES = 2;  // auto-retries for a stall that produced no output at all
    const CONTINUE_CAP = 2;   // auto-continuations when the backend truncates a reply
    let continues = 0;
    const sender = makeDeltaSender(requestId);
    activeStream = { requestId, sender };
    const deltaSend = sender;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (ac.signal.aborted) break;
      drainInjections(requestId, msgs);
      // each round gets its own AbortController so a mid-run injection can interrupt
      // just this round; a full stop aborts the outer controller, which chains down.
      const roundAc = new AbortController();
      const onOuterAbort = () => roundAc.abort();
      ac.signal.addEventListener('abort', onOuterAbort);
      chatRounds.set(requestId, roundAc);
      try {
        let content, reasoning, toolCalls, truncated;
        // a stall that emitted nothing is usually a transient proxy drop: retry the same
        // round (no bytes shown, no tool ran) instead of killing the whole run.
        for (let stallTries = 0; ; stallTries++) {
          try {
            ({ content, reasoning, toolCalls, truncated } = await streamRound(provider, roundAc, msgs, cfg, tools, (d) => deltaSend.push(d), roundOpts));
            break;
          } catch (re) {
            // user hit stop / injected mid-stall-retry -> surface as an abort so the round
            // loop can either quit cleanly (stop) or drain the injection (soft-interrupt).
            if (ac.signal.aborted || roundAc.signal.aborted) {
              throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            }
            if (re && re.stall && re.emitted === 0 && stallTries < STALL_RETRIES) {
              await new Promise((r) => setTimeout(r, 1500));
              continue;
            }
            throw re;
          }
        }
        deltaSend.flush();
        if (!toolCalls.length) {
          // backend cut the reply short (length cap / dropped socket): nudge it to continue
          // in a fresh round so long answers aren't silently truncated.
          if (truncated && (content || '').trim() && continues < CONTINUE_CAP && !ac.signal.aborted) {
            continues++;
            msgs.push({ role: 'assistant', content: content || '' });
            msgs.push({ role: 'user', content: '[系统提示：上一条回复因长度限制被截断，请紧接着继续输出剩余内容；不要重复已写内容，不要做总结。]' });
            continue;
          }
          break;
        }

        // assistant turn with tool_calls (arguments normalized so a malformed payload
        // never poisons the next round's request with raw text that proxies reject)
        msgs.push({
          role: 'assistant',
          content: content || '',
          tool_calls: toolCalls.map((tc) => {
            const p = safeJsonParse(tc.arguments);
            return { id: tc.id, type: 'function', function: { name: tc.name, arguments: (p && !p.raw) ? JSON.stringify(p) : '{}' } };
          })
        });
        for (const tc of toolCalls) {
          if (ac.signal.aborted) break;
          const args = safeJsonParse(tc.arguments);
          const risk = toolRisk(tc.name, args);
          const needsConfirm = needsApproval(cfg.approvalPolicy, risk);
          sendToRenderer({ requestId, tool: { id: tc.id, name: tc.name, status: 'start', risk } });
          if (needsConfirm) {
            sendToRenderer({ requestId, tool: { id: tc.id, name: tc.name, args, risk, status: 'confirm' } });
            const approved = await requestToolConfirm(requestId, tc.name, args);
            if (!approved) {
              sendToRenderer({ requestId, tool: { id: tc.id, name: tc.name, status: 'done' } });
              msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'user denied tool execution' }) });
              continue;
            }
          }
          let out;
          try { out = await runTool(tc.name, args, (cfg.sandbox && cfg.sandbox.workspace) || WORKSPACE); }
          catch (err) { out = { error: String(err.message || err) }; }
          sendToRenderer({ requestId, tool: { id: tc.id, name: tc.name, status: 'done', summary: summarizeToolResult(out) } });
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out).slice(0, 6000) });
        }
        if (round === MAX_TOOL_ROUNDS - 1) reachedLimit = true;
      } catch (err) {
        // injection soft-interrupt (round aborted, outer still alive) => rejoin the
        // loop so the queued instruction is drained at the top of the next round.
        if (err && err.name === 'AbortError' && !ac.signal.aborted) continue;
        throw err;
      } finally {
        chatRounds.delete(requestId);
        ac.signal.removeEventListener('abort', onOuterAbort);
      }
    }
    // final plain round if the tool-round cap was hit OR an injection is still queued,
    // so the model gives a concluding (or redirected) answer instead of being cut off.
    const needFinal = reachedLimit || (chatInjections.get(requestId) || []).length > 0;
    if (needFinal && !ac.signal.aborted) {
      drainInjections(requestId, msgs);
      await streamRound(provider, ac, msgs, cfg, [], (d) => deltaSend.push(d), roundOpts);
      deltaSend.flush();
    }
    sendToRenderer({ requestId, done: true });
    return { ok: true };
  } catch (err) {
    const aborted = err.name === 'AbortError';
    // always signal done so the renderer can finalize, even on abort
    sendToRenderer({ requestId, done: true, ...(!aborted ? { error: String(err.message || err) } : {}) });
    return { ok: false, aborted };
  } finally {
    chatAborts.delete(requestId);
    chatRounds.delete(requestId);
    chatInjections.delete(requestId);
    if (activeStream && activeStream.requestId === requestId) activeStream = null;
    toolConfirmWaiters.delete(requestId);
  }
});

function summarizeToolResult(out) {
  if (!out) return '';
  if (typeof out === 'string') return out.slice(0, 120);
  const s = JSON.stringify(out);
  return s ? s.slice(0, 120) : '';
}

ipcMain.handle('chat:abort', (e, requestId) => {
  const ac = chatAborts.get(requestId);
  if (ac) ac.abort();
  // killing the fetch does NOT stop an in-flight cmd.exe tool — terminate those too
  [...toolShellProcs].forEach((proc) => {
    if (proc.pid) { try { exec(`taskkill /PID ${proc.pid} /T /F`, () => {}); } catch {} }
  });
  const w = toolConfirmWaiters.get(requestId);
  if (w) { toolConfirmWaiters.delete(requestId); w(false); }
  return { ok: true };
});

// mid-run steering: queue a new instruction and soft-interrupt only the current
// round, so the loop drains the instruction and redirects without killing the request.
const INJECT_PREFIX = '【中途指令】用户在你运行途中发来新指令。请先暂停手头工作，认真理解并优先响应这条新指令，然后按新方向继续：\n';
function drainInjections(requestId, msgs) {
  const q = chatInjections.get(requestId);
  if (!q || !q.length) return false;
  while (q.length) msgs.push({ role: 'user', content: INJECT_PREFIX + q.shift() });
  return true;
}

ipcMain.handle('chat:inject', (e, { requestId, text }) => {
  const t = String(text || '').trim();
  const ac = chatAborts.get(requestId);
  if (!t || !ac || ac.signal.aborted) return { ok: false, error: 'run is not active' };
  // flush any buffered streaming text first so no stale chunk lands after the inject marker
  const st = activeStream;
  if (st && st.requestId === requestId) { try { st.sender.flush(); } catch {} }
  const q = chatInjections.get(requestId) || [];
  q.push(t);
  chatInjections.set(requestId, q);
  const ra = chatRounds.get(requestId);
  if (ra) { try { ra.abort(); } catch {} }
  sendToRenderer({ requestId, injected: t });
  return { ok: true, queued: q.length };
});

// ---------- app info ----------
ipcMain.handle('app:info', () => {
  const cfg = loadConfig();
  return {
    version: app.getVersion(),
    platform: process.platform,
    workspace: (cfg.sandbox && cfg.sandbox.workspace) || WORKSPACE,
    projectRoot: getProjectRoot(),
    dataDir: DATA_DIR,
    electron: process.versions.electron
  };
});

// ---------- self-improve (analyze sessions -> skill suggestions) ----------
const SELFIMPROVE_SYSTEM = `你是一个技能提炼助手（self-improve）。分析用户提供的会话记录，找出用户反复执行的工作模式，提炼为可复用的技能（skill）。
只输出严格 JSON（不要任何其他文字、不要 markdown 代码块）：
{
  "skills": [
    { "name": "技能名", "description": "一句话描述（何时触发/使用）", "prompt": "技能指令（告诉 AI 如何完成该任务，包含步骤、要点、输出格式）" }
  ],
  "upgrades": [
    { "name": "已有技能名（必须与用户提供的现有技能名完全一致）", "prompt": "改进后的技能指令" }
  ]
}
- skills：最多 3 个值得新建的技能（只在有明确重复模式时给出，不要凑数）
- upgrades：最多 3 个对现有技能的改进（改进其 prompt，使其更贴合用户实际用法）
- 没有建议时返回 {"skills": [], "upgrades": []}`;

ipcMain.handle('selfimprove:run', async (e, { sessionsText, existingSkills }) => {
  const cfg = loadConfig();
  const provider = cfg.providers.find((p) => p.id === cfg.activeProviderId) || cfg.providers[0];
  if (!provider) return { ok: false, error: '没有可用的 API 提供商，请先在设置中添加' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120000);
  try {
    const user = `现有技能列表：${existingSkills || ''}\n\n会话记录：\n${String(sessionsText || '').slice(0, 30000)}`;
    const { content } = await streamRound(provider, ac, [
      { role: 'system', content: SELFIMPROVE_SYSTEM },
      { role: 'user', content: user }
    ], cfg, []);
    let parsed = null;
    const jsonMatch = String(content || '').match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch {}
    }
    if (!parsed || !Array.isArray(parsed.skills)) {
      return { ok: true, text: String(content || ''), skills: [], upgrades: [], parseFailed: true };
    }
    return {
      ok: true,
      text: String(content || ''),
      skills: (parsed.skills || []).slice(0, 3),
      upgrades: (parsed.upgrades || []).slice(0, 3)
    };
  } catch (err) {
    const msg = err.name === 'AbortError' ? '分析超时（120 秒）' : String(err.message || err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
});

// ---------- lifecycle ----------
// stable taskbar identity: same AppUserModelID => taskbar groups/merges windows together
app.setAppUserModelId('com.deepseek.desktop');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // taskbar icon clicked on a pinned portable exe re-runs the stub -> lands here.
    // Toggle: minimized -> restore; visible+focused -> fold back to the taskbar icon; else show.
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) {
        mainWin.restore();
        mainWin.show();
        mainWin.moveTop();
        mainWin.focus();
      } else if (mainWin.isVisible() && mainWin.isFocused()) {
        mainWin.minimize();
      } else {
        mainWin.show();
        mainWin.moveTop();
        mainWin.focus();
      }
    } else {
      createWindow();
    }
  });
  app.whenReady().then(() => {
    ensureDataDir();
    startProjectWatcher();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { app.quit(); });
}

app.on('web-contents-created', (e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.DSH_DEBUG) {
    contents.on('console-message', (event, level, message, line, sourceId) => {
      if (level && typeof level === 'object') {
        ({ level, message, lineNumber: line, sourceId } = level);
      }
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    contents.on('render-process-gone', (ev, details) => {
      console.log(`[renderer-gone] ${JSON.stringify(details)}`);
    });
  }
});