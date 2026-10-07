'use strict';
// Bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  on,
  app: {
    info: invoke('app:info'),
    setTitle: invoke('app:setTitle'),
    closeConfirmed: () => ipcRenderer.send('app:closeConfirmed'),
  },
  settings: { get: invoke('settings:get'), set: invoke('settings:set') },
  dialog: {
    openFolder: invoke('dialog:openFolder'),
    openFile: invoke('dialog:openFile'),
    saveAs: invoke('dialog:saveAs'),
    confirm: invoke('dialog:confirm'),
  },
  workspace: { open: invoke('workspace:open'), close: invoke('workspace:close'), root: invoke('workspace:root') },
  fs: {
    readDir: invoke('fs:readDir'),
    readFile: invoke('fs:readFile'),
    writeFile: invoke('fs:writeFile'),
    createFile: invoke('fs:createFile'),
    createDir: invoke('fs:createDir'),
    rename: invoke('fs:rename'),
    delete: invoke('fs:delete'),
    exists: invoke('fs:exists'),
    stat: invoke('fs:stat'),
    listFiles: invoke('fs:listFiles'),
    search: invoke('fs:search'),
    watch: invoke('fs:watch'),
  },
  path: { join: invoke('path:join'), relative: invoke('path:relative') },
  ai: {
    chat: invoke('ai:chat'),
    cancel: invoke('ai:cancel'),
    approve: invoke('ai:approve'),
    complete: invoke('ai:complete'),
    cancelComplete: invoke('ai:cancelComplete'),
    models: invoke('ai:models'),
    test: invoke('ai:test'),
    revert: invoke('ai:revert'),
  },
  term: {
    create: invoke('term:create'),
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    kill: invoke('term:kill'),
  },
  shell: {
    openExternal: invoke('shell:openExternal'),
    showItemInFolder: invoke('shell:showItemInFolder'),
    openPath: invoke('shell:openPath'),
  },
});
