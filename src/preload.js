'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsh', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch)
  },
  provider: {
    test: (opts) => ipcRenderer.invoke('provider:test', opts)
  },
  sessions: {
    load: () => ipcRenderer.invoke('sessions:load'),
    save: (sessions) => ipcRenderer.invoke('sessions:save', sessions)
  },
  projects: {
    load: () => ipcRenderer.invoke('projects:load'),
    save: (projects) => ipcRenderer.invoke('projects:save', projects),
    createFolder: (folderPath) => ipcRenderer.invoke('projects:createFolder', folderPath),
    deleteFolder: (folderPath) => ipcRenderer.invoke('projects:deleteFolder', folderPath),
    onChanged: (cb) => ipcRenderer.on('projects:changed', () => cb())
  },
  context: {
    detail: (messages) => ipcRenderer.invoke('context:detail', { messages })
  },
  skills: {
    load: () => ipcRenderer.invoke('skills:load'),
    save: (skills) => ipcRenderer.invoke('skills:save', skills),
    scanClaude: (dir) => ipcRenderer.invoke('skills:scanClaude', dir)
  },
  selfimprove: {
    run: (sessionsText, existingSkills) => ipcRenderer.invoke('selfimprove:run', { sessionsText, existingSkills })
  },
  plugins: {
    load: () => ipcRenderer.invoke('plugins:load'),
    save: (plugins) => ipcRenderer.invoke('plugins:save', plugins),
    connect: (plugin) => ipcRenderer.invoke('plugins:connect', plugin),
    disconnect: (id) => ipcRenderer.invoke('plugins:disconnect', id),
    listTools: (id) => ipcRenderer.invoke('plugins:listTools', id)
  },
  tool: {
    confirmReply: (requestId, approved) => ipcRenderer.invoke('tool:confirm:reply', { requestId, approved })
  },
  shell: {
    exec: (id, cmd, cwd) => ipcRenderer.invoke('shell:exec', { id, cmd, cwd }),
    kill: (id) => ipcRenderer.invoke('shell:kill', id),
    onData: (cb) => ipcRenderer.on('shell:data', (e, d) => cb(d)),
    onDone: (cb) => ipcRenderer.on('shell:done', (e, d) => cb(d))
  },
  chat: {
    start: (opts) => ipcRenderer.invoke('chat:start', opts),
    abort: (requestId) => ipcRenderer.invoke('chat:abort', requestId),
    inject: (requestId, text) => ipcRenderer.invoke('chat:inject', { requestId, text }),
    onChunk: (cb) => ipcRenderer.on('chat:chunk', (e, d) => cb(d))
  },
  app: {
    info: () => ipcRenderer.invoke('app:info')
  }
});
