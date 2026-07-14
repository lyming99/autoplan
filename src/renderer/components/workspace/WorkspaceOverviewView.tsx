import { memo } from 'react';
import type { AppSnapshot, AppEventMeta, CodexSessionInfo, AgentCliSessionInfo, ProjectState } from '../../types';
import { CodexLog, agentCliSessionContextLabel } from '../CodexLog';
import { EventList } from '../PlanLists';
import { Icon, type IconName } from '../icons';
import {
  agentCliProviderLabel,
  codexReasoningEffortLabel,
  readAgentCliProvider,
  readCodexReasoningEffort,
} from '../shared';
import { formatChinaTime } from '../../utils/time';

type EventSessionMeta = Record<string, unknown> & AgentCliSessionInfo & CodexSessionInfo;

type OverviewProps = {
  snapshot: AppSnapshot;
  state: ProjectState | null;
  onGoTasks: () => void;
};

/** 仅提取概览页实际使用的快照字段做比较指纹 */
function overviewSnapshotKey(s: AppSnapshot): string {
  const op = s.activeOperation || s.lastOperation;
  const activity = op?.activity;
  const acts = activity?.length || 0;
  const lastAct = acts > 0 ? `${activity![acts - 1].at}|${activity![acts - 1].role}|${activity![acts - 1].text}` : '';
  return [
    s.requirements.length,
    s.plans.length,
    s.plans.map(p => `${p.id}:${p.status}:${p.completed_tasks}/${p.total_tasks}`).join(','),
    s.tasks.length,
    s.tasks.filter(t => t.status === 'completed').length,
    s.tasks.filter(t => t.status === 'failed').length,
    s.events.filter(e => !String(e.type || '').startsWith('scan.')).length,
    s.events.length > 0 ? s.events[0].id : '',
    op?.label ?? '',
    op?.label ?? '',
    op?.logTail?.slice(-500) ?? '',
    op?.startedAt ?? '',
    op?.exitCode ?? '',
    Boolean(s.activeOperation),
    acts,
    lastAct,
  ].join('|');
}

function overviewStateKey(st: ProjectState | null): string {
  if (!st) return '';
  return `${st.running ? 1 : 0}|${st.phase || ''}|${st.agent_cli_provider || ''}|${st.interval_seconds || 0}`;
}

function areOverviewPropsEqual(prev: OverviewProps, next: OverviewProps): boolean {
  if (prev.onGoTasks !== next.onGoTasks) return false;
  if (overviewSnapshotKey(prev.snapshot) !== overviewSnapshotKey(next.snapshot)) return false;
  if (overviewStateKey(prev.state) !== overviewStateKey(next.state)) return false;
  return true;
}

export const WorkspaceOverviewView = memo(function WorkspaceOverviewView({
  snapshot,
  state,
  onGoTasks,
}: OverviewProps) {
  const reqCount = snapshot.requirements.length;
  const planCount = snapshot.plans.length;
  const runningPlan = snapshot.plans.find((plan) => !['completed'].includes(plan.status));
  const doneTasks = snapshot.tasks.filter((task) => task.status === 'completed').length;
  const totalTasks = snapshot.tasks.length;
  const recentEvents = snapshot.events
    .filter((event) => !String(event.type || '').startsWith('scan.'))
    .slice(0, 8)
    .map(withAgentSessionEventLabel);

  const phases = ['scan', 'generate-plan', 'execute-task', 'validate', 'completed'];
  const currentPhase = state?.phase || 'idle';
  const activeIndex = phases.indexOf(currentPhase);
  const operation = snapshot.activeOperation || snapshot.lastOperation;
  const operationActive = Boolean(snapshot.activeOperation);
  const operationCliSource = operation
    ? {
        agentCliProvider: operation.agentCliProvider || state?.agent_cli_provider,
        codexReasoningEffort: operation.codexReasoningEffort || state?.codex_reasoning_effort,
      }
    : state;
  const operationProvider = readAgentCliProvider(operationCliSource);
  const operationProviderLabel = agentCliProviderLabel(operationProvider);
  const operationReasoningLabel = operationProvider === 'codex'
    ? `思考${codexReasoningEffortLabel(readCodexReasoningEffort(operationCliSource))}`
    : '';
  const operationSessionLabel = operation
    ? agentCliSessionContextLabel(operation, operationProviderLabel, { includeProvider: false })
    : '';
  const operationTime = operation?.startedAt ? `开始于 ${formatChinaTime(operation.startedAt)}` : '';
  const operationExit =
    operation && !operationActive && typeof operation.exitCode === 'number'
      ? `退出码 ${operation.exitCode}${operation.exitCode === 0 ? '（成功）' : '（失败）'}`
      : '';
  const operationHint = operation
    ? [operationProviderLabel, operationReasoningLabel, operationTime, operationSessionLabel, operationExit].filter(Boolean).join(' · ')
    : '等待下一次执行';
  const operationTitle = operation
    ? `${operationActive ? '执行日志' : '最近执行'} · ${operationProviderLabel} · ${operation.label}`
    : `执行日志 · ${operationProviderLabel}`;
  const stateProvider = readAgentCliProvider(state);
  const stateProviderLabel = agentCliProviderLabel(stateProvider);
  const stateReasoningLabel = codexReasoningEffortLabel(readCodexReasoningEffort(state));

  return (
    <>
      <div className="stat-grid">
        <StatCard icon="requirement" value={String(reqCount)} label="需求" accent="brand" />
        <StatCard
          icon="plan"
          value={String(planCount)}
          label="计划"
          sub={runningPlan ? `${runningPlan.completed_tasks}/${runningPlan.total_tasks} 任务` : '无进行中'}
          accent="info"
        />
        <StatCard icon="tasks" value={`${doneTasks}/${totalTasks}`} label="任务进度" accent="success" />
        <StatCard
          icon="settings"
          value={stateProviderLabel}
          label="CLI 后端"
          sub={stateProvider === 'codex' ? `思考${stateReasoningLabel} · 间隔 ${state?.interval_seconds || 5}s` : `间隔 ${state?.interval_seconds || 5}s`}
          accent="warning"
        />
      </div>

      <div className="overview-grid">
        <div className="overview-main-column">
          <section className="card live-log-card">
            <div className="card-head log-card-head">
              <div className="log-title-line">
                <h2>
                  <span className={`live-dot${operationActive ? '' : ' idle'}`} /> {operationTitle}
                </h2>
                <span className="hint">{operationHint}</span>
                <span className={`log-phase-chip ${state?.running ? 'running' : 'stopped'}`}>
                  {state?.running ? '循环运行中' : '循环已停止'} · {operationProviderLabel} · {currentPhase}
                </span>
              </div>
              <div className="log-summary">
                <span>
                  需求 <b>{snapshot.requirements.length}</b>
                </span>
                <span>
                  反馈 <b>{snapshot.feedback.length}</b>
                </span>
                <span>
                  Plan <b>{snapshot.plans.length}</b>
                </span>
              </div>
            </div>
            <CodexLog
              log={operation?.logTail || ''}
              activity={operation?.activity || []}
              context={operation || null}
              provider={operationProvider}
            />
          </section>
        </div>

        <div className="overview-side-column">
          <section className="card">
            <div className="card-head">
              <h2>循环阶段流水线</h2>
            </div>
            <div className="card-body">
              <div className="pipeline">
                {phases.map((phase, index) => {
                  const done = activeIndex > index;
                  const active = activeIndex === index;
                  return (
                    <div className={`pipe-step ${done ? 'done' : ''} ${active ? 'active' : ''}`} key={phase}>
                      <div className="pipe-node">
                        {done ? (
                          <Icon name="complete" size={18} className="pipe-status-icon" aria-hidden="true" />
                        ) : active ? (
                          <Icon name="run" size={18} className="pipe-status-icon" aria-hidden="true" />
                        ) : (
                          index + 1
                        )}
                      </div>
                      <div className="pipe-label">{phaseLabel(phase)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>近期事件</h2>
              <span className="spacer">
                <button type="button" className="btn-link" onClick={onGoTasks}>
                  查看任务
                  <Icon name="enter" size={14} aria-hidden />
                </button>
              </span>
            </div>
            <div className="card-body">
              <EventList events={recentEvents} />
            </div>
          </section>
        </div>
      </div>
    </>
  );
}, areOverviewPropsEqual);

function StatCard({
  icon,
  value,
  label,
  sub,
  accent,
}: {
  icon: IconName;
  value: string;
  label: string;
  sub?: string;
  accent: 'brand' | 'info' | 'success' | 'warning';
}) {
  return (
    <div className={`stat stat-${accent}`}>
      <div className="stat-ico">
        <Icon name={icon} size={20} aria-hidden="true" />
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub ? <div className="stat-delta">{sub}</div> : null}
    </div>
  );
}

function phaseLabel(phase: string) {
  return (
    {
      idle: '空闲',
      scan: '扫描',
      'generate-plan': '生成计划',
      'execute-task': '执行任务',
      validate: '验收',
      completed: '完成',
      waiting: '等待下一轮',
      error: '异常',
    }[phase] || phase
  );
}

function withAgentSessionEventLabel(event: AppSnapshot['events'][number]) {
  const meta = event.meta;
  if (!isEventMetaObject(meta)) return event;
  const providerLabel = agentCliProviderLabel(readAgentCliProvider(meta));
  const sessionLabel = agentCliSessionContextLabel(meta, providerLabel);
  if (!sessionLabel) return event;
  return {
    ...event,
    meta: {
      ...meta,
      agentCliSessionLabel: sessionLabel,
      codexSessionLabel: sessionLabel,
    },
  };
}

function isEventMetaObject(meta: AppEventMeta | null | undefined): meta is EventSessionMeta {
  return Boolean(meta && typeof meta === 'object' && !Array.isArray(meta));
}
