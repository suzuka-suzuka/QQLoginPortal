import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hashPassword,
  parseCookies,
  SessionStore,
  verifyConfiguredPassword,
  verifyPassword,
} from '../src/auth.mjs';

test('password hashes verify without retaining plaintext', async () => {
  const password = 'correct horse battery staple';
  const hash = await hashPassword(password);
  assert.match(hash, /^scrypt\$32768\$8\$1\$/);
  assert.equal(hash.includes(password), false);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
});

test('configured fixed passwords and legacy hashes both verify', async () => {
  const password = 'a fixed portal password';
  assert.equal(await verifyConfiguredPassword(password, { password }), true);
  assert.equal(await verifyConfiguredPassword('wrong password', { password }), false);

  const passwordHash = await hashPassword(password);
  assert.equal(await verifyConfiguredPassword(password, { passwordHash }), true);
  assert.equal(await verifyConfiguredPassword('wrong password', { passwordHash }), false);
});

test('session store expires and revokes tokens', () => {
  let now = 1_000;
  const store = new SessionStore(500, () => now);
  const token = store.create();
  assert.equal(store.has(token), true);
  now = 1_501;
  assert.equal(store.has(token), false);
  const second = store.create();
  store.revoke(second);
  assert.equal(store.has(second), false);
  const third = store.create();
  store.clear();
  assert.equal(store.has(third), false);
  store.setTtl(1_000);
  const fourth = store.create();
  now += 999;
  assert.equal(store.has(fourth), true);
});

test('cookie parser handles encoded values and malformed pairs', () => {
  assert.deepEqual(parseCookies('a=1; portal=hello%20world; broken'), {
    a: '1',
    portal: 'hello world',
  });
});
