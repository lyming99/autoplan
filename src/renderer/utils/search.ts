import { WORKSPACE_SEARCH_HIT_FIELDS, WORKSPACE_SEARCH_SOURCE_TYPES } from '../types';
import type {
  AppSnapshot,
  WorkspaceSearchGroup,
  WorkspaceSearchHitField,
  WorkspaceSearchLocation,
  WorkspaceSearchMatch,
  WorkspaceSearchQuery,
  WorkspaceSearchResult,
  WorkspaceSearchSourceConfig,
  WorkspaceSearchSourceType,
  WorkspaceSearchState,
  WorkspaceTab,
} from '../types';
import { formatEvent, getEventSearchText } from '../components/PlanLists';
import { getTimestampMs } from './time';

const SEARCH_SUMMARY_MAX_LENGTH = 140;
const SEARCH_SNIPPET_MAX_LENGTH = 120;
const FALLBACK_SEARCH_PRIORITY = 99;
const WORKSPACE_SEARCH_LOCATION_HIGHLIGHT_MS = 2400;
const WORKSPACE_SEARCH_LOCATION_SCROLL_BEHAVIOR = 'smooth';

const WORKSPACE_SEARCH_FIELD_PRIORITIES: Record<WorkspaceSearchHitField, number> = {
  [WORKSPACE_SEARCH_HIT_FIELDS.TITLE]: 0,
  [WORKSPACE_SEARCH_HIT_FIELDS.TASK_KEY]: 0,
  [WORKSPACE_SEARCH_HIT_FIELDS.STATUS]: 1,
  [WORKSPACE_SEARCH_HIT_FIELDS.EVENT_TYPE]: 1,
  [WORKSPACE_SEARCH_HIT_FIELDS.BODY]: 2,
  [WORKSPACE_SEARCH_HIT_FIELDS.MARKDOWN]: 2,
  [WORKSPACE_SEARCH_HIT_FIELDS.RAW_LINE]: 2,
  [WORKSPACE_SEARCH_HIT_FIELDS.EVENT_MESSAGE]: 2,
  [WORKSPACE_SEARCH_HIT_FIELDS.FILE_PATH]: 3,
  [WORKSPACE_SEARCH_HIT_FIELDS.SOURCE_PATH]: 3,
  [WORKSPACE_SEARCH_HIT_FIELDS.SCOPE]: 3,
  [WORKSPACE_SEARCH_HIT_FIELDS.EVENT_META]: 3,
};

type AttachmentRecord = AppSnapshot['attachments'][number];

interface WorkspaceSearchField {
  field: WorkspaceSearchHitField;
  label: string;
  value: string;
  priority: number;
}

interface WorkspaceSearchCandidate {
  source: WorkspaceSearchSourceType;
  recordId: number;
  title: string;
  summary: string;
  status: string | null;
  updatedAt: string;
  location: WorkspaceSearchLocation;
  fields: WorkspaceSearchField[];
}

interface RankedWorkspaceSearchResult {
  result: WorkspaceSearchResult;
  priority: number;
  updatedAtMs: number;
}

export const WORKSPACE_SEARCH_SOURCE_CONFIGS: WorkspaceSearchSourceConfig[] = [
  {
    type: WORKSPACE_SEARCH_SOURCE_TYPES.REQUIREMENT,
    label: '需求',
    targetTab: 'requirement',
  },
  {
    type: WORKSPACE_SEARCH_SOURCE_TYPES.FEEDBACK,
    label: '反馈',
    targetTab: 'feedback',
  },
  {
    type: WORKSPACE_SEARCH_SOURCE_TYPES.PLAN,
    label: 'Plan',
    targetTab: 'tasks',
  },
  {
    type: WORKSPACE_SEARCH_SOURCE_TYPES.TASK,
    label: '任务',
    targetTab: 'tasks',
  },
  {
    type: WORKSPACE_SEARCH_SOURCE_TYPES.EVENT,
    label: '事件流',
    targetTab: 'events',
  },
];

export const WORKSPACE_SEARCH_SOURCE_CONFIG_BY_TYPE = WORKSPACE_SEARCH_SOURCE_CONFIGS.reduce(
  (configs, config) => {
    configs[config.type] = config;
    return configs;
  },
  {} as Record<WorkspaceSearchSourceType, WorkspaceSearchSourceConfig>,
);

export function normalizeWorkspaceSearchQuery(query: string | null | undefined): WorkspaceSearchQuery {
  const raw = typeof query === 'string' ? query : '';
  const normalized = raw.trim().replace(/\s+/g, ' ').toLowerCase();

  return {
    raw,
    normalized,
    terms: normalized === '' ? [] : normalized.split(' '),
    isEmpty: normalized === '',
  };
}

export function isWorkspaceSearchSourceType(source: unknown): source is WorkspaceSearchSourceType {
  return (
    typeof source === 'string' &&
    Object.prototype.hasOwnProperty.call(WORKSPACE_SEARCH_SOURCE_CONFIG_BY_TYPE, source)
  );
}

export function getWorkspaceSearchSourceConfig(source: unknown): WorkspaceSearchSourceConfig | null {
  if (!isWorkspaceSearchSourceType(source)) {
    return null;
  }

  return WORKSPACE_SEARCH_SOURCE_CONFIG_BY_TYPE[source];
}

export function getWorkspaceSearchTargetTab(source: unknown): WorkspaceTab {
  return getWorkspaceSearchSourceConfig(source)?.targetTab ?? 'overview';
}

export function createEmptyWorkspaceSearchGroups(): WorkspaceSearchGroup[] {
  return WORKSPACE_SEARCH_SOURCE_CONFIGS.map((config) => ({
    source: config.type,
    label: config.label,
    targetTab: config.targetTab,
    count: 0,
    results: [],
  }));
}

export function createEmptyWorkspaceSearchState(query?: string | null): WorkspaceSearchState {
  return {
    query: normalizeWorkspaceSearchQuery(query),
    total: 0,
    results: [],
    groups: createEmptyWorkspaceSearchGroups(),
  };
}

export function resolveWorkspaceSearchQuery(
  query: string | WorkspaceSearchQuery | null | undefined,
): WorkspaceSearchQuery {
  if (typeof query === 'string' || query === null || typeof query === 'undefined') {
    return normalizeWorkspaceSearchQuery(query);
  }

  return normalizeWorkspaceSearchQuery(query.raw || query.normalized);
}

export function groupWorkspaceSearchResults(
  results: readonly WorkspaceSearchResult[],
): WorkspaceSearchGroup[] {
  return WORKSPACE_SEARCH_SOURCE_CONFIGS.map((config) => {
    const groupResults = results.filter((result) => result.source === config.type);

    return {
      source: config.type,
      label: config.label,
      targetTab: config.targetTab,
      count: groupResults.length,
      results: groupResults,
    };
  });
}

export function sortWorkspaceSearchResults(
  results: readonly WorkspaceSearchResult[],
): WorkspaceSearchResult[] {
  return [...results].sort(compareWorkspaceSearchResults);
}

export function workspaceSearchValueMatches(
  value: unknown,
  queryInput: string | WorkspaceSearchQuery | null | undefined,
): boolean {
  const query = resolveWorkspaceSearchQuery(queryInput);
  return !query.isEmpty && doesTextMatchQuery(toSearchText(value).toLowerCase(), query);
}

export function searchWorkspaceSnapshot(
  snapshot: AppSnapshot | null | undefined,
  queryInput: string | WorkspaceSearchQuery | null | undefined,
): WorkspaceSearchState {
  const query = resolveWorkspaceSearchQuery(queryInput);
  if (!snapshot || query.isEmpty) {
    return createWorkspaceSearchStateFromResults(query, []);
  }

  const attachmentLookup = createAttachmentLookup(snapshot.attachments ?? []);
  const candidates: WorkspaceSearchCandidate[] = [
    ...(snapshot.requirements ?? []).map((requirement) =>
      createRequirementCandidate(
        requirement,
        getOwnerAttachments(attachmentLookup, 'requirement', requirement.id),
      ),
    ),
    ...(snapshot.feedback ?? []).map((feedback) =>
      createFeedbackCandidate(feedback, getOwnerAttachments(attachmentLookup, 'feedback', feedback.id)),
    ),
    ...(snapshot.plans ?? []).map(createPlanCandidate),
    ...(snapshot.tasks ?? []).map(createTaskCandidate),
    ...(snapshot.events ?? []).map(createEventCandidate),
  ];

  const rankedResults = candidates
    .map((candidate) => createRankedWorkspaceSearchResult(candidate, query))
    .filter((result): result is RankedWorkspaceSearchResult => result !== null)
    .sort(compareRankedWorkspaceSearchResults);
  const results = rankedResults.map(({ result }) => result);

  return createWorkspaceSearchStateFromResults(query, results);
}

export function createWorkspaceSearchState(
  snapshot: AppSnapshot | null | undefined,
  queryInput: string | WorkspaceSearchQuery | null | undefined,
): WorkspaceSearchState {
  return searchWorkspaceSnapshot(snapshot, queryInput);
}

function createWorkspaceSearchStateFromResults(
  query: WorkspaceSearchQuery,
  results: WorkspaceSearchResult[],
): WorkspaceSearchState {
  return {
    query,
    total: results.length,
    results,
    groups: groupWorkspaceSearchResults(results),
  };
}

function createRequirementCandidate(
  requirement: AppSnapshot['requirements'][number],
  attachments: readonly AttachmentRecord[],
): WorkspaceSearchCandidate {
  const fields: WorkspaceSearchField[] = [];
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.TITLE, '标题', requirement.title);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.BODY, '正文', requirement.body);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.STATUS, '状态', requirement.status);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.SOURCE_PATH, '来源路径', requirement.source_path);
  pushAttachmentFields(fields, attachments);

  return {
    source: WORKSPACE_SEARCH_SOURCE_TYPES.REQUIREMENT,
    recordId: requirement.id,
    title: toSearchText(requirement.title) || `需求 #${requirement.id}`,
    summary: summarizeSearchText(requirement.body || requirement.source_path || requirement.status, '暂无正文'),
    status: nullableSearchText(requirement.status),
    updatedAt: requirement.updated_at,
    location: createWorkspaceSearchLocation(WORKSPACE_SEARCH_SOURCE_TYPES.REQUIREMENT, requirement.id),
    fields,
  };
}

function createFeedbackCandidate(
  feedback: AppSnapshot['feedback'][number],
  attachments: readonly AttachmentRecord[],
): WorkspaceSearchCandidate {
  const fields: WorkspaceSearchField[] = [];
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.TITLE, '标题', feedback.title);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.BODY, '正文', feedback.body);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.STATUS, '状态', feedback.status);
  pushAttachmentFields(fields, attachments);

  return {
    source: WORKSPACE_SEARCH_SOURCE_TYPES.FEEDBACK,
    recordId: feedback.id,
    title: toSearchText(feedback.title) || `反馈 #${feedback.id}`,
    summary: summarizeSearchText(feedback.body || feedback.status, '暂无正文'),
    status: nullableSearchText(feedback.status),
    updatedAt: feedback.updated_at,
    location: createWorkspaceSearchLocation(WORKSPACE_SEARCH_SOURCE_TYPES.FEEDBACK, feedback.id),
    fields,
  };
}

function createPlanCandidate(plan: AppSnapshot['plans'][number]): WorkspaceSearchCandidate {
  const fields: WorkspaceSearchField[] = [];
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.TITLE, '标题', plan.title);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.FILE_PATH, '文件路径', plan.file_path);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.STATUS, '状态', plan.status);
  const planTitle = toSearchText(plan.title);
  const fileName = getFileName(plan.file_path);

  return {
    source: WORKSPACE_SEARCH_SOURCE_TYPES.PLAN,
    recordId: plan.id,
    title: planTitle || fileName || `Plan #${plan.id}`,
    summary: summarizeSearchText(plan.file_path || planTitle || plan.status, '暂无路径'),
    status: nullableSearchText(plan.status),
    updatedAt: plan.updated_at,
    location: createWorkspaceSearchLocation(WORKSPACE_SEARCH_SOURCE_TYPES.PLAN, plan.id, {
      planId: plan.id,
      filePath: plan.file_path,
    }),
    fields,
  };
}

function createTaskCandidate(task: AppSnapshot['tasks'][number]): WorkspaceSearchCandidate {
  const fields: WorkspaceSearchField[] = [];
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.TASK_KEY, '任务 Key', task.task_key);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.TITLE, '标题', task.title);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.TITLE, 'Plan 标题', task.plan_title);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.STATUS, '状态', task.status);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.SCOPE, 'Scope', task.scope);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.RAW_LINE, '原始任务行', task.raw_line);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.FILE_PATH, '文件路径', task.file_path);

  const taskTitle = toSearchText(task.title);
  const taskKey = toSearchText(task.task_key);

  return {
    source: WORKSPACE_SEARCH_SOURCE_TYPES.TASK,
    recordId: task.id,
    title: taskKey && taskTitle ? `${taskKey}: ${taskTitle}` : taskTitle || taskKey || `任务 #${task.id}`,
    summary: summarizeSearchText(task.raw_line || task.scope || task.file_path, '暂无内容'),
    status: nullableSearchText(task.status),
    updatedAt: task.updated_at,
    location: createWorkspaceSearchLocation(WORKSPACE_SEARCH_SOURCE_TYPES.TASK, task.id, {
      planId: task.plan_id,
      taskId: task.id,
      taskKey,
      filePath: task.file_path,
    }),
    fields,
  };
}

function createEventCandidate(event: AppSnapshot['events'][number]): WorkspaceSearchCandidate {
  const fields: WorkspaceSearchField[] = [];
  const meta = getObjectMeta(event.meta);
  const eventMeta = stringifySearchMeta(event.meta);
  const display = formatEvent(event);
  const eventSearchText = getEventSearchText(event);

  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.EVENT_TYPE, '事件类型', event.type);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.TITLE, '标题', display.title);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.BODY, '正文', display.body);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.EVENT_MESSAGE, '事件信息', event.message);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.TASK_KEY, '任务 Key', meta?.taskKey);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.TITLE, '任务标题', meta?.taskTitle);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.STATUS, '状态', meta?.status);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.EVENT_META, '事件元信息', eventMeta);
  pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.EVENT_META, '事件搜索文本', eventSearchText);

  return {
    source: WORKSPACE_SEARCH_SOURCE_TYPES.EVENT,
    recordId: event.id,
    title: toSearchText(display.title) || toSearchText(event.message) || toSearchText(event.type) || `事件 #${event.id}`,
    summary: summarizeSearchText(event.type || eventMeta, '暂无事件信息'),
    status: nullableSearchText(meta?.status),
    updatedAt: event.created_at,
    location: createWorkspaceSearchLocation(WORKSPACE_SEARCH_SOURCE_TYPES.EVENT, event.id, {
      planId: meta?.planId ?? meta?.plan_id,
      taskId: meta?.taskId ?? meta?.task_id,
      taskKey: meta?.taskKey ?? meta?.task_key,
      filePath: meta?.filePath ?? meta?.file_path,
    }),
    fields,
  };
}

function createRankedWorkspaceSearchResult(
  candidate: WorkspaceSearchCandidate,
  query: WorkspaceSearchQuery,
): RankedWorkspaceSearchResult | null {
  const searchableText = candidate.fields.map((field) => field.value.toLowerCase()).join(' ');
  if (!doesTextMatchQuery(searchableText, query)) {
    return null;
  }

  const matches = candidate.fields
    .filter((field) => doesFieldMatchQuery(field, query))
    .map((field): WorkspaceSearchMatch => ({
      field: field.field,
      label: field.label,
      value: field.value,
      snippet: createSearchSnippet(field.value, query),
    }));
  if (matches.length === 0) {
    return null;
  }

  const priority = matches.reduce(
    (best, match) => Math.min(best, getSearchFieldPriority(match.field)),
    FALLBACK_SEARCH_PRIORITY,
  );
  const updatedAtMs = getTimestampMs(candidate.updatedAt);

  return {
    priority,
    updatedAtMs,
    result: {
      id: `${candidate.source}:${candidate.recordId}`,
      source: candidate.source,
      targetTab: candidate.location.targetTab,
      location: candidate.location,
      targetType: candidate.location.targetType,
      targetId: candidate.location.targetId,
      anchorId: candidate.location.anchorId,
      recordId: candidate.recordId,
      planId: candidate.location.planId,
      taskId: candidate.location.taskId,
      taskKey: candidate.location.taskKey,
      filePath: candidate.location.filePath,
      title: candidate.title,
      summary: candidate.summary,
      status: candidate.status,
      updatedAt: candidate.updatedAt,
      matches,
    },
  };
}

function createWorkspaceSearchLocation(
  targetType: WorkspaceSearchSourceType,
  targetId: number,
  options: { planId?: unknown; taskId?: unknown; taskKey?: unknown; filePath?: unknown } = {},
): WorkspaceSearchLocation {
  const planId = readSearchId(options.planId);
  const taskId = readSearchId(options.taskId);
  const taskKey = nullableSearchText(options.taskKey);
  const filePath = nullableSearchText(options.filePath);

  return {
    targetTab: getWorkspaceSearchTargetTab(targetType),
    targetType,
    targetId,
    anchorId: createWorkspaceSearchAnchorId(targetType, targetId),
    scrollBehavior: WORKSPACE_SEARCH_LOCATION_SCROLL_BEHAVIOR,
    highlightMs: WORKSPACE_SEARCH_LOCATION_HIGHLIGHT_MS,
    planId,
    taskId,
    taskKey,
    filePath,
  };
}

function createWorkspaceSearchAnchorId(targetType: WorkspaceSearchSourceType, targetId: number) {
  return `workspace-${targetType}-${targetId}`;
}

function readSearchId(value: unknown) {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

function pushSearchField(
  fields: WorkspaceSearchField[],
  field: WorkspaceSearchHitField,
  label: string,
  value: unknown,
) {
  const text = toSearchText(value);
  if (!text) return;

  fields.push({
    field,
    label,
    value: text,
    priority: getSearchFieldPriority(field),
  });
}

function pushAttachmentFields(fields: WorkspaceSearchField[], attachments: readonly AttachmentRecord[]) {
  attachments.forEach((attachment) => {
    pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.FILE_PATH, '附件名称', attachment.original_name);
    pushSearchField(fields, WORKSPACE_SEARCH_HIT_FIELDS.FILE_PATH, '附件路径', attachment.stored_path);
  });
}

function createAttachmentLookup(attachments: readonly AttachmentRecord[]) {
  const lookup = new Map<string, AttachmentRecord[]>();

  attachments.forEach((attachment) => {
    const key = createAttachmentLookupKey(attachment.owner_type, attachment.owner_id);
    const ownerAttachments = lookup.get(key) ?? [];
    lookup.set(key, [...ownerAttachments, attachment]);
  });

  return lookup;
}

function getOwnerAttachments(
  lookup: Map<string, AttachmentRecord[]>,
  ownerType: AttachmentRecord['owner_type'],
  ownerId: number,
) {
  return lookup.get(createAttachmentLookupKey(ownerType, ownerId)) ?? [];
}

function createAttachmentLookupKey(ownerType: AttachmentRecord['owner_type'], ownerId: number) {
  return `${ownerType}:${ownerId}`;
}

function doesFieldMatchQuery(field: WorkspaceSearchField, query: WorkspaceSearchQuery) {
  return doesTextMatchQuery(field.value.toLowerCase(), query);
}

function doesTextMatchQuery(text: string, query: WorkspaceSearchQuery) {
  if (!text || query.isEmpty) return false;
  if (text.includes(query.normalized)) return true;
  return query.terms.every((term) => text.includes(term));
}

function createSearchSnippet(value: string, query: WorkspaceSearchQuery) {
  const text = toSearchText(value);
  if (text.length <= SEARCH_SNIPPET_MAX_LENGTH) return text;

  const lowerText = text.toLowerCase();
  const matchIndex = getFirstSearchMatchIndex(lowerText, query);
  const safeMatchIndex = matchIndex >= 0 ? matchIndex : 0;
  const start = Math.max(0, safeMatchIndex - 32);
  const end = Math.min(text.length, start + SEARCH_SNIPPET_MAX_LENGTH);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';

  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function getFirstSearchMatchIndex(text: string, query: WorkspaceSearchQuery) {
  const phraseIndex = text.indexOf(query.normalized);
  if (phraseIndex >= 0) return phraseIndex;

  return query.terms.reduce((bestIndex, term) => {
    const termIndex = text.indexOf(term);
    if (termIndex < 0) return bestIndex;
    return bestIndex < 0 ? termIndex : Math.min(bestIndex, termIndex);
  }, -1);
}

function compareRankedWorkspaceSearchResults(
  left: RankedWorkspaceSearchResult,
  right: RankedWorkspaceSearchResult,
) {
  if (left.priority !== right.priority) return left.priority - right.priority;
  if (left.updatedAtMs !== right.updatedAtMs) return right.updatedAtMs - left.updatedAtMs;
  return compareWorkspaceSearchResults(left.result, right.result);
}

function compareWorkspaceSearchResults(left: WorkspaceSearchResult, right: WorkspaceSearchResult) {
  const leftPriority = getWorkspaceSearchResultPriority(left);
  const rightPriority = getWorkspaceSearchResultPriority(right);
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;

  const leftUpdatedAt = getTimestampMs(left.updatedAt);
  const rightUpdatedAt = getTimestampMs(right.updatedAt);
  if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt;

  if (left.source !== right.source) return left.source.localeCompare(right.source);
  return right.recordId - left.recordId;
}

function getWorkspaceSearchResultPriority(result: WorkspaceSearchResult) {
  return result.matches.reduce(
    (priority, match) => Math.min(priority, getSearchFieldPriority(match.field)),
    FALLBACK_SEARCH_PRIORITY,
  );
}

function getSearchFieldPriority(field: WorkspaceSearchHitField) {
  return WORKSPACE_SEARCH_FIELD_PRIORITIES[field] ?? FALLBACK_SEARCH_PRIORITY;
}

function summarizeSearchText(value: unknown, fallback: string) {
  const text = toSearchText(value);
  if (!text) return fallback;
  if (text.length <= SEARCH_SUMMARY_MAX_LENGTH) return text;
  return `${text.slice(0, SEARCH_SUMMARY_MAX_LENGTH)}…`;
}

function nullableSearchText(value: unknown) {
  return toSearchText(value) || null;
}

function toSearchText(value: unknown) {
  if (value === null || typeof value === 'undefined') return '';
  return String(value).trim().replace(/\s+/g, ' ');
}

function getFileName(filePath: unknown) {
  const path = toSearchText(filePath);
  if (!path) return '';
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function getObjectMeta(meta: unknown): Record<string, unknown> | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }

  return meta as Record<string, unknown>;
}

function stringifySearchMeta(meta: unknown) {
  if (meta === null || typeof meta === 'undefined') return '';
  if (typeof meta === 'string') return meta;

  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}
