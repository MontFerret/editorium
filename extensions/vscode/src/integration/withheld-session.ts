import { Client, credentials, Server, ServerCredentials, type ServerUnaryCall } from '@grpc/grpc-js';

import { ExecutionServiceService, type CreateSessionRequest, type CreateSessionResponse } from '../daemon/gen/ferretd/execution/v1/execution.pb';
import type { ExecutionGeneratedClient } from '../daemon/types';

// Let the real daemon commit a Session, then hold its successful reply at the
// transport boundary until the VS Code client's actual gRPC call is cancelled.
export async function withholdSessionReply(client: ExecutionGeneratedClient) {
  const upstream = client.createSession.bind(client);
  const server = new Server();
  let published!: () => void;
  let fail!: (error: Error) => void;
  const committed = new Promise<void>((resolve, reject) => { published = resolve; fail = reject; });
  server.addService({ createSession: ExecutionServiceService.createSession }, {
    createSession(call: ServerUnaryCall<CreateSessionRequest, CreateSessionResponse>,
      callback: Parameters<typeof upstream>[3]) {
      upstream(call.request, call.metadata, { deadline: call.getDeadline() }, (error, response) => {
        if (error) {
          fail(error);
          callback(error, response);
        } else {
          published();
        }
      });
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
  const proxy = new Client(`127.0.0.1:${port}`, credentials.createInsecure());
  const method = ExecutionServiceService.createSession;
  const original = client.createSession;
  client.createSession = (request, metadata, options, callback) =>
    proxy.makeUnaryRequest(method.path, method.requestSerialize, method.responseDeserialize, request, metadata, options,
      (error, response) => callback(error, response ?? {}));
  return {
    committed,
    dispose() {
      client.createSession = original;
      proxy.close();
      server.forceShutdown();
    },
  };
}
