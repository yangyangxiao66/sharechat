import { WebContentsView, ipcMain, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resumeCommand } from './resume-command.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../modules/terminal');
const runtime = require('../modules/terminal/main.js');
const HEADER_HEIGHT = 44;

export class TerminalHost {
  constructor(window, onViewChange) {
    this.window = window;
    this.onViewChange = onViewChange;
    this.view = null;
    this.visible = false;
    this.pending = new Map();
    this.ready = null;
    this.disposed = false;
    this.resize = () => {
      if (!this.view || this.disposed) return;
      const [width, height] = window.getContentSize();
      this.view.setBounds({ x: 0, y: HEADER_HEIGHT, width, height: Math.max(0, height - HEADER_HEIGHT) });
    };
    this.onResult = (event, result = {}) => {
      if (event.sender !== this.view?.webContents) return;
      const request = this.pending.get(result.requestId);
      if (!request) return;
      this.pending.delete(result.requestId);
      clearTimeout(request.timer);
      result.error ? request.reject(new Error(result.error)) : request.resolve(result.id);
    };
    ipcMain.on('terminal:host-launch-result', this.onResult);
    window.on('resize', this.resize);
  }

  async ensure() {
    if (this.disposed) throw new Error('窗口已关闭');
    if (this.ready) return this.ready;
    this.view = new WebContentsView({ webPreferences: {
      preload: path.join(root, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    } });
    this.view.setVisible(false);
    this.view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#16171b' : '#f4f2ee');
    this.window.contentView.addChildView(this.view);
    this.resize();
    this.view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.view.webContents.on('will-navigate', event => event.preventDefault());
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('终端加载超时，请重启 sharechat')), 20000);
      const onReady = event => {
        if (event.sender === this.view?.webContents) finish();
      };
      const finish = error => {
        clearTimeout(timer);
        ipcMain.removeListener('terminal:host-ready', onReady);
        this.cancelReady = null;
        error ? reject(error) : resolve();
      };
      this.cancelReady = finish;
      ipcMain.on('terminal:host-ready', onReady);
      runtime.attachHost(this.window, this.view.webContents, () => {
        this.setVisible(true).catch(() => {});
      }).then(() => this.view.webContents.loadFile(path.join(root, 'renderer/index.html'))).catch(finish);
    });
    return this.ready;
  }

  async setVisible(visible) {
    this.visible = Boolean(visible);
    if (this.visible) await this.ensure();
    if (this.disposed) return;
    if (this.view) {
      this.resize();
      this.view.setVisible(this.visible);
      if (this.visible) this.view.webContents.focus();
    }
    this.onViewChange(this.visible ? 'terminal' : 'sessions');
  }

  async launch(result) {
    const command = resumeCommand(result.resume);
    await this.setVisible(true);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('接续终端启动超时；会话已转换，可复制命令手动运行'));
      }, 20000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.view.webContents.send('terminal:host-launch', {
        requestId,
        options: { shell: 'powershell', cwd: result.cwd, startCommand: command,
          title: `${result.target} · 接续`, launchpadAgent: result.target },
      });
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelReady?.(new Error('窗口已关闭'));
    ipcMain.removeListener('terminal:host-launch-result', this.onResult);
    this.window.removeListener('resize', this.resize);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('窗口已关闭'));
    }
    this.pending.clear();
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    runtime.disposeHost().catch(() => {});
  }
}
