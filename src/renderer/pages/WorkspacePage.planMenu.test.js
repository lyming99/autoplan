const { describe, it } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function source(...parts) {
  return readFileSync(join(process.cwd(), ...parts), 'utf8').replace(/\r\n/g, '\n');
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectIncludes(sourceText, snippet, message) {
  expect(sourceText.includes(snippet), message);
}

function expectNotIncludes(sourceText, snippet, message) {
  expect(!sourceText.includes(snippet), message);
}

function expectCountAtLeast(sourceText, snippet, minimum, message) {
  const count = sourceText.split(snippet).length - 1;
  expect(count >= minimum, `${message} (expected at least ${minimum}, got ${count})`);
}

function cssRuleBody(sourceText, selector) {
  const selectorStart = sourceText.indexOf(`${selector} {`);
  expect(selectorStart >= 0, `Should find CSS rule for ${selector}`);
  const blockStart = sourceText.indexOf('{', selectorStart);
  expect(blockStart >= 0, `Should find CSS block start for ${selector}`);

  let depth = 0;
  for (let index = blockStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return sourceText.slice(blockStart + 1, index);
    }
  }

  throw new Error(`Could not parse CSS rule body for ${selector}`);
}

describe('Plan card action menu regression', () => {
  it('keeps the more-actions trigger wired as an accessible menu button', () => {
    const planList = source('src', 'renderer', 'components', 'plans', 'PlanList.tsx');

    expectIncludes(planList, 'className="plan-action-menu-button"', 'Plan cards should render a dedicated more-actions button');
    expectIncludes(planList, 'aria-haspopup="menu"', 'More-actions button should expose menu semantics');
    expectIncludes(planList, 'aria-expanded={menuOpen}', 'More-actions button should expose the open state');
    expectIncludes(planList, 'aria-controls={menuOpen ? menuId : undefined}', 'More-actions button should reference the open menu');
    expectIncludes(planList, 'data-plan-action-menu="true"', 'Menu wrapper should remain marked as a card-interactive region');
    expectIncludes(planList, 'if (openMenuPlanId === plan.id)', 'Menu trigger should close the currently open menu');
    expectIncludes(planList, 'setOpenMenuPlanId(plan.id)', 'Menu trigger should open only its plan menu');
    expectIncludes(planList, "target.closest('[data-plan-action-menu=\"true\"]')", 'Outside pointer handling should ignore menu interactions');
    expectIncludes(planList, "event.key === 'Escape'", 'Escape should close the open menu');
    expectIncludes(planList, 'setOpenMenuPlanId(null);', 'Blur, outside click, and menu actions should close the menu');
  });

  it('keeps stop and delete actions exposed as role menuitems with disabled and danger states', () => {
    const planList = source('src', 'renderer', 'components', 'plans', 'PlanList.tsx');

    expectIncludes(planList, 'className="plan-action-menu ctx-menu"', 'Plan card popup should render as a menu');
    expectCountAtLeast(planList, 'role="menuitem"', 2, 'Plan card popup should expose stop and delete menu items');
    expectIncludes(planList, '<span>停止</span>', 'Plan card menu should include the stop item');
    expectIncludes(planList, '<span>删除</span>', 'Plan card menu should include the delete item');
    expectIncludes(planList, "canStopPlan(plan, runningInPlan)", 'Stop item should only enable for running plans');
    expectIncludes(planList, "title={stopDisabledReason || '停止该计划'}", 'Disabled stop item should explain why it is unavailable');
    expectIncludes(planList, 'disabled={Boolean(stopDisabledReason)}', 'Stop item should be disabled when stop is unavailable');
    expectIncludes(planList, 'className="plan-action-menu-item danger"', 'Delete menu item should retain danger styling');
    expectIncludes(planList, '<Icon name="stop" size={15} aria-hidden />', 'Stop item should keep its icon');
    expectIncludes(planList, '<Icon name="trash" size={15} aria-hidden />', 'Delete item should keep its icon');
  });

  it('portals the menu outside the scrolling card list and keeps it inside the viewport', () => {
    const styles = source('src', 'renderer', 'styles', 'components.css');
	const planList = source('src', 'renderer', 'components', 'plans', 'PlanList.tsx');
    const actionsRule = cssRuleBody(styles, '.plan-actions');
    const mainRule = cssRuleBody(styles, '.plan-action-main');
    const wrapRule = cssRuleBody(styles, '.plan-action-menu-wrap');
    const menuRule = cssRuleBody(styles, '.plan-action-menu');

    expectIncludes(actionsRule, 'display: flex', 'Plan actions should keep a horizontal layout row');
    expectIncludes(actionsRule, 'align-items: flex-end', 'Plan actions should align the menu trigger to the bottom edge');
    expectIncludes(actionsRule, 'justify-content: space-between', 'Plan actions should reserve the right edge for the menu trigger');
    expectIncludes(actionsRule, 'min-width: 0', 'Plan actions should allow compact card layouts without overflow');
    expectNotIncludes(actionsRule, 'flex-wrap: wrap', 'Plan actions row should not wrap the menu trigger back into the left-side flow');

    expectIncludes(mainRule, 'flex: 1 1 auto', 'Plan action content should take available space before the menu anchor');
    expectIncludes(mainRule, 'flex-wrap: wrap', 'Plan action content should wrap before it can push the menu trigger inward');
    expectIncludes(mainRule, 'min-width: 0', 'Plan action content should shrink without forcing menu overflow');

    expectIncludes(wrapRule, 'position: relative', 'Menu wrapper should anchor the popup without leaving layout flow');
    expectIncludes(wrapRule, 'display: inline-flex', 'Menu wrapper should participate as a flex item');
    expectIncludes(wrapRule, 'flex: 0 0 auto', 'Menu wrapper should keep stable button sizing in the action row');
    expectIncludes(wrapRule, 'margin-left: auto', 'Menu wrapper should stay pinned to the right side of the action row');
    expectIncludes(wrapRule, 'align-self: flex-end', 'Menu wrapper should stay aligned to the bottom-right corner');
    expectIncludes(wrapRule, 'justify-content: flex-end', 'Menu wrapper should right-align the trigger inside its anchor');
    expectNotIncludes(wrapRule, 'position: absolute', 'Menu wrapper should not be absolutely positioned');
    expectNotIncludes(wrapRule, 'right:', 'Menu wrapper should not depend on card-corner right offsets');
    expectNotIncludes(wrapRule, 'bottom:', 'Menu wrapper should not depend on card-corner bottom offsets');

    expectIncludes(menuRule, 'position: fixed', 'Popup should use viewport positioning outside overflow containers');
    expectIncludes(menuRule, 'z-index: 1000', 'Popup should render above cards and panels');
    expectIncludes(menuRule, 'min-width: 156px', 'Popup should keep its menu width floor');
    expectIncludes(menuRule, 'max-width: min(220px, calc(100vw - 32px))', 'Popup should keep viewport-aware width bounds');
    expectIncludes(planList, 'createPortal(', 'Popup should escape the scrolling plan list through a portal');
    expectIncludes(planList, 'document.body', 'Popup portal should target the document body');
    expectIncludes(planList, "document.addEventListener('scroll', updatePosition, true)", 'Popup should track nested scrolling containers');
    expectIncludes(planList, "window.addEventListener('resize', updatePosition)", 'Popup should track viewport resize');
    expectIncludes(planList, 'const openAbove =', 'Popup should open above when the lower viewport has insufficient room');
    expectIncludes(styles, '.plan-action-menu { max-width: calc(100vw - 48px); }', 'Narrow screens should keep the menu within the viewport');
  });
});
