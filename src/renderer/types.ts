export type IntakeType = 'requirement' | 'feedback';
export type WorkspaceTab = 'overview' | 'requirement' | 'feedback' | 'acceptance' | 'tasks' | 'terminal' | 'executors' | 'scripts' | 'events' | 'settings' | 'chat';
export const DEFAULT_WORKSPACE_TAB: WorkspaceTab = 'requirement';
export type AgentCliProvider = 'codex' | 'claude' | 'opencode' | 'oh-my-pi' | string;
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | string;

export const PLAN_GENERATION_STRATEGIES = {
  EXTERNAL_CLI_MARKDOWN: 'external-cli-markdown',
  EXTERNAL_CLI_STRUCTURED: 'external-cli-structured',
  BUILTIN_LLM_STRUCTURED: 'builtin-llm-structured',
} as const;

export const PLAN_EXECUTION_STRATEGIES = {
  EXTERNAL_CLI: 'external-cli',
  BUILTIN_LLM: 'builtin-llm',
} as const;

export type PlanGenerationStrategy =
  (typeof PLAN_GENERATION_STRATEGIES)[keyof typeof PLAN_GENERATION_STRATEGIES];
export type PlanExecutionStrategy =
  (typeof PLAN_EXECUTION_STRATEGIES)[keyof typeof PLAN_EXECUTION_STRATEGIES];
export type PlanBackendProvider = AgentCliProvider | 'openai' | 'deepseek' | 'anthropic' | string;

export interface PlanGenerationSnapshotFields {
  plan_generation_strategy?: PlanGenerationStrategy | null;
  plan_generation_provider?: PlanBackendProvider | null;
  plan_generation_command?: string | null;
  plan_generation_model?: string | null;
  plan_generation_codex_reasoning_effort?: CodexReasoningEffort | null;
}

export interface PlanExecutionSnapshotFields {
  plan_execution_strategy?: PlanExecutionStrategy | null;
  plan_execution_provider?: PlanBackendProvider | null;
  plan_execution_command?: string | null;
  plan_execution_model?: string | null;
  plan_execution_codex_reasoning_effort?: CodexReasoningEffort | null;
}

export interface PlanGenerationInputFields {
  planGenerationStrategy?: PlanGenerationStrategy | null;
  planGenerationProvider?: PlanBackendProvider | null;
  planGenerationCommand?: string | null;
  planGenerationModel?: string | null;
  planGenerationCodexReasoningEffort?: CodexReasoningEffort | null;
}

export interface PlanExecutionInputFields {
  planExecutionStrategy?: PlanExecutionStrategy | null;
  planExecutionProvider?: PlanBackendProvider | null;
  planExecutionCommand?: string | null;
  planExecutionModel?: string | null;
  planExecutionCodexReasoningEffort?: CodexReasoningEffort | null;
}

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

export interface AgentCliOption { value: AgentCliProvider; label: string; }

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

export interface WorkspaceSearchSourceConfig { type: WorkspaceSearchSourceType; label: string; targetTab: WorkspaceTab; }

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

export interface Project extends PlanGenerationSnapshotFields, PlanExecutionSnapshotFields {
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

export interface ProjectState extends PlanGenerationSnapshotFields, PlanExecutionSnapshotFields {
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

export interface IntakeGenerateFailureState {
  generate_fail_count?: number;
  last_generate_fail_at?: string | null;
  last_generate_error?: string | null;
  last_generate_log_file?: string | null;
  last_generate_agent_cli_provider?: AgentCliProvider | null;
  last_generate_codex_reasoning_effort?: CodexReasoningEffort | null;
}

export interface LinkedPlanSummary {
  link_id?: number | null;
  linkId?: number | null;
  intake_type?: IntakeType | string | null;
  intake_id?: number | null;
  plan_id?: number | string | null;
  planId?: number | string | null;
  id?: number | string | null;
  phase_index?: number | null;
  phaseIndex?: number | null;
  phase_title?: string | null;
  phaseTitle?: string | null;
  title?: string | null;
  file_path?: string | null;
  filePath?: string | null;
  status?: PlanStatus | string | null;
  completed_tasks?: number | string | null;
  completedTasks?: number | string | null;
  completed?: number | string | null;
  total_tasks?: number | string | null;
  totalTasks?: number | string | null;
  total?: number | string | null;
  validation_passed?: number | boolean | null;
  validationPassed?: number | boolean | null;
  is_current?: boolean;
  current?: boolean;
}

export interface IntakeLinkedPlanSnapshotFields {
  linked_plans?: LinkedPlanSummary[];
  linked_plan_title?: string | null;
  linked_plan_file_path?: string | null;
  linked_plan_status?: string | null;
  linked_plan_completed_tasks?: number | null;
  linked_plan_total_tasks?: number | null;
}

export interface Requirement extends IntakeGenerateFailureState, IntakeLinkedPlanSnapshotFields, PlanGenerationSnapshotFields {
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

export interface Feedback extends AgentCliSessionInfo, IntakeGenerateFailureState, IntakeLinkedPlanSnapshotFields, PlanGenerationSnapshotFields {
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

export interface Plan extends AgentCliSessionInfo, PlanGenerationSnapshotFields, PlanExecutionSnapshotFields {
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

export interface PlanConcurrencyBatch { batch: number; reason: string; tasks: PlanConcurrencyTask[]; }

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

export interface PlanTaskAssociationTaskRef { plan_id?: number | null; file_path?: string | null; }

export interface PlanTaskAssociationPlanRef { id: number; file_path?: string | null; }

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

export interface TaskEventSemantics { status: TaskEventStatus; label: string; }

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

export interface ScanSummary {
  count: number;
  total_size: number;
  latest_scanned_at: string | null;
  latest_modified_at: string | null;
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

export interface ScriptIdInput { projectId: number; scriptId: number; }

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

export type ExecutorType = 'shell' | 'process' | 'plugin';
export type ExecutorDependsOrder = 'parallel' | 'sequence';
export type ExecutorLastStatus = 'idle' | 'ok' | 'bad' | 'running' | 'stopped';
export type ExecutorArg = string | { value: string; quoting?: 'escape' | 'strong' | 'weak' };
export type ExecutorProblemMatcher = string | string[] | Record<string, unknown> | Record<string, unknown>[] | null;

/**
 * Plugin 执行器（需求 #64）
 *
 * 与 shell/process 的「一次性命令」不同，plugin 表示一个长期运行的开发工具进程
 * （如 flutter run / npm run dev / vite），支持 start → running → stop 三态生命周期，
 * 并可在运行中通过 reload action 触发热刷新（向 stdin 发送文本或执行独立命令）。
 */

/** 单个 action 的执行方式：'command' 执行独立命令；'input' 向运行中进程 stdin 发送文本 */
export type ExecutorActionType = 'command' | 'input';

/** plugin 三态生命周期动作名 */
export type ExecutorPluginActionName = 'start' | 'reload' | 'stop';

/** plugin 执行器某个生命周期动作的命令定义，复用 ExecutorArg 形态 */
export interface ExecutorAction {
  /** 执行方式，缺省按 'command' 处理；reload 在 'input' 模式下发送 stdin 文本 */
  type?: ExecutorActionType;
  /** 命令名（如 'flutter'、'npm'）；command 模式下必填 */
  command?: string;
  /** 命令参数，复用 ExecutorArg 形态 */
  args?: ExecutorArg[];
  /** input 模式下发送给运行中进程 stdin 的文本（如 'r' 触发 Flutter 热刷新） */
  input?: string;
}

/**
 * plugin 执行器的动作配置块。
 * - start：启动命令（必填），定义长驻进程的启动命令
 * - reload：热刷新（可选），向运行中进程发送 stdin 输入或执行独立命令
 * - stop：停止命令（可选），留空时使用默认信号（SIGTERM）终止
 */
export interface ExecutorActions {
  start?: ExecutorAction;
  reload?: ExecutorAction;
  stop?: ExecutorAction;
}

/** plugin 执行器运行时状态（持久化于 plugin_state_json，进程退出后 pid 置空） */
export interface ExecutorPluginState {
  /** 持久子进程 PID，进程未启动/已退出时为 null */
  pid: number | null;
  /** 是否运行中 */
  running: boolean;
  /** 最近一次执行的 action */
  lastAction?: ExecutorPluginActionName | null;
  /** 最近一次 action 时间（ISO 字符串） */
  lastActionAt?: string | null;
  /** 最近一次启动时间（ISO 字符串） */
  startedAt?: string | null;
  /** 最近一次退出码 */
  exitCode?: number | null;
  /** 最近一次错误信息 */
  error?: string | null;
}

export interface ExecutorOptions { cwd: string; env: Record<string, string>; timeoutMs?: number; timeout_ms?: number; }
export interface ExecutorGroup { kind: string | null; isDefault: boolean; }
export interface ExecutorPresentation {
  reveal?: 'always' | 'silent' | 'never';
  panel?: 'shared' | 'dedicated' | 'new';
  revealProblems?: 'never' | 'onProblem' | 'always';
  echo?: boolean;
  focus?: boolean;
  showReuseMessage?: boolean;
  clear?: boolean;
  close?: boolean;
}

export interface Executor {
  id: number;
  projectId: number;
  project_id?: number;
  label: string;
  type: ExecutorType;
  command: string;
  args: ExecutorArg[];
  options: ExecutorOptions;
  group: ExecutorGroup;
  group_kind?: string | null;
  group_is_default?: number;
  presentation: ExecutorPresentation;
  problemMatcher: ExecutorProblemMatcher;
  /** plugin 执行器的动作配置（start/reload/stop）；仅 type === 'plugin' 时使用 */
  actions?: ExecutorActions;
  /** plugin 执行器运行时状态（pid/running/lastAction 等）；仅 type === 'plugin' 时使用 */
  pluginState?: ExecutorPluginState;
  dependsOn: string[];
  dependsOrder: ExecutorDependsOrder;
  depends_order?: ExecutorDependsOrder;
  enabled: boolean;
  sortOrder: number;
  sort_order?: number;
  lastStatus: ExecutorLastStatus | null;
  last_status?: ExecutorLastStatus | null;
  lastExitCode: number | null;
  last_exit_code?: number | null;
  lastDurationMs: number | null;
  last_duration_ms?: number | null;
  lastLog: string | null;
  last_log?: string | null;
  lastRunAt: string | null;
  last_run_at?: string | null;
  createdAt: string | null;
  created_at?: string | null;
  updatedAt: string | null;
  updated_at?: string | null;
  running: boolean;
  runStatus: ExecutorLastStatus;
  activeOperation?: ActiveOperation | null;
}

export interface ExecutorInput {
  projectId: number;
  label: string;
  type?: ExecutorType;
  command: string;
  args?: ExecutorArg[];
  options?: Partial<ExecutorOptions>;
  group?: string | Partial<ExecutorGroup> | null;
  dependsOn?: string | string[];
  dependsOrder?: ExecutorDependsOrder;
  presentation?: ExecutorPresentation;
  problemMatcher?: ExecutorProblemMatcher;
  /** plugin 执行器的动作配置；type === 'plugin' 时构造，其余类型忽略 */
  actions?: ExecutorActions;
  enabled?: boolean | number;
  sortOrder?: number;
}

export interface UpdateExecutorInput extends Partial<ExecutorInput> {
  projectId: number;
  executorId: number;
}

export interface ExecutorIdInput { projectId: number; executorId: number; }

/** 触发 plugin 执行器生命周期动作（start/reload/stop）的入参 */
export interface RunExecutorPluginActionInput {
  projectId: number;
  executorId: number;
  action: ExecutorPluginActionName;
}

export interface ExecutorDependencyRunResult {
  executorId: number | null;
  label: string | null;
  status: ExecutorLastStatus | string;
  exitCode: number | null;
  durationMs: number | null;
  errorMessage?: string;
}

export interface ExecutorRunResult {
  snapshot: AppSnapshot;
  executorId: number;
  label: string;
  status: ExecutorLastStatus | string;
  exitCode: number | null;
  durationMs: number | null;
  log: string | null;
  logFile?: string | null;
  timedOut?: boolean;
  error?: string | null;
  dependencyResults?: ExecutorDependencyRunResult[];
}

export interface ExecutorImportTasksJsonInput {
  projectId: number;
  content?: string;
  tasksJson?: string;
  json?: string;
  filePath?: string;
  path?: string;
  version?: string;
  tasks?: Record<string, unknown>[];
}

export interface ExecutorImportMessage {
  index: number | null;
  label: string | null;
  code: string;
  field?: string | null;
  message: string;
  fields?: string[];
  details?: Record<string, unknown>;
}

export interface ExecutorImportTasksJsonResult {
  version: string | null;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  executors: Executor[];
  skipped: ExecutorImportMessage[];
  errors: ExecutorImportMessage[];
  snapshot: AppSnapshot;
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
  scanSummary?: ScanSummary;
  scripts: Script[];
  executors: Executor[];
  terminals: TerminalSession[];
  activeOperation: ActiveOperation | null;
  activeOperations: ActiveOperation[];
  lastOperation: ActiveOperation | null;
}

export interface WorkspaceSnapshotPatch {
  projectId: number | null;
  activeProjectId?: number | null;
  state?: ProjectState | null;
  tasks?: PlanTask[];
  events?: AppEvent<AppEventMeta | null>[];
  activeOperation?: ActiveOperation | null;
  activeOperations?: ActiveOperation[];
  lastOperation?: ActiveOperation | null;
}

export interface ActivityLine { role: string; text: string; at: string; }

export interface ActiveOperation extends AgentCliSessionInfo, CodexSessionInfo {
  label: string;
  projectId: number | null;
  planId: number | null;
  taskId: number | null;
  operationType?: 'executor' | string | null;
  executorId?: number | null;
  executorLabel?: string | null;
  rootExecutorId?: number | null;
  rootExecutorLabel?: string | null;
  parentExecutorId?: number | null;
  executorRunId?: string | null;
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

export interface CreateIntakeInput extends PlanGenerationInputFields {
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

export interface CreateProjectInput extends PlanGenerationInputFields, PlanExecutionInputFields {
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

export interface McpAgentCliInput { agentCliProvider?: McpAgentCliProvider; agentCliCommand?: string; codexReasoningEffort?: McpCodexReasoningEffort; }

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
export interface EnvVarEntry { name: string; value: string; }

export interface LoopConfigInput extends PlanGenerationInputFields, PlanExecutionInputFields {
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

export interface ProjectIdInput { projectId: number; manual?: boolean; }

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

export interface PlanIdInput extends ProjectIdInput {
  planId: number;
}

export interface ReadPlanInput extends PlanIdInput {}

export interface IntakeActionInput extends ProjectIdInput {
  type: IntakeType;
  id: number;
  title?: string;
}

export interface RetryIntakePlanGenerationOptions extends PlanGenerationInputFields {
  agentCliProvider?: AgentCliProvider;
  agentCliCommand?: string;
  codexReasoningEffort?: CodexReasoningEffort | null;
}

export interface RetryIntakePlanGenerationInput extends IntakeActionInput, RetryIntakePlanGenerationOptions {}

export interface UpdateRequirementInput extends RecordIdInput, PlanGenerationInputFields {
  title?: string;
  body?: string;
  status?: string;
  attachments?: PendingAttachment[];
  agentCliProvider?: AgentCliProvider;
  agentCliCommand?: string;
  codexReasoningEffort?: CodexReasoningEffort;
}

export interface UpdateFeedbackInput extends UpdateRequirementInput { requirementId?: number | null; }

/** 正式版本更新检查的 GitHub Releases 来源（仅正式版，不含 beta） */
export const AUTOPLAN_RELEASES_URL = 'https://github.com/lyming99/autoplan/releases';

/** 最新正式版 Release 解析结果（主进程 updateChecker.parseLatestRelease 产物） */
export interface UpdateLatestRelease {
  version: string;
  name: string;
  htmlUrl: string;
  publishedAt: string;
  body: string;
  summary: string;
  isPrerelease: boolean;
  isDraft: boolean;
  isStable: boolean;
}

/** 更新检查状态快照（主进程 updateChecker.status() 产物） */
export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string;
  latestName: string;
  htmlUrl: string;
  publishedAt: string;
  lastCheckedAt: string;
  dismissedVersion: string;
  hasUpdate: boolean;
  stableUpdate: boolean;
  autoCheck: boolean;
  intervalMinutes: number;
}

/** updates:check 结果：在 UpdateStatus 基础上附带本次抓取的 ok/error/release */
export interface UpdateCheckResult extends UpdateStatus {
  ok: boolean;
  error: string | null;
  release: UpdateLatestRelease | null;
}

/** Chat 对话模块（需求 #26）*/

/** AI 配置（需求 #28）*/
export interface AiConfig {
  id: number;
  projectId: number | null;
  name: string;
  provider: 'openai' | 'deepseek' | 'anthropic' | string;
  baseUrl: string;
  hasApiKey: boolean;
  maskedKey: string;
  model: string;
  temperature: string;
  thinkingDepth: 'low' | 'medium' | 'high' | null;
  thinkingBudgetTokens: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 对话（需求 #28）*/
export interface Conversation {
  id: number;
  project_id: number;
  projectId: number;
  title: string;
  ai_config_id: number | null;
  aiConfigId: number | null;
  pinned_at: string | null;
  pinnedAt: string | null;
  pinned: boolean;
  created_at: string;
  createdAt: string;
  updated_at: string;
  updatedAt: string;
}

/** Chat 对话配置（扩展：需求 #28 增加思考深度字段） */
export interface ChatConfig {
  source?: string;
  compatibilityOnly?: boolean;
  aiConfigId?: number | null;
  name?: string;
  provider: 'openai' | 'deepseek' | 'anthropic' | string;
  baseUrl: string;
  hasApiKey: boolean;
  maskedKey: string;
  model: string;
  temperature: string;
  thinkingDepth?: string | null;
  thinkingBudgetTokens?: number | null;
}

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ChatMessage {
  id: number;
  project_id?: number;
  projectId: number;
  role: ChatRole;
  content: string;
  tool_calls?: string | null;
  toolCalls: ChatToolCall[] | null;
  tool_result?: string | null;
  toolResult: Record<string, unknown> | null;
  status: 'streaming' | 'done' | 'aborted' | 'error' | 'queued';
  created_at?: string;
  createdAt: string;
}

export interface ChatToolCall { name: string; args: Record<string, unknown>; }

export interface ChatToolErrorResult {
  error?: string;
  errorCode?: string;
  [key: string]: unknown;
}

export interface ChatPlanToolResult extends ChatToolErrorResult {
  type: 'plan';
  id: number | null;
  title: string;
  status: string;
  totalTasks: number;
  filePath: string;
  projectId?: number | null;
  openable?: boolean;
}

export type ChatKnownToolResult = ChatPlanToolResult | ChatToolErrorResult | Record<string, unknown>;

export type ChatStreamPhase = 'idle' | 'thinking' | 'replying';

/**
 * 对话中「打开需求/反馈」的可打开引用。
 * 工具结果富化（create 与 open 系列工具的 type/projectId/id）与「打开需求 #N」意图直达共用此契约。
 */
export type ChatIntakeOpenRef = {
  type: IntakeType;
  projectId: number;
  id: number;
};

/** 打开需求/反馈回调：由工作区（WorkspacePage）提供，对话侧触发切 tab + 锚点定位/高亮。 */
export type OpenIntakeHandler = (ref: ChatIntakeOpenRef) => void;

export interface WorkspaceChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  streamingToolCall: ChatToolCall | null;
  config: ChatConfig;
  sendMessage: (message: string) => Promise<void>;
  stopGeneration: () => Promise<void>;
  clearSession: () => Promise<void>;
  loadHistory: (conversationId: number) => Promise<void>;
  conversations: Conversation[];
  aiConfigs: AiConfig[];
  activeConversationId: number | null;
  switchConversation: (conversationId: number) => Promise<void>;
  createConversation: () => Promise<void>;
  deleteConversation: (conversationId: number) => Promise<void>;
  renameConversation: (conversationId: number, title: string) => Promise<void>;
  getAiConfigName: (configId: number | null) => string;
  formatRelativeTime: (iso: string) => string;
  isThinking: boolean;
  thinkingContent: string;
  streamPhase: ChatStreamPhase;
  /** 队列发送（需求 #37）：排队快照/计数与管理动作（useChatQueue 提供，接入前可选） */
  queue?: ChatQueueItem[];
  queueCount?: number;
  cancelQueueItem?: (id: number) => Promise<void>;
  editQueueItem?: (id: number, text: string) => Promise<void>;
  clearQueue?: () => Promise<void>;
}

export type ChatChunkEvent =
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; content: string }
  | { type: 'thinking_end' }
  | { type: 'text_delta'; content: string }
  | { type: 'tool_start'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: ChatKnownToolResult }
  | { type: 'error'; message: string }
  | { type: 'status'; status: string };

export type ChatDoneStatus = 'done' | 'aborted' | 'error' | 'max_rounds';

export interface ChatDoneEvent {
  status: ChatDoneStatus;
  error?: string;
  conversationId?: number;
  title?: string;
}

export interface AiConfigChangedEvent { source: string; configId: number | null; configs: AiConfig[]; }

export interface ChatSendPayload { projectId: number; conversationId?: number; message: string; }

export interface ChatClearPayload { projectId: number; conversationId: number; }

export interface ChatStopPayload { projectId: number; conversationId: number; }

export interface ChatHistoryPayload { projectId: number; conversationId: number; }

/** 队列发送（需求 #37）：AI 回复中可继续输入，新消息入队按序处理 */
export type ChatQueueItemState = 'queued' | 'processing';
export interface ChatQueueItem { id: number; content: string; state: ChatQueueItemState; }
export interface ChatQueueSnapshot { conversationId: number; items: ChatQueueItem[]; count: number; }
export interface ChatQueuePayload { projectId: number; conversationId: number; id?: number; message?: string; }

export interface ChatSaveConfigInput {
  name?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: string;
  thinkingDepth?: 'low' | 'medium' | 'high' | null;
  thinkingBudgetTokens?: number | null;
}

/** AI 配置 CRUD 载荷（需求 #28）*/
export type AiConfigListInput = void;

export interface AiConfigCreateInput {
  name: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: string;
  thinkingDepth?: 'low' | 'medium' | 'high' | null;
  thinkingBudgetTokens?: number | null;
}

export interface AiConfigUpdateInput {
  configId: number;
  name?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: string;
  thinkingDepth?: 'low' | 'medium' | 'high' | null;
  thinkingBudgetTokens?: number | null;
}

export interface AiConfigDeleteInput { configId: number; }

export interface AiConfigGetInput { configId: number; }

/** 对话 CRUD 载荷（需求 #28）*/
export interface ConversationCreateInput { projectId: number; title?: string; aiConfigId?: number | null; }

export interface ConversationUpdateInput {
  projectId: number;
  conversationId: number;
  title?: string;
  aiConfigId?: number | null;
  pinned?: boolean;
  pinnedAt?: string | null;
}

export interface ConversationDeleteInput { projectId: number; conversationId: number; }

export interface ConversationListInput { projectId: number; }

/** 文件访问范围（需求 #35）*/

/** 文件读取入口（read_file / search_files / 打开文件 / 读取计划）可访问的范围 */
export type FileAccessScope = 'project' | 'workspace' | 'custom' | 'all';

/** 文件访问设置快照：file-access:get 返回 / file-access:save 入参的公共形态 */
export interface FileAccessSettings { scope: FileAccessScope; allowCrossProject: boolean; allowedRoots: string[]; }

/** file-access:save 入参（字段均可选，未提供字段沿用既有持久化值） */
export interface FileAccessSaveInput { scope?: FileAccessScope; allowCrossProject?: boolean; allowedRoots?: string[]; }

/** file-access:save 返回：warned 表示已保存为 all 范围（高风险） */
export interface FileAccessSaveResult { saved: boolean; warned?: boolean; }

/** 终端模块（需求 #55）：仅描述 renderer 可见的可序列化对象，不包含 PTY/进程句柄 */
export type TerminalStatus = 'starting' | 'running' | 'exited' | 'killed' | 'error' | string;
export type TerminalProfileKind = 'default' | 'custom' | string;
export type TerminalEnvInput = Record<string, string | number | boolean | null | undefined>;
export interface TerminalProfile { id: string; name: string; kind: TerminalProfileKind; shellPath: string; args: string[]; env: Record<string, string>; }
export interface TerminalSession { id: string; projectId: number | string; title: string; cwd: string; shell: string; status: TerminalStatus; createdAt: string; endedAt: string | null; exitCode: number | null; cols: number | null; rows: number | null; profile: TerminalProfile; }
export interface TerminalProfileInput { id?: string; profileId?: string; name?: string; label?: string; kind?: TerminalProfileKind; shellPath?: string; shell?: string; path?: string; args?: string[]; env?: TerminalEnvInput; }
export interface TerminalCreateInput { projectId: number; cwd?: string; profileId?: string; profile?: string | TerminalProfileInput; title?: string; cols?: number; rows?: number; env?: TerminalEnvInput; }
export interface TerminalSessionIdInput { sessionId: string; }
export interface TerminalWriteInput extends TerminalSessionIdInput { data: string; }
export interface TerminalResizeInput extends TerminalSessionIdInput { cols: number; rows: number; }
export interface TerminalRenameInput extends TerminalSessionIdInput { title: string; }
export interface TerminalErrorResult { ok: false; code: string; message: string; details?: string; }
export type TerminalSessionResult = { ok: true; session: TerminalSession } | TerminalErrorResult;
export type TerminalListResult = { ok: true; sessions: TerminalSession[] } | TerminalErrorResult;
export type TerminalReplayResult = { ok: true; session: TerminalSession; chunks: string[]; data: string } | TerminalErrorResult;
export interface TerminalEvent {
  sessionId: string;
  projectId: number | string;
  session: TerminalSession;
  data?: string;
  exitCode?: number | null;
  signal?: string | null;
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
  stopPlan: (input: PlanIdInput) => Promise<AppSnapshot>;
  deletePlan: (input: PlanIdInput) => Promise<AppSnapshot>;
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
  retryIntakePlanGeneration: (input: RetryIntakePlanGenerationInput) => Promise<AppSnapshot>;
  createScript: (input: CreateScriptInput) => Promise<AppSnapshot>;
  updateScript: (input: UpdateScriptInput) => Promise<AppSnapshot>;
  deleteScript: (input: ScriptIdInput) => Promise<AppSnapshot>;
  toggleScript: (input: ScriptIdInput) => Promise<AppSnapshot>;
  runScript: (input: ScriptIdInput) => Promise<ScriptRunResult>;
  stopScript: (input: ScriptIdInput) => Promise<AppSnapshot>;
  pickScriptFile: (input?: { runtime?: ScriptRuntime }) => Promise<string | null>;
  pickTasksJson: () => Promise<string | null>;
  createExecutor: (input: ExecutorInput) => Promise<AppSnapshot>;
  updateExecutor: (input: UpdateExecutorInput) => Promise<AppSnapshot>;
  deleteExecutor: (input: ExecutorIdInput) => Promise<AppSnapshot>;
  toggleExecutor: (input: ExecutorIdInput) => Promise<AppSnapshot>;
  runExecutor: (input: ExecutorIdInput) => Promise<ExecutorRunResult>;
  stopExecutor: (input: ExecutorIdInput) => Promise<AppSnapshot>;
  /** 触发 plugin 执行器生命周期动作（start/reload/stop） */
  runExecutorAction: (input: RunExecutorPluginActionInput) => Promise<ExecutorRunResult>;
  importTasksJson: (input: ExecutorImportTasksJsonInput) => Promise<ExecutorImportTasksJsonResult>;
  createTerminal: (input: TerminalCreateInput) => Promise<TerminalSessionResult>;
  listTerminals: (input: ProjectIdInput) => Promise<TerminalListResult>;
  writeTerminal: (input: TerminalWriteInput) => Promise<TerminalSessionResult>;
  resizeTerminal: (input: TerminalResizeInput) => Promise<TerminalSessionResult>;
  killTerminal: (input: TerminalSessionIdInput) => Promise<TerminalSessionResult>;
  closeTerminal: (input: TerminalSessionIdInput) => Promise<TerminalSessionResult>;
  renameTerminal: (input: TerminalRenameInput) => Promise<TerminalSessionResult>;
  replayTerminal: (input: TerminalSessionIdInput) => Promise<TerminalReplayResult>;
  clearTerminal: (input: TerminalSessionIdInput) => Promise<TerminalSessionResult>;
  getDroppedFilePath: (file: File) => string;
  toFileUrl: (filePath: string) => string;
  onLoopUpdate: (handler: (snapshot: AppSnapshot) => void) => () => void;
  onLoopPatch: (handler: (patch: WorkspaceSnapshotPatch) => void) => () => void;
  pickDirectory: () => Promise<string | null>;
  openProjectFolder: (input: ProjectIdInput) => Promise<{ ok: boolean; error: string | null }>;
  updateStatus: () => Promise<UpdateStatus>;
  checkForUpdates: () => Promise<UpdateCheckResult>;
  dismissUpdate: (version?: string | { version?: string } | null) => Promise<UpdateStatus>;
  setAutoUpdateCheck: (enabled: boolean) => Promise<UpdateStatus>;
  onUpdateStatus: (handler: (status: UpdateStatus) => void) => () => void;
  openExternal: (url: string) => Promise<{ ok: boolean; error: string | null }>;
  onTerminalData: (handler: (event: TerminalEvent & { data: string }) => void) => () => void;
  onTerminalExit: (handler: (event: TerminalEvent) => void) => () => void;
  onTerminalStatus: (handler: (event: TerminalEvent) => void) => () => void;
  // Chat 对话模块（需求 #26 / #28）
  chatSend: (payload: ChatSendPayload) => Promise<{ accepted: boolean; conversationId?: number; error?: string }>;
  chatStop: (payload: ChatStopPayload) => Promise<{ stopped: boolean; error?: string }>;
  chatClear: (payload: ChatClearPayload) => Promise<{ cleared: boolean; error?: string }>;
  chatHistory: (payload: ChatHistoryPayload) => Promise<ChatMessage[]>;
  chatSaveConfig: (config: ChatSaveConfigInput) => Promise<{ saved: boolean }>;
  chatGetConfig: () => Promise<ChatConfig>;
  onChatChunk: (handler: (event: { type: string; data: Record<string, unknown> }) => void) => () => void;
  onChatDone: (handler: (event: ChatDoneEvent) => void) => () => void;
  /** 队列发送（需求 #37） */
  chatQueueList: (payload: ChatQueuePayload) => Promise<ChatQueueItem[]>;
  chatQueueCancel: (payload: ChatQueuePayload) => Promise<{ ok: boolean }>;
  chatQueueEdit: (payload: ChatQueuePayload) => Promise<{ ok: boolean }>;
  chatQueueClear: (payload: ChatQueuePayload) => Promise<{ ok: boolean }>;
  onChatQueue: (handler: (event: ChatQueueSnapshot) => void) => () => void;
  // AI 配置（需求 #28）
  aiConfigList: () => Promise<AiConfig[]>;
  aiConfigCreate: (payload: AiConfigCreateInput) => Promise<AiConfig>;
  aiConfigUpdate: (payload: AiConfigUpdateInput) => Promise<AiConfig>;
  aiConfigDelete: (payload: AiConfigDeleteInput) => Promise<{ deleted: boolean }>;
  aiConfigGet: (payload: AiConfigGetInput) => Promise<AiConfig>;
  onAiConfigChanged: (handler: (event: AiConfigChangedEvent) => void) => () => void;
  // 对话管理（需求 #28）
  conversationList: (payload: ConversationListInput) => Promise<Conversation[]>;
  conversationCreate: (payload: ConversationCreateInput) => Promise<Conversation>;
  conversationUpdate: (payload: ConversationUpdateInput) => Promise<Conversation>;
  conversationDelete: (payload: ConversationDeleteInput) => Promise<{ deleted: boolean; id: number }>;
  // 文件访问范围（需求 #35）
  fileAccess: {
    get: () => Promise<FileAccessSettings>;
    save: (config: FileAccessSaveInput) => Promise<FileAccessSaveResult>;
  };
}
declare global {
  interface Window {
    autoplan: AutoplanApi;
  }
}
