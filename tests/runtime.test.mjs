import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listInstanceProcesses, QQInstanceManager } from '../src/runtime.mjs';

async function writeProcess(procRoot, pid, args) {
  await mkdir(path.join(procRoot, String(pid)));
  await writeFile(path.join(procRoot, String(pid), 'cmdline'), Buffer.from(`${args.join('\0')}\0`));
}

async function withProcRoot(run) {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), 'qq-login-portal-proc-'));
  try { await run(procRoot); } finally { await rm(procRoot, { recursive: true, force: true }); }
}

test('associates QQ main processes by exact current flags and excludes Electron helpers', async () => {
  await withProcRoot(async procRoot => {
    await Promise.all([
      writeProcess(procRoot, 100, ['/opt/QQ/qq', '--no-sandbox', '--qq-login-instance=12345678']),
      writeProcess(procRoot, 101, ['/opt/QQ/qq', '--type=renderer', '--qq-login-instance=12345678']),
      writeProcess(procRoot, 102, ['/opt/QQ/qq', '--no-sandbox', '--qq-login-instance=87654321']),
      writeProcess(procRoot, 103, ['/usr/bin/node', '--qq-login-instance=12345678']),
    ]);

    assert.deepEqual(await listInstanceProcesses('/opt/QQ/qq', '12345678', procRoot), [100]);
    assert.deepEqual(await listInstanceProcesses('/opt/QQ/qq', '87654321', procRoot), [102]);
  });
});

test('recognizes an exact legacy flag only as a migration alias', async () => {
  await withProcRoot(async procRoot => {
    await Promise.all([
      writeProcess(procRoot, 100, ['/opt/QQ/qq', '--snowluma-instance=main']),
      writeProcess(procRoot, 101, ['/opt/QQ/qq', '--snowluma-instance=other']),
    ]);
    assert.deepEqual(await listInstanceProcesses('/opt/QQ/qq', '12345678', procRoot, ['main']), [100]);
  });
});

function managerConfig(procRoot) {
  return {
    runtime: {
      stateDir: procRoot,
      xvfb: { display: ':991', command: 'Xvfb', args: [] },
      qq: {
        command: path.join(procRoot, 'qq'),
        resourcesDir: path.join(procRoot, 'resources'),
        agentEntry: path.join(procRoot, 'qq-agent.cjs'),
        args: ['--no-sandbox'],
        startupTimeoutMs: 2_000,
      },
    },
    instances: [
      {
        id: 'main', uin: '12345678', enabled: true, autostart: true,
        homeDir: path.join(procRoot, 'main'), userDataDir: path.join(procRoot, 'main', 'electron'), display: ':991',
        socketPath: path.join(procRoot, 'main.sock'),
      },
      {
        id: '87654321', uin: '87654321', enabled: true, autostart: true,
        homeDir: path.join(procRoot, 'second'), userDataDir: path.join(procRoot, 'second', 'electron'), display: ':991',
        socketPath: path.join(procRoot, 'second.sock'),
      },
    ],
  };
}

test('one unavailable instance does not erase another kernel login state', async () => {
  await withProcRoot(async procRoot => {
    const config = managerConfig(procRoot);
    await Promise.all([
      writeProcess(procRoot, 100, [config.runtime.qq.command, '--snowluma-instance=main']),
      writeProcess(procRoot, 200, [config.runtime.qq.command, '--qq-login-instance=87654321']),
    ]);
    const manager = new QQInstanceManager(config, {
      procRoot,
      inspectLoaderFn: async () => ({ installed: true, state: 'installed', message: 'ok' }),
      requestAgentFn: async socketPath => {
        if (socketPath.endsWith('second.sock')) throw new Error('ECONNREFUSED');
        return {
          state: {
            instanceId: 'main', pid: 100, phase: 'online', connected: true,
            qrcodeAvailable: false, qrcodeRevision: 2, quickLoginAccounts: [],
            account: { uin: '12345678', uid: 'u', nickname: '' }, error: '', updatedAt: 1,
          },
        };
      },
    });

    const snapshot = await manager.snapshot();
    assert.equal(snapshot.instances[0].login.phase, 'online');
    assert.equal(snapshot.instances[0].login.online, true);
    assert.equal(snapshot.instances[0].login.account.uin, '12345678');
    assert.equal(snapshot.instances[1].login.phase, 'agent_unavailable');
    assert.equal(snapshot.instances[1].login.online, false);
    assert.match(snapshot.instances[1].login.error, /ECONNREFUSED/);
    assert.equal('onebot' in snapshot.instances[0], false);
    assert.equal('snowluma' in snapshot.runtime, false);
  });
});

test('starts new QQ processes with only standalone arguments and environment names', async () => {
  await withProcRoot(async procRoot => {
    const config = managerConfig(procRoot);
    config.instances = [config.instances[0]];
    await Promise.all([
      writeFile(config.runtime.qq.command, ''),
      writeFile(config.runtime.qq.agentEntry, ''),
    ]);
    let launch;
    const manager = new QQInstanceManager(config, {
      procRoot,
      inspectLoaderFn: async () => ({ installed: true, state: 'installed', message: 'ok' }),
      ensureDisplayFn: async () => 'existing',
      spawnFn: async (spec, env) => {
        launch = { spec, env };
        await writeProcess(procRoot, 300, [spec.command, ...spec.args]);
        return 300;
      },
      requestAgentFn: async () => ({ state: { phase: 'waiting_scan' } }),
      waitFn: async check => Boolean(await check()),
    });

    const result = await manager.startInstance('main');
    assert.deepEqual(result, { started: true, pid: 300, agentReady: true });
    assert.ok(launch.spec.args.includes('--qq-login-instance=12345678'));
    assert.equal(launch.spec.args.some(arg => arg.startsWith('--snowluma-instance=')), false);
    assert.equal(launch.env.QQ_LOGIN_EXPECTED_UIN, '12345678');
    assert.equal(launch.env.QQ_LOGIN_SOCKET, config.instances[0].socketPath);
    assert.equal(Object.keys(launch.env).some(key => key.startsWith('SNOWLUMA_')), false);
  });
});

test('refresh, quick login, and logout use only the selected instance socket', async () => {
  await withProcRoot(async procRoot => {
    const config = managerConfig(procRoot);
    const calls = [];
    const manager = new QQInstanceManager(config, {
      procRoot,
      requestAgentFn: async (socketPath, request) => {
        calls.push({ socketPath, request });
        return { accepted: true };
      },
    });

    await manager.refreshQrCode('87654321');
    await manager.quickLogin('main', '12345678');
    await manager.logoutInstance('87654321');
    assert.equal(calls[0].socketPath, config.instances[1].socketPath);
    assert.deepEqual(calls[0].request, { action: 'refresh' });
    assert.equal(calls[1].socketPath, config.instances[0].socketPath);
    assert.deepEqual(calls[1].request, { action: 'quickLogin', uin: '12345678' });
    assert.equal(calls[2].socketPath, config.instances[1].socketPath);
    assert.deepEqual(calls[2].request, { action: 'logout' });
  });
});

test('stops only exact processes belonging to the selected instance', async () => {
  await withProcRoot(async procRoot => {
    const config = managerConfig(procRoot);
    await Promise.all([
      writeProcess(procRoot, 100, [config.runtime.qq.command, '--snowluma-instance=main']),
      writeProcess(procRoot, 200, [config.runtime.qq.command, '--qq-login-instance=87654321']),
    ]);
    const signals = [];
    const manager = new QQInstanceManager(config, {
      procRoot,
      killFn: (pid, signal) => {
        signals.push([pid, signal]);
        rmSync(path.join(procRoot, String(pid)), { recursive: true, force: true });
      },
    });

    const result = await manager.stopInstance('87654321');
    assert.deepEqual(result, { stopped: true, signaledPids: [200], remainingPids: [] });
    assert.deepEqual(signals, [[200, 'SIGTERM']]);
    assert.deepEqual(await manager.findPids(config.instances[0]), [100]);
  });
});

test('does not start an instance disabled during migration', async () => {
  await withProcRoot(async procRoot => {
    const config = managerConfig(procRoot);
    config.instances[0].enabled = false;
    let inspected = false;
    let spawned = false;
    const manager = new QQInstanceManager(config, {
      procRoot,
      inspectLoaderFn: async () => { inspected = true; return { installed: true }; },
      spawnFn: async () => { spawned = true; return 123; },
    });

    await assert.rejects(manager.startInstance('main'), /已在配置中停用/);
    assert.equal(inspected, false);
    assert.equal(spawned, false);
  });
});
