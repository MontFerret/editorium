import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import { Metadata, status } from '@grpc/grpc-js';

import type { DaemonConnection } from '../daemon/types';
import { listRuntimes, validateCatalog } from '../runtime/catalog';
import { resolveRuntimeConfiguration } from '../runtime/configuration';
import { UnsupportedDiscovery } from '../runtime/errors';
import { RuntimeCoordinator } from '../runtime/coordinator';

const local = { name: 'local', label: 'Built-in', provider: 'native' };
const remote = { name: 'Δ 🦦', label: 'Service', provider: 'wire' };
const catalog = { defaultRuntime: remote.name, runtimes: [local, remote] };

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

class RuntimeDaemon {
  public minor = 4;
  public executables: (string | undefined)[] = [];
  public paths: (string | undefined)[] = [];
  public process = new AbortController();
  public beforeStart = async () => {};
  public async start(path?: string, executable?: string): Promise<void> {
    this.executables.push(executable);
    this.paths.push(path);
    await this.beforeStart();
  }
  public async stop(): Promise<void> {
    this.process.abort();
    this.process = new AbortController();
  }
  public requireConnection(): DaemonConnection {
    return { signal: this.process.signal, apiVersion: { major: 1, minor: this.minor } } as DaemonConnection;
  }
}

suite('window runtime catalog', () => {
  let dir: string;
  let daemon: RuntimeDaemon;
  let config: string;
  let selection: string;
  let requests: number;
  let discover: () => Promise<typeof catalog>;
  let runtime: RuntimeCoordinator;
  setup(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ferret-runtime-'));
    config = join(dir, 'runtimes.json');
    await writeFile(config, 'bytes owned by ferretd');
    daemon = new RuntimeDaemon();
    selection = '';
    requests = 0;
    discover = async () => catalog;
    runtime = new RuntimeCoordinator(daemon, { entered: '' }, () => selection, () => {
      requests++;
      return discover();
    });
  });
  teardown(async () => { await runtime.shutdown(); await rm(dir, { recursive: true, force: true }); });

  test('adopts the latest pre-use save and coalesces discovery and startup', async () => {
    runtime.save(resolveRuntimeConfiguration('unapplied', dir));
    runtime.save(resolveRuntimeConfiguration(config));
    await runtime.restartExecutable('/override');
    assert.deepEqual(daemon.paths, []);
    const started = gate(), done = gate();
    discover = async () => { started.open(); await done.promise; return catalog; };
    const first = runtime.catalog();
    assert.equal(runtime.catalog(), first);
    await started.promise;
    assert.equal(runtime.retry(), first);
    assert.equal(runtime.view.status, 'loading');
    done.open();
    await first;
    assert.equal(requests, 1);
    assert.deepEqual(daemon.paths, [config]);
    assert.deepEqual(runtime.view.catalog, catalog);
    assert.throws(() => runtime.admitDebug(), /Daemon default/);
  });

  test('pins admitted launches across saves and binary restarts without adopting a pending path', async () => {
    const admitted = runtime.admitRun();
    await runtime.restartExecutable('/override');
    assert.deepEqual(daemon.paths, []);
    runtime.save(resolveRuntimeConfiguration(config));
    await admitted.prepareRun();
    assert.deepEqual(daemon.paths, [undefined]);
    const restart = runtime.restartExecutable('/override');
    assert.equal(runtime.restartExecutable('/override'), restart);
    await restart;
    assert.deepEqual(daemon.paths, [undefined, undefined]);
    await assert.rejects(runtime.reload(), /finish/);
    runtime.save({ entered: '' });
    runtime.save({ entered: '' });
    assert.throws(() => runtime.admitDebug(), /Reload/);
    admitted.release();
    admitted.release();
    await runtime.reload();
    const run = runtime.admitRun();
    await run.prepareRun();
    run.release();
    assert.equal(requests, 2);
  });

  test('keeps a save pending during startup, including after failed startup', async () => {
    const entered = gate(), release = gate();
    daemon.beforeStart = async () => { entered.open(); await release.promise; throw new Error('startup failed'); };
    const discovery = runtime.catalog();
    await entered.promise;
    runtime.save(resolveRuntimeConfiguration(config));
    runtime.save({ entered: '' });
    release.open();
    await discovery;
    assert.equal(runtime.view.status, 'reload-required');
    await assert.rejects(runtime.retry(), /Reload/);
    assert.throws(() => runtime.admitDebug(), /Reload/);
    daemon.beforeStart = async () => {};
    await runtime.reload();
    assert.equal(runtime.view.status, 'ready');
  });

  test('preserves adoption across failed startup and distinguishes retry from explicit replacement', async () => {
    daemon.beforeStart = async () => { throw new Error('start failed'); };
    await runtime.catalog();
    assert.equal(runtime.view.status, 'failed');
    daemon.beforeStart = async () => {};
    await runtime.retry();
    assert.equal(runtime.view.status, 'ready');
    runtime.save(resolveRuntimeConfiguration(config));
    daemon.beforeStart = async () => { throw new Error('replacement failed'); };
    await runtime.reload();
    assert.equal(runtime.view.status, 'reload-required');
    await assert.rejects(runtime.retry(), /Reload/);
    assert.deepEqual(daemon.paths, [undefined, undefined, config]);
  });

  test('does not let a late catalog publish across reload or a newer save', async () => {
    const started = gate(), done = gate();
    discover = async () => { started.open(); await done.promise; return catalog; };
    const old = runtime.catalog();
    await started.promise;
    const nextStarted = gate(), nextDone = gate();
    discover = async () => { nextStarted.open(); await nextDone.promise; return catalog; };
    const replacement = runtime.reload();
    assert.strictEqual(runtime.reload(), replacement);
    await nextStarted.promise;
    done.open();
    await old;
    assert.equal(runtime.view.status, 'loading');
    runtime.save(resolveRuntimeConfiguration(config));
    runtime.save({ entered: '' });
    nextDone.open();
    await replacement;
    assert.equal(runtime.view.status, 'reload-required');
    assert.equal(runtime.view.catalog, undefined);
    await runtime.reload();
    assert.equal(runtime.view.status, 'ready');
  });

  for (const restoreOriginal of [false, true]) {
    test(`explicit Reload supersedes the older replacement after ${restoreOriginal ? 'A → B → A' : 'A → B'}`, async () => {
      const entered = gate(), release = gate();
      discover = async () => { entered.open(); await release.promise; return catalog; };
      const old = runtime.reload();
      await entered.promise;
      runtime.save(resolveRuntimeConfiguration(config));
      if (restoreOriginal) runtime.save({ entered: '' });
      const latest = { defaultRuntime: 'local', runtimes: [local] };
      discover = async () => latest;
      const replacement = runtime.reload();
      assert.notEqual(replacement, old);
      assert.equal(runtime.reload(), replacement);
      await replacement;
      if (restoreOriginal) runtime.admitDebug().release();
      else assert.throws(() => runtime.admitDebug(), /Daemon default/);
      release.open();
      await old;
      assert.deepEqual(runtime.view.catalog, latest);
      assert.deepEqual(daemon.paths, [undefined, restoreOriginal ? undefined : config]);
    });
  }

  test('a newer executable supersedes a starting binary replacement on the adopted revision', async () => {
    await runtime.catalog();
    runtime.save(resolveRuntimeConfiguration(config));
    const entered = gate(), release = gate();
    daemon.beforeStart = async () => { entered.open(); await release.promise; };
    const first = runtime.restartExecutable('B');
    await entered.promise;
    daemon.beforeStart = async () => {};
    const second = runtime.restartExecutable('C');
    assert.equal(runtime.restartExecutable('C'), second);
    await second;
    release.open();
    await first;
    assert.deepEqual(daemon.executables, [undefined, 'B', 'C']);
    assert.deepEqual(daemon.paths, [undefined, undefined, undefined]);
    assert.equal(runtime.view.status, 'reload-required');
  });

  test('reports discovery failures to Run and preserves live replacement on retry', async () => {
    discover = async () => { throw new Error('RPC failed'); };
    await runtime.catalog();
    const run = runtime.admitRun();
    await assert.rejects(run.prepareRun(), /RPC failed/);
    run.release();
    assert.deepEqual(daemon.paths, [undefined]);
    await runtime.reload();
    assert.equal(runtime.view.status, 'failed');
    assert.throws(() => runtime.admitDebug(), /reload/i);
    discover = async () => catalog;
    await runtime.retry();
    assert.deepEqual(daemon.paths, [undefined, undefined]);
    assert.equal(runtime.view.status, 'ready');
    runtime.admitDebug().release();
    discover = async () => { throw new Error('again'); };
    await runtime.reload();
    await daemon.stop();
    await assert.rejects(runtime.retry(), /Reload/);
    assert.equal(daemon.paths.length, 3);
  });

  test('keeps independent Debug reservations on daemon loss and honors literal selectors', async () => {
    await runtime.catalog();
    const a = runtime.admitDebug(), b = runtime.admitDebug();
    await daemon.stop();
    assert.equal(runtime.view.catalog, undefined);
    a.release();
    await assert.rejects(runtime.reload(), /finish/);
    b.release();
    for (const name of ['local', 'LOCAL', ' ', 'Δ 🦦', 'Daemon default']) {
      assert.throws(() => runtime.admitDebug(name), /Daemon default/);
      selection = name;
      assert.throws(() => runtime.admitDebug(''), /Daemon default/);
      selection = '';
    }
    await runtime.reload();
    assert.equal(runtime.view.status, 'ready');
  });

  test('detects changed bytes during startup and rereads unchanged paths on explicit reload', async () => {
    runtime.save(resolveRuntimeConfiguration(config));
    daemon.beforeStart = async () => { await writeFile(config, 'changed'); };
    await runtime.catalog();
    assert.equal(requests, 0);
    assert.equal(runtime.view.status, 'reload-required');
    runtime.save(resolveRuntimeConfiguration(config));
    assert.equal(runtime.view.status, 'reload-required');
    await runtime.reload();
    assert.equal(runtime.view.status, 'ready');
    discover = async () => { await rm(config); return catalog; };
    await runtime.reload();
    assert.equal(runtime.view.status, 'reload-required');
  });

  test('resolves against admitted A after Save B and detects edits before memoized reuse', async () => {
    runtime.save(resolveRuntimeConfiguration(config));
    selection = remote.name;
    const entered = gate(), release = gate();
    discover = async () => { entered.open(); await release.promise; return catalog; };
    const named = runtime.admitRun(), implicit = runtime.admitRun(''), native = runtime.admitRun('local');
    const results = Promise.all([named.prepareRun(), implicit.prepareRun(), native.prepareRun()]);
    await entered.promise;
    runtime.save(resolveRuntimeConfiguration(join(dir, 'other.json')));
    selection = 'changed';
    release.open();
    const [first, second, third] = await results;
    assert.deepEqual([first.selector, second.selector, third.selector], [remote.name, '', 'local']);
    assert.deepEqual([first.name, second.name, third.name], [remote.name, remote.name, 'local']);
    assert.deepEqual([first.provider, second.provider, third.provider], ['wire', 'wire', 'native']);
    assert.equal(first.connection, third.connection);
    assert.equal(requests, 1);
    assert.equal(runtime.view.status, 'reload-required');
    assert.throws(() => runtime.admitRun(), /Reload/);
    await named.verifyConfiguration();
    for (const run of [named, implicit, native]) run.release();
    runtime.save(resolveRuntimeConfiguration(config));
    await runtime.reload();
    const reuse = runtime.admitRun('local');
    await reuse.prepareRun();
    await writeFile(config, 'different bytes');
    await assert.rejects(reuse.verifyConfiguration(), /Reload/);
    assert.throws(() => runtime.admitRun(), /Reload/);
    reuse.release();
  });

  test('rejects exact-name misses, unknown providers, and explicit or configured selection on API 1.2', async () => {
    discover = async () => ({ ...catalog, runtimes: [local, { ...remote, provider: 'future' }] });
    for (const [name, message] of [['LOCAL', /unavailable/], ['', /Unsupported provider/]] as const) {
      const run = runtime.admitRun(name);
      await assert.rejects(run.prepareRun(), message);
      run.release();
    }
    await runtime.shutdown();
    daemon.minor = 2;
    runtime = new RuntimeCoordinator(daemon, { entered: '' }, () => '');
    const fallback = runtime.admitRun('');
    assert.equal((await fallback.prepareRun()).provider, 'native');
    fallback.release();
    const explicit = runtime.admitRun('local');
    await assert.rejects(explicit.prepareRun(), /API 1.3/);
    explicit.release();
    await runtime.shutdown();
    runtime = new RuntimeCoordinator(daemon, resolveRuntimeConfiguration(config), () => '');
    const configured = runtime.admitRun('');
    await assert.rejects(configured.prepareRun(), /API 1.3/);
    configured.release();
  });

  test('API 1.3 gates the resolved Wire default and permits explicit native', async () => {
    daemon.minor = 3;
    runtime.save(resolveRuntimeConfiguration(config));
    for (const selector of ['', remote.name, 'local']) {
      const run = runtime.admitRun(selector);
      try {
        if (selector === 'local') assert.equal((await run.prepareRun()).provider, 'native');
        else await assert.rejects(run.prepareRun(), /Δ 🦦.*API 1.4.*Upgrade/);
      } finally { run.release(); }
    }
  });

  test('unsupported initial discovery still permits built-in launches', async () => {
    discover = async () => { throw new UnsupportedDiscovery('Unsupported daemon'); };
    await runtime.catalog();
    assert.equal(runtime.view.status, 'unsupported');
    assert.equal(runtime.view.catalog, undefined);
    const run = runtime.admitRun();
    await run.prepareRun();
    run.release();
    assert.equal(requests, 1);
    await runtime.reload();
    assert.equal(runtime.view.status, 'unsupported');
    const after = runtime.admitRun('');
    assert.equal((await after.prepareRun()).name, 'local');
    after.release();
  });

  test('disposal settles in-flight work and ignores late results', async () => {
    const entered = gate(), release = gate();
    discover = async () => { entered.open(); await release.promise; return catalog; };
    const work = runtime.catalog();
    await entered.promise;
    const shutdown = runtime.shutdown();
    release.open();
    await Promise.all([shutdown, work]);
    assert.equal(runtime.view.catalog, undefined);
    assert.throws(() => runtime.admitDebug(), /shutting down/);
  });

  test('shutdown joins superseded discovery even after its replacement has completed', async () => {
    const entered = gate(), release = gate();
    discover = async () => { entered.open(); await release.promise; return catalog; };
    const old = runtime.catalog();
    await entered.promise;
    discover = async () => catalog;
    await runtime.reload();
    let stopped = false;
    const shutdown = runtime.shutdown().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    release.open();
    await Promise.all([old, shutdown]);
  });

  test('resolves relative paths only against one host folder and fails explicit invalid files', async () => {
    assert.deepEqual(resolveRuntimeConfiguration('runtimes.json', dir), { entered: 'runtimes.json', path: config });
    assert.ok(resolveRuntimeConfiguration('runtimes.json').problem);
    assert.ok(resolveRuntimeConfiguration(null).problem);
    assert.ok(resolveRuntimeConfiguration('${workspaceFolder}/runtimes.json', dir).problem);
    for (const path of [dir, join(dir, 'missing')]) {
      runtime.save(resolveRuntimeConfiguration(path));
      await runtime.reload();
      assert.equal(runtime.view.status, 'reload-required');
    }
    assert.deepEqual(daemon.paths, []);
    runtime.save(resolveRuntimeConfiguration('runtimes.json', dir));
    await runtime.reload();
    runtime.save(resolveRuntimeConfiguration('runtimes.json', resolve(dir, '..')));
    assert.equal(runtime.view.status, 'reload-required');
  });

  test('rejects a runtime configuration FIFO without waiting for a writer', async function () {
    if (process.platform === 'win32') this.skip();

    const fifo = join(dir, 'runtime.fifo');
    const exec = promisify(execFile);
    await exec('mkfifo', [fifo]);
    const { stdout } = await exec('node', [
      '-e', 'require(process.argv[1]).fingerprintFile(process.argv[2]).catch(error => console.log(error.message))',
      require.resolve('../file-fingerprint'), fifo,
    ], { timeout: 5_000, killSignal: 'SIGKILL' });
    assert.equal(stdout.trimEnd(), `Expected a regular file: ${fifo}`);
  });

  test('requires a fully qualified Windows root for absolute paths on any host', () => {
    for (const entered of ['///runtimes.json', '//settings.json', '/cfg.json', 'C:cfg.json', '\\\\host', '//?/UNC/host', '//?/C:cfg.json']) {
      assert.match(resolveRuntimeConfiguration(entered, 'C:\\workspace', win32).problem!, /fully qualified/);
    }
    for (const entered of ['C:/dir/cfg.json', '//server/share/cfg.json', '//?/UNC/host/share/cfg.json', '//?/C:/dir/cfg.json']) {
      assert.equal(resolveRuntimeConfiguration(entered, undefined, win32).path, win32.normalize(entered));
    }
    assert.equal(resolveRuntimeConfiguration('sub/cfg.json', 'D:\\workspace', win32).path, 'D:\\workspace\\sub\\cfg.json');
  });

  test('validates descriptor identity, default membership, and negotiated discovery support', async () => {
    for (const entry of [{ ...local, name: '' }, { ...local, name: ' local' },
      { ...local, provider: '' }, { ...local, label: '' }, local]) {
      assert.throws(() => validateCatalog({ defaultRuntime: 'local', runtimes: [local, entry] }));
    }
    assert.throws(() => validateCatalog({ defaultRuntime: 'other', runtimes: [local] }), /default/);
    assert.equal(validateCatalog(catalog), catalog);
    const literal = { ...local, name: '\uFEFFlocal' };
    assert.equal(validateCatalog({ defaultRuntime: literal.name, runtimes: [literal] }).defaultRuntime, literal.name);
    assert.throws(() => validateCatalog({ defaultRuntime: 'local', runtimes: [{ ...local, name: '\u0085local' }] }));
    for (const version of [{ major: 1, minor: 2 }, { major: 2, minor: 3 }]) {
      await assert.rejects(listRuntimes({ ...daemon.requireConnection(), apiVersion: version }), /API 1.3/);
    }
    let details = 'unimplemented';
    const connection = {
      ...daemon.requireConnection(),
      daemon: { listRuntimes: (_r, _m, _o, cb) => {
        cb(Object.assign(new Error(details), { code: status.UNIMPLEMENTED, details, metadata: new Metadata() }), catalog);
        return {} as ReturnType<DaemonConnection['daemon']['listRuntimes']>;
      } } as DaemonConnection['daemon'],
    };
    await assert.rejects(listRuntimes(connection), /does not support/);
    for (details of ['No message received', 'Too many responses received']) {
      await assert.rejects(listRuntimes(connection), error => !(error instanceof UnsupportedDiscovery) && String(error).includes(details));
    }
  });
});
