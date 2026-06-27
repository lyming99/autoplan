import type { AppEvent } from '../../types';
import { formatEvent } from '../../utils/planEvents';

export function EventList({ emptyText = '暂无事件。', events }: { emptyText?: string; events: AppEvent[] }) {
  if (!events.length) return <div className="empty">{emptyText}</div>;

  return (
    <div className="list compact event-list">
      {events.map((event) => {
        const display = formatEvent(event);
        return (
          <article className={`item event-item ${display.tone ? `event-item-${display.tone}` : ''}`} key={event.id}>
            <div className="item-title event-title">
              <span>{display.title}</span>
              {display.badge ? <span className={`event-badge event-badge-${display.tone}`}>{display.badge}</span> : null}
            </div>
            {display.body ? <div className="item-body plain-text">{display.body}</div> : null}
            <div className="meta event-meta">{display.meta}</div>
          </article>
        );
      })}
    </div>
  );
}
