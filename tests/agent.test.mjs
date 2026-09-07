import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createQQLoginController, handleAgentRequest, parseQrImage } = require('../src/qq-agent.cjs');

function fakeService({ quickResult = { result: '0', loginErrorInfo: {} } } = {}) {
  let listener;
  const calls = { refresh: 0, quick: [], offline: 0, removed: [] };
  return {
    calls,
    get listener() { return listener; },
    addKernelLoginListener(value) { listener = value; return 17; },
    removeKernelLoginListener(id) { calls.removed.push(id); },
    getQRCodePicture() { calls.refresh += 1; return true; },
    getLoginList: async () => ({
      LocalLoginInfoList: [
        { uin: '12345678', nickName: '历史账号', isQuickLogin: true, isAutoLogin: false },
        { uin: '87654321', nickName: '不可快登', isQuickLogin: false, isAutoLogin: false },
      ],
    }),
    async quickLoginWithUin(uin) { calls.quick.push(uin); return quickResult; },
    offline() { calls.offline += 1; return true; },
  };
}

function controllerFor(service, instanceId, expectedUin = '') {
  let now = 1_000;
  return createQQLoginController(service, {
    instanceId,
    expectedUin,
    pid: instanceId === 'main' ? 101 : 202,
    now: () => ++now,
    schedule: callback => { callback(); return null; },
  });
}

test('accepts the kernel PNG payload without taking a screen capture', () => {
  const png = Buffer.from('\x89PNG\r\n\x1a\nqr', 'binary');
  const parsed = parseQrImage(`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(parsed.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(parsed.base64, 'base64'), png);
  assert.equal(parseQrImage('data:text/plain;base64,SGVsbG8='), null);
});

test('tracks QR, scanned, expired, and login-success states from QQ callbacks', async () => {
  const service = fakeService();
  const controller = controllerFor(service, 'main');
  await Promise.resolve();

  service.listener.onLoginConnected();
  assert.equal(service.calls.refresh, 1);
  service.listener.onQRCodeGetPicture({
    pngBase64QrcodeData: `data:image/png;base64,${Buffer.from('kernel-qr').toString('base64')}`,
    qrcodeUrl: 'https://example.invalid/qr-token',
  });
  assert.equal(controller.publicSnapshot().phase, 'waiting_scan');
  assert.equal(controller.publicSnapshot().qrcodeAvailable, true);
  assert.equal(controller.getQrCode().revision, 1);

  service.listener.onQRCodeSessionUserScaned();
  assert.equal(controller.publicSnapshot().phase, 'scanned');
  service.listener.onQRCodeSessionFailed(1, 3);
  assert.equal(controller.publicSnapshot().phase, 'expired');
  assert.match(controller.publicSnapshot().error, /过期/);

  service.listener.onQRCodeLoginSucceed({ uin: '12345678', uid: 'u_1', nickName: '主账号' });
  assert.equal(controller.publicSnapshot().phase, 'online');
  assert.equal(controller.publicSnapshot().account.uin, '12345678');
  assert.equal(controller.publicSnapshot().qrcodeAvailable, false);
});

test('keeps two instance controllers isolated', () => {
  const firstService = fakeService();
  const secondService = fakeService();
  const first = controllerFor(firstService, 'main');
  const second = controllerFor(secondService, 'second');

  firstService.listener.onQRCodeGetPicture({
    pngBase64QrcodeData: Buffer.from('first').toString('base64'),
    qrcodeUrl: 'first-url',
  });
  secondService.listener.onQRCodeGetPicture({
    pngBase64QrcodeData: Buffer.from('second').toString('base64'),
    qrcodeUrl: 'second-url',
  });
  firstService.listener.onQRCodeSessionUserScaned();

  assert.equal(first.publicSnapshot().phase, 'scanned');
  assert.equal(second.publicSnapshot().phase, 'waiting_scan');
  assert.notEqual(first.getQrCode().base64, second.getQrCode().base64);
  assert.equal(first.publicSnapshot().pid, 101);
  assert.equal(second.publicSnapshot().pid, 202);
});

test('routes refresh and quick-login commands only to the selected service', async () => {
  const firstService = fakeService();
  const secondService = fakeService();
  const first = controllerFor(firstService, 'main');
  controllerFor(secondService, 'second');

  await handleAgentRequest(first, JSON.stringify({ action: 'refresh' }));
  await handleAgentRequest(first, JSON.stringify({ action: 'quickLogin', uin: '12345678' }));
  await handleAgentRequest(first, JSON.stringify({ action: 'logout' }));
  assert.equal(firstService.calls.refresh, 1);
  assert.deepEqual(firstService.calls.quick, ['12345678']);
  assert.equal(firstService.calls.offline, 1);
  assert.equal(secondService.calls.refresh, 0);
  assert.deepEqual(secondService.calls.quick, []);
  assert.equal(secondService.calls.offline, 0);

  first.dispose();
  assert.deepEqual(firstService.calls.removed, [17]);
});

test('uses the QQ kernel offline flow and waits for its logout callback', async () => {
  const service = fakeService();
  const controller = controllerFor(service, '12345678');
  assert.equal(controller.publicSnapshot().capabilities.logout, true);

  const request = await controller.logout();
  assert.deepEqual(request, { accepted: true });
  assert.equal(controller.publicSnapshot().phase, 'logging_out');
  service.listener.onLogoutSucceed();
  assert.equal(controller.publicSnapshot().phase, 'connected');
  assert.equal(controller.publicSnapshot().account, null);
});

test('automatically logs out when a QR code is confirmed by the wrong QQ number', () => {
  const service = fakeService();
  const controller = controllerFor(service, '12345678', '12345678');
  service.listener.onQRCodeLoginSucceed({ uin: '87654321', uid: 'wrong', nickName: '扫错账号' });
  assert.equal(service.calls.offline, 1);
  assert.equal(controller.publicSnapshot().phase, 'logging_out');

  service.listener.onLogoutSucceed();
  assert.equal(controller.publicSnapshot().phase, 'account_mismatch');
  assert.equal(controller.publicSnapshot().account, null);
  assert.match(controller.publicSnapshot().error, /已自动退出/);
});

test('surfaces quick-login failure without marking the instance online', async () => {
  const service = fakeService({ quickResult: { result: '42', loginErrorInfo: { errMsg: '需要重新扫码' } } });
  const controller = controllerFor(service, 'main');
  const response = await controller.quickLogin('12345678');
  assert.deepEqual(response, { success: false, message: '需要重新扫码' });
  assert.equal(controller.publicSnapshot().phase, 'failed');
  assert.equal(controller.publicSnapshot().account, null);
});
