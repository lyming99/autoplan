'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { it } = require('node:test');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

it('routes a plan path click through plan.file_path in folder mode', () => {
  const workspacePage = source('WorkspacePage.tsx');
  const planList = source('../components/plans/PlanList.tsx');

  assert.match(
    workspacePage,
    /onOpenPlanFile=\{\(plan\) => openScopeFile\(plan\.file_path, 'folder'\)\}/,
    'the plan card callback must reveal plan.file_path instead of opening a database-backed reader',
  );
  assert.match(
    planList,
    /onClick=\{\(event\) => \{[\s\S]*?event\.stopPropagation\(\);[\s\S]*?onOpenPlanFile\?\.\(plan\);[\s\S]*?\}\}/,
    'the path control must stop card navigation and invoke the plan file callback',
  );
});
