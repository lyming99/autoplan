const { parentPort, workerData } = require('node:worker_threads');
const { scanDirectorySync } = require('./workspaceFiles');

function serializeError(error) {
  return {
    message: error?.message || String(error),
    stack: error?.stack || '',
    code: error?.code,
  };
}

try {
  const scan = scanDirectorySync(workerData.root, workerData.workspace, workerData.extensions || []);
  parentPort.postMessage({ ok: true, scan });
} catch (error) {
  parentPort.postMessage({ ok: false, error: serializeError(error) });
}
