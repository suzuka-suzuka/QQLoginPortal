import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { accountGroup, actionFeedback, availableActions, effectivePhase, filterInstances, instanceIdentity, qrPresentation } from '../public/app.js';

function instance(id = '12345678', phase = 'waiting_scan', patch = {}) {
  return {
    id, uin: id, enabled: true, autostart: false,
    process: { running: phase !== 'stopped', pid: 101 },
    login: { phase, online: phase === 'online', connected: true, qrcodeAvailable: true, qrcodeRevision: 1, capabilities: { logout: false } },
    ...patch,
  };
}

test('account filtering combines real status with a QQ-number search', () => {
  const accounts = [instance('12345678', 'online'), instance('87654321'), instance('98765432', 'stopped')];
  assert.deepEqual(filterInstances(accounts, 'all', ' 876 ').map(item => item.id), ['87654321', '98765432']);
  assert.deepEqual(filterInstances(accounts, 'pending', '876').map(item => item.id), ['87654321']);
  assert.deepEqual(filterInstances(accounts, 'online', '876'), []);
  assert.equal(filterInstances(accounts).length, 3);
  assert.equal(accounts.length, 3);
});

test('a stopped process never appears online from a stale login snapshot', () => {
  const stopped = instance('12345678', 'online', { process: { running: false } });
  assert.equal(effectivePhase(stopped), 'stopped');
  assert.equal(accountGroup(stopped), 'stopped');
  assert.equal(qrPresentation(stopped).showImage, false);
});

test('QR failures and intermediate phases remain visible in the pending filter', () => {
  for (const phase of ['expired', 'failed', 'scanned', 'agent_unavailable', 'disconnected', 'connecting', 'quick_login']) {
    assert.equal(accountGroup(instance('12345678', phase)), 'pending');
  }
});

test('identity uses the configured QQ number and can read a migrated account', () => {
  assert.equal(instanceIdentity(instance()), '12345678');
  assert.equal(instanceIdentity({ id: 'main', login: { account: { uin: '87654321' } } }), '87654321');
  assert.equal(instanceIdentity({ id: 'main', login: {} }), 'main');
});

test('actions respect process state, disabled accounts and real logout support', () => {
  assert.deepEqual(availableActions(instance('12345678', 'stopped')), { start: true, stop: false, refresh: false, logout: false, remove: true });
  assert.equal(availableActions(instance('12345678', 'stopped', { enabled: false })).start, false);
  assert.equal(availableActions(instance('12345678', 'online')).logout, false);
  const supported = instance('12345678', 'online');
  supported.login.capabilities.logout = true;
  assert.equal(availableActions(supported).logout, true);
  assert.equal(availableActions(supported).refresh, false);
  assert.equal(availableActions(supported).remove, false);
});

test('disconnected agents cannot request QR refreshes', () => {
  const pending = instance();
  pending.login.connected = false;
  assert.equal(availableActions(pending).refresh, false);
});

test('a live waiting-scan state can display the kernel QR', () => {
  assert.equal(qrPresentation(instance()).showImage, true);
  const missing = instance();
  missing.login.qrcodeAvailable = false;
  assert.equal(qrPresentation(missing).showImage, false);
});

test('stale QR payloads are hidden after scan, login, expiration or failure', () => {
  for (const phase of ['online', 'scanned', 'expired', 'failed', 'disconnected', 'logging_out', 'account_mismatch', 'quick_login', 'refreshing']) {
    assert.equal(qrPresentation(instance('12345678', phase)).showImage, false, phase);
  }
});

test('the login success screen explains that the page can be closed', () => {
  const state = qrPresentation(instance('12345678', 'online'));
  assert.equal(state.title, '登录成功');
  assert.match(state.detail, /关闭网页/);
});

test('an account mismatch never falsely promises that automatic logout succeeded', () => {
  const state = qrPresentation(instance('12345678', 'account_mismatch'));
  assert.equal(state.title, '账号不匹配');
  assert.doesNotMatch(state.detail, /已自动退出/);
});

test('unsuccessful quick login is not presented as successful despite HTTP 200', () => {
  assert.deepEqual(actionFeedback('quick-login', { result: { success: false, message: '登录态已失效' } }), { error: true, message: '登录态已失效' });
});

test('rejected operations and unavailable agents give actionable feedback', () => {
  assert.equal(actionFeedback('refresh', { accepted: false }).error, true);
  assert.deepEqual(actionFeedback('logout', { result: { accepted: false }, state: { error: '无法退出' } }), { error: true, message: '无法退出' });
  assert.deepEqual(actionFeedback('start', { agentReady: false, message: '登录桥暂未连接' }), { error: true, message: '登录桥暂未连接' });
  assert.equal(actionFeedback('start', { agentReady: true }).error, false);
});

test('navigation contains only accounts, QR login and settings without dashboard widgets', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.deepEqual([...html.matchAll(/data-view="([^"]+)"/g)].map(match => match[1]), ['accounts', 'scan', 'settings']);
  assert.doesNotMatch(html, /INSTANCE OVERVIEW|hero-stats|health-grid|summary-online|运行状态|最近动态|批量操作/);
  assert.match(html, /<script src="\/app.js" type="module">/);
  assert.match(html, /name="uin"/);
  assert.doesNotMatch(html, /name="(?:displayName|nickname|remark)"/);
});

test('all document IDs are unique and inputs retain accessible labels', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /aria-label="搜索 QQ 号"|class="sr-only">搜索 QQ 号/);
  assert.match(html, /aria-labelledby="add-title"/);
  assert.match(html, /aria-describedby="confirm-message"/);
});
