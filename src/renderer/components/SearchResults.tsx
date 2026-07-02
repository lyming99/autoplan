import type { CSSProperties, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
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

/** 弹层紧贴搜索框下方的间距（沿用原 `calc(100% + 10px)`）。 */
const SEARCH_POPUP_GAP = 10;
/** 弹层最大宽度（沿用原 `width: min(760px, ...)`）。 */
const SEARCH_POPUP_MAX_WIDTH = 760;
/** 视口两侧留白，用于约束 fixed 弹层不水平溢出（沿用原 `calc(100vw - 48px)` 的 24px×2）。 */
const SEARCH_POPUP_SIDE_MARGIN = 24;
/** 窄屏断点，与 `styles.css` 中 `@media (max-width: 760px)` 对齐。 */
const SEARCH_POPUP_NARROW_BREAKPOINT = 760;

/**
 * 搜索弹层锚点（`.workspace-search-popover-anchor`）的视口坐标。
 * 由 WorkspacePage 读取其 `getBoundingClientRect()` 后随 props 传入，
 * 用于在 Portal(`position: fixed`) 定位下让弹层紧贴搜索框正下方、与搜索框右对齐。
 */
export interface SearchResultsAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface SearchResultsProps {
  /** 锚点坐标；缺省时回退到 CSS 兜底定位（P002 起由 WorkspacePage 传入）。 */
  anchorRect?: SearchResultsAnchorRect | null;
  onClear: () => void;
  onClose: () => void;
  onSelectGroup: (targetTab: WorkspaceTab) => void;
  onSelectResult: (result: WorkspaceSearchResult) => void;
  open: boolean;
  searchState: WorkspaceSearchState;
}

/**
 * 依据锚点视口坐标构造 fixed 弹层的内联定位样式。
 *
 * - 宽屏：`right` 对齐搜索框右边缘、`width` 封顶 760px 且左边缘至少留 `SEARCH_POPUP_SIDE_MARGIN`，与改造前视觉一致；
 * - 窄屏（≤760px）：改为左对齐、宽度受限于视口，避免 fixed 定位下水平溢出。
 * - 无锚点坐标时返回 `undefined`，回退到 `styles.css` 的兜底定位。
 */
function buildSearchPopupStyle(anchorRect: SearchResultsAnchorRect | null | undefined): CSSProperties | undefined {
  if (!anchorRect || typeof window === 'undefined') return undefined;
  const viewportWidth = window.innerWidth;
  const top = anchorRect.bottom + SEARCH_POPUP_GAP;

  if (viewportWidth <= SEARCH_POPUP_NARROW_BREAKPOINT) {
    return {
      position: 'fixed',
      top: `${top}px`,
      left: `${SEARCH_POPUP_SIDE_MARGIN}px`,
      right: 'auto',
      width: `${Math.max(0, viewportWidth - SEARCH_POPUP_SIDE_MARGIN * 2)}px`,
    };
  }

  const width = Math.min(SEARCH_POPUP_MAX_WIDTH, Math.max(0, anchorRect.right - SEARCH_POPUP_SIDE_MARGIN));
  return {
    position: 'fixed',
    top: `${top}px`,
    right: `${Math.max(0, viewportWidth - anchorRect.right)}px`,
    width: `${width}px`,
  };
}

export function SearchResults({
  anchorRect,
  onClear,
  onClose,
  onSelectGroup,
  onSelectResult,
  open,
  searchState,
}: SearchResultsProps) {
  if (searchState.query.isEmpty || !open) return null;

  const queryLabel = searchState.query.raw.trim().replace(/\s+/g, ' ') || searchState.query.normalized;
  // Portal 到 document.body 后用 fixed 定位脱离 .workspace-main 的裁剪/层叠上下文；
  // 坐标由锚点 getBoundingClientRect 推导，无锚点时回退到 CSS 兜底定位。
  const popupStyle = buildSearchPopupStyle(anchorRect);
  const mountNode = typeof document !== 'undefined' ? document.body : null;

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

  const popup = (
    <section
      className="search-results search-results-popup card"
      style={popupStyle}
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

  // 渲染到 document.body，彻底脱离 .workspace-main { overflow: hidden } 的裁剪与左侧导航的网格/层叠区域。
  return mountNode ? createPortal(popup, mountNode) : popup;
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
