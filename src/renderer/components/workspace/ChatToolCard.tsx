import { useState } from 'react';
import type { ChatMessage, ChatPlanToolResult, IntakeType, OpenIntakeHandler } from '../../types';
import { buildIntakeAnchorId } from '../../utils/chatIntents';
import { Modal } from '../Modal';
import { Icon } from '../icons';

/** 工具调用摘要与详情弹窗 */
export function ChatToolCard({ message, onOpenIntake }: { message: ChatMessage; onOpenIntake?: OpenIntakeHandler }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const result = (message.toolResult || {}) as Record<string, unknown>;
  const name = String(result.name || '工具');
  const args = result.args;
  const isLoading = result.loading === true;
  const toolResult = result.result;
  const hasToolResult = Object.prototype.hasOwnProperty.call(result, 'result');
  const toolResultRecord = asRecord(toolResult);
  const toolErrorText = formatToolErrorText(toolResultRecord);
  const isError = message.status === 'error' || message.status === 'aborted' || Boolean(toolErrorText);
  const hasArgs = hasDisplayableToolValue(args);
  const hasVisibleToolResult = hasDisplayableToolValue(toolResult);
  const statusKind = isLoading ? 'loading' : isError ? 'error' : 'success';
  const statusLabel = isLoading ? '执行中' : isError ? '执行失败' : '已完成';
  const statusIcon = isLoading ? 'settings' : isError ? 'alert' : 'check';
  const summary = formatToolSummary(args, toolResult, hasToolResult, isLoading);

  // 可打开 intake 卡片识别：create_*/open_* 且 result.id 为正整数才视为可打开主键
  const intakeResult = toolResult && typeof toolResult === 'object' && !Array.isArray(toolResult)
    ? (toolResult as Record<string, unknown>)
    : null;
  const intakeType = intakeTypeFromToolName(name);
  const intakeId = intakeResult ? toPositiveInt(intakeResult.id) : null;
  const isOpenResult = name === 'open_requirement' || name === 'open_feedback';
  const hasOpenableIntake = intakeType !== null && intakeId !== null && OPENABLE_INTAKE_TOOLS.has(name);
  const intakeErrorText = intakeResult && typeof intakeResult.error === 'string' && intakeResult.error.trim()
    ? intakeResult.error.trim()
    : '';
  const intakeNotFound = intakeResult?.errorCode === 'INTAKE_NOT_FOUND';
  const planResult = planToolResultFromResult(name, toolResultRecord);
  const planErrorText = name === 'create_plan' && !planResult ? toolErrorText : '';

  const resolveIntakeProjectId = (): number | null =>
    toPositiveInt(intakeResult?.projectId)
    ?? toPositiveInt(message.projectId)
    ?? toPositiveInt(message.project_id)
    ?? null;

  const handleOpenIntake = () => {
    if (!onOpenIntake || !hasOpenableIntake || !intakeType || intakeId === null) return;
    const projectId = resolveIntakeProjectId();
    if (projectId === null) return;
    onOpenIntake({ type: intakeType, projectId, id: intakeId });
  };

  const handleCopyIntakeLink = () => {
    if (!intakeType || intakeId === null) return;
    const projectId = resolveIntakeProjectId();
    if (projectId === null) return;
    void copyIntakeLink(intakeType, projectId, intakeId);
  };

  return (
    <div className={`chat-message chat-message--tool chat-message--tool-${statusKind}`}>
      <div className="chat-tool-card">
        <button
          type="button"
          className="chat-tool-card__header"
          onClick={() => setDetailOpen(true)}
          aria-haspopup="dialog"
          aria-label={`查看工具调用详情：${name}，${statusLabel}`}
        >
          <span className={`chat-tool-card__icon chat-tool-card__icon--${statusKind}`} aria-hidden>
            <Icon name={statusIcon} size={14} />
          </span>
          <span className="chat-tool-card__meta">
            <span className="chat-tool-card__title-row">
              <span className="chat-tool-card__name">{name}</span>
              <span className={`chat-tool-card__status chat-tool-card__status--${statusKind}`}>{statusLabel}</span>
            </span>
            {summary ? (
              <span className="chat-tool-card__args" title={summary}>{summary}</span>
            ) : null}
          </span>
          <span className="chat-tool-card__open" aria-hidden>
            <Icon name="eye" size={14} />
          </span>
        </button>
        {hasOpenableIntake && intakeType ? (
          <IntakeOpenCard
            type={intakeType}
            title={typeof intakeResult?.title === 'string' ? intakeResult.title : ''}
            status={typeof intakeResult?.status === 'string' ? intakeResult.status : ''}
            body={isOpenResult && typeof intakeResult?.body === 'string' ? intakeResult.body : ''}
            linkedPlan={isOpenResult ? intakeResult?.linkedPlan : undefined}
            hasOpenHandler={Boolean(onOpenIntake)}
            onOpen={handleOpenIntake}
            onCopyLink={handleCopyIntakeLink}
          />
        ) : null}
        {planResult ? (
          <PlanResultCard result={planResult} />
        ) : null}
        {planErrorText ? (
          <div className="chat-tool-card__intake-error">
            <Icon name="alert" size={13} aria-hidden />
            <span>{planErrorText}</span>
          </div>
        ) : null}
        {!hasOpenableIntake && intakeType && (intakeErrorText || intakeNotFound) ? (
          <div className="chat-tool-card__intake-error">
            <Icon name="alert" size={13} aria-hidden />
            <span>{intakeErrorText || (intakeType === 'feedback' ? '未找到该反馈' : '未找到该需求')}</span>
          </div>
        ) : null}
        <Modal
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
          title="工具调用详情"
          size="wide"
          maxWidth={760}
          className="chat-tool-modal"
          bodyClassName="chat-tool-modal__body"
        >
          <div className="chat-tool-modal__summary">
            <div className="chat-tool-modal__field">
              <span className="chat-tool-modal__label">工具名称</span>
              <strong className="chat-tool-modal__value">{name}</strong>
            </div>
            <div className="chat-tool-modal__field">
              <span className="chat-tool-modal__label">执行状态</span>
              <span className={`chat-tool-modal__status chat-tool-modal__status--${statusKind}`}>
                <Icon name={statusIcon} size={14} aria-hidden />
                {statusLabel}
              </span>
            </div>
          </div>

          <div className="chat-tool-modal__section">
            <div className="chat-tool-modal__section-title">参数</div>
            {hasArgs ? (
              <pre className="chat-tool-modal__code"><code>{formatToolResult(args)}</code></pre>
            ) : (
              <div className="chat-tool-modal__empty">无参数</div>
            )}
          </div>

          <div className="chat-tool-modal__section">
            <div className="chat-tool-modal__section-title">结果</div>
            {hasVisibleToolResult ? (
              <pre className="chat-tool-modal__code"><code>{formatToolResult(toolResult)}</code></pre>
            ) : isLoading || (hasToolResult && result.loading === true) ? (
              <div className="chat-tool-modal__empty">等待结果...</div>
            ) : (
              <div className="chat-tool-modal__empty">无返回内容</div>
            )}
          </div>
        </Modal>
      </div>
    </div>
  );
}

function hasDisplayableToolValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function formatToolArgsSummary(value: unknown): string {
  if (!hasDisplayableToolValue(value)) return '';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    const summary = entries
      .slice(0, 2)
      .map(([key, val]) => `${key}=${compactToolText(formatToolResult(val), 32)}`)
      .join(', ');
    return compactToolText(entries.length > 2 ? `${summary}, ...` : summary, 92);
  }
  return compactToolText(formatToolResult(value), 92);
}

function formatToolSummary(args: unknown, toolResult: unknown, hasToolResult: boolean, isLoading: boolean): string {
  const argsSummary = formatToolArgsSummary(args);
  if (argsSummary) return `参数 ${argsSummary}`;
  if (isLoading) return '等待结果';
  if (!hasToolResult || !hasDisplayableToolValue(toolResult)) return '无返回内容';
  return '结果已返回';
}

function compactToolText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatToolErrorText(result: Record<string, unknown> | null): string {
  if (!result) return '';
  const error = typeof result.error === 'string' ? result.error.trim() : '';
  if (error) return error;
  const errorCode = typeof result.errorCode === 'string' ? result.errorCode.trim() : '';
  return errorCode ? `工具返回错误：${errorCode}` : '';
}

function planToolResultFromResult(name: string, result: Record<string, unknown> | null): ChatPlanToolResult | null {
  if (!result) return null;
  if (result.type !== 'plan' && name !== 'create_plan') return null;
  if (typeof result.error === 'string' && result.error.trim()) return null;

  const id = toPositiveInt(result.id);
  const title = typeof result.title === 'string' ? result.title.trim() : '';
  const status = typeof result.status === 'string' ? result.status.trim() : '';
  const filePath = typeof result.filePath === 'string' ? result.filePath.trim() : '';
  const totalTasks = toNonNegInt(result.totalTasks) ?? 0;
  if (!title && !filePath && id === null) return null;

  return {
    type: 'plan',
    id,
    title: title || (id !== null ? `Plan #${id}` : '执行计划'),
    status,
    totalTasks,
    filePath,
    projectId: toPositiveInt(result.projectId),
    openable: result.openable === true,
  };
}

/* ------------------------------------------------------------------ intake 可打开卡片 ------------------------------------------------------------------ */

/** 可打开 intake 工具（按 name 识别，渲染富卡片 + 打开/复制链接动作）。 */
const OPENABLE_INTAKE_TOOLS: ReadonlySet<string> = new Set([
  'create_requirement',
  'create_feedback',
  'open_requirement',
  'open_feedback',
]);

/** 由工具 name 映射出 intake 类型（name 始终存在，比 result.type 更可靠）。 */
function intakeTypeFromToolName(name: string): IntakeType | null {
  switch (name) {
    case 'create_requirement':
    case 'open_requirement':
      return 'requirement';
    case 'create_feedback':
    case 'open_feedback':
      return 'feedback';
    default:
      return null;
  }
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toNonNegInt(value: unknown): number | null {
  if (typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/* ------------------------------------------------------------------ plan 结果卡片 ------------------------------------------------------------------ */

function PlanResultCard({ result }: { result: ChatPlanToolResult }) {
  const idText = result.id !== null ? `#${result.id}` : '';
  const taskText = result.totalTasks > 0 ? `${result.totalTasks} 个任务` : '任务数未返回';

  return (
    <div className="chat-tool-card__intake chat-tool-card__plan">
      <div className="chat-tool-card__intake-head">
        <span className="chat-tool-card__intake-type">计划</span>
        <span className="chat-tool-card__intake-title" title={result.title}>{result.title}</span>
        {result.status ? <span className="chat-tool-card__intake-status">{result.status}</span> : null}
      </div>
      <div className="chat-tool-card__intake-plan">
        <Icon name="plan" size={13} aria-hidden />
        <span className="chat-tool-card__intake-plan-title" title={result.filePath || idText}>
          {result.filePath || '计划文件已创建'}
        </span>
        <span className="chat-tool-card__intake-plan-progress">{taskText}</span>
      </div>
      {idText ? <p className="chat-tool-card__intake-body">Plan {idText}</p> : null}
    </div>
  );
}

/** 应用内定位深链（HashRouter）：含项目 / 类型 / 锚点。 */
function buildIntakeDeepLink(type: IntakeType, projectId: number, id: number): string {
  const { origin, pathname } = window.location;
  const anchor = buildIntakeAnchorId(type, id);
  return `${origin}${pathname}#/projects/${projectId}?tab=${type}&anchor=${anchor}`;
}

/** 复制应用内定位链接到剪贴板；剪贴板不可用时静默降级，不抛错。 */
async function copyIntakeLink(type: IntakeType, projectId: number, id: number): Promise<void> {
  try {
    await navigator.clipboard?.writeText(buildIntakeDeepLink(type, projectId, id));
  } catch {
    /* 剪贴板不可用，静默降级 */
  }
}

/**
 * 可打开 intake 富卡片：标题、状态徽标、（open_*）正文摘要 + 绑定 Plan 进度，并提供「打开」「复制链接」动作。
 * 无 onOpenIntake（无 UI 链路）时仅展示详情文本与「复制链接」，不报错。
 */
function IntakeOpenCard({
  type,
  title,
  status,
  body,
  linkedPlan,
  hasOpenHandler,
  onOpen,
  onCopyLink,
}: {
  type: IntakeType;
  title: string;
  status: string;
  body: string;
  linkedPlan: unknown;
  hasOpenHandler: boolean;
  onOpen: () => void;
  onCopyLink: () => void;
}) {
  const typeLabel = type === 'requirement' ? '需求' : '反馈';
  const plan = linkedPlan && typeof linkedPlan === 'object' && !Array.isArray(linkedPlan)
    ? (linkedPlan as Record<string, unknown>)
    : null;
  const planTitle = plan && typeof plan.title === 'string' ? plan.title : '';
  const planCompleted = plan ? toNonNegInt(plan.completed) : null;
  const planTotal = plan ? toNonNegInt(plan.total) : null;
  const hasPlan = Boolean(plan && (planTitle || planTotal !== null));

  return (
    <div className="chat-tool-card__intake">
      <div className="chat-tool-card__intake-head">
        <span className="chat-tool-card__intake-type">{typeLabel}</span>
        <span className="chat-tool-card__intake-title" title={title}>{title || typeLabel}</span>
        {status ? <span className="chat-tool-card__intake-status">{status}</span> : null}
      </div>
      {body ? <p className="chat-tool-card__intake-body">{compactToolText(body, 160)}</p> : null}
      {hasPlan ? (
        <div className="chat-tool-card__intake-plan">
          <Icon name="plan" size={13} aria-hidden />
          <span className="chat-tool-card__intake-plan-title" title={planTitle}>{planTitle || '执行计划'}</span>
          {planTotal !== null ? (
            <span className="chat-tool-card__intake-plan-progress">{planCompleted ?? 0}/{planTotal}</span>
          ) : null}
        </div>
      ) : null}
      <div className="chat-tool-card__intake-actions">
        {hasOpenHandler ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={onOpen}>
            <Icon name="open" size={13} aria-hidden />
            打开
          </button>
        ) : null}
        <button type="button" className="btn-link" onClick={onCopyLink}>
          <Icon name="copy" size={13} aria-hidden />
          复制链接
        </button>
      </div>
    </div>
  );
}
