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

describe('P009 IntakePanel performance path', () => {
  const panel = source('src', 'renderer', 'components', 'IntakePanel.tsx');

  it('keeps first-screen intake rendering bounded with load-more and locate expansion', () => {
    expectIncludes(panel, 'const INTAKE_INITIAL_VISIBLE_COUNT = 80;', 'initial visible intake count should stay bounded');
    expectIncludes(panel, 'const INTAKE_LOAD_MORE_COUNT = 80;', 'load-more should advance in bounded batches');
    expectIncludes(panel, 'const [visibleLimit, setVisibleLimit] = useState(INTAKE_INITIAL_VISIBLE_COUNT);', 'visible limit should initialize from the bounded constant');
    expectIncludes(panel, 'setVisibleLimit(INTAKE_INITIAL_VISIBLE_COUNT);', 'switching intake type should reset the bounded window');
    expectIncludes(panel, 'setVisibleLimit((current) => Math.max(current, targetIndex + 1));', 'locating a target should expand only enough to include it');
    expectIncludes(panel, 'const visibleCount = Math.min(visibleLimit, items.length);', 'visible count should cap at item length');
    expectIncludes(panel, 'const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);', 'rendered items should be sliced before mapping');
    expectIncludes(panel, '{visibleItems.map((item) => {', 'the list should render only the visible slice');
    expectIncludes(panel, 'setVisibleLimit((current) => Math.min(items.length, current + INTAKE_LOAD_MORE_COUNT))', 'load more should extend by one bounded batch');
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
