import { useMemo, useState } from 'react';
import type { Plan, PlanTask } from '../../types';
import { Icon } from '../icons';
import { formatChinaDateTime } from '../../utils/time';
import {
  planTitle,
  scopeFileLabel,
  scopeFileStatus,
  type AcceptanceGroup,
  type AcceptedRecord,
} from '../../utils/planTasks';

type AcceptanceTarget = 'plan' | 'task';

interface AcceptanceViewProps {
  projectId: number;
  groups: AcceptanceGroup[];
  recentAccepted: AcceptedRecord[];
  onAccept: (targetType: AcceptanceTarget, id: number) => void;
  onUnaccept: (targetType: AcceptanceTarget, id: number) => void;
}

function basename(filePath: string) {
  if (!filePath) return '';
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function planFileLabel(plan: Plan) {
  return basename(String(plan.file_path || '').trim()) || '未命名计划文件';
}

function planCompletedPct(plan: Plan) {
  const total = Number(plan.total_tasks) || 0;
  if (total <= 0) return 0;
  const completed = Math.min(Number(plan.completed_tasks) || 0, total);
  return Math.round((completed / total) * 100);
}

function planProgressText(plan: Plan) {
  const total = Number(plan.total_tasks) || 0;
  const completed = Number(plan.completed_tasks) || 0;
  if (total <= 0) return '';
  return `${completed} / ${total} · ${planCompletedPct(plan)}%`;
}

function primaryScopeFile(task: PlanTask) {
  const files = task.scope_files || [];
  return files.find((file) => !file.isUnknown && !file.isValidation) || files[0] || null;
}

function primaryScopeLabel(task: PlanTask) {
  const file = primaryScopeFile(task);
  if (file) return scopeFileLabel(file);
  return String(task.scope || '').trim();
}

function recordId(record: AcceptedRecord) {
  return record.targetType === 'plan' ? record.plan.id : record.task.id;
}

/**
 * 验收视图（P007）：把「已完成且未验收」的计划/任务按计划分组渲染为两级 checklist，
 * 勾选即验收、取消即回退；交互走 onAccept/onUnaccept → controller → IPC → 落库 accepted_at →
 * 回灌 snapshot 刷新，不做脱离 snapshot 的本地乐观态（与 P001 设计稿一致）。
 */
export function AcceptanceView({
  projectId,
  groups,
  recentAccepted,
  onAccept,
  onUnaccept,
}: AcceptanceViewProps) {
  const [acceptedCollapsed, setAcceptedCollapsed] = useState(false);
  const pendingTaskCount = useMemo(
    () => groups.reduce((sum, group) => sum + group.tasks.length, 0),
    [groups],
  );
  const latestAcceptedAt = recentAccepted.length ? recentAccepted[0].acceptedAt : '';
  const hasPending = groups.length > 0;

  function acceptAllPending() {
    groups.forEach((group) => {
      onAccept('plan', group.plan.id);
      group.tasks.forEach((task) => onAccept('task', task.id));
    });
  }

  function acceptPlanGroup(group: AcceptanceGroup) {
    onAccept('plan', group.plan.id);
    group.tasks.forEach((task) => onAccept('task', task.id));
  }

  return (
    <div className="acceptance-view" data-project-id={projectId}>
      <div className="accept-bar">
        <span className="accept-ico" aria-hidden="true">
          <Icon name="acceptance" size={20} />
        </span>
        <div className="accept-text">
          <p>
            已完成但未验收的<b>计划与任务</b>，逐项勾选即完成验收；取消勾选可回退。
          </p>
          <div className="accept-meta">
            <span>
              待验收 <b>{groups.length}</b> 个计划
            </span>
            <span className="meta-dot" aria-hidden="true" />
            <span>
              <b>{pendingTaskCount}</b> 个任务
            </span>
            {latestAcceptedAt ? (
              <>
                <span className="meta-dot" aria-hidden="true" />
                <span>
                  最近验收 <b className="mono">{formatChinaDateTime(latestAcceptedAt)}</b>
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div className="accept-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={acceptAllPending}
            disabled={!hasPending}
            title={hasPending ? '批量验收当页全部待验收项' : '暂无待验收项'}
          >
            <Icon name="check-double" size={14} aria-hidden="true" />
            全部验收
          </button>
        </div>
      </div>

      {hasPending ? (
        <>
          <div className="accept-section-head">
            <h2>
              待验收
              <span className="count">
                {groups.length} 个计划 · {pendingTaskCount} 个任务
              </span>
            </h2>
            <span className="hint">勾选复选框即验收，取消即回退</span>
          </div>
          <div className="accept-groups">
            {groups.map((group) => (
              <PendingPlanCard
                key={group.plan.id}
                group={group}
                onAccept={onAccept}
                onAcceptGroup={acceptPlanGroup}
              />
            ))}
          </div>
        </>
      ) : (
        <AcceptanceEmpty />
      )}

      {recentAccepted.length ? (
        <AcceptedSection
          records={recentAccepted}
          collapsed={acceptedCollapsed}
          onToggle={() => setAcceptedCollapsed((current) => !current)}
          onUnaccept={onUnaccept}
        />
      ) : null}
    </div>
  );
}

function AcceptanceCheck({
  checked,
  title,
  onClick,
}: {
  checked: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={`check${checked ? ' checked' : ''}`}
      title={title}
      onClick={onClick}
    >
      <Icon name="check" size={13} aria-hidden="true" />
    </button>
  );
}

function PendingPlanCard({
  group,
  onAccept,
  onAcceptGroup,
}: {
  group: AcceptanceGroup;
  onAccept: (targetType: AcceptanceTarget, id: number) => void;
  onAcceptGroup: (group: AcceptanceGroup) => void;
}) {
  const { plan, tasks } = group;
  const pct = planCompletedPct(plan);
  const progressText = planProgressText(plan);
  return (
    <div className="accept-plan">
      <div className="accept-plan-head">
        <AcceptanceCheck
          checked={false}
          title="验收此计划"
          onClick={() => onAccept('plan', plan.id)}
        />
        <div className="plan-main">
          <div className="plan-path mono" title={plan.file_path || undefined}>
            {planFileLabel(plan)}
          </div>
          <div className="plan-title">{planTitle(plan) || '未命名计划'}</div>
        </div>
        <div className="accept-plan-progress">
          {progressText ? (
            <>
              <div className={`progress${pct >= 100 ? ' success' : ''}`}>
                <span style={{ width: `${pct}%` }} />
              </div>
              <span className="progress-text mono">{progressText}</span>
            </>
          ) : null}
        </div>
        <span className="chip chip-completed">completed</span>
        <div className="accept-plan-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onAcceptGroup(group)}
            disabled={tasks.length === 0}
            title={
              tasks.length
                ? `批量验收本计划 ${tasks.length} 个待验收任务`
                : '本计划暂无待验收任务'
            }
          >
            <Icon name="check-double" size={14} aria-hidden="true" />
            全部验收本计划
          </button>
        </div>
      </div>
      {tasks.length ? (
        <div className="accept-tasks">
          {tasks.map((task) => (
            <PendingTaskRow key={task.id} task={task} onAccept={onAccept} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PendingTaskRow({
  task,
  onAccept,
}: {
  task: PlanTask;
  onAccept: (targetType: AcceptanceTarget, id: number) => void;
}) {
  const scopeFile = primaryScopeFile(task);
  const scopeText = primaryScopeLabel(task);
  const scopeTitle = scopeFile ? scopeFileStatus(scopeFile) : scopeText;
  return (
    <div className="accept-task" id={`workspace-acceptance-task-${task.id}`}>
      <AcceptanceCheck checked={false} title="验收此任务" onClick={() => onAccept('task', task.id)} />
      <span className="task-key mono">{task.task_key || `#${task.id}`}</span>
      <span className="task-title" title={task.title}>
        {task.title}
      </span>
      {scopeText ? (
        <span className="task-scope" title={scopeTitle}>
          <Icon name="file" size={12} aria-hidden="true" />
          <span className="mono">{scopeText}</span>
        </span>
      ) : null}
    </div>
  );
}

function recordMetaLine(record: AcceptedRecord) {
  if (record.targetType === 'plan') return planFileLabel(record.plan);
  const key = record.task.task_key || `#${record.task.id}`;
  const scope = primaryScopeLabel(record.task);
  return scope ? `${key} · ${scope}` : key;
}

function AcceptedSection({
  records,
  collapsed,
  onToggle,
  onUnaccept,
}: {
  records: AcceptedRecord[];
  collapsed: boolean;
  onToggle: () => void;
  onUnaccept: (targetType: AcceptanceTarget, id: number) => void;
}) {
  return (
    <div className={`accepted-card${collapsed ? ' collapsed' : ''}`}>
      <button type="button" className="accepted-head" aria-expanded={!collapsed} onClick={onToggle}>
        <span className="acc-caret" aria-hidden="true">
          <Icon name="chevron-down" size={14} />
        </span>
        <span className="acc-title">
          已验收（最近）
          <span className="count">{records.length}</span>
        </span>
        <span className="acc-hint">点击折叠 / 展开</span>
      </button>
      {collapsed ? null : (
        <div className="accepted-body">
          {records.map((record) => (
            <AcceptedRow key={`${record.targetType}-${recordId(record)}`} record={record} onUnaccept={onUnaccept} />
          ))}
        </div>
      )}
    </div>
  );
}

function AcceptedRow({
  record,
  onUnaccept,
}: {
  record: AcceptedRecord;
  onUnaccept: (targetType: AcceptanceTarget, id: number) => void;
}) {
  const isPlan = record.targetType === 'plan';
  const id = recordId(record);
  const title = record.targetType === 'plan' ? planTitle(record.plan) || '未命名计划' : record.task.title;
  const metaLine = recordMetaLine(record);
  return (
    <div className="accepted-item" id={`workspace-acceptance-${record.targetType}-${id}`}>
      <span className="check checked ai-check" aria-hidden="true">
        <Icon name="check" size={13} />
      </span>
      <div className="ai-main">
        <div className="ai-title" title={title}>
          {title}
        </div>
        <div className="ai-meta">
          <span className="ai-type">{isPlan ? '计划' : '任务'}</span>
          {metaLine ? <span className="mono">{metaLine}</span> : null}
          <span className="meta-dot" aria-hidden="true" />
          <span>
            验收于 <span className="mono">{formatChinaDateTime(record.acceptedAt)}</span>
          </span>
        </div>
      </div>
      <div className="ai-actions">
        <button
          type="button"
          className="btn btn-sm accept-undo-btn"
          onClick={() => onUnaccept(record.targetType, id)}
          title="取消验收，回到待验收"
        >
          <Icon name="undo" size={14} aria-hidden="true" />
          取消验收
        </button>
      </div>
    </div>
  );
}

function AcceptanceEmpty() {
  return (
    <div className="accept-empty">
      <div className="empty-ico" aria-hidden="true">
        <Icon name="acceptance" size={28} />
      </div>
      <div className="empty-title">暂无待验收项</div>
      <p>
        当前项目所有已完成的计划与任务均已通过验收。新任务在循环自动验收通过并进入{' '}
        <code>completed</code> 后会出现在这里，供你逐项确认。
      </p>
    </div>
  );
}
