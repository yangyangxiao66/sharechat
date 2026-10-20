const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
for (const root of ['bin', 'src', 'desktop', 'modules/terminal', 'scripts', 'test']) {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:c?js|mjs)$/.test(file)) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    }
  }
  walk(root);
}
console.log('All JavaScript syntax checks passed');
