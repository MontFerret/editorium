import * as assert from 'node:assert/strict';

import {
  ExecutionResultRenderError,
  formatDuration,
  formatTimestamp,
  renderExecutionOutput,
} from '../execution/format';

suite('Ferret execution output formatting', () => {
  test('renders JSON scalars without protocol metadata', () => {
    assert.strictEqual(render('42'), '42');
    assert.strictEqual(render('null'), 'null');
    assert.strictEqual(render('true'), 'true');
    assert.strictEqual(render('"Ferret"'), '"Ferret"');
  });

  test('pretty-prints nested objects and arrays with stable indentation', () => {
    assert.strictEqual(
      render('{"users":[{"name":"alice","active":true},null],"count":1}'),
      [
        '{',
        '  "users": [',
        '    {',
        '      "name": "alice",',
        '      "active": true',
        '    },',
        '    null',
        '  ],',
        '  "count": 1',
        '}',
      ].join('\n'),
    );
    assert.strictEqual(render('{"empty":{},"items":[]}'), [
      '{',
      '  "empty": {},',
      '  "items": []',
      '}',
    ].join('\n'));
  });

  test('preserves daemon number lexemes outside JavaScript safe ranges', () => {
    assert.strictEqual(
      render('{"large":9007199254740993,"exponent":1e400}'),
      [
        '{',
        '  "large": 9007199254740993,',
        '  "exponent": 1e400',
        '}',
      ].join('\n'),
    );
  });

  test('accepts JSON content type parameters', () => {
    assert.strictEqual(
      render(' { "ok" : true } ', 'Application/JSON; charset=utf-8'),
      ['{', '  "ok": true', '}'].join('\n'),
    );
  });

  test('rejects malformed UTF-8, malformed JSON, and other content types', () => {
    assert.throws(
      () =>
        renderExecutionOutput({
          contentType: 'application/json',
          data: new Uint8Array([0xff]),
        }),
      ExecutionResultRenderError,
    );
    assert.throws(() => render('{"missing":'), ExecutionResultRenderError);
    assert.throws(
      () => render('value', 'text/plain'),
      ExecutionResultRenderError,
    );
  });

  test('formats short, second, and minute durations naturally', () => {
    assert.strictEqual(formatDuration(31), '31 ms');
    assert.strictEqual(formatDuration(284), '284 ms');
    assert.strictEqual(formatDuration(1_400), '1.4 s');
    assert.strictEqual(formatDuration(12_800), '12.8 s');
    assert.strictEqual(formatDuration(59_950), '1m 00s');
    assert.strictEqual(formatDuration(63_000), '1m 03s');
    assert.strictEqual(formatDuration(-10), '0 ms');
  });

  test('formats a fixed-width local timestamp', () => {
    assert.strictEqual(
      formatTimestamp(new Date(2026, 7, 18, 6, 4, 9)),
      '06:04:09',
    );
  });
});

function render(
  value: string,
  contentType = 'application/json',
): string {
  return renderExecutionOutput({
    contentType,
    data: new TextEncoder().encode(value),
  });
}
