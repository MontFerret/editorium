import type { ClientReadableStream } from '@grpc/grpc-js';
import { DaemonDisposedError } from '../daemon/errors';
import type { WatchExecutionResponse } from '../daemon/gen/ferretd/execution/v1/execution.pb';
import { FerretExecutionClientError, normalizeExecutionError } from './errors';
import { mapExecutionEvent, ProtocolMappingError } from './mapping';
import type { FerretExecutionEvent } from './types';

export class ExecutionWatch implements AsyncIterable<FerretExecutionEvent> {
  private readonly queue: WatchExecutionResponse[] = [];
  private consumed = false;
  private done = false;
  private failure: unknown;
  private terminalSeen = false;
  private wake: (() => void) | undefined;

  public constructor(
    private readonly stream: ClientReadableStream<WatchExecutionResponse>,
    private readonly connectionSignal: AbortSignal,
    private readonly callerSignal?: AbortSignal,
  ) {
    stream.on('data', this.onData);
    stream.on('error', this.onError);
    stream.on('end', this.onEnd);
    stream.on('close', this.onEnd);
    connectionSignal.addEventListener(
      'abort',
      this.onConnectionAbort,
      { once: true },
    );
    callerSignal?.addEventListener('abort', this.onCallerAbort, {
      once: true,
    });
    if (connectionSignal.aborted) {
      this.onConnectionAbort();
    } else if (callerSignal?.aborted === true) {
      this.onCallerAbort();
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<FerretExecutionEvent> {
    if (this.consumed) {
      return this.failedIterator(
        new FerretExecutionClientError({
          code: 'protocol',
          operation: 'watch-execution',
          message: 'an execution watch can only be consumed once',
        }),
      );
    }

    this.consumed = true;

    const generator = this.iterate();

    return {
      next: () => generator.next(),
      return: () => {
        this.finishLocally();
        return generator.return(undefined);
      },
    };
  }

  private readonly onData = (value: WatchExecutionResponse): void => {
    if (!this.done) {
      if (this.terminalSeen) {
        this.failure = new ProtocolMappingError(
          'execution watch returned an event after its terminal event',
        );
        this.done = true;
        this.detachSignals();
        this.stream.cancel();
        this.notify();
        return;
      }

      this.queue.push(value);
      this.terminalSeen =
        value.payload?.$case === 'completed' ||
        value.payload?.$case === 'failed' ||
        value.payload?.$case === 'cancelled';
      this.notify();
    }
  };

  private readonly onError = (error: unknown): void => {
    if (!this.done) {
      this.failure = error;
      this.done = true;
    }

    this.detachStream();
    this.detachSignals();
    this.notify();
  };

  private readonly onEnd = (): void => {
    if (!this.done && !this.terminalSeen) {
      this.failure = new ProtocolMappingError(
        'execution watch ended before a terminal event',
      );
    }
    this.done = true;
    this.detachStream();
    this.detachSignals();
    this.notify();
  };

  private readonly onCallerAbort = (): void => {
    this.finishLocally();
  };

  private readonly onConnectionAbort = (): void => {
    if (this.connectionSignal.reason instanceof DaemonDisposedError) {
      this.finishLocally();
      return;
    }

    this.failure = this.connectionSignal.reason;
    this.done = true;
    this.detachSignals();
    this.stream.cancel();
    this.notify();
  };

  private async *iterate(): AsyncGenerator<FerretExecutionEvent> {
    try {
      while (true) {
        const next = this.queue.shift();
        if (next !== undefined) {
          try {
            yield mapExecutionEvent(next);
          } catch (error) {
            throw normalizeExecutionError(
              error,
              'watch-execution',
              this.connectionSignal,
            );
          }

          continue;
        }

        if (this.failure !== undefined) {
          throw normalizeExecutionError(
            this.failure,
            'watch-execution',
            this.connectionSignal,
          );
        }

        if (this.done) {
          return;
        }

        await this.wait();
      }
    } finally {
      if (!this.done) {
        this.finishLocally();
      }
    }
  }

  private finishLocally(): void {
    if (this.done) {
      return;
    }

    this.done = true;
    // Keep received events available to the single observer even when Stop wins the unary acknowledgment race.
    if (!this.terminalSeen) this.queue.length = 0;
    this.detachSignals();
    this.stream.cancel();
    this.notify();
  }

  private detachSignals(): void {
    this.connectionSignal.removeEventListener(
      'abort',
      this.onConnectionAbort,
    );
    this.callerSignal?.removeEventListener(
      'abort',
      this.onCallerAbort,
    );
  }

  private detachStream(): void {
    this.stream.removeListener('data', this.onData);
    this.stream.removeListener('error', this.onError);
    this.stream.removeListener('end', this.onEnd);
    this.stream.removeListener('close', this.onEnd);
  }

  private wait(): Promise<void> {
    return new Promise((resolveWait) => {
      this.wake = resolveWait;
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private failedIterator(error: Error): AsyncIterator<FerretExecutionEvent> {
    return { next: () => Promise.reject(error) };
  }
}
