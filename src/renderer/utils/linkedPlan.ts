import { PLAN_STATUS, type LinkedPlanSummary, type Plan } from '../types';

export type LinkedPlanIntakeItem = {
  linked_plan_id?: number | string | null;
  linked_plans?: LinkedPlanSummary[] | null;
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

export function normalizeLinkedPlans(item: LinkedPlanIntakeItem | null | undefined) {
  const fromArray = Array.isArray(item?.linked_plans)
    ? item.linked_plans
        .map((summary, index) => normalizeLinkedPlanSummary(summary, index + 1))
        .filter((summary): summary is LinkedPlanSummary => summary !== null)
    : [];
  if (fromArray.length > 0) {
    return fromArray.sort(
      (a, b) => linkedPlanPhaseIndex(a) - linkedPlanPhaseIndex(b)
        || (linkedPlanSummaryPlanId(a) || 0) - (linkedPlanSummaryPlanId(b) || 0),
    );
  }

  const planId = normalizeLinkedPlanId(item?.linked_plan_id);
  if (planId === null) return [];
  return [
    {
      plan_id: planId,
      phase_index: 1,
      phase_title: null,
      title: normalizeLinkedPlanText(item?.linked_plan_title),
      file_path: normalizeLinkedPlanText(item?.linked_plan_file_path),
      status: normalizeLinkedPlanText(item?.linked_plan_status),
      completed_tasks: normalizeOptionalLinkedPlanCount(item?.linked_plan_completed_tasks),
      total_tasks: normalizeOptionalLinkedPlanCount(item?.linked_plan_total_tasks),
      validation_passed: null,
      is_current: true,
    },
  ];
}

export function currentLinkedPlanSummary(linkedPlans: LinkedPlanSummary[] | null | undefined) {
  const normalized = (linkedPlans || [])
    .map((summary, index) => normalizeLinkedPlanSummary(summary, index + 1))
    .filter((summary): summary is LinkedPlanSummary => summary !== null);
  if (normalized.length === 0) return null;
  return normalized.find((summary) => Boolean(summary.is_current || summary.current))
    || normalized.find((summary) => {
      const status = String(summary.status || '').toLowerCase();
      return status && !['completed', 'interrupted', 'draft'].includes(status);
    })
    || normalized.find((summary) => String(summary.status || '').toLowerCase() !== 'completed')
    || normalized[0];
}

export function findPreviewableLinkedPlan(
  item: LinkedPlanIntakeItem | null | undefined,
  plans: Plan[],
  projectId: number,
  linkedPlan?: LinkedPlanSummary | null,
) {
  const target = linkedPlan
    ? normalizeLinkedPlanSummary(linkedPlan, 1)
    : currentLinkedPlanSummary(normalizeLinkedPlans(item));
  const planId = target ? linkedPlanSummaryPlanId(target) : normalizeLinkedPlanId(item?.linked_plan_id);
  if (!planId) return null;
  return findLinkedPlanInSnapshot(plans, planId, projectId);
}

function normalizeLinkedPlanCount(value: number | string | null | undefined) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function normalizeOptionalLinkedPlanCount(value: number | string | null | undefined) {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
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

export function createUnavailableLinkedPlanFromSummary(projectId: number, linkedPlan: LinkedPlanSummary | null | undefined): Plan {
  const summary = normalizeLinkedPlanSummary(linkedPlan || null, 1);
  const planId = summary ? linkedPlanSummaryPlanId(summary) : null;
  const completed = summary
    ? normalizeLinkedPlanCount(summary.completed_tasks ?? summary.completedTasks ?? summary.completed)
    : 0;
  const total = summary
    ? normalizeLinkedPlanCount(summary.total_tasks ?? summary.totalTasks ?? summary.total)
    : 0;
  return {
    id: planId || 0,
    project_id: projectId,
    issue_hash: '',
    title: normalizeLinkedPlanText(summary?.title)
      || normalizeLinkedPlanText(summary?.phase_title ?? summary?.phaseTitle)
      || (planId ? `Plan #${planId}` : '绑定 Plan'),
    file_path: normalizeLinkedPlanText(summary?.file_path ?? summary?.filePath) || '',
    hash: '',
    status: normalizeLinkedPlanStatus(summary?.status),
    sort_order: 0,
    is_draft: false,
    completed_tasks: completed,
    total_tasks: total,
    validation_passed: normalizeLinkedPlanValidation(summary?.validation_passed ?? summary?.validationPassed),
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

function normalizeLinkedPlanSummary(summary: LinkedPlanSummary | null | undefined, fallbackPhaseIndex: number) {
  const planId = linkedPlanSummaryPlanId(summary);
  if (planId === null) return null;
  return {
    ...summary,
    plan_id: planId,
    phase_index: normalizeLinkedPlanPhaseIndex(summary?.phase_index ?? summary?.phaseIndex, fallbackPhaseIndex),
    phase_title: normalizeLinkedPlanText(summary?.phase_title ?? summary?.phaseTitle),
    title: normalizeLinkedPlanText(summary?.title),
    file_path: normalizeLinkedPlanText(summary?.file_path ?? summary?.filePath),
    status: normalizeLinkedPlanText(summary?.status),
    completed_tasks: normalizeOptionalLinkedPlanCount(summary?.completed_tasks ?? summary?.completedTasks ?? summary?.completed),
    total_tasks: normalizeOptionalLinkedPlanCount(summary?.total_tasks ?? summary?.totalTasks ?? summary?.total),
    validation_passed: summary?.validation_passed ?? summary?.validationPassed ?? null,
    is_current: Boolean(summary?.is_current ?? summary?.current ?? false),
  };
}

function linkedPlanSummaryPlanId(summary: LinkedPlanSummary | null | undefined) {
  return normalizeLinkedPlanId(summary?.plan_id ?? summary?.planId ?? summary?.id);
}

function linkedPlanPhaseIndex(summary: LinkedPlanSummary) {
  return normalizeLinkedPlanPhaseIndex(summary.phase_index ?? summary.phaseIndex, 1);
}

function normalizeLinkedPlanPhaseIndex(value: number | null | undefined, fallback: number) {
  const phaseIndex = Number(value);
  return Number.isInteger(phaseIndex) && phaseIndex > 0 ? phaseIndex : fallback;
}

function normalizeLinkedPlanText(value: unknown) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function normalizeLinkedPlanStatus(value: unknown): Plan['status'] {
  const status = normalizeLinkedPlanText(value);
  return (status || PLAN_STATUS.INTERRUPTED) as Plan['status'];
}

function normalizeLinkedPlanValidation(value: number | boolean | null | undefined) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? 1 : 0;
}
