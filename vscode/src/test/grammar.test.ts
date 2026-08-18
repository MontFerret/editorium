import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OnigScanner,
  OnigString,
  loadWASM,
} from 'vscode-oniguruma';
import {
  INITIAL,
  Registry,
  parseRawGrammar,
  type IGrammar,
  type IToken,
} from 'vscode-textmate';

const grammarScope = 'source.ferret';
const grammarPath = join(
  __dirname,
  '..',
  '..',
  'syntaxes',
  'ferret.tmLanguage.json',
);
const fixturePath = join(__dirname, '..', '..', 'test', 'fixtures');

interface FerretToken extends IToken {
  text: string;
}

let grammar: IGrammar;

function tokenWithText(tokens: FerretToken[], text: string): FerretToken {
  const token = tokens.find((candidate) => candidate.text === text);

  assert.ok(token, `Expected a token containing exactly ${JSON.stringify(text)}`);

  return token;
}

function tokensWithText(tokens: FerretToken[], text: string): FerretToken[] {
  const matching = tokens.filter((candidate) => candidate.text === text);

  assert.notStrictEqual(
    matching.length,
    0,
    `Expected at least one token containing exactly ${JSON.stringify(text)}`,
  );

  return matching;
}

function assertScope(
  tokens: FerretToken[],
  text: string,
  expectedScope: string,
): void {
  const matches = tokensWithText(tokens, text);

  assert.ok(
    matches.some((token) => token.scopes.includes(expectedScope)),
    `Expected ${JSON.stringify(text)} to include ${expectedScope}; got ${matches
      .map((token) => token.scopes.join(' '))
      .join(' | ')}`,
  );
}

function assertNoScope(
  tokens: FerretToken[],
  unexpectedScope: string,
): void {
  const scoped = tokens.filter((token) =>
    token.scopes.includes(unexpectedScope),
  );

  assert.deepStrictEqual(
    scoped,
    [],
    `Expected no token to include ${unexpectedScope}; got ${scoped
      .map((token) => `${JSON.stringify(token.text)}: ${token.scopes.join(' ')}`)
      .join(' | ')}`,
  );
}

function assertNotScope(
  tokens: FerretToken[],
  text: string,
  unexpectedScope: string,
): void {
  const matches = tokensWithText(tokens, text);

  assert.ok(
    matches.every((token) => !token.scopes.includes(unexpectedScope)),
    `Expected ${JSON.stringify(text)} not to include ${unexpectedScope}; got ${matches
      .map((token) => token.scopes.join(' '))
      .join(' | ')}`,
  );
}

function tokenize(source: string): FerretToken[] {
  const tokens: FerretToken[] = [];
  let ruleStack = INITIAL;

  for (const text of source.split('\n')) {
    const result = grammar.tokenizeLine(text, ruleStack);

    for (const token of result.tokens) {
      const tokenText = text.slice(token.startIndex, token.endIndex);

      if (tokenText.length > 0) {
        tokens.push({ ...token, text: tokenText });
      }
    }

    ruleStack = result.ruleStack;
  }

  return tokens;
}

suite('Ferret TextMate grammar', () => {
  suiteSetup(async () => {
    const wasmBuffer = readFileSync(
      require.resolve('vscode-oniguruma/release/onig.wasm'),
    );
    const wasm = wasmBuffer.buffer.slice(
      wasmBuffer.byteOffset,
      wasmBuffer.byteOffset + wasmBuffer.byteLength,
    );

    await loadWASM(wasm);

    const registry = new Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (patterns) => new OnigScanner(patterns),
        createOnigString: (text) => new OnigString(text),
      }),
      loadGrammar: async (scopeName) => {
        if (scopeName !== grammarScope) {
          return null;
        }

        const source = await readFile(grammarPath, 'utf8');

        return parseRawGrammar(source, grammarPath);
      },
    });
    const loaded = await registry.loadGrammar(grammarScope);

    assert.ok(loaded, `Expected to load ${grammarScope}`);
    grammar = loaded;
  });

  test('recognizes current keywords in every casing', () => {
    const tokens = tokenize(`let lower = true
LeT mixed = NoNe
FOR item IN items {
    ReTuRn item
}`);

    assertScope(tokens, 'let', 'storage.type.variable.ferret');
    assertScope(tokens, 'LeT', 'storage.type.variable.ferret');
    assertScope(tokens, 'FOR', 'keyword.control.loop.ferret');
    assertScope(tokens, 'item', 'variable.other.definition.ferret');
    assertScope(tokens, 'IN', 'keyword.operator.comparison.ferret');
    assertScope(tokens, 'ReTuRn', 'keyword.control.flow.ferret');
    assertScope(tokens, 'true', 'constant.language.boolean.ferret');
    assertScope(tokens, 'NoNe', 'constant.language.null.ferret');
  });

  test('scopes declarations, parameters, arbitrary calls, and namespaces', () => {
    const tokens = tokenize(`func decorate(value, prefix) => custom::nested::render(prefix, value)
let result = arbitrary_call(@input)`);

    assertScope(tokens, 'decorate', 'entity.name.function.ferret');
    assertScope(tokens, 'value', 'variable.parameter.ferret');
    assertScope(tokens, 'prefix', 'variable.parameter.ferret');
    assertScope(tokens, 'custom', 'entity.name.namespace.ferret');
    assertScope(tokens, 'nested', 'entity.name.namespace.ferret');
    assertScope(tokens, 'render', 'entity.name.function.ferret');
    assertScope(tokens, 'arbitrary_call', 'entity.name.function.ferret');
    assertScope(tokens, 'input', 'variable.parameter.ferret');
    assert.ok(
      tokens.every((token) =>
        token.scopes.every((scope) => !scope.startsWith('support.function')),
      ),
    );
  });

  test('scopes literals, comments, and symbolic operators', () => {
    const tokens = tokenize(`// RETURN 99 AND false
/* QUERY css\`ignored\` */
let values = [1, 2.5, 1e3, 250ms, true, FALSE, none, null, "a\\n", 'b''c', ´tick´, ...other]
values[0] += 1
return values[0] >= 1 AND values ANY IN other ?? []`);

    const lineComment = tokens.find((token) => token.text.includes('RETURN 99'));
    const blockComment = tokens.find((token) => token.text.includes('QUERY'));

    assert.ok(lineComment?.scopes.includes('comment.line.double-slash.ferret'));
    assert.ok(blockComment?.scopes.includes('comment.block.ferret'));
    assertScope(tokens, '1', 'constant.numeric.integer.ferret');
    assertScope(tokens, '2.5', 'constant.numeric.float.ferret');
    assertScope(tokens, '1e3', 'constant.numeric.float.ferret');
    assertScope(tokens, '250ms', 'constant.numeric.duration.ferret');
    assertScope(tokens, 'FALSE', 'constant.language.boolean.ferret');
    assertScope(tokens, 'null', 'constant.language.null.ferret');
    assertScope(tokens, '"', 'punctuation.definition.string.begin.ferret');
    assertScope(tokens, "'", 'punctuation.definition.string.begin.ferret');
    assertScope(tokens, '´', 'punctuation.definition.string.begin.ferret');
    assertScope(tokens, '\\n', 'constant.character.escape.ferret');
    assertScope(tokens, "''", 'constant.character.escape.ferret');
    assertScope(tokens, '...', 'keyword.operator.spread.ferret');
    assertScope(tokens, '+=', 'keyword.operator.assignment.augmented.ferret');
    assertScope(tokens, '>=', 'keyword.operator.comparison.ferret');
    assertScope(tokens, 'AND', 'keyword.operator.logical.ferret');
    assertScope(tokens, 'ANY', 'keyword.operator.quantifier.ferret');
    assertScope(tokens, '??', 'keyword.operator.coalesce.ferret');
  });

  test('scopes every symbolic operator family and punctuation', () => {
    const tokens = tokenize(`func apply(input) => input
let values = [{ key: 1 }, ...other]
values[0]?.key += 1
values[0] = values[0] * 2 / 1 % 2 + 3 - 4
values[0]++
values[0]--
let range = 1..3
let regex = "x" =~ "x" AND "x" !~ "y"
let compare = 1 == 1 OR 1 != 2 && 2 > 1 && 1 < 2 && 2 >= 1 && 1 <= 2
let inverse = !compare
let fallback = value ?? none
let choice = compare ? value : fallback
let first = values[~? custom \`.item\`]
let called = apply(values[0])
target <- "ready";`);

    for (const operator of ['=~', '!~', '==', '!=', '>', '<', '>=', '<=']) {
      assertScope(tokens, operator, 'keyword.operator.comparison.ferret');
    }
    for (const operator of ['AND', 'OR', '&&', '!']) {
      assertScope(tokens, operator, 'keyword.operator.logical.ferret');
    }
    for (const operator of ['*', '/', '%', '+', '-', '++', '--']) {
      assertScope(tokens, operator, 'keyword.operator.arithmetic.ferret');
    }

    assertScope(tokens, '=>', 'keyword.operator.arrow.ferret');
    assertScope(tokens, '=', 'keyword.operator.assignment.ferret');
    assertScope(tokens, '+=', 'keyword.operator.assignment.augmented.ferret');
    assertScope(tokens, '...', 'keyword.operator.spread.ferret');
    assertScope(tokens, '..', 'keyword.operator.range.ferret');
    assertScope(tokens, '??', 'keyword.operator.coalesce.ferret');
    assertScope(tokens, '?', 'keyword.operator.optional.ferret');
    assertScope(tokens, '~?', 'keyword.operator.query.ferret');
    assertScope(tokens, '<-', 'keyword.operator.dispatch.ferret');
    assertScope(tokens, '{', 'punctuation.section.braces.ferret');
    assertScope(tokens, '[', 'punctuation.section.brackets.ferret');
    assertScope(tokens, '(', 'punctuation.section.parens.ferret');
    assertScope(tokens, ',', 'punctuation.separator.comma.ferret');
    assertScope(tokens, ':', 'punctuation.separator.key-value.ferret');
    assertScope(tokens, '.', 'punctuation.accessor.ferret');
    assertScope(tokens, ';', 'punctuation.terminator.statement.ferret');
  });

  test('covers nested for and match bindings from the reusable fixture', async () => {
    const source = await readFile(join(fixturePath, 'control-flow.fql'), 'utf8');
    const tokens = tokenize(source);
    const loops = tokensWithText(tokens, 'for');

    assert.ok(loops.length >= 2);
    assert.ok(
      loops.every((token) => token.scopes.includes('keyword.control.loop.ferret')),
    );
    assertScope(tokens, 'match', 'keyword.control.conditional.ferret');
    assertScope(tokens, 'when', 'keyword.control.conditional.ferret');
    assertScope(tokens, 'user', 'variable.other.definition.ferret');
    assertScope(tokens, 'index', 'variable.other.definition.ferret');
    assertScope(tokens, 'tag', 'variable.other.definition.ferret');
  });

  test('covers control flow, queries, wait expressions, and recovery tails', () => {
    const tokens = tokenize(`return for item in items {
    filter item.active
    sort item.score desc
    limit 5
    let total = query count \`.ready\` in item using css
    let present = query exists \`.ready\` in item using css
    return match item.kind {
        "ready" => query one \`.ready\` in item using css,
        _ => waitfor value item[~ css\`.status\`]
            when .visible
            timeout 5s
            on timeout return none
    }
}`);

    for (const keyword of [
      'filter',
      'sort',
      'desc',
      'limit',
      'match',
      'query',
      'count',
      'exists',
      'one',
      'using',
      'waitfor',
      'value',
      'when',
      'timeout',
      'on',
    ]) {
      assert.ok(
        tokensWithText(tokens, keyword).some((token) =>
          token.scopes.some((scope) =>
            scope.startsWith('keyword.') || scope.startsWith('storage.'),
          ),
        ),
        `Expected ${keyword} to be a language keyword`,
      );
    }

    assertScope(tokens, '~', 'keyword.operator.query.ferret');
    assertScope(tokens, 'css', 'entity.name.tag.dialect.ferret');
    assertScope(tokens, '5s', 'constant.numeric.duration.ferret');
    assertScope(tokens, '_', 'variable.language.anonymous.ferret');
  });

  test('scopes dispatch, event waits, and contextual recovery words', () => {
    const tokens = tokenize(`dispatch "ready" in target with { detail: true } options { once: true }
target <- "done" on error retry 3 delay 250ms backoff exponential or fail
return waitfor event all {
    "ready" in target when .visible
} trigger dispatch "seen" in target timeout 5s`);

    for (const keyword of [
      'dispatch',
      'event',
      'all',
      'with',
      'options',
      'trigger',
      'timeout',
      'backoff',
    ]) {
      assert.ok(
        tokensWithText(tokens, keyword).some((token) =>
          token.scopes.some((scope) => scope.startsWith('keyword.')),
        ),
        `Expected ${keyword} to be a language keyword`,
      );
    }
    for (const keyword of ['on', 'error', 'retry', 'delay', 'fail']) {
      assertScope(tokens, keyword, 'keyword.control.exception.ferret');
    }

    assertScope(tokens, '<-', 'keyword.operator.dispatch.ferret');
    assertScope(tokens, '250ms', 'constant.numeric.duration.ferret');
  });

  test('keeps template interpolation in Ferret and dialect payloads extensible', () => {
    const tokens = tokenize(
      'let message = `hello ${user.name} ${{ nested: true }.nested}`\n' +
        'let first = page[~ custom_selector \'a.item\']\n' +
        'let second = page[~? arbitrary "a.item"]\n' +
        'let third = page[~ other ´a.item´]\n' +
        'return page[~ sql `a[href="${message}"]`]',
    );

    assertScope(tokens, '${', 'punctuation.section.interpolation.begin.ferret');
    assertScope(tokens, 'true', 'constant.language.boolean.ferret');
    assertScope(tokens, 'sql', 'entity.name.tag.dialect.ferret');
    assertScope(tokens, 'custom_selector', 'entity.name.tag.dialect.ferret');
    assertScope(tokens, 'arbitrary', 'entity.name.tag.dialect.ferret');
    assertScope(tokens, 'other', 'entity.name.tag.dialect.ferret');
    assertScope(tokens, '~?', 'keyword.operator.query.ferret');
    assertNotScope(tokens, '~?', 'meta.embedded.inline.ferret');
    assertNotScope(tokens, '[', 'meta.embedded.inline.ferret');
    assertNotScope(tokens, ']', 'meta.embedded.inline.ferret');
    assert.ok(
      tokensWithText(tokens, 'a[href="').some((token) =>
        token.scopes.includes('meta.embedded.inline.ferret'),
      ),
    );
    assert.ok(
      tokensWithText(tokens, 'message').some((token) =>
        token.scopes.includes('meta.interpolation.ferret'),
      ),
    );
    assert.ok(
      tokensWithText(tokens, 'a.item').every((token) =>
        token.scopes.includes('meta.embedded.inline.ferret'),
      ),
    );
  });

  test('does not classify ordinary identifier and string adjacency as query literals', () => {
    const tokens = tokenize(`foo "bar"
foo 'bar'
let foo = "bar"
return foo
"plain string"
some_identifier
foo"adjacent"
sql\`standalone\``);

    assertNoScope(tokens, 'meta.embedded.inline.ferret');
    assertScope(tokens, 'bar', 'string.quoted.double.ferret');
    assertScope(tokens, 'bar', 'string.quoted.single.ferret');
    assertScope(tokens, 'plain string', 'string.quoted.double.ferret');
    assertScope(tokens, 'adjacent', 'string.quoted.double.ferret');
    assertScope(
      tokens,
      'standalone',
      'string.quoted.other.template.ferret',
    );
    assertNotScope(tokens, 'foo', 'entity.name.tag.dialect.ferret');
    assertNotScope(tokens, 'sql', 'entity.name.tag.dialect.ferret');
  });

  test('keeps incomplete standalone templates out of embedded-query scopes', () => {
    const tokens = tokenize('sql`');

    assertNoScope(tokens, 'meta.embedded.inline.ferret');
    assertNotScope(tokens, 'sql', 'entity.name.tag.dialect.ferret');
    assertScope(tokens, '`', 'string.quoted.other.template.ferret');
  });

  test('ends a completed dialect payload before following Ferret code', () => {
    const tokens = tokenize(`let q = page[~ sql\`select * from users\`]
return q`);

    assertScope(
      tokens,
      'select * from users',
      'meta.embedded.inline.ferret',
    );
    assertScope(tokens, 'return', 'keyword.control.flow.ferret');
    assertNotScope(tokens, 'return', 'meta.embedded.inline.ferret');
  });

  test('tokenizes unfinished constructs without losing earlier scopes', () => {
    const tokens = tokenize(`let result = custom::call(
return query one \`select *
from users
/* unfinished`);

    assertScope(tokens, 'let', 'storage.type.variable.ferret');
    assertScope(tokens, 'custom', 'entity.name.namespace.ferret');
    assertScope(tokens, 'call', 'entity.name.function.ferret');
    assertScope(tokens, 'return', 'keyword.control.flow.ferret');
    assertScope(tokens, 'query', 'keyword.control.query.ferret');
    assertScope(tokens, 'one', 'keyword.control.query.ferret');

    const finalToken = tokenWithText(tokens, '/* unfinished');

    assert.ok(finalToken.scopes.includes('string.quoted.other.template.ferret'));

    const commentTokens = tokenize('return 1\n/* unfinished');
    const unfinishedComment = commentTokens.find((token) =>
      token.text.includes('unfinished'),
    );

    assert.ok(unfinishedComment?.scopes.includes('comment.block.ferret'));

    const stringTokens = tokenize('let value = "unfinished');

    assertScope(stringTokens, 'unfinished', 'string.quoted.double.ferret');
  });
});
