'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  TERMINAL_DEFAULTS,
  TERMINAL_LIMITS,
  TERMINAL_PROFILE_KIND,
} = require('./terminalTypes');

const TERMINAL_SETTING_KEYS = Object.freeze({
  defaultProfile: 'terminal.defaultProfile',
  initialCwd: 'terminal.initialCwd',
  fontSize: 'terminal.fontSize',
  scrollbackLimit: 'terminal.scrollbackLimit',
  retainOnExit: 'terminal.retainOnExit',
  confirmBeforeKill: 'terminal.confirmBeforeKill',
});

const TERMINAL_SETTING_LIMITS = Object.freeze({
  minFontSize: 10,
  maxFontSize: 24,
});

const DEFAULT_TERMINAL_SETTINGS = Object.freeze({
  defaultProfile: 'default',
  initialCwd: '',
  fontSize: 13,
  scrollbackLimit: TERMINAL_DEFAULTS.scrollbackLimit,
  retainOnExit: TERMINAL_DEFAULTS.retainOnExit,
  confirmBeforeKill: true,
});

function selectTerminalProfile(input = {}, options = {}) {
  const source = isPlainObject(input?.profile) ? input.profile : {};
  if (typeof input?.profile === 'string') source.id = input.profile;
  return normalizeTerminalProfile(source, options);
}

function normalizeTerminalProfile(input = {}, options = {}) {
  const defaults = defaultTerminalProfile(options);
  const source = isPlainObject(input) ? input : {};
  const shellPath = trimText(firstDefined(source.shellPath, source.shell, source.path, defaults.shellPath));
  const name = trimText(firstDefined(source.name, source.label, defaults.name));
  const id = normalizeProfileId(firstDefined(source.id, source.profileId, name, defaults.id));
  const kind = source.kind === TERMINAL_PROFILE_KIND.CUSTOM ? TERMINAL_PROFILE_KIND.CUSTOM : defaults.kind;

  return {
    id,
    name: limitText(name || defaults.name, TERMINAL_LIMITS.maxProfileNameLength),
    kind,
    shellPath: limitText(shellPath || defaults.shellPath, TERMINAL_LIMITS.maxShellPathLength),
    args: normalizeProfileArgs(firstDefined(source.args, defaults.args)),
    env: normalizeTerminalEnv(source.env),
  };
}

function defaultTerminalProfile(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const fileSystem = options.fs || fs;
  const shell = defaultShellSpec(platform, env, fileSystem);
  return {
    id: 'default',
    name: shell.name,
    kind: TERMINAL_PROFILE_KIND.DEFAULT,
    shellPath: shell.shellPath,
    args: shell.args,
    env: {},
  };
}

function defaultShellSpec(platform, env, fileSystem) {
  const override = trimText(env.AUTOPLAN_TERMINAL_SHELL);
  if (override) return { name: path.basename(override), shellPath: override, args: [] };

  if (platform === 'win32') {
    const candidates = [
      { name: 'PowerShell', shellPath: 'pwsh.exe', args: ['-NoLogo'] },
      { name: 'PowerShell', shellPath: 'powershell.exe', args: ['-NoLogo'] },
      { name: 'Command Prompt', shellPath: env.ComSpec || '', args: [] },
      { name: 'Command Prompt', shellPath: 'cmd.exe', args: [] },
    ];
    return firstAvailableCommand(candidates, env, fileSystem, platform) || candidates[1];
  }

  const shellPath = trimText(env.SHELL);
  if (shellPath) return { name: path.basename(shellPath), shellPath, args: [] };
  if (fileExists('/bin/bash', fileSystem)) return { name: 'bash', shellPath: '/bin/bash', args: [] };
  if (fileExists('/bin/sh', fileSystem)) return { name: 'sh', shellPath: '/bin/sh', args: [] };
  return { name: 'sh', shellPath: 'sh', args: [] };
}

function firstAvailableCommand(candidates, env, fileSystem, platform) {
  for (const candidate of candidates) {
    if (!candidate.shellPath) continue;
    if (isAbsolutePath(candidate.shellPath, platform) && fileExists(candidate.shellPath, fileSystem)) return candidate;
    if (!isAbsolutePath(candidate.shellPath, platform) && commandExistsInPath(candidate.shellPath, env, fileSystem, platform)) return candidate;
  }
  return null;
}

function commandExistsInPath(command, env, fileSystem, platform) {
  const pathValue = env.Path || env.PATH || '';
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  const pathApi = platform === 'win32' ? path.win32 : path;
  const dirs = String(pathValue).split(delimiter).filter(Boolean);
  const names = platform === 'win32' && !/\.[a-z0-9]+$/i.test(command)
    ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
    : [command];
  return dirs.some((dir) => names.some((name) => fileExists(pathApi.join(dir, name), fileSystem)));
}

function isAbsolutePath(filePath, platform) {
  return platform === 'win32' ? path.win32.isAbsolute(filePath) : path.isAbsolute(filePath);
}

function normalizeTerminalCreateInput(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const size = normalizeTerminalSize(source.cols, source.rows);
  return {
    cols: size.cols,
    rows: size.rows,
    title: normalizeTerminalTitle(source.title),
    scrollbackLimit: normalizeScrollbackLimit(source.scrollbackLimit ?? source.scrollback),
    retainOnExit: source.retainOnExit === undefined ? TERMINAL_DEFAULTS.retainOnExit : normalizeBoolean(source.retainOnExit),
    env: normalizeTerminalEnv(source.env),
  };
}

function normalizeTerminalSettings(input = {}) {
  const source = isPlainObject(input) ? input : {};
  return {
    defaultProfile: normalizeProfileId(readTerminalSetting(source, 'defaultProfile')),
    initialCwd: normalizeTerminalInitialCwd(readTerminalSetting(source, 'initialCwd')),
    fontSize: clampInteger(
      readTerminalSetting(source, 'fontSize'),
      DEFAULT_TERMINAL_SETTINGS.fontSize,
      TERMINAL_SETTING_LIMITS.minFontSize,
      TERMINAL_SETTING_LIMITS.maxFontSize,
    ),
    scrollbackLimit: normalizeScrollbackLimit(readTerminalSetting(source, 'scrollbackLimit')),
    retainOnExit: normalizeTerminalSettingBoolean(readTerminalSetting(source, 'retainOnExit'), DEFAULT_TERMINAL_SETTINGS.retainOnExit),
    confirmBeforeKill: normalizeTerminalSettingBoolean(readTerminalSetting(source, 'confirmBeforeKill'), DEFAULT_TERMINAL_SETTINGS.confirmBeforeKill),
  };
}

function terminalSettingsFromDb(db, options = {}) {
  if (!db || typeof db.getSettings !== 'function') return normalizeTerminalSettings();
  const projectId = normalizePositiveInteger(options.projectId);
  const globalSettings = db.getSettings('terminal.');
  if (!projectId) return normalizeTerminalSettings(globalSettings);

  const projectPrefix = `terminal.project.${projectId}.`;
  const projectSettings = db.getSettings(projectPrefix);
  const normalizedProjectSettings = Object.fromEntries(
    Object.entries(projectSettings).map(([key, value]) => [key.slice(projectPrefix.length), value]),
  );
  return normalizeTerminalSettings({ ...globalSettings, ...normalizedProjectSettings });
}

function saveTerminalSettingsToDb(db, input = {}, options = {}) {
  if (!db || typeof db.setSetting !== 'function') throw new Error('settings store unavailable');
  const projectId = normalizePositiveInteger(options.projectId);
  const settings = normalizeTerminalSettings(input);
  for (const [name, value] of Object.entries(settings)) {
    db.setSetting(terminalSettingKey(name, projectId), String(value));
  }
  return settings;
}

function terminalCreateInputFromSettings(settings = {}, input = {}) {
  const normalized = normalizeTerminalSettings(settings);
  const source = isPlainObject(input) ? input : {};
  const hasProfile = source.profile !== undefined && source.profile !== null && source.profile !== '';
  const profileId = trimText(firstDefined(source.profileId, source.profile));
  return {
    ...source,
    cwd: normalizeTerminalInitialCwd(firstDefined(source.cwd, normalized.initialCwd)) || undefined,
    profileId: hasProfile ? source.profileId : (profileId || (normalized.defaultProfile === 'default' ? undefined : normalized.defaultProfile)),
    scrollbackLimit: normalizeScrollbackLimit(firstDefined(source.scrollbackLimit, normalized.scrollbackLimit)),
    retainOnExit: source.retainOnExit === undefined ? normalized.retainOnExit : normalizeBoolean(source.retainOnExit),
  };
}

function normalizeTerminalSize(cols, rows) {
  return {
    cols: clampInteger(cols, TERMINAL_DEFAULTS.cols, TERMINAL_LIMITS.minCols, TERMINAL_LIMITS.maxCols),
    rows: clampInteger(rows, TERMINAL_DEFAULTS.rows, TERMINAL_LIMITS.minRows, TERMINAL_LIMITS.maxRows),
  };
}

function normalizeTerminalTitle(value) {
  const title = trimText(value) || TERMINAL_DEFAULTS.title;
  return limitText(title, TERMINAL_LIMITS.maxTitleLength);
}

function normalizeScrollbackLimit(value) {
  return clampInteger(
    value,
    TERMINAL_DEFAULTS.scrollbackLimit,
    TERMINAL_LIMITS.minScrollbackLimit,
    TERMINAL_LIMITS.maxScrollbackLimit,
  );
}

function normalizeTerminalInitialCwd(value) {
  return limitText(trimText(value), TERMINAL_LIMITS.maxCwdLength);
}

function normalizeProfileArgs(value) {
  const raw = Array.isArray(value) ? value : (value === undefined || value === null || value === '' ? [] : [value]);
  return raw
    .slice(0, TERMINAL_LIMITS.maxProfileArgs)
    .map((entry) => limitText(String(entry ?? ''), TERMINAL_LIMITS.maxProfileArgLength));
}

function normalizeTerminalEnv(value) {
  if (!isPlainObject(value)) return {};
  const env = {};
  for (const [key, raw] of Object.entries(value)) {
    const envKey = trimText(key);
    if (!envKey) continue;
    env[envKey] = raw === undefined || raw === null ? '' : String(raw);
  }
  return env;
}

function normalizeProfileId(value) {
  const id = trimText(value || DEFAULT_TERMINAL_SETTINGS.defaultProfile).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return limitText(id || 'default', TERMINAL_LIMITS.maxProfileNameLength);
}

function readTerminalSetting(source, name) {
  return firstDefined(
    source[name],
    source[TERMINAL_SETTING_KEYS[name]],
    DEFAULT_TERMINAL_SETTINGS[name],
  );
}

function normalizeTerminalSettingBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  return normalizeBoolean(value);
}

function terminalSettingKey(name, projectId = null) {
  const key = TERMINAL_SETTING_KEYS[name];
  if (!key) throw new Error(`unknown terminal setting: ${name}`);
  return projectId ? `terminal.project.${projectId}.${name}` : key;
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  const integer = Number.isFinite(number) ? Math.floor(number) : fallback;
  return Math.min(max, Math.max(min, integer));
}

function normalizeBoolean(value) {
  if (value === false || value === 0) return false;
  const text = String(value ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no', 'disabled'].includes(text);
}

function limitText(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function trimText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function fileExists(filePath, fileSystem = fs) {
  try {
    return fileSystem.existsSync(filePath);
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  DEFAULT_TERMINAL_SETTINGS,
  TERMINAL_SETTING_KEYS,
  TERMINAL_SETTING_LIMITS,
  defaultTerminalProfile,
  normalizeScrollbackLimit,
  normalizeTerminalCreateInput,
  normalizeTerminalEnv,
  normalizeTerminalProfile,
  normalizeTerminalSize,
  normalizeTerminalSettings,
  normalizeTerminalTitle,
  selectTerminalProfile,
  saveTerminalSettingsToDb,
  terminalCreateInputFromSettings,
  terminalSettingsFromDb,
};
