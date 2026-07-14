const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { packagedGoDataDirectory, packagedLogDirectory } = require('./dataDirectory');

test('packaged Go database stays below Electron userData', () => {
  const userData = path.resolve('C:\\Users\\fixture\\AppData\\Roaming\\AutoPlan');
  assert.equal(packagedGoDataDirectory(userData), path.join(userData, 'data', 'go'));
  assert.equal(packagedLogDirectory(userData), path.join(userData, 'logs'));
  assert.throws(() => packagedGoDataDirectory('relative'), /daemon_user_data_dir_invalid/);
  assert.throws(() => packagedLogDirectory('relative'), /daemon_user_data_dir_invalid/);
});
