import * as assert from 'node:assert/strict';

import {
  Metadata,
  status,
  type ClientUnaryCall,
  type ServiceError,
} from '@grpc/grpc-js';

import { unary } from '../daemon/rpc';

suite('Ferret daemon unary transport', () => {
  test('does not leave abort handling attached after synchronous completion', async () => {
    const abort = new AbortController();
    let cancelCalls = 0;
    const result = await unary<{ value: number }>((callback) => {
      callback(null, { value: 42 });
      return {
        cancel: () => {
          cancelCalls += 1;
        },
      } as unknown as ClientUnaryCall;
    }, abort.signal);

    abort.abort(new Error('too late'));

    assert.deepStrictEqual(result, { value: 42 });
    assert.strictEqual(cancelCalls, 0);
  });

  test('cancels pending calls and reports the local abort reason', async () => {
    const abort = new AbortController();
    const reason = new Error('disposed');
    let callback:
      | ((
          error: ServiceError | null,
          response: { value: number },
        ) => void)
      | undefined;
    let cancelCalls = 0;
    const pending = unary<{ value: number }>((respond) => {
      callback = respond;
      return {
        cancel: () => {
          cancelCalls += 1;
        },
      } as unknown as ClientUnaryCall;
    }, abort.signal);

    abort.abort(reason);
    callback?.(serviceError(status.CANCELLED, 'cancelled'), { value: 0 });

    await assert.rejects(pending, (error: unknown) => error === reason);
    assert.strictEqual(cancelCalls, 1);
  });
});

function serviceError(code: status, details: string): ServiceError {
  return Object.assign(new Error(details), {
    code,
    details,
    metadata: new Metadata(),
  });
}
