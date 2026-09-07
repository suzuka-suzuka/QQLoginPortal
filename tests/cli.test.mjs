import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { probeKernel } from '../src/cli.mjs';

function probeConfig() {
  return {
    runtime: {
      stateDir: path.resolve('test-state'),
      xvfb: { display: ':99' },
      qq: {},
    },
    instances: [],
  };
}

test('kernel probe cleans an exact spawned instance when startup throws before returning', async () => {
  let findCall = 0;
  const killed = [];
  const removed = [];
  const manager = {
    async findPids() {
      findCall += 1;
      if (findCall === 1) return [];
      if (findCall === 2) return [4242];
      return [];
    },
    async startInstance() {
      throw new Error('QQ spawned, then readiness check failed');
    },
  };

  await assert.rejects(
    probeKernel(probeConfig(), {
      platform: 'linux',
      managerFactory: () => manager,
      killProcess: (pid, signal) => killed.push({ pid, signal }),
      removePath: async (target, options) => removed.push({ target, options }),
    }),
    /readiness check failed/,
  );

  assert.deepEqual(killed, [{ pid: 4242, signal: 'SIGTERM' }]);
  assert.equal(removed.length, 2);
  assert.equal(removed[0].options.force, true);
  assert.equal(removed[1].options.force, true);
});

test('kernel probe never takes over a pre-existing exact probe instance', async () => {
  let started = false;
  const killed = [];
  const removed = [];
  const manager = {
    async findPids() { return [4343]; },
    async startInstance() { started = true; },
  };

  await assert.rejects(
    probeKernel(probeConfig(), {
      platform: 'linux',
      managerFactory: () => manager,
      killProcess: (pid, signal) => killed.push({ pid, signal }),
      removePath: async target => removed.push(target),
    }),
    /遗留的 kernel-probe 主进程/,
  );

  assert.equal(started, false);
  assert.deepEqual(killed, []);
  assert.deepEqual(removed, []);
});
