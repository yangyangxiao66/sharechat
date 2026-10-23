import { app, BrowserWindow, ipcMain, nativeTheme, shell, clipboard } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandLine } from '../src/core.js';
import { assertClaudeLaunchAllowed } from '../src/claude-guard.js';
import { withSkipPermissions } from './resume-command.js';
import { TerminalHost } from './terminal-host.js';
import { sessionTask, stopSessionTasks } from './session-tasks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
app.setName('sharechat');
// Windows groups taskbar buttons by AppUserModelID; without a dedicated one the
// dev build inherits electron.exe's atom icon instead of the sharechat logo.
if (process.platform === 'win32') app.setAppUserModelId('io.github.yangyangxiao66.sharechat');
let mainWindow = null;
let terminalHost = null;

const overlay = () => (nativeTheme.shouldUseDarkColors
  ? { color: '#16171b', symbolColor: '#c9cbd3', height: 44 }
  : { color: '#f4f2ee', symbolColor: '#3a3b40', height: 44 });

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 980,
    minHeight: 600,
    title: 'sharechat',
    icon: path.join(here, 'renderer', 'assets', 'sharechat-icon.png'),
    autoHideMenuBar: true,
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
  mainWindow = win;
  terminalHost = new TerminalHost(win, mode => {
    if (!win.isDestroyed()) win.webContents.send('workspace:view', mode);
  });
  const updateTheme = () => {
    if (!win.isDestroyed() && process.platform !== 'darwin') win.setTitleBarOverlay(overlay());
  };
  nativeTheme.on('updated', updateTheme);
  win.on('closed', () => {
    terminalHost?.dispose();
    terminalHost = null;
    mainWindow = null;
    nativeTheme.removeListener('updated', updateTheme);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(path.join(here, 'renderer', 'index.html'));

  // Dev aid: OPENCHAT_SCREENSHOT=out.png [OPENCHAT_SCRIPT=js] captures the window and quits.
  const shot = process.env.SHARECHAT_SCREENSHOT || process.env.OPENCHAT_SCREENSHOT;
  if (shot) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, Number(process.env.SHARECHAT_SHOT_DELAY || process.env.OPENCHAT_SHOT_DELAY) || 6000));
      const script = process.env.SHARECHAT_SCRIPT || process.env.OPENCHAT_SCRIPT;
      if (script) {
        await win.webContents.executeJavaScript(script);
        await new Promise((r) => setTimeout(r, 4000));
      }
      const img = await win.webContents.capturePage();
      (await import('node:fs')).writeFileSync(shot, img.toPNG());
      app.quit();
    });
  }
}


const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
  if (_e.sender !== mainWindow?.webContents) return { ok: false, error: '无效的窗口请求' };
  try { return { ok: true, data: await fn(...args) }; }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
});

handle('agents', () => sessionTask('agents'));

handle('sessions', () => sessionTask('sessions'));

handle('session:load', (meta) => sessionTask('load', { meta }));

handle('workspace:view', async mode => {
  if (mode !== 'sessions' && mode !== 'terminal') throw new Error('未知视图');
  await terminalHost.setVisible(mode === 'terminal');
  return { mode: terminalHost.visible ? 'terminal' : 'sessions' };
});

async function launchWorkBuddyApp(appPath) {
  if (!appPath) throw new Error('会话已写入，但没有找到 WorkBuddy 可执行文件，请手动打开 WorkBuddy');
  await new Promise((resolve, reject) => {
    const child = spawn(appPath, [], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

handle('convert', async ({ meta, target, model, launch, skipPermissions }) => {
  const isSelfResume = target === meta.agent;
  if (launch && target === 'claude') await assertClaudeLaunchAllowed();
  if (launch && target !== 'workbuddy' && target !== 'chatgpt') await terminalHost.ensure();
  const r = isSelfResume
    ? await sessionTask('resume', { meta })
    : await sessionTask('convert', { meta, target, model });
  const resume = skipPermissions === true && r.resume ? withSkipPermissions(r.resume) : r.resume;
  const result = resume === r.resume ? r : { ...r, resume };
  const command = result.openUrl || (result.resume ? commandLine(result.resume) : '');
  let terminalId = null;
  let launchError = null;
  let launchedApp = null;
  if (launch) {
    if (result.openUrl) {
      try {
        await shell.openExternal(result.openUrl);
        launchedApp = result.target;
      } catch (error) {
        launchError = error.message || String(error);
      }
    } else if (result.target === 'workbuddy') {
      try {
        await launchWorkBuddyApp(result.workbuddyApp);
        launchedApp = 'workbuddy';
      } catch (error) {
        launchError = error.message || String(error);
      }
    } else {
      try {
        terminalId = await terminalHost.launch(result);
      } catch (error) {
        launchError = error.message;
        await terminalHost?.setVisible(false);
      }
    }
  }
  return { ...result, command, terminalId, launchError, launchedApp };
});

handle('opencode:models', () => sessionTask('models'));

handle('reveal', (p) => { if (p) shell.showItemInFolder(p); });
handle('open-folder', (p) => shell.openPath(p));
handle('copy', (text) => clipboard.writeText(String(text)));

app.whenReady().then(() => {
  // OPENCHAT_THEME=light|dark overrides the system theme.
  const theme = process.env.SHARECHAT_THEME || process.env.OPENCHAT_THEME || 'system';
  if (['light', 'dark', 'system'].includes(theme)) nativeTheme.themeSource = theme;
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopSessionTasks);
