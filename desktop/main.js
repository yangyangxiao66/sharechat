import { app, BrowserWindow, ipcMain, nativeTheme, shell, clipboard } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentInfo, listSessions, loadSession, convertSession, openInTerminal, commandLine } from '../src/core.js';
import { summarizeInput } from '../src/render.js';
import { clip, runCli } from '../src/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_PREVIEW = 400;

const overlay = () => (nativeTheme.shouldUseDarkColors
  ? { color: '#16171b', symbolColor: '#c9cbd3', height: 44 }
  : { color: '#f4f2ee', symbolColor: '#3a3b40', height: 44 });

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 980,
    minHeight: 600,
    title: 'openchat',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171b' : '#f4f2ee',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : overlay(),
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  nativeTheme.on('updated', () => {
    if (process.platform !== 'darwin') win.setTitleBarOverlay(overlay());
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(path.join(here, 'renderer', 'index.html'));

  // Dev aid: OPENCHAT_SCREENSHOT=out.png [OPENCHAT_SCRIPT=js] captures the window and quits.
  const shot = process.env.OPENCHAT_SCREENSHOT;
  if (shot) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, Number(process.env.OPENCHAT_SHOT_DELAY) || 6000));
      if (process.env.OPENCHAT_SCRIPT) {
        await win.webContents.executeJavaScript(process.env.OPENCHAT_SCRIPT);
        await new Promise((r) => setTimeout(r, 4000));
      }
      const img = await win.webContents.capturePage();
      (await import('node:fs')).writeFileSync(shot, img.toPNG());
      app.quit();
    });
  }
}

// Trim a session for display: the renderer only needs readable text.
function preview(session) {
  const msgs = session.messages;
  const start = Math.max(0, msgs.length - MAX_PREVIEW);
  return {
    ...session,
    file: session.file || null,
    total: msgs.length,
    omitted: start,
    messages: msgs.slice(start).map((m) => (m.role === 'user'
      ? { role: 'user', text: clip(m.text, 6000), ts: m.ts }
      : {
          role: 'assistant', ts: m.ts,
          parts: m.parts.map((p) => (p.type === 'text'
            ? { type: 'text', text: clip(p.text, 6000) }
            : { type: 'tool', name: p.name, input: summarizeInput(p.input, 240), output: clip(p.output ?? '', 2000), isError: p.isError })),
        })),
    rawMarkdown: session.rawMarkdown ? clip(session.rawMarkdown, 60000) : undefined,
  };
}

const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
});

handle('agents', () => agentInfo());

handle('sessions', () => {
  const errors = [];
  const rows = listSessions({ onError: (agent, e) => errors.push({ agent, message: e.message }) });
  return { rows, errors };
});

handle('session:load', (meta) => preview(loadSession(meta).session));

handle('convert', ({ meta, target, model, launch }) => {
  const r = convertSession(meta, target, { model: model || undefined });
  const command = commandLine(r.resume);
  if (launch) openInTerminal(r.resume, r.cwd);
  return { ...r, command };
});

handle('opencode:models', () => (runCli('opencode', ['models'], { timeout: 120000 }) || '')
  .split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[^\s/]+\/\S+$/.test(l)));

handle('reveal', (p) => { if (p) shell.showItemInFolder(p); });
handle('open-folder', (p) => shell.openPath(p));
handle('copy', (text) => clipboard.writeText(String(text)));

app.whenReady().then(() => {
  // OPENCHAT_THEME=light|dark overrides the system theme.
  if (['light', 'dark'].includes(process.env.OPENCHAT_THEME)) nativeTheme.themeSource = process.env.OPENCHAT_THEME;
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
