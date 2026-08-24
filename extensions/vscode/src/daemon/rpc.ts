import {
  Channel,
  ChannelCredentials,
  makeGenericClientConstructor,
  type ClientUnaryCall,
  type ServiceError,
} from '@grpc/grpc-js';

import { DaemonServiceService } from './gen/ferretd/daemon/v1/daemon.pb';
import {
  ExecutionServiceService,
} from './gen/ferretd/execution/v1/execution.pb';
import {
  WorkspaceServiceService,
} from './gen/ferretd/workspace/v1/workspace.pb';
import type {
  DaemonConnection,
  DaemonGeneratedClient,
  ExecutionGeneratedClient,
  WorkspaceGeneratedClient,
} from './types';

type GeneratedClientConstructor<Client> = new (
  address: string,
  credentials: ChannelCredentials,
  options?: object,
) => Client;

const DaemonClient = makeGenericClientConstructor(
  DaemonServiceService,
  'DaemonService',
) as unknown as GeneratedClientConstructor<DaemonGeneratedClient>;
const ExecutionClient = makeGenericClientConstructor(
  ExecutionServiceService,
  'ExecutionService',
) as unknown as GeneratedClientConstructor<ExecutionGeneratedClient>;
const WorkspaceClient = makeGenericClientConstructor(
  WorkspaceServiceService,
  'WorkspaceService',
) as unknown as GeneratedClientConstructor<WorkspaceGeneratedClient>;

export function createConnection(
  target: string,
  signal: AbortSignal,
): DaemonConnection {
  const credentials = ChannelCredentials.createInsecure();
  const channel = new Channel(target, credentials, {});
  const options = { channelOverride: channel };

  return {
    channel,
    daemon: new DaemonClient('unused', credentials, options),
    executions: new ExecutionClient(
      'unused',
      credentials,
      options,
    ),
    signal,
    workspaces: new WorkspaceClient(
      'unused',
      credentials,
      options,
    ),
  };
}

export function unary<Response>(
  invoke: (
    callback: (
      error: ServiceError | null,
      response: Response,
    ) => void,
  ) => ClientUnaryCall,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted === true) {
    return Promise.reject(signal.reason);
  }

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (!settled) {
        call.cancel();
      }
    };
    const finish = (
      error: ServiceError | null,
      response: Response,
    ): void => {
      if (settled) {
        return;
      }

      settled = true;
      signal?.removeEventListener('abort', onAbort);

      if (signal?.aborted === true) {
        reject(signal.reason);
      } else if (error !== null) {
        reject(error);
      } else {
        resolve(response);
      }
    };

    const call = invoke(finish);
    if (settled) {
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
    }
  });
}
