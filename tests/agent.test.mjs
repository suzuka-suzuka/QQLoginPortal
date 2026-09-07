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

  await service.listener.onLoginConnected();
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

function recoveryController(service, expectedUin = '12345678') {
  const timers = new Map();
  let id = 0;
  const controller = createQQLoginController(service, {
    instanceId: expectedUin || 'legacy', expectedUin,
    setTimer(callback, delay) { const key = ++id; timers.set(key, { callback, delay }); return key; },
    cancelTimer(key) { timers.delete(key); },
  });
  return {
    controller,
    fire(delay) { for (const [key, timer] of [...timers]) if (timer.delay === delay) { timers.delete(key); timer.callback(); } },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('restores only the configured account and waits for a success callback without generating QR', async () => {
  const service = fakeService();
  const order = [];
  const originalHistory = service.getLoginList;
  service.setRemerberPwd = value => { order.push(['remember', value]); };
  service.getLoginList = () => { order.push(['history']); return originalHistory(); };
  const { controller, fire } = recoveryController(service);
  await service.listener.onLoginConnected();
  assert.deepEqual(order.slice(0, 2), [['remember', true], ['history']]);
  assert.deepEqual(service.calls.quick, ['12345678']);
  assert.equal(service.calls.refresh, 0);
  assert.equal(controller.publicSnapshot().phase, 'quick_login');
  service.listener.onQRCodeGetPicture({ pngBase64QrcodeData: Buffer.from('late-qr').toString('base64') });
  service.listener.onQRCodeSessionFailed(1, 3);
  assert.equal(controller.publicSnapshot().phase, 'quick_login');
  service.listener.onUserLoggedIn('12345678');
  assert.equal(controller.publicSnapshot().phase, 'online');
  assert.equal(controller.publicSnapshot().recovery.status, 'restored');
  fire(15_000);
  service.listener.onLoginConnected();
  assert.equal(service.calls.refresh, 0);
  assert.equal(controller.getQrCode(), null);
  controller.dispose();
});

test('awaits history before deciding to restore and ignores duplicate connected events', async () => {
  const service = fakeService();
  let resolveHistory;
  service.getLoginList = () => new Promise(resolve => { resolveHistory = resolve; });
  const { controller } = recoveryController(service);
  const startup = service.listener.onLoginConnected();
  await flush();
  service.listener.onLoginConnected();
  assert.equal(service.calls.refresh, 0);
  assert.deepEqual(service.calls.quick, []);
  resolveHistory({ result: 0, LocalLoginInfoList: [{ uin: '12345678', isQuickLogin: true }] });
  await startup;
  assert.deepEqual(service.calls.quick, ['12345678']);
  controller.dispose();
});

test('never restores another account or a saved account without valid quick-login capability', async () => {
  for (const target of ['87654321', '99999999', '']) {
    const service = fakeService();
    const { controller } = recoveryController(service, target);
    await service.listener.onLoginConnected();
    assert.deepEqual(service.calls.quick, []);
    assert.equal(service.calls.refresh, 1);
    assert.equal(controller.publicSnapshot().recovery.status, 'qr_required');
    controller.dispose();
  }
});

test('empty and rejected history responses fall back to QR without login attempts', async () => {
  for (const result of [{ result: 0, LocalLoginInfoList: [] }, { result: 7, LocalLoginInfoList: [{uin:'12345678',isQuickLogin:true}] }]) {
    const service = fakeService(); service.getLoginList = async () => result;
    const { controller } = recoveryController(service);
    await service.listener.onLoginConnected();
    assert.deepEqual(service.calls.quick, []);
    assert.equal(service.calls.refresh, 1);
    controller.dispose();
  }
});

test('rejected or throwing restoration requests fall back once and retain the reason', async () => {
  for (const throws of [false, true]) {
    const service = fakeService({ quickResult: { result: '42', loginErrorInfo: {errMsg:'需要设备验证'} } });
    if (throws) service.quickLoginWithUin = async () => { throw new Error('需要设备验证'); };
    const { controller, fire } = recoveryController(service);
    await service.listener.onLoginConnected();
    assert.equal(service.calls.refresh, 1);
    assert.match(controller.publicSnapshot().recovery.message, /设备验证/);
    service.listener.onQRCodeSessionQuickLoginFailed('迟到的失败');
    fire(15_000);
    assert.equal(service.calls.refresh, 1);
    assert.equal(controller.publicSnapshot().phase, 'refreshing');
    controller.dispose();
  }
});

test('accepted restoration without a login-success event times out to QR', async () => {
  const service = fakeService(); const { controller, fire } = recoveryController(service);
  await service.listener.onLoginConnected();
  fire(15_000);
  assert.equal(service.calls.refresh, 1);
  assert.match(controller.publicSnapshot().recovery.message, /超时/);
  assert.notEqual(controller.publicSnapshot().phase, 'online');
  controller.dispose();
});

test('history timeout produces QR and a late history response cannot trigger a login', async () => {
  const service = fakeService(); let resolveHistory;
  service.getLoginList = () => new Promise(resolve => { resolveHistory = resolve; });
  const { controller, fire } = recoveryController(service);
  const startup = service.listener.onLoginConnected(); await flush();
  fire(4_000); await startup;
  resolveHistory({LocalLoginInfoList:[{uin:'12345678',isQuickLogin:true}]}); await flush();
  assert.equal(service.calls.refresh, 1);
  assert.deepEqual(service.calls.quick, []);
  controller.dispose();
});

test('native success while history is loading cancels automatic startup work', async () => {
  const service = fakeService(); const historyResolvers = [];
  service.getLoginList = () => new Promise(resolve => historyResolvers.push(resolve));
  const { controller } = recoveryController(service);
  const startup = service.listener.onLoginConnected(); await flush();
  service.listener.onUserLoggedIn('12345678'); await flush();
  for (const resolve of historyResolvers) resolve({LocalLoginInfoList:[]});
  await startup;
  assert.equal(controller.publicSnapshot().phase, 'online');
  assert.equal(service.calls.refresh, 0);
  assert.deepEqual(service.calls.quick, []);
  controller.dispose();
});

test('manual QR selection cancels pending startup restoration', async () => {
  const service = fakeService(); let resolveHistory;
  service.getLoginList = () => new Promise(resolve => { resolveHistory = resolve; });
  const { controller } = recoveryController(service);
  const startup = service.listener.onLoginConnected(); await flush();
  controller.requestQrCode();
  resolveHistory({LocalLoginInfoList:[{uin:'12345678',isQuickLogin:true}]}); await startup;
  service.listener.onQRCodeGetPicture({pngBase64QrcodeData:Buffer.from('manual').toString('base64')});
  assert.equal(controller.publicSnapshot().phase, 'waiting_scan');
  assert.deepEqual(service.calls.quick, []);
  controller.dispose();
});

test('disconnect and dispose invalidate pending restoration work', async () => {
  for (const action of ['disconnect', 'dispose']) {
    const service = fakeService(); let resolveHistory;
    service.getLoginList = () => new Promise(resolve => { resolveHistory = resolve; });
    const { controller } = recoveryController(service);
    const startup = service.listener.onLoginConnected(); await flush();
    if (action === 'disconnect') service.listener.onLoginDisConnected(); else controller.dispose();
    resolveHistory({LocalLoginInfoList:[{uin:'12345678',isQuickLogin:true}]}); await startup;
    assert.equal(service.calls.refresh, 0);
    assert.deepEqual(service.calls.quick, []);
    controller.dispose();
  }
});

test('explicit logout does not automatically log the account back in', async () => {
  const service = fakeService(); const { controller } = recoveryController(service);
  await service.listener.onLoginConnected(); service.listener.onUserLoggedIn('12345678');
  await controller.logout(); service.listener.onLogoutSucceed();
  service.listener.onLoginConnected(); await flush();
  assert.deepEqual(service.calls.quick, ['12345678']);
  assert.equal(controller.publicSnapshot().phase, 'connected');
  controller.dispose();
});

test('manual quick login rejects a QQ number belonging to another instance', async () => {
  const service = fakeService(); const { controller } = recoveryController(service);
  await assert.rejects(controller.quickLogin('87654321'), /当前实例/);
  assert.deepEqual(service.calls.quick, []);
  controller.dispose();
});

test('unsolicited login-service logout callbacks cannot erase successful QR login', () => {
  const service = fakeService(); const { controller } = recoveryController(service);
  service.listener.onQRCodeLoginSucceed({uin:'12345678',uid:'u_private',nickName:'private'});
  service.listener.onLogoutSucceed();
  service.listener.onLogoutFailed('old login-service cleanup');
  service.listener.onLoginConnected();
  assert.equal(controller.publicSnapshot().phase, 'online');
  assert.equal(controller.publicSnapshot().account.uin, '12345678');
  assert.equal(service.calls.refresh, 0);
  assert.equal(controller.getQrCode(), null);
  assert.equal(controller.publicSnapshot().events.find(e=>e.event==='onLogoutSucceed').phase, 'online');
  assert.doesNotMatch(JSON.stringify(controller.publicSnapshot().events), /private|12345678/);
  controller.dispose();
});

test('a login-service cleanup callback cannot interrupt automatic recovery', async () => {
  const service = fakeService(); const { controller } = recoveryController(service);
  await service.listener.onLoginConnected();
  service.listener.onLogoutSucceed();
  assert.equal(controller.publicSnapshot().phase, 'quick_login');
  service.listener.onUserLoggedIn('12345678');
  service.listener.onLogoutSucceed();
  assert.equal(controller.publicSnapshot().phase, 'online');
  assert.equal(controller.publicSnapshot().recovery.status, 'restored');
  controller.dispose();
});

test('real login transport disconnection remains visible after successful login', () => {
  const service = fakeService(); const { controller } = recoveryController(service);
  service.listener.onQRCodeLoginSucceed({uin:'12345678'});
  service.listener.onLoginDisConnected();
  assert.equal(controller.publicSnapshot().phase, 'disconnected');
  controller.dispose();
});

test('unsolicited logout cannot cancel QR login or remove its image', () => {
  const service = fakeService(); const { controller } = recoveryController(service);
  service.listener.onQRCodeGetPicture({pngBase64QrcodeData:Buffer.from('qr').toString('base64')});
  service.listener.onLogoutSucceed();
  assert.equal(controller.publicSnapshot().phase, 'waiting_scan');
  assert.ok(controller.getQrCode());
  controller.dispose();
});

test('logout confirmation is bounded and expired callbacks cannot change later state', async () => {
  const service = fakeService(); const { controller, fire } = recoveryController(service);
  service.listener.onQRCodeLoginSucceed({uin:'12345678'});
  await controller.logout();
  fire(15_000);
  assert.equal(controller.publicSnapshot().phase, 'failed');
  service.listener.onQRCodeLoginSucceed({uin:'12345678'});
  service.listener.onLogoutSucceed();
  assert.equal(controller.publicSnapshot().phase, 'online');
  controller.dispose();
});
