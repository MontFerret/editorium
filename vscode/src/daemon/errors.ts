export type DaemonErrorCode =
  | 'incompatible-daemon'
  | 'protocol'
  | 'startup-failed'
  | 'unavailable';

export class DaemonError extends Error {
  public readonly cause?: unknown;

  public constructor(
    public readonly code: DaemonErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.name = 'DaemonError';
    this.cause = options?.cause;
  }
}

export class DaemonDisposedError extends Error {
  public constructor() {
    super('Ferret daemon connection was disposed locally');
    this.name = 'DaemonDisposedError';
  }
}

export function unavailableDaemon(cause?: unknown): DaemonError {
  return new DaemonError(
    'unavailable',
    'Ferret daemon is unavailable',
    cause === undefined ? undefined : { cause },
  );
}
