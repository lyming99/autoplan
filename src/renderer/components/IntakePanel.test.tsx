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

function sliceBetween(sourceText: string, startNeedle: string, endNeedle: string, message: string) {
  const start = sourceText.indexOf(startNeedle);
  expect(start >= 0, message);
  const end = sourceText.indexOf(endNeedle, start);
  expect(end >= 0, message);
  return sourceText.slice(start, end + endNeedle.length);
}

type FailureFixture = {
  generate_fail_count?: number;
  last_generate_error?: string;
  linkedPlans?: Array<{ plan_id: number }>;
};

function fixtureIsGenerationFailure(item: FailureFixture) {
  const hasFailure = Boolean(item.last_generate_error?.trim()) || Number(item.generate_fail_count || 0) > 0;
  return (item.linkedPlans || []).length === 0 && hasFailure;
}

describe('P009 IntakePanel performance path', () => {
  const panel = source('src', 'renderer', 'components', 'IntakePanel.tsx');

  it('keeps first-screen intake rendering bounded with load-more and locate expansion', () => {
    expectIncludes(panel, 'const INTAKE_INITIAL_VISIBLE_COUNT = 80;', 'initial visible intake count should stay bounded');
    expectIncludes(panel, 'const INTAKE_LOAD_MORE_COUNT = 80;', 'load-more should advance in bounded batches');
    expectIncludes(panel, 'const [visibleLimit, setVisibleLimit] = useState(INTAKE_INITIAL_VISIBLE_COUNT);', 'visible limit should initialize from the bounded constant');
    expectIncludes(panel, '}, [type, listFilter]);', 'switching intake type or filter should reset the bounded window');
    expectIncludes(panel, 'setVisibleLimit((current) => Math.max(current, targetIndex + 1));', 'locating a target should expand only enough to include it');
    expectIncludes(panel, 'const visibleCount = Math.min(visibleLimit, filteredItems.length);', 'visible count should cap at filtered item length');
    expectIncludes(panel, '() => filteredItems.slice(0, visibleCount),', 'rendered items should be sliced from the filtered collection before mapping');
    expectIncludes(panel, '{visibleItems.map((item) => {', 'the list should render only the visible slice');
    expectIncludes(panel, 'setVisibleLimit((current) => Math.min(filteredItems.length, current + INTAKE_LOAD_MORE_COUNT))', 'load more should extend by one bounded batch within the filtered collection');
  });

  it('builds an owner-keyed attachment lookup once per attachment input', () => {
    const lookupBody = sliceBetween(
      panel,
      'const attachmentsByOwner = useMemo(() => {',
      '  }, [attachments]);',
      'should locate the attachment lookup memo',
    );

    expectIncludes(lookupBody, 'const grouped = new Map<string, Attachment[]>();', 'attachments should be grouped in a Map');
    expectIncludes(lookupBody, 'for (const attachment of attachments) {', 'lookup should scan attachments once per prop change');
    expectIncludes(lookupBody, 'const key = intakeAttachmentKey(attachment.owner_type, attachment.owner_id);', 'lookup key should include owner type and owner id');
    expectIncludes(lookupBody, 'group.push(attachment);', 'same-owner multiple attachments should append to the same group');
    expectIncludes(lookupBody, 'grouped.set(key, [attachment]);', 'first attachment for an owner should create a new group');
    expect(!lookupBody.includes('items'), 'attachment grouping should not depend on item count');
  });

  it('uses the owner lookup while rendering visible items and falls back to an empty attachment array', () => {
    const renderBody = sliceBetween(
      panel,
      '{visibleItems.map((item) => {',
      '{hasMoreItems ? (',
      'should locate the visible item render loop',
    );

    expectIncludes(renderBody, 'const itemAttachments = attachmentsByOwner.get(intakeAttachmentKey(type, item.id)) || EMPTY_ATTACHMENTS;', 'each item should do an O(1) owner lookup with an empty fallback');
    expectIncludes(panel, 'const EMPTY_ATTACHMENTS: Attachment[] = [];', 'no-attachment items should reuse a stable empty array');
    expect(!renderBody.includes('attachments.filter'), 'visible item rendering should not filter the full attachments array per item');
    expect(!renderBody.includes('attachments.map'), 'visible item rendering should not map the full attachments array per item');
  });
});

describe('P003 IntakePanel generation-failure filtering regressions', () => {
  const panel = source('src', 'renderer', 'components', 'IntakePanel.tsx');

  it('classifies no failure, one failure, count-only failure, and a historical failure already bound to Plan', () => {
    const cases: Array<[string, FailureFixture, boolean]> = [
      ['ordinary intake', {}, false],
      ['single failure', { last_generate_error: 'CLI exited with code 1' }, true],
      ['count-only failure', { generate_fail_count: 1 }, true],
      ['historical failure with Plan', {
        generate_fail_count: 2,
        last_generate_error: 'older failure',
        linkedPlans: [{ plan_id: 42 }],
      }, false],
    ];

    for (const [name, fixture, expected] of cases) {
      expect(fixtureIsGenerationFailure(fixture) === expected, `${name} should have the expected failure-filter result`);
    }

    const failureReader = sliceBetween(
      panel,
      'function intakeGenerationFailure(item: IntakeItem): IntakeGenerateFailure | null {',
      'function isIntakeGenerationFailure(item: IntakeItem) {',
      'should locate the failure metadata reader',
    );
    expectIncludes(failureReader, "readStringField(item, ['last_generate_error'])", 'an error message should mark an intake as failed');
    expectIncludes(failureReader, "readNumberField(item, ['generate_fail_count'])", 'a positive failure count should mark an intake as failed');
    expectIncludes(failureReader, 'if (!reason && failCount <= 0) return null;', 'records without failure metadata should not match');

    const classifier = sliceBetween(
      panel,
      'function isIntakeGenerationFailure(item: IntakeItem) {',
      '}',
      'should locate the reusable failure classifier',
    );
    expectIncludes(classifier, 'linkedPlansOf(item).length === 0', 'records already bound to Plan should be excluded even after a historical failure');
    expectIncludes(classifier, 'intakeGenerationFailure(item) !== null', 'unbound records should require actual failure metadata');
  });

  it('keeps all/failed controls, counts, selected state, and the dedicated empty state together', () => {
    expectIncludes(panel, "const [listFilter, setListFilter] = useState<IntakeListFilter>('all');", 'the panel should start in all mode');
    expectIncludes(panel, "() => listFilter === 'generation-failed' ? items.filter(isIntakeGenerationFailure) : items,", 'failed mode should derive its own item collection');
    expectIncludes(panel, '() => items.filter(isIntakeGenerationFailure).length,', 'the failed tab count should use the same classifier');
    expectIncludes(panel, 'aria-selected={listFilter === \'all\'}', 'the all tab should expose selected state');
    expectIncludes(panel, "onClick={() => setListFilter('all')}", 'users should be able to return from failed mode to all records');
    expectIncludes(panel, '<span className="count">{items.length}</span>', 'the all tab should show the unfiltered count');
    expectIncludes(panel, 'aria-selected={listFilter === \'generation-failed\'}', 'the failed tab should expose selected state');
    expectIncludes(panel, "onClick={() => setListFilter('generation-failed')}", 'users should be able to select failed mode');
    expectIncludes(panel, '<span className="count">{generationFailedCount}</span>', 'the failed tab should show its derived count');
    expectIncludes(panel, "{listFilter === 'generation-failed' ? '暂无计划生成失败记录' : emptyText}", 'zero failed results should use the dedicated empty copy');
  });

  it('filters before pagination and bases locate, totals, and load-more bounds on filtered results', () => {
    const filterIndex = panel.indexOf('const filteredItems = useMemo(');
    const visibleCountIndex = panel.indexOf('const visibleCount = Math.min(visibleLimit, filteredItems.length);');
    const sliceIndex = panel.indexOf('() => filteredItems.slice(0, visibleCount),');
    expect(filterIndex >= 0 && visibleCountIndex > filterIndex && sliceIndex > visibleCountIndex, 'failure filtering should happen before the visibleItems slice');

    expectIncludes(panel, 'const targetIndex = filteredItems.findIndex((item) => Number(item.id) === Number(locateItemId));', 'explicit item location should use the current filtered positions');
    expectIncludes(panel, 'const hasMoreItems = visibleCount < filteredItems.length;', 'has-more should use the filtered total');
    expectIncludes(panel, '<span>已显示 {visibleCount} / {filteredItems.length}</span>', 'pagination copy should report the filtered total');
    expectIncludes(panel, 'Math.min(filteredItems.length, current + INTAKE_LOAD_MORE_COUNT)', 'load more should stop at the filtered total');
    expectIncludes(panel, '}, [type, listFilter]);', 'changing filter should reset pagination to the first window');
  });
});
