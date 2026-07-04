const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

const typesPath = join(process.cwd(), 'src', 'renderer', 'types.ts');

function formatParseDiagnostic(diagnostic, sourceFile) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (typeof diagnostic.start === 'number') {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
    return `${sourceFile.fileName}:${line + 1}:${character + 1} TS${diagnostic.code}: ${message}`;
  }
  return `${sourceFile.fileName} TS${diagnostic.code}: ${message}`;
}

describe('renderer types syntax', () => {
  it('parses types.ts without syntax diagnostics', () => {
    const sourceText = readFileSync(typesPath, 'utf8');
    const sourceFile = ts.createSourceFile(typesPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const diagnostics = sourceFile.parseDiagnostics || [];

    assert.equal(
      diagnostics.length,
      0,
      diagnostics.map((diagnostic) => formatParseDiagnostic(diagnostic, sourceFile)).join('\n'),
    );
  });
});
