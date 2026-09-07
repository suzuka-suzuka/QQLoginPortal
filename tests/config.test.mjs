import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { hashPassword } from '../src/auth.mjs';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.mjs';

function validConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth.password = 'a sufficiently long password';
  return config;
}

function addInstance(config, uin) {
  config.instances.push({ id: uin, uin, enabled: true, autostart: false });
}

test('accepts an empty standalone configuration so accounts can be added in the web UI', () => {
  const configDir = path.resolve('portal-config');
  const result = normalizeConfig(validConfig(), configDir);
  assert.equal(result.listen.host, '127.0.0.1');
  assert.equal(result.runtime.xvfb.display, ':1');
  assert.deepEqual(result.instances, []);
  assert.equal(result.management.instanceRoot, path.join(configDir, 'data', 'instances'));
  assert.equal('snowluma' in result.runtime, false);
  assert.equal('onebotPortStart' in result.management, false);
});

test('uses the QQ number as the instance identity and derives isolated paths', () => {
  const config = validConfig();
  addInstance(config, '12345678');
  const result = normalizeConfig(config, path.resolve('portal-config'));
  assert.equal(result.instances[0].id, '12345678');
  assert.equal(result.instances[0].uin, '12345678');
  assert.match(result.instances[0].homeDir, /12345678[\\/]home$/);
  assert.match(result.instances[0].userDataDir, /12345678[\\/]electron$/);
  assert.match(result.instances[0].socketPath, /12345678\.sock$/);
});

test('rejects mismatched or duplicate QQ identities', () => {
  const config = validConfig();
  addInstance(config, '12345678');
  config.instances.push({ id: '87654321', uin: '12345678' });
  assert.throws(() => normalizeConfig(config), /id 与 uin 必须一致|QQ 号.*冲突/);

  config.instances[1] = { id: 'legacy-slot', uin: '12345678' };
  assert.throws(() => normalizeConfig(config), /QQ 号.*冲突/);
});

test('accepts a legacy password hash', async () => {
  const config = validConfig();
  delete config.auth.password;
  config.auth.passwordHash = await hashPassword('a sufficiently long password');
  const result = normalizeConfig(config);
  assert.equal(result.auth.password, '');
  assert.match(result.auth.passwordHash, /^scrypt\$32768\$8\$1\$/);
});

test('rejects short fixed passwords and ambiguous authentication', async () => {
  const config = validConfig();
  config.auth.password = 'too-short';
  assert.throws(() => normalizeConfig(config), /12 到 256/);

  config.auth.password = 'a sufficiently long password';
  config.auth.passwordHash = await hashPassword('another sufficiently long password');
  assert.throws(() => normalizeConfig(config), /只能配置一个/);
});

test('keeps multiple QQ instances on independent data and sockets', () => {
  const config = validConfig();
  addInstance(config, '12345678');
  addInstance(config, '87654321');
  const configDir = path.resolve('portal-config');
  const result = normalizeConfig(config, configDir);
  assert.equal(result.instances.length, 2);
  assert.notEqual(result.instances[0].homeDir, result.instances[1].homeDir);
  assert.notEqual(result.instances[0].userDataDir, result.instances[1].userDataDir);
  assert.notEqual(result.instances[0].socketPath, result.instances[1].socketPath);

  config.instances[1].homeDir = result.instances[0].homeDir;
  assert.throws(() => normalizeConfig(config, configDir), /QQ HOME 冲突/);
});

test('reserves current and migration launch flags for the manager', () => {
  for (const flag of [
    '--qq-login-instance=wrong',
    '--snowluma-instance=wrong',
    '--user-data-dir=/tmp/wrong',
  ]) {
    const config = validConfig();
    config.runtime.qq.args.push(flag);
    assert.throws(() => normalizeConfig(config), /不要手动配置/);
  }
});

test('ignores unrelated integration fields left by an embedded preview config', () => {
  const config = validConfig();
  config.runtime.snowluma = { enabled: true, readyPort: 5099 };
  config.management.onebotHost = '127.0.0.1';
  config.management.onebotPortStart = 3001;
  config.instances.push({
    id: 'main',
    uin: '12345678',
    name: 'unused alias',
    onebot: { host: '127.0.0.1', port: 3001 },
  });
  const result = normalizeConfig(config);
  assert.equal(result.instances[0].id, 'main');
  assert.equal(result.instances[0].uin, '12345678');
  assert.equal('name' in result.instances[0], false);
  assert.equal('onebot' in result.instances[0], false);
  assert.equal('snowluma' in result.runtime, false);
});
