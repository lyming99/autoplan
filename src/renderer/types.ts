export type IntakeType = 'requirement' | 'feedback';
export type WorkspaceTab = 'overview' | 'requirement' | 'feedback' | 'acceptance' | 'tasks' | 'scripts' | 'events' | 'settings';
export const DEFAULT_WORKSPACE_TAB: WorkspaceTab = 'requirement';
export type AgentCliProvider = 'codex' | 'claude' | 'opencode' | 'oh-my-pi' | string;
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | string;

export const PLAN_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  READY_FOR_VALIDATION: 'ready_for_validation',
  VALIDATION_FAILED: 'validation_failed',
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
  DRAFT: 'draft',
} as const;

export type PlanStatus = (typeof PLAN_STATUS)[keyof typeof PLAN_STATUS];

export interface AgentCliOption {
  value: AgentCliProvider;
  label: string;
}

export interface AgentCliDisplaySource {
  agent_cli_provider?: AgentCliProvider | null;
  agentCliProvider?: AgentCliProvider | null;
  cli_provider?: AgentCliProvider | null;
  cliProvider?: AgentCliProvider | null;
  cli_backend?: AgentCliProvider | null;
  cliBackend?: AgentCliProvider | null;
  provider?: AgentCliProvider | null;
  agent_cli_command?: string | null;
  agentCliCommand?: string | null;
  cli_command?: string | null;
  cliCommand?: string | null;
  cli_path?: string | null;
  cliPath?: string | null;
  command?: string | null;
  codex_reasoning_effort?: CodexReasoningEffort | null;
  codexReasoningEffort?: CodexReasoningEffort | null;
  codex_thinking_depth?: CodexReasoningEffort | null;
  codexThinkingDepth?: CodexReasoningEffort | null;
  reasoning_effort?: CodexReasoningEffort | null;
  reasoningEffort?: CodexReasoningEffort | null;
  thinking_depth?: CodexReasoningEffort | null;
  thinkingDepth?: CodexReasoningEffort | null;
  agent_cli_session_id?: string | null;
  agentCliSessionId?: string | null;
  agentCliSessionMode?: string | null;
  agentCliSessionState?: string | null;
  agentCliSessionRequestedId?: string | null;
  agentCliSessionFallback?: boolean | null;
  agentCliSessionLabel?: string | null;
  codex_session_id?: string | null;
  codexSessionId?: string | null;
  codexSessionMode?: string | null;
  codexSessionState?: string | null;
  codexSessionRequestedId?: string | null;
  codexSessionFallback?: boolean | null;
  codexSessionLabel?: string | null;
  [key: string]: unknown;
}

export const WORKSPACE_SEARCH_SOURCE_TYPES = {
  REQUIREMENT: 'requirement',
  FEEDBACK: 'feedback',
  PLAN: 'plan',
  TASK: 'task',
  EVENT: 'event',
} as const;

export type WorkspaceSearchSourceType =
  (typeof WORKSPACE_SEARCH_SOURCE_TYPES)[keyof typeof WORKSPACE_SEARCH_SOURCE_TYPES];

export const WORKSPACE_SEARCH_HIT_FIELDS = {
  TITLE: 'title',
  BODY: 'body',
  STATUS: 'status',
  MARKDOWN: 'markdown',
  FILE_PATH: 'filePath',
  SOURCE_PATH: 'sourcePath',
  TASK_KEY: 'taskKey',
  SCOPE: 'scope',
  RAW_LINE: 'rawLine',
  EVENT_TYPE: 'eventType',
  EVENT_MESSAGE: 'eventMessage',
  EVENT_META: 'eventMeta',
} as const;

export type WorkspaceSearchHitField =
  (typeof WORKSPACE_SEARCH_HIT_FIELDS)[keyof typeof WORKSPACE_SEARCH_HIT_FIELDS];

export type WorkspaceSearchTargetType = WorkspaceSearchSourceType;

export type WorkspaceSearchScrollBehavior = 'auto' | 'smooth';

export interface WorkspaceSearchQuery {
  raw: string;
  normalized: string;
  terms: string[];
  isEmpty: boolean;
}

export interface WorkspaceSearchSourceConfig {
  type: WorkspaceSearchSourceType;
  label: string;
  targetTab: WorkspaceTab;
}

export interface WorkspaceSearchMatch {
  field: WorkspaceSearchHitField;
  label: string;
  value: string;
  snippet?: string;
}

export interface WorkspaceSearchLocation {
  targetTab: WorkspaceTab;
  targetType: WorkspaceSearchTargetType;
  targetId: number;
  anchorId: string;
  scrollBehavior: WorkspaceSearchScrollBehavior;
  highlightMs: number;
  planId?: number | null;
  taskId?: number | null;
  taskKey?: string | null;
  filePath?: string | null;
}

export interface WorkspaceSearchResult {
  id: string;
  source: WorkspaceSearchSourceType;
  targetTab: WorkspaceTab;
  location: WorkspaceSearchLocation;
  targetType: WorkspaceSearchTargetType;
  targetId: number;
  anchorId: string;
  recordId: number;
  planId?: number | null;
  taskId?: number | null;
  taskKey?: string | null;
  filePath?: string | null;
  title: string;
  summary: string;
  status: string | null;
  updatedAt: string;
  matches: WorkspaceSearchMatch[];
}

export interface WorkspaceSearchGroup {
  source: WorkspaceSearchSourceType;
  label: string;
  targetTab: WorkspaceTab;
  count: number;
  results: WorkspaceSearchResult[];
}

export interface WorkspaceSearchState {
  query: WorkspaceSearchQuery;
  total: number;
  results: WorkspaceSearchResult[];
  groups: WorkspaceSearchGroup[];
}

export interface Project {
  id: number;
  name: string;
  workspace_path: string;
  description: string;
  created_at: string;
  updated_at: string;
  running?: number;
  phase?: string;
  interval_seconds?: number;
  validation_command?: string;
  agent_cli_provider?: AgentCliProvider;
  agent_cli_command?: string;
  codex_reasoning_effort?: CodexReasoningEffort | null;
  env_vars?: string;
}

export interface ProjectState {
  project_id: number;
  running: number;
  phase: string;
  interval_seconds: number;
  validation_command: string;
  last_issue_hash?: string | null;
  last_error?: string | null;
  agent_cli_provider?: AgentCliProvider;
  agent_cli_command?: string;
  codex_reasoning_effort?: CodexReasoningEffort | null;
  env_vars?: string;
  updated_at: string;
  /** 由 snapshot 合并自 project.workspace_path */
  workspace_path?: string;
}

export interface Requirement {
  id: number;
  project_id: number;
  title: string;
  body: string;
  status: string;
  source_path?: string | null;
  source_hash?: string | null;
  agent_cli_provider?: AgentCliProvider | null;
  agent_cli_command?: string;
  codex_reasoning_effort?: CodexReasoningEffort | null;
  linked_plan_id?: number | null;
  plan_title?: string | null;
  plan_file_path?: string | null;
  plan_status?: string | null;
  plan_completed?: number | null;
  plan_total?: number | null;
  created_at: string;
  updated_at: string;
}

export interface Feedback extends AgentCliSessionInfo {
  id: number;
  project_id: number;
  requirement_id?: number | null;
  title: string;
  body: string;
  status: string;
  agent_cli_provider?: AgentCliProvider | null;
  agent_cli_command?: string;
  codex_reasoning_effort?: CodexReasoningEffort | null;
  agent_cli_session_id?: string | null;
  linked_plan_id?: number | null;
  plan_title?: string | null;
  plan_file_path?: string | null;
  plan_status?: string | null;
  plan_completed?: number | null;
  plan_total?: number | null;
  created_at: string;
  updated_at: string;
}

export interface Attachment {
  id: number;
  project_id: number;
  owner_type: IntakeType;
  owner_id: number;
  original_name: string;
  stored_path: string;
  mime_type?: string | null;
  size: number;
  hash: string;
  created_at: string;
}

export interface Plan extends AgentCliSessionInfo {
  id: number;
  project_id: number;
  issue_hash: string;
  file_path: string;
  title?: string | null;
  hash: string;
  status: PlanStatus;
  sort_order: number;
  is_draft: boolean;
  total_tasks: number;
  completed_tasks: number;
  validation_passed: number;
  agent_cli_provider?: AgentCliProvider | null;
  agent_cli_command?: string;
  codex_reasoning_effort?: CodexReasoningEffort | null;
  agent_cli_session_id?: string | null;
  concurrency_suggestion: PlanConcurrencySuggestion;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
}

export interface PlanScopeFileInfo {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  canOpen: boolean;
  isUnknown: boolean;
  isValidation: boolean;
  reason: string;
}

export interface PlanConcurrencyTask {
  id: number;
  task_key: string;
  title: string;
  status: string;
  scopes: string[];
  reason: string;
}

export interface PlanConcurrencyBatch {
  batch: number;
  reason: string;
  tasks: PlanConcurrencyTask[];
}

export interface PlanConcurrencySuggestion {
  hasSafeParallelBatches: boolean;
  parallelTaskCount: number;
  batchCount: number;
  serialTaskCount: number;
  maxParallelTasks: number;
  batches: PlanConcurrencyBatch[];
  serialTasks: PlanConcurrencyTask[];
}

export type ReadPlanTaskParseStatus = 'parsed' | 'parse_empty' | 'no_tasks' | 'empty_markdown' | 'read_failed';

export interface ReadPlanTask {
  id: number;
  plan_id: number;
  task_key: string;
  title: string;
  raw_line: string;
  scope: string;
  scopes: string[];
  status: string;
  sort_order: number;
  updated_at: string;
}

export interface ReadPlanResult {
  ok: boolean;
  id: number | null;
  project_id: number | null;
  file_path: string;
  markdown: string;
  tasks: ReadPlanTask[];
  task_total: number;
  task_completed: number;
  task_parse_status: ReadPlanTaskParseStatus;
  task_parse_message: string;
  task_parse_has_task_section: boolean;
  hash: string;
  updated_at: string;
  error: string | null;
}

export interface WorkspacePlanReadState {
  plan: Plan | null;
  result: ReadPlanResult | null;
  loading: boolean;
  error: string | null;
}

export type AgentCliSessionMode = 'new' | 'resume' | 'continue';

export type AgentCliSessionState = AgentCliSessionMode | 'fallback-new' | string;

export interface AgentCliSessionInfo {
  agentCliProvider?: AgentCliProvider | null;
  agent_cli_provider?: AgentCliProvider | null;
  agentCliSessionId?: string | null;
  agent_cli_session_id?: string | null;
  agentCliSessionShortId?: string | null;
  agent_cli_session_short_id?: string | null;
  agentCliSessionMode?: AgentCliSessionMode | null;
  agent_cli_session_mode?: AgentCliSessionMode | null;
  agentCliSessionState?: AgentCliSessionState | null;
  agent_cli_session_state?: AgentCliSessionState | null;
  agentCliSessionLabel?: string | null;
  agent_cli_session_label?: string | null;
  agentCliSessionRequestedId?: string | null;
  agent_cli_session_requested_id?: string | null;
  agentCliSessionRequestedShortId?: string | null;
  agent_cli_session_requested_short_id?: string | null;
  agentCliSessionFallback?: boolean | null;
  agent_cli_session_fallback?: boolean | null;
}

export type CodexSessionMode = Extract<AgentCliSessionMode, 'new' | 'resume'>;

export type CodexSessionState = CodexSessionMode | 'fallback-new' | string;

export interface CodexSessionInfo {
  codexSessionId?: string | null;
  codex_session_id?: string | null;
  codexSessionShortId?: string | null;
  codex_session_short_id?: string | null;
  codexSessionMode?: CodexSessionMode | null;
  codex_session_mode?: CodexSessionMode | null;
  codexSessionState?: CodexSessionState | null;
  codex_session_state?: CodexSessionState | null;
  codexSessionLabel?: string | null;
  codex_session_label?: string | null;
  codexSessionRequestedId?: string | null;
  codex_session_requested_id?: string | null;
  codexSessionRequestedShortId?: string | null;
  codex_session_requested_short_id?: string | null;
  codexSessionFallback?: boolean | null;
  codex_session_fallback?: boolean | null;
}

export interface PlanTask extends AgentCliSessionInfo, CodexSessionInfo {
  id: number;
  plan_id: number;
  task_key: string;
  title: string;
  raw_line: string;
  scope: string;
  scope_files: PlanScopeFileInfo[];
  status: string;
  sort_order: number;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number;
  run_duration_ms?: number;
  agent_cli_session_id?: string | null;
  codex_session_id: string | null;
  agentCliProvider?: string | null;
  agentCliCommand?: string | null;
  codexReasoningEffort?: CodexReasoningEffort | null;
  updated_at: string;
  accepted_at: string | null;
  /** JOIN plans 得到 */
  file_path: string;
  /** JOIN plans 并读取计划 Markdown 标题得到 */
  plan_title: string;
}

export type PlanTaskAssociationSource = 'plan_id' | 'file_path';

export interface PlanTaskAssociationTaskRef {
  plan_id?: number | null;
  file_path?: string | null;
}

export interface PlanTaskAssociationPlanRef {
  id: number;
  file_path?: string | null;
}

export function readPlanTaskAssociationPlanId(task: PlanTaskAssociationTaskRef) {
  if (task.plan_id === null || typeof task.plan_id === 'undefined') return null;
  const planId = Number(task.plan_id);
  return Number.isFinite(planId) ? planId : null;
}

export function readPlanTaskAssociationFilePath(record: { file_path?: string | null }) {
  return String(record.file_path || '').trim();
}

export function getPlanTaskAssociationSource(
  task: PlanTaskAssociationTaskRef,
  plan: PlanTaskAssociationPlanRef,
): PlanTaskAssociationSource | null {
  const taskPlanId = readPlanTaskAssociationPlanId(task);
  if (taskPlanId !== null) return taskPlanId === plan.id ? 'plan_id' : null;

  const taskFilePath = readPlanTaskAssociationFilePath(task);
  const planFilePath = readPlanTaskAssociationFilePath(plan);
  return taskFilePath && planFilePath && taskFilePath === planFilePath ? 'file_path' : null;
}

export function isTaskAssociatedWithPlan(task: PlanTaskAssociationTaskRef, plan: PlanTaskAssociationPlanRef) {
  return getPlanTaskAssociationSource(task, plan) !== null;
}

export interface WorkspacePlanSelectionState {
  selectedPlanId: number | null;
  selectedPlan: Plan | null;
  selectPlan: (plan: Plan) => void;
  clearSelection: () => void;
}

export const TASK_EVENT_TYPES = {
  STARTED: 'task.started',
  SUCCEEDED: 'task.succeeded',
  FAILED: 'task.failed',
  STOP_REQUESTED: 'task.stop.requested',
  STOPPED: 'task.stopped',
  INTERRUPTED: 'task.interrupted',
} as const;

export const LEGACY_TASK_EVENT_TYPES = {
  EXECUTED: 'task.executed',
  STOPPING: 'task.stopping',
} as const;

export const TASK_EVENT_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  INTERRUPTED: 'interrupted',
} as const;

export type TaskEventType = (typeof TASK_EVENT_TYPES)[keyof typeof TASK_EVENT_TYPES];
export type LegacyTaskEventType = (typeof LEGACY_TASK_EVENT_TYPES)[keyof typeof LEGACY_TASK_EVENT_TYPES];
export type TaskEventStatus = (typeof TASK_EVENT_STATUS)[keyof typeof TASK_EVENT_STATUS];

export interface TaskEventSemantics {
  status: TaskEventStatus;
  label: string;
}

export const TASK_EVENT_SEMANTICS: Record<TaskEventType, TaskEventSemantics> = {
  [TASK_EVENT_TYPES.STARTED]: { status: TASK_EVENT_STATUS.RUNNING, label: '开始了任务' },
  [TASK_EVENT_TYPES.SUCCEEDED]: { status: TASK_EVENT_STATUS.COMPLETED, label: '结束了任务' },
  [TASK_EVENT_TYPES.FAILED]: { status: TASK_EVENT_STATUS.FAILED, label: '任务失败' },
  [TASK_EVENT_TYPES.STOP_REQUESTED]: { status: TASK_EVENT_STATUS.STOPPING, label: '请求停止任务' },
  [TASK_EVENT_TYPES.STOPPED]: { status: TASK_EVENT_STATUS.STOPPED, label: '已停止任务' },
  [TASK_EVENT_TYPES.INTERRUPTED]: { status: TASK_EVENT_STATUS.INTERRUPTED, label: '已中断任务' },
};

export const TASK_EVENT_COMPATIBILITY: Record<LegacyTaskEventType, TaskEventType> = {
  [LEGACY_TASK_EVENT_TYPES.EXECUTED]: TASK_EVENT_TYPES.SUCCEEDED,
  [LEGACY_TASK_EVENT_TYPES.STOPPING]: TASK_EVENT_TYPES.STOPPED,
};

export interface TaskEventMeta extends AgentCliSessionInfo, CodexSessionInfo {
  taskId?: number | null;
  taskKey?: string | null;
  taskTitle?: string | null;
  planId?: number | null;
  status?: TaskEventStatus | string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  runDurationMs?: number | null;
  exitCode?: number | null;
  log?: string | null;
  error?: string | null;
  agentCliProvider?: string | null;
  agentCliCommand?: string | null;
  codexReasoningEffort?: CodexReasoningEffort | null;
  [key: string]: unknown;
}

export type AppEventStructuredMeta = TaskEventMeta | Record<string, unknown>;
export type AppEventMeta = string | AppEventStructuredMeta;

export interface AppEvent<TMeta extends AppEventMeta | null = AppEventMeta | null> {
  id: number;
  project_id: number;
  type: string;
  message: string;
  meta?: TMeta;
  created_at: string;
}

export interface ScanFile {
  project_id: number;
  scan_type: string;
  file_path: string;
  hash: string;
  size: number;
  modified_at: string;
  scanned_at: string;
}

export type ScriptRuntime = 'node' | 'bash' | 'ps' | 'cmd';
export type ScriptSourceType = 'inline' | 'file';
export type ScriptTriggerMode = 'hook' | 'manual' | 'schedule';
export type ScriptContextInject = 'env' | 'stdin' | 'none';
export type ScriptHookStage = 'plan:after' | 'task:after' | 'validation:before' | 'loop:end' | 'on:fail';
export type ScriptLastStatus = 'idle' | 'ok' | 'bad' | 'running';

/** 脚本记录同时容忍蛇形（DB 原样）与驼峰字段，沿用本仓库既有双写惯例 */
export interface Script {
  id: number;
  project_id: number;
  projectId?: number;
  name: string;
  path: string;
  runtime: ScriptRuntime;
  body: string;
  source_type: ScriptSourceType;
  sourceType?: ScriptSourceType;
  description: string;
  trigger_mode: ScriptTriggerMode;
  triggerMode?: ScriptTriggerMode;
  hook_stage: ScriptHookStage | null;
  hookStage?: ScriptHookStage | null;
  schedule_cron: string | null;
  scheduleCron?: string | null;
  enabled: number;
  work_dir: string;
  workDir?: string;
  timeout_seconds: number;
  timeoutSeconds?: number;
  fail_aborts: number;
  failAborts?: number;
  context_inject: ScriptContextInject;
  contextInject?: ScriptContextInject;
  sort_order: number;
  sortOrder?: number;
  last_status: ScriptLastStatus | null;
  lastStatus?: ScriptLastStatus | null;
  last_exit_code: number | null;
  lastExitCode?: number | null;
  last_duration_ms: number | null;
  lastDurationMs?: number | null;
  last_log: string | null;
  lastLog?: string | null;
  last_run_at: string | null;
  lastRunAt?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateScriptInput {
  projectId: number;
  name: string;
  runtime?: ScriptRuntime;
  body?: string;
  path?: string;
  sourceType?: ScriptSourceType;
  source_type?: ScriptSourceType;
  description?: string;
  triggerMode?: ScriptTriggerMode;
  trigger_mode?: ScriptTriggerMode;
  hookStage?: ScriptHookStage | null;
  hook_stage?: ScriptHookStage | null;
  scheduleCron?: string | null;
  schedule_cron?: string | null;
  enabled?: number | boolean;
  workDir?: string;
  work_dir?: string;
  timeoutSeconds?: number;
  timeout_seconds?: number;
  failAborts?: number | boolean;
  fail_aborts?: number | boolean;
  contextInject?: ScriptContextInject;
  context_inject?: ScriptContextInject;
  sortOrder?: number;
  sort_order?: number;
}

export interface UpdateScriptInput extends CreateScriptInput {
  scriptId: number;
}

export interface ScriptIdInput {
  projectId: number;
  scriptId: number;
}

/** 手动运行 scripts:run 的返回：更新后的快照 + 本次运行的退出码/耗时/日志 */
export interface ScriptRunResult {
  snapshot: AppSnapshot;
  status: ScriptLastStatus | null;
  exitCode: number | null;
  durationMs: number | null;
  log: string | null;
  timedOut?: boolean;
  error?: string | null;
}

export interface AppSnapshot {
  activeProjectId: number | null;
  activeProject: Project | null;
  projects: Project[];
  mcp: McpStatus;
  state: ProjectState | null;
  requirements: Requirement[];
  feedback: Feedback[];
  attachments: Attachment[];
  plans: Plan[];
  tasks: PlanTask[];
  events: AppEvent<AppEventMeta | null>[];
  scans: ScanFile[];
  scripts: Script[];
  activeOperation: ActiveOperation | null;
  activeOperations: ActiveOperation[];
  lastOperation: ActiveOperation | null;
}

export interface ActivityLine {
  role: string;
  text: string;
  at: string;
}

export interface ActiveOperation extends AgentCliSessionInfo, CodexSessionInfo {
  label: string;
  projectId: number | null;
  planId: number | null;
  taskId: number | null;
  agentCliProvider?: string;
  agentCliCommand?: string;
  codexReasoningEffort?: CodexReasoningEffort | null;
  startedAt: string | null;
  finishedAt?: string | null;
  exitCode?: number | null;
  cancelled?: boolean | null;
  cancelledAt?: string | null;
  logTail: string;
  activity: ActivityLine[];
}

export const PENDING_ATTACHMENT_SOURCES = {
  PATH: 'path',
  CLIPBOARD_IMAGE: 'clipboard-image',
} as const;

export type PendingAttachmentSource =
  (typeof PENDING_ATTACHMENT_SOURCES)[keyof typeof PENDING_ATTACHMENT_SOURCES];

export interface PendingAttachmentBase {
  id: string;
  source: PendingAttachmentSource;
  name: string;
  size: number;
  /** MIME type */
  type: string;
  previewUrl: string;
}

export interface PendingPathAttachment extends PendingAttachmentBase {
  source: typeof PENDING_ATTACHMENT_SOURCES.PATH;
  path: string;
}

export interface PendingClipboardImageAttachment extends PendingAttachmentBase {
  source: typeof PENDING_ATTACHMENT_SOURCES.CLIPBOARD_IMAGE;
  dataUrl: string;
  base64?: string;
  dataBase64?: string;
  bytes?: number[] | ArrayBuffer | Uint8Array;
}

export type PendingAttachment = PendingPathAttachment | PendingClipboardImageAttachment;

export interface CreateIntakeInput {
  projectId: number;
  body: string;
  attachments: PendingAttachment[];
  title?: string;
  status?: string;
  autoRun?: boolean;
  requirementId?: number | null;
  agentCliProvider?: AgentCliProvider;
  agentCliCommand?: string;
  codexReasoningEffort?: CodexReasoningEffort;
}

export interface CreateProjectInput {
  name: string;
  workspacePath: string;
  description?: string;
  agentCliProvider?: AgentCliProvider;
  agentCliCommand?: string;
  codexReasoningEffort?: CodexReasoningEffort;
}

export const MCP_TOOL_NAMES = {
  LIST_PROJECTS: 'list_projects',
  GET_PROJECT: 'get_project',
  CREATE_PROJECT: 'create_project',
  LIST_REQUIREMENTS: 'list_requirements',
  CREATE_REQUIREMENT: 'create_requirement',
  LIST_FEEDBACK: 'list_feedback',
  CREATE_FEEDBACK: 'create_feedback',
  LIST_PLANS: 'list_plans',
  GET_PLAN: 'get_plan',
  LIST_TASKS: 'list_tasks',
  START_LOOP: 'start_loop',
  STOP_LOOP: 'stop_loop',
} as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[keyof typeof MCP_TOOL_NAMES];
export type McpTransport = 'http' | 'stdio';
export type McpStatusKind = 'disabled' | 'configured' | 'running' | 'error';
export type McpAgentCliProvider = 'codex' | 'claude';
export type McpCodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type McpIntakeStatus = 'open' | 'completed' | 'closed';
export interface McpToolDoc { name: McpToolName | string; title: string; description: string; markdown: string; }

export interface McpStatus {
  enabled: boolean;
  running: boolean;
  status: McpStatusKind;
  transport: McpTransport;
  host: string | null;
  port: number | null;
  path: string | null;
  url: string | null;
  /** 是否已设置 Bearer 密钥（快照不下发明文密钥本身） */
  hasAuthToken: boolean;
  /** 脱敏密钥：仅显示末 4 位（如 `····1234`），无密钥时为空串 */
  authTokenMasked: string;
  /** 鉴权请求头模板提示（不含真实密钥，如 `Authorization: Bearer <token>`） */
  authHeader: string;
  localOnly: boolean;
  tools: McpToolName[];
  toolDocs: McpToolDoc[];
  connectionExample: string;
  note: string;
  lastEvent?: {
    type: string;
    message: string;
    createdAt: string;
  } | null;
  lastError?: string | null;
  /** 实时运行态：MCP 进程本次启动时间，未运行/未注入时为 null */
  startedAt?: string | null;
}

/** MCP 配置表单：渲染层 draft 完整值（authToken 默认留空，不从快照明文回填） */
export interface McpConfigForm {
  enabled: boolean;
  transport: McpTransport;
  host: string;
  port: number | string;
  path: string;
  authToken: string;
}

/** saveMcpConfig 载荷：仅下发显式改动的字段（authToken 传空串表示清除鉴权） */
export interface McpConfigInput {
  projectId?: number | null;
  enabled?: boolean;
  transport?: McpTransport;
  host?: string;
  port?: number | string;
  path?: string;
  authToken?: string;
}

export interface McpAgentCliInput {
  agentCliProvider?: McpAgentCliProvider;
  agentCliCommand?: string;
  codexReasoningEffort?: McpCodexReasoningEffort;
}

export interface McpAttachmentInput {
  name?: string;
  size?: number;
  source?: PendingAttachmentSource;
  path?: string;
  /** MIME type */
  type?: string;
  dataUrl?: string;
  base64?: string;
  dataBase64?: string;
  bytes?: number[];
}

export interface McpCreateProjectInput extends McpAgentCliInput {
  name: string;
  workspacePath: string;
  description?: string;
}

export interface McpCreateRequirementInput extends McpAgentCliInput {
  projectId: number;
  title: string;
  body: string;
  attachments?: McpAttachmentInput[];
  autoRun?: boolean;
  status?: McpIntakeStatus;
}

export interface McpCreateFeedbackInput extends McpCreateRequirementInput {
  requirementId?: number | null;
}

export type McpToolInput =
  | McpCreateProjectInput
  | McpCreateRequirementInput
  | McpCreateFeedbackInput;

export interface McpSnapshotSummary {
  activeProjectId: number | null;
  activeProject: Pick<Project, 'id' | 'name' | 'description'> & { workspacePath: string } | null;
  state: {
    running: boolean;
    phase: string;
    validationCommand: string;
    agentCliProvider: AgentCliProvider | null;
    codexReasoningEffort: CodexReasoningEffort | null;
  } | null;
  counts: {
    projects: number;
    requirements: number;
    feedback: number;
    plans: number;
    tasks: number;
    events: number;
  };
}

export interface McpToolResult {
  projectId: number | null;
  requirementId?: number | null;
  feedbackId?: number | null;
  snapshot: McpSnapshotSummary;
}

export interface UpdateProjectInput extends CreateProjectInput {
  id: number;
}

/** 环境变量键值对（设置面板与表单共用），序列化为 project_states.env_vars 的 JSON 数组 */
export interface EnvVarEntry {
  name: string;
  value: string;
}

export interface LoopConfigInput {
  projectId: number;
  workspacePath?: string;
  intervalSeconds?: number;
  validationCommand?: string;
  validation_command?: string;
  agentCliProvider?: AgentCliProvider;
  agentCliCommand?: string;
  codexReasoningEffort?: CodexReasoningEffort;
  mcpAuthToken?: string;
  envVars?: EnvVarEntry[];
}

export interface ProjectIdInput {
  projectId: number;
  manual?: boolean;
}

export interface RecordIdInput extends ProjectIdInput {
  id: number;
}

export interface AcceptanceItemInput extends RecordIdInput {
  targetType: 'plan' | 'task';
}

export interface AcceptBatchInput extends ProjectIdInput {
  targets: AcceptanceItemInput[];
}

export interface TaskIdInput extends ProjectIdInput {
  taskId: number;
}

export interface ReadPlanInput extends ProjectIdInput {
  planId: number;
}

export interface IntakeActionInput extends ProjectIdInput {
  type: IntakeType;
  id: number;
  title?: string;
}

export interface UpdateRequirementInput extends RecordIdInput {
  title?: string;
  body?: string;
  status?: string;
  attachments?: PendingAttachment[];
  agentCliProvider?: AgentCliProvider;
  agentCliCommand?: string;
  codexReasoningEffort?: CodexReasoningEffort;
}

export interface UpdateFeedbackInput extends UpdateRequirementInput {
  requirementId?: number | null;
}
export interface AutoplanApi {
  mcpToolNames: McpToolName[];
  snapshot: (projectId?: number | null) => Promise<AppSnapshot>;
  createProject: (input: CreateProjectInput) => Promise<AppSnapshot>;
  updateProject: (input: UpdateProjectInput) => Promise<AppSnapshot>;
  deleteProject: (input: ProjectIdInput) => Promise<AppSnapshot>;
  configureLoop: (config: LoopConfigInput) => Promise<AppSnapshot>;
  startLoop: (input: ProjectIdInput) => Promise<AppSnapshot>;
  stopLoop: (input: ProjectIdInput) => Promise<AppSnapshot>;
  runOnce: (input: ProjectIdInput) => Promise<AppSnapshot>;
  startMcp: (input: ProjectIdInput) => Promise<AppSnapshot>;
  stopMcp: (input: ProjectIdInput) => Promise<AppSnapshot>;
  mcpStatus: (input?: ProjectIdInput | null) => Promise<AppSnapshot>;
  saveMcpConfig: (config: McpConfigInput) => Promise<AppSnapshot>;
  readPlan: (input: ReadPlanInput) => Promise<ReadPlanResult>;
  runTask: (input: TaskIdInput) => Promise<AppSnapshot>;
  stopTask: (input: TaskIdInput) => Promise<AppSnapshot>;
  acceptItem: (input: AcceptanceItemInput) => Promise<AppSnapshot>;
  unacceptItem: (input: AcceptanceItemInput) => Promise<AppSnapshot>;
  acceptItems: (input: AcceptBatchInput) => Promise<AppSnapshot>;
  unacceptItems: (input: AcceptBatchInput) => Promise<AppSnapshot>;
  createRequirement: (input: CreateIntakeInput) => Promise<AppSnapshot>;
  updateRequirement: (input: UpdateRequirementInput) => Promise<AppSnapshot>;
  deleteRequirement: (input: RecordIdInput) => Promise<AppSnapshot>;
  createFeedback: (input: CreateIntakeInput) => Promise<AppSnapshot>;
  updateFeedback: (input: UpdateFeedbackInput) => Promise<AppSnapshot>;
  deleteFeedback: (input: RecordIdInput) => Promise<AppSnapshot>;
  interruptIntake: (input: IntakeActionInput) => Promise<AppSnapshot>;
  resumeIntake: (input: IntakeActionInput) => Promise<AppSnapshot>;
  appendIntakeTask: (input: IntakeActionInput) => Promise<AppSnapshot>;
  createScript: (input: CreateScriptInput) => Promise<AppSnapshot>;
  updateScript: (input: UpdateScriptInput) => Promise<AppSnapshot>;
  deleteScript: (input: ScriptIdInput) => Promise<AppSnapshot>;
  toggleScript: (input: ScriptIdInput) => Promise<AppSnapshot>;
  runScript: (input: ScriptIdInput) => Promise<ScriptRunResult>;
  stopScript: (input: ScriptIdInput) => Promise<AppSnapshot>;
  pickScriptFile: (input?: { runtime?: ScriptRuntime }) => Promise<string | null>;
  getDroppedFilePath: (file: File) => string;
  toFileUrl: (filePath: string) => string;
  onLoopUpdate: (handler: (snapshot: AppSnapshot) => void) => () => void;
  pickDirectory: () => Promise<string | null>;
  openProjectFolder: (input: ProjectIdInput) => Promise<{ ok: boolean; error: string | null }>;
}
declare global {
  interface Window {
    autoplan: AutoplanApi;
  }
}
