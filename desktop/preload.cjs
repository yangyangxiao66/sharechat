const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

contextBridge.exposeInMainWorld('openchat', {
  platform: process.platform,
  agents: () => call('agents'),
  sessions: () => call('sessions'),
  load: (meta) => call('session:load', meta),
  convert: (req) => call('convert', req),
  opencodeModels: () => call('opencode:models'),
  reveal: (p) => call('reveal', p),
  openFolder: (p) => call('open-folder', p),
  copy: (text) => call('copy', text),
});
