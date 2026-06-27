import type { KeyboardEvent } from 'react';
import type {
  WorkspaceSearchGroup,
  WorkspaceSearchResult,
  WorkspaceSearchSourceType,
  WorkspaceSearchState,
  WorkspaceTab,
} from '../types';
import { formatChinaDateTime } from '../utils/time';
import { Icon, type IconName } from './icons';

const GROUP_RESULT_LIMIT = 4;

const sourceIconNames: Record<WorkspaceSearchSourceType, IconName> = {
  requirement: 'requirement',
  feedback: 'feedback',
  plan: 'plan',
  task: 'tasks',
  event: 'events',
};

const searchTargetLabels: Record<WorkspaceSearchSourceType, string> = {
  requirement: '需求记录',
  feedback: '反馈记录',
  plan: 'Plan',
  task: '任务',
  event: '事件',
};

interface SearchResultsProps {
  onClear: () => void;
  onClose: () => void;
  onSelectGroup: (targetTab: WorkspaceTab) => void;
  onSelectResult: (result: WorkspaceSearchResult) => void;
  open: boolean;
  searchState: WorkspaceSearchState;
}

export function SearchResults({ onClear, onClose, onSelectGroup, onSelectResult, open, searchState }: SearchResultsProps) {
  if (searchState.query.isEmpty || !open) return null;

  const queryLabel = searchState.query.raw.trim().replace(/\s+/g, ' ') || searchState.query.normalized;

  function handleClear() {
    onClear();
    onClose();
  }

  function handleSelectGroup(targetTab: WorkspaceTab) {
    onSelectGroup(targetTab);
    onClose();
  }

  function handleSelectResult(result: WorkspaceSearchResult) {
    onSelectResult(result);
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onClose();
  }

  return (
    <section
      className="search-results search-results-popup card"
      aria-label="统一搜索结果"
      aria-live="polite"
      onKeyDown={handleKeyDown}
      role="dialog"
    >
      <div className="search-results-head">
        <div>
          <h2>搜索结果概览</h2>
          <p>
            “{queryLabel}” 命中 <b>{searchState.total}</b> 条结果
          </p>
        </div>
        <button type="button" className="search-results-clear" onClick={handleClear}>
          清空搜索
        </button>
      </div>

      <div className="search-source-strip" aria-label="按来源统计的命中数量">
        {searchState.groups.map((group) => (
          <button
            type="button"
            className={`search-source-chip${group.count ? '' : ' is-empty'}`}
            disabled={group.count === 0}
            key={group.source}
            onClick={() => handleSelectGroup(group.targetTab)}
          >
            <Icon name={sourceIconNames[group.source]} size={14} aria-hidden="true" />
            <span>{group.label}</span>
            <b>{group.count}</b>
          </button>
        ))}
      </div>

      {searchState.total === 0 ? (
        <div className="search-results-empty">
          <div>没有找到与“{queryLabel}”匹配的记录。</div>
          <button type="button" className="btn btn-sm" onClick={handleClear}>
            清空搜索，恢复全部列表
          </button>
        </div>
      ) : (
        <div className="search-results-body">
          <div className="search-result-groups" role="listbox" aria-label="搜索结果列表">
            {searchState.groups.map((group) => (
              <SearchResultGroup
                group={group}
                key={group.source}
                onSelectGroup={handleSelectGroup}
                onSelectResult={handleSelectResult}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function SearchResultGroup({
  group,
  onSelectGroup,
  onSelectResult,
}: {
  group: WorkspaceSearchGroup;
  onSelectGroup: (targetTab: WorkspaceTab) => void;
  onSelectResult: (result: WorkspaceSearchResult) => void;
}) {
  const visibleResults = group.results.slice(0, GROUP_RESULT_LIMIT);
  const hiddenCount = Math.max(0, group.count - visibleResults.length);

  return (
    <section className={`search-result-group${group.count ? '' : ' is-empty'}`} role="group" aria-label={group.label}>
      <div className="search-result-group-head">
        <div className="search-result-group-title">
          <Icon name={sourceIconNames[group.source]} size={16} aria-hidden="true" />
          <span>{group.label}</span>
        </div>
        <span className="search-result-group-count">{group.count} 条</span>
      </div>

      {visibleResults.length ? (
        <div className="search-result-items">
          {visibleResults.map((result) => (
            <SearchResultItem key={result.id} result={result} onSelect={onSelectResult} />
          ))}
          {hiddenCount ? (
            <button type="button" className="search-result-more" onClick={() => onSelectGroup(group.targetTab)}>
              在{group.label}中查看其余 {hiddenCount} 条
            </button>
          ) : null}
        </div>
      ) : (
        <div className="search-result-group-empty">无匹配</div>
      )}
    </section>
  );
}

function SearchResultItem({
  onSelect,
  result,
}: {
  onSelect: (result: WorkspaceSearchResult) => void;
  result: WorkspaceSearchResult;
}) {
  const primaryMatch = result.matches[0];
  const snippet = primaryMatch?.snippet || result.summary;
  const updatedAt = formatChinaDateTime(result.updatedAt);

  return (
    <button type="button" className="search-result-item" role="option" aria-selected={false} onClick={() => onSelect(result)}>
      <span className="search-result-item-top">
        <span className="search-result-title">{result.title}</span>
        {result.status ? <span className="search-result-status">{result.status}</span> : null}
      </span>
      <span className="search-result-snippet">
        {primaryMatch ? `${primaryMatch.label}：` : ''}
        {snippet}
      </span>
      <span className="search-result-meta">
        <span>{formatSearchResultLocation(result)}</span>
        {updatedAt ? <span>{updatedAt}</span> : null}
      </span>
    </button>
  );
}

function formatSearchResultLocation(result: WorkspaceSearchResult) {
  const label = searchTargetLabels[result.location.targetType] ?? '记录';
  const targetText = result.location.taskKey
    ? `点击后定位到 ${result.location.taskKey} ${label}`
    : `点击后定位到${label} #${result.location.targetId}`;
  const planFilterText = getSearchResultPlanFilterText(result);
  return planFilterText ? `${targetText}，${planFilterText}` : targetText;
}

function getSearchResultPlanFilterText(result: WorkspaceSearchResult) {
  if (result.targetTab !== 'tasks') return '';
  if (result.source === 'plan') return '并筛选该 Plan 的任务';
  if (result.source === 'task' && (result.planId || result.filePath)) return '并切换到所属 Plan 任务';
  return '';
}
