const { execFileSync } = require('node:child_process');

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  console.log('Configured Git hooks from .githooks');
} catch {
  console.log('Skipping Git hook setup outside a Git work tree');
}
