export type FerretJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly FerretJsonValue[]
  | { readonly [key: string]: FerretJsonValue };

export type FerretParameters = Readonly<
  Record<string, FerretJsonValue>
>;

export interface FerretSourceSnapshot {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly uri: string;
  readonly revision: number;
}

export interface FerretSession {
  readonly id: string;
  readonly source: FerretSourceSnapshot;
  readonly parameters: readonly string[];
}

export type FerretExecutionStatus =
  | 'created'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface FerretExecutionOptions {
  readonly outputContentType: string;
}

export interface FerretExecutionOutput {
  readonly contentType: string;
  readonly data: Uint8Array;
}

export type FerretExecutionFailureCategory =
  | 'session-creation'
  | 'runtime'
  | 'cleanup';

export interface FerretPosition {
  readonly line: number;
  readonly character: number;
}

export interface FerretRange {
  readonly start: FerretPosition;
  readonly end: FerretPosition;
}

export interface FerretRelatedInformation {
  readonly uri: string;
  readonly range: FerretRange;
  readonly message: string;
}

export interface FerretDiagnostic {
  readonly uri: string;
  readonly range: FerretRange;
  readonly severity: 'error';
  readonly code: string;
  readonly source: string;
  readonly message: string;
  readonly relatedInformation: readonly FerretRelatedInformation[];
}

export interface FerretExecutionFailure {
  readonly category: FerretExecutionFailureCategory;
  readonly message: string;
  readonly diagnostics: readonly FerretDiagnostic[];
}

export interface FerretExecution {
  readonly id: string;
  readonly sessionId: string;
  readonly status: FerretExecutionStatus;
  readonly parameters: FerretParameters;
  readonly options: FerretExecutionOptions;
  readonly output?: FerretExecutionOutput;
  readonly failure?: FerretExecutionFailure;
}

export type FerretExecutionEventKind =
  | 'created'
  | 'started'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface FerretExecutionEvent {
  readonly executionId: string;
  readonly sequence: number;
  readonly kind: FerretExecutionEventKind;
  readonly execution: FerretExecution;
}
