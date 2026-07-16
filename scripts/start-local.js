'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const localGoBin = path.join(root, '.autoplan-runtime', 'go', 'bin');
const localGo = path.join(localGoBin, 'go');

function hasLocalGo() {
  try {
    const info = fs.lstatSync(localGo);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function goVersion(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ['version'], { shell: false, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.on('exit', (code) => resolve(code === 0 ? output.trim() : ''));
    child.on('error', () => resolve(''));
  });
}

async function main() {
  const env = { ...process.env };

  if (hasLocalGo()) {
    const currentVersion = await goVersion('go');
    if (!currentVersion.includes('go1.25')) {
      env.PATH = `${localGoBin}${path.delimiter}${env.PATH || ''}`;
    }
  }

  if (!env.GOPROXY) {
    env.GOPROXY = 'https://goproxy.cn,direct';
  }

  const child = spawn(process.execPath, [path.join(root, 'scripts', 'dev.js')], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env,
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

main().catch((error) => {
  process.stderr.write(`start_local_failed: ${error?.message || error}\n`);
  process.exit(1);
});
