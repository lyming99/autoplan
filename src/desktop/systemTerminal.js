'use strict';

const fs = require('node:fs');
const { spawn: defaultSpawn } = require('node:child_process');

async function openSystemTerminal(workspacePath, options = {}) {
  const platform = options.platform || process.platform;
  const spawn = options.spawn || defaultSpawn;
  const env = options.env || process.env;
  let cwd;
  try {
    cwd = await fs.promises.realpath(String(workspacePath || '').trim());
    if (!(await fs.promises.stat(cwd)).isDirectory()) throw new Error('not_directory');
  } catch {
    return { ok: false, error: '项目工作区路径不存在' };
  }

  const candidates = terminalCandidates(platform, cwd, env);
  for (const candidate of candidates) {
    if (await launch(candidate, cwd, spawn)) return { ok: true, error: null };
  }
  return { ok: false, error: '无法启动系统终端' };
}

function terminalCandidates(platform, cwd, env) {
  if (platform === 'win32') {
    return [
      { command: 'wt.exe', args: ['-d', cwd] },
      { command: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/K'] },
    ];
  }
  if (platform === 'darwin') return [{ command: 'open', args: ['-a', 'Terminal', cwd] }];
  return [
    { command: 'x-terminal-emulator', args: ['--working-directory', cwd] },
    { command: 'gnome-terminal', args: ['--working-directory', cwd] },
    { command: 'konsole', args: ['--workdir', cwd] },
  ];
}

function launch(candidate, cwd, spawn) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const finish = (started) => {
      if (settled) return;
      settled = true;
      if (started) child?.unref?.();
      resolve(started);
    };
    try {
      child = spawn(candidate.command, candidate.args, {
        cwd, detached: true, stdio: 'ignore', windowsHide: false,
      });
      child.once('spawn', () => finish(true));
      child.once('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

module.exports = { openSystemTerminal, terminalCandidates };
