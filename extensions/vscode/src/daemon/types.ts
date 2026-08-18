import type {
  CallOptions,
  Channel,
  ClientReadableStream,
  ClientUnaryCall,
  Metadata,
  ServiceError,
} from '@grpc/grpc-js';

import type {
  GetInfoRequest,
  GetInfoResponse,
  ShutdownRequest,
  ShutdownResponse,
} from './gen/ferretd/daemon/v1/daemon.pb';
import type {
  CancelExecutionRequest,
  CancelExecutionResponse,
  CloseExecutionRequest,
  CloseExecutionResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  CreateExecutionRequest,
  CreateExecutionResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  RunExecutionRequest,
  RunExecutionResponse,
  WatchExecutionRequest,
  WatchExecutionResponse,
} from './gen/ferretd/execution/v1/execution.pb';
import type {
  CloseRequest,
  CloseResponse,
  OpenRequest,
  OpenResponse,
} from './gen/ferretd/workspace/v1/workspace.pb';

type UnaryCallback<Response> = (
  error: ServiceError | null,
  response: Response,
) => void;

type UnaryMethod<Request, Response> = (
  request: Request,
  callback: UnaryCallback<Response>,
) => ClientUnaryCall;

export interface DaemonGeneratedClient {
  getInfo(
    request: GetInfoRequest,
    metadata: Metadata,
    options: Partial<CallOptions>,
    callback: UnaryCallback<GetInfoResponse>,
  ): ClientUnaryCall;
  shutdown(
    request: ShutdownRequest,
    metadata: Metadata,
    options: Partial<CallOptions>,
    callback: UnaryCallback<ShutdownResponse>,
  ): ClientUnaryCall;
}

export interface WorkspaceGeneratedClient {
  open: UnaryMethod<OpenRequest, OpenResponse>;
  close: UnaryMethod<CloseRequest, CloseResponse>;
}

export interface ExecutionGeneratedClient {
  createSession: UnaryMethod<CreateSessionRequest, CreateSessionResponse>;
  closeSession: UnaryMethod<CloseSessionRequest, CloseSessionResponse>;
  createExecution: UnaryMethod<
    CreateExecutionRequest,
    CreateExecutionResponse
  >;
  runExecution: UnaryMethod<RunExecutionRequest, RunExecutionResponse>;
  cancelExecution: UnaryMethod<
    CancelExecutionRequest,
    CancelExecutionResponse
  >;
  closeExecution: UnaryMethod<
    CloseExecutionRequest,
    CloseExecutionResponse
  >;
  watchExecution(
    request: WatchExecutionRequest,
  ): ClientReadableStream<WatchExecutionResponse>;
}

export interface FerretWorkspace {
  readonly id: string;
  readonly root: string;
}

export interface ResolvedFerretDocument {
  readonly workspaceId: string;
  readonly relativePath: string;
}

export interface DaemonConnection {
  readonly channel: Channel;
  readonly daemon: DaemonGeneratedClient;
  readonly executions: ExecutionGeneratedClient;
  readonly signal: AbortSignal;
  readonly workspaces: WorkspaceGeneratedClient;
}

export interface DaemonConnectionProvider {
  requireConnection(): DaemonConnection;
}
