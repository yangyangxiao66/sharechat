// Qoder desktop is currently a conversion target. Sessions are written into
// ~/.qoder/projects and indexed in Qoder's own main.sqlite by native/qoder.js.
import path from 'node:path';
import { HOME } from '../util.js';

export const id = 'qoder';
export const label = 'Qoder';

export function home() {
  return process.env.QODER_HOME || path.join(HOME, '.qoder');
}

export function list() {
  return [];
}

export function load() {
  throw new Error('Qoder 会话暂不支持作为来源');
}

export function launchCommand(prompt) {
  return { cmd: 'qoder', args: [prompt] };
}
