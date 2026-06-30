const { effectiveAgentCliConfig, hasAgentCliOverride } = require('./agentCliConfig');
const { parseEventMeta } = require('./snapshots');

function planAgentCliConfig(service, plan) {
  const projectDefaults = service.status(plan.project_id);
  const eventSnapshot = planAgentCliEventSnapshot(service, plan.project_id, plan.id);
  const sourceSnapshot = planSourceAgentCliSnapshot(service, plan.project_id, plan.id);
  const snapshotDefaults = eventSnapshot || sourceSnapshot || projectDefaults;
  if (hasAgentCliOverride(plan)) return effectiveAgentCliConfig(snapshotDefaults, plan);
  if (eventSnapshot) return effectiveAgentCliConfig(projectDefaults, eventSnapshot);
  if (sourceSnapshot) return effectiveAgentCliConfig(projectDefaults, sourceSnapshot);
  return effectiveAgentCliConfig(projectDefaults);
}

function planSnapshotAgentCliConfig(service, plan) {
  return planAgentCliConfig(service, plan);
}

function planAgentCliEventSnapshot(service, projectId, planId) {
  const rows = service.db.all(
    `SELECT meta FROM events
     WHERE project_id = ? AND type = 'plan.generated' AND meta IS NOT NULL
     ORDER BY id DESC
     LIMIT 40`,
    [projectId],
  );
  for (const row of rows) {
    const meta = parseEventMeta(row.meta);
    if (!meta || typeof meta !== 'object') continue;
    if (Number(meta.planId ?? meta.plan_id) === Number(planId) && hasAgentCliOverride(meta)) return meta;
  }
  return null;
}

function planSourceAgentCliSnapshot(service, projectId, planId) {
  const requirement = service.db.get('SELECT * FROM requirements WHERE project_id = ? AND linked_plan_id = ? LIMIT 1', [
    projectId,
    planId,
  ]);
  if (requirement && hasAgentCliOverride(requirement)) return requirement;
  const feedback = service.db.get('SELECT * FROM feedback WHERE project_id = ? AND linked_plan_id = ? LIMIT 1', [projectId, planId]);
  if (feedback && hasAgentCliOverride(feedback)) return feedback;
  return null;
}

module.exports = {
  planAgentCliConfig,
  planSnapshotAgentCliConfig,
  planAgentCliEventSnapshot,
  planSourceAgentCliSnapshot,
};
