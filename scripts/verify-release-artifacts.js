'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_ROOT = path.join(ROOT, 'release');
const PLATFORM = Object.freeze({ windows: 'win32', macos: 'darwin', linux: 'linux' });
const LINUX_APP_IMAGE = /-linux-(?:x64|x86_64)\.AppImage$/;
const LINUX_DEB = /-linux-(?:x64|amd64)\.deb$/;

class ReleaseArtifactError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReleaseArtifactError';
    this.code = code;
  }
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function parseArgs(argv) {
  const options = { platform: process.env.RELEASE_PLATFORM || hostPlatform(), releaseDir: process.env.RELEASE_DIR || RELEASE_ROOT, mode: process.env.RELEASE_MODE || process.env.MACOS_RELEASE_MODE || 'unsigned-test' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--platform', '--release-dir', '--mode'].includes(key) || index + 1 >= argv.length) throw new ReleaseArtifactError('release_artifact_arguments_invalid');
    const value = argv[++index];
    if (key === '--platform') options.platform = value;
    else if (key === '--release-dir') options.releaseDir = value;
    else options.mode = value;
  }
  if (!PLATFORM[options.platform] || !['unsigned-test', 'signed-notarized'].includes(options.mode)) {
    throw new ReleaseArtifactError('release_artifact_arguments_invalid');
  }
  options.releaseDir = path.resolve(options.releaseDir);
  return options;
}

function hostPlatform() {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
}

function assertFile(file, code = 'release_artifact_missing') {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0) throw new ReleaseArtifactError(code);
  return info;
}

function assertDirectory(directory, code = 'release_bundle_missing') {
  const info = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new ReleaseArtifactError(code);
  return info;
}

function expectedBinary(platform) { return platform === 'win32' ? 'autoplan-server.exe' : 'autoplan-server'; }

function inspectSidecar(directory, platform, expectedArch) {
  assertDirectory(directory);
  const resources = platform === 'darwin' && path.basename(directory) === 'Contents'
    ? path.join(directory, 'Resources')
    : path.join(directory, 'resources');
  const root = path.join(resources, 'sidecar', platform, expectedArch);
  const binary = path.join(root, expectedBinary(platform));
  const manifestPath = path.join(root, 'autoplan-server.manifest.json');
  const binaryInfo = assertFile(binary, 'release_sidecar_binary_missing');
  assertFile(manifestPath, 'release_sidecar_manifest_missing');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { throw new ReleaseArtifactError('release_sidecar_manifest_invalid'); }
  if (!manifest || manifest.schema_version !== 1 || manifest.kind !== 'autoplan-packaged-sidecar-resource' ||
      manifest.platform !== platform || manifest.arch !== expectedArch || manifest.binary !== expectedBinary(platform) ||
      manifest.bytes !== binaryInfo.size || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') ||
      !/^[a-f0-9]{40}$/.test(manifest.source_commit || '') || !/^[a-f0-9]{64}$/.test(manifest.source_tree_sha256 || '')) {
    throw new ReleaseArtifactError('release_sidecar_manifest_invalid');
  }
  if (sha256(fs.readFileSync(binary)) !== manifest.sha256) throw new ReleaseArtifactError('release_sidecar_checksum_invalid');
  if (platform !== 'win32' && (binaryInfo.mode & 0o111) === 0) throw new ReleaseArtifactError('release_sidecar_not_executable');
  return { binary, manifest };
}

function listFiles(directory) {
  assertDirectory(directory, 'release_directory_missing');
  return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

function requireArtifact(files, expression) {
  const matches = files.filter((name) => expression.test(name));
  if (matches.length !== 1) throw new ReleaseArtifactError('release_installer_artifact_missing');
  return matches[0];
}

function currentPackageVersionPattern() {
  let value;
  try { value = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
  catch { throw new ReleaseArtifactError('release_package_version_invalid'); }
  if (typeof value !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(value)) {
    throw new ReleaseArtifactError('release_package_version_invalid');
  }
  return value.replaceAll('.', '\\.').replaceAll('+', '\\+');
}

function runRequired(command, args, code) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, shell: false });
  if (result.error || result.status !== 0) throw new ReleaseArtifactError(code);
}

function findAppBundles(root) {
  const bundles = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.name.endsWith('.app')) bundles.push(full);
      else walk(full);
    }
  };
  walk(root);
  return bundles.sort();
}

function verifyMac(options) {
  const files = listFiles(options.releaseDir);
  const version = currentPackageVersionPattern();
  for (const arch of ['x64', 'arm64']) {
    requireArtifact(files, new RegExp(`-${version}-mac-${arch}\\.dmg$`));
    requireArtifact(files, new RegExp(`-${version}-mac-${arch}\\.zip$`));
  }
  const apps = findAppBundles(options.releaseDir);
  if (apps.length === 0) throw new ReleaseArtifactError('release_app_bundle_missing');
  const observed = new Set();
  for (const app of apps) {
    const resourceRoot = path.join(app, 'Contents');
    for (const arch of ['x64', 'arm64']) {
      const candidate = path.join(resourceRoot, 'Resources', 'sidecar', 'darwin', arch);
      if (fs.existsSync(candidate)) {
        const sidecar = inspectSidecar(resourceRoot, 'darwin', arch);
        observed.add(arch);
        if (options.mode === 'signed-notarized') runRequired('codesign', ['--verify', '--strict', '--verbose=2', sidecar.binary], 'release_sidecar_signature_invalid');
      }
    }
    if (options.mode === 'signed-notarized') {
      runRequired('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], 'release_app_signature_invalid');
      runRequired('spctl', ['--assess', '--type', 'execute', '--verbose', app], 'release_gatekeeper_invalid');
      runRequired('xcrun', ['stapler', 'validate', app], 'release_notarization_invalid');
    }
  }
  if (observed.size !== 2) throw new ReleaseArtifactError('release_sidecar_architecture_missing');
}

function verifyWindows(options) {
  const files = listFiles(options.releaseDir);
  const version = currentPackageVersionPattern();
  requireArtifact(files, new RegExp(`-${version}-win-x64-Setup\\.exe$`));
  const unpacked = path.join(options.releaseDir, 'win-unpacked');
  const sidecar = inspectSidecar(unpacked, 'win32', 'x64');
  if (options.mode === 'signed-notarized') {
    runRequired('powershell', ['-NoProfile', '-NonInteractive', '-Command', `if ((Get-AuthenticodeSignature -LiteralPath '${sidecar.binary.replace(/'/g, "''")}').Status -ne 'Valid') { exit 2 }`], 'release_sidecar_signature_invalid');
  }
}

function verifyLinux(options) {
  const files = listFiles(options.releaseDir);
  const version = currentPackageVersionPattern();
  requireArtifact(files, new RegExp(`-${version}-linux-(?:x64|x86_64)\\.AppImage$`));
  requireArtifact(files, new RegExp(`-${version}-linux-(?:x64|amd64)\\.deb$`));
  inspectSidecar(path.join(options.releaseDir, 'linux-unpacked'), 'linux', 'x64');
}

function verificationResult(options) {
  const signed = options.mode === 'signed-notarized';
  return {
    status: 'verified',
    code: signed ? 'release_artifacts_verified' : 'release_artifacts_unsigned_test_verified',
    platform: options.platform,
    release_mode: options.mode,
    trust_status: signed ? 'verified' : 'unsigned-test',
  };
}

function verifyReleaseArtifacts(options) {
  if (options.platform === 'macos') verifyMac(options);
  else if (options.platform === 'windows') verifyWindows(options);
  else verifyLinux(options);
  return verificationResult(options);
}

if (require.main === module) {
  try {
    const result = verifyReleaseArtifacts(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === 'verified' ? 0 : 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'blocked', code: error?.code || 'release_artifact_verification_failed' })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { LINUX_APP_IMAGE, LINUX_DEB, PLATFORM, RELEASE_ROOT, ReleaseArtifactError, expectedBinary, findAppBundles, inspectSidecar, parseArgs, verificationResult, verifyReleaseArtifacts };
