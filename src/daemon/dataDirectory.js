const path = require('node:path');

function packagedGoDataDirectory(userDataDirectory) {
  const userData = String(userDataDirectory || '').trim();
  if (!userData || !path.isAbsolute(userData)) throw new Error('daemon_user_data_dir_invalid');
  return path.join(userData, 'data', 'go');
}

function packagedLogDirectory(userDataDirectory) {
  const userData = String(userDataDirectory || '').trim();
  if (!userData || !path.isAbsolute(userData)) throw new Error('daemon_user_data_dir_invalid');
  return path.join(userData, 'logs');
}

module.exports = { packagedGoDataDirectory, packagedLogDirectory };
