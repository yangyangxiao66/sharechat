const COMMANDS = new Set(['claude', 'codex', 'grok', 'qwen', 'gemini', 'opencode']);

// Resume arguments are data, including model names and paths. Never interpolate
// them as PowerShell expressions or reuse the CLI's cmd.exe quoting rules.
export function resumeCommand(resume) {
  if (!resume || !COMMANDS.has(resume.cmd) || !Array.isArray(resume.args)) {
    throw new Error('不支持的接续命令');
  }
  const quote = value => {
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('接续参数包含无效字符');
    return `'${value.replace(/'/g, "''")}'`;
  };
  return `& ${[resume.cmd, ...resume.args].map(quote).join(' ')}`;
}
