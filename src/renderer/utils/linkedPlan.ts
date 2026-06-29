import { PLAN_STATUS, type Plan } from '../types';

export type LinkedPlanIntakeItem = {
  linked_plan_id?: number | string | null;
  linked_plan_title?: string | null;
  linked_plan_file_path?: string | null;
  linked_plan_status?: string | null;
  linked_plan_completed_tasks?: number | string | null;
  linked_plan_total_tasks?: number | string | null;
};

export function normalizeLinkedPlanId(value: number | string | null | undefined) {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  const planId = Number(value);
  return Number.isInteger(planId) && planId > 0 ? planId : null;
}

export function findLinkedPlanInSnapshot(plans: Plan[], planId: number, projectId: number) {
  return (
    plans.find((plan) => Number(plan.id) === planId && Number(plan.project_id) === Number(projectId)) ||
    plans.find((plan) => Number(plan.id) === planId) ||
    null
  );
}

export function matchFallbackPlan(plan: Plan | null | undefined, planId: number) {
  return plan && Number(plan.id) === planId ? plan : null;
}

function normalizeLinkedPlanCount(value: number | string | null | undefined) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

export function createUnavailableLinkedPlan(projectId: number, item: LinkedPlanIntakeItem, planId: number | null): Plan {
  return {
    id: planId || 0,
    project_id: projectId,
    issue_hash: '',
    title: item.linked_plan_title || (planId ? `Plan #${planId}` : '绑定 Plan'),
    file_path: item.linked_plan_file_path || '',
    hash: '',
    status: PLAN_STATUS.INTERRUPTED,
    sort_order: 0,
    is_draft: false,
    completed_tasks: normalizeLinkedPlanCount(item.linked_plan_completed_tasks),
    total_tasks: normalizeLinkedPlanCount(item.linked_plan_total_tasks),
    validation_passed: 0,
    concurrency_suggestion: {
      hasSafeParallelBatches: false,
      parallelTaskCount: 0,
      batchCount: 0,
      serialTaskCount: 0,
      maxParallelTasks: 0,
      batches: [],
      serialTasks: [],
    },
    created_at: '',
    updated_at: '',
    accepted_at: null,
  };
}
