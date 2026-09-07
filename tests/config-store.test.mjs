import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.mjs';
import { ConfigFileStore } from '../src/config-store.mjs';

async function withStore(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qq-login-portal-config-'));
  const configPath = path.join(directory, 'config.json');
  const raw = structuredClone(DEFAULT_CONFIG);
  raw.auth.password = 'original fixed password';
  raw.management.instanceRoot = path.join(directory, 'instances');
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  const live = normalizeConfig(raw, directory);
  const store = new ConfigFileStore(configPath, live);
  try {
    await run({ configPath, live, store });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('adds a QQ-number instance with isolated paths and no display-name field', async () => {
  await withStore(async ({ configPath, live, store }) => {
    const created = await store.addInstance({ uin: '12345678', autostart: false });
    assert.deepEqual(created, {
      id: '12345678',
      uin: '12345678',
      autostart: false,
    });
    assert.equal(live.instances[0].id, '12345678');
    assert.equal('name' in live.instances[0], false);
    assert.match(live.instances[0].homeDir, /12345678[\\/]home$/);
    assert.match(live.instances[0].userDataDir, /12345678[\\/]electron$/);

    const persisted = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(persisted.auth.password, 'original fixed password');
    assert.equal(persisted.instances[0].uin, '12345678');
    assert.equal('name' in persisted.instances[0], false);
    assert.equal('onebot' in persisted.instances[0], false);
    if (process.platform !== 'win32') assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    await assert.rejects(store.addInstance({ uin: '12345678' }), /已存在/);
  });
});

test('updates web-managed settings without exposing the password or changing runtime config', async () => {
  await withStore(async ({ configPath, live, store }) => {
    const settings = await store.updateSettings({
      newPassword: 'replacement fixed password',
      sessionTtlMinutes: 180,
      maxInstances: 24,
    });
    assert.equal(settings.auth.passwordConfigured, true);
    assert.equal(settings.auth.sessionTtlMinutes, 180);
    assert.equal(settings.management.maxInstances, 24);
    assert.equal('password' in settings.auth, false);
    assert.equal('onebotPortStart' in settings.management, false);
    assert.equal(live.runtime.qq.command, path.normalize('/opt/QQ/qq'));

    const persisted = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(persisted.auth.password, 'replacement fixed password');
    assert.equal(persisted.runtime.qq.command, '/opt/QQ/qq');
  });
});

test('updates autostart and allows every stopped instance configuration to be removed', async () => {
  await withStore(async ({ live, store }) => {
    await store.addInstance({ uin: '22334455' });
    const updated = await store.updateInstance('22334455', { autostart: true });
    assert.equal(updated.autostart, true);
    assert.equal(live.instances[0].autostart, true);
    const removed = await store.removeInstance('22334455');
    assert.equal(removed.uin, '22334455');
    assert.equal(live.instances.length, 0);
  });
});

test('updates an instance whose config uses only its QQ number without an explicit id', async () => {
  await withStore(async ({ configPath, store }) => {
    const raw = JSON.parse(await readFile(configPath, 'utf8'));
    raw.instances = [{ uin: '22334455', autostart: false }];
    await writeFile(configPath, JSON.stringify(raw), { mode: 0o600 });
    const updated = await store.updateInstance('22334455', { autostart: true });
    assert.equal(updated.id, '22334455');
    assert.equal(updated.autostart, true);
    const persisted = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(persisted.instances[0].autostart, true);
    assert.equal((await store.removeInstance('22334455')).uin, '22334455');
  });
});
