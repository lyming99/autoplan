const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { notarize } = require('@electron/notarize');

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function isEnabled(...names) {
  const value = env(...names);
  return value === '1' || value === 'true' || value === 'yes';
}

function buildAppPath(context) {
  const appName = context.packager.appInfo.productFilename;
  return path.join(context.appOutDir, `${appName}.app`);
}

function writeApiKey(contents, sourceName, isBase64) {
  const directory = path.join(env('RUNNER_TEMP') || os.tmpdir(), 'autoplan-notarize');
  fs.mkdirSync(directory, { recursive: true });
  const keyPath = path.join(directory, `${sourceName}.p8`);
  const buffer = isBase64 ? Buffer.from(contents, 'base64') : Buffer.from(contents);
  fs.writeFileSync(keyPath, buffer, { mode: 0o600 });
  return keyPath;
}

function resolveApiKeyPath() {
  const keyPath = env('APPLE_API_KEY_PATH', 'APP_STORE_CONNECT_API_KEY_PATH', 'ASC_API_KEY_PATH');
  if (keyPath) return keyPath;

  const keyContents = env('APPLE_API_KEY', 'APP_STORE_CONNECT_API_KEY', 'ASC_API_KEY');
  if (keyContents) {
    if (fs.existsSync(keyContents)) return keyContents;
    return writeApiKey(keyContents, 'AuthKey', false);
  }

  const base64Contents = env('APPLE_API_KEY_BASE64', 'APP_STORE_CONNECT_API_KEY_BASE64', 'ASC_API_KEY_BASE64');
  if (base64Contents) return writeApiKey(base64Contents, 'AuthKey', true);

  return null;
}

function resolveCredentials() {
  const keychainProfile = env('APPLE_KEYCHAIN_PROFILE', 'NOTARYTOOL_KEYCHAIN_PROFILE');
  if (keychainProfile) {
    const credentials = { keychainProfile };
    const keychain = env('APPLE_KEYCHAIN', 'NOTARYTOOL_KEYCHAIN');
    if (keychain) credentials.keychain = keychain;
    return { credentials, strategy: 'Keychain profile' };
  }

  const appleApiKey = resolveApiKeyPath();
  const appleApiKeyId = env('APPLE_API_KEY_ID', 'APP_STORE_CONNECT_API_KEY_ID', 'ASC_API_KEY_ID');
  const appleApiIssuer = env('APPLE_API_ISSUER', 'APP_STORE_CONNECT_API_ISSUER', 'ASC_API_ISSUER');
  if (appleApiKey || appleApiKeyId || appleApiIssuer) {
    const missing = [];
    if (!appleApiKey) missing.push('APPLE_API_KEY_PATH or APPLE_API_KEY');
    if (!appleApiKeyId) missing.push('APPLE_API_KEY_ID');
    if (!appleApiIssuer) missing.push('APPLE_API_ISSUER');
    if (missing.length) return { missing, strategy: 'App Store Connect API key' };
    return {
      credentials: { appleApiKey, appleApiKeyId, appleApiIssuer },
      strategy: 'App Store Connect API key',
    };
  }

  const appleId = env('APPLE_ID', 'APPLEID');
  const appleIdPassword = env('APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID_PASSWORD', 'APPLE_PASSWORD');
  const teamId = env('APPLE_TEAM_ID', 'APPLE_TEAMID');
  if (appleId || appleIdPassword || teamId) {
    const missing = [];
    if (!appleId) missing.push('APPLE_ID');
    if (!appleIdPassword) missing.push('APPLE_APP_SPECIFIC_PASSWORD');
    if (!teamId) missing.push('APPLE_TEAM_ID');
    if (missing.length) return { missing, strategy: 'Apple ID app-specific password' };
    return {
      credentials: { appleId, appleIdPassword, teamId },
      strategy: 'Apple ID app-specific password',
    };
  }

  return {
    missing: ['APPLE_KEYCHAIN_PROFILE or APPLE_API_KEY_PATH/APPLE_API_KEY or APPLE_ID'],
    strategy: 'notarization credentials',
  };
}

async function notarizeMac(context) {
  const packagePlatform = context.electronPlatformName || process.platform;
  if (process.platform !== 'darwin' || packagePlatform !== 'darwin') {
    console.log('[notarize] Skipping macOS notarization outside a darwin package build.');
    return;
  }

  if (isEnabled('SKIP_NOTARIZE', 'MAC_NOTARIZE_SKIP')) {
    console.log('[notarize] Skipping macOS notarization because SKIP_NOTARIZE is enabled.');
    return;
  }

  const appPath = buildAppPath(context);
  if (!fs.existsSync(appPath)) {
    throw new Error(`[notarize] Cannot find app bundle at ${appPath}.`);
  }

  const resolved = resolveCredentials();
  if (!resolved.credentials) {
    const message = `[notarize] Skipping macOS notarization: missing ${resolved.strategy}: ${resolved.missing.join(', ')}.`;
    if (isEnabled('MAC_NOTARIZE_REQUIRED', 'APPLE_NOTARIZE_REQUIRED', 'NOTARIZE_REQUIRED')) {
      throw new Error(message);
    }
    console.warn(`${message} Set MAC_NOTARIZE_REQUIRED=true to fail instead of skip.`);
    return;
  }

  const options = { appPath, ...resolved.credentials };
  const notarytoolPath = env('APPLE_NOTARYTOOL_PATH', 'NOTARYTOOL_PATH');
  if (notarytoolPath) options.notarytoolPath = notarytoolPath;

  console.log(`[notarize] Submitting ${appPath} using ${resolved.strategy}.`);
  await notarize(options);
  console.log('[notarize] macOS notarization completed.');
}

module.exports = notarizeMac;
module.exports.default = notarizeMac;
