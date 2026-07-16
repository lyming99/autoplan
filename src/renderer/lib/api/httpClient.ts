import type {
  AcceptanceItemInput,
  AcceptanceRedoInput,
  AcceptBatchInput,
  AppEvent,
  AppSnapshot,
  AiConfig,
  AiConfigCreateInput,
  AiConfigUpdateInput,
  AiConfigDeleteInput,
  AiConfigGetInput,
  Attachment,
  CreateIntakeInput,
  CreateProjectInput,
  Feedback,
  ClaudeCliConfig,
  ClaudeCliConfigCreateInput,
  ClaudeCliConfigUpdateInput,
  ClaudeCliConfigDeleteInput,
  ClaudeCliConfigGetInput,
  ClaudeCliConfigSetDefaultInput,
  ChatClearPayload,
  ChatConfig,
  ChatDoneEvent,
  ChatHistoryPayload,
  ChatMessage,
  ChatQueueItem,
  ChatQueuePayload,
  ChatSendPayload,
  ChatSaveConfigInput,
  ChatStopPayload,
  ConversationCreateInput,
  ConversationDeleteInput,
  ConversationListInput,
  ConversationUpdateInput,
  Conversation,
  CreateScriptInput,
  FileAccessSaveInput,
  FileAccessSaveResult,
  FileAccessSettings,
  IntakeAcceptanceInput,
  IntakeActionInput,
  IntakeType,
  LoopConfigInput,
  McpConfigInput,
  Plan,
  PlanIdInput,
  PlanTask,
  Project,
  ProjectIdInput,
  ReadPlanInput,
  ReadPlanResult,
  ReorderPlansInput,
  RetryIntakePlanGenerationInput,
  RunTaskBatchesInput,
  RunExecutorPluginActionInput,
  Requirement,
  ExecutorIdInput,
  ExecutorRunResult,
  ProcessOperationAccepted,
  ScriptIdInput,
  ScriptRunResult,
  TaskIdInput,
  UpdateFeedbackInput,
  UpdateProjectInput,
  UpdateRequirementInput,
  UpdateScriptInput,
  TerminalRestCreateInput,
  TerminalRestReplay,
  TerminalRestSession,
} from '../../types';
import {
  AUTOPLAN_CLIENT_OPERATION_KEYS,
  type AutoplanClient,
  type HttpCapability,
  type HttpChatOperations,
  type HttpCapabilityDiscovery,
  type HttpMutationOptions,
  type HttpPlanAutoplanClient,
  type HttpStaticAutoplanClient,
  type HttpStaticExecutor,
  type HttpStaticScript,
  type HttpCursorPage,
  type HttpMessageMetadata,
  type HttpMCPConfig,
  type PlanEventsQueryOptions,
  type PlanQueryOptions,
  type PlanTaskQueryOptions,
  type HttpRequestOptions,
  type IntakePage,
  type IntakePageRequest,
  type IntakePagination,
  type IntakePlanLink,
  type IntakePlanLinkInput,
  type AttachmentDeleteResult,
  type AttachmentUploadResult,
  type ProbeResult,
  type ProjectPage,
  type ProjectPageRequest,
  type ProjectPagination,
  type RuntimeFeatureFlag,
  type RuntimeFeatureFlags,
  type RuntimeOperationAccepted,
  type RuntimeOperationOwner,
  type TerminalConnectionHandlers,
} from './client';
import {
  AUTOPLAN_CLIENT_EVENT_KEYS,
  createResumableChatEventStream,
  createResumableEventStream,
  isTerminalOperationEvent,
  type EventStreamWatermark,
  type EventHandler,
  type ChatSSEEventEnvelope,
  type ProjectEventDelivery,
  type ProjectEventConnectionUpdate,
  type ResumableEventSubscription,
  type Unsubscribe,
} from './events';
import { TerminalTransport, type GoTerminalControlPlane } from './terminalTransport';
export const AUTOPLAN_SESSION_HEADER = 'X-Autoplan-Session' as const;
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key' as const;
export const AUTOPLAN_HTTP_RUNTIME_CONFIG_KEY = '__AUTOPLAN_HTTP_RUNTIME__' as const;
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
export const MAXIMUM_HTTP_TIMEOUT_MS = 120_000;
export const PROJECT_SSE_PATH = '/api/v1/projects' as const;
export const OPERATION_SSE_PATH = '/api/v1/operations' as const;
const JSON_CONTENT_TYPE = 'application/json';
const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream';
const MAXIMUM_EVENT_WATERMARKS = 128;
const MAXIMUM_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_REQUEST_BYTES = 16 * 1024 * 1024;
const MAXIMUM_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAXIMUM_ATTACHMENT_TOTAL_BYTES = 100 * 1024 * 1024;
const MAXIMUM_ATTACHMENT_COUNT = 20;
const MAXIMUM_ATTACHMENT_NAME_LENGTH = 120;
const MAXIMUM_PLAN_MARKDOWN_BYTES = 2 * 1024 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const SERVER_ERROR_CODES = new Set([
  'not_found', 'method_not_allowed', 'invalid_json', 'body_too_large', 'unsupported_media_type',
  'invalid_idempotency_key', 'unauthorized', 'origin_forbidden', 'invalid_pagination',
  'invalid_project_id', 'invalid_project', 'invalid_config', 'invalid_intake', 'invalid_attachment',
  'invalid_automation', 'invalid_conversation', 'invalid_cursor',
  'invalid_plan', 'invalid_task', 'invalid_acceptance',
  'project_not_found', 'intake_not_found', 'attachment_not_found', 'automation_not_found', 'conversation_not_found', 'config_not_found', 'plan_not_found', 'task_not_found',
  'version_required', 'version_conflict', 'project_running', 'relation_conflict',
  'precondition_failed', 'idempotency_key_reused', 'request_in_progress', 'duplicate_intake',
  'attachment_recovery_required', 'range_not_satisfiable', 'insufficient_storage', 'repository_busy',
  'repository_schema_drift', 'repository_unavailable',
  'request_timeout', 'invalid_runtime_command', 'operation_state_conflict',
  'chat_runtime_unavailable', 'chat_queue_item_not_found', 'chat_turn_not_found',
  'chat_turn_state_conflict', 'chat_idempotency_conflict',
  'terminal_feature_disabled', 'terminal_platform_blocked', 'terminal_pty_unavailable',
  'terminal_invalid_payload', 'terminal_invalid_session', 'terminal_session_not_found',
  'terminal_project_not_found', 'terminal_forbidden', 'terminal_cwd_outside_workspace',
  'terminal_write_failed', 'terminal_resize_failed', 'terminal_kill_failed',
  'terminal_replay_gap', 'terminal_cursor_too_old', 'terminal_session_limit',
  'terminal_connection_limit', 'terminal_rate_limited', 'terminal_slow_consumer', 'terminal_protocol_error',
  'not_implemented', 'service_unavailable', 'shutting_down', 'internal_error',
]);
const DEFAULT_RUNTIME_FEATURES: RuntimeFeatureFlags = Object.freeze({
  go_loop_actions: false,
  go_plan_actions: false,
  go_task_actions: false,
  go_acceptance_retry_actions: false,
  go_scripts_api: false,
  go_executors_api: false,
  go_chat_api: false,
  go_terminal_api: false,
  go_agent_cli_runtime: false,
});
type FetchImplementation = typeof fetch;
type ForwardedTarget = Record<PropertyKey, unknown>;
export type HttpCredentialMode = 'header' | 'cookie';
export interface HttpAutoplanRuntimeConfig {
  baseUrl: string;
  credentialMode?: HttpCredentialMode;
  sessionCredential?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImplementation;
  idempotencyKeyFactory?: () => string;
  runtimeFeatures?: Partial<Record<RuntimeFeatureFlag, boolean>>;
}
export interface HttpAutoplanClientOptions extends HttpAutoplanRuntimeConfig {
  delegate: AutoplanClient;
}
interface SuccessEnvelope<T> {
  data: T;
  request_id: string;
}
interface ErrorEnvelope {
  code: string;
  message: string;
  request_id: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
interface RequestControl {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
}
interface RequestInitOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  formData?: FormData;
  idempotencyKey?: string;
  retryTransportFailure?: boolean;
}
interface FilePolicyContract {
  scope: FileAccessSettings['scope'];
  allow_cross_project: boolean;
  allowed_roots: string[];
  version: number;
  high_risk: boolean;
}
interface PreparedAttachment {
  name: string;
  blob: Blob;
}
interface IntakeMutationResult {
  snapshot: AppSnapshot;
  cleanup?: Record<string, unknown>;
}
interface PlanMutationResult {
  snapshot: AppSnapshot;
}
interface PlanContentResult {
  plan: Plan;
  tasks: PlanTask[];
  markdown: string;
  errorCode: string;
}
interface PlanMutationContext {
  projectId: number;
  plans: Map<number, Plan>;
  tasks: Map<number, PlanTask>;
}
interface ProcessActionResult {
  operation: RuntimeOperationAccepted;
  snapshot: AppSnapshot;
}
interface ProcessStopResult {
  operation: RuntimeOperationAccepted | null;
  stopped: boolean;
  changed: boolean;
}
export class HttpClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly request_id: string | null;
  constructor(
    code: string,
    status = 0,
    retryable = false,
    requestId: string | null = null,
  ) {
    super(`AutoPlan HTTP request failed (${code})`);
    this.name = 'HttpClientError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.requestId = requestId;
    this.request_id = requestId;
  }
}

/**
 * Older source-only transport fixtures stub the event module. This tiny
 * fallback keeps that boundary loadable; production always receives the full
 * parser/retry implementation exported by events.ts.
 */
function createCompatibilityEventStream(
  options: Parameters<typeof createResumableEventStream>[0],
): ResumableEventSubscription {
  let stopped = false;
  const controller = new AbortController();
  const stop = (() => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    options.onState('closed', 1);
  }) as ResumableEventSubscription;
  stop.completeResync = () => undefined;
  queueMicrotask(async () => {
    if (stopped) return;
    options.onState('connecting', 1);
    try {
      await options.open(null, controller.signal);
      if (!stopped) options.onState('unavailable', 1);
    } catch (error) {
      if (!stopped && !controller.signal.aborted) options.onState('unavailable', 1);
    }
  });
  return stop;
}
export interface HttpAutoplanClient extends HttpStaticAutoplanClient, HttpChatOperations {}
/**
 * Hybrid transport. Project/config, P06 Intake/attachment operations, and
 * capability-enabled P07 persistence operations use the loopback sidecar.
 * P007 runtime action families are selected independently and never fall back
 * after an HTTP mutation has been submitted.
 */
export class HttpAutoplanClient {
  readonly #baseUrl: string;
  readonly #credentialMode: HttpCredentialMode;
  readonly #sessionCredential: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: FetchImplementation;
  readonly #delegate: AutoplanClient;
  readonly #idempotencyKeyFactory: () => string;
  readonly #runtimeFeatures: RuntimeFeatureFlags;
  readonly #idempotencyKeys = new WeakMap<object, string>();
  readonly #attachmentIdempotencyKeys = new WeakMap<object, Map<number, string>>();
  readonly #planMutationContexts = new WeakMap<object, Map<string, PlanMutationContext>>();
  readonly #projectVersions = new Map<number, number>();
  readonly #mutationGenerations = new Map<string, number>();
  readonly #eventConnections = new Set<Unsubscribe>();
  readonly #eventWatermarks = new Map<string, EventStreamWatermark>();
  readonly #operationOwners = new Map<string, RuntimeOperationOwner>();
  readonly #operationStreams = new Map<string, ResumableEventSubscription>();
  readonly #terminals: TerminalTransport;
  #filePolicy: FilePolicyContract | null = null;
  #capabilityDiscovery: Promise<HttpCapabilityDiscovery> | null = null;
  #snapshotController: AbortController | null = null;
  constructor(options: HttpAutoplanClientOptions) {
    if (!options || !options.delegate) throw configurationError();
    this.#baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
    this.#credentialMode = options.credentialMode ?? 'header';
    if (this.#credentialMode !== 'header' && this.#credentialMode !== 'cookie') {
      throw configurationError();
    }
    if (this.#credentialMode === 'header') {
      if (!options.sessionCredential || !SESSION_PATTERN.test(options.sessionCredential)) {
        throw configurationError();
      }
      this.#sessionCredential = options.sessionCredential;
    } else if (options.sessionCredential !== undefined) {
      throw configurationError();
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAXIMUM_HTTP_TIMEOUT_MS) {
      throw configurationError();
    }
    this.#timeoutMs = timeoutMs;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw configurationError();
    // Chromium's Window.fetch is receiver-sensitive. Storing it as a bare
    // function and invoking it later turns every renderer request into an
    // "Illegal invocation" network_error, while test doubles remain plain
    // functions and must retain their own call convention.
    this.#fetch = options.fetchImpl ? fetchImpl : fetchImpl.bind(globalThis);
    this.#delegate = options.delegate;
    this.#idempotencyKeyFactory = options.idempotencyKeyFactory ?? secureIdempotencyKey;
    if (typeof this.#idempotencyKeyFactory !== 'function') throw configurationError();
    this.#runtimeFeatures = normalizeRuntimeFeatures(options.runtimeFeatures);
    const terminalControl: GoTerminalControlPlane = {
      create: (projectId, input) => this.#terminalCreate(projectId, input),
      list: (projectId) => this.#terminalList(projectId),
      write: (projectId, sessionId, data) => this.#terminalWrite(projectId, sessionId, data),
      resize: (projectId, sessionId, cols, rows) => this.#terminalResize(projectId, sessionId, cols, rows),
      kill: (projectId, sessionId) => this.#terminalSessionAction(projectId, sessionId, 'kill'),
      close: (projectId, sessionId) => this.#terminalSessionAction(projectId, sessionId, 'close'),
      rename: (projectId, sessionId, title) => this.#terminalRename(projectId, sessionId, title),
      clear: (projectId, sessionId) => this.#terminalSessionAction(projectId, sessionId, 'clear'),
      replay: (projectId, sessionId, lastSeq) => this.#terminalReplay(projectId, sessionId, lastSeq),
    };
    this.#terminals = new TerminalTransport({
      enabled: this.#runtimeFeatureEnabled('go_terminal_api'),
      legacy: options.delegate,
      control: terminalControl,
      baseUrl: this.#baseUrl,
    });
    installDelegateForwarders(this as unknown as ForwardedTarget, options.delegate);
  }

  getRuntimeFeatureFlags = (): RuntimeFeatureFlags => ({ ...this.#runtimeFeatures });

  getRuntimeOperationOwner = (operationId: string): RuntimeOperationOwner | null => {
    if (!validOperationID(operationId)) return null;
    return this.#operationOwners.get(operationId) ?? null;
  };

  createTerminal = (input: Parameters<AutoplanClient['createTerminal']>[0]) => this.#terminals.create(input);
  listTerminals = (input: Parameters<AutoplanClient['listTerminals']>[0]) => this.#terminals.list(input);
  writeTerminal = (input: Parameters<AutoplanClient['writeTerminal']>[0]) => this.#terminals.write(input);
  resizeTerminal = (input: Parameters<AutoplanClient['resizeTerminal']>[0]) => this.#terminals.resize(input);
  killTerminal = (input: Parameters<AutoplanClient['killTerminal']>[0]) => this.#terminals.kill(input);
  closeTerminal = (input: Parameters<AutoplanClient['closeTerminal']>[0]) => this.#terminals.close(input);
  renameTerminal = (input: Parameters<AutoplanClient['renameTerminal']>[0]) => this.#terminals.rename(input);
  replayTerminal = (input: Parameters<AutoplanClient['replayTerminal']>[0]) => this.#terminals.replay(input);
  clearTerminal = (input: Parameters<AutoplanClient['clearTerminal']>[0]) => this.#terminals.clear(input);
  connectTerminal = (projectId: number, sessionId: string, lastSeq: number, handlers: TerminalConnectionHandlers) =>
    this.#terminals.connect(projectId, sessionId, lastSeq, handlers);
  onTerminalData = (handler: Parameters<AutoplanClient['onTerminalData']>[0]) => this.#delegate.onTerminalData(handler);
  onTerminalExit = (handler: Parameters<AutoplanClient['onTerminalExit']>[0]) => this.#delegate.onTerminalExit(handler);
  onTerminalStatus = (handler: Parameters<AutoplanClient['onTerminalStatus']>[0]) => this.#delegate.onTerminalStatus(handler);
  onTerminalClosed = (handler: Parameters<AutoplanClient['onTerminalClosed']>[0]) => this.#delegate.onTerminalClosed(handler);
  health = (options: HttpRequestOptions = {}): Promise<ProbeResult> =>
    this.#request('/healthz', options.signal, validateProbe);
  ready = (options: HttpRequestOptions = {}): Promise<ProbeResult> =>
    this.#request('/readyz', options.signal, validateProbe);
  listProjects = async (request: ProjectPageRequest = {}): Promise<ProjectPage> => {
    const page = positiveInteger(request.page ?? 1, 'invalid_pagination');
    const pageSize = positiveInteger(request.pageSize ?? 50, 'invalid_pagination');
    if (pageSize > 200) throw new HttpClientError('invalid_pagination');
    const value = await this.#request(
      `/api/v1/projects?page=${page}&page_size=${pageSize}&sort=updated_at_desc`,
      request.signal,
      validateProjectPage,
    );
    return value;
  };

  getProject = (projectId: number, options: HttpRequestOptions = {}): Promise<Project> => {
    const id = positiveInteger(projectId, 'invalid_project_id');
    return this.#request(
      `/api/v1/projects/${id}`,
      options.signal,
      (value) => validateSuccessEnvelope(value, validateProject).data,
    );
  };

  getProjectSnapshot = async (
    projectId: number,
    options: HttpRequestOptions = {},
  ): Promise<AppSnapshot> => {
    const id = positiveInteger(projectId, 'invalid_project_id');
    const response = await this.#request(
      `/api/v1/projects/${id}/snapshot`,
      options.signal,
      (value) => validateSuccessEnvelope(value, validateSnapshot).data,
    );
    const snapshot = this.#normalizeSnapshot(response);
    this.#recordSnapshotVersion(snapshot);
    return snapshot;
  };

  getLoopConfig = async (
    projectId: number,
    options: HttpRequestOptions = {},
  ): Promise<AppSnapshot> => {
    const id = positiveInteger(projectId, 'invalid_project_id');
    const response = await this.#request(
      `/api/v1/projects/${id}/loop-config`,
      options.signal,
      (value) => validateSuccessEnvelope(value, validateSnapshot).data,
    );
    const snapshot = this.#normalizeSnapshot(response);
    requireSnapshotVersion(snapshot, id);
    this.#recordSnapshotVersion(snapshot);
    return snapshot;
  };

  listStaticScripts = async (projectId: number, options: PlanQueryOptions = {}): Promise<HttpStaticScript[]> => {
    const id = positiveInteger(projectId, 'invalid_project_id');
    const limit = positiveInteger(options.limit ?? 50, 'invalid_pagination');
    const offset = nonNegativeInteger(options.offset ?? 0, 'invalid_pagination');
    if (limit > 200) throw new HttpClientError('invalid_pagination');
    return this.#request(`/api/v1/projects/${id}/scripts?limit=${limit}&offset=${offset}`, options.signal,
      (value) => validateSuccessEnvelope(value, validateStaticScripts).data);
  };

  getStaticScript = (projectId: number, scriptId: number, options: HttpRequestOptions = {}): Promise<HttpStaticScript> =>
    this.#request(`/api/v1/projects/${positiveInteger(projectId, 'invalid_project_id')}/scripts/${positiveInteger(scriptId, 'invalid_automation')}`,
      options.signal, (value) => validateSuccessEnvelope(value, validateStaticScript).data);

  createStaticScript = (projectId: number, input: Record<string, unknown>, options: HttpMutationOptions = {}): Promise<HttpStaticScript> =>
    this.#staticMutation(`/api/v1/projects/${positiveInteger(projectId, 'invalid_project_id')}/scripts`, 'POST', input, options, validateStaticScript);

  updateStaticScript = (projectId: number, scriptId: number, version: number, input: Record<string, unknown>, options: HttpMutationOptions = {}): Promise<HttpStaticScript> =>
    this.#staticMutation(`/api/v1/projects/${positiveInteger(projectId, 'invalid_project_id')}/scripts/${positiveInteger(scriptId, 'invalid_automation')}`, 'PATCH', { ...input, version: positiveVersion(version) }, options, validateStaticScript);

  deleteStaticScript = (projectId: number, scriptId: number, version: number, options: HttpMutationOptions = {}): Promise<HttpStaticScript> => {
    const id = positiveInteger(projectId, 'invalid_project_id');
    const script = positiveInteger(scriptId, 'invalid_automation');
    return this.#request(`/api/v1/projects/${id}/scripts/${script}?version=${positiveVersion(version)}`, options.signal,
      (value) => validateSuccessEnvelope(value, validateStaticScript).data,
      { method: 'DELETE', idempotencyKey: this.#idempotencyKeyFor(options), retryTransportFailure: true });
  };

  createScript = async (input: CreateScriptInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    await this.#request(
      `/api/v1/projects/${projectId}/scripts`,
      undefined,
      (value) => validateSuccessEnvelope(value, validateStaticScript).data,
      { method: 'POST', body: staticScriptInput(input), idempotencyKey: this.#idempotencyKeyFor(input), retryTransportFailure: true },
    );
    return this.#refreshProjectSnapshot(projectId);
  };

  updateScript = async (input: UpdateScriptInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const scriptId = positiveInteger(input?.scriptId, 'invalid_automation');
    const current = await this.getStaticScript(projectId, scriptId);
    await this.#request(
      `/api/v1/projects/${projectId}/scripts/${scriptId}`,
      undefined,
      (value) => validateSuccessEnvelope(value, validateStaticScript).data,
      {
        method: 'PATCH', body: { ...staticScriptInput(input), version: positiveVersion(current.version) },
        idempotencyKey: this.#idempotencyKeyFor(input), retryTransportFailure: true,
      },
    );
    return this.#refreshProjectSnapshot(projectId);
  };

  deleteScript = async (input: ScriptIdInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const scriptId = positiveInteger(input?.scriptId, 'invalid_automation');
    const current = await this.getStaticScript(projectId, scriptId);
    await this.#request(
      `/api/v1/projects/${projectId}/scripts/${scriptId}?version=${positiveVersion(current.version)}`,
      undefined,
      (value) => validateSuccessEnvelope(value, validateStaticScript).data,
      { method: 'DELETE', idempotencyKey: this.#idempotencyKeyFor(input), retryTransportFailure: true },
    );
    return this.#refreshProjectSnapshot(projectId);
  };

  toggleScript = async (input: ScriptIdInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const scriptId = positiveInteger(input?.scriptId, 'invalid_automation');
    const current = await this.getStaticScript(projectId, scriptId);
    await this.#request(
      `/api/v1/projects/${projectId}/scripts/${scriptId}/toggle`,
      undefined,
      (value) => validateSuccessEnvelope(value, validateStaticScript).data,
      {
        method: 'POST', body: { version: positiveVersion(current.version) },
        idempotencyKey: this.#idempotencyKeyFor(input), retryTransportFailure: true,
      },
    );
    return this.#refreshProjectSnapshot(projectId);
  };

  listStaticExecutors = async (projectId: number, options: PlanQueryOptions = {}): Promise<HttpStaticExecutor[]> => {
    const id = positiveInteger(projectId, 'invalid_project_id');
    const limit = positiveInteger(options.limit ?? 50, 'invalid_pagination');
    const offset = nonNegativeInteger(options.offset ?? 0, 'invalid_pagination');
    if (limit > 200) throw new HttpClientError('invalid_pagination');
    return this.#request(`/api/v1/projects/${id}/executors?limit=${limit}&offset=${offset}`, options.signal,
      (value) => validateSuccessEnvelope(value, validateStaticExecutors).data);
  };

  getStaticExecutor = (projectId: number, executorId: number, options: HttpRequestOptions = {}): Promise<HttpStaticExecutor> =>
    this.#request(`/api/v1/projects/${positiveInteger(projectId, 'invalid_project_id')}/executors/${positiveInteger(executorId, 'invalid_automation')}`,
      options.signal, (value) => validateSuccessEnvelope(value, validateStaticExecutor).data);

  createStaticExecutor = (projectId: number, input: Record<string, unknown>, options: HttpMutationOptions = {}): Promise<HttpStaticExecutor> =>
    this.#staticMutation(`/api/v1/projects/${positiveInteger(projectId, 'invalid_project_id')}/executors`, 'POST', input, options, validateStaticExecutor);

  updateStaticExecutor = (projectId: number, executorId: number, version: number, input: Record<string, unknown>, options: HttpMutationOptions = {}): Promise<HttpStaticExecutor> =>
    this.#staticMutation(`/api/v1/projects/${positiveInteger(projectId, 'invalid_project_id')}/executors/${positiveInteger(executorId, 'invalid_automation')}`, 'PATCH', { ...input, version: positiveVersion(version) }, options, validateStaticExecutor);

  deleteStaticExecutor = (projectId: number, executorId: number, version: number, options: HttpMutationOptions = {}): Promise<HttpStaticExecutor> => {
    const id = positiveInteger(projectId, 'invalid_project_id');
    const executor = positiveInteger(executorId, 'invalid_automation');
    return this.#request(`/api/v1/projects/${id}/executors/${executor}?version=${positiveVersion(version)}`, options.signal,
      (value) => validateSuccessEnvelope(value, validateStaticExecutor).data,
      { method: 'DELETE', idempotencyKey: this.#idempotencyKeyFor(options), retryTransportFailure: true });
  };

  listStaticConversations = (projectId: number, cursor = '', options: HttpRequestOptions = {}): Promise<HttpCursorPage<Conversation>> => {
    const id = positiveInteger(projectId, 'invalid_project_id');
    if (typeof cursor !== 'string' || cursor.length > 512) throw new HttpClientError('invalid_cursor');
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.#request(`/api/v1/projects/${id}/conversations${query}`, options.signal, validateConversationPage);
  };

  listStaticMessages = (projectId: number, conversationId: number, cursor = '', options: HttpRequestOptions = {}): Promise<HttpCursorPage<HttpMessageMetadata>> => {
    const project = positiveInteger(projectId, 'invalid_project_id');
    const conversation = positiveInteger(conversationId, 'invalid_conversation');
    if (typeof cursor !== 'string' || cursor.length > 512) throw new HttpClientError('invalid_cursor');
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.#request(`/api/v1/projects/${project}/conversations/${conversation}/messages${query}`, options.signal, validateMessagePage);
  };

  /** P13A is independently gated; a disabled gate preserves the legacy owner. */
  isChatHTTPEnabled = (): boolean => this.#runtimeFeatureEnabled('go_chat_api');

  chatSend = async (payload: ChatSendPayload): Promise<{ accepted: boolean; conversationId?: number; error?: string }> => {
    if (!this.isChatHTTPEnabled()) return this.#delegate.chatSend(payload);
    const projectId = positiveInteger(payload?.projectId, 'invalid_project_id');
    const conversationId = positiveInteger(payload?.conversationId, 'invalid_conversation');
    const message = boundedChatText(payload?.message, 'invalid_request');
    const accepted = await this.#request(
      chatMessagesPath(projectId, conversationId),
      undefined,
      (value) => validateSuccessEnvelope(value, validateChatAccepted).data,
      {
        method: 'POST',
        body: { message, idempotency_key: this.#idempotencyKeyFor(payload) },
        idempotencyKey: this.#idempotencyKeyFor(payload),
      },
    );
    if (accepted.project_id !== projectId || accepted.conversation_id !== conversationId) throw new HttpClientError('invalid_response');
    return { accepted: true, conversationId: accepted.conversation_id };
  };

  chatStop = async (payload: ChatStopPayload): Promise<{ stopped: boolean; error?: string }> => {
    if (!this.isChatHTTPEnabled()) return this.#delegate.chatStop(payload);
    const projectId = positiveInteger(payload?.projectId, 'invalid_project_id');
    const conversationId = positiveInteger(payload?.conversationId, 'invalid_conversation');
    const result = await this.#request(
      `${chatConversationPath(projectId, conversationId)}:stop`, undefined,
      (value) => validateSuccessEnvelope(value, validateChatStop).data,
      { method: 'POST', body: {}, idempotencyKey: this.#idempotencyKeyFor(payload) },
    );
    if (result.project_id !== projectId || result.conversation_id !== conversationId) throw new HttpClientError('invalid_response');
    return { stopped: result.stopped };
  };

  chatClear = async (payload: ChatClearPayload): Promise<{ cleared: boolean; error?: string }> => {
    if (!this.isChatHTTPEnabled()) return this.#delegate.chatClear(payload);
    const projectId = positiveInteger(payload?.projectId, 'invalid_project_id');
    const conversationId = positiveInteger(payload?.conversationId, 'invalid_conversation');
    const result = await this.#request(
      chatMessagesPath(projectId, conversationId), undefined,
      (value) => validateSuccessEnvelope(value, validateChatClear).data,
      { method: 'DELETE', idempotencyKey: this.#idempotencyKeyFor(payload) },
    );
    if (result.project_id !== projectId || result.conversation_id !== conversationId) throw new HttpClientError('invalid_response');
    return { cleared: result.cleared };
  };

  chatHistory = async (payload: ChatHistoryPayload): Promise<ChatMessage[]> => {
    if (!this.isChatHTTPEnabled()) return this.#delegate.chatHistory(payload);
    const projectId = positiveInteger(payload?.projectId, 'invalid_project_id');
    const conversationId = positiveInteger(payload?.conversationId, 'invalid_conversation');
    return this.#readChatPages(
      chatMessagesPath(projectId, conversationId),
      validateChatMessagePage,
      (message) => {
        if (message.projectId !== projectId || message.conversationId !== conversationId) throw new HttpClientError('invalid_response');
        return toLegacyChatMessage(message);
      },
    );
  };

  chatQueueList = async (payload: ChatQueuePayload): Promise<ChatQueueItem[]> => {
    if (!this.isChatHTTPEnabled()) return this.#delegate.chatQueueList(payload);
    const projectId = positiveInteger(payload?.projectId, 'invalid_project_id');
    const conversationId = positiveInteger(payload?.conversationId, 'invalid_conversation');
    const queue = await this.#request(
      `${chatConversationPath(projectId, conversationId)}/queue`, undefined,
      (value) => validateSuccessEnvelope(value, validateChatQueue).data,
    );
    if (queue.projectId !== projectId || queue.conversationId !== conversationId) throw new HttpClientError('invalid_response');
    return queue.items;
  };

  chatQueueCancel = async (payload: ChatQueuePayload): Promise<{ ok: boolean }> => {
    if (!this.isChatHTTPEnabled()) return this.#delegate.chatQueueCancel(payload);
    const projectId = positiveInteger(payload?.projectId, 'invalid_project_id');
    const conversationId = positiveInteger(payload?.conversationId, 'invalid_conversation');
    const id = positiveInteger(payload?.id, 'invalid_chat_queue_item');
    return this.#chatQueueMutation(projectId, conversationId, id, 'DELETE', undefined, payload);
  };

  chatQueueEdit = async (payload: ChatQueuePayload): Promise<{ ok: boolean }> => {
    if (!this.isChatHTTPEnabled()) return this.#delegate.chatQueueEdit(payload);
    const projectId = positiveInteger(payload?.projectId, 'invalid_project_id');
    const conversationId = positiveInteger(payload?.conversationId, 'invalid_conversation');
    const id = positiveInteger(payload?.id, 'invalid_chat_queue_item');
    return this.#chatQueueMutation(projectId, conversationId, id, 'PATCH', { message: boundedChatText(payload?.message, 'invalid_request') }, payload);
  };

  chatQueueClear = async (payload: ChatQueuePayload): Promise<{ ok: boolean }> => {
    if (!this.isChatHTTPEnabled()) return this.#delegate.chatQueueClear(payload);
    const projectId = positiveInteger(payload?.projectId, 'invalid_project_id');
    const conversationId = positiveInteger(payload?.conversationId, 'invalid_conversation');
    const result = await this.#request(
      `${chatConversationPath(projectId, conversationId)}/queue`, undefined,
      (value) => validateSuccessEnvelope(value, validateChatBoolean).data,
      { method: 'DELETE', idempotencyKey: this.#idempotencyKeyFor(payload) },
    );
    return result;
  };

  conversationList = async (payload: ConversationListInput): Promise<Conversation[]> => {
    if (!this.isChatHTTPEnabled()) return this.#delegate.conversationList(payload);
    const projectId = positiveInteger(payload?.projectId, 'invalid_project_id');
    return this.#readChatPages(
      `/api/v1/projects/${projectId}/conversations`, validateConversationPage,
      (conversation) => {
        if (conversation.projectId !== projectId) throw new HttpClientError('invalid_response');
        return conversation;
      },
    );
  };

  conversationCreate = async (payload: ConversationCreateInput): Promise<Conversation> => {
    if (!this.isChatHTTPEnabled()) return this.#delegate.conversationCreate(payload);
    const projectId = positiveInteger(payload?.projectId, 'invalid_project_id');
    const body: Record<string, unknown> = {};
    if (payload.title !== undefined) body.title = boundedConversationTitle(payload.title);
    if (payload.aiConfigId !== undefined) body.ai_config_id = nullablePositiveInteger(payload.aiConfigId) ? payload.aiConfigId : invalidConversationInput();
    const conversation = await this.#request(
      `/api/v1/projects/${projectId}/conversations`, undefined,
      (value) => validateSuccessEnvelope(value, validateConversation).data,
      { method: 'POST', body, idempotencyKey: this.#idempotencyKeyFor(payload) },
    );
    if (conversation.projectId !== projectId) throw new HttpClientError('invalid_response');
    return conversation;
  };

  conversationUpdate = async (payload: ConversationUpdateInput): Promise<Conversation> => {
    if (!this.isChatHTTPEnabled()) return this.#delegate.conversationUpdate(payload);
    const projectId = positiveInteger(payload?.projectId, 'invalid_project_id');
    const conversationId = positiveInteger(payload?.conversationId, 'invalid_conversation');
    const body: Record<string, unknown> = {};
    if (payload.title !== undefined) body.title = boundedConversationTitle(payload.title);
    if (payload.aiConfigId !== undefined) body.ai_config_id = nullablePositiveInteger(payload.aiConfigId) ? payload.aiConfigId : invalidConversationInput();
    if (payload.pinned !== undefined) {
      if (typeof payload.pinned !== 'boolean') throw new HttpClientError('invalid_request');
      body.pinned = payload.pinned;
    }
    if (payload.pinnedAt !== undefined) {
      if (!nullableUTC(payload.pinnedAt)) throw new HttpClientError('invalid_request');
      body.pinned_at = payload.pinnedAt;
    }
    if (!Object.keys(body).length) throw new HttpClientError('invalid_request');
    const conversation = await this.#request(
      chatConversationPath(projectId, conversationId), undefined,
      (value) => validateSuccessEnvelope(value, validateConversation).data,
      { method: 'PATCH', body, idempotencyKey: this.#idempotencyKeyFor(payload) },
    );
    if (conversation.projectId !== projectId || conversation.id !== conversationId) throw new HttpClientError('invalid_response');
    return conversation;
  };

  conversationDelete = async (payload: ConversationDeleteInput): Promise<{ deleted: boolean; id: number }> => {
    if (!this.isChatHTTPEnabled()) return this.#delegate.conversationDelete(payload);
    const projectId = positiveInteger(payload?.projectId, 'invalid_project_id');
    const conversationId = positiveInteger(payload?.conversationId, 'invalid_conversation');
    await this.#request(
      chatConversationPath(projectId, conversationId), undefined,
      (value) => validateSuccessEnvelope(value, validateDeletedConversation).data,
      { method: 'DELETE', idempotencyKey: this.#idempotencyKeyFor(payload) },
    );
    return { deleted: true, id: conversationId };
  };

  listStaticAIConfigs = (options: HttpRequestOptions = {}): Promise<AiConfig[]> =>
    this.#request('/api/v1/ai-configs', options.signal, (value) => validateSuccessEnvelope(value, validateAIConfigs).data);
  listStaticClaudeConfigs = (options: HttpRequestOptions = {}): Promise<ClaudeCliConfig[]> =>
    this.#request('/api/v1/claude-cli-configs', options.signal, (value) => validateSuccessEnvelope(value, validateClaudeConfigs).data);
  getStaticMCPConfig = (options: HttpRequestOptions = {}): Promise<HttpMCPConfig> =>
    this.#request('/api/v1/mcp-config', options.signal, (value) => validateSuccessEnvelope(value, validateMCPConfig).data);

  aiConfigList = (): Promise<AiConfig[]> => this.listStaticAIConfigs();

  chatGetConfig = async (): Promise<ChatConfig> => {
    const current = (await this.listStaticAIConfigs())[0];
    if (!current) {
      return {
        source: 'go-default', compatibilityOnly: false,
        provider: 'openai', baseUrl: 'https://api.openai.com', hasApiKey: false,
        maskedKey: '', model: 'gpt-5.5', temperature: '0.3',
        thinkingDepth: null, thinkingBudgetTokens: null,
      };
    }
    return {
      source: 'ai-config', compatibilityOnly: false, aiConfigId: current.id, name: current.name,
      provider: current.provider, baseUrl: current.baseUrl, hasApiKey: current.hasApiKey,
      maskedKey: current.maskedKey, model: current.model, temperature: current.temperature,
      thinkingDepth: current.thinkingDepth, thinkingBudgetTokens: current.thinkingBudgetTokens,
    };
  };

  chatSaveConfig = async (payload: ChatSaveConfigInput): Promise<{ saved: boolean }> => {
    if (!isRecord(payload)) throw new HttpClientError('invalid_config');
    const current = (await this.listStaticAIConfigs())[0];
    const fields = chatAIConfigInput(payload);
    if (current) {
      await this.aiConfigUpdate({ configId: current.id, ...fields });
    } else {
      const name = String(payload.name || '').trim() || '默认配置';
      await this.aiConfigCreate({ name, ...fields });
    }
    return { saved: true };
  };

  aiConfigGet = (payload: AiConfigGetInput): Promise<AiConfig> => {
    const id = positiveInteger(payload?.configId, 'invalid_config');
    return this.#request(`/api/v1/ai-configs/${id}`, undefined,
      (value) => validateSuccessEnvelope(value, validateAIConfig).data);
  };

  aiConfigCreate = (payload: AiConfigCreateInput): Promise<AiConfig> =>
    this.#request('/api/v1/ai-configs', undefined,
      (value) => validateSuccessEnvelope(value, validateAIConfig).data,
      { method: 'POST', body: staticAIConfigInput(payload), retryTransportFailure: true });

  aiConfigUpdate = async (payload: AiConfigUpdateInput): Promise<AiConfig> => {
    const id = positiveInteger(payload?.configId, 'invalid_config');
    const current = await this.aiConfigGet({ configId: id });
    return this.#request(`/api/v1/ai-configs/${id}`, undefined,
      (value) => validateSuccessEnvelope(value, validateAIConfig).data,
      { method: 'PATCH', body: { ...staticAIConfigInput(payload), version: positiveVersion(current.version ?? 0) }, retryTransportFailure: true });
  };

  aiConfigDelete = async (payload: AiConfigDeleteInput): Promise<{ deleted: boolean }> => {
    const id = positiveInteger(payload?.configId, 'invalid_config');
    const current = await this.aiConfigGet({ configId: id });
    return this.#request(`/api/v1/ai-configs/${id}?version=${positiveVersion(current.version ?? 0)}`, undefined,
      (value) => validateSuccessEnvelope(value, validateDeletedStaticConfig).data,
      { method: 'DELETE', retryTransportFailure: true });
  };

  claudeCliConfigList = (): Promise<ClaudeCliConfig[]> => this.listStaticClaudeConfigs();

  claudeCliConfigGet = (payload: ClaudeCliConfigGetInput): Promise<ClaudeCliConfig> => {
    const id = positiveInteger(payload?.configId, 'invalid_config');
    return this.#request(`/api/v1/claude-cli-configs/${id}`, undefined,
      (value) => validateSuccessEnvelope(value, validateClaudeConfig).data);
  };

  claudeCliConfigCreate = (payload: ClaudeCliConfigCreateInput): Promise<ClaudeCliConfig> =>
    this.#request('/api/v1/claude-cli-configs', undefined,
      (value) => validateSuccessEnvelope(value, validateClaudeConfig).data,
      { method: 'POST', body: staticClaudeConfigInput(payload), retryTransportFailure: true });

  claudeCliConfigUpdate = async (payload: ClaudeCliConfigUpdateInput): Promise<ClaudeCliConfig> => {
    const id = positiveInteger(payload?.configId, 'invalid_config');
    const current = await this.claudeCliConfigGet({ configId: id });
    return this.#request(`/api/v1/claude-cli-configs/${id}`, undefined,
      (value) => validateSuccessEnvelope(value, validateClaudeConfig).data,
      { method: 'PATCH', body: { ...staticClaudeConfigInput(payload), version: positiveVersion(current.version ?? 0) }, retryTransportFailure: true });
  };

  claudeCliConfigDelete = async (payload: ClaudeCliConfigDeleteInput): Promise<{ deleted: boolean }> => {
    const id = positiveInteger(payload?.configId, 'invalid_config');
    const current = await this.claudeCliConfigGet({ configId: id });
    return this.#request(`/api/v1/claude-cli-configs/${id}?version=${positiveVersion(current.version ?? 0)}`, undefined,
      (value) => validateSuccessEnvelope(value, validateDeletedStaticConfig).data,
      { method: 'DELETE', retryTransportFailure: true });
  };

  claudeCliConfigSetDefault = async (payload: ClaudeCliConfigSetDefaultInput): Promise<ClaudeCliConfig> => {
    const id = positiveInteger(payload?.configId, 'invalid_config');
    const current = await this.claudeCliConfigGet({ configId: id });
    return this.#request(`/api/v1/claude-cli-configs/${id}/default`, undefined,
      (value) => validateSuccessEnvelope(value, validateClaudeConfig).data,
      { method: 'POST', body: { version: positiveVersion(current.version ?? 0) }, retryTransportFailure: true });
  };

  saveMcpConfig = async (payload: McpConfigInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(payload?.projectId, 'invalid_project_id');
    await this.#request('/api/v1/mcp-config', undefined,
      (value) => validateSuccessEnvelope(value, validateMCPConfig).data,
      { method: 'PATCH', body: staticMCPConfigInput(payload), retryTransportFailure: true });
    return this.#refreshProjectSnapshot(projectId);
  };

  getCapabilities = (options: HttpRequestOptions = {}): Promise<HttpCapabilityDiscovery> =>
    options.signal ? this.#discoverCapabilities(options.signal) : this.#capabilities();

  listPlans = async (
    projectId: number,
    options: PlanQueryOptions = {},
  ): Promise<Plan[]> => {
    const id = positiveInteger(projectId, 'invalid_project_id');
    const limit = positiveInteger(options.limit ?? 200, 'invalid_pagination');
    const offset = nonNegativeInteger(options.offset ?? 0, 'invalid_pagination');
    if (limit > 200) throw new HttpClientError('invalid_pagination');
    if (!(await this.#supportsCapabilities(['plans.query']))) {
      return plansFromSnapshot(await this.getProjectSnapshot(id, { signal: options.signal }), id).slice(offset, offset + limit);
    }
    const plans = await this.#request(
      `/api/v1/plans?project_id=${id}&limit=${limit}&offset=${offset}`,
      options.signal,
      (value) => validateSuccessEnvelope(value, validatePlans).data,
    );
    return plansForProject(plans, id);
  };

  getPlan = async (
    input: PlanIdInput,
    options: PlanQueryOptions = {},
  ): Promise<Plan> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const planId = positiveInteger(input?.planId, 'invalid_plan');
    if (!(await this.#supportsCapabilities(['plans.query']))) {
      return findPlan(plansFromSnapshot(await this.getProjectSnapshot(projectId, { signal: options.signal }), projectId), planId);
    }
    const plan = await this.#request(
      `/api/v1/plans?project_id=${projectId}&plan_id=${planId}`,
      options.signal,
      (value) => validateSuccessEnvelope(value, validatePlan).data,
    );
    if (plan.id !== planId || plan.project_id !== projectId) throw new HttpClientError('invalid_response');
    return plan;
  };

  listPlanTasks = async (
    input: PlanIdInput,
    options: PlanTaskQueryOptions = {},
  ): Promise<PlanTask[]> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const planId = positiveInteger(input?.planId, 'invalid_plan');
    if (!(await this.#supportsCapabilities(['tasks.query']))) {
      return tasksFromSnapshot(await this.getProjectSnapshot(projectId, { signal: options.signal }), projectId, planId);
    }
    const tasks = await this.#request(
      `/api/v1/plan-tasks?project_id=${projectId}&plan_id=${planId}`,
      options.signal,
      (value) => validateSuccessEnvelope(value, validatePlanTasks).data,
    );
    return tasksForPlan(tasks, projectId, planId);
  };

  getPlanTask = async (
    input: PlanIdInput & { taskId: number },
    options: PlanTaskQueryOptions = {},
  ): Promise<PlanTask> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const planId = positiveInteger(input?.planId, 'invalid_plan');
    const taskId = positiveInteger(input?.taskId, 'invalid_task');
    if (!(await this.#supportsCapabilities(['tasks.query']))) {
      return findTask(tasksFromSnapshot(await this.getProjectSnapshot(projectId, { signal: options.signal }), projectId, planId), taskId);
    }
    const task = await this.#request(
      `/api/v1/plan-tasks?project_id=${projectId}&plan_id=${planId}&task_id=${taskId}`,
      options.signal,
      (value) => validateSuccessEnvelope(value, validatePlanTask).data,
    );
    if (task.id !== taskId || task.plan_id !== planId ||
        (task as PlanTask & { project_id?: number }).project_id !== projectId) {
      throw new HttpClientError('invalid_response');
    }
    return task;
  };

  listPlanEvents = async (
    projectId: number,
    options: PlanEventsQueryOptions = {},
  ): Promise<AppEvent[]> => {
    const id = positiveInteger(projectId, 'invalid_project_id');
    const limit = positiveInteger(options.limit ?? 80, 'invalid_pagination');
    const offset = nonNegativeInteger(options.offset ?? 0, 'invalid_pagination');
    if (limit > 200) throw new HttpClientError('invalid_pagination');
    if (!(await this.#supportsCapabilities(['events.query']))) {
      return eventsFromSnapshot(await this.getProjectSnapshot(id, { signal: options.signal }), id, limit, offset);
    }
    const events = await this.#request(
      `/api/v1/events?project_id=${id}&limit=${limit}&offset=${offset}`,
      options.signal,
      (value) => validateSuccessEnvelope(value, validatePlanEvents).data,
    );
    if (events.some((event) => event.project_id !== id)) throw new HttpClientError('invalid_response');
    return events;
  };

  readPlan = async (input: ReadPlanInput): Promise<ReadPlanResult> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const planId = positiveInteger(input?.planId, 'invalid_plan');
    const content = await this.#request(
      `/api/v1/projects/${projectId}/plans/${planId}/content`,
      undefined,
      (value) => validateSuccessEnvelope(value, validatePlanContent).data,
    );
    if (content.plan.id !== planId || content.plan.project_id !== projectId ||
        content.tasks.some((task) => task.plan_id !== planId ||
          (task as PlanTask & { project_id?: number }).project_id !== projectId)) {
      throw new HttpClientError('invalid_response');
    }
    return planReadResult(content);
  };

  reorderPlans = async (
    input: ReorderPlansInput,
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    if (!(await this.#supportsCapabilities(['plans.reorder']))) return this.#delegate.reorderPlans(input);
    const context = await this.#planMutationContext(input, 'reorder', projectId, options.signal);
    const planIds = normalizedPlanIDs(input, context.plans);
    return this.#planMutation(
      '/api/v1/plans/reorder',
      'PUT',
      { project_id: projectId, plan_ids: planIds, expected_updated_at: planVersions(context.plans) },
      input,
      options.signal,
      `plans:${projectId}`,
    );
  };

  deletePlan = async (
    input: PlanIdInput,
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const planId = positiveInteger(input?.planId, 'invalid_plan');
    if (!(await this.#supportsCapabilities(['plans.delete']))) return this.#delegate.deletePlan(input);
    const context = await this.#planMutationContext(input, 'delete', projectId, options.signal);
    const plan = findPlan([...context.plans.values()], planId);
    return this.#planMutation(
      '/api/v1/plans',
      'DELETE',
      { project_id: projectId, plan_id: planId, expected_updated_at: plan.updated_at },
      input,
      options.signal,
      `plans:${projectId}`,
    );
  };

  createProject = (
    input: CreateProjectInput,
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => this.#snapshotMutation(
    '/api/v1/projects',
    'POST',
    projectCreateBody(input),
    input,
    options.signal,
  );

  updateProject = (
    input: UpdateProjectInput,
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => {
    const id = positiveInteger(input?.id, 'invalid_project_id');
    return this.#snapshotMutation(
      `/api/v1/projects/${id}`,
      'PATCH',
      projectUpdateBody(input),
      input,
      options.signal,
      `project:${id}`,
    );
  };

  deleteProject = (
    input: ProjectIdInput,
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => {
    const id = positiveInteger(input?.projectId, 'invalid_project_id');
    return this.#snapshotMutation(
      `/api/v1/projects/${id}`,
      'DELETE',
      undefined,
      input,
      options.signal,
      `project:${id}`,
    );
  };

  configureLoop = async (
    input: LoopConfigInput,
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => {
    const id = positiveInteger(input?.projectId, 'invalid_project_id');
    const version = positiveVersion(input.version ?? this.#projectVersions.get(id));
    const snapshot = await this.#snapshotMutation(
      `/api/v1/projects/${id}/loop-config`,
      'PATCH',
      loopConfigBody(input, version),
      input,
      options.signal,
      `project:${id}`,
    );
    requireSnapshotVersion(snapshot, id);
    return snapshot;
  };

  startLoop = async (input: ProjectIdInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    if (!this.#runtimeFeatureEnabled('go_loop_actions')) return this.#nodeRuntime(() => this.#delegate.startLoop(input));
    return this.#submitRuntimeAction('go_loop_actions', projectId,
      `/api/v1/projects/${projectId}/loop/actions/start`, {}, input);
  };

  stopLoop = async (input: ProjectIdInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    if (!this.#runtimeFeatureEnabled('go_loop_actions')) return this.#nodeRuntime(() => this.#delegate.stopLoop(input));
    return this.#submitRuntimeAction('go_loop_actions', projectId,
      `/api/v1/projects/${projectId}/loop/actions/stop`, {}, input);
  };

  runOnce = async (input: ProjectIdInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    if (!this.#runtimeFeatureEnabled('go_loop_actions')) return this.#nodeRuntime(() => this.#delegate.runOnce(input));
    return this.#submitRuntimeAction('go_loop_actions', projectId,
      `/api/v1/projects/${projectId}/loop/actions/run-once`, {}, input);
  };

  stopPlan = async (input: PlanIdInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const planId = positiveInteger(input?.planId, 'invalid_plan');
    if (!this.#runtimeFeatureEnabled('go_plan_actions')) return this.#nodeRuntime(() => this.#delegate.stopPlan(input));
    return this.#submitRuntimeAction('go_plan_actions', projectId,
      `/api/v1/projects/${projectId}/plans/${planId}/actions/stop`, {}, input);
  };

  resumePlan = async (input: PlanIdInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const planId = positiveInteger(input?.planId, 'invalid_plan');
    if (!this.#runtimeFeatureEnabled('go_plan_actions')) return this.#nodeRuntime(() => this.#delegate.resumePlan(input));
    return this.#submitRuntimeAction('go_plan_actions', projectId,
      `/api/v1/projects/${projectId}/plans/${planId}/actions/resume`, {}, input);
  };

  reExecutePlan = async (input: PlanIdInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const planId = positiveInteger(input?.planId, 'invalid_plan');
    if (!this.#runtimeFeatureEnabled('go_plan_actions')) return this.#nodeRuntime(() => this.#delegate.reExecutePlan(input));
    return this.#submitRuntimeAction('go_plan_actions', projectId,
      `/api/v1/projects/${projectId}/plans/${planId}/actions/re-execute`, {}, input);
  };

  recreatePlanFromIntake = async (input: PlanIdInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const planId = positiveInteger(input?.planId, 'invalid_plan');
    if (!this.#runtimeFeatureEnabled('go_plan_actions')) return this.#nodeRuntime(() => this.#delegate.recreatePlanFromIntake(input));
    return this.#submitRuntimeAction('go_plan_actions', projectId,
      `/api/v1/projects/${projectId}/plans/${planId}/actions/recreate`, {}, input);
  };

  runTask = async (input: TaskIdInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const taskId = positiveInteger(input?.taskId, 'invalid_task');
    const planId = positiveInteger(input?.planId, 'invalid_plan');
    if (!this.#runtimeFeatureEnabled('go_task_actions')) return this.#nodeRuntime(() => this.#delegate.runTask(input));
    return this.#submitRuntimeAction('go_task_actions', projectId,
      `/api/v1/projects/${projectId}/tasks/${taskId}/actions/run`, { plan_id: planId }, input);
  };

  stopTask = async (input: TaskIdInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const taskId = positiveInteger(input?.taskId, 'invalid_task');
    const planId = positiveInteger(input?.planId, 'invalid_plan');
    if (!this.#runtimeFeatureEnabled('go_task_actions')) return this.#nodeRuntime(() => this.#delegate.stopTask(input));
    return this.#submitRuntimeAction('go_task_actions', projectId,
      `/api/v1/projects/${projectId}/tasks/${taskId}/actions/stop`, { plan_id: planId }, input);
  };

  runTaskBatches = async (input: RunTaskBatchesInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const planId = positiveInteger(input?.planId, 'invalid_plan');
    if (!this.#runtimeFeatureEnabled('go_task_actions')) return this.#nodeRuntime(() => this.#delegate.runTaskBatches(input));
    return this.#submitRuntimeAction('go_task_actions', projectId,
      `/api/v1/projects/${projectId}/plans/${planId}/actions/run-batches`,
      { batches: runtimeTaskBatches(input.batches) }, input);
  };

  acceptItem = async (input: AcceptanceItemInput, _options: HttpMutationOptions = {}): Promise<AppSnapshot> =>
    this.#submitAcceptanceAction('accept', input);

  unacceptItem = async (input: AcceptanceItemInput, _options: HttpMutationOptions = {}): Promise<AppSnapshot> =>
    this.#submitAcceptanceAction('unaccept', input);

  redoAcceptanceItem = async (input: AcceptanceRedoInput, _options: HttpMutationOptions = {}): Promise<AppSnapshot> =>
    this.#submitAcceptanceAction('redo', input);

  acceptItems = async (input: AcceptBatchInput, _options: HttpMutationOptions = {}): Promise<AppSnapshot> =>
    this.#submitAcceptanceBatchAction('accept-batch', input);

  unacceptItems = async (input: AcceptBatchInput, _options: HttpMutationOptions = {}): Promise<AppSnapshot> =>
    this.#submitAcceptanceBatchAction('unaccept-batch', input);

  interruptIntake = (input: IntakeActionInput): Promise<AppSnapshot> =>
    this.#submitIntakePlanAction(input, 'interrupt', {});

  resumeIntake = (input: IntakeActionInput): Promise<AppSnapshot> =>
    this.#submitIntakePlanAction(input, 'resume', {});

  appendIntakeTask = (input: IntakeActionInput): Promise<AppSnapshot> => {
    if (typeof input?.title !== 'string' || input.title.trim() === '') {
      throw new HttpClientError('invalid_intake');
    }
    return this.#submitIntakePlanAction(input, 'append-task', { title: input.title.trim() });
  };

  retryIntakePlanGeneration = async (input: RetryIntakePlanGenerationInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const intakeId = positiveInteger(input?.id, 'invalid_intake');
    if (input?.type !== 'requirement' && input?.type !== 'feedback') throw new HttpClientError('invalid_intake');
    if (!this.#runtimeFeatureEnabled('go_acceptance_retry_actions')) {
      return this.#nodeRuntime(() => this.#delegate.retryIntakePlanGeneration(input));
    }
    const snapshot = await this.#intakeMutation(
      `/api/v1/projects/${projectId}/intake/${input.type}/${intakeId}/actions/retry-plan-generation`,
      'POST', {}, input, undefined, `intake:${input.type}:${intakeId}`,
    );
    // Retrying clears the persisted generation failure synchronously. Start a
    // fresh bounded cycle immediately instead of leaving the user waiting for
    // the next timer tick. A cycle already in progress is a successful reset,
    // not a reason to replay the mutation or fall back to Node.
    if (!this.#runtimeFeatureEnabled('go_loop_actions')) return snapshot;
    try {
      return await this.runOnce({ projectId });
    } catch (error) {
      if (error instanceof HttpClientError &&
          (error.code === 'precondition_failed' || error.code === 'operation_state_conflict')) {
        return snapshot;
      }
      throw error;
    }
  };

  // P006 used `this.#runtimeFeatureEnabled('go_agent_cli_runtime')` and
  // `Promise.reject(new HttpClientError('not_implemented'))` as a temporary
  // stopgap. P007 supersedes that coupled gate with the independent Script
  // and Executor owners below; the legacy flag remains parse-only.
  runScript = async (input: ScriptIdInput): Promise<ScriptRunResult> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const scriptId = positiveInteger(input?.scriptId, 'invalid_automation');
    if (!this.#runtimeFeatureEnabled('go_scripts_api')) {
      return this.#nodeRuntime(() => this.#delegate.runScript(input));
    }
    const { operation, snapshot } = await this.#submitProcessAction(
      'go_scripts_api', projectId,
      `/api/v1/projects/${projectId}/scripts/${scriptId}/actions/run`, input, ['script.run'],
    );
    const script = snapshot.scripts.find((candidate) => candidate.id === scriptId);
    return {
      snapshot,
      status: script?.last_status ?? script?.lastStatus ?? (operation.status === 'queued' ? 'running' : null),
      exitCode: script?.last_exit_code ?? script?.lastExitCode ?? null,
      durationMs: script?.last_duration_ms ?? script?.lastDurationMs ?? null,
      log: script?.last_log ?? script?.lastLog ?? null,
      operation: operation as ProcessOperationAccepted,
    };
  };

  stopScript = async (input: ScriptIdInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const scriptId = positiveInteger(input?.scriptId, 'invalid_automation');
    if (!this.#runtimeFeatureEnabled('go_scripts_api')) {
      return this.#nodeRuntime(() => this.#delegate.stopScript(input));
    }
    return this.#submitProcessStop(
      'go_scripts_api', projectId,
      `/api/v1/projects/${projectId}/scripts/${scriptId}/actions/stop`, input, ['script.run'],
    );
  };

  runExecutor = async (input: ExecutorIdInput): Promise<ExecutorRunResult> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const executorId = positiveInteger(input?.executorId, 'invalid_automation');
    if (!this.#runtimeFeatureEnabled('go_executors_api')) {
      return this.#nodeRuntime(() => this.#delegate.runExecutor(input));
    }
    const { operation, snapshot } = await this.#submitProcessAction(
      'go_executors_api', projectId,
      `/api/v1/projects/${projectId}/executors/${executorId}/actions/run`, input, ['executor.run'],
    );
    return executorRunResult(snapshot, executorId, operation);
  };

  stopExecutor = async (input: ExecutorIdInput): Promise<AppSnapshot> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const executorId = positiveInteger(input?.executorId, 'invalid_automation');
    if (!this.#runtimeFeatureEnabled('go_executors_api')) {
      return this.#nodeRuntime(() => this.#delegate.stopExecutor(input));
    }
    return this.#submitProcessStop(
      'go_executors_api', projectId,
      `/api/v1/projects/${projectId}/executors/${executorId}/actions/stop`, input,
      ['executor.run', 'executor.action'],
    );
  };

  runExecutorAction = async (input: RunExecutorPluginActionInput): Promise<ExecutorRunResult> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const executorId = positiveInteger(input?.executorId, 'invalid_automation');
    if (input?.action !== 'start' && input?.action !== 'reload' && input?.action !== 'stop') {
      throw new HttpClientError('invalid_runtime_command');
    }
    if (!this.#runtimeFeatureEnabled('go_executors_api')) {
      return this.#nodeRuntime(() => this.#delegate.runExecutorAction(input));
    }
    if (input.action === 'stop') {
      const snapshot = await this.#submitProcessStop(
        'go_executors_api', projectId,
        `/api/v1/projects/${projectId}/executors/${executorId}/actions/stop`, input,
        ['executor.run', 'executor.action'],
      );
      return executorRunResult(snapshot, executorId, null);
    }
    const { operation, snapshot } = await this.#submitProcessAction(
      'go_executors_api', projectId,
      `/api/v1/projects/${projectId}/executors/${executorId}/actions/${input.action}`,
      input, ['executor.run', 'executor.action'],
    );
    return executorRunResult(snapshot, executorId, operation);
  };

  listRequirements = (request: IntakePageRequest): Promise<IntakePage<Requirement>> =>
    this.#listIntakes('requirement', request);

  getRequirement = (
    projectId: number,
    intakeId: number,
    options: HttpRequestOptions = {},
  ): Promise<Requirement> => this.#getIntake('requirement', projectId, intakeId, options.signal);

  listFeedback = (request: IntakePageRequest): Promise<IntakePage<Feedback>> =>
    this.#listIntakes('feedback', request);

  getFeedback = (
    projectId: number,
    intakeId: number,
    options: HttpRequestOptions = {},
  ): Promise<Feedback> => this.#getIntake('feedback', projectId, intakeId, options.signal);

  createRequirement = (
    input: CreateIntakeInput,
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => this.#createIntake('requirement', input, options);

  createFeedback = (
    input: CreateIntakeInput,
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => this.#createIntake('feedback', input, options);

  updateRequirement = (
    input: UpdateRequirementInput,
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => this.#updateIntake('requirement', input, options);

  updateFeedback = (
    input: UpdateFeedbackInput,
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => this.#updateIntake('feedback', input, options);

  deleteRequirement = (
    input: ProjectIdInput & { id: number },
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => this.#deleteIntake('requirement', input, options.signal);

  deleteFeedback = (
    input: ProjectIdInput & { id: number },
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => this.#deleteIntake('feedback', input, options.signal);

  acceptIntake = (
    input: IntakeAcceptanceInput,
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => this.#setIntakeAcceptance(input, true, options.signal);

  unacceptIntake = (
    input: IntakeAcceptanceInput,
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => this.#setIntakeAcceptance(input, false, options.signal);

  listRequirementPlanLinks = (
    projectId: number,
    intakeId: number,
    options: HttpRequestOptions = {},
  ): Promise<IntakePlanLink[]> => this.#listPlanLinks('requirement', projectId, intakeId, options.signal);

  listFeedbackPlanLinks = (
    projectId: number,
    intakeId: number,
    options: HttpRequestOptions = {},
  ): Promise<IntakePlanLink[]> => this.#listPlanLinks('feedback', projectId, intakeId, options.signal);

  replaceRequirementPlanLinks = (
    projectId: number,
    intakeId: number,
    links: IntakePlanLinkInput[],
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => this.#replacePlanLinks('requirement', projectId, intakeId, links, options.signal);

  replaceFeedbackPlanLinks = (
    projectId: number,
    intakeId: number,
    links: IntakePlanLinkInput[],
    options: HttpMutationOptions = {},
  ): Promise<AppSnapshot> => this.#replacePlanLinks('feedback', projectId, intakeId, links, options.signal);

  uploadIntakeAttachment = async (
    type: IntakeType,
    input: CreateIntakeInput | UpdateRequirementInput | UpdateFeedbackInput,
    intakeId: number,
    attachmentIndex: number,
    options: HttpMutationOptions = {},
  ): Promise<AttachmentUploadResult> => {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const ownerID = positiveInteger(intakeId, 'invalid_intake');
    const attachments = preparePendingAttachments(input?.attachments ?? []);
    const prepared = attachments[attachmentIndex];
    if (!prepared) throw new HttpClientError('invalid_attachment');
    reportUploadProgress(options.onUploadProgress, 0, prepared.blob.size);
    const result = await this.#uploadPreparedAttachment(type, projectId, ownerID, prepared, input, attachmentIndex, options.signal);
    reportUploadProgress(options.onUploadProgress, prepared.blob.size, prepared.blob.size);
    return result;
  };

  deleteAttachment = async (
    projectId: number,
    attachmentId: number,
    options: HttpMutationOptions = {},
  ): Promise<AttachmentDeleteResult> => {
    const ownerProjectID = positiveInteger(projectId, 'invalid_project_id');
    const id = positiveInteger(attachmentId, 'invalid_attachment');
    const intent = { projectId: ownerProjectID, attachmentId: id, operation: 'delete-attachment' };
    return this.#request(
      `/api/v1/attachments/${id}?project_id=${ownerProjectID}`,
      options.signal,
      (value) => validateSuccessEnvelope(value, validateAttachmentDelete).data,
      {
        method: 'DELETE',
        idempotencyKey: this.#idempotencyKeyFor(intent),
        retryTransportFailure: true,
      },
    );
  };

  getAttachmentDownloadUrl = (projectId: number, attachmentId: number): string => {
    const ownerProjectID = positiveInteger(projectId, 'invalid_project_id');
    const id = positiveInteger(attachmentId, 'invalid_attachment');
    return controlledAttachmentURL(`/api/v1/attachments/${id}/content`, ownerProjectID, this.#baseUrl);
  };

  fileAccess = {
    get: async (options: HttpRequestOptions = {}): Promise<FileAccessSettings> => {
      const policy = await this.#request(
        '/api/v1/file-access-policy',
        options.signal,
        (value) => validateSuccessEnvelope(value, validateFilePolicy).data,
      );
      this.#recordFilePolicy(policy);
      return fileAccessSettings(policy);
    },
    save: async (
      input: FileAccessSaveInput,
      options: HttpMutationOptions = {},
    ): Promise<FileAccessSaveResult> => {
      const version = positiveVersion(input?.version ?? this.#filePolicy?.version);
      const generation = this.#beginMutation('file-policy');
      const policy = await this.#request(
        '/api/v1/file-access-policy',
        options.signal,
        (value) => validateSuccessEnvelope(value, validateFilePolicy).data,
        {
          method: 'PATCH',
          body: filePolicyBody(input, version, this.#filePolicy),
          idempotencyKey: this.#idempotencyKeyFor(input),
          retryTransportFailure: true,
        },
      );
      this.#assertCurrentMutation('file-policy', generation);
      this.#recordFilePolicy(policy);
      return {
        saved: true,
        ...(policy.high_risk ? { warned: true } : {}),
        version: policy.version,
      };
    },
  };

  snapshot = async (projectId?: number | null): Promise<AppSnapshot> => {
    this.#snapshotController?.abort();
    const controller = new AbortController();
    this.#snapshotController = controller;
    try {
      if (projectId !== null && projectId !== undefined) {
        return await this.getProjectSnapshot(projectId, { signal: controller.signal });
      }
      const projects = await this.#listAllProjects(controller.signal);
      return projectListSnapshot(emptyProjectListSnapshot(), projects);
    } finally {
      if (this.#snapshotController === controller) this.#snapshotController = null;
    }
  };

  connectProjectEvents = (
    projectId: number,
    onState?: EventHandler<ProjectEventConnectionUpdate>,
    onEvent?: EventHandler<ProjectEventDelivery>,
  ): ResumableEventSubscription => {
    const id = positiveInteger(projectId, 'invalid_project_id');
    return this.#connectEventStream({
      projectId: id,
      source: 'project',
      path: `${PROJECT_SSE_PATH}/${id}/events`,
      onState,
      onEvent,
    });
  };

  connectOperationEvents = (
    projectId: number,
    operationId: string,
    onState?: EventHandler<ProjectEventConnectionUpdate>,
    onEvent?: EventHandler<ProjectEventDelivery>,
  ): ResumableEventSubscription => {
    const id = positiveInteger(projectId, 'invalid_project_id');
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) {
      throw new HttpClientError('invalid_operation');
    }
    return this.#connectEventStream({
      projectId: id,
      source: 'operation',
      operationId,
      path: `${OPERATION_SSE_PATH}/${encodeURIComponent(operationId)}/events?project_id=${id}`,
      onState,
      onEvent,
    });
  };

  connectChatEvents = (
    projectId: number,
    conversationId: number,
    handlers: Parameters<HttpChatOperations['connectChatEvents']>[2],
  ): ResumableEventSubscription => {
    if (!this.isChatHTTPEnabled()) throw new HttpClientError('runtime_feature_disabled');
    const project = positiveInteger(projectId, 'invalid_project_id');
    const conversation = positiveInteger(conversationId, 'invalid_conversation');
    if (!isRecord(handlers) || Object.values(handlers).some((handler) => handler !== undefined && typeof handler !== 'function')) {
      throw new HttpClientError('invalid_event_handler');
    }
    const watermarkKey = `chat:${project}:${conversation}`;
    const chunkSequences = new Map<string, number>();
    const stream = createResumableChatEventStream({
      projectId: project,
      initialWatermark: this.#eventWatermarks.get(watermarkKey),
      open: async (lastEventId, signal) => {
        const response = await this.#fetchResponse(
          `${chatConversationPath(project, conversation)}/events`, signal, EVENT_STREAM_CONTENT_TYPE, false,
          'GET', undefined, undefined, lastEventId,
        );
        if (!response.ok) await responseFailure(response);
        if (mediaType(response.headers.get('Content-Type')) !== EVENT_STREAM_CONTENT_TYPE) {
          throw new HttpClientError('invalid_content_type', response.status);
        }
        return response;
      },
      onEvent: (event) => this.#deliverChatEvent(project, conversation, event, handlers, chunkSequences),
      onResync: (reason) => handlers.onResync?.(reason),
      onWatermark: (watermark) => this.#recordEventWatermark(watermarkKey, watermark),
      onState: () => undefined,
      isRetryable: (error) => !(error instanceof HttpClientError) || error.retryable || error.status >= 500,
    });
    let stopped = false;
    let unsubscribe: ResumableEventSubscription;
    unsubscribe = (() => {
      if (stopped) return;
      stopped = true;
      stream();
      this.#eventConnections.delete(unsubscribe);
    }) as ResumableEventSubscription;
    unsubscribe.completeResync = () => stream.completeResync();
    this.#eventConnections.add(unsubscribe);
    return unsubscribe;
  };

  destroy(): void {
    this.#snapshotController?.abort();
    this.#snapshotController = null;
    for (const unsubscribe of [...this.#eventConnections]) unsubscribe();
    this.#eventWatermarks.clear();
    this.#operationStreams.clear();
    this.#operationOwners.clear();
  }

  #terminalCreate(projectId: number, input: TerminalRestCreateInput): Promise<TerminalRestSession> {
    const project = positiveInteger(projectId, 'invalid_project_id');
    return this.#request(
      `/api/v1/projects/${project}/terminals`,
      undefined,
      (value) => validateSuccessEnvelope(value, validateTerminalRestSession).data,
      { method: 'POST', body: input, idempotencyKey: this.#newIdempotencyKey(), retryTransportFailure: true },
    );
  }

  #terminalList(projectId: number): Promise<TerminalRestSession[]> {
    const project = positiveInteger(projectId, 'invalid_project_id');
    return this.#request(
      `/api/v1/projects/${project}/terminals`,
      undefined,
      (value) => validateSuccessEnvelope(value, validateTerminalRestSessions).data,
    );
  }

  #terminalWrite(projectId: number, sessionId: string, data: string): Promise<TerminalRestSession> {
    return this.#terminalMutation(projectId, sessionId, '/actions/write', { data });
  }

  #terminalResize(projectId: number, sessionId: string, cols: number, rows: number): Promise<TerminalRestSession> {
    return this.#terminalMutation(projectId, sessionId, '/actions/resize', { cols, rows });
  }

  #terminalRename(projectId: number, sessionId: string, title: string): Promise<TerminalRestSession> {
    return this.#terminalMutation(projectId, sessionId, '/actions/rename', { title });
  }

  #terminalSessionAction(
    projectId: number,
    sessionId: string,
    action: 'kill' | 'close' | 'clear',
  ): Promise<TerminalRestSession> {
    return this.#terminalMutation(projectId, sessionId, `/actions/${action}`, {});
  }

  #terminalMutation(
    projectId: number,
    sessionId: string,
    suffix: string,
    body: Record<string, unknown>,
  ): Promise<TerminalRestSession> {
    const project = positiveInteger(projectId, 'invalid_project_id');
    const session = terminalSessionID(sessionId);
    return this.#request(
      `/api/v1/terminals/${encodeURIComponent(session)}${suffix}?project_id=${project}`,
      undefined,
      (value) => validateSuccessEnvelope(value, validateTerminalRestSession).data,
      { method: 'POST', body, idempotencyKey: this.#newIdempotencyKey(), retryTransportFailure: true },
    );
  }

  #terminalReplay(projectId: number, sessionId: string, lastSeq: number): Promise<TerminalRestReplay> {
    const project = positiveInteger(projectId, 'invalid_project_id');
    const session = terminalSessionID(sessionId);
    const sequence = nonNegativeInteger(lastSeq, 'terminal_invalid_payload');
    if (sequence > 9007199254740991) throw new HttpClientError('terminal_invalid_payload');
    return this.#request(
      `/api/v1/terminals/${encodeURIComponent(session)}/replay?project_id=${project}&last_seq=${sequence}`,
      undefined,
      (value) => validateSuccessEnvelope(value, validateTerminalRestReplay).data,
    );
  }

  #connectEventStream(options: {
    projectId: number;
    source: 'project' | 'operation';
    path: string;
    operationId?: string;
    onState?: EventHandler<ProjectEventConnectionUpdate>;
    onEvent?: EventHandler<ProjectEventDelivery>;
  }): ResumableEventSubscription {
    if (options.onState !== undefined && typeof options.onState !== 'function' ||
        options.onEvent !== undefined && typeof options.onEvent !== 'function') {
      throw new HttpClientError('invalid_event_handler');
    }
    const watermarkKey = `${options.source}:${options.projectId}:${options.operationId ?? ''}`;
    const createEventStream = typeof createResumableEventStream === 'function'
      ? createResumableEventStream
      : createCompatibilityEventStream;
    const stream = createEventStream({
      projectId: options.projectId,
      requireContiguousRevisions: options.source === 'project',
      initialWatermark: this.#eventWatermarks.get(watermarkKey),
      open: async (lastEventId, signal) => {
        const response = await this.#fetchResponse(
          options.path,
          signal,
          EVENT_STREAM_CONTENT_TYPE,
          false,
          'GET',
          undefined,
          undefined,
          lastEventId,
        );
        if (!response.ok) await responseFailure(response);
        if (mediaType(response.headers.get('Content-Type')) !== EVENT_STREAM_CONTENT_TYPE) {
          throw new HttpClientError('invalid_content_type', response.status);
        }
        return response;
      },
      onEvent: (event) => {
        options.onEvent?.({ kind: 'event', projectId: options.projectId, source: options.source, event });
      },
      onResync: (reason) => {
        options.onEvent?.({ kind: 'resync', projectId: options.projectId, source: options.source, reason });
      },
      onWatermark: (watermark) => this.#recordEventWatermark(watermarkKey, watermark),
      onState: (state, attempt) => options.onState?.({
        projectId: options.projectId, state, attempt,
        ...(options.operationId ? { operationId: options.operationId } : {}),
        ...(options.operationId && this.#operationOwners.get(options.operationId)
          ? { runtimeOwner: this.#operationOwners.get(options.operationId) }
          : {}),
      }),
      isRetryable: (error) => !(error instanceof HttpClientError) || error.retryable || error.status >= 500,
    });
    let stopped = false;
    let unsubscribe: ResumableEventSubscription;
    unsubscribe = (() => {
      if (stopped) return;
      stopped = true;
      stream();
      this.#eventConnections.delete(unsubscribe);
    }) as ResumableEventSubscription;
    unsubscribe.completeResync = () => stream.completeResync();
    this.#eventConnections.add(unsubscribe);
    return unsubscribe;
  }

  async #readChatPages<TItem, TResult>(
    path: string,
    validate: (value: unknown) => HttpCursorPage<TItem>,
    map: (item: TItem) => TResult,
  ): Promise<TResult[]> {
    const result: TResult[] = [];
    let cursor = '';
    for (let page = 0; page < 100; page += 1) {
      const query = `?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await this.#request(`${path}${query}`, undefined, validate);
      result.push(...response.data.map(map));
      if (!response.next_cursor) return result;
      if (response.next_cursor === cursor) throw new HttpClientError('invalid_response');
      cursor = response.next_cursor;
    }
    throw new HttpClientError('invalid_response');
  }

  async #chatQueueMutation(
    projectId: number,
    conversationId: number,
    itemId: number,
    method: 'PATCH' | 'DELETE',
    body: Record<string, unknown> | undefined,
    intent: object,
  ): Promise<{ ok: boolean }> {
    return this.#request(
      `${chatConversationPath(projectId, conversationId)}/queue/${itemId}`,
      undefined,
      (value) => validateSuccessEnvelope(value, validateChatBoolean).data,
      { method, ...(body === undefined ? {} : { body }), idempotencyKey: this.#idempotencyKeyFor(intent) },
    );
  }

  #deliverChatEvent(
    projectId: number,
    conversationId: number,
    event: ChatSSEEventEnvelope,
    handlers: Parameters<HttpChatOperations['connectChatEvents']>[2],
    chunkSequences: Map<string, number>,
  ): void {
    switch (event.type) {
      case 'chat_chunk': {
        const chunk = validateChatChunk(event.data, projectId, conversationId);
        const previous = chunkSequences.get(chunk.turnId);
        if (previous !== undefined && chunk.sequence <= previous) return;
        if (previous !== undefined && chunk.sequence !== previous + 1) throw new HttpClientError('invalid_response');
        chunkSequences.set(chunk.turnId, chunk.sequence);
        while (chunkSequences.size > 64) {
          const oldest = chunkSequences.keys().next().value;
          if (oldest === undefined) break;
          chunkSequences.delete(oldest);
        }
        handlers.onChunk?.({ type: chunk.type, data: chunk.data });
        return;
      }
      case 'chat_queue': {
        const queue = validateChatQueue(event.data);
        if (queue.projectId !== projectId || queue.conversationId !== conversationId) throw new HttpClientError('invalid_response');
        handlers.onQueue?.({ conversationId: queue.conversationId, items: queue.items, count: queue.count });
        return;
      }
      case 'chat_done': {
        const done = validateChatDone(event.data, projectId, conversationId);
        chunkSequences.delete(done.turnId);
        handlers.onDone?.(done);
        return;
      }
    }
  }

  #recordEventWatermark(key: string, watermark: EventStreamWatermark): void {
    this.#eventWatermarks.delete(key);
    this.#eventWatermarks.set(key, watermark);
    while (this.#eventWatermarks.size > MAXIMUM_EVENT_WATERMARKS) {
      const oldest = this.#eventWatermarks.keys().next().value;
      if (oldest === undefined) return;
      this.#eventWatermarks.delete(oldest);
    }
  }

  #capabilities(): Promise<HttpCapabilityDiscovery> {
    this.#capabilityDiscovery ??= this.#discoverCapabilities(undefined);
    return this.#capabilityDiscovery;
  }

  #discoverCapabilities(signal: AbortSignal | undefined): Promise<HttpCapabilityDiscovery> {
    return this.#request(
      '/api/v1/capabilities',
      signal,
      (value) => validateSuccessEnvelope(value, validateCapabilityDiscovery),
    ).then((envelope) => ({ ...envelope.data, request_id: envelope.request_id }));
  }

  async #supportsCapabilities(capabilities: readonly string[]): Promise<boolean> {
    try {
      const discovered = await this.#capabilities();
      const enabled = new Map(discovered.capabilities.map((capability) => [capability.id, capability.enabled]));
      return capabilities.every((capability) => enabled.get(capability) === true);
    } catch {
      // Discovery is read-only. Falling back before a persistence request is
      // issued preserves the established IPC owner and cannot duplicate a
      // mutation. Once an HTTP persistence request starts, no fallback occurs.
      return false;
    }
  }

  #runtimeFeatureEnabled(feature: RuntimeFeatureFlag): boolean {
    return this.#runtimeFeatures[feature] === true;
  }

  async #nodeRuntime<T>(operation: () => Promise<T>): Promise<T> {
    const result = await operation();
    this.#recordNodeOperationOwner(result);
    return result;
  }

  async #submitRuntimeAction(
    feature: RuntimeFeatureFlag,
    projectId: number,
    path: string,
    body: Record<string, unknown>,
    intent: object,
  ): Promise<AppSnapshot> {
    if (!this.#runtimeFeatureEnabled(feature)) throw new HttpClientError('runtime_feature_disabled');
    const accepted = await this.#request(
      path,
      undefined,
      (value) => validateSuccessEnvelope(value, validateRuntimeOperationAccepted).data,
      {
        method: 'POST',
        body,
        // Runtime actions are never retried here. An unknown acceptance is
        // recovered only through the fixed Operation id/SSE owner, never by
        // replaying a mutation through Node.
        idempotencyKey: this.#idempotencyKeyFor(intent),
      },
    );
    this.#operationOwners.set(accepted.operation_id, 'go');
    this.#followRuntimeOperation(projectId, accepted);
    return this.getProjectSnapshot(projectId);
  }

  async #refreshProjectSnapshot(projectId: number): Promise<AppSnapshot> {
    const snapshot = await this.getProjectSnapshot(projectId);
    this.#recordSnapshotVersion(snapshot);
    return snapshot;
  }

  #submitIntakePlanAction(
    input: IntakeActionInput,
    action: 'interrupt' | 'resume' | 'append-task',
    body: Record<string, unknown>,
  ): Promise<AppSnapshot> {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const intakeId = positiveInteger(input?.id, 'invalid_intake');
    if (input?.type !== 'requirement' && input?.type !== 'feedback') {
      throw new HttpClientError('invalid_intake');
    }
    return this.#intakeMutation(
      `/api/v1/projects/${projectId}/intake/${input.type}/${intakeId}/actions/${action}`,
      'POST', body, input, undefined, `intake:${input.type}:${intakeId}`,
    );
  }

  async #submitProcessAction(
    feature: RuntimeFeatureFlag,
    projectId: number,
    path: string,
    intent: object,
    acceptedTypes: readonly string[],
  ): Promise<ProcessActionResult> {
    if (!this.#runtimeFeatureEnabled(feature)) throw new HttpClientError('runtime_feature_disabled');
    const operation = await this.#request(
      path,
      undefined,
      (value) => validateSuccessEnvelope(value, (data) => validateProcessOperationAccepted(data, acceptedTypes)).data,
      {
        method: 'POST',
        body: {},
        // A connection error after submission is intentionally visible to the
        // caller. Replaying through Node would create a second owner; callers
        // can instead observe the fixed Operation through SSE.
        idempotencyKey: this.#idempotencyKeyFor(intent),
      },
    );
    this.#operationOwners.set(operation.operation_id, 'go');
    this.#followRuntimeOperation(projectId, operation);
    const snapshot = await this.getProjectSnapshot(projectId);
    this.#recordSnapshotVersion(snapshot);
    return { operation, snapshot };
  }

  async #submitProcessStop(
    feature: RuntimeFeatureFlag,
    projectId: number,
    path: string,
    intent: object,
    acceptedTypes: readonly string[],
  ): Promise<AppSnapshot> {
    if (!this.#runtimeFeatureEnabled(feature)) throw new HttpClientError('runtime_feature_disabled');
    const result = await this.#request(
      path,
      undefined,
      (value) => validateSuccessEnvelope(value, (data) => validateProcessStopResult(data, acceptedTypes)).data,
      {
        method: 'POST',
        body: {},
        idempotencyKey: this.#idempotencyKeyFor(intent),
      },
    );
    if (result.operation !== null) {
      this.#operationOwners.set(result.operation.operation_id, 'go');
      this.#followRuntimeOperation(projectId, result.operation);
    }
    const snapshot = await this.getProjectSnapshot(projectId);
    this.#recordSnapshotVersion(snapshot);
    return snapshot;
  }

  async #submitAcceptanceAction(
    action: 'accept' | 'unaccept' | 'redo',
    input: AcceptanceItemInput | AcceptanceRedoInput,
  ): Promise<AppSnapshot> {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const target = runtimeAcceptanceTarget(input);
    if (!this.#runtimeFeatureEnabled('go_acceptance_retry_actions')) {
      if (action === 'accept') return this.#nodeRuntime(() => this.#delegate.acceptItem(input));
      if (action === 'unaccept') return this.#nodeRuntime(() => this.#delegate.unacceptItem(input));
      return this.#nodeRuntime(() => this.#delegate.redoAcceptanceItem(input as AcceptanceRedoInput));
    }
    const supplement = action === 'redo' ? (input as AcceptanceRedoInput).supplement : undefined;
    if (supplement !== undefined && supplement !== null &&
        (typeof supplement !== 'string' || supplement.length > 2000 || /[\r\0]/.test(supplement))) {
      throw new HttpClientError('invalid_acceptance');
    }
    return this.#submitRuntimeAction('go_acceptance_retry_actions', projectId,
      `/api/v1/projects/${projectId}/acceptance/actions/${action}`,
      { ...target, ...(typeof supplement === 'string' ? { supplement } : {}) }, input);
  }

  async #submitAcceptanceBatchAction(
    action: 'accept-batch' | 'unaccept-batch',
    input: AcceptBatchInput,
  ): Promise<AppSnapshot> {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    if (!Array.isArray(input?.targets) || input.targets.length === 0 || input.targets.length > 100) {
      throw new HttpClientError('invalid_acceptance');
    }
    if (!this.#runtimeFeatureEnabled('go_acceptance_retry_actions')) {
      return action === 'accept-batch'
        ? this.#nodeRuntime(() => this.#delegate.acceptItems(input))
        : this.#nodeRuntime(() => this.#delegate.unacceptItems(input));
    }
    return this.#submitRuntimeAction('go_acceptance_retry_actions', projectId,
      `/api/v1/projects/${projectId}/acceptance/actions/${action}`,
      { targets: input.targets.map((target) => runtimeAcceptanceTarget(target)) }, input);
  }

  #followRuntimeOperation(projectId: number, accepted: RuntimeOperationAccepted): void {
    this.#operationStreams.get(accepted.operation_id)?.();
    let stream: ResumableEventSubscription | null = null;
    stream = this.connectOperationEvents(projectId, accepted.operation_id, undefined, (delivery) => {
      if (delivery.kind !== 'event' || delivery.event.operation_id !== accepted.operation_id) return;
      if (isTerminalOperationEvent(delivery.event)) {
        stream?.();
        this.#operationStreams.delete(accepted.operation_id);
      }
    });
    this.#operationStreams.set(accepted.operation_id, stream);
  }

  #recordNodeOperationOwner(value: unknown): void {
    if (!isRecord(value)) return;
    for (const candidate of [value.activeOperation, value.lastOperation]) {
      if (!isRecord(candidate)) continue;
      const operationID = candidate.operation_id ?? candidate.operationId;
      if (validOperationID(operationID)) this.#operationOwners.set(operationID, 'node');
    }
  }

  async #planMutationContext(
    intent: object,
    operation: string,
    projectId: number,
    signal: AbortSignal | undefined,
  ): Promise<PlanMutationContext> {
    if (!intent || typeof intent !== 'object') throw new HttpClientError('invalid_request');
    let contexts = this.#planMutationContexts.get(intent);
    const existing = contexts?.get(operation);
    if (existing) {
      if (existing.projectId !== projectId) throw new HttpClientError('invalid_request');
      return existing;
    }
    const snapshot = await this.getProjectSnapshot(projectId, { signal });
    const context: PlanMutationContext = {
      projectId,
      plans: new Map<number, Plan>(plansFromSnapshot(snapshot, projectId).map(
        (plan): [number, Plan] => [plan.id, plan],
      )),
      tasks: new Map<number, PlanTask>(tasksFromSnapshot(snapshot, projectId).map(
        (task): [number, PlanTask] => [task.id, task],
      )),
    };
    contexts ??= new Map<string, PlanMutationContext>();
    contexts.set(operation, context);
    this.#planMutationContexts.set(intent, contexts);
    return context;
  }

  async #planMutation(
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body: Record<string, unknown>,
    intent: object,
    signal: AbortSignal | undefined,
    scope: string,
  ): Promise<AppSnapshot> {
    const generation = this.#beginMutation(scope);
    const result = await this.#request(
      path,
      signal,
      (value) => validateSuccessEnvelope(value, validatePlanMutation).data,
      {
        method,
        body,
        idempotencyKey: this.#idempotencyKeyFor(intent),
      },
    );
    const snapshot = this.#normalizeSnapshot(result.snapshot);
    this.#assertCurrentMutation(scope, generation);
    this.#recordSnapshotVersion(snapshot);
    return snapshot;
  }

  async #setAcceptance(
    input: AcceptanceItemInput,
    accept: boolean,
    options: HttpMutationOptions,
  ): Promise<AppSnapshot> {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const capability = acceptanceCapability(input?.targetType, accept ? 'accept' : 'unaccept');
    if (!(await this.#supportsCapabilities([capability]))) {
      return accept ? this.#delegate.acceptItem(input) : this.#delegate.unacceptItem(input);
    }
    const context = await this.#planMutationContext(input, accept ? 'accept' : 'unaccept', projectId, options.signal);
    return this.#planMutation(
      `/api/v1/plans/${accept ? 'accept' : 'unaccept'}`,
      'POST',
      { project_id: projectId, target: acceptanceTarget(input, context) },
      input,
      options.signal,
      `plans:${projectId}`,
    );
  }

  async #setAcceptances(
    input: AcceptBatchInput,
    accept: boolean,
    options: HttpMutationOptions,
  ): Promise<AppSnapshot> {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    if (!Array.isArray(input?.targets) || input.targets.length === 0) {
      throw new HttpClientError('invalid_acceptance');
    }
    const capabilities = [...new Set(input.targets.map((target) =>
      acceptanceCapability(target?.targetType, accept ? 'accept' : 'unaccept')),
    )];
    if (!(await this.#supportsCapabilities(capabilities))) {
      return accept ? this.#delegate.acceptItems(input) : this.#delegate.unacceptItems(input);
    }
    const context = await this.#planMutationContext(input, accept ? 'accept-batch' : 'unaccept-batch', projectId, options.signal);
    const targets = input.targets.map((target) => acceptanceTarget(target, context));
    return this.#planMutation(
      `/api/v1/plans/${accept ? 'accept' : 'unaccept'}-batch`,
      'POST',
      { project_id: projectId, targets },
      input,
      options.signal,
      `plans:${projectId}`,
    );
  }

  async #listAllProjects(signal: AbortSignal): Promise<Project[]> {
    const projects: Project[] = [];
    let page = 1;
    let expectedTotal: number | null = null;
    for (let requestCount = 0; requestCount < 10_000; requestCount += 1) {
      const result = await this.listProjects({ page, pageSize: 200, signal });
      if (result.pagination.page !== page || result.pagination.page_size !== 200)
        throw new HttpClientError('invalid_pagination');
      expectedTotal ??= result.pagination.total;
      if (result.pagination.total !== expectedTotal) {
        throw new HttpClientError('pagination_changed');
      }
      projects.push(...result.data);
      if (new Set(projects.map((project) => project.id)).size !== projects.length)
        throw new HttpClientError('invalid_pagination');
      if (result.pagination.next_page === null) {
        if (projects.length !== expectedTotal) throw new HttpClientError('invalid_pagination');
        return projects;
      }
      if (result.pagination.next_page !== page + 1) {
        throw new HttpClientError('invalid_pagination');
      }
      page = result.pagination.next_page;
    }
    throw new HttpClientError('pagination_limit_exceeded');
  }

  async #listIntakes<TItem extends Requirement | Feedback>(
    type: IntakeType,
    request: IntakePageRequest,
  ): Promise<IntakePage<TItem>> {
    const projectId = positiveInteger(request?.projectId, 'invalid_project_id');
    const page = positiveInteger(request.page ?? 1, 'invalid_pagination');
    const pageSize = positiveInteger(request.pageSize ?? 50, 'invalid_pagination');
    if (pageSize > 200 || (request.status !== undefined && !validIntakeStatus(request.status))) {
      throw new HttpClientError('invalid_pagination');
    }
    const status = request.status === undefined ? '' : `&status=${encodeURIComponent(request.status)}`;
    return this.#request(
      `/api/v1/projects/${projectId}/${intakeCollection(type)}?page=${page}&page_size=${pageSize}${status}`,
      request.signal,
      (value) => validateIntakePage<TItem>(value, type),
    );
  }

  #getIntake<TItem extends Requirement | Feedback>(
    type: IntakeType,
    projectId: number,
    intakeId: number,
    signal: AbortSignal | undefined,
  ): Promise<TItem> {
    const ownerProjectID = positiveInteger(projectId, 'invalid_project_id');
    const id = positiveInteger(intakeId, 'invalid_intake');
    return this.#request(
      `/api/v1/projects/${ownerProjectID}/${intakeCollection(type)}/${id}`,
      signal,
      (value) => validateSuccessEnvelope(value, (item) => validateIntake<TItem>(item, type)).data,
    );
  }

  async #createIntake(
    type: IntakeType,
    input: CreateIntakeInput,
    options: HttpMutationOptions,
  ): Promise<AppSnapshot> {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    if (!input || typeof input !== 'object' || (input as CreateIntakeInput & { autoRun?: unknown }).autoRun === true) {
      throw new HttpClientError('not_implemented');
    }
    const attachments = preparePendingAttachments(input.attachments ?? []);
    const snapshot = await this.#intakeMutation(
      `/api/v1/projects/${projectId}/${intakeCollection(type)}`,
      'POST',
      intakeCreateBody(type, input),
      input,
      options.signal,
    );
    if (!attachments.length) return snapshot;
    const owner = latestIntakeFromSnapshot(snapshot, type, projectId);
    const totalBytes = attachmentBytes(attachments);
    let uploadedBytes = 0;
    reportUploadProgress(options.onUploadProgress, uploadedBytes, totalBytes);
    for (let index = 0; index < attachments.length; index += 1) {
      await this.#uploadPreparedAttachment(type, projectId, owner.id, attachments[index], input, index, options.signal);
      uploadedBytes += attachments[index].blob.size;
      reportUploadProgress(options.onUploadProgress, uploadedBytes, totalBytes);
    }
    return this.getProjectSnapshot(projectId, { signal: options.signal });
  }

  async #updateIntake(
    type: IntakeType,
    input: UpdateRequirementInput | UpdateFeedbackInput,
    options: HttpMutationOptions,
  ): Promise<AppSnapshot> {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const id = positiveInteger(input?.id, 'invalid_intake');
    const attachments = preparePendingAttachments(input.attachments ?? []);
    const snapshot = await this.#intakeMutation(
      `/api/v1/projects/${projectId}/${intakeCollection(type)}/${id}`,
      'PATCH',
      intakeUpdateBody(type, input),
      input,
      options.signal,
      `intake:${type}:${id}`,
    );
    const totalBytes = attachmentBytes(attachments);
    let uploadedBytes = 0;
    if (attachments.length) reportUploadProgress(options.onUploadProgress, uploadedBytes, totalBytes);
    for (let index = 0; index < attachments.length; index += 1) {
      await this.#uploadPreparedAttachment(type, projectId, id, attachments[index], input, index, options.signal);
      uploadedBytes += attachments[index].blob.size;
      reportUploadProgress(options.onUploadProgress, uploadedBytes, totalBytes);
    }
    return attachments.length ? this.getProjectSnapshot(projectId, { signal: options.signal }) : snapshot;
  }

  #deleteIntake(
    type: IntakeType,
    input: ProjectIdInput & { id: number },
    signal: AbortSignal | undefined,
  ): Promise<AppSnapshot> {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const id = positiveInteger(input?.id, 'invalid_intake');
    return this.#intakeMutation(
      `/api/v1/projects/${projectId}/${intakeCollection(type)}/${id}`,
      'DELETE',
      undefined,
      input,
      signal,
      `intake:${type}:${id}`,
    );
  }

  #setIntakeAcceptance(
    input: IntakeAcceptanceInput,
    accept: boolean,
    signal: AbortSignal | undefined,
  ): Promise<AppSnapshot> {
    const projectId = positiveInteger(input?.projectId, 'invalid_project_id');
    const id = positiveInteger(input?.id, 'invalid_intake');
    if (input.type !== 'requirement' && input.type !== 'feedback') throw new HttpClientError('invalid_intake');
    return this.#intakeMutation(
      `/api/v1/projects/${projectId}/${intakeCollection(input.type)}/${id}/accept`,
      accept ? 'POST' : 'DELETE',
      undefined,
      input,
      signal,
      `intake:${input.type}:${id}`,
    );
  }

  #listPlanLinks(
    type: IntakeType,
    projectId: number,
    intakeId: number,
    signal: AbortSignal | undefined,
  ): Promise<IntakePlanLink[]> {
    const ownerProjectID = positiveInteger(projectId, 'invalid_project_id');
    const id = positiveInteger(intakeId, 'invalid_intake');
    return this.#request(
      `/api/v1/projects/${ownerProjectID}/${intakeCollection(type)}/${id}/plan-links`,
      signal,
      (value) => validateSuccessEnvelope(value, validatePlanLinks).data,
    );
  }

  #replacePlanLinks(
    type: IntakeType,
    projectId: number,
    intakeId: number,
    links: IntakePlanLinkInput[],
    signal: AbortSignal | undefined,
  ): Promise<AppSnapshot> {
    const ownerProjectID = positiveInteger(projectId, 'invalid_project_id');
    const id = positiveInteger(intakeId, 'invalid_intake');
    const intent = { projectId: ownerProjectID, id, type, links };
    return this.#intakeMutation(
      `/api/v1/projects/${ownerProjectID}/${intakeCollection(type)}/${id}/plan-links`,
      'PUT',
      { links: planLinksBody(links) },
      intent,
      signal,
      `intake:${type}:${id}`,
    );
  }

  async #uploadPreparedAttachment(
    type: IntakeType,
    projectId: number,
    intakeId: number,
    attachment: PreparedAttachment,
    intent: object,
    attachmentIndex: number,
    signal: AbortSignal | undefined,
  ): Promise<AttachmentUploadResult> {
    const formData = createAttachmentFormData(attachment);
    const result = await this.#request(
      `/api/v1/projects/${projectId}/${intakeCollection(type)}/${intakeId}/attachments`,
      signal,
      (value) => validateSuccessEnvelope(value, validateAttachmentUpload).data,
      {
        method: 'POST',
        formData,
        idempotencyKey: this.#attachmentIdempotencyKeyFor(intent, attachmentIndex),
        retryTransportFailure: true,
      },
    );
    return {
      ...result,
      attachment: this.#normalizeAttachment(result.attachment, projectId),
    };
  }

  async #intakeMutation(
    path: string,
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    body: unknown,
    intent: object,
    signal: AbortSignal | undefined,
    scope?: string,
  ): Promise<AppSnapshot> {
    const generation = scope === undefined ? null : this.#beginMutation(scope);
    const result = await this.#request(
      path,
      signal,
      (value) => validateSuccessEnvelope(value, validateIntakeMutation).data,
      {
        method,
        ...(body === undefined ? {} : { body }),
        idempotencyKey: this.#idempotencyKeyFor(intent),
        retryTransportFailure: true,
      },
    );
    const snapshot = this.#normalizeSnapshot(result.snapshot);
    if (scope !== undefined && generation !== null) this.#assertCurrentMutation(scope, generation);
    this.#recordSnapshotVersion(snapshot);
    return snapshot;
  }

  #normalizeSnapshot(snapshot: AppSnapshot): AppSnapshot {
    const projectId = snapshot.activeProjectId;
    if (!safeInteger(projectId) || projectId <= 0) return snapshot;
    return {
      ...snapshot,
      attachments: snapshot.attachments.map((attachment) => this.#normalizeAttachment(attachment, projectId)),
    };
  }

  #normalizeAttachment(attachment: Attachment, projectId: number): Attachment {
    return {
      ...attachment,
      download_url: controlledAttachmentURL(attachment.download_url, projectId, this.#baseUrl),
    };
  }

  async #snapshotMutation(
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    intent: object,
    signal: AbortSignal | undefined,
    scope?: string,
  ): Promise<AppSnapshot> {
    const generation = scope === undefined ? null : this.#beginMutation(scope);
    const response = await this.#request(
      path,
      signal,
      (value) => validateSuccessEnvelope(value, validateSnapshot).data,
      {
        method,
        ...(body === undefined ? {} : { body }),
        idempotencyKey: this.#idempotencyKeyFor(intent),
        retryTransportFailure: true,
      },
    );
    const snapshot = this.#normalizeSnapshot(response);
    if (scope !== undefined && generation !== null) {
      this.#assertCurrentMutation(scope, generation);
    }
    this.#recordSnapshotVersion(snapshot);
    return snapshot;
  }

  #staticMutation<T>(
    path: string,
    method: 'POST' | 'PATCH',
    input: Record<string, unknown>,
    options: HttpMutationOptions,
    validate: (value: unknown) => T,
  ): Promise<T> {
    if (!isRecord(input)) throw new HttpClientError('invalid_request');
    return this.#request(path, options.signal, (value) => validateSuccessEnvelope(value, validate).data, {
      method,
      body: input,
      idempotencyKey: this.#idempotencyKeyFor(options),
      retryTransportFailure: true,
    });
  }

  #idempotencyKeyFor(intent: object): string {
    if (!intent || typeof intent !== 'object') {
      throw new HttpClientError('invalid_request');
    }
    const existing = this.#idempotencyKeys.get(intent);
    if (existing) return existing;
    const key = this.#newIdempotencyKey();
    this.#idempotencyKeys.set(intent, key);
    return key;
  }

  #attachmentIdempotencyKeyFor(intent: object, index: number): string {
    if (!intent || typeof intent !== 'object' || !Number.isInteger(index) || index < 0) {
      throw new HttpClientError('invalid_attachment');
    }
    let keys = this.#attachmentIdempotencyKeys.get(intent);
    const existing = keys?.get(index);
    if (existing) return existing;
    const key = this.#newIdempotencyKey();
    keys ??= new Map<number, string>();
    keys.set(index, key);
    this.#attachmentIdempotencyKeys.set(intent, keys);
    return key;
  }

  #newIdempotencyKey(): string {
    let key: string;
    try {
      key = this.#idempotencyKeyFactory();
    } catch {
      throw configurationError();
    }
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) throw configurationError();
    return key;
  }

  #beginMutation(scope: string): number {
    const generation = (this.#mutationGenerations.get(scope) ?? 0) + 1;
    this.#mutationGenerations.set(scope, generation);
    return generation;
  }

  #assertCurrentMutation(scope: string, generation: number): void {
    if (this.#mutationGenerations.get(scope) !== generation) {
      throw new HttpClientError('mutation_response_superseded');
    }
  }

  #recordSnapshotVersion(snapshot: AppSnapshot): void {
    const state = snapshot.state;
    if (!isRecord(state) || !safeInteger(state.project_id) || state.project_id <= 0 ||
        !safeInteger(state.version) || state.version <= 0) return;
    const current = this.#projectVersions.get(state.project_id) ?? 0;
    if (state.version >= current) this.#projectVersions.set(state.project_id, state.version);
  }

  #recordFilePolicy(policy: FilePolicyContract): void {
    if (this.#filePolicy === null || policy.version >= this.#filePolicy.version) {
      this.#filePolicy = { ...policy, allowed_roots: [...policy.allowed_roots] };
    }
  }

  async #request<T>(
    path: string,
    externalSignal: AbortSignal | undefined,
    validate: (value: unknown) => T,
    options: RequestInitOptions = {},
  ): Promise<T> {
    if (options.body !== undefined && options.formData !== undefined) throw new HttpClientError('invalid_request');
    const body = options.formData ?? serializeRequestBody(options.body);
    const attempts = options.retryTransportFailure ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const control = requestControl(externalSignal, this.#timeoutMs);
      try {
        const response = await this.#fetchResponse(
          path,
          control.signal,
          JSON_CONTENT_TYPE,
          true,
          options.method ?? 'GET',
          body,
          options.idempotencyKey,
        );
        if (!response.ok) await responseFailure(response);
        const value = await responseJSON(response);
        const result = validate(value);
        assertResponseRequestID(response, requestIDOf(value));
        return result;
      } catch (error) {
        const failure = normalizeRequestFailure(error, control);
        if (typeof window !== 'undefined' && failure.code === 'network_error') {
          // Paths are fixed application routes and never contain credentials.
          // Keep Chromium's otherwise opaque fetch failure actionable in the
          // Electron development terminal.
          console.error(`[autoplan] HTTP network error: ${options.method ?? 'GET'} ${path}`);
        }
        if (attempt + 1 < attempts && isRetryableTransportFailure(failure) &&
            !externalSignal?.aborted) continue;
        throw failure;
      } finally {
        control.cleanup();
      }
    }
    throw new HttpClientError('network_error', 0, true);
  }

  #fetchResponse(
    path: string,
    signal: AbortSignal,
    accept: string,
    jsonResponse: boolean,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'GET',
    body?: string | FormData,
    idempotencyKey?: string,
    lastEventId?: string | null,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: accept };
    if (this.#credentialMode === 'header' && this.#sessionCredential) {
      headers[AUTOPLAN_SESSION_HEADER] = this.#sessionCredential;
    }
    if (typeof body === 'string') headers['Content-Type'] = JSON_CONTENT_TYPE;
    if (idempotencyKey !== undefined) headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey;
    if (lastEventId !== null && lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;
    return this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      signal,
      ...(body === undefined ? {} : { body }),
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      ...(jsonResponse ? {} : { keepalive: false }),
    });
  }
}

function installDelegateForwarders(target: ForwardedTarget, delegate: AutoplanClient) {
  for (const key of AUTOPLAN_CLIENT_OPERATION_KEYS) {
    if (key === 'snapshot' || key === 'createProject' || key === 'updateProject' ||
        key === 'deleteProject' || key === 'configureLoop' || key === 'fileAccess' ||
        key === 'reorderPlans' || key === 'deletePlan' ||
        key === 'acceptItem' || key === 'unacceptItem' || key === 'redoAcceptanceItem' ||
        key === 'acceptItems' || key === 'unacceptItems' ||
        key === 'interruptIntake' || key === 'resumeIntake' || key === 'appendIntakeTask' ||
        key === 'startLoop' || key === 'stopLoop' || key === 'runOnce' ||
        key === 'stopPlan' || key === 'resumePlan' || key === 'reExecutePlan' ||
        key === 'recreatePlanFromIntake' ||
        key === 'runTask' || key === 'runTaskBatches' || key === 'stopTask' ||
        key === 'retryIntakePlanGeneration' || key === 'readPlan' ||
        key === 'createScript' || key === 'updateScript' || key === 'deleteScript' || key === 'toggleScript' ||
        key === 'runScript' || key === 'stopScript' ||
        key === 'runExecutor' || key === 'stopExecutor' || key === 'runExecutorAction' ||
        key === 'createTerminal' || key === 'listTerminals' || key === 'writeTerminal' ||
        key === 'resizeTerminal' || key === 'killTerminal' || key === 'closeTerminal' ||
        key === 'renameTerminal' || key === 'replayTerminal' || key === 'clearTerminal' ||
        key === 'chatSend' || key === 'chatStop' || key === 'chatClear' || key === 'chatHistory' ||
        key === 'chatSaveConfig' || key === 'chatGetConfig' ||
        key === 'chatQueueList' || key === 'chatQueueCancel' || key === 'chatQueueEdit' || key === 'chatQueueClear' ||
        key === 'conversationList' || key === 'conversationCreate' || key === 'conversationUpdate' || key === 'conversationDelete' ||
        key === 'aiConfigList' || key === 'aiConfigCreate' || key === 'aiConfigUpdate' || key === 'aiConfigDelete' || key === 'aiConfigGet' ||
        key === 'claudeCliConfigList' || key === 'claudeCliConfigCreate' || key === 'claudeCliConfigUpdate' ||
        key === 'claudeCliConfigDelete' || key === 'claudeCliConfigGet' || key === 'claudeCliConfigSetDefault' ||
        key === 'saveMcpConfig' ||
        key === 'acceptIntake' || key === 'unacceptIntake' ||
        key === 'createRequirement' || key === 'updateRequirement' || key === 'deleteRequirement' ||
        key === 'createFeedback' || key === 'updateFeedback' || key === 'deleteFeedback') continue;
    const value = delegate[key];
    if (key === 'mcpToolNames') {
      defineForwardedValue(target, key, value);
    } else {
      if (typeof value !== 'function') throw configurationError();
      defineForwardedValue(target, key, (...args: unknown[]) => Reflect.apply(value, delegate, args));
    }
  }
  for (const key of AUTOPLAN_CLIENT_EVENT_KEYS) {
    if (key === 'onTerminalData' || key === 'onTerminalExit' || key === 'onTerminalStatus' || key === 'onTerminalClosed') {
      continue;
    }
    const subscribe = delegate[key];
    if (typeof subscribe !== 'function') throw configurationError();
    defineForwardedValue(target, key, (...args: unknown[]) => Reflect.apply(subscribe, delegate, args));
  }
}

function defineForwardedValue(target: ForwardedTarget, key: PropertyKey, value: unknown) {
  Object.defineProperty(target, key, {
    configurable: false,
    enumerable: true,
    writable: false,
    value,
  });
}

function configurationError() {
  return new HttpClientError('http_configuration_invalid');
}

function normalizeLoopbackBaseUrl(value: string): string {
  if (typeof value !== 'string') throw configurationError();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configurationError();
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw configurationError();
  }
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw configurationError();
  return `http://127.0.0.1:${port}`;
}

function normalizeRuntimeFeatures(
  value: Partial<Record<RuntimeFeatureFlag, boolean>> | undefined,
): RuntimeFeatureFlags {
  if (value === undefined) return DEFAULT_RUNTIME_FEATURES;
  if (!isRecord(value)) return DEFAULT_RUNTIME_FEATURES;
  const result: Record<RuntimeFeatureFlag, boolean> = { ...DEFAULT_RUNTIME_FEATURES };
  for (const [key, enabled] of Object.entries(value)) {
    // A malformed, partial or future handoff cannot grant a runtime owner.
    // Close every process gate instead of accepting a mixed feature document.
    if (!(key in result) || typeof enabled !== 'boolean') return DEFAULT_RUNTIME_FEATURES;
    result[key as RuntimeFeatureFlag] = enabled;
  }
  return Object.freeze(result);
}

function validOperationID(value: unknown): value is string {
  return typeof value === 'string' && OPERATION_ID_PATTERN.test(value);
}

function runtimeTaskBatches(value: RunTaskBatchesInput['batches']): Array<{ task_ids: number[] }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new HttpClientError('invalid_task');
  }
  const seen = new Set<number>();
  return value.map((batch) => {
    if (!batch || !Array.isArray(batch.taskIds) || batch.taskIds.length === 0 || batch.taskIds.length > 100) {
      throw new HttpClientError('invalid_task');
    }
    return {
      task_ids: batch.taskIds.map((taskId) => {
        const id = positiveInteger(taskId, 'invalid_task');
        if (seen.has(id)) throw new HttpClientError('invalid_task');
        seen.add(id);
        return id;
      }),
    };
  });
}

function runtimeAcceptanceTarget(input: AcceptanceItemInput): { target_type: 'plan' | 'task'; id: number } {
  if (input?.targetType !== 'plan' && input?.targetType !== 'task') throw new HttpClientError('invalid_acceptance');
  return { target_type: input.targetType, id: positiveInteger(input.id, 'invalid_acceptance') };
}

function staticScriptInput(input: CreateScriptInput): Record<string, unknown> {
  if (!isRecord(input)) throw new HttpClientError('invalid_automation');
  const result: Record<string, unknown> = {};
  const fields: Array<[string, unknown]> = [
    ['name', input.name], ['runtime', input.runtime], ['body', input.body], ['path', input.path],
    ['source_type', input.sourceType ?? input.source_type], ['description', input.description],
    ['trigger_mode', input.triggerMode ?? input.trigger_mode], ['hook_stage', input.hookStage ?? input.hook_stage],
    ['schedule_cron', input.scheduleCron ?? input.schedule_cron], ['work_dir', input.workDir ?? input.work_dir],
    ['timeout_seconds', input.timeoutSeconds ?? input.timeout_seconds],
    ['context_inject', input.contextInject ?? input.context_inject], ['sort_order', input.sortOrder ?? input.sort_order],
  ];
  for (const [key, value] of fields) {
    if (value !== undefined) result[key] = value;
  }
  for (const [key, value] of [
    ['enabled', input.enabled], ['fail_aborts', input.failAborts ?? input.fail_aborts],
  ] as const) {
    if (value === undefined) continue;
    if (value !== true && value !== false && value !== 0 && value !== 1) {
      throw new HttpClientError('invalid_automation');
    }
    result[key] = Boolean(value);
  }
  return result;
}

function staticAIConfigInput(input: AiConfigCreateInput | AiConfigUpdateInput): Record<string, unknown> {
  if (!isRecord(input)) throw new HttpClientError('invalid_config');
  return compactObject({
    name: input.name,
    provider: input.provider,
    base_url: input.baseUrl,
    api_key: input.apiKey,
    model: input.model,
    temperature: input.temperature,
    thinking_depth: input.thinkingDepth === null ? '' : input.thinkingDepth,
    thinking_budget_tokens: input.thinkingBudgetTokens === null ? 0 : input.thinkingBudgetTokens,
  });
}

function chatAIConfigInput(input: ChatSaveConfigInput): Omit<AiConfigUpdateInput, 'configId'> {
  return compactObject({
    name: input.name,
    provider: input.provider,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    model: input.model,
    temperature: input.temperature,
    thinkingDepth: input.thinkingDepth,
    thinkingBudgetTokens: input.thinkingBudgetTokens,
  }) as Omit<AiConfigUpdateInput, 'configId'>;
}

function staticClaudeConfigInput(input: ClaudeCliConfigCreateInput | ClaudeCliConfigUpdateInput): Record<string, unknown> {
  if (!isRecord(input)) throw new HttpClientError('invalid_config');
  return compactObject({
    name: input.name,
    base_url: input.baseUrl,
    auth_token: input.authToken,
    model: input.model,
  });
}

function staticMCPConfigInput(input: McpConfigInput): Record<string, unknown> {
  if (!isRecord(input)) throw new HttpClientError('invalid_config');
  let port: number | undefined;
  if (input.port !== undefined) {
    const rawPort: unknown = input.port;
    const parsed = typeof rawPort === 'string' ? Number(rawPort.trim()) : rawPort;
    if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
      throw new HttpClientError('invalid_config');
    }
    port = parsed;
  }
  return compactObject({
    enabled: input.enabled,
    transport: input.transport,
    host: input.host,
    port,
    path: input.path,
    auth_token: input.authToken,
  });
}

function positiveInteger(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpClientError(code);
  }
  return value;
}

function nonNegativeInteger(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpClientError(code);
  }
  return value;
}

function positiveVersion(value: unknown): number {
  if (!safeInteger(value) || value <= 0) throw new HttpClientError('version_required');
  return value;
}

function requestControl(externalSignal: AbortSignal | undefined, timeoutMs: number): RequestControl {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

function normalizeRequestFailure(error: unknown, control: RequestControl): HttpClientError {
  if (error instanceof HttpClientError) return error;
  if (control.didTimeout()) return new HttpClientError('request_timeout', 0, true);
  if (control.signal.aborted) return new HttpClientError('request_cancelled');
  return new HttpClientError('network_error', 0, true);
}

function isRetryableTransportFailure(error: HttpClientError): boolean {
  return error.retryable && (error.code === 'network_error' || error.code === 'request_timeout');
}

function serializeRequestBody(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let body: string | undefined;
  try {
    body = JSON.stringify(value);
  } catch {
    throw new HttpClientError('invalid_request');
  }
  if (body === undefined) throw new HttpClientError('invalid_request');
  if (new TextEncoder().encode(body).byteLength > MAXIMUM_REQUEST_BYTES) {
    throw new HttpClientError('request_too_large');
  }
  return body;
}

function secureIdempotencyKey(): string {
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.getRandomValues !== 'function') throw configurationError();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `renderer:${hex}`;
}

function projectCreateBody(input: CreateProjectInput): Record<string, unknown> {
  if (!input || typeof input !== 'object') throw new HttpClientError('invalid_request');
  return compactObject({
    name: input.name,
    workspace_path: input.workspacePath,
    description: input.description,
    agent_cli_provider: input.agentCliProvider,
    agent_cli_command: input.agentCliCommand,
    codex_reasoning_effort: input.codexReasoningEffort,
    plan_generation_strategy: input.planGenerationStrategy,
    plan_generation_provider: input.planGenerationProvider,
    plan_generation_command: input.planGenerationCommand,
    plan_generation_model: input.planGenerationModel,
    plan_generation_codex_reasoning_effort: input.planGenerationCodexReasoningEffort,
    plan_execution_strategy: input.planExecutionStrategy,
    plan_execution_provider: input.planExecutionProvider,
    plan_execution_command: input.planExecutionCommand,
    plan_execution_model: input.planExecutionModel,
    plan_execution_codex_reasoning_effort: input.planExecutionCodexReasoningEffort,
  });
}

function projectUpdateBody(input: UpdateProjectInput): Record<string, unknown> {
  if (!input || typeof input !== 'object') throw new HttpClientError('invalid_request');
  return compactObject({
    name: input.name,
    workspace_path: input.workspacePath,
    description: input.description,
  });
}

function intakeCollection(type: IntakeType): 'requirements' | 'feedback' {
  if (type === 'requirement') return 'requirements';
  if (type === 'feedback') return 'feedback';
  throw new HttpClientError('invalid_intake');
}

function validIntakeStatus(value: unknown): value is string {
  return value === 'draft' || value === 'open' || value === 'completed' || value === 'closed';
}

function intakeCreateBody(type: IntakeType, input: CreateIntakeInput): Record<string, unknown> {
  if (!input || typeof input !== 'object' || typeof input.body !== 'string') {
    throw new HttpClientError('invalid_intake');
  }
  if (type === 'requirement' && input.requirementId !== undefined) throw new HttpClientError('invalid_intake');
  const record = input as unknown as Record<string, unknown>;
  const status = input.status ?? (record.createAsDraft === true ? 'draft' : undefined);
  if (status !== undefined && !validIntakeStatus(status)) throw new HttpClientError('invalid_intake');
  return compactObject({
    ...(type === 'feedback' ? { requirement_id: input.requirementId } : {}),
    title: input.title,
    body: input.body,
    status,
    agent_cli: intakeAgentCLIBody(record),
    plan_generation: intakePlanGenerationBody(record),
  });
}

function intakeUpdateBody(
  type: IntakeType,
  input: UpdateRequirementInput | UpdateFeedbackInput,
): Record<string, unknown> {
  if (!input || typeof input !== 'object') throw new HttpClientError('invalid_intake');
  const record = input as unknown as Record<string, unknown>;
  if (type === 'requirement' && hasOwn(record, 'requirementId')) throw new HttpClientError('invalid_intake');
  if (input.status !== undefined && !validIntakeStatus(input.status)) throw new HttpClientError('invalid_intake');
  const agentCLI = intakeAgentCLIBody(record);
  const planGeneration = intakePlanGenerationBody(record);
  const body = compactObject({
    expected_updated_at: input.expectedUpdatedAt,
    ...(type === 'feedback' && hasOwn(record, 'requirementId')
      ? { requirement_id: (input as UpdateFeedbackInput).requirementId }
      : {}),
    title: input.title,
    body: input.body,
    status: input.status,
    agent_cli: agentCLI,
    plan_generation: planGeneration,
  });
  if (!['title', 'body', 'status', 'requirement_id', 'agent_cli', 'plan_generation'].some((key) => key in body)) {
    throw new HttpClientError('invalid_intake');
  }
  return body;
}

function intakeAgentCLIBody(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const keys = ['agentCliProvider', 'agentCliCommand', 'codexReasoningEffort'];
  if (!keys.some((key) => hasOwn(input, key))) return undefined;
  return compactObject({
    provider: input.agentCliProvider,
    command: input.agentCliCommand,
    codex_reasoning_effort: input.codexReasoningEffort,
  });
}

function intakePlanGenerationBody(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const keys = [
    'planGenerationStrategy', 'planGenerationProvider', 'planGenerationCommand', 'planGenerationModel',
    'planGenerationCodexReasoningEffort', 'planGenerationClaudeBaseUrl', 'planGenerationClaudeAuthToken',
    'planGenerationClaudeModel', 'planGenerationClaudeConfigId',
  ];
  if (!keys.some((key) => hasOwn(input, key))) return undefined;
  return compactObject({
    strategy: input.planGenerationStrategy,
    provider: input.planGenerationProvider,
    command: input.planGenerationCommand,
    model: input.planGenerationModel,
    codex_reasoning_effort: input.planGenerationCodexReasoningEffort,
    claude_base_url: input.planGenerationClaudeBaseUrl,
    claude_auth_token: input.planGenerationClaudeAuthToken,
    claude_model: input.planGenerationClaudeModel,
    claude_config_id: input.planGenerationClaudeConfigId,
  });
}

function planLinksBody(links: IntakePlanLinkInput[]): Record<string, unknown>[] {
  if (!Array.isArray(links) || links.length > 200) throw new HttpClientError('invalid_intake');
  return links.map((link) => {
    if (!link || typeof link !== 'object' || !safeInteger(link.planId) || link.planId <= 0 ||
        !safeInteger(link.phaseIndex) || link.phaseIndex <= 0 || typeof link.phaseTitle !== 'string' ||
        link.phaseTitle.length > 500) {
      throw new HttpClientError('invalid_intake');
    }
    return { plan_id: link.planId, phase_index: link.phaseIndex, phase_title: link.phaseTitle };
  });
}

function preparePendingAttachments(value: unknown): PreparedAttachment[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_ATTACHMENT_COUNT) throw new HttpClientError('invalid_attachment');
  const result = value.map((item) => preparePendingAttachment(item));
  const total = attachmentBytes(result);
  if (total > MAXIMUM_ATTACHMENT_TOTAL_BYTES) throw new HttpClientError('invalid_attachment');
  return result;
}

function attachmentBytes(attachments: readonly PreparedAttachment[]): number {
  return attachments.reduce((sum, attachment) => sum + attachment.blob.size, 0);
}

function reportUploadProgress(
  callback: HttpMutationOptions['onUploadProgress'] | undefined,
  loaded: number,
  total: number,
): void {
  if (!callback) return;
  try {
    callback({ loaded, total });
  } catch {
    // UI observers cannot affect transport ownership or reveal attachment data.
  }
}

function preparePendingAttachment(value: unknown): PreparedAttachment {
  if (!isRecord(value)) throw new HttpClientError('invalid_attachment');
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > MAXIMUM_ATTACHMENT_NAME_LENGTH || name.includes('\u0000')) {
    throw new HttpClientError('invalid_attachment');
  }
  // P06 HTTP never opens or serializes a renderer/Electron path. A caller must
  // provide browser bytes (Blob or an in-memory legacy clipboard representation).
  if (value.source === 'path' || hasProperty(value, 'path')) throw new HttpClientError('invalid_attachment');
  const blob = blobFromPendingAttachment(value);
  if (blob.size <= 0 || blob.size > MAXIMUM_ATTACHMENT_BYTES) throw new HttpClientError('invalid_attachment');
  return { name, blob };
}

function blobFromPendingAttachment(value: Record<string, unknown>): Blob {
  if (isBlob(value)) return value;
  if (isBlob(value.blob)) return value.blob;
  if (isBlob(value.file)) return value.file;
  if (typeof value.dataUrl === 'string') return blobFromDataURL(value.dataUrl, value.type);
  if (Array.isArray(value.bytes)) return blobFromByteArray(value.bytes, value.type);
  if (value.bytes instanceof ArrayBuffer) return new Blob([value.bytes], { type: stringValue(value.type) });
  if (value.bytes instanceof Uint8Array) {
    return new Blob([Uint8Array.from(value.bytes)], { type: stringValue(value.type) });
  }
  throw new HttpClientError('invalid_attachment');
}

function blobFromDataURL(value: string, fallbackType: unknown): Blob {
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match || typeof globalThis.atob !== 'function') throw new HttpClientError('invalid_attachment');
  let decoded: string;
  try {
    decoded = globalThis.atob(match[2].replace(/\s/g, ''));
  } catch {
    throw new HttpClientError('invalid_attachment');
  }
  if (decoded.length === 0 || decoded.length > MAXIMUM_ATTACHMENT_BYTES) throw new HttpClientError('invalid_attachment');
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: stringValue(fallbackType) || match[1] });
}

function blobFromByteArray(value: unknown[], type: unknown): Blob {
  if (value.length === 0 || value.length > MAXIMUM_ATTACHMENT_BYTES ||
      value.some((item) => !safeInteger(item) || item < 0 || item > 255)) {
    throw new HttpClientError('invalid_attachment');
  }
  return new Blob([Uint8Array.from(value)], { type: stringValue(type) });
}

function createAttachmentFormData(attachment: PreparedAttachment): FormData {
  if (typeof FormData !== 'function') throw configurationError();
  const data = new FormData();
  data.append('file', attachment.blob, attachment.name);
  return data;
}

function latestIntakeFromSnapshot(snapshot: AppSnapshot, type: IntakeType, projectId: number): Requirement | Feedback {
  const items = type === 'requirement' ? snapshot.requirements : snapshot.feedback;
  const owner = items
    .filter((item) => item.project_id === projectId && safeInteger(item.id) && item.id > 0)
    .reduce<Requirement | Feedback | null>((latest, item) => !latest || item.id > latest.id ? item : latest, null);
  if (!owner) throw new HttpClientError('invalid_response');
  return owner;
}

function controlledAttachmentURL(value: unknown, projectId: number, baseUrl: string): string {
  const path = typeof value === 'string' ? value : '';
  const match = path.match(/^\/api\/v1\/attachments\/([1-9][0-9]*)\/content$/);
  if (!match) {
    throw new HttpClientError('invalid_response');
  }
  const parsed = new URL(path, baseUrl);
  if (parsed.origin !== baseUrl || parsed.search || parsed.hash) throw new HttpClientError('invalid_response');
  parsed.searchParams.set('project_id', String(projectId));
  return parsed.toString();
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
}

function hasProperty(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob === 'function' && value instanceof Blob;
}

function loopConfigBody(input: LoopConfigInput, version: number): Record<string, unknown> {
  if (!input || typeof input !== 'object') throw new HttpClientError('invalid_request');
  return compactObject({
    version,
    interval_seconds: input.intervalSeconds,
    validation_command: input.validationCommand ?? input.validation_command,
    project_prompt: input.projectPrompt ?? input.project_prompt,
    agent_cli_provider: input.agentCliProvider,
    agent_cli_command: input.agentCliCommand,
    codex_reasoning_effort: input.codexReasoningEffort,
    plan_generation_strategy: input.planGenerationStrategy,
    plan_generation_provider: input.planGenerationProvider,
    plan_generation_command: input.planGenerationCommand,
    plan_generation_model: input.planGenerationModel,
    plan_generation_codex_reasoning_effort: input.planGenerationCodexReasoningEffort,
    plan_generation_claude_base_url: input.planGenerationClaudeBaseUrl,
    plan_generation_claude_auth_token: input.planGenerationClaudeAuthToken,
    plan_generation_claude_model: input.planGenerationClaudeModel,
    plan_generation_claude_config_id: input.planGenerationClaudeConfigId,
    plan_execution_strategy: input.planExecutionStrategy,
    plan_execution_provider: input.planExecutionProvider,
    plan_execution_command: input.planExecutionCommand,
    plan_execution_model: input.planExecutionModel,
    plan_execution_codex_reasoning_effort: input.planExecutionCodexReasoningEffort,
    plan_execution_claude_base_url: input.planExecutionClaudeBaseUrl,
    plan_execution_claude_auth_token: input.planExecutionClaudeAuthToken,
    plan_execution_claude_model: input.planExecutionClaudeModel,
    plan_execution_claude_config_id: input.planExecutionClaudeConfigId,
    env_vars: input.envVars,
  });
}

function filePolicyBody(
  input: FileAccessSaveInput,
  version: number,
  current: FilePolicyContract | null,
): Record<string, unknown> {
  if (!input || typeof input !== 'object') throw new HttpClientError('invalid_request');
  return compactObject({
    version,
    scope: input.scope ?? current?.scope,
    allow_cross_project: input.allowCrossProject ?? current?.allow_cross_project,
    allowed_roots: input.allowedRoots ?? current?.allowed_roots,
  });
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

async function responseFailure(response: Response): Promise<never> {
  const value = await responseJSON(response);
  const failure = validateErrorEnvelope(value);
  assertResponseRequestID(response, failure.request_id);
  throw new HttpClientError(failure.code, response.status, failure.retryable, failure.request_id);
}

async function responseJSON(response: Response): Promise<unknown> {
  if (mediaType(response.headers.get('Content-Type')) !== JSON_CONTENT_TYPE) {
    throw new HttpClientError('invalid_content_type', response.status);
  }
  const declaredLength = Number(response.headers.get('Content-Length') || '0');
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAXIMUM_RESPONSE_BYTES) {
    throw new HttpClientError('response_too_large', response.status);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAXIMUM_RESPONSE_BYTES) {
    throw new HttpClientError('response_too_large', response.status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpClientError('invalid_json', response.status);
  }
}

function validateStaticScripts(value: unknown): HttpStaticScript[] {
  if (!Array.isArray(value)) throw new HttpClientError('invalid_response');
  return value.map(validateStaticScript);
}

function validateStaticScript(value: unknown): HttpStaticScript {
  const object = exactObject(value, [
    'id', 'project_id', 'name', 'runtime', 'description', 'trigger_mode', 'hook_stage', 'schedule_cron', 'enabled',
    'timeout_seconds', 'fail_aborts', 'context_inject', 'sort_order', 'last_status', 'last_exit_code', 'last_duration_ms',
    'last_run_at', 'source_type', 'has_path', 'has_body', 'has_work_dir', 'has_last_log', 'created_at', 'updated_at', 'version',
  ]);
  if (!positiveSafeInteger(object.id) || !positiveSafeInteger(object.project_id) || typeof object.name !== 'string' ||
      typeof object.runtime !== 'string' || typeof object.description !== 'string' || typeof object.trigger_mode !== 'string' ||
      typeof object.enabled !== 'boolean' || !positiveSafeInteger(object.timeout_seconds) || typeof object.fail_aborts !== 'boolean' ||
      typeof object.context_inject !== 'string' || !safeInteger(object.sort_order) || typeof object.source_type !== 'string' ||
      typeof object.has_path !== 'boolean' || typeof object.has_body !== 'boolean' || typeof object.has_work_dir !== 'boolean' ||
      typeof object.has_last_log !== 'boolean' || !validUTC(object.created_at) || !validUTC(object.updated_at) || !positiveSafeInteger(object.version)) {
    throw new HttpClientError('invalid_response');
  }
  return object as unknown as HttpStaticScript;
}

function validateStaticExecutors(value: unknown): HttpStaticExecutor[] {
  if (!Array.isArray(value)) throw new HttpClientError('invalid_response');
  return value.map(validateStaticExecutor);
}

function validateStaticExecutor(value: unknown): HttpStaticExecutor {
  const object = exactObject(value, [
    'id', 'project_id', 'label', 'type', 'group_kind', 'group_is_default', 'depends_on', 'depends_order', 'enabled', 'sort_order',
    'last_status', 'last_exit_code', 'last_duration_ms', 'last_run_at', 'has_command', 'argument_count', 'has_actions', 'has_options_cwd',
    'options_env_key_count', 'has_problem_matcher', 'has_plugin_state', 'has_last_log', 'created_at', 'updated_at', 'version',
  ]);
  if (!positiveSafeInteger(object.id) || !positiveSafeInteger(object.project_id) || typeof object.label !== 'string' ||
      typeof object.type !== 'string' || !Array.isArray(object.depends_on) || object.depends_on.some((item) => typeof item !== 'string') ||
      typeof object.depends_order !== 'string' || typeof object.enabled !== 'boolean' || !safeInteger(object.sort_order) ||
      typeof object.has_command !== 'boolean' || !nonNegativeIntegerValue(object.argument_count) || typeof object.has_actions !== 'boolean' ||
      typeof object.has_options_cwd !== 'boolean' || !nonNegativeIntegerValue(object.options_env_key_count) ||
      typeof object.has_problem_matcher !== 'boolean' || typeof object.has_plugin_state !== 'boolean' || typeof object.has_last_log !== 'boolean' ||
      !validUTC(object.created_at) || !validUTC(object.updated_at) || !positiveSafeInteger(object.version)) throw new HttpClientError('invalid_response');
  return object as unknown as HttpStaticExecutor;
}

function validateConversationPage(value: unknown): HttpCursorPage<Conversation> {
  const object = exactObject(value, ['data', 'next_cursor', 'request_id']);
  if (!Array.isArray(object.data) || typeof object.next_cursor !== 'string' || object.next_cursor.length > 512 || !validRequestID(object.request_id)) throw new HttpClientError('invalid_response');
  return { data: object.data.map(validateConversation), next_cursor: object.next_cursor, request_id: object.request_id };
}

function validateConversation(value: unknown): Conversation {
  const object = exactObject(value, ['id', 'project_id', 'projectId', 'title', 'ai_config_id', 'aiConfigId', 'pinned_at', 'pinnedAt', 'pinned', 'created_at', 'createdAt', 'updated_at', 'updatedAt']);
  if (!positiveSafeInteger(object.id) || !positiveSafeInteger(object.project_id) || object.projectId !== object.project_id || typeof object.title !== 'string' ||
      !nullablePositiveInteger(object.ai_config_id) || object.aiConfigId !== object.ai_config_id || !nullableUTC(object.pinned_at) || object.pinnedAt !== object.pinned_at ||
      typeof object.pinned !== 'boolean' || !validUTC(object.created_at) || object.createdAt !== object.created_at || !validUTC(object.updated_at) || object.updatedAt !== object.updated_at) throw new HttpClientError('invalid_response');
  return object as unknown as Conversation;
}

interface P13ChatMessage {
  id: number;
  projectId: number;
  conversationId: number;
  role: ChatMessage['role'];
  content: string;
  toolCallsRaw: string | null;
  toolCalls: ChatMessage['toolCalls'];
  toolResultRaw: string | null;
  toolResult: ChatMessage['toolResult'];
  status: 'streaming' | 'queued' | 'done' | 'aborted' | 'error' | 'max_rounds' | 'interrupted';
  createdAt: string;
}

interface P13ChatQueue {
  projectId: number;
  conversationId: number;
  items: ChatQueueItem[];
  count: number;
}

function validateChatMessagePage(value: unknown): HttpCursorPage<P13ChatMessage> {
  const object = exactObject(value, ['data', 'next_cursor', 'request_id']);
  if (!Array.isArray(object.data) || object.data.length > 200 || typeof object.next_cursor !== 'string' ||
      object.next_cursor.length > 512 || !validRequestID(object.request_id)) throw new HttpClientError('invalid_response');
  return { data: object.data.map(validateChatMessage), next_cursor: object.next_cursor, request_id: object.request_id };
}

function validateChatMessage(value: unknown): P13ChatMessage {
  const object = exactObject(value, [
    'id', 'project_id', 'projectId', 'conversation_id', 'conversationId', 'role', 'content',
    'tool_calls', 'toolCalls', 'tool_result', 'toolResult', 'status', 'created_at', 'createdAt',
  ]);
  if (!positiveSafeInteger(object.id) || !positiveSafeInteger(object.project_id) || object.projectId !== object.project_id ||
      !positiveSafeInteger(object.conversation_id) || object.conversationId !== object.conversation_id ||
      !['user', 'assistant', 'tool', 'system'].includes(object.role as string) || typeof object.content !== 'string' || object.content.length > 1_000_000 ||
      !nullableBoundedString(object.tool_calls, 65_536) || !nullableBoundedString(object.tool_result, 65_536) ||
      !['streaming', 'queued', 'done', 'aborted', 'error', 'max_rounds', 'interrupted'].includes(object.status as string) ||
      !validUTC(object.created_at) || object.createdAt !== object.created_at || !validToolCalls(object.toolCalls) || !nullableSafeChatData(object.toolResult)) {
    throw new HttpClientError('invalid_response');
  }
  return {
    id: object.id,
    projectId: object.project_id,
    conversationId: object.conversation_id,
    role: object.role as ChatMessage['role'],
    content: object.content,
    toolCallsRaw: object.tool_calls as string | null,
    toolCalls: object.toolCalls as ChatMessage['toolCalls'],
    toolResultRaw: object.tool_result as string | null,
    toolResult: object.toolResult as ChatMessage['toolResult'],
    status: object.status as P13ChatMessage['status'],
    createdAt: object.created_at,
  };
}

function toLegacyChatMessage(message: P13ChatMessage): ChatMessage {
  return {
    id: message.id,
    project_id: message.projectId,
    projectId: message.projectId,
    role: message.role,
    content: message.content,
    tool_calls: message.toolCallsRaw,
    toolCalls: message.toolCalls,
    tool_result: message.toolResultRaw,
    toolResult: message.toolResult,
    status: message.status === 'max_rounds' ? 'error' : message.status === 'interrupted' ? 'aborted' : message.status,
    created_at: message.createdAt,
    createdAt: message.createdAt,
  };
}

function validateChatQueue(value: unknown): P13ChatQueue {
  const object = exactObject(value, ['project_id', 'projectId', 'conversation_id', 'conversationId', 'items', 'count']);
  if (!positiveSafeInteger(object.project_id) || object.projectId !== object.project_id ||
      !positiveSafeInteger(object.conversation_id) || object.conversationId !== object.conversation_id ||
      !Array.isArray(object.items) || object.items.length > 200 || !nonNegativeIntegerValue(object.count) || object.count !== object.items.length) {
    throw new HttpClientError('invalid_response');
  }
  const items = object.items.map((item) => {
    const queueItem = exactObject(item, ['id', 'content', 'state']);
    if (!positiveSafeInteger(queueItem.id) || typeof queueItem.content !== 'string' || !queueItem.content.length || queueItem.content.length > 1_000_000 ||
        (queueItem.state !== 'queued' && queueItem.state !== 'processing')) throw new HttpClientError('invalid_response');
    return { id: queueItem.id, content: queueItem.content, state: queueItem.state } as ChatQueueItem;
  });
  return { projectId: object.project_id, conversationId: object.conversation_id, items, count: object.count };
}

function validateChatAccepted(value: unknown): { project_id: number; conversation_id: number } {
  const object = exactObject(value, ['accepted', 'project_id', 'conversation_id', 'message_id', 'turn_id', 'operation_id']);
  if (object.accepted !== true || !positiveSafeInteger(object.project_id) || !positiveSafeInteger(object.conversation_id) ||
      !positiveSafeInteger(object.message_id) || !validOperationID(object.turn_id) ||
      !(object.operation_id === null || validOperationID(object.operation_id))) throw new HttpClientError('invalid_response');
  return { project_id: object.project_id, conversation_id: object.conversation_id };
}

function validateChatBoolean(value: unknown): { ok: boolean } {
  const object = exactObject(value, ['ok']);
  if (typeof object.ok !== 'boolean') throw new HttpClientError('invalid_response');
  return { ok: object.ok };
}

function validateChatStop(value: unknown): { stopped: boolean; project_id: number; conversation_id: number } {
  const object = exactObject(value, ['stopped', 'project_id', 'conversation_id', 'operation_id']);
  if (typeof object.stopped !== 'boolean' || !positiveSafeInteger(object.project_id) || !positiveSafeInteger(object.conversation_id) ||
      !(object.operation_id === null || validOperationID(object.operation_id))) throw new HttpClientError('invalid_response');
  return object as { stopped: boolean; project_id: number; conversation_id: number };
}

function validateChatClear(value: unknown): { cleared: boolean; project_id: number; conversation_id: number } {
  const object = exactObject(value, ['cleared', 'project_id', 'conversation_id']);
  if (typeof object.cleared !== 'boolean' || !positiveSafeInteger(object.project_id) || !positiveSafeInteger(object.conversation_id)) {
    throw new HttpClientError('invalid_response');
  }
  return object as { cleared: boolean; project_id: number; conversation_id: number };
}

function validateDeletedConversation(value: unknown): { deleted_messages: number } {
  const object = exactObject(value, ['deleted_messages']);
  if (!nonNegativeIntegerValue(object.deleted_messages)) throw new HttpClientError('invalid_response');
  return { deleted_messages: object.deleted_messages };
}

function validateChatChunk(value: unknown, projectId: number, conversationId: number): { turnId: string; sequence: number; type: string; data: Record<string, unknown> } {
  const object = exactObject(value, ['project_id', 'projectId', 'conversation_id', 'conversationId', 'turn_id', 'sequence', 'type', 'data']);
  if (object.project_id !== projectId || object.projectId !== projectId || object.conversation_id !== conversationId || object.conversationId !== conversationId ||
      !validOperationID(object.turn_id) || !positiveSafeInteger(object.sequence) ||
      !['thinking_start', 'thinking_delta', 'thinking_end', 'chunk', 'tool_start', 'tool_result', 'error', 'status'].includes(object.type as string) ||
      !isSafeChatData(object.data)) throw new HttpClientError('invalid_response');
  return {
    turnId: object.turn_id as string,
    sequence: object.sequence as number,
    type: object.type === 'chunk' ? 'text_delta' : object.type as string,
    data: object.data as Record<string, unknown>,
  };
}

function validateChatDone(value: unknown, projectId: number, conversationId: number): ChatDoneEvent & { turnId: string } {
  const object = exactObject(value, ['project_id', 'projectId', 'conversation_id', 'conversationId', 'turn_id', 'status'], ['error', 'title', 'operation_id']);
  if (object.project_id !== projectId || object.projectId !== projectId || object.conversation_id !== conversationId || object.conversationId !== conversationId ||
      !validOperationID(object.turn_id) || !['done', 'aborted', 'error', 'max_rounds', 'interrupted'].includes(object.status as string) ||
      (object.error !== undefined && (typeof object.error !== 'string' || object.error.length > 2048)) ||
      (object.title !== undefined && (typeof object.title !== 'string' || object.title.length > 200)) ||
      (object.operation_id !== undefined && object.operation_id !== null && !validOperationID(object.operation_id))) throw new HttpClientError('invalid_response');
  return {
    status: object.status === 'interrupted' ? 'aborted' : object.status as ChatDoneEvent['status'],
    ...(typeof object.error === 'string' ? { error: object.error } : {}),
    conversationId,
    turnId: object.turn_id as string,
    ...(typeof object.title === 'string' ? { title: object.title } : {}),
  };
}

function nullableBoundedString(value: unknown, maximum: number): value is string | null {
  return value === null || typeof value === 'string' && value.length <= maximum;
}

function validToolCalls(value: unknown): boolean {
  return value === null || Array.isArray(value) && value.length <= 64 && value.every((item) => {
    const call = exactObject(item, ['name', 'args']);
    return typeof call.name === 'string' && call.name.length > 0 && call.name.length <= 128 && isSafeChatData(call.args);
  });
}

function nullableSafeChatData(value: unknown): boolean {
  return value === null || isSafeChatData(value);
}

function isSafeChatData(value: unknown, depth = 0): value is Record<string, unknown> {
  if (!isRecord(value) || depth > 16 || Object.keys(value).length > 64) return false;
  return Object.entries(value).every(([key, child]) =>
    !/workspace[_-]?path|(?:^|_)(?:env|token|password|secret|credential|command|stdout|stderr)(?:$|_)/i.test(key) &&
    (child === null || typeof child === 'boolean' || typeof child === 'number' ||
      typeof child === 'string' && child.length <= 2048 ||
      Array.isArray(child) && child.length <= 64 && child.every((item) => item === null || typeof item !== 'object' || isSafeChatData(item, depth + 1)) ||
      isRecord(child) && isSafeChatData(child, depth + 1)),
  );
}

function chatConversationPath(projectId: number, conversationId: number): string {
  return `/api/v1/projects/${projectId}/conversations/${conversationId}`;
}

function chatMessagesPath(projectId: number, conversationId: number): string {
  return `${chatConversationPath(projectId, conversationId)}/messages`;
}

function boundedChatText(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_000_000) throw new HttpClientError(code);
  return value;
}

function boundedConversationTitle(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200) throw new HttpClientError('invalid_request');
  return value;
}

function invalidConversationInput(): never {
  throw new HttpClientError('invalid_request');
}

function validateMessagePage(value: unknown): HttpCursorPage<HttpMessageMetadata> {
  const object = exactObject(value, ['data', 'next_cursor', 'request_id']);
  if (!Array.isArray(object.data) || typeof object.next_cursor !== 'string' || object.next_cursor.length > 512 || !validRequestID(object.request_id)) throw new HttpClientError('invalid_response');
  return { data: object.data.map(validateMessageMetadata), next_cursor: object.next_cursor, request_id: object.request_id };
}

function validateMessageMetadata(value: unknown): HttpMessageMetadata {
  const object = exactObject(value, ['id', 'project_id', 'conversation_id', 'role', 'status', 'created_at', 'has_content', 'has_tool_calls', 'has_tool_result']);
  if (!positiveSafeInteger(object.id) || !positiveSafeInteger(object.project_id) || !positiveSafeInteger(object.conversation_id) ||
      !['user', 'assistant', 'tool', 'system'].includes(object.role as string) || !nullableStringValue(object.status) || !validUTC(object.created_at) ||
      typeof object.has_content !== 'boolean' || typeof object.has_tool_calls !== 'boolean' || typeof object.has_tool_result !== 'boolean') throw new HttpClientError('invalid_response');
  return object as unknown as HttpMessageMetadata;
}

function validateAIConfigs(value: unknown): AiConfig[] {
  if (!Array.isArray(value)) throw new HttpClientError('invalid_response');
  return value.map(validateAIConfig);
}

function validateAIConfig(value: unknown): AiConfig {
  const object = exactObject(value, ['id', 'project_id', 'projectId', 'name', 'provider', 'base_url', 'baseUrl', 'has_api_key', 'hasApiKey', 'masked_key', 'maskedKey', 'model', 'temperature', 'thinking_depth', 'thinkingDepth', 'thinking_budget_tokens', 'thinkingBudgetTokens', 'created_at', 'createdAt', 'updated_at', 'updatedAt', 'version']);
  if (!positiveSafeInteger(object.id) || !nullablePositiveInteger(object.project_id) || object.projectId !== object.project_id || typeof object.name !== 'string' ||
      typeof object.provider !== 'string' || typeof object.base_url !== 'string' || object.baseUrl !== object.base_url || typeof object.has_api_key !== 'boolean' || object.hasApiKey !== object.has_api_key ||
      typeof object.masked_key !== 'string' || object.maskedKey !== object.masked_key || typeof object.model !== 'string' || typeof object.temperature !== 'string' ||
      !nullableThinkingDepth(object.thinking_depth) || object.thinkingDepth !== object.thinking_depth || !nullableNonNegativeInteger(object.thinking_budget_tokens) || object.thinkingBudgetTokens !== object.thinking_budget_tokens ||
      !validUTC(object.created_at) || object.createdAt !== object.created_at || !validUTC(object.updated_at) || object.updatedAt !== object.updated_at || !positiveSafeInteger(object.version)) throw new HttpClientError('invalid_response');
  return { id: object.id, projectId: object.project_id, name: object.name, provider: object.provider, baseUrl: object.base_url, hasApiKey: object.has_api_key, maskedKey: object.masked_key, model: object.model, temperature: object.temperature, thinkingDepth: object.thinking_depth, thinkingBudgetTokens: object.thinking_budget_tokens, createdAt: object.created_at, updatedAt: object.updated_at, version: object.version };
}

function validateClaudeConfigs(value: unknown): ClaudeCliConfig[] {
  if (!Array.isArray(value)) throw new HttpClientError('invalid_response');
  return value.map(validateClaudeConfig);
}

function validateClaudeConfig(value: unknown): ClaudeCliConfig {
  const object = exactObject(value, ['id', 'project_id', 'projectId', 'name', 'base_url', 'baseUrl', 'has_auth_token', 'hasAuthToken', 'masked_key', 'maskedKey', 'model', 'is_default', 'isDefault', 'created_at', 'createdAt', 'updated_at', 'updatedAt', 'version']);
  if (!positiveSafeInteger(object.id) || !nullablePositiveInteger(object.project_id) || object.projectId !== object.project_id || typeof object.name !== 'string' || typeof object.base_url !== 'string' || object.baseUrl !== object.base_url ||
      typeof object.has_auth_token !== 'boolean' || object.hasAuthToken !== object.has_auth_token || typeof object.masked_key !== 'string' || object.maskedKey !== object.masked_key ||
      typeof object.model !== 'string' || typeof object.is_default !== 'boolean' || object.isDefault !== object.is_default || !validUTC(object.created_at) || object.createdAt !== object.created_at || !validUTC(object.updated_at) || object.updatedAt !== object.updated_at || !positiveSafeInteger(object.version)) throw new HttpClientError('invalid_response');
  return { id: object.id, projectId: object.project_id, name: object.name, baseUrl: object.base_url, hasAuthToken: object.has_auth_token, maskedKey: object.masked_key, model: object.model, isDefault: object.is_default, createdAt: object.created_at, updatedAt: object.updated_at, version: object.version };
}

function validateMCPConfig(value: unknown): HttpMCPConfig {
  const object = exactObject(value, ['enabled', 'transport', 'host', 'port', 'path', 'port_explicit', 'portExplicit', 'has_auth_token', 'hasAuthToken', 'auth_token_masked', 'authTokenMasked']);
  if (typeof object.enabled !== 'boolean' || (object.transport !== 'http' && object.transport !== 'stdio') || typeof object.host !== 'string' ||
      !positiveSafeInteger(object.port) || object.port > 65535 || typeof object.path !== 'string' || typeof object.port_explicit !== 'boolean' || object.portExplicit !== object.port_explicit ||
      typeof object.has_auth_token !== 'boolean' || object.hasAuthToken !== object.has_auth_token || typeof object.auth_token_masked !== 'string' || object.authTokenMasked !== object.auth_token_masked) throw new HttpClientError('invalid_response');
  return { enabled: object.enabled, transport: object.transport, host: object.host, port: object.port, path: object.path, port_explicit: object.port_explicit, has_auth_token: object.has_auth_token, auth_token_masked: object.auth_token_masked };
}

function validateDeletedStaticConfig(value: unknown): { deleted: boolean } {
  const object = exactObject(value, ['deleted']);
  if (object.deleted !== true) throw new HttpClientError('invalid_response');
  return { deleted: true };
}

function positiveSafeInteger(value: unknown): value is number { return safeInteger(value) && value > 0; }
function nonNegativeIntegerValue(value: unknown): value is number { return safeInteger(value) && value >= 0; }
function nullablePositiveInteger(value: unknown): value is number | null { return value === null || positiveSafeInteger(value); }
function nullableNonNegativeInteger(value: unknown): value is number | null { return value === null || nonNegativeIntegerValue(value); }
function nullableStringValue(value: unknown): value is string | null { return value === null || typeof value === 'string'; }
function nullableThinkingDepth(value: unknown): value is AiConfig['thinkingDepth'] {
  return value === null || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh';
}

function validateProbe(value: unknown): ProbeResult {
  const object = exactObject(value, ['status', 'request_id']);
  if ((object.status !== 'ok' && object.status !== 'ready') || !validRequestID(object.request_id)) {
    throw new HttpClientError('invalid_response');
  }
  return object as unknown as ProbeResult;
}

function validateCapabilityDiscovery(value: unknown): Omit<HttpCapabilityDiscovery, 'request_id'> {
  const object = exactObject(value, ['version', 'capabilities']);
  if (object.version !== 'v1' || !Array.isArray(object.capabilities) || object.capabilities.length > 128) {
    throw new HttpClientError('invalid_response');
  }
  const capabilities = object.capabilities.map((item) => {
    const capability = exactObject(item, ['id', 'enabled']);
    if (typeof capability.id !== 'string' || !CAPABILITY_ID_PATTERN.test(capability.id) ||
        typeof capability.enabled !== 'boolean') {
      throw new HttpClientError('invalid_response');
    }
    return { id: capability.id, enabled: capability.enabled };
  });
  if (new Set(capabilities.map((capability) => capability.id)).size !== capabilities.length) {
    throw new HttpClientError('invalid_response');
  }
  return { version: 'v1', capabilities };
}

function validateRuntimeOperationAccepted(value: unknown): RuntimeOperationAccepted {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    'operation_id', 'type', 'status', 'request_id', 'accepted_at',
  ].includes(key)) || !validOperationID(value.operation_id) ||
      typeof value.type !== 'string' || value.type.length === 0 || value.type.length > 128 ||
      typeof value.status !== 'string' || !['accepted', 'queued', 'running', 'completed', 'succeeded', 'cancelled'].includes(value.status) ||
      typeof value.request_id !== 'string' || !REQUEST_ID_PATTERN.test(value.request_id) ||
      typeof value.accepted_at !== 'string' || !validUTC(value.accepted_at)) {
    throw new HttpClientError('invalid_response');
  }
  return {
    operation_id: value.operation_id,
    type: value.type,
    status: value.status,
    request_id: value.request_id,
    accepted_at: value.accepted_at,
  };
}

function validateProcessOperationAccepted(
  value: unknown,
  acceptedTypes: readonly string[],
): RuntimeOperationAccepted {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    'operation_id', 'type', 'status', 'request_id', 'accepted_at',
  ].includes(key)) || !validOperationID(value.operation_id) ||
      typeof value.type !== 'string' || !acceptedTypes.includes(value.type) ||
      typeof value.status !== 'string' || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.status) ||
      !validRequestID(value.request_id) || !validUTC(value.accepted_at)) {
    throw new HttpClientError('invalid_response');
  }
  return {
    operation_id: value.operation_id,
    type: value.type,
    status: value.status,
    request_id: value.request_id,
    accepted_at: value.accepted_at,
  };
}

function validateProcessStopResult(value: unknown, acceptedTypes: readonly string[]): ProcessStopResult {
  if (!isRecord(value) || Object.keys(value).some((key) => !['operation', 'stopped', 'changed'].includes(key)) ||
      typeof value.stopped !== 'boolean' || typeof value.changed !== 'boolean') {
    throw new HttpClientError('invalid_response');
  }
  const operation = value.operation === undefined || value.operation === null
    ? null
    : validateProcessOperationAccepted(value.operation, acceptedTypes);
  return { operation, stopped: value.stopped, changed: value.changed };
}

function executorRunResult(
  snapshot: AppSnapshot,
  executorId: number,
  operation: RuntimeOperationAccepted | null,
): ExecutorRunResult {
  const executor = snapshot.executors.find((candidate) => candidate.id === executorId);
  const status = executor?.last_status ?? executor?.lastStatus ?? 'running';
  return {
    snapshot,
    executorId,
    label: executor?.label ?? '',
    status,
    exitCode: executor?.last_exit_code ?? executor?.lastExitCode ?? null,
    durationMs: executor?.last_duration_ms ?? executor?.lastDurationMs ?? null,
    log: executor?.last_log ?? executor?.lastLog ?? null,
    operation: operation as ProcessOperationAccepted | null,
  };
}

function validatePlans(value: unknown): Plan[] {
  if (!Array.isArray(value)) throw new HttpClientError('invalid_response');
  return value.map(validatePlan);
}

function validatePlan(value: unknown): Plan {
  if (!isRecord(value) || !safeInteger(value.id) || value.id <= 0 ||
      !safeInteger(value.project_id) || value.project_id <= 0 ||
      typeof value.issue_hash !== 'string' || typeof value.file_path !== 'string' ||
      !safeRelativePlanReference(value.file_path) || typeof value.hash !== 'string' ||
      typeof value.status !== 'string' || !safeInteger(value.sort_order) || value.sort_order < 0 ||
      !safeInteger(value.total_tasks) || value.total_tasks < 0 ||
      !safeInteger(value.completed_tasks) || value.completed_tasks < 0 ||
      value.completed_tasks > value.total_tasks ||
      (value.validation_passed !== 0 && value.validation_passed !== 1) ||
      !safeInteger(value.plan_generation_duration_ms) || value.plan_generation_duration_ms < 0 ||
      !validUTC(value.created_at) || !validUTC(value.updated_at) || !nullableUTC(value.accepted_at)) {
    throw new HttpClientError('invalid_response');
  }
  const isDraft = value.is_draft === undefined ? value.status === 'draft' : value.is_draft;
  if (typeof isDraft !== 'boolean') throw new HttpClientError('invalid_response');
  const concurrencySuggestion = value.concurrency_suggestion === undefined
    ? emptyConcurrencySuggestion()
    : value.concurrency_suggestion;
  if (!validConcurrencySuggestion(concurrencySuggestion)) throw new HttpClientError('invalid_response');
  return {
    id: value.id,
    project_id: value.project_id,
    issue_hash: value.issue_hash,
    file_path: value.file_path,
    hash: value.hash,
    status: value.status,
    sort_order: value.sort_order,
    total_tasks: value.total_tasks,
    completed_tasks: value.completed_tasks,
    validation_passed: value.validation_passed,
    plan_generation_duration_ms: value.plan_generation_duration_ms,
    created_at: value.created_at,
    updated_at: value.updated_at,
    accepted_at: value.accepted_at,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    is_draft: isDraft,
    concurrency_suggestion: concurrencySuggestion,
  } as unknown as Plan;
}

function validatePlanTasks(value: unknown): PlanTask[] {
  if (!Array.isArray(value)) throw new HttpClientError('invalid_response');
  return value.map(validatePlanTask);
}

function validatePlanContent(value: unknown): PlanContentResult {
  const object = exactObject(value, ['plan', 'tasks', 'markdown'], ['error_code']);
  const plan = validatePlan(object.plan);
  const tasks = validatePlanTasks(object.tasks);
  if (typeof object.markdown !== 'string' || BufferByteLength(object.markdown) > MAXIMUM_PLAN_MARKDOWN_BYTES ||
      (object.error_code !== undefined &&
        (typeof object.error_code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(object.error_code)))) {
    throw new HttpClientError('invalid_response');
  }
  return { plan, tasks, markdown: object.markdown, errorCode: object.error_code as string | undefined || '' };
}

function planReadResult(content: PlanContentResult): ReadPlanResult {
  const tasks = content.tasks.map((task) => ({
    id: task.id,
    plan_id: task.plan_id,
    task_key: task.task_key,
    title: task.title,
    raw_line: task.raw_line,
    scope: task.scope,
    scopes: readPlanTaskScopes(task.scope),
    status: task.status,
    sort_order: task.sort_order,
    updated_at: task.updated_at,
  }));
  const error = planContentErrorMessage(content.errorCode);
  const parse = planTaskParseStatus(content.markdown, error, tasks.length);
  return {
    ok: error === null,
    id: content.plan.id,
    project_id: content.plan.project_id,
    file_path: content.plan.file_path,
    markdown: content.markdown,
    tasks,
    task_total: tasks.length,
    task_completed: tasks.filter((task) => task.status === 'completed').length,
    task_parse_status: parse.status,
    task_parse_message: parse.message,
    task_parse_has_task_section: parse.hasTaskSection,
    hash: content.plan.hash,
    updated_at: content.plan.updated_at,
    error,
  };
}

function readPlanTaskScopes(scope: string): string[] {
  return [...new Set(scope.split(/[,，、;；]+/).map((item) => item.trim()).filter(Boolean))];
}

function planContentErrorMessage(code: string): string | null {
  switch (code) {
    case '': return null;
    case 'workspace_unavailable': return '项目工作区不存在或无法访问';
    case 'file_path_empty': return '计划文件路径为空';
    case 'file_not_found': return '计划文件不存在';
    case 'file_too_large': return '计划文件过大，无法预览';
    case 'invalid_encoding': return '计划文件不是有效的 UTF-8 文本';
    default: return '计划文件读取失败';
  }
}

function planTaskParseStatus(markdown: string, error: string | null, taskCount: number): {
  status: ReadPlanResult['task_parse_status']; message: string; hasTaskSection: boolean;
} {
  if (error) return { status: 'read_failed', message: error, hasTaskSection: false };
  const hasTaskSection = /(?:^|\n)\s*#{1,6}\s*(?:任务拆解|任务计划|任务列表|开发任务|实施计划|Tasks)(?:\s|$)/i.test(markdown);
  const hasCheckboxLine = /^\s*[-*+]\s+\[[ xX]\]\s+/m.test(markdown);
  if (taskCount > 0) return { status: 'parsed', message: `已解析 ${taskCount} 个任务。`, hasTaskSection };
  if (!markdown.trim()) return { status: 'empty_markdown', message: 'Plan Markdown 正文为空。', hasTaskSection: false };
  if (hasTaskSection || hasCheckboxLine) {
    return { status: 'parse_empty', message: 'Markdown 疑似包含任务拆解，但当前没有解析到任务。', hasTaskSection: true };
  }
  return { status: 'no_tasks', message: '当前 Plan 尚未解析到任务拆解。', hasTaskSection: false };
}

function BufferByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validatePlanTask(value: unknown): PlanTask {
  if (!isRecord(value) || !safeInteger(value.id) || value.id <= 0 ||
      !safeInteger(value.project_id) || value.project_id <= 0 ||
      !safeInteger(value.plan_id) || value.plan_id <= 0 ||
      typeof value.task_key !== 'string' || !value.task_key || typeof value.title !== 'string' ||
      typeof value.raw_line !== 'string' || typeof value.scope !== 'string' ||
      typeof value.status !== 'string' || !safeInteger(value.sort_order) || value.sort_order < 0 ||
      !nullableUTC(value.started_at) || !nullableUTC(value.finished_at) ||
      !safeInteger(value.duration_ms) || value.duration_ms < 0 || !validUTC(value.updated_at) ||
      !nullableUTC(value.accepted_at) || typeof value.file_path !== 'string' ||
      !safeRelativePlanReference(value.file_path) || typeof value.plan_title !== 'string') {
    throw new HttpClientError('invalid_response');
  }
  if (value.scope_files !== undefined && !Array.isArray(value.scope_files)) {
    throw new HttpClientError('invalid_response');
  }
  if (value.codex_session_id !== undefined && value.codex_session_id !== null &&
      typeof value.codex_session_id !== 'string') {
    throw new HttpClientError('invalid_response');
  }
  return {
    id: value.id,
    project_id: value.project_id,
    plan_id: value.plan_id,
    task_key: value.task_key,
    title: value.title,
    raw_line: value.raw_line,
    scope: value.scope,
    scope_files: [],
    status: value.status,
    sort_order: value.sort_order,
    started_at: value.started_at,
    finished_at: value.finished_at,
    duration_ms: value.duration_ms,
    codex_session_id: null,
    updated_at: value.updated_at,
    accepted_at: value.accepted_at,
    file_path: value.file_path,
    plan_title: value.plan_title,
  } as unknown as PlanTask;
}

function validatePlanEvents(value: unknown): AppEvent[] {
  if (!Array.isArray(value)) throw new HttpClientError('invalid_response');
  return value.map((item) => {
    const event = exactObject(item, ['id', 'project_id', 'type', 'message', 'meta', 'created_at']);
    if (!safeInteger(event.id) || event.id <= 0 || !safeInteger(event.project_id) || event.project_id <= 0 ||
        typeof event.type !== 'string' || !event.type || typeof event.message !== 'string' ||
        !validUTC(event.created_at) ||
        (event.meta !== null && typeof event.meta !== 'string' && !isRecord(event.meta))) {
      throw new HttpClientError('invalid_response');
    }
    return event as unknown as AppEvent;
  });
}

function terminalSessionID(value: unknown): string {
  if (typeof value !== 'string' || !/^term_[a-z0-9][a-z0-9_-]{5,}$/.test(value) || value.length > 160) {
    throw new HttpClientError('terminal_invalid_session');
  }
  return value;
}

function validateTerminalRestSessions(value: unknown): TerminalRestSession[] {
  if (!Array.isArray(value) || value.length > 32) throw new HttpClientError('invalid_response');
  return value.map(validateTerminalRestSession);
}

function validateTerminalRestSession(value: unknown): TerminalRestSession {
  const object = exactObject(value, [
    'id', 'project_id', 'title', 'cwd', 'shell', 'status', 'created_at', 'ended_at', 'exit_code',
    'cols', 'rows', 'profile', 'closed', 'runtime',
  ]);
  if (!/^term_[a-z0-9][a-z0-9_-]{5,}$/.test(String(object.id)) || String(object.id).length > 160 ||
      !positiveSafeInteger(object.project_id) || typeof object.title !== 'string' || object.title.length > 80 ||
      typeof object.cwd !== 'string' || object.cwd.length === 0 || object.cwd.length > 2048 ||
      typeof object.shell !== 'string' || object.shell.length === 0 || object.shell.length > 2048 ||
      typeof object.status !== 'string' || !validUTC(object.created_at) || !nullableUTC(object.ended_at) ||
      !nullableTerminalExitCode(object.exit_code) || !terminalSize(object.cols, object.rows) ||
      typeof object.closed !== 'boolean' || object.runtime !== 'go') {
    throw new HttpClientError('invalid_response');
  }
  return {
    id: object.id as string,
    project_id: object.project_id as number,
    title: object.title as string,
    cwd: object.cwd as string,
    shell: object.shell as string,
    status: object.status as TerminalRestSession['status'],
    created_at: object.created_at as string,
    ended_at: object.ended_at as string | null,
    exit_code: object.exit_code as number | null,
    cols: object.cols as number,
    rows: object.rows as number,
    profile: validateTerminalRestProfile(object.profile),
    closed: object.closed as boolean,
    runtime: 'go',
  };
}

function validateTerminalRestProfile(value: unknown): TerminalRestSession['profile'] {
  const object = exactObject(value, ['id', 'name', 'kind', 'shell_path', 'args', 'env']);
  if (typeof object.id !== 'string' || object.id.length === 0 || object.id.length > 80 ||
      typeof object.name !== 'string' || object.name.length === 0 || object.name.length > 80 ||
      (object.kind !== 'default' && object.kind !== 'custom') || typeof object.shell_path !== 'string' ||
      object.shell_path.length === 0 || object.shell_path.length > 2048 || !Array.isArray(object.args) ||
      object.args.length > 32 || object.args.some((argument) => typeof argument !== 'string' || argument.length > 512) ||
      !isRecord(object.env) || Object.keys(object.env).length !== 0) {
    throw new HttpClientError('invalid_response');
  }
  return { id: object.id, name: object.name, kind: object.kind, shell_path: object.shell_path, args: [...object.args], env: {} };
}

function validateTerminalRestReplay(value: unknown): TerminalRestReplay {
  const object = exactObject(value, ['session', 'first_seq', 'last_seq', 'entries', 'replay_complete']);
  if (!nonNegativeSequence(object.first_seq) || !nonNegativeSequence(object.last_seq) || object.first_seq > object.last_seq ||
      object.replay_complete !== true || !Array.isArray(object.entries) || object.entries.length > 4096) {
    throw new HttpClientError('invalid_response');
  }
  let previous = object.first_seq === 0 ? 0 : object.first_seq - 1;
  const entries = object.entries.map((entry) => {
    const output = exactObject(entry, ['seq', 'data']);
    if (!positiveSafeInteger(output.seq) || output.seq > 9007199254740991 || output.seq <= previous ||
        typeof output.data !== 'string' || output.data.length > 64 << 10) {
      throw new HttpClientError('invalid_response');
    }
    previous = output.seq;
    return { seq: output.seq, data: output.data };
  });
  if (entries.length > 0 && entries[entries.length - 1].seq > object.last_seq) throw new HttpClientError('invalid_response');
  return {
    session: validateTerminalRestSession(object.session), first_seq: object.first_seq,
    last_seq: object.last_seq, entries, replay_complete: true,
  };
}

function terminalSize(cols: unknown, rows: unknown): boolean {
  return safeInteger(cols) && cols >= 2 && cols <= 500 && safeInteger(rows) && rows >= 1 && rows <= 200;
}
function nullableTerminalExitCode(value: unknown): boolean {
  return value === null || (safeInteger(value) && value >= -2147483648 && value <= 2147483647);
}
function nonNegativeSequence(value: unknown): value is number {
  return safeInteger(value) && value >= 0 && value <= 9007199254740991;
}

function validatePlanMutation(value: unknown): PlanMutationResult {
  const object = exactObject(value, ['snapshot'], ['items']);
  if (object.items !== undefined && !Array.isArray(object.items)) throw new HttpClientError('invalid_response');
  return { snapshot: validateSnapshot(object.snapshot) };
}

function validateProjectPage(value: unknown): ProjectPage {
  const object = exactObject(value, ['data', 'pagination', 'request_id']);
  if (!Array.isArray(object.data) || !validRequestID(object.request_id)) {
    throw new HttpClientError('invalid_response');
  }
  const data = object.data.map(validateProject);
  const pagination = validatePagination(object.pagination);
  if (data.length > pagination.page_size ||
      (pagination.next_page !== null && pagination.next_page !== pagination.page + 1) ||
      (pagination.next_page !== null && pagination.page * pagination.page_size >= pagination.total) ||
      (pagination.next_page === null && data.length > 0 &&
        (pagination.page - 1) * pagination.page_size + data.length < pagination.total)) {
    throw new HttpClientError('invalid_response');
  }
  return { data, pagination, request_id: object.request_id as string };
}

function validatePagination(value: unknown): ProjectPagination {
  const object = exactObject(value, ['page', 'page_size', 'total', 'next_page']);
  if (!safeInteger(object.page) || object.page <= 0 ||
      !safeInteger(object.page_size) || object.page_size <= 0 || object.page_size > 200 ||
      !safeInteger(object.total) || object.total < 0 ||
      (object.next_page !== null && (!safeInteger(object.next_page) || object.next_page <= 1))) {
    throw new HttpClientError('invalid_response');
  }
  return object as unknown as ProjectPagination;
}

function validateIntakePage<TItem extends Requirement | Feedback>(value: unknown, type: IntakeType): IntakePage<TItem> {
  const object = exactObject(value, ['data', 'pagination', 'request_id']);
  if (!Array.isArray(object.data) || !validRequestID(object.request_id)) throw new HttpClientError('invalid_response');
  const pagination = validatePagination(object.pagination) as IntakePagination;
  const data = object.data.map((item) => validateIntake<TItem>(item, type));
  if (data.length > pagination.page_size ||
      (pagination.next_page !== null && pagination.next_page !== pagination.page + 1)) {
    throw new HttpClientError('invalid_response');
  }
  return { data, pagination, request_id: object.request_id as string };
}

function validateIntake<TItem extends Requirement | Feedback>(value: unknown, expectedType: IntakeType): TItem {
  const required = [
    'id', 'project_id', 'intake_type', 'title', 'body', 'status', 'linked_plans', 'created_at', 'updated_at',
  ];
  const optional = [
    'requirement_id', 'accepted_at', 'linked_plan_id', 'agent_cli_provider', 'agent_cli_command',
    'codex_reasoning_effort', 'plan_generation_strategy', 'plan_generation_provider',
    'plan_generation_command', 'plan_generation_model', 'plan_generation_codex_reasoning_effort',
    'plan_generation_claude_base_url', 'plan_generation_claude_model', 'plan_generation_claude_config_id',
    'plan_generation_has_claude_auth_token', 'generate_fail_count', 'last_generate_fail_at',
    'last_generate_error', 'last_generate_agent_cli_provider', 'last_generate_codex_reasoning_effort',
  ];
  const object = exactObject(value, required, optional);
  if (!safeInteger(object.id) || object.id <= 0 || !safeInteger(object.project_id) || object.project_id <= 0 ||
      object.intake_type !== expectedType || typeof object.title !== 'string' || typeof object.body !== 'string' ||
      !validIntakeStatus(object.status) || !validUTC(object.created_at) || !validUTC(object.updated_at) ||
      !Array.isArray(object.linked_plans)) {
    throw new HttpClientError('invalid_response');
  }
  // IntakeDTO deliberately serializes this nullable field for both types.
  // A Requirement may therefore carry `requirement_id: null`, but never an ID.
  if (expectedType === 'requirement' && object.requirement_id !== undefined && object.requirement_id !== null) {
    throw new HttpClientError('invalid_response');
  }
  if (expectedType === 'feedback' && object.requirement_id !== undefined && object.requirement_id !== null &&
      (!safeInteger(object.requirement_id) || object.requirement_id <= 0)) {
    throw new HttpClientError('invalid_response');
  }
  object.linked_plans.map(validatePlanLink);
  return object as unknown as TItem;
}

function validatePlanLinks(value: unknown): IntakePlanLink[] {
  if (!Array.isArray(value)) throw new HttpClientError('invalid_response');
  return value.map(validatePlanLink);
}

function validatePlanLink(value: unknown): IntakePlanLink {
  const object = exactObject(value, ['link_id', 'plan_id', 'phase_index', 'phase_title']);
  if ((object.link_id !== null && (!safeInteger(object.link_id) || object.link_id <= 0)) ||
      !safeInteger(object.plan_id) || object.plan_id <= 0 || !safeInteger(object.phase_index) ||
      object.phase_index <= 0 || typeof object.phase_title !== 'string' || object.phase_title.length > 500) {
    throw new HttpClientError('invalid_response');
  }
  return object as unknown as IntakePlanLink;
}

function validateSafeAttachment(value: unknown): Attachment {
  const object = exactObject(value, ['id', 'display_name', 'size', 'mime_type', 'download_url']);
  const urlMatch = typeof object.download_url === 'string'
    ? object.download_url.match(/^\/api\/v1\/attachments\/([1-9][0-9]*)\/content$/)
    : null;
  if (!safeInteger(object.id) || object.id <= 0 || typeof object.display_name !== 'string' || !object.display_name ||
      object.display_name.length > MAXIMUM_ATTACHMENT_NAME_LENGTH || !safeInteger(object.size) || object.size <= 0 ||
      object.size > MAXIMUM_ATTACHMENT_BYTES || typeof object.mime_type !== 'string' || !object.mime_type ||
      !urlMatch || Number(urlMatch[1]) !== object.id) {
    throw new HttpClientError('invalid_response');
  }
  return object as unknown as Attachment;
}

function validateAttachmentUpload(value: unknown): AttachmentUploadResult {
  const object = exactObject(value, ['attachment', 'state', 'recovery_required']);
  if (typeof object.state !== 'string' || !object.state || typeof object.recovery_required !== 'boolean') {
    throw new HttpClientError('invalid_response');
  }
  return {
    attachment: validateSafeAttachment(object.attachment),
    state: object.state,
    recovery_required: object.recovery_required,
  };
}

function validateAttachmentDelete(value: unknown): AttachmentDeleteResult {
  const object = exactObject(value, ['attachment_id', 'state', 'recovery_required']);
  if (!safeInteger(object.attachment_id) || object.attachment_id <= 0 || typeof object.state !== 'string' ||
      !object.state || typeof object.recovery_required !== 'boolean') {
    throw new HttpClientError('invalid_response');
  }
  return object as unknown as AttachmentDeleteResult;
}

function validateIntakeMutation(value: unknown): IntakeMutationResult {
  const object = exactObject(value, ['snapshot'], ['cleanup']);
  if (object.cleanup !== undefined && !isRecord(object.cleanup)) throw new HttpClientError('invalid_response');
  return {
    snapshot: validateSnapshot(object.snapshot),
    ...(object.cleanup === undefined ? {} : { cleanup: object.cleanup }),
  };
}

function validateSuccessEnvelope<T>(value: unknown, validate: (value: unknown) => T): SuccessEnvelope<T> {
  const object = exactObject(value, ['data', 'request_id']);
  if (!validRequestID(object.request_id)) throw new HttpClientError('invalid_response');
  return { data: validate(object.data), request_id: object.request_id as string };
}

function validateErrorEnvelope(value: unknown): ErrorEnvelope {
  const object = exactObject(value, ['code', 'message', 'request_id', 'retryable'], ['details']);
  if (typeof object.code !== 'string' || !SERVER_ERROR_CODES.has(object.code) ||
      typeof object.message !== 'string' || !object.message || !validRequestID(object.request_id) ||
      typeof object.retryable !== 'boolean' ||
      (object.details !== undefined && !isRecord(object.details))) {
    throw new HttpClientError('invalid_error_response', 0);
  }
  return object as unknown as ErrorEnvelope;
}

function validateProject(value: unknown): Project {
  if (!isRecord(value) || !safeInteger(value.id) || value.id <= 0 ||
      typeof value.name !== 'string' || !value.name || typeof value.workspace_path !== 'string' ||
      typeof value.description !== 'string' || !validUTC(value.created_at) || !validUTC(value.updated_at)) {
    throw new HttpClientError('invalid_response');
  }
  return value as unknown as Project;
}

function validateSnapshot(value: unknown): AppSnapshot {
  const required = [
    'activeProjectId', 'activeProject', 'projects', 'mcp', 'state', 'requirements',
    'feedback', 'attachments', 'plans', 'tasks', 'events', 'scans', 'scanSummary',
    'scripts', 'executors', 'terminals', 'activeOperation', 'activeOperations', 'lastOperation',
  ];
  const object = exactObject(value, required);
  if (!Array.isArray(object.projects) || !Array.isArray(object.attachments) || !isRecord(object.mcp) ||
      !required.filter((key) => [
        'projects', 'mcp', 'activeProjectId', 'activeProject', 'state', 'scanSummary',
        'activeOperation', 'lastOperation',
      ].includes(key)).every((key) => key in object)) {
    throw new HttpClientError('invalid_response');
  }
  for (const key of [
    'requirements', 'feedback', 'plans', 'tasks', 'events', 'scans',
    'scripts', 'executors', 'terminals', 'activeOperations',
  ]) {
    if (!Array.isArray(object[key])) throw new HttpClientError('invalid_response');
  }
  const projects = object.projects.map(validateProject);
  const attachments = object.attachments.map(validateSafeAttachment);
  if ((object.activeProjectId === null) !== (object.activeProject === null) ||
      (object.activeProjectId !== null &&
        (!safeInteger(object.activeProjectId) || object.activeProjectId <= 0))) {
    throw new HttpClientError('invalid_response');
  }
  if (object.activeProject !== null) {
    const active = validateProject(object.activeProject);
    if (active.id !== object.activeProjectId) throw new HttpClientError('invalid_response');
  }
  return { ...object, projects, attachments } as unknown as AppSnapshot;
}

function plansFromSnapshot(snapshot: AppSnapshot, projectId: number): Plan[] {
  if (!Array.isArray(snapshot.plans)) throw new HttpClientError('invalid_response');
  return plansForProject(validatePlans(snapshot.plans), projectId);
}

function tasksFromSnapshot(snapshot: AppSnapshot, projectId: number, planId?: number): PlanTask[] {
  if (!Array.isArray(snapshot.tasks)) throw new HttpClientError('invalid_response');
  const tasks = validatePlanTasks(snapshot.tasks);
  if (planId === undefined) {
    return tasks.filter((task) => (task as PlanTask & { project_id?: number }).project_id === projectId);
  }
  return tasksForPlan(tasks, projectId, planId);
}

function plansForProject(plans: readonly Plan[], projectId: number): Plan[] {
  if (plans.some((plan) => plan.project_id !== projectId)) throw new HttpClientError('invalid_response');
  return [...plans];
}

function tasksForPlan(tasks: readonly PlanTask[], projectId: number, planId: number): PlanTask[] {
  if (tasks.some((task) => task.plan_id !== planId ||
      (task as PlanTask & { project_id?: number }).project_id !== projectId)) {
    throw new HttpClientError('invalid_response');
  }
  return [...tasks];
}

function eventsFromSnapshot(snapshot: AppSnapshot, projectId: number, limit = 200, offset = 0): AppEvent[] {
  if (!Array.isArray(snapshot.events)) throw new HttpClientError('invalid_response');
  const events = validatePlanEvents(snapshot.events).filter((event) => event.project_id === projectId);
  return events.slice(offset, offset + limit);
}

function findPlan(plans: readonly Plan[], planId: number): Plan {
  const plan = plans.find((item) => item.id === planId);
  if (!plan) throw new HttpClientError('not_found', 404);
  return plan;
}

function findTask(tasks: readonly PlanTask[], taskId: number): PlanTask {
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw new HttpClientError('not_found', 404);
  return task;
}

function normalizedPlanIDs(input: ReorderPlansInput, plans: ReadonlyMap<number, Plan>): number[] {
  const record = input as unknown as Record<string, unknown>;
  const supplied = record.planIds ?? record.plan_ids;
  if (!Array.isArray(supplied) || supplied.some((id) => !safeInteger(id) || id <= 0) ||
      new Set(supplied).size !== supplied.length || supplied.length !== plans.size) {
    throw new HttpClientError('invalid_plan');
  }
  const result = supplied as number[];
  if (result.some((id) => !plans.has(id))) throw new HttpClientError('invalid_plan');
  return [...result];
}

function planVersions(plans: ReadonlyMap<number, Plan>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [id, plan] of plans) {
    if (!validUTC(plan.updated_at)) throw new HttpClientError('invalid_response');
    result[String(id)] = plan.updated_at;
  }
  return result;
}

function taskVersionsForPlan(tasks: ReadonlyMap<number, PlanTask>, planId: number): Record<string, string> {
  const result: Record<string, string> = {};
  for (const task of tasks.values()) {
    if (task.plan_id !== planId) continue;
    if (!validUTC(task.updated_at)) throw new HttpClientError('invalid_response');
    result[String(task.id)] = task.updated_at;
  }
  return result;
}

function acceptanceCapability(targetType: unknown, action: 'accept' | 'unaccept' | 'redo'): string {
  if (targetType !== 'plan' && targetType !== 'task') throw new HttpClientError('invalid_acceptance');
  return `${targetType === 'plan' ? 'plans' : 'tasks'}.${action}`;
}

function acceptanceTarget(
  input: AcceptanceItemInput,
  context: PlanMutationContext,
): Record<string, unknown> {
  const id = positiveInteger(input?.id, 'invalid_acceptance');
  if (input.targetType === 'plan') {
    const plan = findPlan([...context.plans.values()], id);
    return { target_type: 'plan', id, expected_updated_at: plan.updated_at };
  }
  if (input.targetType === 'task') {
    const task = findTask([...context.tasks.values()], id);
    return { target_type: 'task', id, expected_updated_at: task.updated_at };
  }
  throw new HttpClientError('invalid_acceptance');
}

function safeRelativePlanReference(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replaceAll('\\', '/');
  return normalized === '' || (!normalized.startsWith('/') && !normalized.startsWith('file:') &&
    !/^[A-Za-z]:\//.test(normalized) && !normalized.split('/').includes('..'));
}

function nullableUTC(value: unknown): boolean {
  return value === null || validUTC(value);
}

function emptyConcurrencySuggestion(): Record<string, unknown> {
  return {
    hasSafeParallelBatches: false, parallelTaskCount: 0, batchCount: 0,
    serialTaskCount: 0, maxParallelTasks: 1, batches: [], serialTasks: [],
  };
}

function validConcurrencySuggestion(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const required = [
    'hasSafeParallelBatches', 'parallelTaskCount', 'batchCount', 'serialTaskCount',
    'maxParallelTasks', 'batches', 'serialTasks',
  ];
  return required.every((key) => key in value) && typeof value.hasSafeParallelBatches === 'boolean' &&
    safeInteger(value.parallelTaskCount) && value.parallelTaskCount >= 0 &&
    safeInteger(value.batchCount) && value.batchCount >= 0 &&
    safeInteger(value.serialTaskCount) && value.serialTaskCount >= 0 &&
    safeInteger(value.maxParallelTasks) && value.maxParallelTasks > 0 &&
    Array.isArray(value.batches) && Array.isArray(value.serialTasks);
}

function requireSnapshotVersion(snapshot: AppSnapshot, projectId: number): number {
  const state = snapshot.state;
  if (!isRecord(state) || state.project_id !== projectId ||
      !safeInteger(state.version) || state.version <= 0) {
    throw new HttpClientError('invalid_response');
  }
  return state.version;
}

function validateFilePolicy(value: unknown): FilePolicyContract {
  const object = exactObject(value, [
    'scope', 'allow_cross_project', 'allowed_roots', 'version', 'high_risk',
  ]);
  if (!['project', 'workspace', 'custom', 'all'].includes(String(object.scope)) ||
      typeof object.allow_cross_project !== 'boolean' || !Array.isArray(object.allowed_roots) ||
      object.allowed_roots.length > 128 || object.allowed_roots.some(
        (root) => typeof root !== 'string' || root.length === 0 || root.length > 4096,
      ) ||
      !safeInteger(object.version) || object.version <= 0 || typeof object.high_risk !== 'boolean' ||
      object.high_risk !== (object.scope === 'all')) {
    throw new HttpClientError('invalid_response');
  }
  return object as unknown as FilePolicyContract;
}

function fileAccessSettings(policy: FilePolicyContract): FileAccessSettings {
  return {
    scope: policy.scope,
    allowCrossProject: policy.allow_cross_project,
    allowedRoots: [...policy.allowed_roots],
    version: policy.version,
    highRisk: policy.high_risk,
  };
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpClientError('invalid_response');
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !(key in value))) {
    throw new HttpClientError('invalid_response');
  }
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
function validRequestID(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}
function validUTC(value: unknown): value is string {
  return typeof value === 'string' && UTC_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}
function requestIDOf(value: unknown): string {
  if (!isRecord(value) || !validRequestID(value.request_id)) throw new HttpClientError('invalid_response');
  return value.request_id;
}
function assertResponseRequestID(response: Response, requestId: string) {
  const header = response.headers.get('X-Request-ID');
  if (!validRequestID(header) || header !== requestId) throw new HttpClientError('invalid_response', response.status);
}
function mediaType(value: string | null): string {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}
function projectListSnapshot(source: AppSnapshot, projects: Project[]): AppSnapshot {
  return {
    ...source,
    activeProjectId: null,
    activeProject: null,
    projects,
    state: null,
    requirements: [],
    feedback: [],
    attachments: [],
    plans: [],
    tasks: [],
    events: [],
    scans: [],
    scripts: [],
    executors: [],
    terminals: [],
    activeOperation: null,
    activeOperations: [],
    lastOperation: null,
  };
}

function emptyProjectListSnapshot(): AppSnapshot {
  return {
    activeProjectId: null,
    activeProject: null,
    projects: [],
    mcp: {
      enabled: false,
      running: false,
      status: 'disabled',
      transport: 'http',
      host: null,
      port: null,
      path: null,
      url: null,
      hasAuthToken: false,
      authTokenMasked: '',
      authHeader: '',
      localOnly: true,
      tools: [],
      toolDocs: [],
      connectionExample: '',
      note: '',
      lastEvent: null,
      lastError: null,
      startedAt: null,
    },
    state: null,
    requirements: [],
    feedback: [],
    attachments: [],
    plans: [],
    tasks: [],
    events: [],
    scans: [],
    scanSummary: { count: 0, total_size: 0, latest_scanned_at: null, latest_modified_at: null },
    scripts: [],
    executors: [],
    terminals: [],
    activeOperation: null,
    activeOperations: [],
    lastOperation: null,
  };
}
