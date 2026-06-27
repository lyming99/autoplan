import type { AppSnapshot, ProjectState } from '../../types';
import { CodexLog } from '../CodexLog';
import { EventList } from '../PlanLists';
import { Icon, type IconName } from '../icons';
import {
  agentCliProviderLabel,
  codexReasoningEffortLabel,
  readAgentCliProvider,
  readCodexReasoningEffort,
} from '../shared';
import { formatChinaTime } from '../../utils/time';

export function WorkspaceOverviewView({
  snapshot,
  state,
  onGoTasks,
}: {
  snapshot: AppSnapshot;
  state: ProjectState | null;
  onGoTasks: () => void;
}) {
  const reqCount = snapshot.requirements.length;
  const planCount = snapshot.plans.length;
  const runningPlan = snapshot.plans.find((plan) => !['completed'].includes(plan.status));
  const doneTasks = snapshot.tasks.filter((task) => task.status === 'completed').length;
  const totalTasks = snapshot.tasks.length;

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
  const operationReasoningLabel = operationProvider !== 'claude'
    ? `思考${codexReasoningEffortLabel(readCodexReasoningEffort(operationCliSource))}`
    : '';
  const operationSessionLabel = operationProviderLabel === 'Codex' ? operation?.codexSessionLabel : '';
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
          sub={stateProvider === 'claude' ? `间隔 ${state?.interval_seconds || 5}s` : `思考${stateReasoningLabel} · 间隔 ${state?.interval_seconds || 5}s`}
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
              <EventList events={snapshot.events.slice(0, 8)} />
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

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
      waiting: '等待',
      error: '异常',
    }[phase] || phase
  );
}
