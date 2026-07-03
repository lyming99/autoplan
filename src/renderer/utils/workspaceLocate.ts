/**
 * 工作区锚点定位通用逻辑。
 *
 * 从 `WorkspacePage.locateWorkspaceSearchResult` 抽出，供搜索定位与对话「打开需求/反馈」复用：
 * `getElementById` → `scrollIntoView({ block: 'center' })` → 加 `search-locate-highlight` → 限时移除。
 * 纯 DOM 工具，无 React 依赖，可在 vitest/jsdom 中测试。
 */

/** 高亮 class（与 WorkspacePage / 全局样式口径一致）。 */
const HIGHLIGHT_CLASS = 'search-locate-highlight';

const DEFAULT_HIGHLIGHT_MS = 2400;
const MIN_HIGHLIGHT_MS = 600;

export interface LocateWorkspaceAnchorOptions {
  /** 滚动行为，默认 'smooth'。 */
  scrollBehavior?: ScrollBehavior;
  /** 高亮持续时间（ms），低于 600 时按 600 处理；默认 2400。 */
  highlightMs?: number;
  /**
   * 自定义计时器，便于测试注入伪时钟。默认使用 `window.setTimeout`。
   * 返回值仅用于返回，不做 clear（高亮一次性移除）。
   */
  scheduleTimer?: (handler: () => void, ms: number) => void;
}

/**
 * 定位并高亮工作区内指定锚点元素。
 *
 * @param anchorId 目标元素 id（如 `workspace-requirement-35`）
 * @returns 命中并定位返回 `true`；元素不存在返回 `false`
 */
export function locateWorkspaceAnchor(
  anchorId: string,
  options: LocateWorkspaceAnchorOptions = {},
): boolean {
  const target = document.getElementById(anchorId);
  if (!(target instanceof HTMLElement)) return false;

  const opts = options || {};
  const previousTabIndex = target.getAttribute('tabindex');
  const highlightMs = Math.max(MIN_HIGHLIGHT_MS, Number(opts.highlightMs) || DEFAULT_HIGHLIGHT_MS);
  const scrollBehavior: ScrollBehavior = opts.scrollBehavior ?? 'smooth';
  const schedule = opts.scheduleTimer ?? ((handler, ms) => window.setTimeout(handler, ms));

  target.scrollIntoView({ behavior: scrollBehavior, block: 'center', inline: 'nearest' });
  target.classList.remove(HIGHLIGHT_CLASS);
  void target.offsetWidth; // 强制重排，确保高亮动画可重启
  target.classList.add(HIGHLIGHT_CLASS);
  target.setAttribute('tabindex', previousTabIndex ?? '-1');
  target.focus({ preventScroll: true });

  schedule(() => {
    target.classList.remove(HIGHLIGHT_CLASS);
    if (previousTabIndex === null) target.removeAttribute('tabindex');
  }, highlightMs);

  return true;
}
