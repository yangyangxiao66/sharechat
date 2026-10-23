// ChatGPT desktop (OpenAI.Codex Store app): Codex threads created in the
// desktop UI. Sessions live in CODEX_HOME like the CLI, but carry
// originator "Codex Desktop"; open them with codex://threads/<id>.
import path from 'node:path';
import { HOME } from '../util.js';
import { allSessions, load as loadCodex } from './codex.js';

export const id = 'chatgpt';
export const label = 'ChatGPT 桌面版';

export function home() {
  const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(HOME, 'AppData', 'Roaming') : '');
  return appData ? path.join(appData, 'Codex') : path.join(HOME, '.codex');
}

export function list() {
  return allSessions()
    .filter((s) => s.desktop && (s.threadSource === 'user' || !s.threadSource))
    .map((s) => ({ ...s, agent: id }));
}

export function load(meta) {
  const session = loadCodex(meta);
  session.agent = id;
  return session;
}

export function launchCommand(prompt) {
  return { cmd: 'codex', args: [prompt] };
}
