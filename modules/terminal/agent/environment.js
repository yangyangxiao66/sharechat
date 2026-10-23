/** Keep OpenCode's Windows file watcher from terminating its interactive UI. */
function agentEnvironment(env, platform = process.platform) {
  const result = { ...env };
  // Reproduced with OpenCode 1.18.23 and 1.19.3 on Windows: the normal TUI
  // exits with code 1 during watcher initialization. Its supported opt-out
  // preserves the full UI; external file changes no longer refresh live.
  // Respect an explicit override so users can re-enable it after an upstream fix.
  if (platform === "win32" && result.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER === undefined) {
    result.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true";
  }
  return result;
}

module.exports = { agentEnvironment };
