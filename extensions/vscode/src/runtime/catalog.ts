import { Metadata, status } from '@grpc/grpc-js';

import type { ListRuntimesResponse } from '../daemon/gen/ferretd/daemon/v1/daemon.pb';
import { unary } from '../daemon/rpc';
import { isServiceError } from '../daemon/status-details';
import type { DaemonConnection } from '../daemon/types';

import { UnsupportedDiscovery } from './errors';

// ferretd validates surrounding whitespace using Go's Unicode White_Space set.
// U+FEFF is valid at the start of a literal runtime name.
const boundaryWhitespace = /^\p{White_Space}|\p{White_Space}$/u;

export async function listRuntimes(connection: DaemonConnection): Promise<ListRuntimesResponse> {
  const version = connection.apiVersion;
  if (version?.major !== 1 || version.minor < 3) {
    throw new UnsupportedDiscovery('Runtime discovery requires ferretd API 1.3 or later in major 1.');
  }
  try {
    const catalog = await unary<ListRuntimesResponse>((callback) =>
      connection.daemon.listRuntimes({}, new Metadata(), { deadline: Date.now() + 10000 }, callback),
    connection.signal);
    return validateCatalog(catalog);
  } catch (error) {
    if (isServiceError(error) && error.code === status.UNIMPLEMENTED) {
      throw new UnsupportedDiscovery('This ferretd executable does not support runtime discovery.');
    }
    throw error;
  }
}

export function validateCatalog(catalog: ListRuntimesResponse): ListRuntimesResponse {
  const names = new Set<string>();
  for (const { name, label, provider } of catalog.runtimes) {
    if (!name || boundaryWhitespace.test(name) || names.has(name) || !label || !provider) {
      throw new Error('Ferret returned an incomplete or duplicate runtime descriptor.');
    }
    names.add(name);
  }
  if (!names.has(catalog.defaultRuntime)) throw new Error('Ferret returned a catalog missing its default runtime.');
  return catalog;
}
