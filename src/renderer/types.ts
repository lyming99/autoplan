export type IntakeType = 'requirement' | 'feedback';
export type WorkspaceTab = 'overview' | 'requirement' | 'feedback' | 'tasks' | 'events' | 'settings';
export type AgentCliProvider = 'codex' | 'claude' | string;
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | string;

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

export interface WorkspaceSearchResult {
  id: string;
  source: WorkspaceSearchSourceType;
  targetTab: WorkspaceTab;
  recordId: number;
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
  plan_status?: string | null;
  plan_completed?: number | null;
  plan_total?: number | null;
  created_at: string;
  updated_at: string;
}

export interface Feedback {
  id: number;
  project_id: number;
  requirement_id?: number | null;
  title: string;
  body: string;
  status: string;
  agent_cli_provider?: AgentCliProvider | null;
  agent_cli_command?: string;
  codex_reasoning_effort?: CodexReasoningEffort | null;
  linked_plan_id?: number | null;
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

export interface Plan {
  id: number;
  project_id: number;
  issue_hash: string;
  file_path: string;
  title?: string | null;
  hash: string;
  status: string;
  total_tasks: number;
  completed_tasks: number;
  validation_passed: number;
  agent_cli_provider?: AgentCliProvider | null;
  agent_cli_command?: string;
  codex_reasoning_effort?: CodexReasoningEffort | null;
  concurrency_suggestion: PlanConcurrencySuggestion;
  created_at: string;
  updated_at: string;
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

export interface ReadPlanResult {
  ok: boolean;
  id: number | null;
  project_id: number | null;
  file_path: string;
  markdown: string;
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

export type CodexSessionMode = 'new' | 'resume';

export type CodexSessionState = CodexSessionMode | 'fallback-new' | string;

export interface CodexSessionInfo {
  codexSessionId?: string | null;
  codexSessionShortId?: string | null;
  codexSessionMode?: CodexSessionMode | null;
  codexSessionState?: CodexSessionState | null;
  codexSessionLabel?: string | null;
  codexSessionRequestedId?: string | null;
  codexSessionRequestedShortId?: string | null;
  codexSessionFallback?: boolean | null;
}

export interface PlanTask extends CodexSessionInfo {
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
  codex_session_id: string | null;
  agentCliProvider?: string | null;
  agentCliCommand?: string | null;
  codexReasoningEffort?: CodexReasoningEffort | null;
  updated_at: string;
  /** JOIN plans 得到 */
  file_path: string;
  /** JOIN plans 并读取计划 Markdown 标题得到 */
  plan_title: string;
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

export interface TaskEventMeta extends CodexSessionInfo {
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

export interface AppSnapshot {
  activeProjectId: number | null;
  activeProject: Project | null;
  projects: Project[];
  state: ProjectState | null;
  requirements: Requirement[];
  feedback: Feedback[];
  attachments: Attachment[];
  plans: Plan[];
  tasks: PlanTask[];
  events: AppEvent<AppEventMeta | null>[];
  scans: ScanFile[];
  activeOperation: ActiveOperation | null;
  activeOperations: ActiveOperation[];
  lastOperation: ActiveOperation | null;
}

export interface ActivityLine {
  role: string;
  text: string;
  at: string;
}

export interface ActiveOperation extends CodexSessionInfo {
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

export interface UpdateProjectInput extends CreateProjectInput {
  id: number;
}

export interface LoopConfigInput {
  projectId: number;
  workspacePath?: string;
  intervalSeconds?: number;
  validationCommand?: string;
  agentCliProvider?: AgentCliProvider;
  agentCliCommand?: string;
  codexReasoningEffort?: CodexReasoningEffort;
}

export interface ProjectIdInput {
  projectId: number;
  manual?: boolean;
}

export interface RecordIdInput extends ProjectIdInput {
  id: number;
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
  snapshot: (projectId?: number | null) => Promise<AppSnapshot>;
  createProject: (input: CreateProjectInput) => Promise<AppSnapshot>;
  updateProject: (input: UpdateProjectInput) => Promise<AppSnapshot>;
  deleteProject: (input: ProjectIdInput) => Promise<AppSnapshot>;
  configureLoop: (config: LoopConfigInput) => Promise<AppSnapshot>;
  startLoop: (input: ProjectIdInput) => Promise<AppSnapshot>;
  stopLoop: (input: ProjectIdInput) => Promise<AppSnapshot>;
  runOnce: (input: ProjectIdInput) => Promise<AppSnapshot>;
  readPlan: (input: ReadPlanInput) => Promise<ReadPlanResult>;
  runTask: (input: TaskIdInput) => Promise<AppSnapshot>;
  stopTask: (input: TaskIdInput) => Promise<AppSnapshot>;
  createRequirement: (input: CreateIntakeInput) => Promise<AppSnapshot>;
  updateRequirement: (input: UpdateRequirementInput) => Promise<AppSnapshot>;
  deleteRequirement: (input: RecordIdInput) => Promise<AppSnapshot>;
  createFeedback: (input: CreateIntakeInput) => Promise<AppSnapshot>;
  updateFeedback: (input: UpdateFeedbackInput) => Promise<AppSnapshot>;
  deleteFeedback: (input: RecordIdInput) => Promise<AppSnapshot>;
  interruptIntake: (input: IntakeActionInput) => Promise<AppSnapshot>;
  resumeIntake: (input: IntakeActionInput) => Promise<AppSnapshot>;
  appendIntakeTask: (input: IntakeActionInput) => Promise<AppSnapshot>;
  getDroppedFilePath: (file: File) => string;
  toFileUrl: (filePath: string) => string;
  onLoopUpdate: (handler: (snapshot: AppSnapshot) => void) => () => void;
}

declare global {
  interface Window {
    autoplan: AutoplanApi;
  }
}
