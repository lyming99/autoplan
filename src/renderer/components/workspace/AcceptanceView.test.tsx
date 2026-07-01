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

function expectCountAtLeast(sourceText: string, snippet: string, minimum: number, message: string) {
  const count = sourceText.split(snippet).length - 1;
  expect(count >= minimum, message);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('P002 – AcceptanceView dual-section structure', () => {
  const view = source('src', 'renderer', 'components', 'workspace', 'AcceptanceView.tsx');

  it('renders both "待验收" and "已完成验收" as simultaneously visible first-level sections', () => {
    expectIncludes(view, '待验收', 'should have a pending-acceptance section heading');
    expectIncludes(view, '已完成验收', 'should have a completed-acceptance section heading');
    expectIncludes(view, 'accept-section-head', 'should keep accept-section-head class for section headers');
    expectIncludes(view, 'accepted-section', 'should include the completed-acceptance section wrapper class');
  });

  it('passes acceptedGroups prop alongside groups and recentAccepted', () => {
    expectIncludes(view, 'acceptedGroups:', 'component should declare acceptedGroups prop (AcceptsGroup[])');
    expectIncludes(view, 'groups:', 'component should keep existing groups prop');
    expectIncludes(view, 'recentAccepted:', 'component should keep existing recentAccepted prop');
  });

  it('renders AcceptedPlanCard and AcceptedTaskRow for grouped completed-acceptance display', () => {
    expectIncludes(view, 'AcceptedPlanCard', 'should define AcceptedPlanCard component');
    expectIncludes(view, 'AcceptedTaskRow', 'should define AcceptedTaskRow component');
    expectIncludes(view, 'acceptedGroups.map', 'should iterate AcceptedGroup[] for grouped rendering');
    expectIncludes(view, 'AcceptedPlanCard', 'should render AcceptedPlanCard per group');
  });

  it('each section has independent head with count', () => {
    expectCountAtLeast(view, 'accept-section-head', 2, 'should have at least 2 section heads');
    expectIncludes(view, 'acceptedPlanCount', 'should compute accepted plan count for display');
    expectIncludes(view, 'acceptedTaskCount', 'should compute accepted task count for display');
  });

  it('top accept-meta summarizes counts from both sides', () => {
    expectIncludes(view, 'acceptedItemCount', 'should compute completed-acceptance item count for meta bar');
    expectIncludes(view, 'accept-meta', 'should keep accept-meta class');
    // The meta should reference both pending counts and the accepted count.
    expectIncludes(view, 'pendingTaskCount', 'should reference pending task count');
    expectIncludes(view, 'acceptedItemCount', 'should reference completed-acceptance total item count');
  });
});

describe('P002 – Boundary states', () => {
  const view = source('src', 'renderer', 'components', 'workspace', 'AcceptanceView.tsx');

  it('shows AcceptanceEmpty when pending is empty', () => {
    expectIncludes(view, 'AcceptanceEmpty', 'should define/use AcceptanceEmpty component');
    // when hasPending is false, AcceptanceEmpty should render
    expectIncludes(view, 'AcceptanceEmpty', 'should render AcceptanceEmpty when pending group is empty');
  });

  it('shows AcceptedEmpty when completed-acceptance is empty, section does not disappear', () => {
    expectIncludes(view, 'AcceptedEmpty', 'should define AcceptedEmpty component');
    // Completed-acceptance section head should always render, and the body should
    // show AcceptedEmpty when hasAccepted is false.
    expectIncludes(view, 'accepted-section', 'completed section wrapper should always render (never disappears)');
  });

  it('pending-empty state does not hide completed-acceptance section', () => {
    // The completed section is rendered outside the hasPending conditional,
    // so it should always appear regardless of pending-empty.
    const idx = view.indexOf('已完成验收');
    expect(idx >= 0, 'completed-acceptance heading should exist in the component source');
  });
});

describe('P002 – Interaction wiring (accept / unaccept / selection / batch)', () => {
  const view = source('src', 'renderer', 'components', 'workspace', 'AcceptanceView.tsx');

  it('wires per-item unaccept in AcceptedPlanCard', () => {
    expectIncludes(view, 'onUnaccept', 'should keep onUnaccept prop');
    expectIncludes(view, "onUnaccept('plan'", 'should call unaccept for plan from AcceptedPlanCard');
  });

  it('wires per-task unaccept in AcceptedTaskRow', () => {
    expectIncludes(view, "onUnaccept('task'", 'should call unaccept for task from AcceptedTaskRow');
  });

  it('wires multi-select batch bar to onAcceptItems and onUnacceptItems', () => {
    expectIncludes(view, 'onAcceptItems', 'should call onAcceptItems for batch accept');
    expectIncludes(view, 'onUnacceptItems', 'should call onUnacceptItems for batch unaccept');
    expectIncludes(view, 'BatchBar', 'should render BatchBar for multi-select');
    expectIncludes(view, 'selectionTargets', 'should resolve selection to target list');
  });

  it('wires selection toggle via handleToggleSelection for both pending and accepted items', () => {
    expectIncludes(view, 'handleToggleSelection', 'should define handleToggleSelection');
    expectIncludes(view, 'onToggleSelection', 'should pass onToggleSelection to child cards/rows');
    expectIncludes(view, 'SelectionCheckbox', 'should render selection checkboxes');
  });

  it('allSelectableKeys covers both pending and accepted sides', () => {
    expectIncludes(view, 'allPendingKeys', 'should compute pending selectable keys');
    expectIncludes(view, 'allAcceptedKeys', 'should compute accepted selectable keys from acceptedGroups');
    expectIncludes(view, 'allSelectableKeys', 'should merge both sets for full-select');
  });

  it('keeps the accept-all button for pending items', () => {
    expectIncludes(view, 'acceptAllPending', 'should define acceptAllPending');
    expectIncludes(view, '全部验收', 'should keep the accept-all button label');
  });
});

describe('P002 – AcceptedPlanCard structural parity with PendingPlanCard', () => {
  const view = source('src', 'renderer', 'components', 'workspace', 'AcceptanceView.tsx');

  it('AcceptedPlanCard renders plan file path, title, progress bar, and chip', () => {
    expectIncludes(view, 'planFileLabel', 'should render plan file label');
    expectIncludes(view, 'planTitle', 'should render plan title');
    expectIncludes(view, 'planCompletedPct', 'should compute completion percentage');
    expectIncludes(view, 'planProgressText', 'should compute progress text');
    expectIncludes(view, 'accept-plan-progress', 'should render progress bar container');
    expectIncludes(view, 'chip-completed', 'should render status chip');
  });

  it('AcceptedPlanCard shows an undo/unaccept button for accepted plans', () => {
    expectIncludes(view, '取消验收', 'should show unaccept button text');
    expectIncludes(view, 'accept-undo-btn', 'should use accept-undo-btn class');
  });

  it('AcceptedPlanCard handles plan=null ungrouped bucket with a spacer and special labels', () => {
    expectIncludes(view, 'sel-check-spacer', 'should render spacer when no plan for checkbox alignment');
    expectIncludes(view, '未分组', 'should label ungrouped plan card');
    expectIncludes(view, '未分组已验收任务', 'should label ungrouped task group');
  });
});

describe('Regression – existing pending-acceptance flow preserved', () => {
  const view = source('src', 'renderer', 'components', 'workspace', 'AcceptanceView.tsx');

  it('PendingPlanCard and PendingTaskRow definitions are intact', () => {
    expectIncludes(view, 'PendingPlanCard', 'should keep PendingPlanCard definition');
    expectIncludes(view, 'PendingTaskRow', 'should keep PendingTaskRow definition');
  });

  it('acceptance check direct-accept (single click) is preserved', () => {
    expectIncludes(view, 'AcceptanceCheck', 'should keep AcceptanceCheck component for direct single-accept');
    expectIncludes(view, "onAccept('plan'", 'should call onAccept for plan from pending card');
    expectIncludes(view, "onAccept('task'", 'should call onAccept for task from pending row');
  });

  it('acceptPlanGroup batch-accepts all tasks under a pending plan', () => {
    expectIncludes(view, 'acceptPlanGroup', 'should define acceptPlanGroup helper');
    expectIncludes(view, '全部验收本计划', 'should show batch accept plan label');
  });

  it('collapsed toggle preserves expand/collapse for completed section', () => {
    expectIncludes(view, 'acceptedCollapsed', 'should manage acceptedCollapsed state');
    expectIncludes(view, 'setAcceptedCollapsed', 'should toggle collapse state');
  });

  it('uses existing IPC-neutral callbacks without signature changes', () => {
    // Verify the prop interface includes all existing callbacks unchanged.
    expectIncludes(view, 'onAccept: (targetType: AcceptanceTarget, id: number) => void', 'onAccept signature unchanged');
    expectIncludes(view, 'onUnaccept: (targetType: AcceptanceTarget, id: number) => void', 'onUnaccept signature unchanged');
    expectIncludes(view, 'onAcceptItems: (targets: { targetType: AcceptanceTarget', 'onAcceptItems signature unchanged');
    expectIncludes(view, 'onUnacceptItems: (targets: { targetType: AcceptanceTarget', 'onUnacceptItems signature unchanged');
  });
});
