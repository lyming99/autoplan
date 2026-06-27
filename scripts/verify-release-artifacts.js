const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const args = {
    platform: process.env.RELEASE_PLATFORM || 'macos',
    releaseDir: process.env.RELEASE_DIR || 'release',
    mode: process.env.MACOS_RELEASE_MODE || 'unsigned-test',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--platform') args.platform = argv[++index];
    else if (arg === '--release-dir') args.releaseDir = argv[++index];
    else if (arg === '--mode') args.mode = argv[++index];
  }
  args.releaseDir = path.resolve(args.releaseDir);
  return args;
}

function fail(message) {
  throw new Error(message);
}

function info(message) {
  console.log(`[verify-release-artifacts] ${message}`);
}

function warn(message) {
  console.warn(`[verify-release-artifacts] ${message}`);
}

function assertFile(filePath) {
  if (!fs.existsSync(filePath)) fail(`Missing expected artifact: ${filePath}`);
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) fail(`Expected a file artifact: ${filePath}`);
  if (stats.size <= 0) fail(`Artifact is empty: ${filePath}`);
  return stats;
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) fail(`Release directory does not exist: ${dir}`);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function runRequired(label, command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) fail(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    if (result.stdout) console.error(result.stdout.trim());
    if (result.stderr) console.error(result.stderr.trim());
    fail(`${label} failed with exit code ${result.status}.`);
  }
  return result.stdout || '';
}

function collectMacArtifacts(releaseDir) {
  const files = listFiles(releaseDir);
  const expected = [];
  for (const arch of ['x64', 'arm64']) {
    for (const ext of ['dmg', 'zip']) expected.push({ arch, ext });
  }

  const artifacts = [];
  for (const item of expected) {
    const suffix = `-mac-${item.arch}.${item.ext}`;
    const matches = files.filter((name) => name.endsWith(suffix));
    if (matches.length !== 1) {
      fail(`Expected exactly one macOS ${item.arch} ${item.ext} artifact, found ${matches.length}.`);
    }
    const filePath = path.join(releaseDir, matches[0]);
    assertFile(filePath);
    const blockmapPath = `${filePath}.blockmap`;
    assertFile(blockmapPath);
    artifacts.push({ ...item, name: matches[0], filePath, blockmapPath });
  }

  const expectedNames = new Set(artifacts.map((artifact) => artifact.name));
  const extraInstallers = files.filter((name) => /-mac-[^.]+\.(dmg|zip)$/.test(name) && !expectedNames.has(name));
  if (extraInstallers.length) fail(`Unexpected macOS installer artifacts: ${extraInstallers.join(', ')}`);

  return artifacts;
}

function verifyLatestMacYml(releaseDir, artifacts) {
  const latestPath = path.join(releaseDir, 'latest-mac.yml');
  if (!fs.existsSync(latestPath)) {
    warn('latest-mac.yml was not generated; auto-update metadata will not be uploaded for macOS.');
    return;
  }
  assertFile(latestPath);

  const content = fs.readFileSync(latestPath, 'utf8');
  const zipNames = new Set(artifacts.filter((artifact) => artifact.ext === 'zip').map((artifact) => artifact.name));
  const referenced = [...content.matchAll(/[^\s'"/]+-mac-(?:x64|arm64)\.zip/g)].map((match) => match[0]);
  if (!referenced.length) fail('latest-mac.yml does not reference an arch-specific macOS zip artifact.');
  for (const name of referenced) {
    if (!zipNames.has(name)) fail(`latest-mac.yml references missing artifact: ${name}`);
  }
  info(`latest-mac.yml references release zip artifact(s): ${[...new Set(referenced)].join(', ')}`);
}

function findAppBundles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith('.app')) {
        found.push(fullPath);
        continue;
      }
      walk(fullPath);
    }
  };
  walk(dir);
  return found.sort((left, right) => left.localeCompare(right));
}

function verifySingleAppTrust(appPath) {
  runRequired(`codesign ${appPath}`, 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  runRequired(`Gatekeeper assess ${appPath}`, 'spctl', ['--assess', '--type', 'execute', '--verbose', appPath]);
  runRequired(`Stapler validate ${appPath}`, 'xcrun', ['stapler', 'validate', appPath]);
}

function verifyDmgMount(artifact, requireTrust) {
  const mountDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-dmg-'));
  try {
    runRequired(`Mount ${artifact.name}`, 'hdiutil', [
      'attach',
      artifact.filePath,
      '-nobrowse',
      '-readonly',
      '-mountpoint',
      mountDir,
    ]);
    const appBundles = findAppBundles(mountDir);
    if (!appBundles.length) fail(`${artifact.name} did not mount an .app bundle.`);
    if (requireTrust) appBundles.forEach(verifySingleAppTrust);
  } finally {
    spawnSync('hdiutil', ['detach', mountDir, '-force'], { encoding: 'utf8' });
    fs.rmSync(mountDir, { recursive: true, force: true });
  }
}

function verifyZipExtract(artifact, requireTrust) {
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-zip-'));
  try {
    runRequired(`Extract ${artifact.name}`, 'ditto', ['-x', '-k', artifact.filePath, extractDir]);
    const appBundles = findAppBundles(extractDir);
    if (!appBundles.length) fail(`${artifact.name} did not extract an .app bundle.`);
    if (requireTrust) appBundles.forEach(verifySingleAppTrust);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

function verifyAppTrust(releaseDir) {
  const appBundles = findAppBundles(releaseDir);
  if (!appBundles.length) fail('No .app bundle found for signature and notarization checks.');
  appBundles.forEach(verifySingleAppTrust);
}

function verifyMacArtifacts(options) {
  info(`Checking macOS artifacts in ${options.releaseDir}.`);
  const artifacts = collectMacArtifacts(options.releaseDir);
  verifyLatestMacYml(options.releaseDir, artifacts);

  if (process.platform !== 'darwin') {
    warn('Skipping macOS-only mount, extract, signing, and notarization checks outside macOS.');
    return;
  }

  const requireTrust = options.mode === 'signed-notarized';
  for (const artifact of artifacts.filter((item) => item.ext === 'dmg')) verifyDmgMount(artifact, requireTrust);
  for (const artifact of artifacts.filter((item) => item.ext === 'zip')) verifyZipExtract(artifact, requireTrust);

  if (requireTrust) {
    verifyAppTrust(options.releaseDir);
  } else {
    warn(`Skipping signature, Gatekeeper, and stapler checks for ${options.mode} mode.`);
  }
  info('macOS release artifact checks completed.');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.platform !== 'macos') {
    info(`No specialized checks configured for ${options.platform}; skipping.`);
    return;
  }
  verifyMacArtifacts(options);
}

try {
  main();
} catch (error) {
  console.error(`[verify-release-artifacts] ${error.message}`);
  process.exit(1);
}
