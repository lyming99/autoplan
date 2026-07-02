export {};

type TestRegistrar = (name: string, fn: () => void) => void;

declare function require(id: string): unknown;
declare const process: { cwd(): string };

const { describe, it } = require('node:test') as { describe: TestRegistrar; it: TestRegistrar };
const { readFileSync } = require('node:fs') as { readFileSync: (path: string, encoding: string) => string };
const { join } = require('node:path') as { join: (...parts: string[]) => string };

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function source(...parts: string[]) {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function expectIncludes(sourceText: string, snippet: string, message: string) {
  expect(sourceText.includes(snippet), message);
}

// 反馈 #26 回归测试：搜索结果弹层通过 react-dom 的 createPortal 渲染到 document.body，
// 并以 position: fixed 定位脱离 .workspace-main 的裁剪与左侧导航的层叠区域。
describe('Feedback #26 search results popup portalization', () => {
  it('renders the popup to document.body via a react-dom Portal', () => {
    const component = source('src', 'renderer', 'components', 'SearchResults.tsx');

    // 场景一：弹层节点挂载在 document.body，而非 .workspace-search-popover-anchor 子树，从而脱离主区裁剪上下文。
    expectIncludes(component, "import { createPortal } from 'react-dom';", '应从 react-dom 导入 createPortal');
    expectIncludes(component, 'const mountNode = typeof document !== \'undefined\' ? document.body : null;', '应将 document.body 作为 Portal 挂载点');
    expectIncludes(component, 'return mountNode ? createPortal(popup, mountNode) : popup;', '应通过 createPortal 把弹层渲染到 document.body');
  });

  it('positions the popup with fixed coordinates derived from the anchor rect', () => {
    const component = source('src', 'renderer', 'components', 'SearchResults.tsx');

    // 场景：弹层 position: fixed，top / 右对齐基准 / width 由传入的锚点坐标计算，紧贴搜索框正下方、与搜索框右对齐。
    expectIncludes(component, 'export interface SearchResultsAnchorRect {', '应导出锚点坐标类型');
    expectIncludes(component, 'anchorRect?: SearchResultsAnchorRect | null;', '应接受可选的锚点坐标 prop');
    expectIncludes(component, 'function buildSearchPopupStyle(anchorRect: SearchResultsAnchorRect | null | undefined): CSSProperties | undefined {', '应基于锚点坐标构造内联定位样式');
    expectIncludes(component, "position: 'fixed',", '定位样式应使用 position: fixed');
    expectIncludes(component, 'const top = anchorRect.bottom + SEARCH_POPUP_GAP;', 'top 应由锚点 bottom 加间距计算');
    expectIncludes(component, 'const width = Math.min(SEARCH_POPUP_MAX_WIDTH, Math.max(0, anchorRect.right - SEARCH_POPUP_SIDE_MARGIN));', 'width 应以 760px 封顶且左缘至少留 SIDE_MARGIN');
    expectIncludes(component, 'right: `${Math.max(0, viewportWidth - anchorRect.right)}px`,', 'right 应对齐搜索框右边缘');
    expectIncludes(component, 'style={popupStyle}', '弹层应应用计算出的内联定位样式');
  });

  it('keeps a left-aligned full-width layout on narrow screens without horizontal overflow', () => {
    const component = source('src', 'renderer', 'components', 'SearchResults.tsx');

    // 场景：窄屏（≤760px）改为左对齐、宽度受限于视口，fixed 定位下不产生水平溢出。
    expectIncludes(component, 'const SEARCH_POPUP_NARROW_BREAKPOINT = 760;', '应定义与样式一致的窄屏断点');
    expectIncludes(component, 'if (viewportWidth <= SEARCH_POPUP_NARROW_BREAKPOINT) {', '窄屏应进入左对齐分支');
    expectIncludes(component, 'left: `${SEARCH_POPUP_SIDE_MARGIN}px`,', '窄屏应左对齐并留侧边距');
    expectIncludes(component, "right: 'auto',", '窄屏应取消右对齐');
  });

  it('mounts nothing when closed or when the query is empty and keeps a11y/escape behavior', () => {
    const component = source('src', 'renderer', 'components', 'SearchResults.tsx');

    // 场景二：open=false 或查询为空时返回 null，document.body 下不残留弹层节点。
    expectIncludes(component, 'if (searchState.query.isEmpty || !open) return null;', '关闭或查询为空时应返回 null，不挂载节点');

    // 场景：保留 role / aria-live / aria-label 与内部 Esc 关闭等无障碍与交互行为。
    expectIncludes(component, 'role="dialog"', '应保留 dialog 角色');
    expectIncludes(component, 'aria-label="统一搜索结果"', '应保留可访问名称');
    expectIncludes(component, 'aria-live="polite"', '应保留 aria-live');
    expectIncludes(component, "if (event.key !== 'Escape') return;", '应保留内部 Esc 关闭逻辑');
  });
});
