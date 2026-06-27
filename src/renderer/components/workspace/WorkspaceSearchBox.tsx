import { Icon } from '../icons';
import { normalizeSearchQuery } from '../../utils/workspaceSearch';

export function WorkspaceSearchBox({
  hitCount,
  onQueryChange,
  query,
}: {
  hitCount: number;
  onQueryChange: (query: string) => void;
  query: string;
}) {
  const hasQuery = Boolean(normalizeSearchQuery(query));
  const resultLabel = `命中 ${hitCount} 条`;

  return (
    <div className="workspace-search" role="search" aria-label="工作区搜索">
      <div className="workspace-search-field">
        <Icon name="search" size={16} className="workspace-search-icon" aria-hidden="true" />
        <input
          aria-label="搜索当前工作区"
          className="workspace-search-input search-input"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              onQueryChange('');
            }
          }}
          placeholder="搜索需求、反馈、任务、Plan 或事件"
          value={query}
        />
        {query ? (
          <button
            type="button"
            className="workspace-search-clear"
            onClick={() => onQueryChange('')}
            aria-label="清空工作区搜索关键字"
          >
            <Icon name="close" size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {hasQuery ? (
        <span className={`workspace-search-count${hitCount === 0 ? ' is-empty' : ''}`} aria-live="polite">
          {resultLabel}
        </span>
      ) : null}
    </div>
  );
}
