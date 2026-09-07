import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createPortalServer } from '../src/portal.mjs';

function testConfig() {
  return {
    auth: { password: 'unused but long enough', sessionTtlMinutes: 60, secureCookie: false },
  };
}

function fakeManager() {
  const calls = [];
  const qrcode = Buffer.from('\x89PNG\r\n\x1a\nkernel-qr', 'binary');
  return {
    calls,
    snapshot: async () => ({
      runtime: {
        loader: { installed: true, state: 'installed', message: 'ok' },
        xvfb: { display: ':1', ready: true },
        qq: { command: '/opt/QQ/qq', available: true },
      },
      instances: [{
        id: 'main', uin: '', enabled: true,
        process: { running: true, pid: 100, duplicatePids: [] },
        login: {
          instanceId: 'main', pid: 100, phase: 'waiting_scan', connected: true,
          qrcodeAvailable: true, qrcodeRevision: 1, quickLoginAccounts: [],
          account: null, error: '', updatedAt: 1,
        },
        startError: null,
      }],
      bootstrap: null,
      bootstrapError: null,
      now: 1,
    }),
    startInstance: async id => { calls.push(['start', id]); return { started: true, pid: 100 }; },
    stopInstance: async id => { calls.push(['stop', id]); return { stopped: true }; },
    refreshQrCode: async id => { calls.push(['refresh', id]); return { accepted: true }; },
    quickLogin: async (id, uin) => { calls.push(['quick', id, uin]); return { result: { success: true } }; },
    logoutInstance: async id => { calls.push(['logout', id]); return { result: { accepted: true } }; },
    addInstance: async input => {
      calls.push(['add', input]);
      return { instance: { id: input.uin, uin: input.uin, autostart: input.autostart }, start: null };
    },
    updateInstance: async (id, patch) => { calls.push(['update', id, patch]); return { id, ...patch }; },
    removeInstance: async id => { calls.push(['remove', id]); return { id }; },
    settings: () => ({
      auth: { passwordConfigured: true, sessionTtlMinutes: 60, secureCookie: false },
      listen: { host: '127.0.0.1', port: 5100 },
      management: { instanceRoot: '/srv/instances', maxInstances: 16 },
    }),
    updateSettings: async patch => {
      calls.push(['settings', patch]);
      return {
        auth: { passwordConfigured: true, sessionTtlMinutes: patch.sessionTtlMinutes, secureCookie: false },
        listen: { host: '127.0.0.1', port: 5100 },
        management: { instanceRoot: '/srv/instances', maxInstances: patch.maxInstances },
      };
    },
    qrcode: async id => {
      calls.push(['qrcode', id]);
      return { qrcode: { mimeType: 'image/png', base64: qrcode.toString('base64'), revision: 1 } };
    },
  };
}

async function withServer(run, verify = async password => password === 'right-password') {
  const instanceManager = fakeManager();
  const server = createPortalServer({ config: testConfig(), instanceManager, verify });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`, instanceManager);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function login(base) {
  const response = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'right-password' }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie');
}

test('keeps instance state and kernel QR bytes behind authentication', async () => {
  await withServer(async base => {
    const status = await fetch(`${base}/api/status`);
    const qrcode = await fetch(`${base}/api/instances/main/qrcode`);
    assert.equal(status.status, 401);
    assert.equal(qrcode.status, 401);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.match(status.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });
});

test('serves the QQ-kernel PNG directly after login', async () => {
  await withServer(async (base, manager) => {
    const cookie = await login(base);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /^qq_login_portal_session=/);

    const status = await fetch(`${base}/api/status`, { headers: { Cookie: cookie } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).instances[0].login.phase, 'waiting_scan');

    const qrcode = await fetch(`${base}/api/instances/main/qrcode`, { headers: { Cookie: cookie } });
    assert.equal(qrcode.status, 200);
    assert.equal(qrcode.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await qrcode.arrayBuffer()), Buffer.from('\x89PNG\r\n\x1a\nkernel-qr', 'binary'));
    assert.deepEqual(manager.calls, [['qrcode', 'main']]);
  });
});

test('routes instance lifecycle actions only to the requested instance', async () => {
  await withServer(async (base, manager) => {
    const cookie = await login(base);
    const options = body => ({
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal((await fetch(`${base}/api/instances/second/start`, options({}))).status, 200);
    assert.equal((await fetch(`${base}/api/instances/second/stop`, options({}))).status, 200);
    assert.equal((await fetch(`${base}/api/instances/second/refresh`, options({}))).status, 200);
    assert.equal((await fetch(`${base}/api/instances/main/quick-login`, options({ uin: '12345678' }))).status, 200);
    assert.equal((await fetch(`${base}/api/instances/main/logout`, options({}))).status, 200);
    assert.deepEqual(manager.calls, [
      ['start', 'second'],
      ['stop', 'second'],
      ['refresh', 'second'],
      ['quick', 'main', '12345678'],
      ['logout', 'main'],
    ]);
  });
});

test('adds, updates, and removes QQ-number instances behind authentication', async () => {
  await withServer(async (base, manager) => {
    const cookie = await login(base);
    const options = (method, body) => ({
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const created = await fetch(`${base}/api/instances`, options('POST', { uin: '12345678', startNow: false, autostart: false }));
    assert.equal(created.status, 201);
    assert.equal((await created.json()).instance.id, '12345678');
    assert.equal((await fetch(`${base}/api/instances/12345678`, options('PATCH', { autostart: true }))).status, 200);
    assert.equal((await fetch(`${base}/api/instances/12345678`, options('DELETE', {}))).status, 200);
    assert.deepEqual(manager.calls, [
      ['add', { uin: '12345678', autostart: false, startNow: false }],
      ['update', '12345678', { autostart: true }],
      ['remove', '12345678'],
    ]);
  });
});

test('reads settings without exposing a password and requires the current password to update them', async () => {
  await withServer(async (base, manager) => {
    const cookie = await login(base);
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    const current = await fetch(`${base}/api/settings`, { headers });
    const currentBody = await current.json();
    assert.equal(current.status, 200);
    assert.equal('password' in currentBody.auth, false);

    const denied = await fetch(`${base}/api/settings`, {
      method: 'PUT', headers, body: JSON.stringify({ currentPassword: 'wrong password' }),
    });
    assert.equal(denied.status, 403);

    const saved = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        currentPassword: 'right-password',
        newPassword: '',
        sessionTtlMinutes: 120,
        maxInstances: 20,
      }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(manager.calls, [[
      'settings',
      { newPassword: undefined, sessionTtlMinutes: 120, maxInstances: 20 },
    ]]);
  });
});

test('rejects malformed quick-login accounts and cross-origin mutations', async () => {
  await withServer(async base => {
    const cookie = await login(base);
    const invalid = await fetch(`${base}/api/instances/main/quick-login`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ uin: '../bad' }),
    });
    assert.equal(invalid.status, 400);
    const crossOrigin = await fetch(`${base}/api/instances/main/refresh`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://evil.invalid' },
      body: '{}',
    });
    assert.equal(crossOrigin.status, 403);
  });
});

test('rate-limits repeated wrong passwords per client address', async () => {
  await withServer(async base => {
    for (let i = 0; i < 5; i += 1) {
      const response = await fetch(`${base}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      });
      assert.equal(response.status, 401);
    }
    const blocked = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'right-password' }),
    });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });
});
