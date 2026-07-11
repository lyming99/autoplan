/**
 * Parse event meta field: JSON string → object, or passthrough.
 * Shared by snapshots.js and planAgentCli.js to avoid circular dependency.
 */
function parseEventMeta(meta) {
  if (!meta) return null;
  if (typeof meta !== 'string') return meta;
  try {
    const parsed = JSON.parse(meta);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return parsed;
  } catch {
    return meta;
  }
  return meta;
}

module.exports = { parseEventMeta };
