import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const generatedRoot = join(packageRoot, 'src', 'daemon', 'gen');
const check = process.argv.includes('--check');
const temporaryRoot = check
  ? await mkdtemp(join(tmpdir(), 'ferret-vscode-proto-'))
  : undefined;
const outputRoot = temporaryRoot ?? generatedRoot;

const template = {
  version: 'v2',
  clean: true,
  inputs: [
    {
      directory: repositoryRoot,
      paths: [
        'shared/proto/ferretd/daemon/v1/daemon.proto',
        'shared/proto/ferretd/execution/v1/execution.proto',
        'shared/proto/ferretd/workspace/v1/workspace.proto',
        'shared/proto/google/rpc/status.proto',
      ],
    },
  ],
  plugins: [
    {
      local: 'protoc-gen-ts_proto',
      out: outputRoot,
      strategy: 'all',
      opt: [
        'env=node',
        'esModuleInterop=false',
        'fileSuffix=.pb',
        'forceLong=number',
        'oneof=unions',
        'outputClientImpl=false',
        'outputJsonMethods=false',
        'outputServices=grpc-js',
        'useExactTypes=false',
        'useOptionals=messages',
      ],
    },
  ],
};

try {
  if (check) {
    await run('buf', [
      'lint',
      'shared/proto',
      '--config',
      'buf.yaml',
    ]);
  }

  await run('buf', [
    'generate',
    '--template',
    JSON.stringify(template),
  ]);

  if (check) {
    await compareTrees(generatedRoot, outputRoot);
  }
} finally {
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} exited with ${
            signal === null ? `code ${String(code)}` : `signal ${signal}`
          }`,
        ),
      );
    });
  });
}

async function compareTrees(expectedRoot, actualRoot) {
  const expected = await files(expectedRoot);
  const actual = await files(actualRoot);
  const names = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  const differences = [];

  for (const name of names) {
    const expectedFile = expected.get(name);
    const actualFile = actual.get(name);

    if (expectedFile === undefined) {
      differences.push(`unexpected generated file: ${name}`);
      continue;
    }

    if (actualFile === undefined) {
      differences.push(`missing generated file: ${name}`);
      continue;
    }

    const [expectedBytes, actualBytes] = await Promise.all([
      readFile(expectedFile),
      readFile(actualFile),
    ]);
    if (!expectedBytes.equals(actualBytes)) {
      differences.push(`outdated generated file: ${name}`);
    }
  }

  if (differences.length > 0) {
    throw new Error(
      `generated protobuf sources are out of date:\n${differences.join('\n')}`,
    );
  }
}

async function files(root) {
  const result = new Map();

  try {
    await access(root, constants.R_OK);
  } catch {
    return result;
  }

  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        result.set(relative(root, path), path);
      }
    }
  }

  return result;
}
